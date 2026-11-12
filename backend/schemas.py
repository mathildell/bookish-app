"""Pydantic schemas matching the frontend TypeScript types."""

from __future__ import annotations
from typing import Optional

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
    indexed_total: int = 0
    indexed_unknown: bool = False  # true when ChromaDB is down and index status can't be trusted


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
# Lists                                                                       #
# --------------------------------------------------------------------------- #

class BookList(BaseModel):
    """A user-created list of books."""
    id: int
    name: str
    book_ids: list[int] = []


class CreateListRequest(BaseModel):
    name: str


class UpdateListRequest(BaseModel):
    """Patch a list by ID. Only supplied fields are updated."""
    name: Optional[str] = None
    book_ids: Optional[list[int]] = None


class CharacterList(BaseModel):
    """A user-created list of character profile ids — a cast, not a shelf of books."""
    id: int
    name: str
    character_ids: list[int] = []


class CreateCharacterListRequest(BaseModel):
    name: str


class UpdateCharacterListRequest(BaseModel):
    """Patch a character list by ID. Only supplied fields are updated."""
    name: Optional[str] = None
    character_ids: Optional[list[int]] = None


# --------------------------------------------------------------------------- #
# Settings                                                                    #
# --------------------------------------------------------------------------- #

class AppSettingsResponse(BaseModel):
    """Full settings returned to the frontend, including computed genre categories."""
    calibre_db_path: str
    calibre_url: str = ""
    obsidian_vault_path: str
    chroma_db_path: str
    ollama_host: str
    ollama_port: int
    chat_model: str
    extraction_model: str = ""
    writing_model: str = ""
    writing_temperature: float = 0.95
    writing_top_p: float = 0.95
    writing_num_predict: int = 1200
    chat_num_ctx: int = 98304
    chat_num_predict: int = 16384
    embedding_model: str
    chunk_size: int
    chunk_overlap: int
    top_k: int
    ignored_books: list[str] = []
    genre_colors: dict[str, str] = {}
    genre_categories: list[str] = []


class AppSettingsUpdate(BaseModel):
    """Patch settings. Only supplied fields are updated."""
    calibre_db_path: Optional[str] = None
    calibre_url: Optional[str] = None
    obsidian_vault_path: Optional[str] = None
    chroma_db_path: Optional[str] = None
    ollama_host: Optional[str] = None
    ollama_port: Optional[int] = None
    chat_model: Optional[str] = None
    extraction_model: Optional[str] = None
    writing_model: Optional[str] = None
    writing_temperature: Optional[float] = None
    writing_top_p: Optional[float] = None
    writing_num_predict: Optional[int] = None
    chat_num_ctx: Optional[int] = None
    chat_num_predict: Optional[int] = None
    embedding_model: Optional[str] = None
    chunk_size: Optional[int] = None
    chunk_overlap: Optional[int] = None
    top_k: Optional[int] = None
    ignored_books: Optional[list[str]] = None
    genre_colors: Optional[dict[str, str]] = None


# --------------------------------------------------------------------------- #
# Characters                                                                  #
# --------------------------------------------------------------------------- #


class CharacterMotivations(BaseModel):
    wants: str = ""
    needs: str = ""


class CharacterVoice(BaseModel):
    """How the character talks — the field that keeps dialogue from blurring together.

    `tone` is the speech register; it can't be called `register` because that
    shadows a pydantic BaseModel attribute.
    """
    tone: str = ""
    rhythm: str = ""
    tells: list[str] = []
    humour: str = ""


class CharacterAppearance(BaseModel):
    """`signature` holds only portable physical facts (build, colouring, marks)."""
    signature: str = ""
    presentation: str = ""


class RelationshipPattern(BaseModel):
    """A reusable dynamic ("protective older sibling"), not a cast list."""
    dynamic: str = ""
    behaviour: str = ""


class CharacterCreate(BaseModel):
    """Every writable field of a profile."""
    name: str
    aliases: list[str] = []
    role: Optional[str] = None
    archetype: Optional[str] = None
    summary: Optional[str] = None
    core_traits: list[str] = []
    motivations: CharacterMotivations = CharacterMotivations()
    fears: list[str] = []
    flaws: list[str] = []
    values: list[str] = []
    voice: CharacterVoice = CharacterVoice()
    mannerisms: list[str] = []
    appearance: CharacterAppearance = CharacterAppearance()
    relationships: list[RelationshipPattern] = []
    formative_experience: Optional[str] = None
    arc_pattern: Optional[str] = None
    situational_anchors: list[str] = []
    thumbnail: Optional[str] = None
    status: str = "complete"
    error: Optional[str] = None
    model: Optional[str] = None
    source_book_ids: list[int] = []


class Character(CharacterCreate):
    """A stored profile."""
    id: int
    created_at: str = ""
    updated_at: str = ""


class CharacterUpdate(BaseModel):
    """Patch a profile. Only supplied fields change."""
    name: Optional[str] = None
    aliases: Optional[list[str]] = None
    role: Optional[str] = None
    archetype: Optional[str] = None
    summary: Optional[str] = None
    core_traits: Optional[list[str]] = None
    motivations: Optional[CharacterMotivations] = None
    fears: Optional[list[str]] = None
    flaws: Optional[list[str]] = None
    values: Optional[list[str]] = None
    voice: Optional[CharacterVoice] = None
    mannerisms: Optional[list[str]] = None
    appearance: Optional[CharacterAppearance] = None
    relationships: Optional[list[RelationshipPattern]] = None
    formative_experience: Optional[str] = None
    arc_pattern: Optional[str] = None
    situational_anchors: Optional[list[str]] = None
    thumbnail: Optional[str] = None
    status: Optional[str] = None
    error: Optional[str] = None
    model: Optional[str] = None
    source_book_ids: Optional[list[int]] = None


class WriteTurn(BaseModel):
    """One side of the scene conversation."""

    role: str
    content: str


class WriteRequest(BaseModel):
    """A scene request: what happens, who is in it, and under which genre."""

    message: str = ""
    history: list[WriteTurn] = []
    character_ids: list[int] = []
    genre: str = ""


class WriteSuggestionsRequest(BaseModel):
    """Ask for fresh suggestion pills without writing a new scene."""

    character_ids: list[int] = []
    history: list[WriteTurn] = []


class DiscoverRequest(BaseModel):
    calibre_ids: list[int] = []
    # Freeform user notes ("Laurent is the protagonist, Uncle is the antagonist").
    # Passed to the model as authoritative over its own reading.
    guidance: str = ""


class ProfileCandidate(BaseModel):
    """One character the user chose to profile in the discovery list."""
    name: str
    aliases: list[str] = []
    role: Optional[str] = None
    description: Optional[str] = None
    calibre_ids: list[int] = []


class ProfilesRequest(BaseModel):
    characters: list[ProfileCandidate] = []
    guidance: str = ""
    # The whole selection for this run. Evidence is gathered from these books as
    # well as each candidate's own sources: a character's recorded sources only say
    # where discovery's sampled excerpts happened to name them, which can be a
    # subset of the books that actually mention them.
    calibre_ids: list[int] = []


# --------------------------------------------------------------------------- #
# Bookmarks                                                                   #
# --------------------------------------------------------------------------- #

class BookmarkCitation(BaseModel):
    calibre_id: Optional[int] = None
    title: str = ""


class BookmarkCreate(BaseModel):
    """A saved chat answer plus the question and citations it came with."""
    question: str = ""
    answer: str
    citations: list[BookmarkCitation] = []
    scope: str = "book"
    calibre_ids: list[int] = []
    note: str = ""
    color: str = "yellow"


class BookmarkUpdate(BaseModel):
    note: Optional[str] = None
    color: Optional[str] = None