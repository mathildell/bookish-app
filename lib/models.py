from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime


@dataclass
class BookRecord:
    calibre_id: int
    title: str
    authors: list[str] = field(default_factory=list)
    series_name: Optional[str] = None
    series_index: Optional[float] = None
    cover_path: Optional[str] = None
    publisher: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    time_period: list[str] = field(default_factory=list)
    tropes: list[str] = field(default_factory=list)
    characters: list[str] = field(default_factory=list)
    sex_themes: list[str] = field(default_factory=list)
    goodreads_id: Optional[str] = None
    word_count: Optional[int] = None
    page_count: Optional[int] = None
    status: Optional[str] = None
    date_added: Optional[datetime] = None
    date_read: Optional[datetime] = None
    user_rating: Optional[int] = None  # Calibre native rating (out of 10)
    goodreads_rating: Optional[int] = None  # GR rating from cc8, scale 2/4/6/8/10 (half-stars possible so /2 → float stars 0.5..5)
    netgalley_deadline: Optional[datetime] = None
    blurb: Optional[str] = None
    personal_notes: Optional[str] = None
    obsidian_review: Optional[str] = None
    review_type: Optional[str] = None
    epub_path: Optional[str] = None
    indexed: bool = False

    @property
    def starred_rating(self) -> Optional[int]:
        if self.user_rating is None:
            return None
        return self.user_rating // 2


@dataclass
class AppSettings:
    calibre_db_path: str = "~/Documents/Books/metadata.db"
    # Web URL of the Calibre library, e.g. http://host:8080/#library_id=Calibre_Library
    calibre_url: str = ""
    obsidian_vault_path: str = "~/BookReviews/"
    chroma_db_path: str = "data/chroma_db"
    ollama_host: str = "192.168.2.10"
    ollama_port: int = 11434
    chat_model: str = "llama3.1:8b"
    # Character work gets its own key so a stronger/different model can be swapped in
    # without touching the Q&A model.
    extraction_model: str = "llama3.1:8b"
    # Empty means "same as chat_model"; the abliterated writing model goes here.
    writing_model: str = ""
    writing_temperature: float = 0.95
    writing_top_p: float = 0.95
    writing_num_predict: int = 1200
    # Chat request limits. Ollama's own defaults (num_ctx 4096, unlimited
    # num_predict) are wrong for RAG: the window truncates the retrieved
    # passages, and an uncapped model can reason until it starves the machine.
    chat_num_ctx: int = 98304
    chat_num_predict: int = 16384
    embedding_model: str = "nomic-embed-text-v2-moe"
    chunk_size: int = 600
    chunk_overlap: int = 10
    top_k: int = 8
    ignored_books: list[str] = field(default_factory=list)
    # Main genre category (e.g. "Fantasy") -> hex color used for genre chips
    genre_colors: dict[str, str] = field(default_factory=dict)

    @property
    def ollama_base_url(self) -> str:
        return f"http://{self.ollama_host}:{self.ollama_port}"

    @property
    def extraction_model_effective(self) -> str:
        return self.extraction_model or self.chat_model

    @property
    def writing_model_effective(self) -> str:
        return self.writing_model or self.chat_model
