"""FastAPI entry point for BookishApp.

    uvicorn backend.main:app --reload --port 8000
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.dependencies import init_services, shutdown_services
from backend.routers import (
    bookmarks,
    books,
    character_lists,
    characters,
    chat,
    ingest,
    lists,
    settings,
    write,
)

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_services()
    yield
    shutdown_services()


app = FastAPI(title="BookishApp API", lifespan=lifespan)

for module, tag in (
    (books, "books"),
    (chat, "chat"),
    (ingest, "index/ingest"),
    (settings, "settings"),
    (lists, "lists"),
    (bookmarks, "bookmarks"),
    (characters, "characters"),
    (character_lists, "character-lists"),
    (write, "write"),
):
    app.include_router(module.router, prefix="/api", tags=[tag])


@app.get("/api/health")
async def health():
    return {"status": "ok"}
