"""Upload and serve the images attached to sheets (characters, worlds)."""

from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend import images

router = APIRouter()


class ImageUpload(BaseModel):
    """A data URL (`data:image/png;base64,...`) or bare base64 of the image file."""
    data: str


@router.post("/images")
def upload_image(req: ImageUpload):
    """Fit the image to a tile, keep it as a file, and return its URL."""
    payload = req.data.split(",", 1)[1] if req.data.startswith("data:") and "," in req.data else req.data
    try:
        raw = base64.b64decode(payload, validate=False)
        name = images.save_upload(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — bad base64
        raise HTTPException(status_code=400, detail="Could not read that image") from exc
    return {"url": f"/api/images/{name}"}


@router.get("/images/{name}")
def get_image(name: str):
    if not images.NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="Image not found")
    path = images.images_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=31536000, immutable"})
