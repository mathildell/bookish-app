#!/usr/bin/env python3
"""Diagnostic: check if ChromaDB chunks have zeroed-out embeddings via the official API."""

import math
import numpy as np
import sys
from pathlib import Path

# Ensure project root is on sys.path
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

import chromadb

db_path = str(Path("data/chroma_db").absolute())
print(f"Opening ChromaDB at {db_path}...")

client = chromadb.PersistentClient(path=db_path)
collection = client.get_collection("book_texts")

total = collection.count()
print(f"Total chunks in collection: {total:,}\n")

# Fetch a large sample of embeddings and check norms
SAMPLE_SIZE = 10000
results = collection.get(limit=SAMPLE_SIZE, include=["embeddings"])

res_embeddings = results.get("embeddings")
if res_embeddings is None or len(res_embeddings) == 0:
    print("⚠️ Got no embeddings from the collection. This is unexpected.")
    sys.exit(1)

ids = results["ids"]

# Compute norms using numpy (vectorized, much faster)
norms_array = res_embeddings  # shape: (n_samples, 768)
vec_norms = np.linalg.norm(norms_array, axis=1)  # shape: (n_samples,)

zero_mask = vec_norms < 0.01
zero_count = int(np.sum(zero_mask))
valid_count = len(vec_norms) - zero_count

sampled = len(vec_norms)
print(f"Sampled {sampled:,} embeddings:")
print(f"  Valid (norm > 0.01):         {valid_count}")
print(f"  Zeroed-out (norm ~0):        {zero_count}")

if sampled > 0:
    print(f"\n  Norm range:              [{float(vec_norms.min()):.4f}, {float(vec_norms.max()):.4f}]")
    print(f"  Median norm:             {float(np.median(vec_norms)):.4f}")
    print(f"  Mean norm:               {float(vec_norms.mean()):.4f}")

# nomic-embed-text normalizes to unit vectors, so norms should be ~1.0
if zero_count > 0:
    print(f"\n⚠️ You have at least {zero_count} zeroed-out embeddings in the sample.")
    est_zero_total = round(zero_count / sampled * total)
    print(f"   Estimated total zeroed across all {total:,} chunks: ~{est_zero_total:,}")
    print("   These are fallback placeholders from reembed.py errors.")
else:
    print("\n✅ All sampled embeddings look valid. No obvious issues found.")
