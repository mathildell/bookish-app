"""Application-wide singleton dependencies."""

import os
import yaml
from pathlib import Path

from lib.models import AppSettings
from lib.calibre_reader import CalibreReader
from lib.obsidian_writer import ObsidianWriter
from lib.ingestor import Ingestor
from lib.chat import ChatEngine


# --------------------------------------------------------------------------- #
# Settings loading                                                           #
# --------------------------------------------------------------------------- #

_settings: AppSettings | None = None
_reader: CalibreReader | None = None
_writer: ObsidianWriter | None = None
_ingestor: Ingestor | None = None
_chat_engine: ChatEngine | None = None
_indexed_ids: set[int] = set()


def _resolve_path(raw: str, root: Path) -> Path:
    """Handle ~/... and bare‑relative paths (anchor them to the project root)."""
    p = Path(raw).expanduser()
    return p.resolve() if p.is_absolute() else (root / raw).resolve()


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
    return _ingestor  # type: ignore[return-value]

def get_chat_engine():
    return _chat_engine  # type: ignore[return-value]

def refresh_indexed_cache():
    global _indexed_ids
    if _ingestor:
        _indexed_ids = _ingestor.get_all_indexed_ids()

def get_indexed_ids():
    return _indexed_ids


# --------------------------------------------------------------------------- #
# Lifecycle                                                                  #
# --------------------------------------------------------------------------- #

def init_services():
    global _settings, _reader, _writer, _ingestor, _chat_engine, _indexed_ids
    _settings = _load_settings_from_yaml()
    try:
        _reader = CalibreReader(_settings.calibre_db_path)
    except Exception as exc:
        print(f"[WARNING] Could not connect to Calibre DB: {exc}")
        _reader = None
    _writer = ObsidianWriter(_settings.obsidian_vault_path)
    _ingestor = Ingestor(_settings)
    _chat_engine = ChatEngine(_settings)
    refresh_indexed_cache()

def shutdown_services():
    global _reader
    if _reader:
        try:
            _reader.close()
        except Exception:
            pass
