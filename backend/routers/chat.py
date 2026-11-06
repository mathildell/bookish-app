"""Chat endpoints with Server-Sent Events for streaming responses."""

import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend import dependencies as deps
from backend.schemas import ChatRequest
from lib.chat import _build_citations

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """Stream a chat response using Server-Sent Events.

    SSE format per chunk:
      data: {"token":"..."}        - partial token
      data: {"done":true,"answer":"...","citations":[...]}  - final result
      event: error
      data: {"error":"..."}
    """
    engine = deps.get_chat_engine()
    if engine is None:
        raise HTTPException(status_code=503, detail="Chat engine not initialized")

    tokens: list[str] = []
    chunks_snapshot: list[dict] = []

    def on_token(token: str):
        tokens.append(token)

    async def event_generator():
        nonlocal chunks_snapshot
        history = [
            {"role": h["role"], "content": h["content"]}
            for h in req.history
        ]

        try:
            for item_type, payload in engine.chat_stream(
                user_message=req.message,
                history=history,
                calibre_ids=req.calibre_ids,
                scope=req.scope,
                on_token=on_token,
            ):
                if item_type == "token":
                    yield f"data: {json.dumps({'token': payload})}\n\n"
                elif item_type == "error":
                    yield f'event: error\ndata: {json.dumps({"error": payload})}\n\n'
                elif item_type == "chunks":
                    chunks_snapshot = payload

            final_answer = "".join(tokens)
            citations = _build_citations(chunks_snapshot)
            yield (
                f'data: {json.dumps({"done": True, "answer": final_answer, "citations": citations})}\n\n'
            )

        except Exception as exc:
            logger.error("SSE event generation failed", exc_info=exc)
            yield f'event: error\ndata: {json.dumps({"error": str(exc)})}\n\n'

    return StreamingResponse(event_generator(), media_type="text/event-stream")
