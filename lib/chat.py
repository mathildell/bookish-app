"""Ollama chat + RAG retrieval from ChromaDB."""

import json
import logging
import os
import re
import time
from typing import Optional, Callable

from ollama import Client

from .models import AppSettings

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Constants                                                                   #
# --------------------------------------------------------------------------- #

_CONTEXT_SNIPPET_MAX = 600       # max chars per retrieved chunk
_HISTORY_TURNS = 6              # last N message pairs to send the model
_SYSTEM_TEMPERATURE = 0.4       # kept low for factual answers

# Ollama allows an unlimited token budget by default, so a model that falls into a
# reasoning loop (repeating a numbered list forever) never stops on its own.
_MAX_PREDICT = 4096             # hard cap on thinking + answer tokens
_THINKING_TIMEOUT_S = 120       # give up if no answer text has arrived by then
_LOOP_CHECK_CHARS = 6000        # start loop detection once reasoning is this long
_LOOP_TAIL_CHARS = 4000
_LOOP_SEGMENT_CHARS = 500

_LOOP_MESSAGE = (
    "The model got stuck repeating itself while reasoning, so the answer was "
    "stopped. Try rephrasing the question."
)
_TIMEOUT_MESSAGE = (
    "The model reasoned for over two minutes without answering, so the answer "
    "was stopped. Try rephrasing the question."
)


def _chat_options() -> dict:
    return {"temperature": _SYSTEM_TEMPERATURE, "num_predict": _MAX_PREDICT}


def _reasoning_is_looping(reasoning: str) -> bool:
    """Detect a reasoning loop, e.g. a numbered list whose numbers just increment.

    Digits are masked so "1. the same text" and "2. the same text" both match.
    """
    if len(reasoning) < _LOOP_CHECK_CHARS:
        return False
    tail = re.sub(r"\d+", "#", reasoning[-_LOOP_TAIL_CHARS:])
    if len(tail) < _LOOP_SEGMENT_CHARS * 2:
        return False
    segment = tail[-_LOOP_SEGMENT_CHARS:]
    return segment in tail[:-_LOOP_SEGMENT_CHARS]

SYSTEM_TEMPLATES = {
    "book": (
        "You are an expert book assistant. Answer questions using the provided context.\n"
        "If the answer isn't in the context, say so honestly — don't make things up.\n"
        "Keep responses concise."
    ),
    "multi_book": (
        "You are an expert book assistant. Answer questions using the provided context.\n"
        "The context contains text from multiple books. Reference which book each quote comes from.\n"
        "If the answer isn't in the context, say so honestly — don't make things up."
    ),
}


def _build_rag_context(chunks: list[dict]) -> str:
    """Collapse retrieved chunks into a single prompt block."""
    parts = []
    for ci in chunks:
        snippet = ci["text"][:_CONTEXT_SNIPPET_MAX]
        cid_str = str(ci.get("book_id", "?"))
        title = ci.get("book_title", "Unknown")
        parts.append(f"[cid:{cid_str} - {title}]:\n" + snippet)
    if not parts:
        return ""
    joined = "\n\n".join(parts)
    return f"\n\n## CONTEXT FOR QUESTION:\n{joined}"


def _build_citations(chunks: list[dict]) -> list[dict]:
    """Deduplicate citation entries by (book_id, title)."""
    citations: list[dict] = []
    seen: set[tuple] = set()
    for ci in chunks:
        key = (ci.get("book_id"), ci.get("book_title"))
        if key and key not in seen:
            citations.append({
                "calibre_id": ci.get("book_id"),
                "title": ci.get("book_title", ""),
            })
            seen.add(key)
    return citations


class ChatEngine:
    """Ollama chat + RAG retrieval from ChromaDB."""

    def __init__(self, settings: AppSettings):
        self.s = settings
        self._ollama = Client(host=settings.ollama_base_url)
        self._collection = None

    @property
    def collection(self):
        if self._collection is None:
            import chromadb as _chroma
            os.makedirs(self.s.chroma_db_path, exist_ok=True)
            c_client = _chroma.PersistentClient(path=self.s.chroma_db_path)
            self._collection = c_client.get_or_create_collection(
                name="book_texts",
                metadata={"hnsw:space": "cosine"},
            )
        return self._collection

    # ----------------------------------------------------------------- #
    # Retrieval                                                          #
    # ----------------------------------------------------------------- #

    def retrieve_chunks(
        self,
        query: str,
        calibre_ids: Optional[list[int]] = None,
        n: int | None = None,
    ) -> list[dict]:
        """Embed *query*, search ChromaDB, and return chunk metadata.

        Raises RuntimeError if ChromaDB is unavailable so callers can show
        a meaningful error instead of a raw hnsw corruption message.
        """
        # Quick self-test before blocking on a real query
        try:
            self.collection.count()
        except Exception as exc:
            raise RuntimeError(
                "Vector index unavailable — the ChromaDB index appears corrupted. "
                "Books still load normally but chat/search will not work until it's fixed. "
                f"Underlying error: {exc}"
            ) from exc

        k = n or self.s.top_k
        try:
            emb_resp = self._ollama.embed(model=self.s.embedding_model, input=query)
            q_emb = emb_resp["embeddings"][0]
        except Exception as exc:
            logger.warning("Query embedding failed for retrieval", exc_info=exc)
            return []

        # Restrict retrieval to the selected books. `_cid` is stored as an int by
        # the ingestor, so the filter must use ints and Chroma's $in operator.
        where_filter: Optional[dict[str, object]] = None
        if calibre_ids:
            where_filter = {"_cid": {"$in": [int(i) for i in calibre_ids]}}

        results = self.collection.query(
            query_embeddings=[q_emb],
            n_results=k,
            where=where_filter,
            include=["distances", "documents", "metadatas"],
        )

        chunks: list[dict] = []
        ids = results["ids"][0]
        for idx in range(len(ids)):
            mid = results["metadatas"][0][idx]
            # authors stored as JSON string — just discard (unused downstream)
            chunks.append({
                "id": ids[idx],
                "text": results["documents"][0][idx],
                "distance": results["distances"][0][idx],
                "chapter": mid.get("_chapter", ""),
                "book_id": mid.get("_cid"),
                "book_title": mid.get("title", ""),
            })
        return chunks

    # ----------------------------------------------------------------- #
    # Chat (blocking — for tests / non-SSE paths)                       #
    # ----------------------------------------------------------------- #

    def chat(
        self,
        user_message: str,
        history: list[dict],
        calibre_ids: Optional[list[int]] = None,
        scope: str = "book",
        on_token: Optional[Callable[[str], None]] = None,
    ) -> dict:
        """Full RAG cycle, returns {"answer", "citations", "tokens_used"}|{"error"}."""
        chunks = self.retrieve_chunks(query=user_message, calibre_ids=calibre_ids)
        system_content = self._make_system(scope, chunks)
        messages = self._make_messages(system_content, history, user_message)

        try:
            stream_resp = self._ollama.chat(
                model=self.s.chat_model,
                messages=messages,
                options=_chat_options(),
                stream=True,
            )
            tokens: list[str] = []
            for frame in stream_resp:
                delta = frame.get("message", {}).get("content") or ""
                if delta and on_token:
                    on_token(delta)
                tokens.append(delta)
            final_answer = "".join(tokens)
        except Exception as exc:
            logger.error("Chat stream failed in chat()", exc_info=exc)
            return {"error": str(exc), "citations": [], "tokens_used": 0}

        return {
            "answer": final_answer,
            "citations": _build_citations(chunks),
            "tokens_used": sum(len(t.split()) for t in tokens),
        }

    # ----------------------------------------------------------------- #
    # Streaming wrapper (for SSE / generator callers)                   #
    # ----------------------------------------------------------------- #

    def chat_stream(
        self,
        user_message: str,
        history: list[dict],
        calibre_ids: Optional[list[int]] = None,
        scope: str = "book",
        on_token: Optional[Callable[[str], None]] = None,
    ):
        """Yield ("thinking"|"token"|"error"|"chunks", payload).

        Reasoning models stream their reasoning in `message.thinking` and leave
        `message.content` empty until they start answering. Forwarding only
        content leaves the caller silent for the whole think phase, so thinking
        is streamed too. Empty content deltas are skipped rather than emitted as
        blank tokens.
        """
        chunks = self.retrieve_chunks(query=user_message, calibre_ids=calibre_ids)
        system_content = self._make_system(scope, chunks)
        messages = self._make_messages(system_content, history, user_message)

        try:
            stream_resp = self._ollama.chat(
                model=self.s.chat_model,
                messages=messages,
                options=_chat_options(),
                stream=True,
            )
            started = time.monotonic()
            reasoning: list[str] = []
            reasoning_frames = 0
            saw_content = False
            for frame in stream_resp:
                message = frame.get("message", {}) or {}
                thought = message.get("thinking") or ""
                if thought:
                    reasoning.append(thought)
                    yield ("thinking", thought)
                    reasoning_frames += 1
                    if reasoning_frames % 20 == 0 and _reasoning_is_looping(
                        "".join(reasoning)
                    ):
                        logger.warning("Reasoning loop detected; stopping generation")
                        yield ("error", _LOOP_MESSAGE)
                        return
                delta = message.get("content") or ""
                if not delta:
                    if not saw_content and time.monotonic() - started > _THINKING_TIMEOUT_S:
                        logger.warning("Reasoning timed out before any answer text")
                        yield ("error", _TIMEOUT_MESSAGE)
                        return
                    continue
                saw_content = True
                if on_token:
                    on_token(delta)
                yield ("token", delta)
        except Exception as exc:
            logger.error("Chat stream failed in chat_stream()", exc_info=exc)
            yield ("error", str(exc))

        yield ("chunks", chunks)

    # ----------------------------------------------------------------- #
    # Internal helpers                                                   #
    # ----------------------------------------------------------------- #

    @staticmethod
    def _make_system(scope: str, chunks: list[dict]) -> str:
        ctx_block = _build_rag_context(chunks)
        return SYSTEM_TEMPLATES.get(scope, SYSTEM_TEMPLATES["book"]) + ctx_block

    @staticmethod
    def _make_messages(system_content: str, history: list[dict], user_message: str) -> list[dict]:
        msgs = [{"role": "system", "content": system_content}]
        for h in history[-_HISTORY_TURNS * 2:]:
            msgs.append({"role": h["role"], "content": h["content"]})
        msgs.append({"role": "user", "content": user_message})
        return msgs
