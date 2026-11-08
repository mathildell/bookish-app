"""Ollama chat + RAG retrieval from ChromaDB."""

import json
import logging
import os
import re
import time
from typing import Optional, Callable

import numpy as np
from ollama import Client

from .models import AppSettings

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Constants                                                                   #
# --------------------------------------------------------------------------- #

_HISTORY_TURNS = 6              # last N message pairs to send the model
# Every hit may bring the chunk that continues it, so the prompt is roughly two
# chunks per hit. At the current 1000-token geometry that is ~48k chars (~12k
# tokens); the cap only bites if a much larger chunk size is indexed, and keeps
# the excerpts inside the model's window with room for history and the answer.
_CONTEXT_MAX_CHARS = 60_000

# Qwen3-Embedding is instruction-trained: the *query* carries a task instruction
# and the indexed documents do not. A bare query still returns results, but it
# flattens the ranking — measured on one book, the bare form put a pre-publication
# disclaimer above the final chapter for "what happens at the end of the book?".
_QUERY_INSTRUCTION = "Given a question about a book, retrieve the passages that answer it"
_SYSTEM_TEMPERATURE = 0.4       # kept low for factual answers

# Both limits are per model — a 27B's real window and output ceiling differ from
# an 8B's — so they come from config.yaml (the `chat:` block) instead of living
# here as constants.
_DEFAULT_NUM_CTX = 98304        # context window offered to the model
# Ollama allows an unlimited token budget by default, so a model that falls into a
# reasoning loop (repeating a numbered list forever) never stops on its own; the
# cap plus the loop detector below are what stop it.
_DEFAULT_NUM_PREDICT = 16384    # hard cap on thinking + answer tokens
_THINKING_TIMEOUT_S = 120       # give up this long after the first frame, not after the request
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


def _chat_options(settings: AppSettings) -> dict:
    """Request options for a chat call.

    num_ctx is sent explicitly because Ollama defaults to 4096 whatever the model
    supports: that is smaller than the retrieved passages plus a few turns of
    history, and the truncation looks like the model ignoring the books.
    """
    return {
        "temperature": _SYSTEM_TEMPERATURE,
        "num_ctx": settings.chat_num_ctx or _DEFAULT_NUM_CTX,
        "num_predict": settings.chat_num_predict or _DEFAULT_NUM_PREDICT,
    }


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


# Navigation and publication boilerplate is chunked and embedded like prose, so it
# competes for the handful of context slots and can win on surface wording alone:
# a pre-publication disclaimer outranked the final chapter for "what happens at
# the end of the book?", because it says "final manuscript … release". These
# chunks are never the answer, so they are dropped after retrieval rather than at
# ingestion — that also covers books that were indexed before this existed.
_FRONT_MATTER_HEAD = re.compile(
    r"^(?:"
    r"acknowledg(?:e)?ments?|author'?s note|about the author|reading group guide|"
    r"discussion (?:questions|guide)|copyright|dedication|disclaimer|contents|"
    r"table of contents|praise for|also by|title page|front cover|back cover|"
    r"afterword|music|playlist|soundtrack|"
    r"this file represents the final manuscript"
    r")\b",
    re.IGNORECASE,
)

# Matched against collapsed, lowercased chapter names — "..._epub_toc_r1.htm"
# becomes " epub toc r1 htm ". Whole tokens only, so "Stockade" is not "toc".
_FRONT_MATTER_CHAPTER_TOKENS = (
    "toc", "nav", "contents", "cover", "titlepage", "title page", "copyright",
    "colophon", "dedication", "disclaimer", "acknowledgment", "acknowledgement",
    "authors note", "about the author", "reading group", "discussion guide",
    "also by", "praise",
)


# Chunk ids are sequential per book: "<calibre_id>_c<n>". The chunk that
# continues a hit is therefore one id away, which is a single exact lookup for
# every hit at once. Ids from another ingest path simply don't expand.
_CHUNK_ID_RE = re.compile(r"^(?P<prefix>.+)_c(?P<index>\d+)$")

# Embeddings rank by overall meaning, so one distinctive word can lose to six
# passages that merely share the subject: "why was Danny's body found in the
# fountain?" returned eleven chunks and not one containing "fountain", while the
# same question phrased "...body in the fountain?" found four. A word that
# appears in only a handful of chunks is a strong signal regardless of what the
# embedding thinks, so a small lexical pass adds those passages back.
_LEXICAL_STOPWORDS = frozenset(
    "a an the and or but if then than that this these those of in on at to for from "
    "by with about into over under after before while during as is are was were be "
    "been being am do does did doing done have has had having i you he she it we they "
    "them his her hers its their theirs our yours my mine who whom whose what when "
    "where why how which there here not no nor so such very can could should would "
    "may might will shall just also only more most much many some any all both each "
    "few other own same too don now tell explain describe book text context passage "
    "chapter story happens happened happen".split()
)
_LEXICAL_MAX_TERMS = 8      # candidate words a query offers to the lexical pass
_LEXICAL_DF_MAX = 25        # a word in more chunks than this says nothing
_LEXICAL_KEEP_TERMS = 3     # rarest words actually used
_LEXICAL_MAX_HITS = 4       # passages a lexical pass may add

# Questions about an ending need the last chapters, which similarity search
# ranks *below* the climax: for "what happens at the end of the book?" the 24
# nearest chunks of a 127-chunk novel stopped at chunk 111, so the closing scene
# was never a candidate and the model correctly said the text was cut off. The
# closing chapters are a quiet aftermath that matches such a question badly, so
# position has to count too.
_END_INTENT = re.compile(
    r"\b(?:end(?:ing|ings|s)?|finale?|last|conclu(?:de|des|sion)|epilogue|"
    r"finish(?:es|ed)?|surviv(?:e|es|ed|or|ors)|alive|aftermath|resolution|"
    r"denouement|escape[sd]?|escaping|"
    # "Does anyone come off the mountain?" is an ending question too, and without
    # this it answered that nobody ever does — the escape happens at the end.
    r"g(?:et|ets|ot|etting) (?:off|out|down|away)|come(?:s)? (?:off|out|down|away)|"
    r"ma(?:ke|kes|de) it (?:off|out|down)|on the way (?:out|home)|the way (?:out|home))\b",
    re.IGNORECASE,
)
_TAIL_WINDOW = 20   # trailing chunks of each selected book worth considering
_TAIL_HITS = 2      # best of those by similarity, placed ahead of the semantic hits
_TAIL_FORCE = 2     # the literal final chunks, always included regardless


def _is_front_matter(chunk: dict) -> bool:
    """True for table-of-contents, copyright, acknowledgments, author bios, etc."""
    chapter = (chunk.get("chapter") or "").lower()
    if chapter:
        norm = " " + re.sub(r"[^a-z0-9]+", " ", chapter).strip() + " "
        if any(f" {token} " in norm for token in _FRONT_MATTER_CHAPTER_TOKENS):
            return True
    head = re.sub(r"\s+", " ", (chunk.get("text") or "")[:200]).strip()
    # EPUBs use curly quotes: "Author’s Note" has to match "author'?s note".
    head = head.replace("\u2019", "'").replace("\u2018", "'")
    return bool(_FRONT_MATTER_HEAD.match(head))


def _query_text(model: str, query: str) -> str:
    """Format a retrieval query the way the embedding model expects it.

    Qwen3-Embedding documents an asymmetric form: an `Instruct:` line on the
    query, nothing on the indexed documents. Other models (nomic-embed) take the
    bare query.
    """
    if "qwen3-embedding" in model.lower():
        return f"Instruct: {_QUERY_INSTRUCTION}\nQuery: {query}"
    return query


def _build_rag_context(chunks: list[dict]) -> str:
    """Collapse retrieved chunks into a single prompt block.

    Whole chunks are sent. The indexer already cut the text at the configured
    chunk size, so the chunk *is* the retrieval unit; clipping every hit to its
    first 600 characters discarded most of it, and conclusions that land late in
    a chunk went with them.

    The cap is a safety valve, not the normal path: chunks are added whole until
    the budget is reached, and anything that doesn't fit is skipped rather than
    truncated.
    """
    parts = []
    used = 0
    for ci in chunks:
        text = ci["text"]
        if parts and used + len(text) > _CONTEXT_MAX_CHARS:
            continue
        cid_str = str(ci.get("book_id", "?"))
        title = ci.get("book_title", "Unknown")
        chapter = ci.get("chapter") or ""
        where = f" - {chapter}" if chapter else ""
        if ci.get("continuation"):
            where += " (continued)"
        parts.append(f"[cid:{cid_str} - {title}{where}]:\n" + text)
        used += len(text)
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
            total = self.collection.count()
        except Exception as exc:
            raise RuntimeError(
                "Vector index unavailable — the ChromaDB index appears corrupted. "
                "Books still load normally but chat/search will not work until it's fixed. "
                f"Underlying error: {exc}"
            ) from exc

        k = n or self.s.top_k
        try:
            emb_resp = self._ollama.embed(
                model=self.s.embedding_model,
                input=_query_text(self.s.embedding_model, query),
            )
            q_emb = emb_resp["embeddings"][0]
        except Exception as exc:
            logger.warning("Query embedding failed for retrieval", exc_info=exc)
            return []

        # Restrict retrieval to the selected books. `_cid` is stored as an int by
        # the ingestor, so the filter must use ints and Chroma's $in operator.
        where_filter: Optional[dict[str, object]] = None
        if calibre_ids:
            where_filter = {"_cid": {"$in": [int(i) for i in calibre_ids]}}

        # Over-fetch, then drop front/back matter: otherwise a TOC, copyright
        # page or acknowledgments can take slots that belong to actual prose.
        fetch_k = min(total, max(k * 4, k + 12)) or k
        try:
            results = self.collection.query(
                query_embeddings=[q_emb],
                n_results=fetch_k,
                where=where_filter,
                include=["distances", "documents", "metadatas"],
            )
        except Exception as exc:
            # ChromaDB fixes the vector size when a collection is first written,
            # so a new embedding model pointed at an old index fails here with a
            # bare "expecting embedding with dimension of 768, got 4096". Say what
            # that means and how to get out of it.
            if "dimension" not in str(exc).lower():
                raise
            raise RuntimeError(
                "The vector index was built with a different embedding model than "
                f"'{self.s.embedding_model}' ({exc}). Re-embed with "
                "scripts/reembed_to_model.py, then point app.chroma_db_path at the "
                "new index once it is complete."
            ) from exc

        chunks: list[dict] = []
        ids = results["ids"][0]
        for idx in range(len(ids)):
            mid = results["metadatas"][0][idx]
            # authors stored as JSON string — just discard (unused downstream)
            chunk = {
                "id": ids[idx],
                "text": results["documents"][0][idx],
                "distance": results["distances"][0][idx],
                "chapter": mid.get("_chapter", ""),
                "book_id": mid.get("_cid"),
                "book_title": mid.get("title", ""),
            }
            if _is_front_matter(chunk):
                continue
            chunks.append(chunk)
            if len(chunks) >= k:
                break
        # Add passages that contain a rare word from the question. Without this
        # the passage about the fountain is not even in the prompt, so the model
        # correctly reports that the context never mentions a fountain.
        ending: list[dict] = []
        if _END_INTENT.search(query):
            ending = self._ending_chunks(
                where_filter, {c["id"] for c in chunks}, q_emb
            )
        exclude = {c["id"] for c in chunks} | {c["id"] for c in ending}
        chunks.extend(self._lexical_chunks(query, where_filter, exclude, q_emb))
        # The closing chapters go first: they answer the question, and the
        # context budget would otherwise drop them as the last thing appended.
        return self._with_continuations(ending + chunks)

    def _with_continuations(self, chunks: list[dict]) -> list[dict]:
        """Attach the chunk that follows each hit.

        Chunks are cut at a fixed character count, not at scene breaks, so the
        answer to a question can sit in the next chunk: "who is the murderer"
        ended mid-deduction, and "what happens at the end of the book" stopped
        one chunk before "THE END". One exact lookup fetches every continuation.
        """
        if not chunks:
            return chunks

        wanted: dict[str, str] = {}
        for chunk in chunks:
            m = _CHUNK_ID_RE.match(str(chunk.get("id") or ""))
            if m:
                nxt = f"{m.group('prefix')}_c{int(m.group('index')) + 1}"
                wanted[nxt] = chunk["id"]
        if not wanted:
            return chunks

        try:
            got = self.collection.get(
                ids=list(wanted), include=["documents", "metadatas"]
            )
        except Exception as exc:
            logger.warning("Continuation lookup failed", exc_info=exc)
            return chunks

        by_id: dict[str, dict] = {}
        for cid, doc, meta in zip(got["ids"], got["documents"], got["metadatas"]):
            if not doc or not meta:
                continue
            chunk = {
                "id": cid,
                "text": doc,
                "chapter": meta.get("_chapter", ""),
                "book_id": meta.get("_cid"),
                "book_title": meta.get("title", ""),
            }
            if not _is_front_matter(chunk):
                by_id[cid] = chunk

        expanded: list[dict] = []
        seen = {c["id"] for c in chunks}
        for chunk in chunks:
            expanded.append(chunk)
            m = _CHUNK_ID_RE.match(str(chunk.get("id") or ""))
            if not m:
                continue
            nid = f"{m.group('prefix')}_c{int(m.group('index')) + 1}"
            nxt = by_id.get(nid)
            if nxt and nid not in seen:
                seen.add(nid)
                # Same distance as its parent: it is read as part of the same hit.
                expanded.append({**nxt, "distance": chunk.get("distance"), "continuation": True})
        return expanded

    def _ending_chunks(
        self,
        where_filter: Optional[dict[str, object]],
        exclude: set[str],
        query_embedding: list[float],
    ) -> list[dict]:
        """Best-matching of the last chunks in each selected book.

        Only used for a question that names an ending. Ranking is still by
        similarity, but the pool is positional: whatever the closing chapters
        are, they get looked at.
        """
        if not where_filter:
            return []
        try:
            heads = self.collection.get(where=where_filter, include=["metadatas"])
        except Exception as exc:
            logger.warning("Tail candidate lookup failed", exc_info=exc)
            return []

        per_book: dict[str, list[tuple[int, str]]] = {}
        for cid in heads["ids"]:
            m = _CHUNK_ID_RE.match(str(cid))
            if not m:
                continue
            per_book.setdefault(m.group("prefix"), []).append(
                (int(m.group("index")), str(cid))
            )
        tail_ids: list[str] = []
        for entries in per_book.values():
            entries.sort()
            tail_ids.extend(cid for _index, cid in entries[-_TAIL_WINDOW:])
        if not tail_ids:
            return []

        try:
            got = self.collection.get(
                ids=tail_ids, include=["documents", "metadatas", "embeddings"]
            )
        except Exception as exc:
            logger.warning("Tail fetch failed", exc_info=exc)
            return []

        q_vec = np.asarray(query_embedding, dtype=float)
        q_norm = float(np.linalg.norm(q_vec)) or 1.0
        ranked: list[tuple[float, dict]] = []
        by_prefix: dict[str, list[tuple[int, dict]]] = {}
        for cid, doc, meta, emb in zip(
            got["ids"], got["documents"], got["metadatas"], got["embeddings"]
        ):
            if cid in exclude or not doc or not meta:
                continue
            chunk = {
                "id": str(cid),
                "text": doc,
                "distance": None,
                "chapter": meta.get("_chapter", ""),
                "book_id": meta.get("_cid"),
                "book_title": meta.get("title", ""),
            }
            # Back matter (afterword, playlist, also-by) lives here too.
            if _is_front_matter(chunk):
                continue
            vec = np.asarray(emb, dtype=float)
            norm = float(np.linalg.norm(vec)) or 1.0
            ranked.append((float(q_vec @ vec) / (q_norm * norm), chunk))
            m = _CHUNK_ID_RE.match(chunk["id"])
            if m:
                by_prefix.setdefault(m.group("prefix"), []).append(
                    (int(m.group("index")), chunk)
                )
        if not ranked:
            return []
        ranked.sort(key=lambda item: item[0], reverse=True)

        # Similarity alone still loses the closing pages, because they are quiet:
        # for this book the last two chunks held the twist ending (the inn, the
        # darkness, "eternal, godforsaken suffering") but ranked below the coach
        # conversation, and the answer confidently reported that she was "finally
        # safe". The final chunks are therefore always included, whatever they
        # score.
        forced: list[str] = []
        for entries in by_prefix.values():
            entries.sort()
            forced.extend(chunk["id"] for _index, chunk in entries[-_TAIL_FORCE:])

        chunks_by_id = {chunk["id"]: chunk for _cosine, chunk in ranked}
        cosine_by_id = {chunk["id"]: cosine for cosine, chunk in ranked}
        order = forced + [chunk["id"] for _cosine, chunk in ranked[:_TAIL_HITS]]
        picked: list[dict] = []
        for cid in order:
            if cid not in chunks_by_id or any(c["id"] == cid for c in picked):
                continue
            picked.append(
                {**chunks_by_id[cid], "distance": 1.0 - cosine_by_id[cid]}
            )
        return picked

    def _lexical_chunks(
        self,
        query: str,
        where_filter: Optional[dict[str, object]],
        exclude: set[str],
        query_embedding: list[float],
    ) -> list[dict]:
        """Passages containing a rare word from the question.

        Vector search answers "what is this about"; it has no way to insist on a
        particular word. This pass asks the index for the literal words instead
        and keeps only the ones that appear in a few chunks, so it adds precision
        without spending context on every question's common nouns.
        """
        seen: set[str] = set()
        candidates: list[str] = []
        for word in re.findall(r"[A-Za-z][A-Za-z'\u2019-]+", query.lower()):
            word = word.strip("'\u2019-")
            if len(word) < 4 or word in _LEXICAL_STOPWORDS or word in seen:
                continue
            seen.add(word)
            candidates.append(word)
            if len(candidates) >= _LEXICAL_MAX_TERMS:
                break
        if not candidates:
            return []

        # Document frequency per word first; only rare words are worth fetching.
        rare: list[tuple[int, str]] = []
        for term in candidates:
            try:
                probe = self.collection.get(
                    where=where_filter,
                    where_document={"$contains": term},
                    include=["metadatas"],
                )
            except Exception as exc:
                logger.warning("Lexical lookup failed for %r", term, exc_info=exc)
                continue
            if 0 < len(probe["ids"]) <= _LEXICAL_DF_MAX:
                rare.append((len(probe["ids"]), term))
        if not rare:
            return []

        rare.sort()
        # Rank the candidates by the same similarity the vector search uses. Their
        # vectors are already in the index, so this costs no embedding calls and
        # keeps the passage that actually answers the question: Emily's account of
        # Dahlia shoving Danny scored 0.625, while a passage that mentions the
        # fountain in passing scored 0.385 and would have been added first.
        pool: dict[str, dict] = {}
        for _df, term in rare[:_LEXICAL_KEEP_TERMS]:
            try:
                got = self.collection.get(
                    where=where_filter,
                    where_document={"$contains": term},
                    include=["documents", "metadatas", "embeddings"],
                )
            except Exception as exc:
                logger.warning("Lexical fetch failed for %r", term, exc_info=exc)
                continue
            for cid, doc, meta, emb in zip(
                got["ids"], got["documents"], got["metadatas"], got["embeddings"]
            ):
                if cid in exclude or cid in pool or not doc or not meta:
                    continue
                chunk = {
                    "id": cid,
                    "text": doc,
                    "distance": None,
                    "chapter": meta.get("_chapter", ""),
                    "book_id": meta.get("_cid"),
                    "book_title": meta.get("title", ""),
                    "lexical": term,
                }
                if _is_front_matter(chunk):
                    continue
                chunk["_vector"] = emb
                pool[cid] = chunk
        if not pool:
            return []

        q_vec = np.asarray(query_embedding, dtype=float)
        q_norm = float(np.linalg.norm(q_vec)) or 1.0
        ranked: list[tuple[float, dict]] = []
        for chunk in pool.values():
            vec = np.asarray(chunk.pop("_vector"), dtype=float)
            norm = float(np.linalg.norm(vec)) or 1.0
            ranked.append((float(q_vec @ vec) / (q_norm * norm), chunk))
        ranked.sort(key=lambda item: item[0], reverse=True)

        added: list[dict] = []
        for cosine, chunk in ranked[:_LEXICAL_MAX_HITS]:
            exclude.add(chunk["id"])
            # ChromaDB's cosine space, so this hit sorts with the semantic ones.
            added.append({**chunk, "distance": 1.0 - cosine})
        return added

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
                options=_chat_options(self.s),
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
                options=_chat_options(self.s),
                stream=True,
            )
            # Timed from the first frame, not from the request: Ollama loads the
            # model inside this call, and at a 98k context window that load alone
            # has been measured at 186 s. Counting it against the answer deadline
            # spent the whole budget before the model had reasoned at all, so a
            # cold start always ended in "the model reasoned for over two minutes"
            # the moment the first reasoning frame arrived.
            first_frame_at: Optional[float] = None
            reasoning: list[str] = []
            reasoning_frames = 0
            saw_content = False
            for frame in stream_resp:
                if first_frame_at is None:
                    first_frame_at = time.monotonic()
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
                    if not saw_content and time.monotonic() - first_frame_at > _THINKING_TIMEOUT_S:
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
