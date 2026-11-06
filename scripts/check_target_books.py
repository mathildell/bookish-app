#!/usr/bin/env python3
"""Check that the 6 previously-zeroed books now have valid embeddings."""

import numpy as np
import sys
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

import chromadb

client = chromadb.PersistentClient(path='data/chroma_db')
col = client.get_collection('book_texts')

CALIBRE_IDS = [985, 986, 987, 988, 2663, 2664]

total_checked = 0
zero_found = 0

for cid in CALIBRE_IDS:
    result = col.get(where={"_cid": cid}, include=['embeddings'])
    ids_list = result.get('ids')
    chunks = len(ids_list) if ids_list is not None else 0
    
    res_emb = result.get('embeddings')
    if res_emb is None or len(res_emb) == 0:
        print(f"  Book {cid}: {chunks} chunks — no embeddings data")
        continue

    vecs = np.array(res_emb)
    norms = np.linalg.norm(vecs, axis=1)
    zeros_in_book = int(np.sum(norms < 0.01))
    
    total_checked += len(vecs)
    zero_found += zeros_in_book
    
    status = "HAS ZEROS" if zeros_in_book else "OK"
    print(f"  Book {cid}: {len(vecs)} chunks, norm range [{norms.min():.4f}, {norms.max():.4f}] {status}")

print(f"\nTotal checked: {total_checked:,} | Total zeroed: {zero_found}")
if zero_found == 0:
    print("All 6 previously-affected books are clean!")
else:
    print(f"Still {zero_found} zeroed embeddings found.")
