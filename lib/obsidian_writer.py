import os
from typing import Optional
from datetime import datetime
from collections import OrderedDict

import frontmatter

from .models import BookRecord


class ObsidianWriter:
    """
    Reads/writes review markdown files in an Obsidian vault.
    
    Directory structure (from plan):
      ~/BookReviews/arcs/   -> ARC reviews
      ~/BookReviews/misc/   -> Non-ARC reviews
    
    Filename convention: [goodreads_id].md
    """

    ARCS_FOLDER = "arcs"
    MISC_FOLDER = "misc"

    def __init__(self, vault_path: str):
        self.vault_path = os.path.expanduser(vault_path)
        if not os.path.exists(self.vault_path):
            os.makedirs(os.path.join(self.vault_path, self.ARCS_FOLDER), exist_ok=True)
            os.makedirs(os.path.join(self.vault_path, self.MISC_FOLDER), exist_ok=True)
        # Index files by frontmatter goodreads ID so lookups work regardless of filename convention
        self._id_index = self._build_index()

    def _folder_for_book(self, book: BookRecord) -> str:
        return self.ARCS_FOLDER if "arc" in [t.lower() for t in book.tags] else self.MISC_FOLDER

    def _filename_for_book(self, book: BookRecord) -> Optional[str]:
        if not book.goodreads_id:
            return None
        return f"{book.goodreads_id}.md"

    def _full_paths(self, book: BookRecord):
        folder = self._folder_for_book(book)
        fname = self._filename_for_book(book)
        if fname is None:
            return (os.path.join(self.vault_path, folder, ""), folder, None)
        return os.path.join(self.vault_path, folder, fname), folder, fname

    # --------------------------------------------------------------- #
    # Writing                                                         #
    # --------------------------------------------------------------- #

    def write_review(self, book: BookRecord, raw_markdown: str) -> bool:
        if not raw_markdown.strip():
            return False

        # If a file already exists for this book (via frontmatter index), reuse its path
        existing_path = self._find_review_path(book)
        if existing_path and os.path.exists(existing_path):
            fpath = existing_path
        else:
            fpath, _, _ = self._full_paths(book)
            if not fpath:
                return False
            os.makedirs(os.path.dirname(fpath), exist_ok=True)

        with open(fpath, "w", encoding="utf-8") as f:
            f.write(raw_markdown)

        # Refresh index after write so new/updated files are found
        self._id_index = self._build_index()
        return True

    # --------------------------------------------------------------- #
    # Reading                                                         #
    # --------------------------------------------------------------- #

    def _build_index(self):
        """Scan all .md files in arcs/ and misc/, index by frontmatter goodreads ID."""
        index: dict[str, str] = {}
        for folder_name in (self.ARCS_FOLDER, self.MISC_FOLDER):
            folder_path = os.path.join(self.vault_path, folder_name)
            if not os.path.isdir(folder_path):
                continue
            for fname in os.listdir(folder_path):
                if not fname.endswith(".md"):
                    continue
                fpath = os.path.join(folder_path, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        post = frontmatter.load(f)
                    gr_id = post.get("goodreads")
                    if gr_id:
                        index[str(gr_id)] = fpath
                except Exception:
                    continue
        return index

    def _find_review_path(self, book: BookRecord) -> Optional[str]:
        if not book.goodreads_id:
            return None
        return self._id_index.get(book.goodreads_id)

    def read_review(self, book: BookRecord) -> Optional[str]:
        fpath = self._find_review_path(book)
        if fpath is None or not os.path.exists(fpath):
            return None
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                post = frontmatter.load(f)
            return post.content
        except Exception:
            return None

    def read_raw_review(self, book: BookRecord) -> Optional[str]:
        fpath = self._find_review_path(book)
        if fpath is None or not os.path.exists(fpath):
            return None
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None

    def read_all_reviews(self) -> dict[str, tuple[str, str]]:
        """Scan both arcs/ and misc/, return {goodreads_id: (folder, review_text)}."""
        result: dict[str, tuple[str, str]] = {}

        for folder_name in (self.ARCS_FOLDER, self.MISC_FOLDER):
            folder_path = os.path.join(self.vault_path, folder_name)
            if not os.path.isdir(folder_path):
                continue

            for fname in sorted(os.listdir(folder_path)):
                if not fname.endswith(".md"):
                    continue
                fpath = os.path.join(folder_path, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        post = frontmatter.load(f)
                    gr_id = post.get("goodreads")
                    if gr_id:
                        result[str(gr_id)] = (folder_name, post.content)
                except Exception:
                    continue

        return result

    def has_review(self, book: BookRecord) -> bool:
        return self._find_review_path(book) is not None

    # --------------------------------------------------------------- #
    # Housekeeping                                                    #
    # --------------------------------------------------------------- #

    def delete_review(self, book: BookRecord) -> bool:
        fpath = self._find_review_path(book)
        if fpath and os.path.exists(fpath):
            os.remove(fpath)
            # Refresh index after deletion
            self._id_index.pop(book.goodreads_id, None)
            return True
        return False
