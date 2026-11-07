"""FastAPI entry point for BookishApp."""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.dependencies import get_settings, init_services, shutdown_services
from backend.routers import (
    books,
    chat,
    ingest,
    settings as settings_router,
    lists,
    bookmarks,
    characters,
    character_lists,
    write,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_services()
    yield
    shutdown_services()


app = FastAPI(title="BookishApp API", lifespan=lifespan)

app.include_router(books.router, prefix="/api", tags=["books"])
app.include_router(chat.router, prefix="/api", tags=["chat"])
app.include_router(ingest.router, prefix="/api", tags=["index/ingest"])
app.include_router(settings_router.router, prefix="/api", tags=["settings"])
app.include_router(lists.router, prefix="/api", tags=["lists"])
app.include_router(bookmarks.router, prefix="/api", tags=["bookmarks"])
app.include_router(characters.router, prefix="/api", tags=["characters"])
app.include_router(character_lists.router, prefix="/api", tags=["character-lists"])
app.include_router(write.router, prefix="/api", tags=["write"])


@app.get("/api/health")
async def health():
    return {"status": "ok"}
