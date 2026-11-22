"""Creative writing: stream a scene for a cast of saved character profiles."""

import asyncio

from fastapi import APIRouter, HTTPException, Request

from backend import dependencies as deps
from backend.schemas import (
    DiscussRequest,
    DistillRequest,
    PlanRequest,
    WriteRequest,
    WriteSuggestionsRequest,
)
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


def _worlds(world_ids: list[int]) -> list[dict]:
    """The selected world sheets, in the order chosen, skipping stale ids."""
    store = deps.get_world_store()
    return [w for w in (store.get(wid) for wid in world_ids) if w]


async def _cast_and_engine(
    character_ids: list[int], world_ids: list[int] | None = None, *, need_cast: bool = True
) -> tuple[list[dict], list[dict], WritingEngine]:
    profiles = await asyncio.to_thread(_profiles, character_ids)
    worlds = await asyncio.to_thread(_worlds, world_ids or [])
    if need_cast and not profiles:
        raise HTTPException(status_code=400, detail="Select at least one character")
    return profiles, worlds, await asyncio.to_thread(_engine)


@router.post("/write/stream")
async def write_stream(req: WriteRequest, request: Request):
    """Stream a scene, then the three suggestion beats.

    data: {"token": "..."} / {"thinking": "..."}
    data: {"done": true, "answer": "...", "suggestions": ["..."]}
    event: error / data: {"error": "..."}
    """
    profiles, worlds, engine = await _cast_and_engine(req.character_ids, req.world_ids)
    history = [turn.model_dump() for turn in req.history]

    def produce(emit, stopped):
        tokens: list[str] = []
        result: dict = {}
        for kind, payload in engine.stream_scene(
            message=req.message,
            history=history,
            profiles=profiles,
            worlds=worlds,
            notes=req.notes,
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


@router.post("/write/discuss")
async def write_discuss(req: DiscussRequest, request: Request):
    """Stream an analytical answer about the cast and world (not prose).

    data: {"token": "..."} / {"thinking": "..."}
    data: {"done": true, "answer": "..."}
    event: error / data: {"error": "..."}
    """
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Ask a question")
    profiles, worlds, engine = await _cast_and_engine(req.character_ids, req.world_ids, need_cast=False)
    if not profiles and not worlds:
        raise HTTPException(status_code=400, detail="Select a character or a world to discuss")
    history = [turn.model_dump() for turn in req.history]

    def produce(emit, stopped):
        result: dict = {}
        for kind, payload in engine.stream_discussion(
            message=req.message, history=history, profiles=profiles, worlds=worlds, notes=req.notes
        ):
            if stopped.is_set():
                return
            if kind == "result":
                result = payload  # type: ignore[assignment]
            elif kind == "error":
                emit({"error": payload}, event="error")
                return
            else:
                emit({kind: payload})
        emit({"done": True, "answer": result.get("answer") or ""})

    return stream_from_thread(request, produce, name="discuss")


@router.post("/write/suggestions")
async def write_suggestions(req: WriteSuggestionsRequest):
    """Regenerate just the three beats (or follow-up questions) from the thread so far."""
    discuss = req.mode == "discuss"
    profiles, worlds, engine = await _cast_and_engine(
        req.character_ids, req.world_ids, need_cast=not discuss
    )
    history = [turn.model_dump() for turn in req.history]
    suggestions = await asyncio.to_thread(
        engine.suggest, profiles, history, worlds, req.notes, "discuss" if discuss else "write"
    )
    return {"suggestions": suggestions}


@router.post("/write/plan")
async def write_plan(req: PlanRequest):
    """Scene cards (title, setting, conflict, brief) planned from the discussion."""
    profiles, worlds, engine = await _cast_and_engine(req.character_ids, req.world_ids, need_cast=False)
    if not profiles and not worlds:
        raise HTTPException(status_code=400, detail="Select a character or a world to plan with")
    history = [turn.model_dump() for turn in req.history]
    try:
        scenes = await asyncio.to_thread(
            lambda: engine.plan_scenes(
                message=req.message, history=history, profiles=profiles,
                worlds=worlds, notes=req.notes, count=req.count,
            )
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Planning failed: {exc}") from exc
    return {"scenes": scenes}


@router.post("/write/distill")
async def write_distill(req: DistillRequest):
    """A scene brief or one-line story note condensed from a discussion reply."""
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Nothing to condense")
    profiles, _, engine = await _cast_and_engine(req.character_ids, need_cast=False)
    try:
        text = await asyncio.to_thread(engine.distill, req.content, req.kind, profiles)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Condensing failed: {exc}") from exc
    return {"text": text}
