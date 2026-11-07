"""Settings read/write endpoints."""

from pathlib import Path
from fastapi import APIRouter
from dataclasses import asdict

import yaml

from backend import dependencies as deps
from backend.schemas import AppSettingsResponse, AppSettingsUpdate


router = APIRouter()

# Cached genre list. Assembling every book in the library to collect genres costs
# ~15 SQL queries per book, and with a network-mounted Calibre DB that is far too
# slow to do per request. The list only changes when the library or DB changes.
_genre_categories_cache: list[str] | None = None


def _genre_categories() -> list[str]:
    """Main genre categories in the library ("Fantasy" from "Fantasy.Dark")."""
    global _genre_categories_cache
    if _genre_categories_cache is not None:
        return _genre_categories_cache

    try:
        reader = deps.get_reader()
    except RuntimeError:
        return []

    # One query for the whole library instead of one per book.
    try:
        rows = reader._exec(
            "SELECT DISTINCT cv.value FROM custom_column_12 cv "
            "JOIN books_custom_column_12_link bcl ON cv.id = bcl.value"
        ).fetchall()
    except Exception:
        return []

    categories = sorted({
        category
        for category in (str(r["value"]).split(".", 1)[0].strip() for r in rows)
        if category
    })
    _genre_categories_cache = categories
    return categories


# Sync handlers: FastAPI runs these in its worker threadpool, so a slow SQLite or
# cover read no longer blocks the event loop (and every other request) for it.
@router.get("/settings", response_model=AppSettingsResponse)
def read_settings():
    data = asdict(deps.get_settings())
    data["genre_categories"] = _genre_categories()
    return data


@router.put("/settings")
def update_settings(update: AppSettingsUpdate):
    """Update settings and re-initialize services."""
    global _genre_categories_cache
    current = deps.get_settings()

    for key, value in update.model_dump(exclude_none=True).items():
        if value is not None:
            setattr(current, key, value)

    # Write to YAML
    here = Path(__file__).resolve().parent.parent.parent
    cfg_path = here / "config.yaml"
    dump_obj = {
        "app": {
            "calibre_db_path": current.calibre_db_path,
            "calibre_url": current.calibre_url,
            "obsidian_vault_path": current.obsidian_vault_path,
            "chroma_db_path": current.chroma_db_path,
            "ignored_books": list(current.ignored_books),
            "genre_colors": dict(current.genre_colors),
        },
        "ollama": {
            "host": current.ollama_host,
            "port": current.ollama_port,
            "chat_model": current.chat_model,
            "embedding_model": current.embedding_model,
        },
        "ingestion": {
            "chunk_size": current.chunk_size,
            "chunk_overlap": current.chunk_overlap,
            "top_k": current.top_k,
        },
    }
    with open(cfg_path, "w") as f:
        yaml.dump(dump_obj, f)

    # Re-init services (drops old connections)
    _genre_categories_cache = None
    deps.shutdown_services()
    deps.init_services()

    return {"ok": True, "message": "Settings updated and services re-initialized"}
