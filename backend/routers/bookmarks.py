"""Bookmarked chat answers ("post-it notes"), persisted in `data/bookmarks.json`."""

from datetime import datetime

from fastapi import APIRouter, HTTPException

from backend.schemas import BookmarkCreate, BookmarkUpdate
from backend.storage import bookmarks

DEFAULT_COLOR = "yellow"

router = APIRouter()


@router.get("/bookmarks")
def get_bookmarks():
    """Every saved note, newest first."""
    return sorted(bookmarks.all(), key=lambda b: b.get("created_at", ""), reverse=True)


@router.post("/bookmarks")
def create_bookmark(req: BookmarkCreate):
    """Save an answer. Identical question + answer returns the existing note."""
    question = req.question.strip()
    answer = req.answer.strip()
    if not answer:
        raise HTTPException(status_code=400, detail="Answer is required")

    record = bookmarks.add(
        {
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "question": question,
            "answer": answer,
            "citations": [c.model_dump() for c in req.citations],
            "scope": req.scope,
            "calibre_ids": [int(i) for i in req.calibre_ids],
            "note": req.note.strip(),
            "color": req.color or DEFAULT_COLOR,
            "pinned": req.pinned,
        },
        existing=lambda b: b.get("question") == question and b.get("answer") == answer,
    )

    # Saving is idempotent, but pinning (or a note) on a copy that already exists must stick.
    def merge(item: dict) -> None:
        if req.pinned:
            item["pinned"] = True
        if req.note.strip():
            item["note"] = req.note.strip()

    if (req.pinned and not record.get("pinned")) or (req.note.strip() and record.get("note") != req.note.strip()):
        record = bookmarks.update(record["id"], merge) or record
    return record


@router.patch("/bookmarks/{bookmark_id}")
def update_bookmark(bookmark_id: int, req: BookmarkUpdate):
    """Patch a bookmark's user-written note, colour or pinned flag."""

    def apply(item: dict) -> None:
        if req.note is not None:
            item["note"] = req.note.strip()
        if req.color is not None:
            item["color"] = req.color
        if req.pinned is not None:
            item["pinned"] = req.pinned

    updated = bookmarks.update(bookmark_id, apply)
    if updated is None:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return updated


@router.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int):
    if not bookmarks.delete(bookmark_id):
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return {"ok": True}
