"""Creative writing endpoints.

Generation runs in a worker thread and streams over SSE, exactly like chat: the
Ollama client is synchronous, and running it on the event loop would freeze every
other request for the length of a scene.
"""

import asyncio
import json
import logging
import threading

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from backend import dependencies as deps
from backend.schemas import WriteRequest, WriteSuggestionsRequest
from lib.writing import WritingEngine

logger = logging.getLogger(__name__)

router = APIRouter()

# Marks the end of a producer thread's output in the queue.
_END = object()

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _engine() -> WritingEngine:
    settings = deps.get_settings()
    if settings is None:
        raise HTTPException(status_code=503, detail="Settings not loaded")
    return WritingEngine(settings)


def _profiles(character_ids: list[int]) -> list[dict]:
    """Load the cast in the order the caller selected it, skipping stale ids."""
    store = deps.get_character_store()
    profiles: list[dict] = []
    for character_id in character_ids:
        profile = store.get(character_id)
        if profile:
            profiles.append(profile)
    return profiles


@router.post("/write/stream")
async def write_stream(req: WriteRequest, request: Request):
    """Stream a scene, then the three suggestion beats.

    data: {"token":"..."} / {"thinking":"..."}
    data: {"done":true,"answer":"...","suggestions":["..."]}
    """
    profiles = await asyncio.to_thread(_profiles, req.character_ids)
    if not profiles:
        raise HTTPException(status_code=400, detail="Select at least one character")

    engine = await asyncio.to_thread(_engine)
    history = [turn.model_dump() for turn in req.history]

    tokens: list[str] = []
    result: dict = {"answer": "", "suggestions": []}
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stopped = threading.Event()

    def emit(item):
        try:
            loop.call_soon_threadsafe(queue.put_nowait, item)
        except RuntimeError:
            stopped.set()

    def produce():
        try:
            for item_type, payload in engine.stream_scene(
                message=req.message,
                history=history,
                profiles=profiles,
                genre=req.genre,
                on_token=tokens.append,
            ):
                if stopped.is_set():
                    break
                if item_type == "result":
                    result.update(payload)  # type: ignore[arg-type]
                    continue
                emit((item_type, payload))
        except Exception as exc:  # surfaced to the client as an SSE error event
            logger.error("Scene SSE failed", exc_info=exc)
            emit(("error", str(exc)))
        finally:
            emit((_END, None))

    async def event_generator():
        threading.Thread(target=produce, name="write-stream", daemon=True).start()
        try:
            while True:
                item_type, payload = await queue.get()
                if item_type is _END:
                    break
                if await request.is_disconnected():
                    stopped.set()
                    return
                if item_type == "token":
                    yield f"data: {json.dumps({'token': payload})}\n\n"
                elif item_type == "thinking":
                    yield f"data: {json.dumps({'thinking': payload})}\n\n"
                elif item_type == "error":
                    # Stop here: a trailing done event would overwrite the error.
                    yield f'event: error\ndata: {json.dumps({"error": payload})}\n\n'
                    return

            answer = result.get("answer") or "".join(tokens)
            yield (
                f"data: {json.dumps({'done': True, 'answer': answer, 'suggestions': result.get('suggestions') or []})}\n\n"
            )
        finally:
            stopped.set()
            while not queue.empty():
                queue.get_nowait()

    return StreamingResponse(
        event_generator(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


@router.post("/write/suggestions")
async def write_suggestions(req: WriteSuggestionsRequest):
    """Regenerate just the three beats from the scene so far."""
    profiles = await asyncio.to_thread(_profiles, req.character_ids)
    if not profiles:
        raise HTTPException(status_code=400, detail="Select at least one character")

    engine = await asyncio.to_thread(_engine)
    history = [turn.model_dump() for turn in req.history]
    suggestions = await asyncio.to_thread(engine.suggest, profiles, history)
    return {"suggestions": suggestions}
