"""Worldbuilding sheet endpoints.

CRUD is AI-free; extraction streams over SSE because it reads many passages through
the model. Extraction and the profile pipeline share their book-reading helpers.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from backend import dependencies as deps
from backend.routers.characters import _reading_order, _titles
from backend.schemas import (
    ResetMemoryRequest,
    ResolveVariantRequest,
    World,
    WorldCreate,
    WorldExtractRequest,
    WorldRefineRequest,
    WorldUpdate,
)
from backend.sse import stream_from_thread
from lib.world_extractor import apply_changes, resolve_variant

router = APIRouter()

# Generated fields a hand edit locks, so re-extracting never overwrites them.
_LOCKABLE = (
    "premise", "rules", "social_structure", "tropes", "settings",
    "terminology", "tensions", "variants",
)


def _store():
    return deps.get_world_store()


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="World not found")


@router.get("/worlds", response_model=list[World])
def list_worlds(q: Optional[str] = None, calibre_id: Optional[int] = None):
    return _store().list(query=q, calibre_id=calibre_id)


@router.post("/worlds", response_model=World, status_code=201)
def create_world(req: WorldCreate):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    payload = req.model_dump()
    payload["name"] = req.name.strip()
    return _store().create(payload)


@router.post("/worlds/extract")
async def extract_world(req: WorldExtractRequest, request: Request):
    """SSE: read the selected books and save (or extend) the named world.

    {"event": "progress", "message": "..."} while reading, then
    {"event": "ok", "world": {...}} or {"event": "error", "error": "..."}.
    A name that already exists is extended like a refine, so earlier notes are kept.
    """
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the world a name")
    if not req.calibre_ids:
        raise HTTPException(status_code=400, detail="Select at least one book")

    extractor, store = await _services()
    existing = next((w for w in await asyncio.to_thread(store.list) if w["name"].strip().lower() == name.lower()), None)
    if existing:
        return await _refine_stream(request, extractor, store, existing, req.calibre_ids, req.guidance)

    calibre_ids = await asyncio.to_thread(_reading_order, [int(c) for c in req.calibre_ids])

    def producer(emit, stopped):
        titles = _titles(calibre_ids)
        for event in extractor.extract(calibre_ids, titles, name, req.guidance):
            if stopped.is_set():
                return
            if event.get("event") == "ok":
                sheet = event.pop("sheet")
                event["world"] = store.create({
                    **sheet, "name": name, "source_book_ids": event.pop("sources"),
                })
            emit(event)

    return stream_from_thread(request, producer, name="worlds", error_as_event=False)


@router.post("/worlds/{world_id}/refine")
async def refine_world(world_id: int, req: WorldRefineRequest, request: Request):
    """SSE: another pass over a saved world, optionally with extra books.

    Reads passages earlier passes did not (all of a newly added book's), merges them
    with the stored notes, and revises the sheet. Fields edited by hand are kept.
    """
    extractor, store = await _services()
    world = await asyncio.to_thread(store.get, world_id)
    if not world:
        raise _not_found()
    return await _refine_stream(request, extractor, store, world, req.calibre_ids, req.guidance)


async def _services():
    try:
        extractor = await asyncio.to_thread(deps.get_world_extractor)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return extractor, await asyncio.to_thread(deps.get_world_store)


async def _refine_stream(request, extractor, store, world: dict, extra_ids: list[int], guidance: str):
    have = set(world.get("source_book_ids") or [])
    added = [int(c) for c in dict.fromkeys(extra_ids) if int(c) not in have]
    everything = [*world.get("source_book_ids", []), *added]
    if not everything:
        raise HTTPException(status_code=400, detail="This world has no source books to read — add some first")
    calibre_ids = await asyncio.to_thread(_reading_order, everything)
    world_id = int(world["id"])

    def producer(emit, stopped):
        titles = _titles(calibre_ids)
        for event in extractor.refine(world, calibre_ids, titles, guidance, new_ids=added):
            if stopped.is_set():
                return
            if event.get("event") == "ok":
                sheet = event.pop("sheet")
                readable = set(event.pop("sources"))
                locked = set(world.get("locked_fields") or [])
                # A book that could not be read now is still a source; one that was just
                # added but is unreadable is not.
                sources = sorted(have | (readable & set(added)))
                event["world"] = store.update(world_id, {
                    **{k: v for k, v in sheet.items() if k not in locked},
                    "source_book_ids": sources,
                })
            emit(event)

    return stream_from_thread(request, producer, name="worlds", error_as_event=False)


@router.get("/worlds/{world_id}", response_model=World)
def get_world(world_id: int):
    world = _store().get(world_id)
    if not world:
        raise _not_found()
    return world


@router.patch("/worlds/{world_id}", response_model=World)
def update_world(world_id: int, req: WorldUpdate):
    patch = req.model_dump(exclude_none=True)
    store = _store()
    current = store.get(world_id)
    if not current:
        raise _not_found()

    if "source_weights" in patch:
        # Only known levels for real source books; "normal" is the default, so not stored.
        sources = {str(b) for b in current.get("source_book_ids") or []}
        patch["source_weights"] = {
            str(k): v for k, v in patch["source_weights"].items()
            if str(k) in sources and v in ("emphasise", "primary")
        }

    # Same rule as character profiles: a field whose value the user changed is locked.
    locked = set(patch.get("locked_fields", current.get("locked_fields") or []))
    baseline = World.model_validate(current).model_dump()
    for field_name in _LOCKABLE:
        if field_name in patch and patch[field_name] != baseline.get(field_name):
            locked.add(field_name)
    patch["locked_fields"] = sorted(f for f in locked if f in _LOCKABLE)

    world = store.update(world_id, patch)
    if not world:
        raise _not_found()
    return world


@router.post("/worlds/{world_id}/variants/resolve")
async def resolve_world_variant(world_id: int, req: ResolveVariantRequest):
    """Settle one "where sources differ" entry.

    The chosen version is adopted: the model proposes minimal edits so no rule, norm,
    convention, setting or tension contradicts it, the edits are applied (locked fields
    excepted), the entry leaves `variants`, and the decision is remembered so a later
    refine does not reopen the question. `dismiss` just drops the entry.
    """
    store = _store()
    world = await asyncio.to_thread(store.get, world_id)
    if not world:
        raise _not_found()
    variants = list(world.get("variants") or [])
    if req.variant not in variants:
        raise HTTPException(status_code=409, detail="That disagreement is no longer on the sheet")
    remaining = [v for v in variants if v != req.variant]

    if req.dismiss:
        saved = await asyncio.to_thread(store.update, world_id, {"variants": remaining})
        return {"world": saved, "changes": []}

    decision = req.decision.strip()
    if not decision:
        raise HTTPException(status_code=400, detail="Say which version is right")
    try:
        extractor = await asyncio.to_thread(deps.get_world_extractor)
        proposed = await asyncio.to_thread(resolve_variant, extractor, world, req.variant, decision)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — the model call failed; nothing was changed
        raise HTTPException(status_code=502, detail=f"Couldn't apply that decision: {exc}") from exc

    locked = set(world.get("locked_fields") or [])
    fields, done = apply_changes(world, proposed, locked)
    saved = await asyncio.to_thread(
        store.update,
        world_id,
        {
            **fields,
            "variants": remaining,
            "decisions": [*(world.get("decisions") or []), decision],
        },
    )
    skipped = [c.get("field") for c in proposed if c.get("field") in locked]
    return {"world": saved, "changes": done, "locked_skipped": sorted(set(skipped))}


@router.post("/worlds/{world_id}/reset")
def reset_world_reading(world_id: int, req: ResetMemoryRequest):
    """Mark passages unread (one book, or all) so the next refine can read them again.

    Non-destructive: the sheet, the notes already taken and the source weights are all
    kept. Only the list of passages already read is cleared, which is what makes a
    refine skip them. Re-reading yields notes that merge with the stored ones.
    """
    store = _store()
    world = store.get(world_id)
    if not world:
        raise _not_found()
    analysis = dict(world.get("analysis") or {})
    used = list(analysis.get("used") or [])
    if req.calibre_id is None:
        analysis["used"] = []
    else:
        prefix = f"{int(req.calibre_id)}:"
        analysis["used"] = [k for k in used if not str(k).startswith(prefix)]
    saved = store.update(world_id, {"analysis": analysis})
    return {"world": saved, "unread_passages": len(used) - len((saved.get("analysis") or {}).get("used") or [])}


@router.delete("/worlds/{world_id}")
def delete_world(world_id: int):
    if not _store().delete(world_id):
        raise _not_found()
    return {"ok": True}
