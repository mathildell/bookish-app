"""JSON-file persistence for the app's small user collections.

Book lists, character lists and bookmarks are each a JSON array of records with an
integer `id`. They are small, edited by one person, and easy to inspect or back up
by hand, so a file per collection is plenty — this module is the one place that
reads and writes them.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"


class JsonCollection:
    """A list of `{"id": int, ...}` records stored in one JSON file.

    Every read-modify-write runs under a single lock, so two concurrent requests
    can never drop each other's change.
    """

    def __init__(self, filename: str):
        self.path = DATA_DIR / filename
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # File access                                                        #
    # ------------------------------------------------------------------ #

    def _load(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text())
        except (json.JSONDecodeError, OSError):
            return []
        return data if isinstance(data, list) else []

    def _save(self, data: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, indent=2))

    @contextmanager
    def transaction(self) -> Iterator[list[dict]]:
        """Yield the records for in-place edits; they are saved on a clean exit."""
        with self._lock:
            data = self._load()
            yield data
            self._save(data)

    # ------------------------------------------------------------------ #
    # Record helpers                                                     #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _id(item: dict) -> int:
        return int(item.get("id", 0))

    def all(self) -> list[dict]:
        with self._lock:
            return self._load()

    def get(self, item_id: int) -> Optional[dict]:
        return next((item for item in self.all() if self._id(item) == item_id), None)

    def add(self, fields: dict, *, existing: Callable[[dict], bool] | None = None) -> dict:
        """Append a record with the next free id and return it.

        When *existing* matches a stored record, that record is returned instead
        and nothing is written — used to make "save" idempotent.
        """
        with self.transaction() as data:
            if existing:
                match = next((item for item in data if existing(item)), None)
                if match is not None:
                    return match
            record = {"id": max((self._id(i) for i in data), default=0) + 1, **fields}
            data.append(record)
            return record

    def update(self, item_id: int, apply: Callable[[dict], None]) -> Optional[dict]:
        """Run *apply* on the matching record in place; None if there is none."""
        with self.transaction() as data:
            for item in data:
                if self._id(item) == item_id:
                    apply(item)
                    return item
        return None

    def delete(self, item_id: int) -> bool:
        with self.transaction() as data:
            kept = [item for item in data if self._id(item) != item_id]
            removed = len(kept) != len(data)
            data[:] = kept
        return removed


book_lists = JsonCollection("lists.json")
character_lists = JsonCollection("character_lists.json")
bookmarks = JsonCollection("bookmarks.json")
