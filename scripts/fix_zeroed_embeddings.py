#!/usr/bin/env python3
"""Fix the ~700 zeroed-out embeddings for books 985, 986, 987, 988, 2663, 2664."""

import sys
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from backend.dependencies import init_services, get_reader, get_ingestor

init_services()
reader = get_reader()
ingestor = get_ingestor()

CALIBRE_IDS = [985, 986, 987, 988, 2663, 2664]

for cid in CALIBRE_IDS:
    book = reader.get_book_by_id(cid)
    if not book:
        print(f"⚠️  Calibre ID {cid} not found — skipping.")
        continue

    print(f"\n🗑  Deleting old chunks for \"{book.title}\" (ID {cid})...")
    ingestor.delete_book(cid)

    print(f"📖 Re-indexing \"{book.title}\" ...")
    ok = ingestor.index_book(book)
    if ok:
        print("  ✅ Done.")
    else:
        print("  ⚠️  Index returned False — may have hit an error.")

print("\n✅ All done!")
