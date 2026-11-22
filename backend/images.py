"""Image files for sheets: user uploads and generated cover collages.

Images are small JPEGs kept as files under `data/images/` and referenced by URL, so
the databases hold a short string instead of a blob. Everything written here is
downscaled first: a sheet shows a 2:3 tile, not a poster.
"""

from __future__ import annotations

import hashlib
import io
import re
import uuid
from pathlib import Path
from typing import Optional

from PIL import Image, ImageOps

from backend import dependencies as deps

# A tile is 2:3. Uploads are kept at up to twice that so a larger card stays sharp.
TILE = (400, 600)
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}\.jpg$")


def images_dir() -> Path:
    path = Path(deps.DATA_DIR) / "images"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _jpeg(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def save_upload(raw: bytes) -> str:
    """Store an uploaded image, fitted to a tile, and return its file name."""
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError("That image is too large (12 MB at most)")
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)
        # Fill the tile from the centre rather than squashing: portraits and
        # landscapes both crop to something sensible.
        img = ImageOps.fit(img.convert("RGB"), TILE, Image.LANCZOS, centering=(0.5, 0.35))
    except Exception as exc:  # noqa: BLE001 — Pillow raises many things for a bad file
        raise ValueError("That file is not an image Pillow can read") from exc
    name = f"{uuid.uuid4().hex}.jpg"
    (images_dir() / name).write_bytes(_jpeg(img))
    return name


def collage_cells(count: int, width: int, height: int) -> list[tuple[int, int, int, int]]:
    """(x, y, w, h) cells for 1 to 4 images on a width x height canvas, 2px gutters."""
    g = 2
    half_w, half_h = (width - g) // 2, (height - g) // 2
    if count <= 1:
        return [(0, 0, width, height)]
    if count == 2:
        return [(0, 0, half_w, height), (half_w + g, 0, width - half_w - g, height)]
    if count == 3:
        return [
            (0, 0, half_w, height),
            (half_w + g, 0, width - half_w - g, half_h),
            (half_w + g, half_h + g, width - half_w - g, height - half_h - g),
        ]
    return [
        (0, 0, half_w, half_h),
        (half_w + g, 0, width - half_w - g, half_h),
        (0, half_h + g, half_w, height - half_h - g),
        (half_w + g, half_h + g, width - half_w - g, height - half_h - g),
    ]


def build_collage(cover_paths: list[str]) -> Optional[bytes]:
    """A 2:3 collage of up to four covers, or None if none of them can be read."""
    covers: list[Image.Image] = []
    for path in cover_paths[:4]:
        try:
            covers.append(Image.open(path).convert("RGB"))
        except Exception:  # noqa: BLE001 — a missing or corrupt cover is just skipped
            continue
    if not covers:
        return None
    canvas = Image.new("RGB", TILE, (24, 24, 27))
    for img, (x, y, w, h) in zip(covers, collage_cells(len(covers), *TILE)):
        canvas.paste(ImageOps.fit(img, (w, h), Image.LANCZOS, centering=(0.5, 0.3)), (x, y))
    return _jpeg(canvas)


def collage_name(ids: list[int]) -> str:
    return "collage-" + hashlib.sha1(",".join(map(str, ids)).encode()).hexdigest()[:16] + ".jpg"
