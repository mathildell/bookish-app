"""Chat endpoints with Server-Sent Events for streaming responses."""

import asyncio
import json
import logging
import threading

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from backend import dependencies as deps
from backend.schemas import ChatRequest
from lib.chat import _build_citations

logger = logging.getLogger(__name__)

router = APIRouter()

# Marks the end of a producer thread's output in the queue.
_END = object()


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request):
    """Stream a chat response using Server-Sent Events.

    SSE format per chunk:
      data: {"token":"..."}        - partial token
      data: {"done":true,"answer":"...","citations":[...]}  - final result
      event: error
      data: {"error":"..."}
    """
    # Opening ChromaDB and the Ollama client is blocking work — keep it off the loop.
    engine = await asyncio.to_thread(deps.get_chat_engine)
    if engine is None:
        raise HTTPException(status_code=503, detail="Chat engine not initialized")

    tokens: list[str] = []
    citations: list[dict] = []
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stopped = threading.Event()

    def emit(item):
        """Hand an item to the event loop from the producer thread."""
        try:
            loop.call_soon_threadsafe(queue.put_nowait, item)
        except RuntimeError:
            # Event loop already closed — nobody is listening any more.
            stopped.set()

    def produce():
        """Blocking RAG + generation cycle, run in a worker thread.

        Retrieval and the Ollama HTTP stream are synchronous. Running them on the
        event loop froze the entire server (every other request, including
        /api/health) for the length of a generation, and again for every
        abandoned one.
        """
        try:
            history = [{"role": h["role"], "content": h["content"]} for h in req.history]
            for item_type, payload in engine.chat_stream(
                user_message=req.message,
                history=history,
                calibre_ids=req.calibre_ids,
                scope=req.scope,
                on_token=tokens.append,
            ):
                if stopped.is_set():
                    break
                emit((item_type, payload))
        except Exception as exc:  # surfaced to the client as an SSE error event
            logger.error("SSE generation failed", exc_info=exc)
            emit(("error", str(exc)))
        finally:
            emit((_END, None))

    async def event_generator():
        nonlocal citations
        threading.Thread(target=produce, name="chat-stream", daemon=True).start()
        try:
            while True:
                item_type, payload = await queue.get()
                if item_type is _END:
                    break
                # Drop the rest of the work for a client that walked away.
                if await request.is_disconnected():
                    stopped.set()
                    return
                if item_type == "token":
                    yield f"data: {json.dumps({'token': payload})}\n\n"
                elif item_type == "thinking":
                    yield f"data: {json.dumps({'thinking': payload})}\n\n"
                elif item_type == "error":
                    # Stop here: a trailing "done" with an empty answer would
                    # overwrite the error text the client just rendered.
                    yield f'event: error\ndata: {json.dumps({"error": payload})}\n\n'
                    return
                elif item_type == "chunks":
                    citations = _build_citations(payload)

            yield (
                f'data: {json.dumps({"done": True, "answer": "".join(tokens), "citations": citations})}\n\n'
            )
        finally:
            stopped.set()
            while not queue.empty():
                queue.get_nowait()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        # Any intermediary that honours these will pass frames straight through.
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
