# BookishApp

A personal reading companion built on top of a **Calibre** library. Browse and filter your
books, chat with their full text through a local LLM (RAG over **Ollama** + **ChromaDB**),
track NetGalley ARCs, keep reviews in an **Obsidian** vault, extract portable character
profiles from novels, and cast those characters into new scenes in a writing sandbox.

Everything runs locally: the library is read straight from Calibre's `metadata.db` (read-only),
models run on your own Ollama host, and user data lives in plain files under `data/`.

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Setup](#setup)
- [Running](#running)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Data & storage](#data--storage)
- [Maintenance scripts](#maintenance-scripts)
- [Project layout](#project-layout)

---

## Features

### Library (`/`)
- Cover grid of the whole Calibre library with **infinite scroll**; covers are loaded only for
  the visible page.
- **Search** across titles, authors, series and Calibre tags (search bar lives in the navbar).
- **Filters**: reading status (`read`, `to-read`, `dnf`, …), indexed / not indexed, saved list.
- **Sorting** by date added (newest / oldest first).
- Goodreads rating shown as moon phases 🌕🌗🌑 on each card.
- Per-card actions on hover: **Index** an unindexed book, or **Chat** with an indexed one.
- **Multi-select** books, then from the action rail:
  - chat with the selection,
  - extract characters from the selection,
  - index / un-index the selection (batch indexing with live per-book progress),
  - add to / remove from a list, or save the selection as a new list.
- **Book lists**: create, rename, delete and filter by user-curated lists (sidebar).
- Books whose title matches a configured *ignored* pattern are hidden everywhere.
- Shows `N indexed`, and flags index status as unknown when ChromaDB is unavailable.

### Book details (`/book/[id]`)
- Full metadata: authors, series, publisher, genres (colour-coded chips), tropes, time period,
  themes, characters, word/page counts, dates added/read, NetGalley deadline.
- Blurb and Calibre personal notes rendered as rich text.
- Links to open the book in Calibre's web UI and on Goodreads.
- Index / un-index the book.
- **Obsidian review** editor: write a Markdown review and save it to the vault; ARC-tagged
  books go to `arcs/`, others to `misc/`.

### Chat (`/chat`)
- Ask questions about one or several books (`/chat?ids=1,2,3`); answers are grounded in the
  book text and **cite** the books they drew from.
- **Streaming** answers token by token, with a collapsible view of the model's reasoning
  ("thinking") for reasoning models.
- Retrieval tuned for books: front/back matter is filtered out, the chunk following each hit is
  attached, questions about an *ending* also pull the closing chapters, and rare words in the
  question trigger an extra lexical pass.
- Guards against runaway reasoning (loop detection and a thinking timeout).
- **Bookmark** any answer with one click.

### Bookmarks (`/bookmarks`)
- A wall of saved answers ("post-it notes") with their question and citations.
- Search questions, answers and books; add a personal note; delete; or reopen the chat on the
  same books.

### ARC tracker (`/arcs`)
- Every book with a NetGalley deadline or an `ARC` tag, with deadline, notes and review status.
- Totals for ARCs, overdue and unreviewed; overdue books show how many days late they are.

### Characters (`/characters`)
- Library of **personality-first character profiles**, designed to be transplanted into any
  setting: archetype, summary, core traits, wants/needs, fears, flaws, values, voice (register,
  rhythm, verbal tells, humour), mannerisms, appearance, relationship patterns, formative
  experience, arc pattern — plus *situational anchors* that hold the canon-only facts.
- Search by name, archetype, role or summary; multi-select; **character lists** (casts) with a
  ✨ shortcut to write a scene with the whole cast.
- **Character detail** (`/characters/[id]`): every field is editable inline; shows source books
  and list membership; delete a profile.

### Character extraction (`/characters/extract`)
- **Discover** the cast of the selected (indexed) books: the model samples each book and
  proposes characters; places, groups and objects are filtered out; aliases are verified
  against the full text so two characters are never fused.
- Optional **guidance** notes ("Laurent is the protagonist…") that override the model's reading.
- Candidates already in the library are flagged; possible duplicates are highlighted.
- **Generate profiles** for the chosen candidates, streamed one card at a time; evidence is
  gathered by counting name mentions across all selected books, and existing profiles are
  extended instead of duplicated.

### Writing sandbox (`/write`)
- Pick a cast of saved characters (or arrive from a character list via `?chars=…`) and a genre.
- Describe what happens; the scene streams in as prose that keeps each character's psychology
  and voice without importing their original world.
- Three **suggestion pills** after each scene propose where it could go next (one raises the
  stakes, one turns romantic, one is wry); click one to continue, or regenerate them.
- Long scenes that hit the token limit are continued automatically.

### Settings (`/settings`)
- Paths: Calibre `metadata.db`, Calibre web URL, Obsidian vault, ChromaDB directory.
- Ollama host/port and model pickers (populated from the models installed on the host) for
  chat, character extraction, writing and embeddings.
- Chat limits (context window, max tokens) and writing sampling (temperature, top-p, max tokens).
- Ingestion: chunk size, chunk overlap, retrieved chunks (top-k).
- Ignored books (title patterns) and **genre colours** per main genre category.
- Saving writes `config.yaml` and re-initialises the backend services.

---

## Architecture

```
 Browser ──► Next.js (frontend/, :3000) ──/api/*──► FastAPI (backend/, :8000)
                                                       │
            ┌──────────────────────┬───────────────────┼──────────────────────┐
            ▼                      ▼                   ▼                      ▼
   Calibre metadata.db      ChromaDB (data/)     Ollama host           Obsidian vault
   (read-only SQLite)       book_texts chunks    chat / embed models   arcs/ & misc/ *.md
```

- **Frontend** — Next.js 15 (App Router), React 19, TanStack Query, Tailwind CSS 4.
  `next.config.js` rewrites `/api/*` to the backend. Streaming endpoints have their own
  route handlers (`src/app/api/**/route.ts`, built from `src/lib/backendProxy.ts`) because the
  rewrite proxy buffers responses.
- **Backend** — FastAPI. Routers in `backend/routers/`; long-running work (retrieval,
  generation, extraction, batch indexing) runs in worker threads and streams to the client as
  Server-Sent Events through `backend/sse.py`.
- **Core library** — `lib/`: Calibre reader, EPUB ingestor, RAG chat engine, character store
  and extractor, writing engine, Obsidian writer. Heavy services (ChromaDB, Ollama clients) load
  lazily on first use, so the library grid is available within seconds.

---

## Requirements

- Python 3.11+
- Node.js 20+
- A Calibre library with EPUBs. The reader expects these custom columns:
  `#8` Goodreads rating, `#9` date read, `#11` page count, `#12` genre, `#13` status,
  `#17` time period, `#18` tropes, `#19` themes, `#20` characters, `#21` word count,
  `#23` review/notes, `#24` NetGalley deadline. Missing optional columns are skipped.
- An [Ollama](https://ollama.com) host with a chat model and an embedding model pulled.

## Setup

```bash
# Backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-backend.txt

# Frontend
cd frontend
npm install
```

Create `config.yaml` at the project root (or set the values from the Settings page later —
every key is optional):

```yaml
app:
  calibre_db_path: ~/Documents/Books/metadata.db
  calibre_url: http://localhost:8080/#library_id=Calibre_Library
  obsidian_vault_path: ~/BookReviews/
  chroma_db_path: data/chroma_db
  ignored_books: []
  genre_colors: {}
ollama:
  host: 192.168.2.10
  port: 11434
  chat_model: llama3.1:8b
  extraction_model: ""      # empty = same as chat_model
  writing_model: ""         # empty = same as chat_model
  embedding_model: nomic-embed-text-v2-moe
chat:
  num_ctx: 98304
  num_predict: 16384
writing:
  temperature: 0.95
  top_p: 0.95
  num_predict: 1200
ingestion:
  chunk_size: 600
  chunk_overlap: 10        # percent
  top_k: 8
```

## Running

```bash
./restart.sh                 # (re)start backend on :8000 and frontend on :3000
./restart.sh --stop-only     # stop both
./restart.sh --clear-cache   # also wipe __pycache__ and .next/cache
```

Or by hand:

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
cd frontend && npm run dev
```

Then open <http://localhost:3000>. Index a few books (card **Index** button, or select several
and use the rail) before chatting with them or extracting characters.

To index a whole library unattended: `./init_run.sh` (runs `init_index.py`, logging to
`data/indexing.log`).

## Configuration

Settings are read from `config.yaml`, falling back to environment variables for a few keys
(`CALIBRE_DB`, `OBSIDIAN_VAULT`, `CHAT_MODEL`, `EMBED_MODEL`), then to built-in defaults.
Relative paths are resolved from the project root. The frontend reaches the backend at
`http://localhost:8000` (rewrites) or `BACKEND_API_URL` (streaming route handlers).

> Changing the **embedding model** requires re-embedding the index
> (`scripts/reembed_to_model.py`) — a ChromaDB collection is tied to one vector size.

---

## API reference

All routes are under `/api`. Interactive docs: <http://localhost:8000/docs>.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/books` | Book cards; `query`, `status`, `indexed`, `sort`, `selected_tags`, `list_id`, `offset`, `limit` |
| GET | `/books/{id}` | Full book record, including its Obsidian review |
| GET | `/books/filters/metadata` | Available reading statuses |
| GET | `/arcs` | ARC tracker rows |
| POST / DELETE | `/obsidian/{id}` | Write / delete a book's review (`{"review": "..."}`) |
| POST | `/index/{id}` | Index one book (blocking) |
| POST | `/unindex/{id}` | Remove a book's embeddings |
| POST | `/batch-index` | Index several books — **SSE** progress (`{"calibre_ids": [...]}`) |
| POST | `/chat/stream` | RAG chat — **SSE** (`thinking`, `token`, `done` with citations) |
| GET / POST | `/lists` | Book lists |
| PATCH / DELETE | `/lists/{id}` | Rename / set `book_ids` / delete |
| GET / POST | `/character-lists` | Character lists (casts) |
| PATCH / DELETE | `/character-lists/{id}` | Rename / set `character_ids` / delete |
| GET / POST | `/bookmarks` | Saved answers (identical question+answer is de-duplicated) |
| PATCH / DELETE | `/bookmarks/{id}` | Update note/colour / delete |
| GET / POST | `/characters` | List (`q`, `calibre_id`) / create profiles |
| GET / PATCH / DELETE | `/characters/{id}` | Read / patch / delete a profile |
| POST | `/characters/discover` | Discover candidates — **SSE** |
| POST | `/characters/profiles` | Generate profiles — **SSE** |
| POST | `/write/stream` | Write a scene — **SSE** (`token`, `done` with suggestions) |
| POST | `/write/suggestions` | Regenerate the three next-beat suggestions |
| GET / PUT | `/settings` | Read / update settings (persists to `config.yaml`) |
| GET | `/models` | Models installed on the Ollama host |

---

## Data & storage

| Location | Contents |
|---|---|
| Calibre `metadata.db` | Book metadata — opened **read-only**, never modified |
| `data/chroma_db/` | ChromaDB collection `book_texts` (chunk ids `<calibre_id>_c<n>`) |
| `data/indexed_ids.cache` | Cached set of indexed book ids (rebuilt from ChromaDB if missing) |
| `data/characters.db` | SQLite store of character profiles, aliases and source books |
| `data/lists.json` | Book lists |
| `data/character_lists.json` | Character lists |
| `data/bookmarks.json` | Bookmarked chat answers |
| Obsidian vault | Reviews as Markdown, matched to books by the `goodreads` frontmatter key |
| `config.yaml` | Settings (git-ignored) |

## Maintenance scripts

| Script | Purpose |
|---|---|
| `init_index.py` / `init_run.sh` | Index every not-yet-indexed book in the library |
| `scripts/reingest_to_model.py` | Re-chunk and re-embed books into a new index (new model or chunk size) |
| `scripts/reembed_to_model.py` | Re-embed existing chunks with another embedding model |
| `scripts/reembed.py` | Re-embed chunks in place |
| `scripts/check_embeddings.py`, `scan_zeros.py`, `fix_zeroed_embeddings.py` | Find and repair zeroed embeddings |
| `scripts/check_target_books.py` | Inspect the embeddings of specific books |
| `scripts/ollama-*.sh` | List, pull, remove and unload models on the Ollama host |

---

## Project layout

```
backend/
  main.py             FastAPI app and router registration
  dependencies.py     settings (config.yaml), singletons, indexed-id cache
  storage.py          JSON-file collections (lists, character lists, bookmarks)
  list_router.py      shared CRUD routes for named id lists
  sse.py              thread → Server-Sent Events relay
  schemas.py          Pydantic request/response models
  routers/            books, chat, ingest, lists, character_lists, bookmarks,
                      characters, write, settings
lib/
  calibre_reader.py   read-only Calibre access
  ingestor.py         EPUB → chunks → embeddings → ChromaDB
  vector_store.py     shared ChromaDB collection access
  chat.py             retrieval + streaming chat
  characters.py       character profile store (SQLite)
  character_extractor.py  discovery and profile synthesis
  writing.py          scene generation and suggestions
  obsidian_writer.py  review files in the vault
  llm.py              Ollama helpers
  models.py           BookRecord and AppSettings
frontend/src/
  app/                pages (library, book, chat, arcs, bookmarks, characters, write, settings)
  app/api/            streaming pass-through route handlers
  components/         shared UI components
  lib/                API client, proxy helper, formatting helpers
  types/              TypeScript types mirroring the backend schemas
docs/                 design notes
scripts/              maintenance scripts
```
