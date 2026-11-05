"""Chat endpoints with Server-Sent Events for streaming responses."""

import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend import dependencies as deps
from backend.schemas import ChatRequest


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

    def on_token(token: str):
        tokens.append(token)

    # We run Ollama chat in a generator to stream SSE events
    async def event_generator():
        nonlocal tokens
        try:
            chunks_data = engine._retrieve_chunks(
                query=req.message, calibre_ids=req.calibre_ids
            )
            context_parts = []
            for ci in chunks_data:
                snippet = ci["text"][:600]
                cid_str = str(ci.get("book_id", "?"))
                title = ci.get("book_title", "Unknown")
                context_parts.append(f"[cid:{cid_str} - {title}]:\n" + snippet)

            rag_context = "\n\n".join(context_parts) if context_parts else ""
            ctx_block = (f"\n\n## CONTEXT FOR QUESTION:\n{rag_context}" if rag_context else "")

            from lib.chat import SYSTEM_TEMPLATES
            sys_content = SYSTEM_TEMPLATES.get(req.scope, SYSTEM_TEMPLATES["book"]) + ctx_block

            from ollama import Client as OllamaClient
            ollama_client = OllamaClient(host=deps.get_settings().ollama_base_url)

            full_msgs = [{"role": "system", "content": sys_content}]
            for h in req.history[-6:]:  # last 3 turns
                full_msgs.append({"role": h["role"], "content": h["content"]})
            full_msgs.append({"role": "user", "content": req.message})

            stream_resp = ollama_client.chat(
                model=deps.get_settings().chat_model,
                messages=full_msgs,
                options={"temperature": 0.4},
                stream=True,
            )

            for chunk in stream_resp:
                delta = chunk.get("message", {}).get("content") or ""
                if delta:
                    tokens.append(delta)
                    yield f"data: {json.dumps({'token': delta})}\n\n"

            final_answer = "".join(tokens)

            # Build citations
            citations = []
            seen = set()
            for ci in chunks_data:
                key = (ci.get("book_id"), ci.get("book_title"))
                if key and key not in seen:
                    citations.append({
                        "calibre_id": ci.get("book_id"),
                        "title": ci.get("book_title", ""),
                    })
                    seen.add(key)

            yield f'data: {json.dumps({"done": True, "answer": final_answer, "citations": citations})}\n\n'

        except Exception as exc:
            yield f'event: error\ndata: {json.dumps({"error": str(exc)})}\n\n'

    return StreamingResponse(event_generator(), media_type="text/event-stream")
