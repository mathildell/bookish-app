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

### Phase A — discovery (light, one LLM call per book)

Sample ~24–40 chunks spread across the book's chapters via
`ChatEngine.retrieve_chunks(..., calibre_ids=[cid])`, prompt for named characters only,
JSON out at temperature 0.2:

```jsonc
[{ "name": "Kvothe", "aliases": ["Kote", "the Bloodless"],
   "role": "protagonist",
   "description": "A gifted musician and arcanist remembered as a legend he insists he never was." }]
```

Only indexed books can be analysed — retrieval is the evidence source.

### Keeping places out of the cast

Sampled prose names places as often as people, so the first version returned cities and
factions as characters. Two defences, both in the prompt plus code:

- The **PERSON test** is stated as a rule the model must apply: an individual, or a named
group that acts as one. Places, houses, ships, objects, factions, prophecies and magic
systems fail it. The usable heuristic given to the model: *could an actor play it on a
stage?*
- The model must still **list** anything that fails the test, labelled with `kind`
  (`person` / `place` / `group` / `object` / `other`). Code then drops every non-`person`
entry and reports the names back to the UI, so nothing is silently swallowed — the user
can see that "Vere" was rejected and add it by hand if the model was wrong.

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

Interface: `discover(calibre_ids, titles, guidance)`, `discover_book(cid, guidance) ->
(candidates, rejected)`, `build_profile(..., guidance)`, `stream_profiles(requests, guidance)`;
`DiscoverRequest`/`ProfilesRequest` gain `guidance: str = ""`.

Results are merged across books in code (which gives `source_book_ids` for free) and each
entry is flagged `already_extracted` by lookup against `characters` + `character_aliases`.
Matches are **disabled in the UI**, not hidden, with a link to the profile and an
"update with these books" action when the selection adds a source.

### Nickname handling

Everything is one body of work, so only name matching can split a character. Normalise
before comparing: lowercase, strip punctuation, leading articles (`the`, `a`) **and**
honorifics (`mr|mrs|ms|miss|lady|lord|sir|dr`).

- new candidate matching an existing name or alias → auto-merge, union sources
- candidate whose alias collides with a *different* character → do **not** merge; flag as
  "possible duplicate" with a manual merge action
- `POST /api/characters/{id}/merge` unions sources + aliases and re-synthesises

### Phase B — deep profile (one synthesis call per character)

Evidence gathering needs no model: run a fixed query set through `retrieve_chunks`
against **every book in the run's selection** — the name, each alias, appearance,
felt/wanted, dialogue (`<name> said`), and each relationship — dedupe by chunk id, cap
at ~20–24k characters, label each excerpt `[cid:<id> - <title> - <chapter>]`.

> **Pitfall: `source_book_ids` is a discovery artifact, not a fact about the text.**
> Discovery reads 12 windows of ~700 characters per book, so a minor character is only
> recorded for the books whose windows happened to name them. Profiling from those
> sources alone silently narrows the evidence: Auguste was tagged with 2 of 3 books
> while occurring 21 times in the third. `ProfilesRequest.calibre_ids` therefore carries
> the whole selection and the router unions it with each candidate's own sources before
> gathering evidence — and that union is what gets recorded, because it is what
> informed the profile.

One synthesis call then returns the full profile JSON, with the de-situation rules above
and an explicit "only state what the excerpts support" guard, so appearance is never
invented. Malformed JSON is repaired once, then stored as `status='failed'` with the raw
error.

Progress streams over SSE (`started / book / evidence / done / error`) so cards fill in
one by one.

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
| POST | `/api/characters/{id}/merge` | merge another character into this one |
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
3. Profile synthesis SSE, profile page (edit, merge, extend sources).
4. Writing engine, `/write`, pills, regenerate-suggestions.
5. Polish: voice test, scene drafts in `data/scenes.json`.

## Out of scope

Relationship graphs, saving scenes to Obsidian (the bookmark feature covers that),
user-selectable POV or length (fixed at 3rd person past, ≤500 words).
