"""Pydantic schemas matching the frontend TypeScript types."""

from __future__ import annotations
from typing import Optional
from datetime import datetime
from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Book                                                                        #
# --------------------------------------------------------------------------- #

class BookCard(BaseModel):
    """Slim book card for list/grid views."""
    calibre_id: int = Field(alias="id")
    title: str
    authors: list[str]
    series_name: Optional[str] = None
    series_index: Optional[float] = None
    cover_uri: Optional[str] = None
    status: Optional[str] = None
    goodreads_rating: Optional[int] = None
    indexed: bool = False


class BookDetail(BookCard):
    """Full book record."""
    publisher: Optional[str] = None
    tags: list[str] = []
    genres: list[str] = []
    time_period: list[str] = []
    tropes: list[str] = []
    characters: list[str] = []
    sex_themes: list[str] = []
    goodreads_id: Optional[str] = None
    word_count: Optional[int] = None
    page_count: Optional[int] = None
    date_added: Optional[str] = None
    date_read: Optional[str] = None
    netgalley_deadline: Optional[str] = None
    blurb: Optional[str] = None
    personal_notes: Optional[str] = None
    obsidian_review: Optional[str] = None


class BooksListResponse(BaseModel):
    cards: list[BookCard]
    total: int
    offset: int


# --------------------------------------------------------------------------- #
# Filters                                                                     #
# --------------------------------------------------------------------------- #

class BookFilterParams(BaseModel):
    query: str = ""
    status: Optional[str] = None
    indexed: Optional[bool] = None
    sort: str = "date_added_desc"
    selected_tags: list[str] = []
    offset: int = 0
    limit: int = 30


# --------------------------------------------------------------------------- #
# Chat                                                                        #
# --------------------------------------------------------------------------- #

class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    calibre_ids: Optional[list[int]] = None
    scope: str = "book"  # "book" | "multi_book"


# --------------------------------------------------------------------------- #
# Settings                                                                    #
# --------------------------------------------------------------------------- #

class AppSettingsResponse(BaseModel):
    calibre_db_path: str
    obsidian_vault_path: str
    chroma_db_path: str
    ollama_host: str
    ollama_port: int
    chat_model: str
    embedding_model: str
    chunk_size: int
    chunk_overlap: int
    top_k: int
    ignored_books: list[str] = []
    genre_colors: dict[str, str] = {}
    genre_categories: list[str] = []


class AppSettingsUpdate(BaseModel):
    calibre_db_path: Optional[str] = None
    obsidian_vault_path: Optional[str] = None
    chroma_db_path: Optional[str] = None
    ollama_host: Optional[str] = None
    ollama_port: Optional[int] = None
    chat_model: Optional[str] = None
    embedding_model: Optional[str] = None
    chunk_size: Optional[int] = None
    chunk_overlap: Optional[int] = None
    top_k: Optional[int] = None
    ignored_books: Optional[list[str]] = None
    genre_colors: Optional[dict[str, str]] = None
