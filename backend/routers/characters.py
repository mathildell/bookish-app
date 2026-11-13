"""Character profile endpoints.

CRUD is AI-free so the library works even when Ollama is down; discovery and
profile synthesis stream over SSE because each involves several blocking model
calls.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from backend import dependencies as deps
from backend.schemas import (
    Character,
    CharacterCreate,
    CharacterUpdate,
    DiscoverRequest,
    ProfilesRequest,
    RefineRequest,
)
from backend.sse import stream_from_thread

router = APIRouter()


def _store():
    return deps.get_character_store()


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="Character not found")


async def _extraction_services():
    """The extractor (ChromaDB + Ollama) and the profile store, loaded off the loop."""
    try:
        extractor = await asyncio.to_thread(deps.get_character_extractor)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return extractor, await asyncio.to_thread(deps.get_character_store)


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

    extractor, store = await _extraction_services()
    calibre_ids = await asyncio.to_thread(_reading_order, [int(c) for c in req.calibre_ids])

    def producer(emit, stopped):
        titles = _titles(calibre_ids)
        for event in extractor.discover(calibre_ids, titles, req.guidance):
            if stopped.is_set():
                return
            if event.get("event") == "candidates":
                event["candidates"] = _annotate(store, event["candidates"])
            emit(event)

    return stream_from_thread(request, producer, name="characters", error_as_event=False)


@router.post("/characters/profiles")
async def generate_profiles(req: ProfilesRequest, request: Request):
    """SSE: build full profiles for the chosen candidates, saving each as it lands."""
    if not req.characters:
        raise HTTPException(status_code=400, detail="Select at least one character")

    extractor, store = await _extraction_services()
    items = [c.model_dump() for c in req.characters]

    # Read every selected book for evidence, not just the ones discovery sampled a
    # name in. The union is also what gets recorded, because it is what informed the
    # profile.
    # Reading order (series order) matters: the profile's arc is built from it.
    run_sources = [int(c) for c in req.calibre_ids]
    every = {c for item in items for c in (item.get("calibre_ids") or [])} | set(run_sources)
    order = {cid: i for i, cid in enumerate(await asyncio.to_thread(_reading_order, sorted(every)))}
    for item in items:
        own = {int(c) for c in (item.get("calibre_ids") or [])}
        item["calibre_ids"] = sorted(own | set(run_sources), key=lambda c: order.get(c, 1 << 30))

    def producer(emit, stopped):
        for event in extractor.stream_profiles(items, req.guidance):
            if stopped.is_set():
                return
            if event.get("event") == "ok":
                item = next(i for i in items if i["name"] == event["name"])
                event["character"] = _persist(store, item, event["profile"])
            emit(event)

    return stream_from_thread(request, producer, name="characters", error_as_event=False)


@router.get("/characters/{character_id}", response_model=Character)
def get_character(character_id: int):
    character = _store().get(character_id)
    if not character:
        raise _not_found()
    return character


@router.post("/characters/{character_id}/refine")
async def refine_character(character_id: int, req: RefineRequest, request: Request):
    """SSE: another pass over a saved profile.

    Reads passages earlier passes did not, merges them with the stored evidence,
    and reviews the sheet against the combined themes. Fields the user edited by
    hand are kept as they are.
    """
    extractor, store = await _extraction_services()
    character = await asyncio.to_thread(store.get, character_id)
    if not character:
        raise _not_found()
    if not character.get("source_book_ids"):
        raise HTTPException(status_code=400, detail="This profile has no source books to read")
    calibre_ids = await asyncio.to_thread(_reading_order, character["source_book_ids"])

    def producer(emit, stopped):
        for event in extractor.refine(character, calibre_ids, req.guidance):
            if stopped.is_set():
                return
            if event.get("event") == "ok":
                event["character"] = _save_generated(store, character_id, event.pop("profile"))
            emit(event)

    return stream_from_thread(request, producer, name="characters", error_as_event=False)


# Generated fields a hand edit locks. Name, aliases, role and sources are identity,
# not generated text, so editing them locks nothing.
_LOCKABLE = (
    "archetype", "summary", "core_traits", "motivations", "fears", "flaws", "values",
    "voice", "mannerisms", "appearance", "relationships", "formative_experience",
    "arc_pattern", "situational_anchors",
)


@router.patch("/characters/{character_id}", response_model=Character)
def update_character(character_id: int, req: CharacterUpdate):
    patch = req.model_dump(exclude_none=True)
    store = _store()
    current = store.get(character_id)
    if not current:
        raise _not_found()

    # A field whose value the user changed is locked, so a later refine or
    # re-profile cannot overwrite it. The edit form sends every field, so only
    # real changes count; an explicit `locked_fields` (e.g. unlocking) is the base.
    locked = set(patch.get("locked_fields", current.get("locked_fields") or []))
    baseline = Character.model_validate(current).model_dump()
    for field_name in _LOCKABLE:
        if field_name in patch and patch[field_name] != baseline.get(field_name):
            locked.add(field_name)
    patch["locked_fields"] = sorted(f for f in locked if f in _LOCKABLE)

    character = store.update(character_id, patch)
    if not character:
        raise _not_found()
    return character


@router.delete("/characters/{character_id}")
def delete_character(character_id: int):
    if not _store().delete(character_id):
        raise _not_found()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def _titles(calibre_ids: list[int]) -> dict[int, str]:
    reader = deps.get_reader()
    if reader is None:
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


def _reading_order(calibre_ids: list[int]) -> list[int]:
    """Books in the order they are meant to be read: by series, then series index.

    Calibre ids follow import order, which for a trilogy can be 2, 1, 3. The profile
    arc ("early in the series… later…") is only right when the books are not.
    """
    ids = list(dict.fromkeys(int(c) for c in calibre_ids))
    reader = deps.get_reader()
    if reader is None or len(ids) < 2:
        return ids
    keys: dict[int, tuple] = {}
    for position, calibre_id in enumerate(ids):
        try:
            record = reader.get_book_by_id(calibre_id)
        except Exception:  # a missing book keeps its place
            record = None
        if record and record.series_name:
            keys[calibre_id] = (record.series_name.lower(), float(record.series_index or 0), position)
        else:
            keys[calibre_id] = ("\uffff", float(position), position)
    return sorted(ids, key=lambda c: keys[c])


def _save_generated(store, character_id: int, profile: dict) -> dict:
    """Write generated fields onto a saved profile, never over a locked one."""
    current = store.get(character_id) or {}
    locked = set(current.get("locked_fields") or [])
    return store.update(character_id, {k: v for k, v in profile.items() if k not in locked})


def _persist(store, item: dict, profile: dict) -> dict:
    """Save a generated profile, extending an existing card rather than duplicating it."""
    sources = sorted({int(c) for c in (item.get("calibre_ids") or [])})
    aliases = [a for a in (item.get("aliases") or []) if a]

    existing = store.find_by_identity(item["name"])
    if existing:
        keep = existing[0]
        locked = set(keep.get("locked_fields") or [])
        updated = store.update(keep["id"], {
            **{k: v for k, v in profile.items() if k not in locked},
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
