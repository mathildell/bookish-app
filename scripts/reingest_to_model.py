#!/usr/bin/env python3
"""Re-ingest the library from the EPUBs into a separate index, with another
embedding model and (optionally) a larger chunk size.

The cheaper migration, scripts/reembed_to_model.py, copies the *existing* chunks
out of the old index and only re-embeds them. That is the right tool when the
text boxes are the ones you want. This script goes back to the EPUBs instead, so
the chunk boundaries can change too — which is the only way to give the new model
more text per chunk than the old index ever had.

Why you might want that: nomic-embed-text-v2-moe truncates at 512 tokens, while
the library was chunked at 600 tokens (2,400 chars), so the tail of every full
chunk was never embedded by it. qwen3-embedding:8b takes 32k tokens, so nothing
is cut off, and bigger chunks put more story in front of the chat model per hit.

    # trial: 3 books into a throwaway index first
    .venv/bin/python scripts/reingest_to_model.py \\
        --model qwen3-embedding:8b --chunk-size 1000 --limit 3

    # the real run, resumed by re-running the same command — a resumed run picks
    # up at the first book missing from the target, so it can also move to a
    # different Ollama box partway through
    .venv/bin/python scripts/reingest_to_model.py \\
        --model qwen3-embedding:8b --chunk-size 1000
    .venv/bin/python scripts/reingest_to_model.py \\
        --model qwen3-embedding:8b --chunk-size 1000 --host 192.168.2.43

When it finishes, set both, then restart the backend:
    app.chroma_db_path     -> the --to-path directory
    ollama.embedding_model -> the --model used here
    ingestion.chunk_size   -> the --chunk-size used here

Resume-safe: books already in the target index are skipped, so an interrupted
run continues where it stopped.
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

# Run under the project venv whatever the shebang resolved to: this needs chromadb,
# ebooklib and the ollama client, which only exist there. Compared via sys.prefix,
# because .venv/bin/python is a symlink to the base interpreter.
_VENV_DIR = PROJECT_ROOT / ".venv"
_VENV_PYTHON = _VENV_DIR / "bin" / "python"
if _VENV_PYTHON.exists() and Path(sys.prefix).resolve() != _VENV_DIR.resolve():
    os.execv(str(_VENV_PYTHON), [str(_VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]])

sys.path.insert(0, str(PROJECT_ROOT))

from lib.calibre_reader import CalibreReader  # noqa: E402
from lib.ingestor import Ingestor  # noqa: E402
from lib.models import AppSettings  # noqa: E402


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


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


def _fmt_eta(seconds: float) -> str:
    if seconds != seconds or seconds in (float("inf"), 0):
        return "?"
    hours, rem = divmod(int(seconds), 3600)
    return f"{hours}h{rem // 60:02d}m"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Re-ingest EPUBs into a separate index with another model/chunk size.",
    )
    ap.add_argument("--model", help="embedding model (default: config ollama.embedding_model)")
    ap.add_argument("--chunk-size", type=int, help="tokens per chunk (default: config ingestion.chunk_size)")
    ap.add_argument("--overlap", type=int, help="overlap percent (default: config ingestion.chunk_overlap)")
    ap.add_argument("--to-path", help="target ChromaDB dir (default: derived from model + chunk size)")
    ap.add_argument("--host", help="Ollama host to embed on (default: config ollama.host)")
    ap.add_argument("--port", type=int, help="Ollama port (default: config ollama.port)")
    ap.add_argument("--limit", type=int, help="only do N books (trial run)")
    args = ap.parse_args()

    cfg = _config()
    o = cfg.get("ollama") or {}
    a = cfg.get("app") or {}
    ing = cfg.get("ingestion") or {}

    model = args.model or o.get("embedding_model") or "nomic-embed-text-v2-moe"
    chunk_size = args.chunk_size or int(ing.get("chunk_size", 600))
    overlap = args.overlap if args.overlap is not None else int(ing.get("chunk_overlap", 10))
    source_path = _resolve(a.get("chroma_db_path") or "data/chroma_db")
    target_path = (
        Path(args.to_path) if args.to_path
        else Path(f"{source_path}_{_slug(model)}_c{chunk_size}")
    )

    if target_path.resolve() == source_path.resolve():
        print(f"❌  target is the live index ({target_path}); pick another --to-path")
        return 1
    if not a.get("calibre_db_path"):
        print("❌  config.yaml has no app.calibre_db_path")
        return 1
    target_path.mkdir(parents=True, exist_ok=True)

    settings = AppSettings(
        calibre_db_path=str(_resolve(a["calibre_db_path"])),
        obsidian_vault_path=str(_resolve(a.get("obsidian_vault_path") or "data/reviews")),
        chroma_db_path=str(target_path),
        ollama_host=args.host or o.get("host", "192.168.2.10"),
        ollama_port=args.port or int(o.get("port", 11434)),
        chat_model=o.get("chat_model", ""),
        extraction_model=o.get("extraction_model", ""),
        writing_model=o.get("writing_model", ""),
        embedding_model=model,
        chunk_size=chunk_size,
        chunk_overlap=overlap,
        top_k=int(ing.get("top_k", 8)),
        ignored_books=list(a.get("ignored_books") or []),
        genre_colors=dict(a.get("genre_colors") or {}),
    )

    print(f"Calibre : {settings.calibre_db_path}")
    print(f"Target  : {target_path}")
    print(f"Model   : {model}  ({settings.ollama_base_url})")
    print(f"Chunks  : {chunk_size} tokens (~{chunk_size * 4} chars), {overlap}% overlap")
    print("Reading the Calibre database …", flush=True)

    reader = CalibreReader(settings.calibre_db_path)
    ingestor = Ingestor(settings)

    ignored = [t.lower() for t in settings.ignored_books if t]
    # Ids first, records lazily: assembling 2,700 BookRecords up front stalls for
    # minutes before the first book is touched, and a resumed run pays it again
    # every time.
    all_ids = [r["id"] for r in reader._exec("SELECT id FROM books ORDER BY id").fetchall()]
    already = ingestor.get_all_indexed_ids()
    todo = [cid for cid in all_ids if cid not in already]
    if args.limit:
        todo = todo[: args.limit]

    print(f"Books in Calibre  : {len(all_ids):,}")
    print(f"Already in target : {len(already):,}")
    print(f"To ingest         : {len(todo):,}" + (f"  (limit {args.limit})" if args.limit else ""))
    if not todo:
        print("✅  nothing to do")
        reader.close()
        return 0

    ok = failed = skipped = 0
    started = time.time()

    for index, cid in enumerate(todo, start=1):
        book = reader.get_book_by_id(cid)
        if not book or not book.epub_path or not os.path.exists(book.epub_path):
            skipped += 1
            print(f"  [{index:>5}/{len(todo)}] SKIP {cid:>6}  (no readable EPUB)")
            sys.stdout.flush()
            continue
        if any(pattern in (book.title or "").lower() for pattern in ignored):
            skipped += 1
            continue

        last_step = ""

        def _cb(progress):
            nonlocal last_step
            last_step = f"ERROR: {progress.error}" if progress.error else progress.current_step

        t0 = time.time()
        try:
            success = ingestor.index_book(book, progress_callback=_cb)
        except KeyboardInterrupt:
            print("\n\nInterrupted — re-run the same command to continue.")
            reader.close()
            return 130
        except Exception as exc:
            print(f"  [{index}/{len(todo)}] FAIL {book.calibre_id} {exc}")
            failed += 1
            continue

        elapsed = time.time() - started
        eta = (elapsed / index) * (len(todo) - index)
        took = time.time() - t0
        if success:
            ok += 1
            print(
                f"  [{index:>5}/{len(todo)}] OK   {took:5.1f}s  ETA {_fmt_eta(eta):>7}  "
                f"{book.calibre_id:>6}  {book.title[:52]}"
            )
        else:
            failed += 1
            print(
                f"  [{index:>5}/{len(todo)}] FAIL {took:5.1f}s  ETA {_fmt_eta(eta):>7}  "
                f"{book.calibre_id:>6}  {book.title[:40]}  {last_step[:28]}"
            )
        sys.stdout.flush()

    total_chunks = ingestor._collection.count()
    print()
    print(f"Ingested {ok:,} books ({failed:,} failed, {skipped:,} skipped) in {_fmt_eta(time.time() - started)}")
    print(f"Target holds {total_chunks:,} chunks at {chunk_size} tokens/chunk")
    if failed:
        print("⚠️  re-run the same command to retry the failures")
        return 1
    if not args.limit:
        print()
        print("Next, in Settings (or config.yaml), then restart the backend:")
        print(f"    app.chroma_db_path     = {target_path}")
        print(f"    ollama.embedding_model = {model}")
        print(f"    ingestion.chunk_size   = {chunk_size}")
    reader.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted. Run the same command again to resume.")
        raise SystemExit(130)
