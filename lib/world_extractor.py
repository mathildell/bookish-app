"""Worldbuilding extraction: read a set of books, write one sheet about their world.

The method mirrors character extraction. Passages are sampled evenly across every
selected book (a rule stated once in chapter two matters as much as one in the
finale), a model records what each batch *shows* about the world with a verbatim
quote, quotes that are not really in the text are discarded, and a final call
consolidates the surviving notes into a sheet. Where the books disagree — every
omegaverse author bends the rules differently — the disagreement is kept as a
variant instead of being averaged away.
"""

from __future__ import annotations

import json
import logging
from typing import Iterator, Optional

from .book_text import Chunk, load_corpus
from .character_extractor import CharacterExtractor, _quote_in, _squash

logger = logging.getLogger(__name__)

# Total passages read across the whole selection, and how many go to the model at once.
_PASSAGE_BUDGET = 72
_BATCH_SIZE = 8
# Keeps one very long paragraph from crowding out the others in a batch.
_PASSAGE_CHARS = 1800

_CATEGORIES = ("rule", "society", "trope", "setting", "term", "tension")

_OBSERVE_SYSTEM = """You are reading excerpts from fiction to record what they SHOW about the
fictional WORLD: its mechanics, society and conventions. Another step will turn your
notes into a worldbuilding sheet, so your only job is accurate observation.

Record a note only when the excerpt makes it clear. Never record what a particular
character feels or does as a person; record the world that explains it.

Each note has:
- "category":
    rule     — a mechanic of how this world works that a new story would have to
               obey (biology, magic, technology, law of nature). State it as a
               general fact, not as one scene.
    society  — how people are organised: hierarchy, law, class, institutions,
               etiquette, what is taboo or expected.
    trope    — a convention or pattern the setting runs on that readers of this
               kind of story expect.
    setting  — a typical place or atmosphere (what it looks, smells or feels like).
    term     — an in-world word or phrase with a specific meaning. Put the word in
               "term" and its meaning in "note".
    tension  — a conflict or pressure the world itself produces.
- "note": one short, general sentence. No character names, no plot events.
- "term": only for category "term", else "".
- "quote": a short verbatim quotation (at most 25 words) copied exactly from the
  excerpts that supports it. Notes without an exact quote are discarded.

Each excerpt is labelled with its book. Cover the whole batch. Prefer what recurs over
what is mentioned once. Return JSON only."""

_OBSERVE_USER = """{guidance}Excerpts:
{evidence}

Record what these excerpts show about the world."""

_CONSOLIDATE_SYSTEM = """You are writing a worldbuilding sheet that a writer will use to set NEW stories in
this world. You are given notes recorded from {count} book(s), each with the book it came
from. Merge them into one sheet.

Rules:
- Use only what the notes support. Do not add what you remember from the books or the
  genre; leave a field empty rather than invent.
- "premise": 2-4 sentences. What is different about this world, and what does everyday
  life look like because of it?
- "rules": the hard mechanics, one declarative sentence each, most important first.
- "social_structure": hierarchy, law, class, norms, taboos.
- "tropes": the conventions the setting runs on.
- "settings": typical places and atmospheres, as short descriptive phrases.
- "terminology": in-world terms with a one-line meaning each.
- "tensions": conflicts the world itself generates, useful as story engines.
- "variants": where the books DISAGREE or one book bends a rule, written like
  "Most books: X; one book: Y". Only real disagreements the notes show.
- Merge duplicates. Drop anything specific to one character or one plot.
- No character names in any field.
- Name the book in a variant when the notes say which one ("Most books: X; <title>: Y").
Return JSON only."""

_REFINE_ADDENDUM = """

You are also given the CURRENT SHEET, written from earlier reading. Revise it rather than
starting over:
- Keep every current entry that the notes do not contradict, even if no note repeats it:
  earlier notes are not all shown again.
- Add what the new notes show. Where a new note sharpens or corrects an entry, replace
  that entry.
- Merge near-duplicates. Keep each list tight: precise beats exhaustive.
- Fields in LOCKED are written by the user: copy them through unchanged.
- DECISIONS were settled by the writer between disagreeing sources. They are final: keep
  the sheet consistent with them, and never list a settled point under "variants"."""

_PRIMARY_ADDENDUM = """

PRIMARY CANON: {titles}. When the notes from these books disagree with notes from other
books, the primary books are right: write their version, and do not list it as a variant.
Use "where the books differ" only for disagreements among the other books, or where a
non-primary book adds something the primary ones do not contradict."""

# How hard a refine leans on a book when sampling passages.
BOOST = {"normal": 1.0, "emphasise": 3.0, "primary": 3.0}

_CONSOLIDATE_USER = """{guidance}World name: {name}
{current}
Notes:
{notes}

Write the sheet."""


def _str_list() -> dict:
    return {"type": "array", "items": {"type": "string"}}


_OBSERVE_SCHEMA = {
    "type": "object",
    "properties": {
        "notes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": list(_CATEGORIES)},
                    "note": {"type": "string"},
                    "term": {"type": "string"},
                    "quote": {"type": "string"},
                },
                "required": ["category", "note", "quote"],
            },
        }
    },
    "required": ["notes"],
}

_SHEET_SCHEMA = {
    "type": "object",
    "properties": {
        "premise": {"type": "string"},
        "rules": _str_list(),
        "social_structure": _str_list(),
        "tropes": _str_list(),
        "settings": _str_list(),
        "terminology": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"term": {"type": "string"}, "meaning": {"type": "string"}},
                "required": ["term", "meaning"],
            },
        },
        "tensions": _str_list(),
        "variants": _str_list(),
    },
    "required": ["premise", "rules"],
}

_CATEGORY_LABEL = {
    "rule": "RULES",
    "society": "SOCIETY",
    "trope": "TROPES",
    "setting": "SETTINGS",
    "term": "TERMS",
    "tension": "TENSIONS",
}


def _clean(items) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items or []:
        text = " ".join(str(item).split())
        if text and text.lower() not in seen:
            seen.add(text.lower())
            out.append(text)
    return out


def passage_key(chunk: Chunk) -> str:
    """Stable id of a passage: the book and its chunk number within the book."""
    return f"{chunk.book_id}:{chunk.order}"


def sample_passages(
    chunks_by_book: list[list[Chunk]],
    budget: int,
    exclude: Optional[set[str]] = None,
    boost: Optional[dict[int, float]] = None,
) -> list[tuple[int, Chunk]]:
    """Evenly spaced chunks from every book, (book number, chunk), in reading order.

    Passages in *exclude* (already read by an earlier pass) are skipped, so repeated
    passes cover new ground. The budget is split across books in proportion to what is
    left of them, with at least a few from each so a short book is still represented.
    *boost* maps a book id to a multiplier (newly added or emphasised sources).
    """
    exclude = exclude or set()
    boost = boost or {}
    remaining = [[c for c in chunks if passage_key(c) not in exclude] for chunks in chunks_by_book]
    weight = [
        len(rest) * (boost.get(rest[0].book_id, 1.0) if rest else 1.0) for rest in remaining
    ]
    total = sum(weight) or 1
    picked: list[tuple[int, Chunk]] = []
    for number, rest in enumerate(remaining, start=1):
        if not rest:
            continue
        share = min(len(rest), max(4, round(budget * weight[number - 1] / total)))
        step = len(rest) / share
        for i in range(share):
            picked.append((number, rest[min(len(rest) - 1, int(i * step + step / 2))]))
    return picked


# Older notes are dropped first once this many are held, so the final call's input
# (and the stored analysis) stays bounded however many passes are made.
_MAX_NOTES = 500

_SHEET_KEYS = (
    "premise", "rules", "social_structure", "tropes", "settings",
    "terminology", "tensions", "variants",
)


def _guidance(text: str) -> str:
    text = (text or "").strip()
    if not text:
        return ""
    return f"The reader's notes (authoritative — follow them):\n{text}\n\n"


def _book_label(book_id: int, titles: dict[int, str]) -> str:
    return titles.get(book_id) or f"book #{book_id}"


def _render_notes(notes: list[dict], titles: dict[int, str]) -> str:
    groups: dict[str, list[str]] = {}
    for item in notes:
        books = ", ".join(_book_label(b, titles) for b in item.get("books") or [])
        text = f"{item['term']}: {item['note']}" if item.get("term") else item["note"]
        groups.setdefault(item["category"], []).append(f"- [{books}] {text}")
    return "\n\n".join(
        f"{_CATEGORY_LABEL[cat]}\n" + "\n".join(lines)
        for cat, lines in groups.items()
        if cat in _CATEGORY_LABEL
    )


def _merge_notes(old: list[dict], new: list[dict]) -> list[dict]:
    """Old notes then new ones, duplicates (by wording) merged, oldest dropped past the cap."""
    merged: dict[tuple[str, str], dict] = {}
    for item in [*old, *new]:
        key = (item.get("category", ""), " ".join(str(item.get("note", "")).lower().split()))
        if key in merged:
            merged[key]["books"] = sorted(set(merged[key].get("books") or []) | set(item.get("books") or []))
        else:
            merged[key] = {**item, "books": sorted(set(item.get("books") or []))}
    return list(merged.values())[-_MAX_NOTES:]


class WorldExtractor:
    """Builds a worldbuilding sheet from books, on top of the character extractor's Ollama plumbing."""

    def __init__(self, extractor: CharacterExtractor):
        self._x = extractor

    def extract(
        self,
        calibre_ids: list[int],
        titles: dict[int, str],
        name: str,
        guidance: str = "",
    ) -> Iterator[dict]:
        """A first pass over the books. Yields `progress` events, then `ok` or `error`."""
        yield from self._run(calibre_ids, titles, name, guidance)

    def refine(
        self,
        world: dict,
        calibre_ids: list[int],
        titles: dict[int, str],
        guidance: str = "",
        new_ids: Optional[list[int]] = None,
    ) -> Iterator[dict]:
        """Another pass over a saved world: new passages, and any newly added books.

        Reads only passages earlier passes did not, merges the new notes with the stored
        ones, and revises the sheet against all of them. Locked fields pass through.
        """
        # A newly added book is read hard at least once, whatever weight it was given.
        weights = {int(k): v for k, v in (world.get("source_weights") or {}).items()}
        boost = {b: BOOST.get(level, 1.0) for b, level in weights.items()}
        for book in new_ids or []:
            boost[book] = max(boost.get(book, 1.0), 3.0)
        primary = [b for b, level in weights.items() if level == "primary" and b in calibre_ids]
        yield from self._run(
            calibre_ids, titles, world["name"], guidance, existing=world, boost=boost, primary=primary
        )

    # ------------------------------------------------------------------ #

    def _run(
        self,
        calibre_ids: list[int],
        titles: dict[int, str],
        name: str,
        guidance: str,
        existing: Optional[dict] = None,
        boost: Optional[dict[int, float]] = None,
        primary: Optional[list[int]] = None,
    ) -> Iterator[dict]:
        collection = self._x.chat.collection
        ids = list(dict.fromkeys(int(c) for c in calibre_ids))
        before = (existing or {}).get("analysis") or {}
        old_notes: list[dict] = list(before.get("notes") or [])
        used: set[str] = set(before.get("used") or [])

        chunks_by_book: list[list[Chunk]] = []
        readable: list[int] = []
        for calibre_id in ids:
            title = _book_label(calibre_id, titles)
            yield {"event": "progress", "message": f"Reading “{title}”…"}
            corpus = load_corpus(collection, [calibre_id])
            if not corpus.chunks:
                yield {"event": "progress", "message": f"Skipped “{title}” — no story text (is it indexed?)"}
                continue
            chunks_by_book.append(corpus.chunks)
            readable.append(calibre_id)

        if not readable:
            yield {"event": "error", "error": "None of the selected books has indexed story text."}
            return

        passages = sample_passages(chunks_by_book, _PASSAGE_BUDGET, exclude=used, boost=boost)
        if not passages:
            yield {"event": "error", "error": "Every passage of these books has already been read."}
            return

        note_guidance = _guidance(guidance)
        new_notes: list[dict] = []
        # A batch never mixes books, so every note is attributable to exactly one: a
        # per-book reset and "primary" canon both depend on that.
        batches: list[list[tuple[int, Chunk]]] = []
        for number in sorted({n for n, _ in passages}):
            own = [p for p in passages if p[0] == number]
            batches.extend(own[i : i + _BATCH_SIZE] for i in range(0, len(own), _BATCH_SIZE))

        for index, batch in enumerate(batches, start=1):
            yield {"event": "progress", "message": f"Noting the world — batch {index} of {len(batches)}…"}
            evidence = "\n\n".join(
                f"[Book {number}: {chunk.title or 'untitled'}]\n{chunk.text[:_PASSAGE_CHARS]}"
                for number, chunk in batch
            )
            haystack = _squash(evidence)
            try:
                reply = self._x._complete(
                    _OBSERVE_SYSTEM,
                    _OBSERVE_USER.format(guidance=note_guidance, evidence=evidence),
                    temperature=0.2,
                    num_predict=3000,
                    schema=_OBSERVE_SCHEMA,
                )
            except Exception as exc:  # noqa: BLE001 — one bad batch must not sink the run
                logger.warning("World batch %s failed", index, exc_info=exc)
                continue
            # The model only sees ordinals; map them back to the books they stand for.
            books_in_batch = sorted({readable[number - 1] for number, _ in batch})
            used.update(passage_key(chunk) for _, chunk in batch)
            for item in (reply.get("notes") if isinstance(reply, dict) else None) or []:
                category = str(item.get("category") or "")
                note = " ".join(str(item.get("note") or "").split())
                quote = _squash(str(item.get("quote") or ""))
                if category not in _CATEGORIES or not note or not _quote_in(quote, haystack):
                    continue
                new_notes.append({
                    "category": category,
                    "note": note,
                    "term": " ".join(str(item.get("term") or "").split()),
                    "books": books_in_batch,
                })

        notes = _merge_notes(old_notes, new_notes)
        if not new_notes and not existing:
            yield {"event": "error", "error": "The model recorded no verifiable worldbuilding from these books."}
            return
        if not notes:
            yield {"event": "error", "error": "No worldbuilding could be verified from these passages."}
            return

        yield {
            "event": "progress",
            "message": (
                f"{len(new_notes)} new notes ({len(notes)} in all). Writing the sheet…"
                if existing
                else f"Writing the sheet from {len(notes)} notes…"
            ),
        }

        system = _CONSOLIDATE_SYSTEM.format(count=len(readable))
        if primary:
            system += _PRIMARY_ADDENDUM.format(titles=", ".join(_book_label(b, titles) for b in primary))
        current = ""
        if existing:
            system += _REFINE_ADDENDUM
            locked = [f for f in existing.get("locked_fields") or [] if f in _SHEET_KEYS]
            sheet_now = {key: existing.get(key) for key in _SHEET_KEYS}
            decisions = [d for d in existing.get("decisions") or [] if str(d).strip()]
            current = (
                "\nCURRENT SHEET:\n" + json.dumps(sheet_now, ensure_ascii=False)
                + ("\nLOCKED: " + ", ".join(locked) if locked else "")
                + ("\nDECISIONS:\n" + "\n".join(f"- {d}" for d in decisions) if decisions else "")
                + "\n"
            )
        try:
            sheet = self._x._complete(
                system,
                _CONSOLIDATE_USER.format(
                    guidance=note_guidance, name=name, current=current,
                    notes=_render_notes(notes, titles),
                ),
                temperature=0.3,
                num_predict=4000,
                schema=_SHEET_SCHEMA,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("World consolidation failed", exc_info=exc)
            yield {"event": "error", "error": f"Could not write the sheet: {exc}"}
            return
        if not isinstance(sheet, dict):
            yield {"event": "error", "error": "The model returned no sheet."}
            return

        terminology = []
        for entry in sheet.get("terminology") or []:
            if isinstance(entry, dict) and str(entry.get("term") or "").strip():
                terminology.append({
                    "term": str(entry["term"]).strip(),
                    "meaning": " ".join(str(entry.get("meaning") or "").split()),
                })

        yield {
            "event": "ok",
            "added_notes": len(new_notes),
            "sheet": {
                "premise": " ".join(str(sheet.get("premise") or "").split()),
                "rules": _clean(sheet.get("rules")),
                "social_structure": _clean(sheet.get("social_structure")),
                "tropes": _clean(sheet.get("tropes")),
                "settings": _clean(sheet.get("settings")),
                "terminology": terminology,
                "tensions": _clean(sheet.get("tensions")),
                "variants": _clean(sheet.get("variants")),
                "model": self._x.s.extraction_model_effective,
                "analysis": {
                    "notes": notes,
                    "used": sorted(used),
                    "passes": int(before.get("passes") or 0) + 1,
                },
            },
            "sources": readable,
        }


# --------------------------------------------------------------------------- #
# Settling a disagreement                                                     #
# --------------------------------------------------------------------------- #

# Entries a decision may rewrite. Terminology and the premise are left alone: they are
# not where a disputed mechanic lives, and rewriting them blind loses more than it fixes.
RESOLVABLE = ("rules", "social_structure", "tropes", "settings", "tensions")

_RESOLVE_SYSTEM = """You maintain a worldbuilding sheet. Its sources disagreed about something, and the
writer has now DECIDED which version is right. Your job is to make the sheet agree with
the decision, with the fewest possible edits.

You get the DISAGREEMENT, the DECISION (final, even if the sheet says otherwise), and
the sheet's current entries, numbered within each field. Return the changes needed:
- "field": one of the fields given.
- "old": the EXACT text of an existing entry to replace or remove; "" when only adding.
- "new": the replacement or added text; "" when only removing. One short declarative
  sentence in the sheet's own style, with no hedging and no mention of the disagreement.

Guidance:
- Replace or remove every entry that contradicts the decision, wherever it is. When only
  part of an entry is disputed, keep the rest of it: change the disputed part only.
- If no entry states the decision, add it (usually as a rule).
- Leave unrelated entries alone. Make at most 4 changes.
- If the sheet already agrees with the decision and nothing contradicts it, return no
  changes.
Return JSON only."""

_RESOLVE_SCHEMA = {
    "type": "object",
    "properties": {
        "changes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string", "enum": list(RESOLVABLE)},
                    "old": {"type": "string"},
                    "new": {"type": "string"},
                },
                "required": ["field", "old", "new"],
            },
        }
    },
    "required": ["changes"],
}


def apply_changes(world: dict, changes: list[dict], locked: set[str]) -> tuple[dict, list[str]]:
    """Apply replace/remove/add edits to a world's lists. Returns (new fields, what was done).

    An "old" entry is matched exactly, else by close similarity, since models re-punctuate
    when they copy. Locked fields are never touched.
    """
    import difflib

    lists = {f: list(world.get(f) or []) for f in RESOLVABLE}
    done: list[str] = []
    for change in changes[:4]:
        field = change.get("field")
        if field not in lists or field in locked:
            continue
        old = " ".join(str(change.get("old") or "").split())
        new = " ".join(str(change.get("new") or "").split())
        entries = lists[field]
        index = next((i for i, e in enumerate(entries) if " ".join(e.split()) == old), None) if old else None
        if old and index is None:
            close = difflib.get_close_matches(old, entries, n=1, cutoff=0.85)
            index = entries.index(close[0]) if close else None
        if old and index is None:
            if new:  # could not find what to replace: add the new entry instead
                entries.append(new)
                done.append(f"Added to {field}: {new}")
            continue
        if old and new:
            entries[index] = new
            done.append(f"Replaced in {field}: {new}")
        elif old:
            del entries[index]
            done.append(f"Removed from {field}: {old}")
        elif new and new not in entries:
            entries.append(new)
            done.append(f"Added to {field}: {new}")
    return {f: v for f, v in lists.items() if v != list(world.get(f) or [])}, done


def resolve_variant(extractor: "WorldExtractor", world: dict, variant: str, decision: str) -> list[dict]:
    """Ask the model for the edits that make the sheet agree with *decision*."""
    sheet = "\n\n".join(
        f"{field}:\n" + ("\n".join(f"{i}. {e}" for i, e in enumerate(world.get(field) or [], 1)) or "(empty)")
        for field in RESOLVABLE
    )
    user = f"DISAGREEMENT: {variant}\n\nDECISION: {decision}\n\nSHEET:\n{sheet}"
    reply = extractor._x._complete(
        _RESOLVE_SYSTEM, user, temperature=0.1, num_predict=1500, schema=_RESOLVE_SCHEMA
    )
    changes = reply.get("changes") if isinstance(reply, dict) else None
    return [c for c in changes or [] if isinstance(c, dict)]
