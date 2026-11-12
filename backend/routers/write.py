"""Creative writing: stream a scene for a cast of saved character profiles."""

import asyncio

from fastapi import APIRouter, HTTPException, Request

from backend import dependencies as deps
from backend.schemas import WriteRequest, WriteSuggestionsRequest
from backend.sse import stream_from_thread
from lib.writing import WritingEngine

router = APIRouter()


def _engine() -> WritingEngine:
    settings = deps.get_settings()
    if settings is None:
        raise HTTPException(status_code=503, detail="Settings not loaded")
    return WritingEngine(settings)


def _profiles(character_ids: list[int]) -> list[dict]:
    """Load the cast in the order the caller selected it, skipping stale ids."""
    store = deps.get_character_store()
    return [p for p in (store.get(cid) for cid in character_ids) if p]


async def _cast_and_engine(character_ids: list[int]) -> tuple[list[dict], WritingEngine]:
    profiles = await asyncio.to_thread(_profiles, character_ids)
    if not profiles:
        raise HTTPException(status_code=400, detail="Select at least one character")
    return profiles, await asyncio.to_thread(_engine)


@router.post("/write/stream")
async def write_stream(req: WriteRequest, request: Request):
    """Stream a scene, then the three suggestion beats.

    data: {"token": "..."} / {"thinking": "..."}
    data: {"done": true, "answer": "...", "suggestions": ["..."]}
    event: error / data: {"error": "..."}
    """
    profiles, engine = await _cast_and_engine(req.character_ids)
    history = [turn.model_dump() for turn in req.history]

    def produce(emit, stopped):
        tokens: list[str] = []
        result: dict = {}
        for kind, payload in engine.stream_scene(
            message=req.message,
            history=history,
            profiles=profiles,
            genre=req.genre,
            on_token=tokens.append,
        ):
            if stopped.is_set():
                return
            if kind == "result":
                result = payload  # type: ignore[assignment]
            elif kind == "error":
                # Stop here: a trailing done frame would overwrite the error.
                emit({"error": payload}, event="error")
                return
            else:
                emit({kind: payload})
        emit({
            "done": True,
            "answer": result.get("answer") or "".join(tokens),
            "suggestions": result.get("suggestions") or [],
        })

    return stream_from_thread(request, produce, name="write")


@router.post("/write/suggestions")
async def write_suggestions(req: WriteSuggestionsRequest):
    """Regenerate just the three beats from the scene so far."""
    profiles, engine = await _cast_and_engine(req.character_ids)
    history = [turn.model_dump() for turn in req.history]
    suggestions = await asyncio.to_thread(engine.suggest, profiles, history)
    return {"suggestions": suggestions}
