"""Index / unindex book endpoints."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import json as _json

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


def _sse_event(data: dict):
    """Yield a single SSE event."""
    yield f"data: {_json.dumps(data)}\n\n"


@router.post("/batch-index")
async def batch_index_books(body: dict):
    """Index multiple books at once, streaming progress via SSE.

    Body: { "calibre_ids": [1, 2, 3] }
    """
    calibre_ids = body.get("calibre_ids", [])
    if not calibre_ids:
        return {"ok": False, "message": "No IDs provided"}

    reader = deps.get_reader()
    ingestor = deps.get_ingestor()

    async def _stream():
        for cid in calibre_ids:
            rec = reader.get_book_by_id(cid)
            if not rec:
                yield _sse_event({"id": cid, "status": "skipped", "reason": "not found"})
                continue

            errors: list[str] = []
            steps: list[str] = []

            def _cb(p: IngestionProgress):
                if p.error:
                    errors.append(p.error)
                else:
                    steps.append(p.current_step)

            yield _sse_event({"id": cid, "title": rec.title, "status": "started"})
            success = ingestor.index_book(rec, progress_callback=_cb)

            if not success or errors:
                yield _sse_event({"id": cid, "title": rec.title, "status": "error", "errors": errors})
            else:
                yield _sse_event({"id": cid, "title": rec.title, "status": "ok", "chunks": len(steps)})

        deps.refresh_indexed_cache()
        yield _sse_event({"done": True, "total": len(calibre_ids)})

    return StreamingResponse(_stream(), media_type="text/event-stream")
