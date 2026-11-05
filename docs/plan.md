Here's the revised plan:

---

## Project Plan (Revised)

### Architecture

```
                  Calibre DB (~ /Books/metadata.db) ──read──┐
                   Obsidian Vault (~ /BookReviews/)  ─read/write──┤
                                                                 ├→ Python Backend ──→ Streamlit UI
                Ollama (configurable hostname:port)        ◄────┘
```

---

### 1. Configuration

**Streamlit sidebar settings panel** with live-editable fields:
- Calibre library path (default: `~/Books/metadata.db`)
- Obsidian vault path (default: `~/BookReviews/`)
- Ollama host + port (default: `192.168.2.10:11434`)
- Chat model name
- Embedding model name

Persisted to a local JSON or YAML config file. No hardcoding — everything changeable via UI.

---

### 2. Data Layer

**Calibre connector (`lib/calibre_reader.py`)**
Read-only SQLite connection fetching all metadata:
- `calibre_id`, title, authors, cover image (as blob path), publisher
- Series name + series index number
- tags, genres, time period, tropes, characters, themes
- Goodreads ID, word count
- Status column (`to-buy`, `to-read`, `read`, `dnf`, `wont-read`)
- Date added, personal read date, user rating
- NetGalley deadline date
- Blurb/synopsis
- Personal review notes (raw thoughts textarea)
- Epub file path

Returns full book records. Supports filtering by any of these fields.

**Obsidian connector (`lib/obsidian_writer.py`)**
- **Read:** Scans `arcs/` and `misc/` subfolders, parses markdown + frontmatter into the app's memory
- **Write:** Saves review content from the app back to `.md` files in the appropriate Obsidian subfolder (ARC vs misc based on Calibre tags)
- Creates files if they don't exist, overwrites if they do
- Filename convention: `[calibre_id] - [Title] - [Author].md` (using calibre ID for reliable primary key lookups, but keeping human-readable name too)

**Merged model:**
```python
{
  calibre_id: int,          # primary key
  title: str,
  authors: list[str],
  series_name: str,         # nullable
  series_index: float,      # e.g. 1, 2, 3.5
  cover_path: str,
  publisher: str,
  tags: list[str],          # includes "arc" if applicable
  genres: list[str],
  time_period: str,         # nullable
  tropes: list[str],        # nullable
  characters: list[str],    # nullable
  themes: list[str],        # nullable
  goodreads_id: str,        # nullable
  word_count: int,          # nullable
  status: str,              # "to-read", "read", "dnf", etc.
  date_added: datetime,
  date_read: datetime,      # nullable
  user_rating: int,         # 1-5 stars
  netgalley_deadline: str,  # nullable
  blurb: str,
  personal_notes: str,      # from Calibre's "review" textarea
  obsidian_review: str,     # full review text from Obsidian markdown
  review_type: str,         # "arc", "misc", or None
  epub_path: str,           # absolute path
  indexed: bool
}
```

---

### 3. Ingestion Pipeline
1. Epub extraction — Use ebooklib + BeautifulSoup to dump each epub into clean text chapters, with metadata about chapter boundaries
2. Text chunking — Chunk each book's text by chapter (~500-800 tokens per chunk, 10% overlap between adjacent chunks), tagging each chunk with book_id, chapter_name, and inherited Calibre metadata
Embedding generation — Connect to remote Ollama API at 192.168.2.10:11434. Recommended model: nomic-embed-text (768-dim, fast, good quality, runs on CPU). Embed all chunks
3. Vector DB storage — Insert into ChromaDB (lightweight, embedded SQLite-based, no separate process needed). Store chunk metadata alongside embeddings for filtering
4. Batch controls: UI button to "index book X" or mass index filtered selection. Re-indexing respects already-embedded books to avoid redundant work.

A few additions:
- **Embedding model:** `nomic-embed-text-v2-moe` (configurable in UI)
- Calibre's rich metadata (`genres`, `tropes`, `themes`, `time_period`, etc.) stored alongside each text chunk in ChromaDB for hybrid filtering
- Indexing respects selective inclusion — sidebar toggle or batch filter

---

### 4. Chat Layer

**Three query scopes:**
1. **Library-wide** — freeform search across all indexed books
2. **Single book** — deep RAG into one book's content + its review/notes
3. **Multi-book** — select N books (e.g., a trilogy, or all "DNF" books) and ask comparative questions like "in which book does X happen?"

The vector query filters by the selected `calibre_id`s before retrieval. LLM receives context only from those books' chunks.

**Conversation memory:**
- Last 4 user-assistant message pairs kept in local Streamlit session state
- Passed as conversation history in system prompt for continuity
- Reset when switching books or scope (library → book chat)
- Capped at ~2000 tokens of conversation history to stay within context budget

**LLM model:** `llama3.1:8b` or similar — you'll pick from a dropdown once models are pulled on your Ollama instance. We can auto-discover available models via the Ollama API.

---

### 5. Streamlit UI

**Sidebar:**
- ⚙️ **Settings** (expandable) — paths, Ollama host/port, model selection
- 📚 **Book browser** — searchable/filterable by any Calibre field (status, rating, tags, series, ARC deadline, genre, read date, etc.)
- Index toggle per book + batch actions ("index all unread", "index all rated ≥ 4 stars")
- Series grouping — expand a series to see/select all its books

**Main area — tabs:**
1. **Library Chat** — cross-library questions, result citations with source links
2. **Book Detail** — metadata display, cover thumbnail, Calibre notes, Obsidian review editor (markdown textarea with save button that writes back to the vault), indexing status
3. **Selected Books Chat** — whatever books are highlighted/selected in the sidebar get queried together
4. **ARC Tracker** — quick-glance view of ARC deadlines, which ones are reviewed/unreviewed, sortable by deadline date

---

### 6. Revised Project Structure

```
BookishApp/
├── app.py                          # Streamlit entrypoint
├── config.yaml                     # persisted settings
├── data/
│   └── chroma_db/                  # vector DB files
├── lib/
│   ├── calibre_reader.py           # Calibre metadata connector
│   ├── obsidian_writer.py          # Read/write Obsidian reviews
│   ├── ingestor.py                 # Epub → chunk → embed pipeline
│   ├── chat.py                     # RAG logic, multi-scope queries
│   └── models.py                   # Pydantic/dataclass definitions
├── requirements.txt
└── .gitignore
```

---

### 7. Dependencies

- `streamlit` — UI
- `ebooklib` + `beautifulsoup4` — epub parsing
- `chromadb` — vector DB
- `ollama` — API client (configurable endpoint)
- `pyyaml` — config persistence
- `Pillow` — cover image rendering in Streamlit
- `python-frontmatter` — Obsidian markdown frontmatter handling