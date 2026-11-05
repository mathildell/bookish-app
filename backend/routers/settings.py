"""Settings read/write endpoints."""

from pathlib import Path
from fastapi import APIRouter
from dataclasses import asdict

import yaml

from backend import dependencies as deps
from backend.schemas import AppSettingsResponse, AppSettingsUpdate


router = APIRouter()


def _genre_categories() -> list[str]:
    """Main genre categories in the library ("Fantasy" from "Fantasy.Dark")."""
    try:
        reader = deps.get_reader()
    except RuntimeError:
        return []

    categories: set[str] = set()
    for book in reader.get_all_books():
        for genre in (book.genres or []):
            category = genre.split(".", 1)[0].strip()
            if category:
                categories.add(category)
    return sorted(categories)


@router.get("/settings", response_model=AppSettingsResponse)
async def read_settings():
    data = asdict(deps.get_settings())
    data["genre_categories"] = _genre_categories()
    return data


@router.put("/settings")
async def update_settings(update: AppSettingsUpdate):
    """Update settings and re-initialize services."""
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
    deps.shutdown_services()
    deps.init_services()

    return {"ok": True, "message": "Settings updated and services re-initialized"}
