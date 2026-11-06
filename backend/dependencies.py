"""Application-wide singleton dependencies."""

import json
import os
import sqlite3
import yaml
from pathlib import Path

from lib.models import AppSettings
from lib.calibre_reader import CalibreReader
from lib.obsidian_writer import ObsidianWriter


# --------------------------------------------------------------------------- #
# Globals                                                                     #
# --------------------------------------------------------------------------- #

_settings: AppSettings | None = None
_reader: CalibreReader | None = None
_writer: ObsidianWriter | None = None
_ingestor = None  # imported lazily below
_chat_engine = None
_indexed_ids: set[int] = set()
_chroma_ok: bool = False


# --------------------------------------------------------------------------- #
# Path helpers                                                                #
# --------------------------------------------------------------------------- #

def _resolve_path(raw: str, root: Path) -> Path:
    p = Path(raw).expanduser()
    return p.resolve() if p.is_absolute() else (root / raw).resolve()


def _indexed_cache_path() -> Path:
    return Path("/Users/neo/Development/perso/BookishApp/data/indexed_ids.cache")


# --------------------------------------------------------------------------- #
# Indexed-ID loading                                                          #
# --------------------------------------------------------------------------- #

def _load_cached_indexed_ids() -> set[int] | None:
    path = _indexed_cache_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return {int(x) for x in data.get("ids", [])}
    except Exception:
        return None


def _save_cached_indexed_ids(ids: set[int]):
    path = _indexed_cache_path()
    try:
        path.write_text(json.dumps({"ids": sorted(ids)}))
    except Exception:
        pass


def _recover_indexed_ids_from_sqlite(chroma_path: str) -> set[int] | None:
    sqlite_db = os.path.join(chroma_path, "chroma.sqlite3")
    if not os.path.exists(sqlite_db):
        return None
    try:
        conn = sqlite3.connect(sqlite_db)
        rows = conn.execute(
            "SELECT DISTINCT em.int_value FROM embedding_metadata em "
            "WHERE em.key = '_cid'"
        ).fetchall()
        conn.close()
        cids = {int(r[0]) for r in rows}
        if cids:
            _save_cached_indexed_ids(cids)
        return cids
    except Exception as exc:
        print(f"    [WARNING] SQLite fallback also failed: {exc}")
        return None


# --------------------------------------------------------------------------- #
# Settings loading                                                           #
# --------------------------------------------------------------------------- #

def _load_settings_from_yaml() -> AppSettings:
    here = Path(__file__).resolve().parent.parent
    cfg_path = here / "config.yaml"
    if cfg_path.exists():
        with open(cfg_path) as f:
            data = yaml.safe_load(f) or {}
    else:
        data = {}

    a2 = data.get("app", {})
    o2 = data.get("ollama", {})
    ing = data.get("ingestion", {})

    vault_raw: str = a2.get("obsidian_vault_path", os.environ.get("OBSIDIAN_VAULT", "~/BookReviews/"))
    vault_path = _resolve_path(vault_raw, here)

    db_raw: str = a2.get("calibre_db_path", os.environ.get("CALIBRE_DB", "~/Documents/Books/metadata.db"))
    db_path = _resolve_path(db_raw, here)

    chroma_raw: str = a2.get("chroma_db_path", str(here / "data/chroma_db"))
    chroma_path = _resolve_path(chroma_raw, here)

    return AppSettings(
        calibre_db_path=str(db_path),
        obsidian_vault_path=str(vault_path),
        chroma_db_path=str(chroma_path),
        ollama_host=o2.get("host", "192.168.2.10"),
        ollama_port=int(o2.get("port", 11434)),
        chat_model=o2.get("chat_model", os.environ.get("CHAT_MODEL", "llama3.1:8b")),
        embedding_model=o2.get("embedding_model", os.environ.get("EMBED_MODEL", "nomic-embed-text-v2-moe")),
        chunk_size=int(ing.get("chunk_size", 600)),
        chunk_overlap=int(ing.get("chunk_overlap", 10)),
        top_k=int(ing.get("top_k", 8)),
        ignored_books=a2.get("ignored_books", []),
        genre_colors=a2.get("genre_colors", {}) or {},
    )


# --------------------------------------------------------------------------- #
# ChromaDB lazy initialisation                                               #
# --------------------------------------------------------------------------- #

_chroma_initialized: bool = False


def _ensure_chroma():
    """Load Ingestor + ChatEngine on first chat/index access, not at server start."""
    global _ingestor, _chat_engine, _chroma_ok, _indexed_ids, _chroma_initialized
    if _chroma_initialized:
        return

    from lib.ingestor import Ingestor as LazyIngestor
    from lib.chat import ChatEngine as LazyChatEngine

    try:
        _ingestor = LazyIngestor(_settings)  # type: ignore[arg-type]
        _chat_engine = LazyChatEngine(_settings)
        # Quick health probe via count — this forces Chromium to be loaded once
        _ingestor._collection.count()
        # Skip live indexed-ID refresh; cache is accurate enough and fast.
        _chroma_ok = True
        print(f"[INFO] ChromaDB ready for chat ({len(_indexed_ids)} cached indexed IDs)")
    except Exception as exc:
        print(f"[WARNING] ChromaDB unavailable on demand: {exc}")

    _chroma_initialized = True


# --------------------------------------------------------------------------- #
# Accessors                                                                  #
# --------------------------------------------------------------------------- #

def get_settings() -> AppSettings:
    return _settings  # type: ignore[return-value]

def get_reader():
    if _reader is None:
        raise RuntimeError("CalibreReader not initialized. Is the server running?")
    return _reader

def get_writer():
    return _writer  # type: ignore[return-value]

def get_ingestor():
    global _ingestor
    _ensure_chroma()
    return _ingestor

def get_chat_engine():
    global _chat_engine
    _ensure_chroma()
    return _chat_engine

def check_chroma_health():
    _ensure_chroma()
    return _chroma_ok

def get_indexed_ids():
    return _indexed_ids


def mark_indexed(calibre_ids):
    """Add book IDs to the indexed cache after a successful index.

    Updating in place avoids a full ChromaDB re-scan, which needs a DISTINCT over
    every embedding's metadata and takes tens of seconds on a large library.
    """
    global _indexed_ids
    _indexed_ids = _indexed_ids | {int(cid) for cid in calibre_ids}
    _save_cached_indexed_ids(_indexed_ids)


def mark_unindexed(calibre_ids):
    """Drop book IDs from the indexed cache after they are removed."""
    global _indexed_ids
    _indexed_ids = _indexed_ids - {int(cid) for cid in calibre_ids}
    _save_cached_indexed_ids(_indexed_ids)


def refresh_indexed_cache():
    """Re-read indexed book IDs from ChromaDB and update cache."""
    global _indexed_ids
    try:
        ingestor = get_ingestor()
        if not ingestor:
            return
        ids = ingestor.get_all_indexed_ids()
        if ids is not None:
            _indexed_ids = ids
            _save_cached_indexed_ids(_indexed_ids)
    except Exception as exc:
        print(f"[WARNING] Failed to refresh indexed cache: {exc}")



# --------------------------------------------------------------------------- #
# Lifecycle                                                                  #
# --------------------------------------------------------------------------- #

def init_services():
    global _settings, _reader, _writer, _indexed_ids, _chroma_ok
    _settings = _load_settings_from_yaml()
    _chroma_ok = False

    # Calibre DB — critical, fail fast if missing
    try:
        _reader = CalibreReader(_settings.calibre_db_path)
    except Exception as exc:
        print(f"[WARNING] Could not connect to Calibre DB: {exc}")
        _reader = None

    _writer = ObsidianWriter(_settings.obsidian_vault_path)

    # Indexed IDs — fast path. Load from cache or SQLite, never block on ChromaDB.
    try:
        cached = _load_cached_indexed_ids()
        if cached:
            _indexed_ids = cached
            print(f"[INFO] Loaded {len(_indexed_ids)} indexed IDs from cache")
            return

        print("[INFO] No index cache — reading chroma.sqlite3 directly (~30s)")
        recovered = _recover_indexed_ids_from_sqlite(_settings.chroma_db_path)
        if recovered:
            _indexed_ids = recovered
            print(f"[INFO] Recovered {len(_indexed_ids)} indexed IDs from SQLite")
    except Exception as exc:
        print(f"[WARNING] Failed to load indexed IDs: {exc}")

def shutdown_services():
    global _reader
    if _reader:
        try:
            _reader.close()
        except Exception:
            pass
