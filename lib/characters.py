"""Character profile storage backed by SQLite.

Profiles are deliberately *personality-first*: the fields describe who a character
is rather than the world they came from, so the same card can be cast into an
unrelated setting. Anything that only makes sense inside the original story lives
in `situational_anchors` and is kept out of the creative-writing prompt.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# --------------------------------------------------------------------------- #
# Field groups                                                                #
# --------------------------------------------------------------------------- #

# Stored as a JSON blob in a TEXT column.
_LIST_FIELDS = (
    "core_traits",
    "fears",
    "flaws",
    "values",
    "mannerisms",
    "relationships",
    "situational_anchors",
)
_DICT_FIELDS = ("motivations", "voice", "appearance")
_JSON_FIELDS = _LIST_FIELDS + _DICT_FIELDS

# Plain scalars.
_SCALAR_FIELDS = (
    "name",
    "role",
    "archetype",
    "summary",
    "formative_experience",
    "arc_pattern",
    "thumbnail",
    "status",
    "error",
    "model",
)

_COLUMNS = (*_SCALAR_FIELDS, *_JSON_FIELDS)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS characters (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    role          TEXT,
    archetype     TEXT,
    summary       TEXT,
    formative_experience TEXT,
    arc_pattern   TEXT,
    thumbnail     TEXT,
    status        TEXT NOT NULL DEFAULT 'complete',
    error         TEXT,
    model         TEXT,
    core_traits   TEXT,
    motivations   TEXT,
    fears         TEXT,
    flaws         TEXT,
    "values"      TEXT,
    voice         TEXT,
    mannerisms    TEXT,
    appearance    TEXT,
    relationships TEXT,
    situational_anchors TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_sources (
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    calibre_id   INTEGER NOT NULL,
    PRIMARY KEY (character_id, calibre_id)
);

CREATE TABLE IF NOT EXISTS character_aliases (
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    alias        TEXT NOT NULL,
    PRIMARY KEY (character_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_character_sources_book
    ON character_sources(calibre_id);
CREATE INDEX IF NOT EXISTS idx_characters_name
    ON characters(name COLLATE NOCASE);
"""

# Honorifics and articles are stripped before names are compared: "Mr Darcy",
# "the Bloodless" and "Darcy" must land on the same key.
_NOISE_PREFIXES = (
    "mr",
    "mrs",
    "ms",
    "miss",
    "mx",
    "dr",
    "sir",
    "lady",
    "lord",
    "laird",
    "the",
    "a",
    "an",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_name(name: str) -> str:
    """Lowercase, drop punctuation and leading honorifics/articles."""
    cleaned = re.sub(r"[^\w\s'-]", "", (name or "").lower()).strip()
    tokens = cleaned.split()
    while len(tokens) > 1 and tokens[0] in _NOISE_PREFIXES:
        tokens.pop(0)
    return " ".join(tokens).replace("-", " ").strip()


def _encode(field: str, value: Any) -> Any:
    if field in _JSON_FIELDS:
        return json.dumps(value if value is not None else _default(field), ensure_ascii=False)
    return value


def _default(field: str) -> Any:
    return {} if field in _DICT_FIELDS else []


def _decode(field: str, raw: Optional[str]) -> Any:
    if not raw:
        return _default(field)
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return _default(field)
    return value if isinstance(value, type(_default(field))) else _default(field)


class CharacterStore:
    """Thread-safe SQLite store for character profiles."""

    def __init__(self, db_path: str | Path):
        self._path = Path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # FastAPI runs sync routes in a worker threadpool, so the connection is
        # shared across threads and every access goes through `_lock`.
        self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # ------------------------------------------------------------------ #
    # Reads                                                              #
    # ------------------------------------------------------------------ #

    def list(self, query: Optional[str] = None, calibre_id: Optional[int] = None) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if calibre_id is not None:
            clauses.append(
                "id IN (SELECT character_id FROM character_sources WHERE calibre_id = ?)"
            )
            params.append(int(calibre_id))
        if query:
            clauses.append(
                "(lower(name) LIKE ? OR lower(coalesce(summary, '')) LIKE ? "
                "OR lower(coalesce(archetype, '')) LIKE ? OR lower(coalesce(role, '')) LIKE ?)"
            )
            needle = f"%{query.lower()}%"
            params.extend([needle, needle, needle, needle])

        sql = "SELECT * FROM characters"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY name COLLATE NOCASE"

        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
            return [self._hydrate(row) for row in rows]

    def get(self, character_id: int) -> Optional[dict]:
        with self._lock:
            row = self._row(character_id)
            return self._hydrate(row) if row else None

    def count(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) FROM characters").fetchone()[0])

    def find_by_identity(self, name: str) -> list[dict]:
        """Characters whose name or alias normalises to *name*."""
        key = normalize_name(name)
        if not key:
            return []
        with self._lock:
            rows = self._conn.execute(
                "SELECT c.*, a.alias AS _alias FROM characters c "
                "LEFT JOIN character_aliases a ON a.character_id = c.id"
            ).fetchall()
        matches: dict[int, dict] = {}
        for row in rows:
            candidate = normalize_name(row["name"])
            alias = normalize_name(row["_alias"] or "")
            if key in (candidate, alias):
                matches.setdefault(int(row["id"]), self._hydrate(row))
        return list(matches.values())

    # ------------------------------------------------------------------ #
    # Writes                                                             #
    # ------------------------------------------------------------------ #

    def create(self, data: dict) -> dict:
        payload = dict(data)
        aliases = [a.strip() for a in (payload.pop("aliases", None) or []) if a and a.strip()]
        sources = [int(c) for c in (payload.pop("source_book_ids", None) or [])]
        payload.pop("id", None)

        fields = {k: v for k, v in payload.items() if k in _COLUMNS and v is not None}
        fields.setdefault("status", "complete")
        now = _now()

        columns = [*fields, "created_at", "updated_at"]
        placeholders = ", ".join("?" for _ in columns)
        # Identifiers are quoted because `values` is a reserved word in SQLite.
        column_sql = ", ".join(f'"{c}"' for c in columns)
        values = [_encode(k, v) for k, v in fields.items()] + [now, now]

        with self._lock:
            cur = self._conn.execute(
                f"INSERT INTO characters ({column_sql}) VALUES ({placeholders})",
                values,
            )
            character_id = int(cur.lastrowid)
            self._write_aliases(character_id, aliases)
            self._write_sources(character_id, sources)
            self._conn.commit()
            return self._hydrate(self._row(character_id))

    def update(self, character_id: int, patch: dict) -> Optional[dict]:
        payload = dict(patch)
        aliases = payload.pop("aliases", None)
        sources = payload.pop("source_book_ids", None)

        # `name` is a valid column but must never be blanked by a partial patch.
        fields = {k: v for k, v in payload.items() if k in _COLUMNS and v is not None}
        if "name" in fields and not str(fields["name"]).strip():
            fields.pop("name")

        with self._lock:
            if not self._row(character_id):
                return None

            if fields:
                assignments = ", ".join(f'"{k}" = ?' for k in fields)
                self._conn.execute(
                    f"UPDATE characters SET {assignments}, updated_at = ? WHERE id = ?",
                    [*[_encode(k, v) for k, v in fields.items()], _now(), int(character_id)],
                )
            else:
                self._conn.execute(
                    "UPDATE characters SET updated_at = ? WHERE id = ?",
                    (_now(), int(character_id)),
                )

            if aliases is not None:
                self._write_aliases(character_id, [a for a in aliases if a and a.strip()])
            if sources is not None:
                self._write_sources(character_id, sources)

            self._conn.commit()
            return self._hydrate(self._row(character_id))

    def delete(self, character_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM characters WHERE id = ?", (int(character_id),)
            )
            self._conn.commit()
            return cur.rowcount > 0

    # ------------------------------------------------------------------ #
    # Internals                                                          #
    # ------------------------------------------------------------------ #

    def _row(self, character_id: int) -> Optional[sqlite3.Row]:
        """The raw row; callers hold `_lock`."""
        return self._conn.execute(
            "SELECT * FROM characters WHERE id = ?", (int(character_id),)
        ).fetchone()

    def _write_aliases(self, character_id: int, aliases: list[str]):
        self._conn.execute(
            "DELETE FROM character_aliases WHERE character_id = ?", (int(character_id),)
        )
        seen: set[str] = set()
        for alias in aliases:
            if alias and alias not in seen:
                seen.add(alias)
                self._conn.execute(
                    "INSERT OR IGNORE INTO character_aliases (character_id, alias) VALUES (?, ?)",
                    (int(character_id), alias),
                )

    def _write_sources(self, character_id: int, sources: list[int]):
        self._conn.execute(
            "DELETE FROM character_sources WHERE character_id = ?", (int(character_id),)
        )
        for calibre_id in sorted({int(s) for s in sources}):
            self._conn.execute(
                "INSERT OR IGNORE INTO character_sources (character_id, calibre_id) VALUES (?, ?)",
                (int(character_id), calibre_id),
            )

    def _hydrate(self, row: sqlite3.Row) -> dict:
        data: dict[str, Any] = {key: row[key] for key in row.keys() if not key.startswith("_")}
        for field_name in _JSON_FIELDS:
            data[field_name] = _decode(field_name, data.get(field_name))

        character_id = int(row["id"])
        data["aliases"] = [
            r["alias"]
            for r in self._conn.execute(
                "SELECT alias FROM character_aliases WHERE character_id = ? ORDER BY alias",
                (character_id,),
            ).fetchall()
        ]
        data["source_book_ids"] = [
            int(r["calibre_id"])
            for r in self._conn.execute(
                "SELECT calibre_id FROM character_sources WHERE character_id = ? ORDER BY calibre_id",
                (character_id,),
            ).fetchall()
        ]
        return data
