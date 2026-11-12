"""Server-Sent Events relay for blocking producers.

Retrieval, Ollama generation, extraction and indexing are all synchronous. Running
them on the event loop froze the whole server — every other request, including
/api/health — for the length of a job. Each streaming endpoint therefore runs its
work in a worker thread and hands frames to the loop through a queue; this module
is that relay, shared by every SSE route.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Callable, Optional

from fastapi import Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

# Any intermediary that honours these passes frames straight through.
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

# Marks the end of a producer thread's output in the queue.
_END = object()

Emit = Callable[..., None]
Producer = Callable[[Emit, threading.Event], None]


def sse_frame(payload: dict, event: Optional[str] = None) -> str:
    """Format one SSE frame, optionally with a named event type."""
    head = f"event: {event}\n" if event else ""
    return f"{head}data: {json.dumps(payload)}\n\n"


def stream_from_thread(
    request: Request,
    producer: Producer,
    *,
    name: str,
    error_as_event: bool = True,
) -> StreamingResponse:
    """Run *producer* in a worker thread and relay what it emits as SSE.

    The producer is called as ``producer(emit, stopped)``. It calls
    ``emit(payload)`` (or ``emit(payload, event="error")``) for each frame and
    should return early once ``stopped`` is set — the client has gone away.

    An uncaught exception becomes a final error frame: ``event: error`` with
    ``{"error": ...}`` by default, or a plain ``{"event": "error", ...}`` data
    frame when *error_as_event* is False (the shape the character streams use).
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stopped = threading.Event()

    def emit(payload: dict, event: Optional[str] = None) -> None:
        try:
            loop.call_soon_threadsafe(queue.put_nowait, sse_frame(payload, event))
        except RuntimeError:
            # Event loop already closed — nobody is listening any more.
            stopped.set()

    def run() -> None:
        try:
            producer(emit, stopped)
        except Exception as exc:  # surfaced to the client as an error frame
            logger.error("%s stream failed", name, exc_info=exc)
            if error_as_event:
                emit({"error": str(exc)}, event="error")
            else:
                emit({"event": "error", "error": str(exc)})
        finally:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, _END)
            except RuntimeError:
                pass

    async def frames():
        threading.Thread(target=run, name=f"{name}-stream", daemon=True).start()
        try:
            while True:
                frame = await queue.get()
                if frame is _END:
                    break
                # Drop the rest of the work for a client that walked away.
                if await request.is_disconnected():
                    return
                yield frame
        finally:
            stopped.set()
            while not queue.empty():
                queue.get_nowait()

    return StreamingResponse(frames(), media_type="text/event-stream", headers=SSE_HEADERS)
