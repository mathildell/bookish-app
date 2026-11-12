"""Read and write book reviews as Markdown files in an Obsidian vault."""

from __future__ import annotations

import os
from typing import Iterator, Optional

import frontmatter

from .models import BookRecord


class ObsidianWriter:
    """
    Reviews live in two folders of the vault:

      <vault>/arcs/  -> ARC reviews (books tagged "ARC")
      <vault>/misc/  -> everything else

    New files are named `<goodreads_id>.md`, but existing files are found by the
    `goodreads` key in their frontmatter, so any filename works.
    """

    ARCS_FOLDER = "arcs"
    MISC_FOLDER = "misc"

    def __init__(self, vault_path: str):
        self.vault_path = os.path.expanduser(vault_path)
        for folder in (self.ARCS_FOLDER, self.MISC_FOLDER):
            os.makedirs(os.path.join(self.vault_path, folder), exist_ok=True)
        self._id_index = self._build_index()

    # --------------------------------------------------------------- #
    # Index                                                            #
    # --------------------------------------------------------------- #

    def _review_files(self) -> Iterator[str]:
        for folder in (self.ARCS_FOLDER, self.MISC_FOLDER):
            folder_path = os.path.join(self.vault_path, folder)
            if not os.path.isdir(folder_path):
                continue
            for name in sorted(os.listdir(folder_path)):
                if name.endswith(".md"):
                    yield os.path.join(folder_path, name)

    def _build_index(self) -> dict[str, str]:
        """{goodreads id: file path}, from each review's frontmatter."""
        index: dict[str, str] = {}
        for path in self._review_files():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    goodreads_id = frontmatter.load(f).get("goodreads")
            except Exception:
                continue
            if goodreads_id:
                index[str(goodreads_id)] = path
        return index

    def _find_review_path(self, book: BookRecord) -> Optional[str]:
        if not book.goodreads_id:
            return None
        path = self._id_index.get(str(book.goodreads_id))
        return path if path and os.path.exists(path) else None

    def has_review_for(self, goodreads_id: Optional[str]) -> bool:
        """Cheap in-memory check, used for every row of the ARC tracker."""
        return bool(goodreads_id) and str(goodreads_id) in self._id_index

    # --------------------------------------------------------------- #
    # Read / write / delete                                            #
    # --------------------------------------------------------------- #

    def read_raw_review(self, book: BookRecord) -> Optional[str]:
        """The whole review file, frontmatter included."""
        path = self._find_review_path(book)
        if path is None:
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except OSError:
            return None

    def write_review(self, book: BookRecord, raw_markdown: str) -> bool:
        """Save the review, reusing the book's existing file if it has one."""
        if not raw_markdown.strip():
            return False

        path = self._find_review_path(book)
        if path is None:
            if not book.goodreads_id:
                return False
            folder = self.ARCS_FOLDER if "arc" in (t.lower() for t in book.tags) else self.MISC_FOLDER
            path = os.path.join(self.vault_path, folder, f"{book.goodreads_id}.md")
            os.makedirs(os.path.dirname(path), exist_ok=True)

        with open(path, "w", encoding="utf-8") as f:
            f.write(raw_markdown)

        # Re-scan: the frontmatter of a new or edited file decides where it is found.
        self._id_index = self._build_index()
        return True

    def delete_review(self, book: BookRecord) -> bool:
        path = self._find_review_path(book)
        if path is None:
            return False
        os.remove(path)
        self._id_index.pop(str(book.goodreads_id), None)
        return True
