"""Worldbuilding sheet storage backed by SQLite.

A world is the setting-level counterpart of a character profile: the rules, social
structure and conventions of a fictional universe (an omegaverse, a magic school, a
dystopia), extracted from one or more books and cast into new stories. Like profiles,
sheets are editable by hand, and hand-edited fields are locked against regeneration.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Plain scalars.
_SCALAR_FIELDS = ("name", "premise", "image", "status", "error", "model")

# Lists of strings, or of {term, meaning} for the glossary. All stored as JSON.
_LIST_FIELDS = (
    "rules",
    "social_structure",
    "tropes",
    "settings",
    "terminology",
    "tensions",
    "variants",
    # Disagreements between sources the writer has settled, as the decision taken. A
    # refine treats them as authoritative so a settled conflict does not come back.
    "decisions",
    "locked_fields",
)

# The evidence behind a generated sheet: every note recorded, and which passages were
# read, so a refine reads *new* passages and builds on the notes already taken.
# `source_weights` is {calibre id: "normal" | "emphasise" | "primary"}: how hard a refine
# leans on each book. It is a setting, so a reset of the analysis never touches it.
_DICT_FIELDS = ("analysis", "source_weights")

_COLUMNS = (*_SCALAR_FIELDS, *_LIST_FIELDS, *_DICT_FIELDS)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS worlds (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    premise          TEXT,
    image            TEXT,
    status           TEXT NOT NULL DEFAULT 'complete',
    error            TEXT,
    model            TEXT,
    rules            TEXT,
    social_structure TEXT,
    tropes           TEXT,
    settings         TEXT,
    terminology      TEXT,
    tensions         TEXT,
    variants         TEXT,
    decisions        TEXT,
    locked_fields    TEXT,
    analysis         TEXT,
    source_weights   TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_sources (
    world_id   INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    calibre_id INTEGER NOT NULL,
    PRIMARY KEY (world_id, calibre_id)
);

CREATE INDEX IF NOT EXISTS idx_worlds_name ON worlds(name COLLATE NOCASE);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _decode(raw: Optional[str]) -> list:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


class WorldStore:
    """Thread-safe SQLite store for worldbuilding sheets."""

    def __init__(self, db_path: str | Path):
        self._path = Path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._migrate()
            self._conn.commit()

    def list(self, query: Optional[str] = None, calibre_id: Optional[int] = None) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if calibre_id is not None:
            clauses.append("id IN (SELECT world_id FROM world_sources WHERE calibre_id = ?)")
            params.append(int(calibre_id))
        if query:
            clauses.append("(lower(name) LIKE ? OR lower(coalesce(premise, '')) LIKE ?)")
            needle = f"%{query.lower()}%"
            params.extend([needle, needle])
        sql = "SELECT * FROM worlds"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY name COLLATE NOCASE"
        with self._lock:
            return [self._hydrate(r) for r in self._conn.execute(sql, params).fetchall()]

    def get(self, world_id: int) -> Optional[dict]:
        with self._lock:
            row = self._row(world_id)
            return self._hydrate(row) if row else None

    def create(self, data: dict) -> dict:
        payload = dict(data)
        sources = [int(c) for c in (payload.pop("source_book_ids", None) or [])]
        payload.pop("id", None)
        fields = {k: v for k, v in payload.items() if k in _COLUMNS and v is not None}
        fields.setdefault("status", "complete")
        now = _now()

        columns = [*fields, "created_at", "updated_at"]
        placeholders = ", ".join("?" for _ in columns)
        values = [self._encode(k, v) for k, v in fields.items()] + [now, now]
        with self._lock:
            cur = self._conn.execute(
                f"INSERT INTO worlds ({', '.join(columns)}) VALUES ({placeholders})", values
            )
            world_id = int(cur.lastrowid)
            self._write_sources(world_id, sources)
            self._conn.commit()
            return self._hydrate(self._row(world_id))

    def update(self, world_id: int, patch: dict) -> Optional[dict]:
        payload = dict(patch)
        sources = payload.pop("source_book_ids", None)
        fields = {k: v for k, v in payload.items() if k in _COLUMNS and v is not None}
        if "name" in fields and not str(fields["name"]).strip():
            fields.pop("name")

        with self._lock:
            if not self._row(world_id):
                return None
            assignments = ", ".join(f"{k} = ?" for k in fields)
            self._conn.execute(
                f"UPDATE worlds SET {assignments + ', ' if assignments else ''}updated_at = ? WHERE id = ?",
                [*[self._encode(k, v) for k, v in fields.items()], _now(), int(world_id)],
            )
            if sources is not None:
                self._write_sources(world_id, sources)
            self._conn.commit()
            return self._hydrate(self._row(world_id))

    def delete(self, world_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM worlds WHERE id = ?", (int(world_id),))
            self._conn.commit()
            return cur.rowcount > 0

    # ------------------------------------------------------------------ #

    def _migrate(self) -> None:
        """Add columns introduced after a database was created; callers hold `_lock`."""
        present = {row[1] for row in self._conn.execute("PRAGMA table_info(worlds)")}
        for column in ("analysis", "source_weights", "image", "decisions"):
            if column not in present:
                self._conn.execute(f"ALTER TABLE worlds ADD COLUMN {column} TEXT")

    @staticmethod
    def _encode(field: str, value: Any) -> Any:
        if field in _LIST_FIELDS:
            return json.dumps(value if value is not None else [], ensure_ascii=False)
        if field in _DICT_FIELDS:
            return json.dumps(value if value is not None else {}, ensure_ascii=False)
        return value

    def _row(self, world_id: int) -> Optional[sqlite3.Row]:
        return self._conn.execute("SELECT * FROM worlds WHERE id = ?", (int(world_id),)).fetchone()

    def _write_sources(self, world_id: int, sources: list[int]) -> None:
        self._conn.execute("DELETE FROM world_sources WHERE world_id = ?", (int(world_id),))
        for calibre_id in sorted({int(s) for s in sources}):
            self._conn.execute(
                "INSERT OR IGNORE INTO world_sources (world_id, calibre_id) VALUES (?, ?)",
                (int(world_id), calibre_id),
            )

    def _hydrate(self, row: sqlite3.Row) -> dict:
        data: dict[str, Any] = {key: row[key] for key in row.keys()}
        for field_name in _LIST_FIELDS:
            data[field_name] = _decode(data.get(field_name))
        try:
            analysis = json.loads(data.get("analysis") or "{}")
        except (TypeError, ValueError):
            analysis = {}
        analysis = analysis if isinstance(analysis, dict) else {}
        data["analysis"] = analysis
        try:
            weights = json.loads(data.get("source_weights") or "{}")
        except (TypeError, ValueError):
            weights = {}
        data["source_weights"] = weights if isinstance(weights, dict) else {}
        data["evidence"] = (
            {
                "notes": len(analysis.get("notes") or []),
                "passages": len(analysis.get("used") or []),
                "passes": int(analysis.get("passes") or 0),
            }
            if analysis.get("notes")
            else None
        )
        data["source_book_ids"] = [
            int(r["calibre_id"])
            for r in self._conn.execute(
                "SELECT calibre_id FROM world_sources WHERE world_id = ? ORDER BY calibre_id",
                (int(row["id"]),),
            ).fetchall()
        ]
        return data
