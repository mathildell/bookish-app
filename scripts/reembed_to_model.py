#!/usr/bin/env python3
"""Re-embed the whole library with a different model, into a separate index.

ChromaDB fixes a collection's vector size when it is first written, so 4096-dim
vectors from qwen3-embedding:8b cannot be added to a collection built at 768 dims
by nomic-embed-text-v2-moe. The only way across is to write the vectors again
somewhere else.

So this builds a *second* ChromaDB directory rather than rewriting the live one:

  * documents and metadata are copied straight out of the existing collection —
    the EPUBs are not re-parsed, so this is pure embedding work;
  * the running app keeps reading the old index, unchanged, for the whole run;
  * switching over is a one-line settings change once the new index is complete
    (see "When it finishes" below).

Interrupting is safe: anything already written to the target is skipped on the
next run.

    # ~10 h for 580k chunks at the ~16 chunks/s measured on 192.168.2.10
    .venv/bin/python scripts/reembed_to_model.py --model qwen3-embedding:8b

    # land it somewhere specific, or re-embed only a slice while testing
    .venv/bin/python scripts/reembed_to_model.py --model qwen3-embedding:8b \\
        --to-path data/chroma_qwen3 --limit 5000

When it finishes, set both of these (Settings page or config.yaml), then restart:
    app.chroma_db_path     -> the --to-path directory above
    ollama.embedding_model -> qwen3-embedding:8b
They only work as a pair: the new directory holds 4096-dim vectors, so queries
must be embedded with the model that produced them.

This deliberately reads config.yaml itself instead of importing the app: the
migration should not depend on the backend's import graph (or on the backend
being healthy) while it rebuilds the index underneath it.

Note: the embedder shares the GPU with the chat model. Chatting during the run
works, but the two take turns on the card, so both get slower.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.yaml"

# Run under the project venv whatever the shebang resolved to: chromadb and the
# ollama client only exist there, and a bare ModuleNotFoundError from a 10-hour
# migration is a bad way to learn that.
# Compare sys.prefix, not sys.executable: .venv/bin/python is a symlink to the
# base interpreter, so both resolve to the same file and a path comparison always
# says "already in the venv".
_VENV_DIR = PROJECT_ROOT / ".venv"
_VENV_PYTHON = _VENV_DIR / "bin" / "python"
if _VENV_PYTHON.exists() and Path(sys.prefix).resolve() != _VENV_DIR.resolve():
    os.execv(str(_VENV_PYTHON), [str(_VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]])

COLLECTION = "book_texts"
ID_PAGE = 5000          # ids fetched per resume check
SOURCE_PAGE = 2000      # documents fetched from the source per round


def _slug(model: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", model.lower()).strip("_")


def _config() -> dict:
    import yaml

    try:
        with open(CONFIG_PATH) as fh:
            return yaml.safe_load(fh) or {}
    except FileNotFoundError:
        return {}


def _resolve(raw: str) -> Path:
    path = Path(os.path.expanduser(str(raw)))
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


def _existing_ids(col) -> set[str]:
    """All ids already in the target, so a restart resumes instead of redoing work."""
    ids: set[str] = set()
    offset = 0
    while True:
        try:
            page = col.get(limit=ID_PAGE, offset=offset, include=[])
        except Exception:
            page = col.get(limit=ID_PAGE, offset=offset)
        batch = page.get("ids") or []
        if not batch:
            return ids
        ids.update(batch)
        offset += len(batch)


def _fmt_eta(seconds: float) -> str:
    if seconds != seconds or seconds in (float("inf"), 0):
        return "?"
    hours, rem = divmod(int(seconds), 3600)
    return f"{hours}h{rem // 60:02d}m"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Re-embed the library with another model into a separate index.",
    )
    ap.add_argument("--model", help="embedding model to use (default: the configured one)")
    ap.add_argument("--from-path", help="source ChromaDB dir (default: app.chroma_db_path)")
    ap.add_argument("--to-path", help="target dir (default: <chroma_db_path>_<model>)")
    ap.add_argument("--batch", type=int, default=128, help="texts per embed request (default 128)")
    ap.add_argument("--limit", type=int, help="stop after N chunks (for a trial run)")
    ap.add_argument("--from-collection", default=COLLECTION)
    args = ap.parse_args()

    cfg = _config()
    ollama_cfg = cfg.get("ollama") or {}
    app_cfg = cfg.get("app") or {}

    model = args.model or ollama_cfg.get("embedding_model") or "nomic-embed-text-v2-moe"
    source_path = (
        Path(args.from_path) if args.from_path
        else _resolve(app_cfg.get("chroma_db_path") or "data/chroma_db")
    )
    target_path = Path(args.to_path) if args.to_path else Path(f"{source_path}_{_slug(model)}")
    base_url = f"http://{ollama_cfg.get('host', '192.168.2.10')}:{ollama_cfg.get('port', 11434)}"

    if not source_path.exists():
        print(f"❌  source index not found: {source_path}")
        return 1
    if target_path.resolve() == source_path.resolve():
        print(f"❌  target is the source ({target_path}); pick another --to-path")
        return 1
    target_path.mkdir(parents=True, exist_ok=True)

    import chromadb
    from ollama import Client

    try:
        source = chromadb.PersistentClient(path=str(source_path)).get_collection(
            args.from_collection
        )
    except Exception as exc:
        print(f"❌  cannot open {args.from_collection!r} in {source_path}: {exc}")
        return 1

    total = source.count()
    if not total:
        print(f"❌  {args.from_collection!r} in {source_path} is empty")
        return 1

    ollama = Client(host=base_url)
    print("Warming up the embedder …", end="", flush=True)
    try:
        warm = ollama.embed(model=model, input="warmup")
    except Exception as exc:
        print(f"\n❌  can't embed with {model!r}: {exc}")
        return 1
    dim = len(warm["embeddings"][0])
    print(f" {dim} dimensions")

    # Vector size and distance function are fixed when the collection is created —
    # ChromaDB refuses to change either afterwards, so both are recorded here at
    # creation time instead of through a modify() call.
    client = chromadb.PersistentClient(path=str(target_path))
    try:
        target = client.get_collection(args.from_collection)
        print(f"Resuming: {target.count():,} chunks already in {target_path}")
    except Exception:
        target = client.create_collection(
            name=args.from_collection,
            metadata={
                "hnsw:space": "cosine",
                "embedding_model": model,
                "embedding_dim": dim,
            },
        )

    done = _existing_ids(target)
    remaining = total - len(done)
    print(f"Source : {total:,} chunks in {source_path}")
    print(f"Target : {target_path}")
    print(f"Model  : {model}  ({base_url})")
    print(f"To do  : {remaining:,} chunks" + (f"  (limit {args.limit:,})" if args.limit else ""))
    if not remaining and not args.limit:
        print("✅  already complete — nothing to do")
        return 0

    processed = skipped = errors = 0
    started = time.time()
    offset = 0
    stop = False

    while not stop:
        page = source.get(limit=SOURCE_PAGE, offset=offset, include=["documents", "metadatas"])
        ids = page.get("ids") or []
        if not ids:
            break
        offset += len(ids)
        docs = page.get("documents") or [None] * len(ids)
        metas = page.get("metadatas") or [None] * len(ids)

        for start in range(0, len(ids), args.batch):
            slice_ids = ids[start:start + args.batch]
            slice_docs = docs[start:start + args.batch]
            slice_metas = metas[start:start + args.batch]

            keep = [
                (i, d, m)
                for i, d, m in zip(slice_ids, slice_docs, slice_metas)
                if i not in done and d
            ]
            if args.limit:
                room = args.limit - processed
                if room <= 0:
                    stop = True
                    break
                # A trial run should stop exactly at --limit, not overshoot by
                # whatever the batch size happens to be.
                keep = keep[:room]
            skipped += len(slice_ids) - len(keep)
            if not keep:
                continue

            try:
                vectors = ollama.embed(model=model, input=[d for _, d, _ in keep])["embeddings"]
            except Exception as exc:
                errors += len(keep)
                print(f"\n  [embed error, {len(keep)} chunks skipped] {exc}")
                continue

            try:
                target.upsert(
                    ids=[i for i, _, _ in keep],
                    embeddings=vectors,
                    documents=[d for _, d, _ in keep],
                    metadatas=[m or {} for _, _, m in keep],
                )
            except Exception as exc:
                errors += len(keep)
                print(f"\n  [upsert error, {len(keep)} chunks skipped] {exc}")
                continue

            done.update(i for i, _, _ in keep)
            processed += len(keep)

            elapsed = time.time() - started
            rate = processed / elapsed if elapsed > 0 else 0
            budget = args.limit or remaining
            left = budget - processed
            eta = left / rate if rate > 0 else float("inf")
            # Cap the shown count: a resumed run counts already-present ids as
            # skipped, which can push the total past the budget it is measured
            # against.
            seen = min(processed + skipped, budget)
            print(
                f"\r  {seen:>7,}/{budget:,}  {100 * seen / budget:5.1f}%  "
                f"{rate:5.1f} chunks/s  ETA {_fmt_eta(eta)}  errors={errors}",
                end="",
                flush=True,
            )

            if args.limit and processed >= args.limit:
                stop = True
                break

    print()
    print(f"Wrote {processed:,} chunks to {target_path}  (skipped {skipped:,}, errors {errors})")
    print(f"Target now holds {target.count():,} chunks at {dim} dims")
    if errors:
        print("⚠️  re-run the same command to retry the chunks that failed")
        return 1
    if target.count() >= total:
        print()
        print("Next, in Settings (or config.yaml), then restart the backend:")
        print(f"    app.chroma_db_path     = {target_path}")
        print(f"    ollama.embedding_model = {model}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
