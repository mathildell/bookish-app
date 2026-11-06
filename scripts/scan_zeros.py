#!/usr/bin/env python3
"""Deep scan for zeroed-out embeddings."""

import numpy as np
import sys
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

import chromadb

client = chromadb.PersistentClient(path='data/chroma_db')
col = client.get_collection('book_texts')
total = col.count()
print(f"Total chunks: {total:,}\n")

SCAN_BATCH = 25000
scanned = 0
zero_ids = []

print("Scanning entire collection in batches...")
offset = 0
while offset < total:
    batch = col.get(limit=SCAN_BATCH, offset=offset, include=['embeddings'])
    if not batch or not batch['ids']:
        break
    vecs = np.array(batch['embeddings'])
    norms = np.linalg.norm(vecs, axis=1)

    zeros_in_batch = np.where(norms < 0.01)[0]
    for idx in zeros_in_batch:
        zero_ids.append(batch['ids'][idx])

    scanned += SCAN_BATCH
    pct = min(100 * scanned / total, 100)
    print(f"\r  [{scanned:>7,}/{total:,}] {pct:.1f}%  zeros_found={len(zero_ids)}", end="", flush=True)
    offset += SCAN_BATCH

print(f"\n\nDone. Scanned all {scanned:,}/{total:,} chunks.")
if zero_ids:
    print(f"\n❌ Found {len(zero_ids)} zeroed-out chunk IDs:")
    for zid in zero_ids[:20]:
        print(f"  {zid}")
    if len(zero_ids) > 20:
        print(f"  ... and {len(zero_ids)-20} more")
    # Show which books they belong to
    book_ids = set()
    for zid in zero_ids:
        calibre_id = '_'.join(zid.split('_')[:-1])
        book_ids.add(calibre_id)
    print(f"\n  Affected Calibre book IDs ({len(book_ids)}): {', '.join(sorted(book_ids))}")
else:
    print("\n✅ No zeroed-out embeddings found in the entire collection!")
