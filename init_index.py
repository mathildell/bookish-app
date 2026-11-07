#!/usr/bin/env python3
"""
One-shot init: index all Calibre books added before 2026-10-21, skipping
"Metadata helper" and any books without a readable EPUB.

Resume-safe: checks ChromaDB for already-indexed IDs and skips them.
Interrupt with Ctrl+C and rerun to continue where it left off.

Usage:
    cd BookishApp && source .venv/bin/activate && python init_index.py

All log output goes to stdout AND data/indexing.log.
"""

import os
import sys
import time
import logging
from pathlib import Path
from datetime import datetime

# ── paths ───────────────────────────────────────────────────────────────
HERE       = Path(__file__).resolve().parent
CHROMA_DIR = HERE / "data" / "chroma_db"
VAULT_DIR  = str(HERE / "data" / "reviews")
DB_PATH    = str(HERE / "data" / "calibre.db")

# ── logging (suppress noisy httpx / urllib3 lines) ──────────────────────
os.makedirs(HERE / "data", exist_ok=True)

for _n in ("httpx", "httpcore", "ollama", "urllib3"):
    try:
        _log = logging.getLogger(_n)
        _log.setLevel(logging.WARNING)
        _log.propagate = False
    except Exception:
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(HERE / "data" / "indexing.log", mode="w"),
    ],
)
log = logging.getLogger("init_index")

# ── project imports ────────────────────────────────────────────────────
sys.path.insert(0, str(HERE))
from lib.calibre_reader import CalibreReader          # noqa: E402
from lib.ingestor import Ingestor                     # noqa: E402
from lib.models import AppSettings                    # noqa: E402

CUTOFF = datetime(2026, 10, 21)


def main() -> None:
    log.info("=" * 72)
    log.info("INITIAL INDEX — books added before %s", CUTOFF.date())
    log.info("=" * 72)

    # ── settings (load YAML overrides if present) ────────────────────────
    settings = AppSettings(
        calibre_db_path=DB_PATH,
        obsidian_vault_path=VAULT_DIR,
        chroma_db_path=str(CHROMA_DIR),
        ollama_host="192.168.2.10",
        ollama_port=11434,
        chat_model=os.environ.get("CHAT_MODEL", "llama3.1:8b"),
        embedding_model=os.environ.get("EMBED_MODEL", "nomic-embed-text-v2-moe"),
        chunk_size=600,
        chunk_overlap=10,
        top_k=8,
        ignored_books=[],
        genre_colors={},
    )

    try:
        import yaml as _yaml
        cfg = HERE / "config.yaml"
        if cfg.exists():
            with open(cfg) as f:
                data = _yaml.safe_load(f) or {}
            ng = data.get("ingestion", {})
            settings.chunk_size     = int(ng.get("chunk_size",     settings.chunk_size))
            settings.chunk_overlap  = int(ng.get("chunk_overlap",  settings.chunk_overlap))
            settings.top_k          = int(ng.get("top_k",          settings.top_k))
    except Exception:
        pass

    reader   = CalibreReader(settings.calibre_db_path)
    ingestor = Ingestor(settings)

    # ── 1. candidate IDs (timestamp < cutoff, at DB level) ───────────────
    cutoff_iso = CUTOFF.isoformat()
    rows = reader._exec(
        "SELECT id FROM books WHERE timestamp IS NOT NULL AND timestamp < ?",
        (cutoff_iso,),
    ).fetchall()
    candidate_ids = sorted(r["id"] for r in rows)
    log.info("Candidate books (added before %s): %d", cutoff_iso, len(candidate_ids))

    # ── 2. drop "Metadata helper" and books tagged "graphic-novel" ────────
    def _title(bid: int) -> str:
        r = reader._exec("SELECT title FROM books WHERE id=?", (bid,)).fetchone()
        return r["title"] if r else ""

    no_helper = {
        bid for bid in candidate_ids
        if "metadata helper" not in _title(bid).lower().replace("-", " ")
    }
    skipped_helper = len(candidate_ids) - len(no_helper)

    # Exclude books with the "graphic-novel" Calibre tag (case-insensitive)
    gn_rows = reader._exec(
        """SELECT DISTINCT btl.book FROM books_tags_link btl
           JOIN tags t ON btl.tag = t.id
           WHERE LOWER(t.name) = 'graphic-novel'""",
    ).fetchall()
    graphic_ids = {r["book"] for r in gn_rows}

    filtered_ids = sorted(no_helper - graphic_ids)
    skipped_gn = len(no_helper) - len(filtered_ids)

    if skipped_helper:
        log.info("Excluded 'Metadata helper' variants: %d", skipped_helper)
    if skipped_gn:
        log.info("Excluded books tagged 'graphic-novel': %d", skipped_gn)

    # ── 3. resume check ─────────────────────────────────────────────────
    already_indexed = ingestor.get_all_indexed_ids() & set(filtered_ids)
    to_index = [bid for bid in filtered_ids if bid not in already_indexed]

    log.info("Already indexed: %d", len(already_indexed))
    log.info("To index:        %d", len(to_index))

    if not to_index:
        log.info("Nothing to do — all candidates already indexed.")
        reader.close()
        return

    # ── 4. index loop ───────────────────────────────────────────────────
    total      = len(to_index)
    ok_count   = 0
    skip_count = 0
    err_count  = 0
    start_ts   = time.time()

    for i, cid in enumerate(to_index):
        elapsed = time.time() - start_ts
        eta     = (elapsed / (i + 1)) * (total - i - 1) if i > 0 else 0

        rec = reader.get_book_by_id(cid)
        if not rec:
            log.info("[%3d/%3d] %5d  SKIP (not found) %.0fs left", i+1, total, cid, eta)
            skip_count += 1
            continue

        t0 = time.time()
        if not rec.epub_path or not os.path.exists(rec.epub_path):
            log.info(
                "[%3d/%3d] %5d  SKIP (no EPUB)   %.0fs left | %s",
                i+1, total, cid, eta, rec.title[:60])
            skip_count += 1
            continue

        t1 = time.time()
        last_step: str = ""

        def _cb(prog):
            nonlocal last_step
            last_step = f"ERROR: {prog.error}" if prog.error else prog.current_step

        success = ingestor.index_book(rec, progress_callback=_cb)
        took = round(time.time() - t1, 1)

        if success:
            ok_count += 1
            log.info(
                "[%3d/%3d] %5d  OK    %.1fs | ETA %.0fs | %s",
                i+1, total, cid, took, eta, rec.title[:60])
        else:
            err_count += 1
            log.info(
                "[%3d/%3d] %5d  FAIL  %.1fs | ETA %.0fs | %s | last=%s",
                i+1, total, cid, took, eta, rec.title[:45], last_step[:25])

    # ── 5. summary ─────────────────────────────────────────────────────
    total_time = time.time() - start_ts
    log.info("")
    log.info("=" * 72)
    log.info("DONE in %.0fs (avg %.1fs/book)", total_time, total_time / max(ok_count, 1))
    log.info("  OK:   %d", ok_count)
    log.info("  SKIP: %d", skip_count)
    log.info("  FAIL: %d", err_count)
    log.info("=" * 72)

    reader.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted. Run again to resume.")
        sys.exit(130)
