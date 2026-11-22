"""Settings read/write endpoints, plus the Ollama model list for the pickers."""

import asyncio
from dataclasses import asdict

import httpx
from fastapi import APIRouter

from backend import dependencies as deps
from backend.schemas import AppSettingsResponse, AppSettingsUpdate

router = APIRouter()

# Cached genre categories. They only change with the library, and collecting them
# over a network-mounted Calibre DB is too slow to repeat per request.
_genre_categories_cache: list[str] | None = None


def _genre_categories() -> list[str]:
    """Main genre categories in the library ("Fantasy" from "Fantasy.Dark")."""
    global _genre_categories_cache
    if _genre_categories_cache is not None:
        return _genre_categories_cache

    reader = deps.get_reader()
    if reader is None:
        return []
    try:
        genres = reader.get_all_genres()
    except Exception:
        return []

    _genre_categories_cache = sorted(
        {g.split(".", 1)[0].strip() for g in genres} - {""}
    )
    return _genre_categories_cache


@router.get("/models")
def list_models():
    """Models installed on the configured Ollama host."""
    base_url = deps.get_settings().ollama_base_url
    try:
        from ollama import Client

        listed = Client(host=base_url, timeout=10.0).list()
    except Exception as exc:
        return {
            "models": [],
            "host": base_url,
            "error": f"Could not reach Ollama at {base_url} ({exc})",
        }

    models = sorted({
        str(m.get("model") or m.get("name") or "").strip()
        for m in (listed.get("models") or [])
    } - {""})
    return {"models": models, "host": base_url, "error": None}


# The pages gate their inputs on this, so it must answer quickly: a short probe
# beats waiting out a model call against a host that is switched off.
_OLLAMA_PROBE_TIMEOUT_S = 3.0


def _probe_ollama(base_url: str) -> dict:
    """One quick request; any HTTP answer at all means the host is reachable."""
    try:
        httpx.get(f"{base_url}/api/version", timeout=_OLLAMA_PROBE_TIMEOUT_S)
    except httpx.TimeoutException:
        return {
            "ok": False,
            "host": base_url,
            "error": f"no answer within {_OLLAMA_PROBE_TIMEOUT_S:g}s",
        }
    except httpx.HTTPError as exc:
        return {"ok": False, "host": base_url, "error": str(exc) or exc.__class__.__name__}
    return {"ok": True, "host": base_url, "error": None}


@router.get("/ollama/health")
async def ollama_health():
    """Whether the configured Ollama host answers, so the UI can warn and disable input."""
    settings = deps.get_settings()
    if settings is None:
        return {"ok": False, "host": "", "error": "Settings not loaded"}
    return await asyncio.to_thread(_probe_ollama, settings.ollama_base_url)


@router.get("/settings", response_model=AppSettingsResponse)
def read_settings():
    return {**asdict(deps.get_settings()), "genre_categories": _genre_categories()}


@router.put("/settings")
def update_settings(update: AppSettingsUpdate):
    """Apply the supplied fields, persist them to config.yaml and restart services."""
    global _genre_categories_cache
    current = deps.get_settings()
    for key, value in update.model_dump(exclude_none=True).items():
        setattr(current, key, value)

    deps.save_settings(current)

    _genre_categories_cache = None
    deps.shutdown_services()
    deps.init_services()
    return {"ok": True, "message": "Settings updated and services re-initialized"}
