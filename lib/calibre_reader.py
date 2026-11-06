import sqlite3
import logging
import os
from typing import Optional
from datetime import datetime

from .models import BookRecord

logger = logging.getLogger(__name__)


class CalibreReader:
    """
    Read-only connector for Calibre's metadata.db.

    Custom columns (verified against live schema):
      #6  grrating          -> composite Goodreads rating
      #7  grvotes           -> composite total votes
      #8  goodreads_rating  -> My Goodreads rating (2/4/6/8/10)
      #9  goodreads_date_read -> read date
      #10 goodreads         -> composite GR ID text
      #11 pcount            -> page count
      #12 genre             -> genres (multi-valued)
      #13 status            -> status: to-read, read, dnf, wont-read
      #17 time_period       -> time period labels
      #18 tropes_aesthetics -> tropes/aesthetics (multi-valued)
      #19 sex_themes        -> themes/warnings (multi-valued)
      #20 chars             -> characters
      #21 wcount            -> word count
      #23 review            -> personal notes/review text
      #24 netgalley_date    -> NetGalley deadline
    """

    def __init__(self, db_path: str):
        self.db_path = os.path.expanduser(db_path)
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(f"Calibre DB not found at {self.db_path}")
        self._conn = sqlite3.connect(
            f"file:{self.db_path}?mode=ro",
            uri=True,
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        self.library_root = self._get_library_root()

    def _get_library_root(self) -> str:
        row = self._conn.execute(
            "SELECT val FROM preferences WHERE key = 'library_path'"
        ).fetchone()
        if row and row["val"]:
            return os.path.expanduser(row["val"]) if row["val"].startswith("~") else row["val"]
        return os.path.dirname(self.db_path)

    def _exec(self, sql: str, params=()):
        return self._conn.execute(sql, params)

    def close(self):
        self._conn.close()

    # ------------------------------------------------------------------ #
    # Public API                                                         #
    # ------------------------------------------------------------------ #

    def get_book_by_id(self, calibre_id: int) -> Optional[BookRecord]:
        if not self._exec("SELECT 1 FROM books WHERE id = ?", (calibre_id,)).fetchone():
            return None
        return self._assemble(calibre_id)

    def get_all_books(self) -> list[BookRecord]:
        ids = [r["id"] for r in self._exec(
            "SELECT id FROM books ORDER BY id"
        ).fetchall()]
        result = []
        for bid in ids:
            try:
                rec = self._assemble(bid)
                if rec is not None:
                    result.append(rec)
            except sqlite3.InterfaceError:
                # Skip problematic records (e.g. missing custom column tables)
                pass
            except Exception:
                # Defensive: any other read failure just skips the book
                pass
        return result

    def get_books_card_data(self) -> list[tuple[int, str, list[str], str | None, float | None, str | None, int | None, datetime | None]]:
        """Return lightweight tuples for book-card rendering.

        Returns (calibre_id, title, authors, status, series_index, series_name, goodreads_rating, date_added).
        Uses ~7 SQL queries total instead of ~15× per book.
        """
        # 1. ids + titles + series_index + timestamp
        rows = self._exec(
            "SELECT id, title, series_index, timestamp FROM books ORDER BY id"
        ).fetchall()
        if not rows:
            return []

        ids = [r["id"] for r in rows]
        title_map = {r["id"]: (r["title"], r["series_index"], self._ts(r["timestamp"])) for r in rows}

        # 2. authors (batched)
        author_map: dict[int, list[str]] = {}
        ph = ",".join("?" * len(ids))
        for r in self._exec(
            f"SELECT bal.book, a.name FROM books_authors_link bal "
            f"JOIN authors a ON bal.author=a.id WHERE bal.book IN ({ph})",
            ids,
        ).fetchall():
            author_map.setdefault(r["book"], []).append(r["name"])

        # 3. status (cc13 — batched)
        status_map: dict[int, str] = {}
        try:
            for r in self._exec(
                f"SELECT bcl.book, cv.value FROM books_custom_column_13_link bcl "
                f"JOIN custom_column_13 cv ON bcl.value=cv.id WHERE bcl.book IN ({ph})",
                ids,
            ).fetchall():
                status_map[r["book"]] = r["value"]
        except sqlite3.OperationalError:
            pass

        # 4. series name (batched)
        series_map: dict[int, str] = {}
        try:
            for r in self._exec(
                f"SELECT bsl.book, s.name FROM books_series_link bsl "
                f"JOIN series s ON bsl.series=s.id WHERE bsl.book IN ({ph})",
                ids,
            ).fetchall():
                if r["name"]:
                    series_map[r["book"]] = r["name"]
        except sqlite3.OperationalError:
            pass

        # 5. Goodreads rating (cc8 — batched, skip zeroes)
        rating_map: dict[int, int] = {}
        try:
            for r in self._exec(
                f"SELECT bcl.book, cv.value FROM books_custom_column_8_link bcl "
                f"JOIN custom_column_8 cv ON bcl.value=cv.id WHERE bcl.book IN ({ph}) AND CAST(cv.value AS INTEGER) > 0",
                ids,
            ).fetchall():
                rating_map[r["book"]] = int(r["value"])
        except sqlite3.OperationalError:
            pass

        # Assemble cards
        result: list[tuple[int, str, list[str], str | None, float | None, str | None, int | None, datetime | None]] = []
        for bid in ids:
            title, s_index, dt_added = title_map[bid]
            result.append((
                bid,
                title,
                author_map.get(bid, []),
                status_map.get(bid),
                s_index,
                series_map.get(bid),
                rating_map.get(bid),
                dt_added,
            ))
        return result

    def get_covers_batch(self, calibre_ids: list[int]) -> dict[int, str | None]:
        """Return cover paths for a batch of book IDs.

        Returns {calibre_id: cover_path_or_none}.
        Call this only when you actually need to render covers (e.g. first visible page).
        """
        ph = ",".join("?" * len(calibre_ids))
        rows = self._exec(
            f"SELECT id, has_cover, path FROM books WHERE id IN ({ph})",
            calibre_ids,
        ).fetchall()

        covers: dict[int, str | None] = {}
        for r in rows:
            bid = r["id"]
            if r["has_cover"]:
                covers[bid] = os.path.join(self.library_root, str(r["path"]), "cover.jpg")
            else:
                covers[bid] = None
        return covers

    def get_book_ids_with_epub(self) -> list[int]:
        rows = self._exec(
            """SELECT DISTINCT d.book FROM data d
               WHERE d.format IN ('EPUB','ORIGINAL_EPUB')"""
        ).fetchall()
        return [r["book"] for r in rows]

    # ------------------------------------------------------------------ #
    # Filtering helpers                                                    #
    # ------------------------------------------------------------------ #

    def filter_by_status(self, status: str) -> list[int]:
        srow = self._exec(
            "SELECT id FROM custom_column_13 WHERE value = ?", (status,)
        ).fetchone()
        if not srow:
            return []
        rows = self._exec(
            "SELECT book FROM books_custom_column_13_link WHERE value = ?",
            (srow["id"],),
        )
        return [r["book"] for r in rows.fetchall()]

    def filter_by_min_rating(self, min_stars: int) -> list[int]:
        threshold = min_stars * 2
        rows = self._exec(
            """SELECT bl.book FROM books_ratings_link bl
               JOIN ratings r ON bl.rating = r.id
               WHERE r.rating >= ?""",
            (threshold,),
        )
        return [r["book"] for r in rows.fetchall()]

    def filter_by_genre(self, genre: str) -> list[int]:
        gids = self._exec(
            "SELECT id FROM custom_column_12 WHERE value LIKE ?",
            (f"%{genre}%",),
        ).fetchall()
        if not gids:
            return []
        placeholders = ",".join("?" * len(gids))
        gid_vals = [g["id"] for g in gids]
        rows = self._exec(
            f"SELECT book FROM books_custom_column_12_link WHERE value IN ({placeholders})",
            gid_vals,
        )
        return [r["book"] for r in rows.fetchall()]

    # ------------------------------------------------------------------ #
    # Internal record assembly                                           #
    # ------------------------------------------------------------------ #

    def _assemble(self, bid: int) -> Optional[BookRecord]:
        row = self._exec("SELECT id, title, series_index FROM books WHERE id = ?", (bid,)).fetchone()
        if not row:
            return None

        rec = BookRecord(
            calibre_id=bid,
            title=row["title"],
        )

        ts_row = self._exec("SELECT timestamp FROM books WHERE id=?", (bid,)).fetchone()
        if ts_row:
            rec.date_added = self._ts(ts_row["timestamp"])

        # Authors (multi-link table)
        for r in self._exec(
            "SELECT a.name FROM authors a JOIN books_authors_link bal ON a.id=bal.author WHERE bal.book=?", (bid,)
        ).fetchall():
            rec.authors.append(r["name"])

        # Series
        sr = self._exec(
            "SELECT s.name FROM series s JOIN books_series_link bsl ON s.id=bsl.series WHERE bsl.book=? ", (bid,)
        ).fetchone()
        if sr and sr["name"]:
            rec.series_name = sr["name"]

        # Standard numeric from books table
        rec.series_index = row["series_index"]

        # Publisher
        pr = self._exec(
            "SELECT p.name FROM publishers p JOIN books_publishers_link bpl ON p.id=bpl.publisher WHERE bpl.book=?", (bid,)
        ).fetchone()
        if pr:
            rec.publisher = pr["name"]

        # Tags
        for t in self._exec(
            "SELECT name FROM tags INNER JOIN books_tags_link ON tags.id=tag WHERE book=?", (bid,)
        ).fetchall():
            rec.tags.append(t["name"])

        # Multi-valued custom columns (genre, time_period, tropes, sex_themes, characters)
        self._fill_multi(rec, "genres",       12, bid)
        self._fill_multi(rec, "time_period",   17, bid)
        self._fill_multi(rec, "tropes",        18, bid)
        self._fill_multi(rec, "sex_themes",    19, bid)
        self._fill_multi(rec, "characters",    20, bid)

        # Status (enumeration link table)
        st = self._exec(
            """SELECT cv.value FROM custom_column_13 cv
               INNER JOIN books_custom_column_13_link bcl ON cv.id=bcl.value
               WHERE bcl.book=?""", (bid,)
        ).fetchone()
        if st:
            rec.status = st["value"]

        # Goodreads rating -> Calibre native stars via ratings table
        rr = self._exec(
            "SELECT r.rating FROM ratings r JOIN books_ratings_link brl ON r.id=brl.rating WHERE brl.book=?", (bid,)
        ).fetchone()
        if rr:
            rec.user_rating = rr["rating"]

        # Goodreads My Rating (cc8) — composite GR rating, scale 2/4/6/8/10 (half-stars possible)
        gr = self._exec("""
            SELECT cv.value FROM custom_column_8 cv
            INNER JOIN books_custom_column_8_link bcl ON cv.id=bcl.value
            WHERE bcl.book=? AND cv.value > 0
        """, (bid,)).fetchone()
        if gr:
            rec.goodreads_rating = gr["value"]

        # Date read from Goodreads date_read (cc9)
        dr = self._exec("SELECT value FROM custom_column_9 WHERE book=?", (bid,),).fetchone()
        if dr and dr["value"]:
            rec.date_read = self._ts(dr["value"])

        # NetGalley deadline
        nr = self._exec("SELECT value FROM custom_column_24 WHERE book=? ", (bid,)
        ).fetchone()
        if nr and nr["value"]:
            rec.netgalley_deadline = self._ts(nr["value"])

        # Word count & page count
        wr = self._exec("SELECT value FROM custom_column_21 WHERE book=?", (bid,)).fetchone()
        if wr:
            try:
                rec.word_count = int(wr["value"])
            except (ValueError, TypeError):
                pass

        pc = self._exec("SELECT value FROM custom_column_11 WHERE book=?", (bid,)).fetchone()
        if pc:
            try:
                rec.page_count = int(pc["value"])
            except (ValueError, TypeError):
                pass

        # Blurb / synopsis from comments table
        cr = self._exec("SELECT text FROM comments WHERE book=?", (bid,)).fetchone()
        if cr and cr["text"]:
            rec.blurb = cr["text"]

        # Personal notes (custom review field)
        pr2 = self._exec(
            "SELECT value FROM custom_column_23 WHERE book=?", (bid,)
        ).fetchone()
        if pr2 and pr2["value"]:
            rec.personal_notes = pr2["value"]

        # Goodreads ID from identifiers
        gr = self._exec(
            "SELECT val FROM identifiers WHERE book=? AND type='goodreads'", (bid,)
        ).fetchone()
        if gr and gr["val"]:
            rec.goodreads_id = gr["val"]

        # EPUB file path resolution
        er = self._exec(
            "SELECT name FROM data WHERE book=? AND format IN ('EPUB','ORIGINAL_EPUB')", (bid,)
        ).fetchone()
        if er:
            base_name = er["name"]
            bp2r = self._exec("SELECT path FROM books WHERE id=?", (bid,)).fetchone()
            if bp2r:
                rec.epub_path = os.path.join(self.library_root, str(bp2r["path"]), f"{base_name}.epub")

        # Cover image path
        cr = self._exec(
            "SELECT has_cover, path FROM books WHERE id=?", (bid,)
        ).fetchone()
        if cr and cr["has_cover"]:
            rec.cover_path = os.path.join(self.library_root, str(cr["path"]), "cover.jpg")

        return rec

    def _fill_multi(self, rec: BookRecord, attr: str, cc_num: int, bid: int):
        table = f"books_custom_column_{cc_num}_link"
        col_table = f"custom_column_{cc_num}"
        try:
            rows = self._exec(
                f"""SELECT c.value FROM {col_table} c
                   INNER JOIN {table} bcl ON c.id=bcl.value
                   WHERE bcl.book=?""",
                (bid,)
            ).fetchall()
        except sqlite3.OperationalError:
            # Table doesn't exist in this Calibre DB version — skip silently
            return
        except sqlite3.InterfaceError:
            raise  # re-raise interface errors up to caller for broader handling
        for r in rows:
            getattr(rec, attr).append(r["value"])

    @staticmethod
    def _ts(v) -> Optional[datetime]:
        if not v:
            return None
        try:
            s = str(v).replace(" ", "T")
            return datetime.fromisoformat(s.replace("+00:00", "+0000") if "+" in s else s)
        except Exception:
            pass
        try:
            import time as _t
            return datetime.fromtimestamp(_t.mktime(v.timetuple()))
        except Exception:
            return None
