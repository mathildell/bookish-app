"""Index / unindex endpoints: turn a book's EPUB into searchable embeddings."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend import dependencies as deps
from backend.sse import stream_from_thread
from lib.ingestor import IngestionProgress

router = APIRouter()


class BatchIndexRequest(BaseModel):
    calibre_ids: list[int] = []


def _index(record) -> tuple[bool, list[str], int]:
    """Index one book; return (success, errors, progress steps seen)."""
    errors: list[str] = []
    steps: list[str] = []

    def on_progress(p: IngestionProgress) -> None:
        (errors if p.error else steps).append(p.error or p.current_step)

    ok = deps.get_ingestor().index_book(record, progress_callback=on_progress)
    ok = ok and not errors
    if ok:
        deps.mark_indexed({record.calibre_id})
    return ok, errors, len(steps)


@router.post("/index/{calibre_id}")
def index_book(calibre_id: int):
    """Index a single book (blocking — returns when done)."""
    record = deps.require_reader().get_book_by_id(calibre_id)
    if not record:
        raise HTTPException(status_code=404, detail="Book not found")

    ok, errors, steps = _index(record)
    if not ok:
        raise HTTPException(status_code=500, detail=", ".join(errors))
    return {"ok": True, "message": f"Indexed {record.title}", "chunks": steps}


@router.post("/unindex/{calibre_id}")
def unindex_book(calibre_id: int):
    """Remove a book's embeddings from ChromaDB."""
    deps.get_ingestor().delete_book(calibre_id)
    deps.mark_unindexed({calibre_id})
    return {"ok": True, "message": f"Removed calibre_id={calibre_id} from index"}


@router.post("/batch-index")
async def batch_index_books(body: BatchIndexRequest, request: Request):
    """Index several books, streaming one progress frame per step over SSE.

    data: {"id", "title", "status": "started" | "ok" | "error" | "skipped", ...}
    data: {"done": true, "total": N}
    """
    if not body.calibre_ids:
        return {"ok": False, "message": "No IDs provided"}

    reader = deps.require_reader()

    def produce(emit, stopped):
        for cid in body.calibre_ids:
            if stopped.is_set():
                return
            record = reader.get_book_by_id(cid)
            if not record:
                emit({"id": cid, "status": "skipped", "reason": "not found"})
                continue

            emit({"id": cid, "title": record.title, "status": "started"})
            ok, errors, steps = _index(record)
            if ok:
                emit({"id": cid, "title": record.title, "status": "ok", "chunks": steps})
            else:
                emit({"id": cid, "title": record.title, "status": "error", "errors": errors})

        emit({"done": True, "total": len(body.calibre_ids)})

    return stream_from_thread(request, produce, name="batch-index", error_as_event=False)
