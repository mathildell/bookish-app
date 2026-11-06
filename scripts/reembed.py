#!/usr/bin/env python3
"""Re-embed all chunks in ChromaDB by reading from chroma.sqlite3 directly."""

import json
import sqlite3
import sys
import time
from pathlib import Path

# Ensure project root is on sys.path
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from backend.dependencies import init_services, get_settings


def main():
    prog_path = Path("/tmp/reembed_done.json")

    # Load resume state
    done_ids = set()
    if prog_path.exists():
        try:
            done_ids = set(json.loads(prog_path.read_text()))
            print(f"Resuming: {len(done_ids):,} chunks already embedded")
        except Exception as e:
            print(f"[WARN] Bad progress file: {e}, starting fresh")

    # Init settings (ChromaDB loads lazily here)
    init_services()
    settings = get_settings()
    elapsed_before_ollama = time.time() - _RUN_START

    # Get ALL chunk IDs from SQLite (fast once, skips ChromaDB overhead)
    print("Loading chunk IDs from chroma.sqlite3 …")
    db_path = str(Path(settings.chroma_db_path) / "chroma.sqlite3")
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT embedding_id FROM embeddings").fetchall()
    all_ids = [r[0] for r in rows]
    conn.close()
    total = len(all_ids)

    # Filter out already-done IDs
    remaining = [i for i in all_ids if i not in done_ids]
    print(f"Total chunks: {total:,}")
    print(f"Remaining to embed: {len(remaining):,}")
    if not remaining:
        prog_path.unlink(missing_ok=True)
        return

    # Connect ChromaDB (lazy loaded on first request)
    import chromadb
    client = chromadb.PersistentClient(path=settings.chroma_db_path)
    col = client.get_collection("book_texts")

    # Connect Ollama embedder
    from ollama import Client
    ollama = Client(host=f"http://{settings.ollama_host}:{settings.ollama_port}")

    # Warm up Ollama connection
    print("Warming up Ollama …")
    try:
        ollama.embed(model=settings.embedding_model, input="test warmup query")
    except Exception as exc:
        print(f"[FATAL] Can't reach Ollama for embedding: {exc}")
        return

    # Main loop
    batch_size = 500      # chunks per ChromaDB fetch + upsert round
    emb_per_call = 200   # texts per Ollama embed request (works ~4-6s/call)
    errors = 0

    for start in range(0, len(remaining), batch_size):
        t_start = time.time()
        batch_ids = remaining[start:start + batch_size]

        # Fetch documents + metadata for this batch of IDs
        try:
            result = col.get(ids=batch_ids, include=["documents", "metadatas"])
        except Exception as exc:
            print(f"\n[ERR] ChromaDB get failed for batch starting at {start}: {exc}")
            break

        if not result or not result.get("ids"):
            for iid in batch_ids:
                done_ids.add(iid)
            prog_path.write_text(json.dumps(list(done_ids)))
            continue

        fetched_docs = {}
        fetched_ids_ = set(result["ids"])
        for tid, doc, meta in zip(result["ids"], result.get("documents") or [], result.get("metadatas") or []):
            if doc:
                fetched_docs[tid] = (doc, meta)

        # Build ordered lists for embedding/upserting — only chunks that have documents
        to_embed_ids = []
        to_embed_texts = []
        to_embed_metas = []

        for iid in batch_ids:
            if iid not in fetched_docs:
                done_ids.add(iid)
                continue
            doc, meta = fetched_docs[iid]
            to_embed_ids.append(iid)
            to_embed_texts.append(doc)
            to_embed_metas.append(meta or {})

        if not to_embed_ids:
            prog_path.write_text(json.dumps(list(done_ids)))
            continue

        # Embed via Ollama in sub-batches
        all_embeddings = []
        for es in range(0, len(to_embed_texts), emb_per_call):
            sub_texts = to_embed_texts[es:es + emb_per_call]
            try:
                resp = ollama.embed(model=settings.embedding_model, input=sub_texts)
                all_embeddings.extend(resp["embeddings"])
            except Exception as exc:
                errors += len(sub_texts)
                print(f"\n  [embed err] {start+es}: {exc}")
                for _ in sub_texts:
                    all_embeddings.append([0.0] * 768)

        # Upsert vectors back into ChromaDB
        try:
            col.upsert(
                ids=to_embed_ids,
                embeddings=all_embeddings,
                documents=to_embed_texts,
                metadatas=to_embed_metas if any(to_embed_metas) else None,
            )
        except Exception as exc:
            print(f"\n[ERR] ChromaDB upsert failed for {len(to_embed_ids)} chunks: {exc}")
            break

        # Mark done and save progress
        for iid in to_embed_ids:
            done_ids.add(iid)
        prog_path.write_text(json.dumps(list(done_ids)))

        processed_so_far = start + batch_size
        elapsed_total = time.time() - _RUN_START  # includes init_services startup
        avg_rate = processed_so_far / elapsed_total if elapsed_total > 0 else 0
        eta_seconds = (len(remaining) - processed_so_far) / avg_rate if avg_rate > 0 else float("inf")

        print(
            f"\r[{processed_so_far:>7,}/{len(remaining):,}] {100 * processed_so_far / len(remaining):.1f}%  "
            f"rate={avg_rate:.0f}/s  ETA={eta_seconds / 60:.0f}m  err={errors}",
            end="", flush=True,
        )

    print(f"\nDone! {len(done_ids):,}/{total:,} chunks embedded ({errors} errors)")


# Track total runtime from script start (includes init_services + SQLite loading)
_RUN_START = time.time()

if __name__ == "__main__":
    main()
