"""Character list endpoints — a cast, deliberately separate from book lists.

A book list is a shelf of Calibre ids; a character list is a set of profile ids. They
share nothing but a name shape, so they get their own routes and their own file.
"""

import json
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.schemas import (
    CharacterList,
    CreateCharacterListRequest,
    UpdateCharacterListRequest,
)


DATA_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "character_lists.json"
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


@router.get("/character-lists", response_model=list[CharacterList])
async def get_character_lists():
    """Every saved character list with its member profile ids."""
    with _lock:
        return _load()


@router.post("/character-lists", response_model=CharacterList, status_code=201)
async def create_character_list(req: CreateCharacterListRequest):
    """Create an empty character list. Name must be non-blank."""
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    with _lock:
        data = _load()
        new_item = {"id": _next_id(data), "name": name, "character_ids": []}
        data.append(new_item)
        _save(data)
    return new_item


@router.patch("/character-lists/{list_id}", response_model=CharacterList)
async def update_character_list(list_id: int, req: UpdateCharacterListRequest):
    """Rename a list and/or replace its membership. Only supplied fields change."""
    with _lock:
        data = _load()
        for item in data:
            if item["id"] != list_id:
                continue
            if req.name is not None:
                new_name = req.name.strip()
                if new_name:
                    item["name"] = new_name
            if req.character_ids is not None:
                item["character_ids"] = sorted(set(req.character_ids))
            _save(data)
            return item
    raise HTTPException(status_code=404, detail="Character list not found")


@router.delete("/character-lists/{list_id}")
async def delete_character_list(list_id: int):
    """Remove a character list entirely; profiles themselves are untouched."""
    with _lock:
        data = _load()
        new_data = [item for item in data if item["id"] != list_id]
        if len(new_data) == len(data):
            raise HTTPException(status_code=404, detail="Character list not found")
        _save(new_data)
    return {"ok": True}
