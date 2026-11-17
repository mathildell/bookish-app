#!/usr/bin/env python3
"""Clean orphaned book entries from ChromaDB.

Books deleted from Calibre leave behind indexed chunks in ChromaDB. This script
finds those orphans and optionally removes them.

Default (dry-run): lists orphan IDs and reports how many chunks would be deleted.
With --execute: actually deletes the orphan entries from ChromaDB.

Usage:
    python scripts/clean_orphans.py            # dry-run
    python scripts/clean_orphans.py --execute  # delete orphans
"""

import argparse
import sqlite3
import sys
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from backend.dependencies import init_services, get_settings


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def _get_calibre_ids(calibre_db_path: str) -> set[int]:
    """Return every book ID currently in Calibre's metadata.db."""
    conn = sqlite3.connect(f"file:{calibre_db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT id FROM books").fetchall()
        return {int(r[0]) for r in rows}
    finally:
        conn.close()


def _get_indexed_ids(chroma_db_path: str) -> set[int]:
    """Return every distinct calibre_id that has embeddings in ChromaDB.

    Reads chroma.sqlite3 directly (same approach as Ingestor.get_all_indexed_ids)
    to avoid the slow ChromaDB Python API pagination.
    """
    db_path = Path(chroma_db_path) / "chroma.sqlite3"
    if not db_path.exists():
        return set()

    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            "SELECT DISTINCT em.int_value FROM embedding_metadata em "
            "WHERE em.key = '_cid'"
        ).fetchall()
        return {int(r[0]) for r in rows}
    finally:
        conn.close()


def _describe_orphans(chroma_db_path: str, calibre_ids: set[int]) -> dict[int, tuple[int, str]]:
    """Look up chunk count and title per calibre_id in ChromaDB.

    Reads chroma.sqlite3 directly.  Returns {calibre_id: (chunk_count, title)}.
    Titles come from embedding_metadata (stored during ingestion).
    """
    db_path = Path(chroma_db_path) / "chroma.sqlite3"
    if not db_path.exists():
        return {}

    conn = sqlite3.connect(str(db_path))
    try:
        ph = ",".join("?" * len(calibre_ids))
        cid_rows = conn.execute(
            "SELECT em.int_value, COUNT(*) "
            "FROM embedding_metadata em "
            "WHERE em.key = '_cid' AND em.int_value IN ({}) "
            "GROUP BY em.int_value".format(ph),
            sorted(calibre_ids),
        ).fetchall()
        chunk_counts = {int(r[0]): int(r[1]) for r in cid_rows}

        title_rows = conn.execute(
            "SELECT DISTINCT cid_em.int_value, title_em.string_value "
            "FROM embedding_metadata cid_em "
            "JOIN embedding_metadata title_em "
            "  ON title_em.id = cid_em.id "
            "  AND title_em.key = 'title' "
            "WHERE cid_em.key = '_cid' "
            "AND cid_em.int_value IN ({})".format(ph),
            sorted(calibre_ids),
        ).fetchall()
        title_map = {int(r[0]): r[1] for r in title_rows}

        return {
            cid: (chunk_counts.get(cid, "?"), title_map.get(cid, "(unknown)"))
            for cid in calibre_ids
        }
    finally:
        conn.close()


def _delete_from_chroma(chroma_db_path: str, calibre_ids: set[int]):
    """Delete all chunks whose _cid matches the given calibre_ids."""
    import chromadb

    client = chromadb.PersistentClient(path=chroma_db_path)
    collection = client.get_collection("book_texts")

    for cid in sorted(calibre_ids):
        count_before = len(
            collection.get(where={"_cid": cid}).get("ids", [])
        )
        collection.delete(where={"_cid": cid})
        print(f"  ✅ Removed calibre_id={cid} ({count_before} chunks)")


# --------------------------------------------------------------------------- #
# Main                                                                        #
# --------------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(
        description="Find and remove orphaned book entries from ChromaDB.",
    )
    parser.add_argument(
        "--execute", action="store_true",
        help="Actually delete the orphans. Without this flag, only a dry-run is performed.",
    )
    args = parser.parse_args()

    # Load settings (Calibre + Chroma paths).  Ollama/ChromaDB are NOT needed.
    init_services()
    settings = get_settings()

    calibre_db_path = settings.calibre_db_path
    chroma_db_path = settings.chroma_db_path

    # Step 1: Calibre IDs
    print(f"Reading Calibre DB at {calibre_db_path} …")
    calibre_ids = _get_calibre_ids(calibre_db_path)
    print(f"  → {len(calibre_ids):,} active books in Calibre")

    # Step 2: Indexed IDs
    print(f"\nReading indexed IDs from ChromaDB at {chroma_db_path} …")
    indexed_ids = _get_indexed_ids(chroma_db_path)
    print(f"  → {len(indexed_ids):,} books currently in index")

    # Step 3: Difference
    orphans = indexed_ids - calibre_ids
    print(f"\n{'=' * 50}")

    orphans = indexed_ids - calibre_ids

    if not orphans:
        print("No orphaned entries found. Index is clean.")
        return

    print(f"Found {len(orphans)} orphaned book(s) in ChromaDB:\n")
    info = _describe_orphans(chroma_db_path, orphans)
    total_chunks = 0
    for cid in sorted(orphans):
        chunks, title = info.get(cid, ("?", "(unknown)"))
        if isinstance(chunks, int):
            total_chunks += chunks
        print(f"  calibre_id = {cid}  ({chunks:,} chunks) — {title}")

    print(f"\nTotal orphaned chunks: {total_chunks:,}")

    # Step 4 (optional): Delete
    if not args.execute:
        print("\n📋 DRY RUN — nothing was deleted.")
        print("Add --execute to actually remove these entries from ChromaDB.")
        return

    print(f"\n⚠️  Executing deletion of {len(orphans)} orphan(s) …")
    _delete_from_chroma(chroma_db_path, orphans)
    print("\n✅ Done. Orphaned entries removed from ChromaDB.")


if __name__ == "__main__":
    main()
