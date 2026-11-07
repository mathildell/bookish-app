"""Book listing endpoints with filtering, search, and pagination."""

import base64
import io
from pathlib import Path
from datetime import datetime

from PIL import Image

from fastapi import APIRouter, HTTPException, Query
from backend import dependencies as deps
from backend.schemas import BookCard, BooksListResponse, BookDetail


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


def _ignored_patterns() -> set[str]:
    """Lowercased title substrings the user asked to hide in settings."""
    try:
        configured = deps.get_settings().ignored_books or []
    except Exception:
        return set()
    return {t.lower().strip() for t in configured if t and t.strip()}


def _is_ignored(title: str | None, patterns: set[str]) -> bool:
    if not patterns:
        return False
    return any(pat in (title or "").lower() for pat in patterns)


def _sort_safe(dt):
    """Normalize a datetime for sorting; fallback to 0."""
    if dt is None:
        return datetime.min
    try:
        return dt.replace(tzinfo=None)
    except Exception:
        return datetime.min


# --------------------------------------------------------------------------- #
# Endpoints                                                                   #
# --------------------------------------------------------------------------- #

@router.get("/books")
def list_books(
    query: str = Query("", description="Search title or author"),
    status: str | None = Query(None),
    indexed: bool | None = Query(None, description="filter by index status"),
    sort: str = Query("date_added_desc", description="sort field and direction"),
    selected_tags: str | None = Query(None, description="comma-separated tag list"),
    list_id: int | None = Query(None, description="filter to books in a saved list"),
    offset: int = Query(0),
    limit: int = Query(30),
):
    """Return book cards using a lightweight query that skips cover/EPUB loading.

    Cover images are loaded on-demand for the visible page only.
    Index status is checked lazily — failures in ChromaDB/Ollama just result
    in empty indexed set rather than blocking the response.
    
    Returns an extra `indexed_unknown` flag when ChromaDB is down so the UI
    can show "(?)" instead of "not indexed".
    """
    reader = deps.get_reader()
    if reader is None:
        return BooksListResponse(cards=[], total=0, offset=offset)

    # Lightweight card data: (calibre_id, title, authors, status, series_index, series_name, goodreads_rating)
    # ~7 SQL queries total regardless of library size — no covers, no EPUB paths.
    try:
        all_cards = reader.get_books_card_data()
    except Exception:
        import logging
        logging.getLogger(__name__).warning("Failed to load book card data", exc_info=True)
        return BooksListResponse(cards=[], total=0, offset=offset)

    # Apply ignored filter
    ign = _ignored_patterns()
    if ign:
        all_cards = [c for c in all_cards if not _is_ignored(c[1], ign)]

    # Lazy index lookup — never blocks on ChromaDB/Ollama being down
    try:
        indexed_ids = deps.get_indexed_ids() or set()
    except Exception:
        indexed_ids = set()

    chroma_ok = deps.check_chroma_health()

    # Build filter set
    tag_set = set(t.strip() for t in (selected_tags or "").split(",") if t.strip()) if selected_tags else set()

    filtered = list(all_cards)

    # Status filter — already present in lightweight card data at index 3
    if status:
        filtered = [c for c in filtered if c[3] == status]

    # Index filter
    if indexed is not None:
        if indexed:
            filtered = [c for c in filtered if c[0] in indexed_ids]
        else:
            filtered = [c for c in filtered if c[0] not in indexed_ids]

    # Saved-list filter — restrict to books in the list
    if list_id is not None:
        try:
            import json as _json
            from pathlib import Path as _Path
            _lists_file = _Path(__file__).resolve().parent.parent.parent / "data" / "lists.json"
            if _lists_file.exists():
                _all_lists = _json.loads(_lists_file.read_text())
                _target = next((l for l in _all_lists if l["id"] == list_id), None)
                if _target:
                    filtered = [c for c in filtered if c[0] in set(_target["book_ids"])]
                else:
                    filtered = []
        except Exception:
            filtered = []

    # Tag filter — for tag/genre filtering we need full data, so do selective assembly
    if tag_set:
        wanted = {t.lower() for t in tag_set}
        matched_ids = set()
        candidate_ids = [c[0] for c in filtered]

        if candidate_ids:
            ph = ",".join("?" * len(candidate_ids))

            # Tags
            for r in reader._exec(
                f"SELECT btl.book, t.name FROM books_tags_link btl "
                f"JOIN tags t ON btl.tag=t.id WHERE btl.book IN ({ph})",
                candidate_ids,
            ).fetchall():
                if r["name"].lower() in wanted:
                    matched_ids.add(r["book"])

            # Genres (cc12)
            for r in reader._exec(
                f"SELECT bcl.book, cv.value FROM books_custom_column_12_link bcl "
                f"JOIN custom_column_12 cv ON bcl.value=cv.id WHERE bcl.book IN ({ph})",
                candidate_ids,
            ).fetchall():
                if r["value"].lower() in wanted:
                    matched_ids.add(r["book"])

        filtered = [c for c in filtered if c[0] in matched_ids]

    # Text search — title, authors and series come from the lightweight data;
    # Calibre tags live in another table, so match them separately.
    if query:
        q_lower = query.lower()

        tag_matched: set[int] = set()
        candidate_ids = [c[0] for c in filtered]
        if candidate_ids:
            ph = ",".join("?" * len(candidate_ids))
            try:
                for r in reader._exec(
                    f"SELECT btl.book, t.name FROM books_tags_link btl "
                    f"JOIN tags t ON btl.tag=t.id WHERE btl.book IN ({ph})",
                    candidate_ids,
                ).fetchall():
                    if q_lower in (r["name"] or "").lower():
                        tag_matched.add(r["book"])
            except Exception:
                tag_matched = set()

        filtered = [
            c for c in filtered
            if q_lower in c[1].lower()
            or any(q_lower in a.lower() for a in (c[2] or []))
            or (c[5] and q_lower in c[5].lower())
            or c[0] in tag_matched
        ]

    # Sorting — date_added via timestamp column at index 7, fallback to ID
    reverse = sort.endswith("_desc")
    def _sort_key(c):
        if sort.startswith("date_added"):
            try:
                dt = c[7] if len(c) > 7 else None
            except (IndexError, TypeError):
                dt = None
            return (_sort_safe(dt), c[0])
        elif sort.startswith("date_read"):
            # date_read not in lightweight data — fallback to ID order
            return (c[0], c[1].casefold())
        return (c[0], c[1].casefold())

    filtered.sort(key=_sort_key, reverse=reverse)

    # Pagination
    page_cards = filtered[offset : offset + limit]

    # Batch-load covers only for IDs being displayed
    if page_cards:
        cover_ids = [c[0] for c in page_cards]
        try:
            cover_paths = reader.get_covers_batch(cover_ids)
        except Exception:
            cover_paths = {}

        cards_out = []
        for c in page_cards:
            bid, title, authors, st_status, s_index, s_name, gr_rating = (
                c[0], c[1], c[2] or [], c[3], c[4], c[5], c[6]
            )
            uri = _cover_to_uri(cover_paths.get(bid)) if cover_paths is not None else None
            cards_out.append(BookCard(
                id=bid,
                title=title,
                authors=authors,
                series_name=s_name,
                series_index=s_index,
                cover_uri=uri,
                status=st_status,
                goodreads_rating=gr_rating,
                indexed=bid in indexed_ids,
            ))
    else:
        cards_out = []

    indexed_total = sum(1 for c in filtered if c[0] in indexed_ids)
    return BooksListResponse(
        cards=cards_out, total=len(filtered), offset=offset,
        indexed_total=indexed_total,
        indexed_unknown=not chroma_ok,
    )


@router.get("/books/{calibre_id}")
def get_book(calibre_id: int):
    reader = deps.get_reader()
    rec = reader.get_book_by_id(calibre_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Book not found")

    indexed_ids = deps.get_indexed_ids()
    writer = deps.get_writer()
    rec.obsidian_review = writer.read_raw_review(rec)
    det = _book_to_detail(rec, indexed_ids)
    return det


@router.get("/books/filters/metadata")
def get_filter_metadata():
    """Return all unique statuses for dropdown filters."""
    reader = deps.get_reader()
    if reader is None:
        return {"statuses": []}
    try:
        rows = reader._exec("SELECT DISTINCT value FROM custom_column_13 WHERE value LIKE '%_%' OR value NOT LIKE 'wont-read%'").fetchall()
    except Exception:
        rows = []
    statuses = sorted(r["value"] for r in rows)
    return {"statuses": statuses}


@router.get("/arcs")
def list_arcs():
    """Return ARC books for the tracker page."""
    reader = deps.get_reader()
    writer = deps.get_writer()

    # Lightweight query: only loads books with a netgalley_deadline or tagged "ARC"
    # (~8 batched SQL queries total vs. ~15× per-book in get_all_books)
    arc_data = reader.get_arc_data()

    # Same ignored-books filter as the library grid
    ign = _ignored_patterns()

    now_dt = datetime.now()
    results = []
    for (calibre_id, title, authors, _has_arc_tag, cover_path, personal_notes, goodreads_id, netgalley_deadline) in arc_data:
        if _is_ignored(title, ign):
            continue

        try:
            dl = netgalley_deadline.replace(tzinfo=None) if netgalley_deadline and netgalley_deadline.tzinfo else netgalley_deadline
        except Exception:
            dl = None

        delta = (now_dt - dl).days if dl else None

        # Fast in-memory check — just a dict lookup by Goodreads ID
        has_review = goodreads_id and str(goodreads_id) in writer._id_index
        overdue = bool(delta and delta > 0) and not has_review

        results.append({
            "calibre_id": calibre_id,
            "title": title,
            "authors": authors or [],
            "cover_uri": _cover_to_uri(cover_path, max_size=120),
            "netgalley_deadline": _fmt_date(netgalley_deadline),
            "days_past_due": delta if overdue else 0,
            "overdue": overdue,
            "has_notes": bool(personal_notes),
            "has_review": has_review,
        })

    return results


# --------------------------------------------------------------------------- #
# Write endpoints                                                             #
# --------------------------------------------------------------------------- #

@router.post("/obsidian/{calibre_id}")
def write_obsidian(calibre_id: int, content: dict):
    """Write a review to the Obsidian vault."""
    reader = deps.get_reader()
    writer = deps.get_writer()
    rec = reader.get_book_by_id(calibre_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Book not found")

    success = writer.write_review(rec, content.get("review", ""))
    return {"ok": success}


@router.delete("/obsidian/{calibre_id}")
def delete_obsidian(calibre_id: int):
    reader = deps.get_reader()
    writer = deps.get_writer()
    rec = reader.get_book_by_id(calibre_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Book not found")

    success = writer.delete_review(rec)
    return {"ok": success}
