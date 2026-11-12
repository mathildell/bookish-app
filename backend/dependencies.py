"""Application-wide singletons: settings, the Calibre reader and lazily-built engines.

Only the cheap services start with the server. ChromaDB, the chat engine and the
character extractor load on first use, so the library grid is up in seconds even
on a large index.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import HTTPException

from backend.storage import DATA_DIR, PROJECT_ROOT
from lib.calibre_reader import CalibreReader
from lib.models import AppSettings
from lib.obsidian_writer import ObsidianWriter
from lib.vector_store import indexed_ids_from_sqlite

logger = logging.getLogger(__name__)

CONFIG_PATH = PROJECT_ROOT / "config.yaml"
_INDEXED_CACHE_PATH = DATA_DIR / "indexed_ids.cache"


# --------------------------------------------------------------------------- #
# Globals                                                                     #
# --------------------------------------------------------------------------- #

_settings: Optional[AppSettings] = None
_reader: Optional[CalibreReader] = None
_writer: Optional[ObsidianWriter] = None
_ingestor = None
_chat_engine = None
_character_store = None
_character_extractor = None
_indexed_ids: set[int] = set()
_chroma_ok = False
_chroma_initialized = False
_chroma_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# config.yaml                                                                 #
# --------------------------------------------------------------------------- #

# section -> {yaml key: AppSettings attribute}. Used both to read and to write
# config.yaml, so the file layout is defined exactly once.
_CONFIG_LAYOUT: dict[str, dict[str, str]] = {
    "app": {
        "calibre_db_path": "calibre_db_path",
        "calibre_url": "calibre_url",
        "obsidian_vault_path": "obsidian_vault_path",
        "chroma_db_path": "chroma_db_path",
        "ignored_books": "ignored_books",
        "genre_colors": "genre_colors",
    },
    "ollama": {
        "host": "ollama_host",
        "port": "ollama_port",
        "chat_model": "chat_model",
        "extraction_model": "extraction_model",
        "writing_model": "writing_model",
        "embedding_model": "embedding_model",
    },
    "chat": {"num_ctx": "chat_num_ctx", "num_predict": "chat_num_predict"},
    "writing": {
        "temperature": "writing_temperature",
        "top_p": "writing_top_p",
        "num_predict": "writing_num_predict",
    },
    "ingestion": {
        "chunk_size": "chunk_size",
        "chunk_overlap": "chunk_overlap",
        "top_k": "top_k",
    },
}

# Environment variables consulted when config.yaml does not set the value.
_ENV_FALLBACKS = {
    "obsidian_vault_path": "OBSIDIAN_VAULT",
    "calibre_db_path": "CALIBRE_DB",
    "chat_model": "CHAT_MODEL",
    "embedding_model": "EMBED_MODEL",
}

_PATH_FIELDS = ("calibre_db_path", "obsidian_vault_path", "chroma_db_path")


def _resolve_path(raw: str) -> str:
    """Expand `~`; relative paths are taken from the project root."""
    p = Path(raw).expanduser()
    return str(p.resolve() if p.is_absolute() else (PROJECT_ROOT / raw).resolve())


def _coerce(value: Any, default: Any) -> Any:
    """Cast a YAML value to the type of the setting's default."""
    if isinstance(default, bool):
        return bool(value)
    if isinstance(default, (int, float)):
        return type(default)(value)
    if isinstance(default, str):
        return str(value)
    return value


def load_settings() -> AppSettings:
    """Build settings from defaults, then environment fallbacks, then config.yaml."""
    data: dict = {}
    if CONFIG_PATH.exists():
        data = yaml.safe_load(CONFIG_PATH.read_text()) or {}

    defaults = asdict(AppSettings())
    values = dict(defaults)
    # An unset extraction model follows the chat model (resolved below).
    values["extraction_model"] = ""
    for attr, env in _ENV_FALLBACKS.items():
        if env in os.environ:
            values[attr] = os.environ[env]

    for section, keys in _CONFIG_LAYOUT.items():
        block = data.get(section) or {}
        for key, attr in keys.items():
            if block.get(key) is not None:
                values[attr] = _coerce(block[key], defaults[attr])

    values["extraction_model"] = values["extraction_model"] or values["chat_model"]
    for attr in _PATH_FIELDS:
        values[attr] = _resolve_path(values[attr])
    return AppSettings(**values)


def save_settings(settings: AppSettings) -> None:
    """Write *settings* back to config.yaml in the layout `load_settings` reads."""
    dump = {
        section: {
            key: _copy(getattr(settings, attr)) for key, attr in keys.items()
        }
        for section, keys in _CONFIG_LAYOUT.items()
    }
    with open(CONFIG_PATH, "w") as f:
        yaml.dump(dump, f)


def _copy(value: Any) -> Any:
    """Plain list/dict copies, so YAML never emits anchors for shared objects."""
    if isinstance(value, list):
        return list(value)
    if isinstance(value, dict):
        return dict(value)
    return value


# --------------------------------------------------------------------------- #
# Indexed-ID cache                                                            #
# --------------------------------------------------------------------------- #
# Which books are indexed is needed for every library page, but asking ChromaDB
# takes tens of seconds on a large index. The answer is cached in a small JSON
# file and kept current by `mark_indexed` / `mark_unindexed`.

def _load_cached_indexed_ids() -> Optional[set[int]]:
    if not _INDEXED_CACHE_PATH.exists():
        return None
    try:
        data = json.loads(_INDEXED_CACHE_PATH.read_text())
        return {int(x) for x in data.get("ids", [])}
    except Exception:
        return None


def _save_cached_indexed_ids(ids: set[int]) -> None:
    try:
        _INDEXED_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _INDEXED_CACHE_PATH.write_text(json.dumps({"ids": sorted(ids)}))
    except Exception:
        pass


def _load_indexed_ids(chroma_path: str) -> set[int]:
    """Cache first; otherwise read chroma.sqlite3 directly and cache the result."""
    cached = _load_cached_indexed_ids()
    if cached:
        logger.info("Loaded %d indexed IDs from cache", len(cached))
        return cached

    logger.info("No index cache — reading chroma.sqlite3 directly (~30s)")
    try:
        recovered = indexed_ids_from_sqlite(chroma_path) or set()
    except Exception as exc:
        logger.warning("Could not read indexed IDs from SQLite: %s", exc)
        return set()
    if recovered:
        _save_cached_indexed_ids(recovered)
        logger.info("Recovered %d indexed IDs from SQLite", len(recovered))
    return recovered


def get_indexed_ids() -> set[int]:
    return _indexed_ids


def mark_indexed(calibre_ids) -> None:
    """Add book IDs to the indexed cache after a successful index."""
    global _indexed_ids
    _indexed_ids = _indexed_ids | {int(cid) for cid in calibre_ids}
    _save_cached_indexed_ids(_indexed_ids)


def mark_unindexed(calibre_ids) -> None:
    """Drop book IDs from the indexed cache after they are removed."""
    global _indexed_ids
    _indexed_ids = _indexed_ids - {int(cid) for cid in calibre_ids}
    _save_cached_indexed_ids(_indexed_ids)


# --------------------------------------------------------------------------- #
# ChromaDB-backed services (lazy)                                             #
# --------------------------------------------------------------------------- #

def _ensure_chroma() -> None:
    """Build the Ingestor and ChatEngine on first use, not at server start.

    Routes run in FastAPI's threadpool, so two requests can land here at once;
    the lock keeps the one-time ChromaDB setup single-threaded.
    """
    global _ingestor, _chat_engine, _chroma_ok, _chroma_initialized
    if _chroma_initialized:
        return

    with _chroma_lock:
        if _chroma_initialized:
            return

        from lib.chat import ChatEngine
        from lib.ingestor import Ingestor

        try:
            _ingestor = Ingestor(_settings)
            _chat_engine = ChatEngine(_settings)
            _ingestor.collection.count()  # health probe: forces the index to load
            _chroma_ok = True
            logger.info("ChromaDB ready (%d cached indexed IDs)", len(_indexed_ids))
        except Exception as exc:
            logger.warning("ChromaDB unavailable: %s", exc)

        _chroma_initialized = True


def check_chroma_health() -> bool:
    _ensure_chroma()
    return _chroma_ok


def get_ingestor():
    _ensure_chroma()
    return _ingestor


def get_chat_engine():
    _ensure_chroma()
    return _chat_engine


def get_character_extractor():
    """Extraction needs retrieval, so this pulls in ChromaDB and Ollama."""
    global _character_extractor
    engine = get_chat_engine()
    if engine is None:
        raise RuntimeError("Chat engine unavailable — check the vector index")
    if _character_extractor is None:
        from lib.character_extractor import CharacterExtractor

        _character_extractor = CharacterExtractor(_settings, engine)
    return _character_extractor


# --------------------------------------------------------------------------- #
# Other accessors                                                             #
# --------------------------------------------------------------------------- #

def get_settings() -> AppSettings:
    return _settings  # type: ignore[return-value]


def get_reader() -> Optional[CalibreReader]:
    """The Calibre reader, or None when metadata.db could not be opened."""
    return _reader


def require_reader() -> CalibreReader:
    """The Calibre reader, or a 503 for routes that cannot work without it."""
    if _reader is None:
        raise HTTPException(status_code=503, detail="Calibre library unavailable — check the database path in Settings")
    return _reader


def get_writer() -> ObsidianWriter:
    return _writer  # type: ignore[return-value]


def get_character_store():
    """Lazily open data/characters.db — no ChromaDB or Ollama needed."""
    global _character_store
    if _character_store is None:
        from lib.characters import CharacterStore

        _character_store = CharacterStore(DATA_DIR / "characters.db")
    return _character_store


# --------------------------------------------------------------------------- #
# Lifecycle                                                                   #
# --------------------------------------------------------------------------- #

def init_services() -> None:
    """(Re)load settings and reset every service built from them."""
    global _settings, _reader, _writer, _indexed_ids, _chroma_ok
    global _ingestor, _chat_engine, _chroma_initialized, _character_store, _character_extractor

    _settings = load_settings()

    # The engines capture the settings they were built with, so drop them on
    # re-init; otherwise a changed chat model would never reach Ollama.
    _ingestor = None
    _chat_engine = None
    _character_store = None
    _character_extractor = None
    _chroma_ok = False
    _chroma_initialized = False

    try:
        _reader = CalibreReader(_settings.calibre_db_path)
    except Exception as exc:
        logger.warning("Could not connect to Calibre DB: %s", exc)
        _reader = None

    _writer = ObsidianWriter(_settings.obsidian_vault_path)
    _indexed_ids = _load_indexed_ids(_settings.chroma_db_path)


def shutdown_services() -> None:
    if _reader:
        try:
            _reader.close()
        except Exception:
            pass
