"""List management endpoints with JSON file persistence."""

import json
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.schemas import BookList, CreateListRequest, UpdateListRequest


DATA_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "lists.json"
_lock = threading.Lock()


def _load() -> list[dict]:
    if not DATA_FILE.exists():
        return []
    try:
        data = json.loads(DATA_FILE.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save(data: list[dict]):
    DATA_FILE.write_text(json.dumps(data, indent=2))


def _next_id(data: list[dict]) -> int:
    return max((item["id"] for item in data), default=0) + 1


router = APIRouter()


@router.get("/lists")
async def get_lists():
    """Return all saved book lists."""
    with _lock:
        return _load()


@router.post("/lists")
async def create_list(req: CreateListRequest):
    """Create a new empty list. Name must be non-blank."""
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    with _lock:
        data = _load()
        new_item = {"id": _next_id(data), "name": name, "book_ids": []}
        data.append(new_item)
        _save(data)
    return new_item


@router.patch("/lists/{list_id}")
async def update_list(list_id: int, req: UpdateListRequest):
    """Update a list — only supplied fields are changed."""
    with _lock:
        data = _load()
        for item in data:
            if item["id"] == list_id:
                if req.name is not None:
                    new_name = req.name.strip()
                    if new_name:
                        item["name"] = new_name
                if req.book_ids is not None:
                    item["book_ids"] = sorted(set(req.book_ids))
                _save(data)
                return item
    raise HTTPException(status_code=404, detail="List not found")


@router.delete("/lists/{list_id}")
async def delete_list(list_id: int):
    """Remove a list entirely."""
    with _lock:
        data = _load()
        new_data = [item for item in data if item["id"] != list_id]
        if len(new_data) == len(data):
            raise HTTPException(status_code=404, detail="List not found")
        _save(new_data)
    return {"ok": True}