"""Shared access to the ChromaDB collection that holds every indexed book chunk.

The ingestor writes to it and the chat engine reads from it; both open it the
same way, so the name and distance metric live here once. `chromadb` is imported
lazily because loading it takes seconds and the server starts without it.
"""

from __future__ import annotations

import os
import sqlite3

COLLECTION_NAME = "book_texts"


def open_collection(chroma_path: str):
    """Open (creating if needed) the book-text collection at *chroma_path*."""
    import chromadb

    os.makedirs(chroma_path, exist_ok=True)
    client = chromadb.PersistentClient(path=chroma_path)
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


def indexed_ids_from_sqlite(chroma_path: str) -> set[int] | None:
    """Every calibre id with embeddings, read straight from `chroma.sqlite3`.

    A DISTINCT over the metadata table avoids Chroma's API entirely, which both
    sidesteps SQLite's bound-variable cap on large collections and works when the
    HNSW index itself will not load. Returns None when the file is missing.
    """
    db_path = os.path.join(chroma_path, "chroma.sqlite3")
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT DISTINCT int_value FROM embedding_metadata WHERE key = '_cid'"
        ).fetchall()
    finally:
        conn.close()
    return {int(r[0]) for r in rows if r[0] is not None}
