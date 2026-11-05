"""Index / unindex book endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend import dependencies as deps
from lib.ingestor import IngestionProgress


router = APIRouter()


@router.post("/index/{calibre_id}")
async def index_book(calibre_id: int):
    """Start indexing a book (blocking — returns when done)."""
    reader = deps.get_reader()
    ingestor = deps.get_ingestor()

    rec = reader.get_book_by_id(calibre_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Book not found")

    errors: list[str] = []
    steps: list[str] = []

    def _cb(p: IngestionProgress):
        if p.error:
            errors.append(p.error)
        else:
            steps.append(p.current_step)

    success = ingestor.index_book(rec, progress_callback=_cb)
    deps.refresh_indexed_cache()

    if not success or errors:
        raise HTTPException(status_code=500, detail=", ".join(errors))
    return {"ok": True, "message": f"Indexed {rec.title}", "chunks": len(steps)}


@router.post("/unindex/{calibre_id}")
async def unindex_book(calibre_id: int):
    """Remove a book's embeddings from ChromaDB."""
    ingestor = deps.get_ingestor()
    ingestor.delete_book(calibre_id)
    deps.refresh_indexed_cache()
    return {"ok": True, "message": f"Removed calibre_id={calibre_id} from index"}
