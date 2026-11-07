"""Character profile endpoints.

CRUD is AI-free so the library works even when Ollama is down; discovery and
profile synthesis stream over SSE because each involves several blocking model
calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from backend import dependencies as deps
from backend.schemas import (
    Character,
    CharacterCreate,
    CharacterMergeRequest,
    CharacterUpdate,
    DiscoverRequest,
    ProfilesRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Marks the end of a producer thread's output in the queue.
_END = object()

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _store():
    return deps.get_character_store()


# --------------------------------------------------------------------------- #
# CRUD                                                                        #
# --------------------------------------------------------------------------- #

@router.get("/characters", response_model=list[Character])
def list_characters(q: Optional[str] = None, calibre_id: Optional[int] = None):
    """All saved profiles, optionally filtered by a source book or a text query."""
    return _store().list(query=q, calibre_id=calibre_id)


@router.post("/characters", response_model=Character, status_code=201)
def create_character(req: CharacterCreate):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    payload = req.model_dump()
    payload["name"] = req.name.strip()
    return _store().create(payload)


@router.post("/characters/discover")
async def discover_characters(req: DiscoverRequest, request: Request):
    """SSE: candidate cast list for the selected books.

    Per-book events while sampling, then one `candidates` event annotated with
    `already_extracted` / `possible_duplicate` against the saved library.
    """
    if not req.calibre_ids:
        raise HTTPException(status_code=400, detail="Select at least one book")

    try:
        extractor = await asyncio.to_thread(deps.get_character_extractor)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    store = await asyncio.to_thread(deps.get_character_store)
    calibre_ids = [int(c) for c in req.calibre_ids]

    def producer(emit, stopped):
        titles = _titles(calibre_ids)
        for event in extractor.discover(calibre_ids, titles, req.guidance):
            if stopped.is_set():
                return
            if event.get("event") == "candidates":
                event["candidates"] = _annotate(store, event["candidates"])
            emit(event)

    return await _sse_stream(producer, request)


@router.post("/characters/profiles")
async def generate_profiles(req: ProfilesRequest, request: Request):
    """SSE: build full profiles for the chosen candidates, saving each as it lands."""
    if not req.characters:
        raise HTTPException(status_code=400, detail="Select at least one character")

    try:
        extractor = await asyncio.to_thread(deps.get_character_extractor)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    store = await asyncio.to_thread(deps.get_character_store)
    items = [c.model_dump() for c in req.characters]

    # Read every selected book for evidence, not just the ones discovery sampled a
    # name in. The union is also what gets recorded, because it is what informed the
    # profile.
    run_sources = sorted({int(c) for c in req.calibre_ids})
    for item in items:
        own = {int(c) for c in (item.get("calibre_ids") or [])}
        item["calibre_ids"] = sorted(own | set(run_sources))

    def producer(emit, stopped):
        for event in extractor.stream_profiles(items, req.guidance):
            if stopped.is_set():
                return
            if event.get("event") == "ok":
                item = next(i for i in items if i["name"] == event["name"])
                event["character"] = _persist(store, item, event["profile"])
            emit(event)

    return await _sse_stream(producer, request)


@router.get("/characters/{character_id}", response_model=Character)
def get_character(character_id: int):
    character = _store().get(character_id)
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


@router.patch("/characters/{character_id}", response_model=Character)
def update_character(character_id: int, req: CharacterUpdate):
    patch = req.model_dump(exclude_none=True)
    if not patch:
        character = _store().get(character_id)
        if not character:
            raise HTTPException(status_code=404, detail="Character not found")
        return character
    character = _store().update(character_id, patch)
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


@router.delete("/characters/{character_id}")
def delete_character(character_id: int):
    if not _store().delete(character_id):
        raise HTTPException(status_code=404, detail="Character not found")
    return {"ok": True}


@router.post("/characters/{character_id}/merge", response_model=Character)
def merge_characters(character_id: int, req: CharacterMergeRequest):
    """Fold another profile into this one (sources and aliases are unioned)."""
    if req.other_id == character_id:
        raise HTTPException(status_code=400, detail="Cannot merge a character into itself")
    merged = _store().merge(character_id, req.other_id)
    if not merged:
        raise HTTPException(status_code=404, detail="Character not found")
    return merged


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def _titles(calibre_ids: list[int]) -> dict[int, str]:
    try:
        reader = deps.get_reader()
    except RuntimeError:
        return {}
    titles: dict[int, str] = {}
    for calibre_id in calibre_ids:
        try:
            record = reader.get_book_by_id(calibre_id)
            if record:
                titles[int(calibre_id)] = record.title
        except Exception:  # a missing book must not abort discovery
            continue
    return titles


def _annotate(store, candidates: list[dict]) -> list[dict]:
    """Flag candidates that already exist, so the UI can disable them."""
    for candidate in candidates:
        found: dict[int, dict] = {}
        for key in [candidate["name"], *(candidate.get("aliases") or [])]:
            for match in store.find_by_identity(key):
                found[int(match["id"])] = match

        if not found:
            candidate["existing_id"] = None
            candidate["already_extracted"] = False
            candidate["possible_duplicate"] = False
            continue

        selected = set(candidate.get("source_book_ids") or [])
        primary = max(found.values(), key=lambda m: len(set(m["source_book_ids"]) & selected))
        candidate["existing_id"] = primary["id"]
        candidate["existing_name"] = primary["name"]
        # Complete only when the saved profile already covers every selected book.
        candidate["already_extracted"] = selected.issubset(set(primary["source_book_ids"]))
        # Two saved profiles matched this name/alias set — merging silently would
        # destroy one, so flag it for the user instead.
        candidate["possible_duplicate"] = len(found) > 1
    return candidates


def _persist(store, item: dict, profile: dict) -> dict:
    """Save a generated profile, extending an existing card rather than duplicating it."""
    sources = sorted({int(c) for c in (item.get("calibre_ids") or [])})
    aliases = [a for a in (item.get("aliases") or []) if a]

    existing = store.find_by_identity(item["name"])
    if existing:
        keep = existing[0]
        updated = store.update(keep["id"], {
            **profile,
            "aliases": sorted(set(keep["aliases"]) | set(aliases)),
            "source_book_ids": sorted(set(keep["source_book_ids"]) | set(sources)),
            "role": item.get("role") or keep.get("role"),
        })
        if updated:
            return updated

    return store.create({
        **profile,
        "name": item["name"],
        "aliases": aliases,
        "role": item.get("role"),
        "source_book_ids": sources,
    })


async def _sse_stream(producer, request: Request) -> StreamingResponse:
    """Run a blocking generator in a worker thread and relay its dicts as SSE.

    Extraction is synchronous (Ollama + ChromaDB), so running it on the event loop
    would freeze every other request for the length of the job.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stopped = threading.Event()

    def emit(payload):
        try:
            loop.call_soon_threadsafe(queue.put_nowait, payload)
        except RuntimeError:
            stopped.set()

    def run():
        try:
            producer(emit, stopped)
        except Exception as exc:  # surfaced to the client as an SSE error event
            logger.error("Character extraction failed", exc_info=exc)
            emit({"event": "error", "error": str(exc)})
        finally:
            emit(_END)

    async def generator():
        threading.Thread(target=run, name="character-stream", daemon=True).start()
        try:
            while True:
                payload = await queue.get()
                if payload is _END:
                    break
                if await request.is_disconnected():
                    stopped.set()
                    return
                yield f"data: {json.dumps(payload)}\n\n"
        finally:
            stopped.set()
            while not queue.empty():
                queue.get_nowait()

    return StreamingResponse(generator(), media_type="text/event-stream", headers=_SSE_HEADERS)
