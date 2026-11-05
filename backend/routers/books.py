"""Book listing endpoints with filtering, search, and pagination."""

import base64
import io
from pathlib import Path
from datetime import datetime
from PIL import Image

from fastapi import APIRouter, Query
from pydantic import BaseModel

from backend import dependencies as deps
from backend.schemas import BookCard, BooksListResponse, BookDetail, BookFilterParams


router = APIRouter()


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def _cover_to_uri(cover_path: str | None, max_size: int = 500) -> str | None:
    if not cover_path or not Path(cover_path).exists():
        return None
    try:
        img = Image.open(cover_path)
        w, h = img.size
        scale = min(1.0, max_size / max(w, h))
        nw, nh = (int(w * scale), int(h * scale))
        if (nw, nh) != (w, h):
            img = img.resize((nw, nh), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        b64 = base64.b64encode(buf.getvalue()).decode()
        return f"data:image/jpeg;base64,{b64}"
    except Exception:
        return None


def _fmt_date(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    try:
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    except Exception:
        return None


def _book_to_card(rec, indexed_ids: set[int]) -> BookCard:
    return BookCard(
        id=rec.calibre_id,
        title=rec.title,
        authors=rec.authors or [],
        series_name=rec.series_name,
        series_index=rec.series_index,
        cover_uri=_cover_to_uri(rec.cover_path),
        status=rec.status,
        goodreads_rating=rec.goodreads_rating,
        indexed=rec.calibre_id in (indexed_ids or set()),
    )


def _book_to_detail(rec, indexed_ids: set[int]) -> BookDetail:
    card = _book_to_card(rec, indexed_ids)
    return BookDetail(
        **card.model_dump(by_alias=True),
        publisher=rec.publisher,
        tags=rec.tags or [],
        genres=rec.genres or [],
        time_period=rec.time_period or [],
        tropes=rec.tropes or [],
        characters=rec.characters or [],
        sex_themes=rec.sex_themes or [],
        goodreads_id=rec.goodreads_id,
        word_count=rec.word_count,
        page_count=rec.page_count,
        date_added=_fmt_date(rec.date_added),
        date_read=_fmt_date(rec.date_read),
        netgalley_deadline=_fmt_date(rec.netgalley_deadline),
        blurb=rec.blurb,
        personal_notes=rec.personal_notes,
        obsidian_review=rec.obsidian_review,
    )


# --------------------------------------------------------------------------- #
# Endpoints                                                                   #
# --------------------------------------------------------------------------- #

@router.get("/books")
async def list_books(
    query: str = Query("", description="Search title or author"),
    status: str | None = Query(None),
    indexed: bool | None = Query(None, description="filter by index status"),
    sort: str = Query("date_added_desc", description="sort field and direction"),
    selected_tags: str | None = Query(None, description="comma-separated tag list"),
    offset: int = Query(0),
    limit: int = Query(30),
):
    reader = deps.get_reader()
    if reader is None:
        return BooksListResponse(cards=[], total=0, offset=offset)

    indexed_ids = deps.get_indexed_ids()
    all_books = list(reader.get_all_books())

    # Filter out ignored titles (case-insensitive partial match)
    ign = {t.lower().strip() for t in (deps.get_settings().ignored_books or []) if t.strip()}
    if ign:
        all_books = [b for b in all_books if not any(pat in b.title.lower() for pat in ign)]

    # Build filter set
    tag_set = set(t.strip() for t in (selected_tags or "").split(",") if t.strip()) if selected_tags else set()
    filtered = list(all_books)

    # Status filter
    if status:
        sid_list = reader.filter_by_status(status)
        if sid_list:
            sid_set = set(sid_list)
            filtered = [b for b in filtered if b.calibre_id in sid_set]

    # Index filter
    if indexed is not None:
        if indexed:
            filtered = [b for b in filtered if b.calibre_id in indexed_ids]
        else:
            filtered = [b for b in filtered if b.calibre_id not in indexed_ids]

    # Tag filter (checks both tags and genres fields, case-insensitively —
    # Calibre tags are often lowercase, e.g. "arc" for the sidebar's "ARC")
    if tag_set:
        wanted = {t.lower() for t in tag_set}
        tagged_ids = set()
        for b in filtered:
            book_values = {t.lower() for t in (b.tags or [])} | {g.lower() for g in (b.genres or [])}
            if wanted & book_values:
                tagged_ids.add(b.calibre_id)
        filtered = [b for b in filtered if b.calibre_id in tagged_ids]

    # Text search
    if query:
        q_lower = query.lower()
        filtered = [
            b for b in filtered
            if q_lower in b.title.lower()
            or any(q_lower in a.lower() for a in (b.authors or []))
            or (b.series_name and q_lower in b.series_name.lower())
        ]

    # Sorting
    def _sort_key(b):
        dt = None
        if sort.startswith("date_added"):
            dt = getattr(b, "date_added", None)
        elif sort.startswith("date_read"):
            dt = getattr(b, "date_read", None)
        if dt is None:
            return datetime.min
        # Strip tz for comparison
        try:
            return dt.replace(tzinfo=None)
        except Exception:
            return datetime.min

    reverse = sort.endswith("_desc")
    filtered.sort(key=_sort_key, reverse=reverse)

    cards = [_book_to_card(b, indexed_ids) for b in filtered[offset : offset + limit]]
    return BooksListResponse(cards=cards, total=len(filtered), offset=offset)


@router.get("/books/{calibre_id}")
async def get_book(calibre_id: int):
    reader = deps.get_reader()
    rec = reader.get_book_by_id(calibre_id)
    if not rec:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Book not found")

    indexed_ids = deps.get_indexed_ids()
    writer = deps.get_writer()
    rec.obsidian_review = writer.read_raw_review(rec)
    det = _book_to_detail(rec, indexed_ids)
    return det


@router.get("/books/filters/metadata")
async def get_filter_metadata():
    """Return all unique statuses for dropdown filters."""
    reader = deps.get_reader()
    all_books = list(reader.get_all_books())

    ign = {t.lower().strip() for t in (deps.get_settings().ignored_books or []) if t.strip()}
    if ign:
        all_books = [b for b in all_books if not any(pat in b.title.lower() for pat in ign)]

    statuses = sorted({b.status for b in all_books if b.status})
    return {"statuses": statuses}


@router.get("/arcs")
async def list_arcs():
    """Return ARC books for the tracker page."""
    reader = deps.get_reader()
    writer = deps.get_writer()
    indexed_ids = deps.get_indexed_ids()

    all_books = list(reader.get_all_books())

    ign = {t.lower().strip() for t in (deps.get_settings().ignored_books or []) if t.strip()}
    if ign:
        all_books = [b for b in all_books if not any(pat in b.title.lower() for pat in ign)]

    arcs = [b for b in all_books if b.netgalley_deadline or any("arc" == t.lower() for t in (getattr(b, "tags", []) or []))]

    now_dt = datetime.now()
    results = []
    for bk in arcs:
        rec = reader.get_book_by_id(bk.calibre_id)
        if not rec:
            continue
        _dt = rec.netgalley_deadline
        try:
            dl = _dt.replace(tzinfo=None) if _dt and _dt.tzinfo else _dt
        except Exception:
            dl = None

        delta = (now_dt - dl).days if dl else None
        has_review = writer.has_review(rec)
        # A saved review means the ARC is done, so it is no longer overdue
        overdue = bool(delta and delta > 0) and not has_review

        results.append({
            "calibre_id": rec.calibre_id,
            "title": rec.title,
            "authors": rec.authors or [],
            "cover_uri": _cover_to_uri(rec.cover_path, max_size=120),
            "netgalley_deadline": _fmt_date(rec.netgalley_deadline),
            "days_past_due": delta if overdue else 0,
            "overdue": overdue,
            "has_notes": bool(rec.personal_notes),
            "has_review": has_review,
        })

    return results


# --------------------------------------------------------------------------- #
# Write endpoints                                                             #
# --------------------------------------------------------------------------- #

@router.post("/obsidian/{calibre_id}")
async def write_obsidian(calibre_id: int, content: dict):
    """Write a review to the Obsidian vault."""
    reader = deps.get_reader()
    writer = deps.get_writer()
    rec = reader.get_book_by_id(calibre_id)
    if not rec:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Book not found")

    success = writer.write_review(rec, content.get("review", ""))
    return {"ok": success}


@router.delete("/obsidian/{calibre_id}")
async def delete_obsidian(calibre_id: int):
    reader = deps.get_reader()
    writer = deps.get_writer()
    rec = reader.get_book_by_id(calibre_id)
    if not rec:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Book not found")

    success = writer.delete_review(rec)
    return {"ok": success}
