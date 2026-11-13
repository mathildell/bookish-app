# Characters & Creative Writing — implementation plan

Status: agreed, in progress. Phase 1 (storage + CRUD + characters grid) is being built.

## Goal

1. **Character extraction** — pick indexed books from the library, get a light list of
   characters, choose which ones to profile, and keep the resulting profile cards.
2. **Creative writing** — cast saved characters into a scene in a chat-shaped UI and
   have a high-temperature, abliterated model write it.

Every book in a selection is treated as one continuous body of work. There is no
spoiler boundary: if a book is in the selection, its contents are in scope.

## Core design decision: personalities, not situations

The profile must survive being transplanted. A prince from a fantasy novel has to be
writable as a barista in a contemporary romance, so every field describes the *person*,
never their world.

Two rules, applied in the extraction prompt:

- **Cause → trait.** A formative experience is kept only if it explains core behaviour,
  and is phrased as its meaning rather than its events.
  ("Raised their siblings alone after everything was taken → therefore protective to the
  point of self-erasure", not "is a prince of Vintas".)
- **The portability test.** "Could this line describe the same person working in a modern
  city?" If not, translate it into the trait it produced, or move it to
  `situational_anchors`.

`situational_anchors` stores the non-portable canon that is load-bearing for accuracy
(titles, magic, world rules). It is **never** injected into the writing prompt by
default.

## Data model

SQLite at `data/characters.db` (stdlib `sqlite3`, atomic, handles partial updates and
concurrent writes from background jobs — unlike the `lists.json` / `bookmarks.json`
blob pattern).

```sql
CREATE TABLE characters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  role          TEXT,
  archetype     TEXT,
  summary       TEXT,              -- one sentence, used in the picker list
  core_traits   TEXT,              -- JSON array
  motivations   TEXT,              -- JSON {wants, needs}
  fears         TEXT,              -- JSON array
  flaws         TEXT,              -- JSON array
  values        TEXT,              -- JSON array
  voice         TEXT,              -- JSON {register, rhythm, tells[], humour}
  mannerisms    TEXT,              -- JSON array
  appearance    TEXT,              -- JSON {signature, presentation}
  relationships TEXT,              -- JSON [{dynamic, behaviour}]
  formative_experience TEXT,
  arc_pattern   TEXT,
  situational_anchors   TEXT,      -- JSON array, quarantined from the writing prompt
  thumbnail     TEXT,              -- relative path under data/character_thumbs/
  status        TEXT NOT NULL DEFAULT 'complete',  -- generating | complete | failed
  error         TEXT,
  model         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE character_sources (
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  calibre_id   INTEGER NOT NULL,
  PRIMARY KEY (character_id, calibre_id)
);

CREATE TABLE character_aliases (
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  PRIMARY KEY (character_id, alias)
);
```

The API still exposes `source_book_ids` and `aliases` as plain arrays; they are assembled
from the join tables.

- `voice` is the highest-value field for writing: personality says who they are, voice
  says how they talk. Without it every character sounds like the narrator.
- `relationships` holds *patterns*, not cast lists: "protective older-sibling dynamic"
  transfers, "brother of X" does not.
- `appearance.signature` keeps only the portable physical facts (build, colouring, marks,
  posture), never costume or rank.
- `status` lets a crashed job leave a visible "generating" card instead of a half-filled
  one that looks complete.

## Configuration

```yaml
ollama:
  chat_model: qwen3-vl:8b
  extraction_model: qwen3-vl:8b   # separate key, same model for now
  writing_model: ""               # empty → falls back to chat_model
  embedding_model: nomic-embed-text-v2-moe
writing:
  temperature: 0.95
  top_p: 0.95
  num_predict: 1200
```

Every new field must be added in **five** places or the first Settings save silently
drops it: `config.yaml`, `lib/models.py` (`AppSettings`), `dependencies._load_settings_from_yaml`,
`backend/routers/settings.py` (`dump_obj` + re-init), and `backend/schemas.py` +
the settings page.

`lib/chat.py` hardcodes `_SYSTEM_TEMPERATURE` inside `_chat_options()`; the writing engine
gets its own options rather than reusing that constant.

## Extraction pipeline

### Why the pipeline was rebuilt (Nov 2026)

The first version sampled 12 chunks × 700 characters per book and asked the model to
find the cast in them. With a 27B model it still mixed people up with places, gave one
character another's motives, and listed people thanked in the Acknowledgements. Those
are pipeline faults, not model faults: the model saw ~2% of the book, including front
and back matter, and was asked to both *find* and *judge* names from it. The rebuild
moves everything measurable into code (`lib/book_text.py`) and gives the model only
narrow, checkable jobs.

### Story text only (`lib/book_text.py`)

Chunks are re-read in order from Chroma and grouped by EPUB section. A section is
dropped as matter when its first short line is a matter heading (Contents,
Acknowledgements, About the Author, Also by, Copyright, Dedication, Afterword, Author's
note, Trigger warning, Newsletter, Excerpt…), or — only in the outer 20% of the book —
when its file name says so (`…_ack_r1.htm`), its opening has matter phrases ("All rights
reserved", "Thanks to", "www."), or it is short with no dialogue. A "Characters" /
"Dramatis personae" page is kept aside as a cast list. Drop caps split by the ingestor
("L\noth sighed") are rejoined.

### Phase A — discovery (one LLM call per selection)

1. **Count.** Every capitalised word that is capitalised mid-sentence and rarely
   lower-case is a name. For each: mentions, chapters spanned, how often it sits next to
   a speech verb ("speaks"), next to person verbs/body parts/honorifics ("acts"), and
   after in/at/from ("place"). One token pass, ~0.4s for a trilogy.
2. **Shortlist.** The 40 most frequent names present in ≥2 chapters, plus names the
   user typed in guidance and cast-list names with ≥10 mentions. Ranking comes first so
   a 70-name cast list cannot crowd out the villain.
3. **Classify.** The model gets each name's counts and 3 short passages (6 for title
   words like "Regent") and returns `kind` (person / group / place / title / object /
   other), `same_as` (nickname/surname links), `role` and a one-line description, under
   an Ollama JSON schema. It can only classify names the text contains.
4. **Code decides prominence.** Links are merged unless they join a title or the cast
   list separates them. Roles are clamped by share of the lead's mentions: under 3% (or
   <8 mentions) is `minor`; a "protagonist" under 15% is `supporting`; a "minor" over 5%
   is `supporting`. Names the user mentions in guidance are exempt.

Non-persons are returned as `filtered` with their kind, so the UI can show "Regent
(title)" and the user can add it by hand.

### Roles describe function, not likability

A blunt, morally ambiguous ally kept coming back as "antagonist". The prompt now defines
the roles by story function: an antagonist's goal must *actively block* a protagonist's,
and cruelty, rudeness or one hostile scene is explicitly not enough — an ally who
disagrees with the hero is not an antagonist. When in doubt the model must say
`supporting`. `_canonical_role()` maps the vocabulary models invent (`villain`, `hero`,
`love interest`, `sidekick`) onto the six canonical roles.

### Steering the model

Extraction is a reading task, and the user has usually read the book. The extract page
carries a **Steer the model** box: freeform notes such as

> Laurent is the protagonist, Damen is the protagonist, Uncle is the antagonist.
> Arles and Vere are places, not characters. The Regent is Laurent's uncle — same person.

Notes are sent as `guidance` on both endpoints, injected into the discovery prompt *and*
every profile call as authoritative — "when they contradict your inference, follow
them". `Re-read with these notes` re-runs discovery in place. Two more corrections live
in the candidate list itself: a role dropdown per row (fed straight into the profile),
and an **Add a name** box for anyone the model missed.

Interface: `discover(calibre_ids, titles, guidance)`, `build_profile(..., guidance)`,
`stream_profiles(requests, guidance)`;
`DiscoverRequest`/`ProfilesRequest` gain `guidance: str = ""`.

Results are merged across books in code (which gives `source_book_ids` for free) and each
entry is flagged `already_extracted` by lookup against `characters` + `character_aliases`.
Matches are **disabled in the UI**, not hidden, with a link to the profile and an
"update with these books" action when the selection adds a source.

### Nickname handling

Within a selection, nicknames are linked by `same_as` in discovery (above). Against the
saved library, only name matching can split a character. Normalise
before comparing: lowercase, strip punctuation, leading articles (`the`, `a`) **and**
honorifics (`mr|mrs|ms|miss|lady|lord|sir|dr`).

- new candidate matching an existing name or alias → auto-merge, union sources
- candidate whose alias collides with a *different* character → do **not** merge; flag as
  "possible duplicate"

### Phase B — deep profile (observe → group → tier → synthesise → check)

The first rebuild still let one vivid line dominate: Laurent's sheet repeated a
"worsening cruelty" that came from a single, guarded self-description in book 1, and
his arc said he never outgrew it. The quote check proved the line *existed*, not that
it was *true of him*. The fix is to measure support and attribution, not just existence.

Books are always processed in **reading order** (`_reading_order` in the router: series
name, then series index), because the arc is built from it.

1. **Evidence** (no model): every paragraph that names the character (case-sensitive).
   Dialogue they speak ranks first, then paragraphs naming nobody else, then shared
   scenes. The budget scales with how much text there is about them (`_BATCH_STEPS`:
   2 batches for a walk-on up to 6 × 16k characters for a trilogy lead) and is **split
   equally between books**, round-robin over chapters inside each book.
2. **Observe** (one call per batch): each excerpt is labelled `[Book 2 · 40% through]`.
   The model records aspect, note, verbatim quote and **source**: `shown` (narration
   demonstrates it), `self` (their own words about themselves — guarded characters
   misdescribe themselves) or `other` (someone's opinion, with `by`). Code finds each
   quote in the batch, drops it if absent, and takes book, chapter and position from
   the passage it was found in — location is measured, not reported.
3. **Group** (one call): observations are clustered into themes (same quality, opposites
   kept apart). Failure falls back to one theme per observation.
4. **Tier** (code): per theme, distinct chapters, books, source mix and spread
   (`B1:4 B2:0 B3:1`, or early/middle/late for one book).
   - `self` — only their own words; `others` — mostly others' opinions;
   - `moment` — fewer than 3 chapters (2 for characters seen in <10 chapters);
   - `changes` — only in one book of several, or within a 35% stretch of one book;
   - `established` — everything else.
5. **Synthesise** (one call): themes are rendered by tier with their support. Only
   `established` themes may become archetype, summary, traits, flaws, values, fears,
   mannerisms or voice; `changes` go to `arc_pattern` as a movement; self-descriptions
   need established backing; others' views feed relationships; moments never headline.
   "One idea, one place" stops a quality repeating across fields.
6. **Portability check**: as before (rewrite pass, then quarantine to anchors).

Everything is saved in the `analysis` column: observations with locations, dialogue
lines, fingerprints of passages read, theme tiers, pass count. The API exposes only a
summary as `evidence`.

### Refine

`POST /api/characters/{id}/refine` (SSE, `{guidance}`): reads 3 more batches from
passages no earlier pass used, least-covered chapters first; merges the new
observations with the stored ones; regroups and re-tiers everything; then writes the
sheet **afresh** from all of it. When everything has been read it re-weighs the stored
evidence only. Profiles made before `analysis` existed get a full-size first pass.

> **Pitfall: never show the model the previous sheet.** The first version passed it as
> a draft to "review"; qwen3.6 returned it word for word (and its self-reported change
> notes claimed edits it had not made). Nothing supported is lost by rewriting, because
> the earlier observations are part of the evidence. The "what changed" list is a code
> diff (`_revision_notes`), not model output.

**Locks.** A hand edit (PATCH changing a generated field's value) adds that field to
`locked_fields`. Refine is shown only the locked fields, to keep the rest consistent
with them; the code then restores them verbatim, and both refine and re-profiling from the
extract page skip locked fields when saving. Locks are shown on the profile page and
removed by clicking them.

`source_book_ids` caveat still applies: the router unions the whole selection into each
candidate's sources before gathering evidence.

The corpus and name statistics are cached per selection (3 entries).

Progress streams over SSE (`started / progress / ok / error / done`).

## Creative writing

Route `/write`, layout mirrors `/chat`: character picker sidebar, genre picker below it,
prose on the right. Selection lives in the URL (`?chars=3,7`). Genre chips reuse
`genre_categories` from `GET /api/settings` and `genre_colors` through the existing
`genreCategory()` / `withAlpha()` helpers.

Fixed craft constraints in the system prompt:

```
Write in third person, past tense. At most 500 words. Prose only —
no preamble, no scene headings, no commentary.

Cast these characters into the setting the user describes. Keep their psychology,
voice and relational patterns. Do not import their original world unless asked.
```

Only portable fields are injected; `situational_anchors` stays out.

Full profiles are injected for up to 5 characters; beyond that the cast is condensed to
summary + traits + voice.

### Suggestion pills

The model ends its turn with a sentinel block:

```
<<<SUGGEST>>>
["...", "...", "..."]
<<<END>>>
```

The server buffers from the sentinel onward, never emits it as tokens, parses it at the
end, and attaches `suggestions: string[]` to the `done` event. Three beats in different
registers (raise the stakes / soften and turn romantic / unexpected and wry). Clicking a
pill **sends immediately**. If the sentinel never arrives, no pills are shown.

`POST /api/write/suggestions` regenerates just the three from the last exchange.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/characters` | list profiles (with `already_extracted` context) |
| POST | `/api/characters` | create a manual profile |
| GET | `/api/characters/{id}` | full profile |
| PATCH | `/api/characters/{id}` | partial update |
| DELETE | `/api/characters/{id}` | remove profile + sources + aliases |
| POST | `/api/characters/discover` | SSE: candidate list for `calibre_ids` |
| POST | `/api/characters/profiles` | SSE: generate profiles for selected candidates |
| POST | `/api/write/stream` | SSE: scene generation + suggestions |
| POST | `/api/write/suggestions` | regenerate the three pills |

Streaming endpoints need their own route handler under `frontend/src/app/api/…`, exactly
like `chat/stream/route.ts` — the `rewrites()` in `next.config.js` buffers bodies.

## Files

Backend: `lib/characters.py` (store), `lib/character_extractor.py`, `lib/writing.py`,
`backend/routers/characters.py`, `backend/routers/write.py`, plus edits to `main.py`,
`schemas.py`, `dependencies.py`, `models.py`, `chat.py`, `config.yaml`.

Frontend: `app/characters/page.tsx`, `app/characters/extract/page.tsx`,
`app/characters/[id]/page.tsx`, `app/write/page.tsx`,
`components/CharacterCard.tsx`, `components/CharacterPicker.tsx`,
`components/WritingInterface.tsx`, `types/character.ts`, `lib/api.ts`, `app/layout.tsx`,
`app/page.tsx` (👥 button), and the three SSE proxy route handlers.

The homepage 👥 button is disabled unless every selected book is indexed, with a tooltip
explaining why, and links to `/characters/extract?ids=…`.

## Build order

1. Config/model plumbing, `CharacterStore`, CRUD routes, `/characters` grid. No AI.
2. Discovery SSE, `/characters/extract`, homepage 👥 button.
3. Profile synthesis SSE, profile page (edit, extend sources).
4. Writing engine, `/write`, pills, regenerate-suggestions.
5. Polish: voice test, scene drafts in `data/scenes.json`.

## Out of scope

Relationship graphs, saving scenes to Obsidian (the bookmark feature covers that),
user-selectable POV or length (fixed at 3rd person past, ≤500 words).
