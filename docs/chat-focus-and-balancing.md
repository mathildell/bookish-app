# Chat: focus and balancing issues

Notes about the unified `/chat` page. The page and its book picker are shipped; the
retrieval problems below are **known and intentionally deferred**. Read this before
trusting a "focused" or "comparing" answer.

## What the page does today

The book selection is the mode:

| Selection | UI | `scope` sent to the API | `calibre_ids` sent |
| --- | --- | --- | --- |
| none | "Whole library" | `book` | omitted |
| 1 book | "1 book in focus" | `book` | `[id]` |
| 2+ books | "Comparing N books" | `multi_book` | `[id, …]` |

Changing the selection remounts `ChatInterface` (keyed by the id list), so history
from one context cannot bleed into another. The URL carries `?ids=` and
`/multi-chat?ids=…` redirects to `/chat?ids=…`.

## Issue 1 — the selection does not constrain retrieval

`lib/chat.py`, `ChatEngine._retrieve_chunks`:

```python
where_filter = {}
if calibre_ids:
    ids_as_strings = [str(i) for i in calibre_ids]
    where_filter["_cid"] = ids_as_strings

results = self.collection.query(
    query_embeddings=[q_emb],
    n_results=k,
    include=["distances", "documents", "metadatas"],
)   # <-- where_filter is never passed
```

`where_filter` is built and discarded, so **every** chat currently searches the whole
library: book chat, single-book focus and multi-book compare. The only thing that
changes between modes is the system prompt in `SYSTEM_TEMPLATES`.

Consequences:

- "Ask about this book" can answer from passages belonging to another book. The
  citations usually reveal it, but the answer is already wrong.
- "Comparing N books" is not guaranteed to be comparing those N books.
- The picker's selection is currently a *label*, not a filter.

### Fix sketch

Chroma's `_cid` metadata is written as an **int** (`lib/ingestor.py`:
`"_cid": book.calibre_id`, and deletion uses `where={"_cid": calibre_id}`), so pass
ints, not the strings currently built:

```python
where = None
if calibre_ids:
    where = {"_cid": {"$in": [int(i) for i in calibre_ids]}}

results = self.collection.query(
    query_embeddings=[q_emb],
    n_results=k,
    include=["distances", "documents", "metadatas"],
    where=where,
)
```

Two things to check while doing it:

1. `$in` support depends on the installed Chroma version. If it is unavailable,
   fall back to one query per id (see Issue 2) or `{"$or": [{"_cid": id} …]}`.
2. `ChatEngine.chat()` has the same call path, so fixing `_retrieve_chunks` fixes both
   the streaming endpoint and the non-streaming engine.

Verify with a term that appears in exactly one book (a character name, a coined
phrase). Ask for it with another book selected: the answer must say it cannot find
it, and citations must be empty or from the selected book only.

## Issue 2 — `top_k` is a shared budget, so large selections dilute

`top_k` defaults to 8 (`config.yaml` → `ingestion.top_k`). With 5 books selected,
those 8 chunks can all come from book 1 — the "comparison" then quietly becomes a
single-book answer with four silent extras. With 20+ books it is near-certain.

The current ranking also has no per-book fairness: it is pure vector distance over an
unfiltered (see Issue 1) index.

### Fix sketch — per-book quota

Embed the question once, query each selected book for its share, then merge by
distance:

```python
def _retrieve_chunks(self, query, calibre_ids=None, n=None):
    k = n or self.s.top_k
    q_emb = self._embed(query)            # embed once, reuse below

    if not calibre_ids:
        return self._query(q_emb, k)

    per_book = max(2, k // len(calibre_ids))
    chunks = []
    for cid in calibre_ids:
        chunks.extend(self._query(q_emb, per_book, where={"_cid": int(cid)}))
    chunks.sort(key=lambda c: c["distance"])
    return chunks[:k]
```

Tradeoffs to decide before implementing:

- **Cost/latency:** N queries instead of 1. Each is small, but a 20-book comparison
  does 20 round-trips to the local Chroma collection. Consider a cap (e.g. 10 books)
  or parallelising.
- **Books with no good match:** a fixed quota can pull in irrelevant passages just to
  fill a slot. Prefer "up to `per_book`" plus a distance threshold, and let the merged
  list be shorter than `k` when nothing is relevant.
- **Uneven sizes:** one very large book will dominate its own quota; that is fine, it
  is still equally represented.
- Alternative: raise `top_k` proportionally to `len(calibre_ids)` (simple, but makes
  prompts long and slow).
- Also worth adding: dedupe near-identical chunks and cap 2 chunks per book per answer
  for a cleaner comparison.

## Issue 3 — mode is decided client-side

`/chat` derives `scope` from the id count and the API trusts it
(`backend/routers/chat.py` → `SYSTEM_TEMPLATES.get(req.scope, …)`). Two clients can
disagree, and a stale tab can send `book` with 6 ids. Cheap hardening: derive the
scope on the server from `len(req.calibre_ids)` and add a third template for the
whole-library case (currently it reuses the single-book prompt).

## Testing checklist for the fix

1. Unique-phrase test per book (Issue 1 verification).
2. 3-book comparison where the answer to a question exists in only one book: the
   other books must be represented or explicitly reported as lacking context.
3. A 10-book comparison: check citation spread and answer latency.
4. Confirm `n_results` is not exceeded per book and that empty books return nothing
   rather than padding.
