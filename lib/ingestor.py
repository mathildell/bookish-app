"""EPUB -> text chunks -> embeddings -> ChromaDB."""

import json
import logging
import os
from dataclasses import dataclass
from typing import Callable, Optional

import ebooklib
from bs4 import BeautifulSoup
from ebooklib import epub as _epub
from ollama import Client

from .models import AppSettings, BookRecord
from .vector_store import indexed_ids_from_sqlite, open_collection

logger = logging.getLogger(__name__)


@dataclass
class Chunk:
    text: str
    calibre_id: int
    chapter_name: str = ""
    start_offset: int = 0
    end_offset: int = 0


@dataclass
class IngestionProgress:
    book_title: str = ""
    current_step: str = "idle"
    chapters_extracted: int = 0
    chunks_created: int = 0
    embeds_done: int = 0
    error: Optional[str] = None


class Ingestor:
    """
    EPUB -> text chunk -> embedding -> ChromaDB pipeline.
    """

    def __init__(self, settings: AppSettings):
        self.s = settings
        self.collection = open_collection(settings.chroma_db_path)
        self._ollama = Client(host=settings.ollama_base_url)

    # --------------------------------------------------------------- #
    # Public API                                                      #
    # --------------------------------------------------------------- #

    def get_all_indexed_ids(self) -> set[int]:
        """Every calibre_id that currently has embeddings.

        Reads chroma.sqlite3 directly (fast, and free of SQLite's bound-variable
        cap on 500K+ chunk collections); pages through the Chroma API only if
        that fails.
        """
        self.collection.count()  # raises if the HNSW index is corrupted
        try:
            ids = indexed_ids_from_sqlite(self.s.chroma_db_path)
            if ids is not None:
                return ids
        except Exception as exc:
            logger.warning("Direct SQLite read failed; paging through Chroma", exc_info=exc)

        cids: set[int] = set()
        offset, page = 0, 5_000
        while True:
            res = self.collection.get(limit=page, offset=offset, include=["metadatas"])
            metadatas = res.get("metadatas") or []
            cids.update(int(m["_cid"]) for m in metadatas if m and m.get("_cid") is not None)
            if len(metadatas) < page:
                return cids
            offset += page

    def index_book(
        self,
        book: BookRecord,
        progress_callback: Optional[Callable[[IngestionProgress], None]] = None,
    ) -> bool:
        """Extract, chunk, embed, and store a single book."""
        if not book.epub_path or not os.path.exists(book.epub_path):
            if progress_callback:
                progress_callback(IngestionProgress(
                    book_title=book.title,
                    error="No readable EPUB file found.",
                ))
            return False

        prog = IngestionProgress(
            book_title=book.title,
            current_step="extracting EPUB...",
        )
        if progress_callback:
            progress_callback(prog)

        chapters = self._extract_chapters(book.epub_path)
        if not chapters:
            if progress_callback:
                progress_callback(IngestionProgress(
                    book_title=book.title,
                    current_step="failed to extract chapters.",
                    error="Could not parse EPUB content.",
                ))
            return False

        prog.chapters_extracted = len(chapters)
        if progress_callback:
            progress_callback(prog)

        # Chunk size and overlap come from settings. They used to be ignored here,
        # so the Chunk Size setting looked live but every book was chunked at the
        # 600-token default — which matters now that a re-ingest at a different
        # size is a supported thing to do (scripts/reingest_to_model.py).
        books_chunks = self._chunk_chapters(
            chapters,
            book.calibre_id,
            chunk_size=self.s.chunk_size,
            overlap_pct=self.s.chunk_overlap / 100,
        )
        prog.chunks_created = len(books_chunks)
        if progress_callback:
            progress_callback(prog)

        metadata_list = self._build_chunk_metadata(book, books_chunks)
        embeddings = []
        for i, chunk in enumerate(books_chunks):
            emb = self._embed_text(chunk.text)
            if emb is None:
                if progress_callback:
                    progress_callback(IngestionProgress(
                        book_title=book.title,
                        error=f"Embedding failed at chunk {i + 1}/{len(books_chunks)}.",
                    ))
                return False

            embeddings.append(emb)
            prog.embeds_done = i + 1
            if (i + 1) % 5 == 0 and progress_callback:
                progress_callback(prog)

        chunk_ids = [f"{book.calibre_id}_c{j}" for j in range(len(books_chunks))]

        # Drop the previous run's chunks first: a re-index that produces fewer
        # chunks would otherwise leave the old tail searchable.
        self.delete_book(book.calibre_id)
        self.collection.upsert(
            ids=chunk_ids,
            documents=[c.text for c in books_chunks],
            embeddings=embeddings,
            metadatas=metadata_list,
        )

        if progress_callback:
            prog.current_step = "complete"
            progress_callback(prog)

        return True

    def delete_book(self, calibre_id: int):
        self.collection.delete(where={"_cid": calibre_id})

    # --------------------------------------------------------------- #
    # Internal EPUB extraction                                        #
    # --------------------------------------------------------------- #

    @staticmethod
    def _extract_chapters(epub_path: str) -> list[tuple[str, str]]:
        try:
            book = _epub.read_epub(epub_path)
            chapters = []
            for item in book.get_items():
                if item.get_type() != ebooklib.ITEM_DOCUMENT:
                    continue

                content_str = item.get_content().decode("utf-8", errors="replace")
                soup = BeautifulSoup(content_str, "html.parser")
                clean = soup.get_text(separator="\n", strip=True)

                clean_lines = [l for l in clean.split("\n") if l.strip()]
                clean = "\n".join(clean_lines)

                if len(clean.strip()) < 30:
                    continue

                try:
                    title_attr = item.get_metas("DC", "title")
                except Exception:
                    title_attr = []
                chapter_name = (title_attr or [])[0] if title_attr else item.get_name() or ""
                chapters.append((chapter_name, clean))

            return chapters
        except Exception as exc:
            logger.warning("EPUB extraction failed", exc_info=exc)
            return []

    # --------------------------------------------------------------- #
    # Chunking                                                        #
    # --------------------------------------------------------------- #

    @staticmethod
    def _chunk_chapters(
        chapters: list[tuple[str, str]],
        calibre_id: int,
        chunk_size: int = 600,
        overlap_pct: float = 0.10,
    ) -> list[Chunk]:
        chunks: list[Chunk] = []

        for ch_name, ch_text in chapters:
            target_tokens = chunk_size * 4
            actual_chunk_chars = max(2_000, target_tokens)
            overlap_chars = int(actual_chunk_chars * overlap_pct)

            offset = 0
            while offset < len(ch_text):
                end = min(offset + actual_chunk_chars, len(ch_text))
                segment = ch_text[offset:end]
                chunks.append(Chunk(
                    text=segment.strip(),
                    calibre_id=calibre_id,
                    chapter_name=ch_name,
                    start_offset=offset,
                    end_offset=end,
                ))
                offset = end - overlap_chars if (end < len(ch_text)) else end

        return chunks

    # --------------------------------------------------------------- #
    # Embedding via Ollama                                           #
    # --------------------------------------------------------------- #

    def _embed_text(self, text: str) -> Optional[list[float]]:
        try:
            resp = self._ollama.embed(
                model=self.s.embedding_model,
                input=text[:8000],
            )
            return resp["embeddings"][0]
        except Exception as e:
            logger.warning("Embedding failed for text segment", exc_info=e)
            return None

    # --------------------------------------------------------------- #
    # Metadata construction                                           #
    # --------------------------------------------------------------- #

    @staticmethod
    def _build_chunk_metadata(book: BookRecord, chunks: list[Chunk]) -> list[dict]:
        base_meta = {
            "_cid": book.calibre_id,
            "title": book.title,
            "authors": json.dumps(book.authors),
            "status": book.status or "",
            "genres": str(book.genres),
            "tropes": str(book.tropes),
        }
        result = []
        for ch in chunks:
            meta = dict(base_meta)
            meta["_chapter"] = ch.chapter_name
            meta["_offset_start"] = ch.start_offset
            meta["_offset_end"] = ch.end_offset
            result.append(meta)

        return result

