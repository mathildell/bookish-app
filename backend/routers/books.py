"""Library endpoints: the book grid, book details, the ARC tracker and reviews."""

from __future__ import annotations

import base64
import io
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from PIL import Image
from pydantic import BaseModel

from backend import dependencies as deps
from backend.schemas import BookCard, BookDetail, BooksListResponse
from backend.storage import book_lists
from lib.calibre_reader import CardRow

logger = logging.getLogger(__name__)

router = APIRouter()


class ReviewBody(BaseModel):
    review: str = ""


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def _cover_to_uri(cover_path: Optional[str], max_size: int = 500) -> Optional[str]:
    """Inline a cover as a downscaled JPEG data URI (the browser can't read Calibre's disk)."""
    if not cover_path or not Path(cover_path).exists():
        return None
    try:
        img = Image.open(cover_path)
        scale = min(1.0, max_size / max(img.size))
        if scale < 1.0:
            img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=80)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


def _fmt_date(dt: Optional[datetime]) -> Optional[str]:
    return dt.strftime("%Y-%m-%dT%H:%M:%S") if dt else None


def _naive(dt: Optional[datetime]) -> datetime:
    """Comparable datetime for sorting; missing dates sort first."""
    return dt.replace(tzinfo=None) if dt else datetime.min


def _ignored_patterns() -> set[str]:
    """Lowercased title substrings the user asked to hide in Settings."""
    settings = deps.get_settings()
    configured = (settings.ignored_books if settings else None) or []
    return {t.lower().strip() for t in configured if t and t.strip()}


def _is_ignored(title: Optional[str], patterns: set[str]) -> bool:
    return any(pat in (title or "").lower() for pat in patterns)


def _require_book(calibre_id: int):
    record = deps.require_reader().get_book_by_id(calibre_id)
    if not record:
        raise HTTPException(status_code=404, detail="Book not found")
    return record


def _matches_query(card: CardRow, needle: str, tag_hits: set[int]) -> bool:
    """Title, author, series or Calibre-tag substring match."""
    return (
        needle in card.title.lower()
        or any(needle in a.lower() for a in card.authors)
        or (card.series_name is not None and needle in card.series_name.lower())
        or card.calibre_id in tag_hits
    )


# --------------------------------------------------------------------------- #
# Library grid                                                                #
# --------------------------------------------------------------------------- #

@router.get("/books", response_model=BooksListResponse)
def list_books(
    query: str = Query("", description="Search title, author, series or tag"),
    status: Optional[str] = Query(None),
    indexed: Optional[bool] = Query(None, description="Filter by index status"),
    sort: str = Query("date_added_desc", description="Sort field and direction"),
    selected_tags: Optional[str] = Query(None, description="Comma-separated tags or genres"),
    list_id: Optional[int] = Query(None, description="Only books in this saved list"),
    offset: int = Query(0),
    limit: int = Query(30),
):
    """One page of book cards.

    Filtering runs on lightweight card data for the whole library (a handful of
    SQL queries); covers are only loaded for the page being returned.
    `indexed_unknown` is set when ChromaDB is down, so the UI can show "(?)"
    instead of claiming books are not indexed.
    """
    empty = BooksListResponse(cards=[], total=0, offset=offset)
    reader = deps.get_reader()
    if reader is None:
        return empty
    try:
        cards = reader.get_books_card_data()
    except Exception:
        logger.warning("Failed to load book card data", exc_info=True)
        return empty

    indexed_ids = deps.get_indexed_ids() or set()
    chroma_ok = deps.check_chroma_health()

    ignored = _ignored_patterns()
    if ignored:
        cards = [c for c in cards if not _is_ignored(c.title, ignored)]
    if status:
        cards = [c for c in cards if c.status == status]
    if indexed is not None:
        cards = [c for c in cards if (c.calibre_id in indexed_ids) == indexed]
    if list_id is not None:
        saved = book_lists.get(list_id)
        members = set(saved.get("book_ids", [])) if saved else set()
        cards = [c for c in cards if c.calibre_id in members]

    wanted_tags = {t.strip().lower() for t in (selected_tags or "").split(",") if t.strip()}
    if wanted_tags:
        ids = [c.calibre_id for c in cards]
        labelled = reader.tags_for_books(ids) + reader.genres_for_books(ids)
        hits = {book for book, label in labelled if label.lower() in wanted_tags}
        cards = [c for c in cards if c.calibre_id in hits]

    if query:
        needle = query.lower()
        try:
            tag_hits = {
                book
                for book, tag in reader.tags_for_books([c.calibre_id for c in cards])
                if needle in tag.lower()
            }
        except Exception:
            tag_hits = set()
        cards = [c for c in cards if _matches_query(c, needle, tag_hits)]

    # date_read isn't in the card data, so every sort but date_added uses id order.
    if sort.startswith("date_added"):
        cards.sort(key=lambda c: (_naive(c.date_added), c.calibre_id), reverse=sort.endswith("_desc"))
    else:
        cards.sort(key=lambda c: (c.calibre_id, c.title.casefold()), reverse=sort.endswith("_desc"))

    page = cards[offset : offset + limit]
    try:
        covers = reader.get_covers_batch([c.calibre_id for c in page])
    except Exception:
        covers = {}

    return BooksListResponse(
        cards=[
            BookCard(
                id=c.calibre_id,
                title=c.title,
                authors=c.authors,
                series_name=c.series_name,
                series_index=c.series_index,
                cover_uri=_cover_to_uri(covers.get(c.calibre_id)),
                status=c.status,
                goodreads_rating=c.goodreads_rating,
                indexed=c.calibre_id in indexed_ids,
            )
            for c in page
        ],
        total=len(cards),
        offset=offset,
        indexed_total=sum(1 for c in cards if c.calibre_id in indexed_ids),
        indexed_unknown=not chroma_ok,
    )


@router.get("/books/filters/metadata")
def get_filter_metadata():
    """Every reading status, for the filter dropdown."""
    reader = deps.get_reader()
    if reader is None:
        return {"statuses": []}
    try:
        return {"statuses": reader.get_statuses()}
    except Exception:
        return {"statuses": []}


@router.get("/books/{calibre_id}", response_model=BookDetail)
def get_book(calibre_id: int):
    """Full metadata for one book, plus its Obsidian review if there is one."""
    rec = _require_book(calibre_id)
    return BookDetail(
        id=rec.calibre_id,
        title=rec.title,
        authors=rec.authors,
        series_name=rec.series_name,
        series_index=rec.series_index,
        cover_uri=_cover_to_uri(rec.cover_path),
        status=rec.status,
        goodreads_rating=rec.goodreads_rating,
        indexed=rec.calibre_id in deps.get_indexed_ids(),
        publisher=rec.publisher,
        tags=rec.tags,
        genres=rec.genres,
        time_period=rec.time_period,
        tropes=rec.tropes,
        characters=rec.characters,
        sex_themes=rec.sex_themes,
        goodreads_id=rec.goodreads_id,
        word_count=rec.word_count,
        page_count=rec.page_count,
        date_added=_fmt_date(rec.date_added),
        date_read=_fmt_date(rec.date_read),
        netgalley_deadline=_fmt_date(rec.netgalley_deadline),
        blurb=rec.blurb,
        personal_notes=rec.personal_notes,
        obsidian_review=deps.get_writer().read_raw_review(rec),
    )


# --------------------------------------------------------------------------- #
# ARC tracker                                                                 #
# --------------------------------------------------------------------------- #

@router.get("/arcs")
def list_arcs():
    """ARC books with their NetGalley deadline and review status."""
    reader = deps.require_reader()
    writer = deps.get_writer()
    ignored = _ignored_patterns()
    now = datetime.now()

    results = []
    for arc in reader.get_arc_data():
        if _is_ignored(arc.title, ignored):
            continue
        deadline = arc.netgalley_deadline
        days_late = (now - _naive(deadline)).days if deadline else None
        has_review = writer.has_review_for(arc.goodreads_id)
        overdue = bool(days_late and days_late > 0) and not has_review

        results.append({
            "calibre_id": arc.calibre_id,
            "title": arc.title,
            "authors": arc.authors,
            "cover_uri": _cover_to_uri(arc.cover_path, max_size=120),
            "netgalley_deadline": _fmt_date(deadline),
            "days_past_due": days_late if overdue else 0,
            "overdue": overdue,
            "has_notes": bool(arc.personal_notes),
            "has_review": has_review,
        })
    return results


# --------------------------------------------------------------------------- #
# Obsidian reviews                                                            #
# --------------------------------------------------------------------------- #

@router.post("/obsidian/{calibre_id}")
def write_obsidian(calibre_id: int, body: ReviewBody):
    """Write a review to the Obsidian vault."""
    return {"ok": deps.get_writer().write_review(_require_book(calibre_id), body.review)}


@router.delete("/obsidian/{calibre_id}")
def delete_obsidian(calibre_id: int):
    return {"ok": deps.get_writer().delete_review(_require_book(calibre_id))}
