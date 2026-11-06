import os
import json
import logging
import math
from typing import Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime

import ebooklib
from ebooklib import epub as _epub
from bs4 import BeautifulSoup
import chromadb
from ollama import Client

from .models import BookRecord, AppSettings

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
        os.makedirs(settings.chroma_db_path, exist_ok=True)
        self._chroma_client = chromadb.PersistentClient(path=settings.chroma_db_path)
        self._collection = self._chroma_client.get_or_create_collection(
            name="book_texts",
            metadata={"hnsw:space": "cosine"},
        )
        self._ollama = Client(host=settings.ollama_base_url)

    # --------------------------------------------------------------- #
    # Public API                                                      #
    # --------------------------------------------------------------- #

    def get_all_indexed_ids(self) -> set[int]:
        """Return all calibre_ids that currently have embeddings.

        Uses ChromaDB's count() to verify the collection is accessible,
        then reads distinct _cid metadata directly from chroma.sqlite3 to
        avoid "too many SQL variables" errors with large collections (500K+ chunks).
        """
        import sqlite3 as _sqlite

        # Verify collection is healthy first
        self._collection.count()  # raises if hnsw is corrupted

        # Direct SQLite read is faster and avoids bound-param limits
        db_path = os.path.join(
            self.s.chroma_db_path,
            "chroma.sqlite3",
        )
        conn = _sqlite.connect(db_path)
        try:
            rows = conn.execute(
                "SELECT DISTINCT em.int_value FROM embedding_metadata em "
                "WHERE em.key = '_cid'"
            ).fetchall()
            return {int(r[0]) for r in rows}
        except Exception:
            # Fallback: iterate via ChromaDB API
            cids = set()
            batch_size = 5_000
            total = self._collection.count()
            seen_ids = set()
            while len(seen_ids) < min(total, 2_000_000):
                res = self._collection.get(limit=batch_size, include=["metadatas"])
                new_ids = set(res.get("ids", [])) - seen_ids
                if not new_ids:
                    break
                seen_ids.update(new_ids)
            return cids
        finally:
            conn.close()

    def is_indexed(self, calibre_id: int) -> bool:
        """Check if a book already has embeddings in ChromaDB."""
        res = self._collection.get(
            where={"_cid": calibre_id},
            limit=1,
        )
        return len(res["ids"]) > 0

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

        books_chunks = self._chunk_chapters(chapters, book.calibre_id)
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

        self._collection.upsert(
            ids=chunk_ids,
            documents=[c.text for c in books_chunks],
            embeddings=embeddings,
            metadatas=metadata_list,
        )

        if progress_callback:
            prog.current_step = "complete"
            progress_callback(prog)

        return True

    def get_embedded_book_ids(self) -> set[int]:
        """Return all calibre IDs that have embeddings stored."""
        res = self._collection.get()
        if not res or not res["metadatas"]:
            return set()
        cids = set()
        for m in res["metadatas"]:
            cid = m.get("_cid")
            if cid is not None:
                cids.add(int(cid))
        return cids

    def delete_book(self, calibre_id: int):
        self._collection.delete(where={"_cid": calibre_id})

    # --------------------------------------------------------------- #
    # Internal EPUB extraction                                        #
    # --------------------------------------------------------------- #

    @staticmethod
    def _extract_chapters(epub_path: str) -> list[tuple[str, str]]:
        try:
            try:
                book = _epub.read_epub(epub_path)
            except Exception:
                book = _epub.EpubBook()
                book.parse_opf(epub_path + ".opf")
                pass

            items = list(book.get_items())

            chapters = []
            for item in items:
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
            pass
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
            tokens_approx = len(ch_text) // 4
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
            print(f"  [embed err] {e}")
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

