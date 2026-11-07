"""Bookmarked chat answers ("post-it notes") with JSON file persistence."""

import json
import threading
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.schemas import BookmarkCreate, BookmarkUpdate


DATA_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "bookmarks.json"
_lock = threading.Lock()

DEFAULT_COLOR = "yellow"


def _load() -> list[dict]:
    if not DATA_FILE.exists():
        return []
    try:
        data = json.loads(DATA_FILE.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save(data: list[dict]):
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, indent=2))


def _next_id(data: list[dict]) -> int:
    return max((int(item.get("id", 0)) for item in data), default=0) + 1


router = APIRouter()


@router.get("/bookmarks")
def get_bookmarks():
    """Return every saved note, newest first."""
    with _lock:
        data = _load()
    return sorted(data, key=lambda b: b.get("created_at", ""), reverse=True)


@router.post("/bookmarks")
def create_bookmark(req: BookmarkCreate):
    """Save an answer. Identical question + answer returns the existing note."""
    question = req.question.strip()
    answer = req.answer.strip()
    if not answer:
        raise HTTPException(status_code=400, detail="Answer is required")

    with _lock:
        data = _load()
        for item in data:
            if item.get("question") == question and item.get("answer") == answer:
                return item

        note = {
            "id": _next_id(data),
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "question": question,
            "answer": answer,
            "citations": [c.model_dump() for c in req.citations],
            "scope": req.scope,
            "calibre_ids": [int(i) for i in req.calibre_ids],
            "note": req.note.strip(),
            "color": req.color or DEFAULT_COLOR,
        }
        data.append(note)
        _save(data)
    return note


@router.patch("/bookmarks/{bookmark_id}")
def update_bookmark(bookmark_id: int, req: BookmarkUpdate):
    """Patch a note's user-written text or colour."""
    with _lock:
        data = _load()
        for item in data:
            if int(item.get("id", 0)) == bookmark_id:
                if req.note is not None:
                    item["note"] = req.note.strip()
                if req.color is not None:
                    item["color"] = req.color
                _save(data)
                return item
    raise HTTPException(status_code=404, detail="Bookmark not found")


@router.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int):
    with _lock:
        data = _load()
        new_data = [item for item in data if int(item.get("id", 0)) != bookmark_id]
        if len(new_data) == len(data):
            raise HTTPException(status_code=404, detail="Bookmark not found")
        _save(new_data)
    return {"ok": True}
