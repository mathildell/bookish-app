"""FastAPI entry point for BookishApp."""

from pathlib import Path
import yaml
import os
import atexit

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.dependencies import get_settings, init_services, shutdown_services
from backend.routers import books, chat, ingest, settings as settings_router


app = FastAPI(title="BookishApp API")

# CORS not needed — Next.js rewrites proxy to backend directly
# app.add_middleware(...)

app.include_router(books.router, prefix="/api", tags=["books"])
app.include_router(chat.router, prefix="/api", tags=["chat"])
app.include_router(ingest.router, prefix="/api", tags=["index/ingest"])
app.include_router(settings_router.router, prefix="/api", tags=["settings"])


@app.on_event("startup")
async def startup():
    init_services()

@app.on_event("shutdown")
async def shutdown():
    shutdown_services()


@app.get("/api/health")
async def health():
    return {"status": "ok"}
