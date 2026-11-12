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

    return bookmarks.add(
        {
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "question": question,
            "answer": answer,
            "citations": [c.model_dump() for c in req.citations],
            "scope": req.scope,
            "calibre_ids": [int(i) for i in req.calibre_ids],
            "note": req.note.strip(),
            "color": req.color or DEFAULT_COLOR,
        },
        existing=lambda b: b.get("question") == question and b.get("answer") == answer,
    )


@router.patch("/bookmarks/{bookmark_id}")
def update_bookmark(bookmark_id: int, req: BookmarkUpdate):
    """Patch a note's user-written text or colour."""

    def apply(item: dict) -> None:
        if req.note is not None:
            item["note"] = req.note.strip()
        if req.color is not None:
            item["color"] = req.color

    updated = bookmarks.update(bookmark_id, apply)
    if updated is None:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return updated


@router.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int):
    if not bookmarks.delete(bookmark_id):
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return {"ok": True}
