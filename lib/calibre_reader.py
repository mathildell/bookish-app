"""Read-only access to Calibre's metadata.db."""

from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime
from typing import Iterable, NamedTuple, Optional

from .models import BookRecord

logger = logging.getLogger(__name__)


class CardRow(NamedTuple):
    """Just enough of a book to draw its grid card, filter and sort it."""
    calibre_id: int
    title: str
    authors: list[str]
    status: Optional[str]
    series_index: Optional[float]
    series_name: Optional[str]
    goodreads_rating: Optional[int]
    date_added: Optional[datetime]


class ArcRow(NamedTuple):
    """An advance-reader copy: a book with a NetGalley deadline or an "ARC" tag."""
    calibre_id: int
    title: str
    authors: list[str]
    has_arc_tag: bool
    cover_path: Optional[str]
    personal_notes: Optional[str]
    goodreads_id: Optional[str]
    netgalley_deadline: Optional[datetime]


def _placeholders(values: Iterable) -> str:
    return ",".join("?" * len(list(values)))


class CalibreReader:
    """
    Read-only connector for Calibre's metadata.db.

    Custom columns (verified against the live schema):
      #8  goodreads_rating  -> my Goodreads rating (2/4/6/8/10)
      #9  goodreads_date_read -> read date
      #11 pcount            -> page count
      #12 genre             -> genres (multi-valued, "Fantasy.Dark")
      #13 status            -> to-read, read, dnf, wont-read
      #17 time_period       -> time period labels
      #18 tropes_aesthetics -> tropes/aesthetics (multi-valued)
      #19 sex_themes        -> themes/warnings (multi-valued)
      #20 chars             -> characters
      #21 wcount            -> word count
      #23 review            -> personal notes/review text
      #24 netgalley_date    -> NetGalley deadline
    """

    GENRE_COLUMN = 12
    STATUS_COLUMN = 13

    # Multi-valued custom columns copied onto BookRecord attributes.
    _MULTI_COLUMNS = {
        "genres": 12,
        "time_period": 17,
        "tropes": 18,
        "sex_themes": 19,
        "characters": 20,
    }

    def __init__(self, db_path: str):
        self.db_path = os.path.expanduser(db_path)
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(f"Calibre DB not found at {self.db_path}")
        self._conn = self._connect()
        self.library_root = self._get_library_root()

    # ------------------------------------------------------------------ #
    # Connection                                                         #
    # ------------------------------------------------------------------ #

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _get_library_root(self) -> str:
        row = self._exec("SELECT val FROM preferences WHERE key = 'library_path'").fetchone()
        if row and row["val"]:
            return os.path.expanduser(row["val"])
        return os.path.dirname(self.db_path)

    def _exec(self, sql: str, params=()):
        try:
            return self._conn.execute(sql, params)
        except (sqlite3.OperationalError, sqlite3.ProgrammingError) as exc:
            # metadata.db lives on an SMB share. When the mount reconnects, the old
            # handle dies ("disk I/O error") and every read fails until the process
            # restarts — which the homepage renders as an empty library. Reopen once
            # and retry; a genuinely unreadable DB raises again from here.
            if isinstance(exc, sqlite3.OperationalError) and "disk i/o error" not in str(exc).lower():
                raise
            logger.warning("Calibre handle lost (%s) — reconnecting to %s", exc, self.db_path)
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = self._connect()
            return self._conn.execute(sql, params)

    def _rows(self, sql: str, params=(), *, optional: bool = False) -> list[sqlite3.Row]:
        """All rows; with *optional*, a missing custom-column table yields []."""
        try:
            return self._exec(sql, params).fetchall()
        except sqlite3.OperationalError:
            if optional:
                return []
            raise

    def close(self):
        self._conn.close()

    def _cover_path(self, row: sqlite3.Row) -> Optional[str]:
        """cover.jpg inside the book's folder, for a `books` row with has_cover/path."""
        if not row["has_cover"]:
            return None
        return os.path.join(self.library_root, str(row["path"]), "cover.jpg")

    # ------------------------------------------------------------------ #
    # Batched lookups (a few queries for the whole library)              #
    # ------------------------------------------------------------------ #

    def _authors_by_book(self, ids: list[int]) -> dict[int, list[str]]:
        authors: dict[int, list[str]] = {}
        for r in self._rows(
            f"SELECT bal.book, a.name FROM books_authors_link bal "
            f"JOIN authors a ON bal.author=a.id WHERE bal.book IN ({_placeholders(ids)})",
            ids,
        ):
            authors.setdefault(r["book"], []).append(r["name"])
        return authors

    def _custom_link_values(self, column: int, ids: list[int], extra: str = "") -> list[sqlite3.Row]:
        """(book, value) rows of a link-table custom column for *ids*."""
        return self._rows(
            f"SELECT bcl.book, cv.value FROM books_custom_column_{column}_link bcl "
            f"JOIN custom_column_{column} cv ON bcl.value=cv.id "
            f"WHERE bcl.book IN ({_placeholders(ids)}){extra}",
            ids,
            optional=True,
        )

    def _custom_values(self, column: int, ids: list[int], extra: str = "") -> list[sqlite3.Row]:
        """(book, value) rows of a direct (one value per book) custom column."""
        return self._rows(
            f"SELECT book, value FROM custom_column_{column} "
            f"WHERE book IN ({_placeholders(ids)}){extra}",
            ids,
            optional=True,
        )

    def tags_for_books(self, ids: list[int]) -> list[tuple[int, str]]:
        """(book, tag name) for every Calibre tag on *ids*."""
        if not ids:
            return []
        return [
            (r["book"], r["name"] or "")
            for r in self._rows(
                f"SELECT btl.book, t.name FROM books_tags_link btl "
                f"JOIN tags t ON btl.tag=t.id WHERE btl.book IN ({_placeholders(ids)})",
                ids,
            )
        ]

    def genres_for_books(self, ids: list[int]) -> list[tuple[int, str]]:
        """(book, genre) for every genre on *ids*."""
        if not ids:
            return []
        return [(r["book"], r["value"] or "") for r in self._custom_link_values(self.GENRE_COLUMN, ids)]

    def get_all_genres(self) -> list[str]:
        """Every genre value attached to at least one book."""
        return [
            str(r["value"])
            for r in self._rows(
                f"SELECT DISTINCT cv.value FROM custom_column_{self.GENRE_COLUMN} cv "
                f"JOIN books_custom_column_{self.GENRE_COLUMN}_link bcl ON cv.id = bcl.value"
            )
        ]

    def get_statuses(self) -> list[str]:
        """Every reading status defined in the library, sorted."""
        rows = self._rows(
            f"SELECT DISTINCT value FROM custom_column_{self.STATUS_COLUMN} "
            "WHERE value LIKE '%_%' OR value NOT LIKE 'wont-read%'"
        )
        return sorted(r["value"] for r in rows)

    def get_covers_batch(self, calibre_ids: list[int]) -> dict[int, Optional[str]]:
        """{calibre_id: cover path or None} — call only for books being drawn."""
        if not calibre_ids:
            return {}
        rows = self._rows(
            f"SELECT id, has_cover, path FROM books WHERE id IN ({_placeholders(calibre_ids)})",
            calibre_ids,
        )
        return {r["id"]: self._cover_path(r) for r in rows}

    def get_books_card_data(self) -> list[CardRow]:
        """Card data for the whole library in ~5 queries instead of ~15 per book."""
        rows = self._rows("SELECT id, title, series_index, timestamp FROM books ORDER BY id")
        if not rows:
            return []
        ids = [r["id"] for r in rows]

        authors = self._authors_by_book(ids)
        status = {r["book"]: r["value"] for r in self._custom_link_values(self.STATUS_COLUMN, ids)}
        series = {
            r["book"]: r["name"]
            for r in self._rows(
                f"SELECT bsl.book, s.name FROM books_series_link bsl "
                f"JOIN series s ON bsl.series=s.id WHERE bsl.book IN ({_placeholders(ids)})",
                ids,
                optional=True,
            )
            if r["name"]
        }
        # Goodreads rating (cc8); zero means "not rated".
        rating = {
            r["book"]: int(r["value"])
            for r in self._custom_link_values(8, ids, " AND CAST(cv.value AS INTEGER) > 0")
        }

        return [
            CardRow(
                calibre_id=r["id"],
                title=r["title"],
                authors=authors.get(r["id"], []),
                status=status.get(r["id"]),
                series_index=r["series_index"],
                series_name=series.get(r["id"]),
                goodreads_rating=rating.get(r["id"]),
                date_added=self._ts(r["timestamp"]),
            )
            for r in rows
        ]

    def get_arc_data(self) -> list[ArcRow]:
        """Every ARC book (NetGalley deadline or "ARC" tag) in ~7 queries."""
        rows = self._rows("SELECT id, title, has_cover, path FROM books ORDER BY id")
        if not rows:
            return []
        all_ids = [r["id"] for r in rows]

        deadlines = {
            r["book"]: self._ts(r["value"]) for r in self._custom_values(24, all_ids) if r["value"]
        }
        arc_tagged = {
            r["book"]
            for r in self._rows(
                "SELECT btl.book FROM books_tags_link btl JOIN tags t ON btl.tag=t.id "
                "WHERE LOWER(t.name)='arc'",
                optional=True,
            )
        }

        arc_rows = [r for r in rows if deadlines.get(r["id"]) or r["id"] in arc_tagged]
        if not arc_rows:
            return []
        arc_ids = [r["id"] for r in arc_rows]

        authors = self._authors_by_book(arc_ids)
        notes = {r["book"]: r["value"] for r in self._custom_values(23, arc_ids, " AND value IS NOT NULL")}
        goodreads = {
            r["book"]: r["val"]
            for r in self._rows(
                f"SELECT book, val FROM identifiers WHERE book IN ({_placeholders(arc_ids)}) "
                "AND type='goodreads'",
                arc_ids,
            )
        }

        return [
            ArcRow(
                calibre_id=r["id"],
                title=r["title"],
                authors=authors.get(r["id"], []),
                has_arc_tag=r["id"] in arc_tagged,
                cover_path=self._cover_path(r),
                personal_notes=notes.get(r["id"]),
                goodreads_id=goodreads.get(r["id"]),
                netgalley_deadline=deadlines.get(r["id"]),
            )
            for r in arc_rows
        ]

    # ------------------------------------------------------------------ #
    # Full record for one book                                           #
    # ------------------------------------------------------------------ #

    def get_book_by_id(self, calibre_id: int) -> Optional[BookRecord]:
        row = self._exec(
            "SELECT id, title, series_index, timestamp, has_cover, path FROM books WHERE id = ?",
            (calibre_id,),
        ).fetchone()
        if not row:
            return None

        bid = row["id"]
        rec = BookRecord(
            calibre_id=bid,
            title=row["title"],
            series_index=row["series_index"],
            date_added=self._ts(row["timestamp"]),
            cover_path=self._cover_path(row),
        )

        def first(sql: str, column: str = "value"):
            """The first value of a one-book query, or None (missing tables included)."""
            found = self._rows(sql, (bid,), optional=True)
            return found[0][column] if found else None

        rec.authors = [
            r["name"]
            for r in self._rows(
                "SELECT a.name FROM authors a JOIN books_authors_link bal ON a.id=bal.author "
                "WHERE bal.book=?",
                (bid,),
            )
        ]
        rec.series_name = first(
            "SELECT s.name FROM series s JOIN books_series_link bsl ON s.id=bsl.series WHERE bsl.book=?",
            "name",
        ) or None
        rec.publisher = first(
            "SELECT p.name FROM publishers p JOIN books_publishers_link bpl ON p.id=bpl.publisher "
            "WHERE bpl.book=?",
            "name",
        )
        rec.tags = [
            r["name"]
            for r in self._rows(
                "SELECT name FROM tags INNER JOIN books_tags_link ON tags.id=tag WHERE book=?", (bid,)
            )
        ]
        for attr, column in self._MULTI_COLUMNS.items():
            setattr(rec, attr, [r["value"] for r in self._custom_link_values(column, [bid])])

        rec.status = first(
            f"SELECT cv.value FROM custom_column_{self.STATUS_COLUMN} cv "
            f"INNER JOIN books_custom_column_{self.STATUS_COLUMN}_link bcl ON cv.id=bcl.value "
            "WHERE bcl.book=?"
        )
        rec.user_rating = first(
            "SELECT r.rating FROM ratings r JOIN books_ratings_link brl ON r.id=brl.rating "
            "WHERE brl.book=?",
            "rating",
        )
        rec.goodreads_rating = first(
            "SELECT cv.value FROM custom_column_8 cv "
            "INNER JOIN books_custom_column_8_link bcl ON cv.id=bcl.value "
            "WHERE bcl.book=? AND cv.value > 0"
        )
        rec.date_read = self._ts(first("SELECT value FROM custom_column_9 WHERE book=?"))
        rec.netgalley_deadline = self._ts(first("SELECT value FROM custom_column_24 WHERE book=?"))
        rec.word_count = self._int(first("SELECT value FROM custom_column_21 WHERE book=?"))
        rec.page_count = self._int(first("SELECT value FROM custom_column_11 WHERE book=?"))
        rec.blurb = first("SELECT text FROM comments WHERE book=?", "text") or None
        rec.personal_notes = first("SELECT value FROM custom_column_23 WHERE book=?") or None
        rec.goodreads_id = first(
            "SELECT val FROM identifiers WHERE book=? AND type='goodreads'", "val"
        ) or None

        epub_name = first(
            "SELECT name FROM data WHERE book=? AND format IN ('EPUB','ORIGINAL_EPUB')", "name"
        )
        if epub_name:
            rec.epub_path = os.path.join(self.library_root, str(row["path"]), f"{epub_name}.epub")
        return rec

    # ------------------------------------------------------------------ #
    # Value parsing                                                      #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _int(value) -> Optional[int]:
        try:
            return int(value) if value is not None else None
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _ts(value) -> Optional[datetime]:
        if not value:
            return None
        if isinstance(value, datetime):
            return value
        try:
            s = str(value).replace(" ", "T")
            return datetime.fromisoformat(s.replace("+00:00", "+0000") if "+" in s else s)
        except ValueError:
            return None
