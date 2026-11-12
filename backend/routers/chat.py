"""RAG chat over the indexed books, streamed as Server-Sent Events."""

import asyncio

from fastapi import APIRouter, HTTPException, Request

from backend import dependencies as deps
from backend.schemas import ChatRequest
from backend.sse import stream_from_thread
from lib.chat import build_citations

router = APIRouter()


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request):
    """Stream an answer.

    data: {"thinking": "..."} / {"token": "..."}            — partial output
    data: {"done": true, "answer": "...", "citations": [...]} — final frame
    event: error / data: {"error": "..."}                    — ends the stream
    """
    # Opening ChromaDB and the Ollama client is blocking work — keep it off the loop.
    engine = await asyncio.to_thread(deps.get_chat_engine)
    if engine is None:
        raise HTTPException(status_code=503, detail="Chat engine not initialized")

    history = [h.model_dump() for h in req.history]

    def produce(emit, stopped):
        tokens: list[str] = []
        citations: list[dict] = []
        for kind, payload in engine.chat_stream(
            user_message=req.message,
            history=history,
            calibre_ids=req.calibre_ids,
            scope=req.scope,
            on_token=tokens.append,
        ):
            if stopped.is_set():
                return
            if kind in ("token", "thinking"):
                emit({kind: payload})
            elif kind == "error":
                # Stop here: a trailing "done" with an empty answer would
                # overwrite the error text the client just rendered.
                emit({"error": payload}, event="error")
                return
            elif kind == "chunks":
                citations = build_citations(payload)
        emit({"done": True, "answer": "".join(tokens), "citations": citations})

    return stream_from_thread(request, produce, name="chat")
