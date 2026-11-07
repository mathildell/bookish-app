"""Character discovery and deep-profile synthesis.

Two phases, deliberately different in cost:

* **Discovery** samples chunks spread across a book and asks for a cast list with
  one-line descriptions. One call per book.
* **Synthesis** gathers evidence by retrieval only (no model), then makes a single
  call per character. The profile is *personality-first*: anything that only makes
  sense inside the original story is translated into the trait it produced or moved
  to `situational_anchors`.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Iterator, Optional

from ollama import Client

from .characters import normalize_name
from .chat import ChatEngine
from .models import AppSettings

logger = logging.getLogger(__name__)

# Breadth beats depth for a cast list, but qwen3-vl sizes its reasoning to the
# prompt: a huge excerpt block makes it burn the whole num_predict budget before
# emitting any JSON (done_reason: "length"). Keep the block small.
_SAMPLE_CHUNKS = 12
_DISCOVERY_EXCERPT_CHARS = 700
_DISCOVERY_TEMPERATURE = 0.2
_DISCOVERY_TOKENS = 6144         # reasoning + JSON share this budget
_PROFILE_TEMPERATURE = 0.3
_PROFILE_TOKENS = 6144
_EVIDENCE_CHUNK_CHARS = 900
_EVIDENCE_BUDGET = 14000         # total characters of source text per profile
_EVIDENCE_PER_QUERY = 4

_DISCOVERY_SYSTEM = """You are cataloguing the recurring CAST of a work of fiction: the
people who act, speak and want things.

A candidate must pass three tests.

1. PERSON. A specific individual, or a named group that acts as one ("the Grey
   Company"). Places, cities, kingdoms, houses, ships, objects, weapons, factions,
   religions, prophecies, books, magic systems and concepts are NOT characters, no
   matter how often they are named. If an entry could not be played by an actor on
   a stage, it is not a character.
2. NAMED. It has a proper name in the text. Never "the innkeeper" or "his mother".
3. PRESENT. It actually appears or is referred to in these excerpts. Do not infer
   cast from your knowledge of the series.
4. MATTERS. A walk-on named once in passing, who never acts, wants or changes
   anything, is not worth listing. If you cannot tell whether they matter, list them
   anyway — but with the "minor" role, so they can be set aside.

"name" is the form used most often in the text. "aliases" lists every other name,
epithet, title or diminutive used for that character in these excerpts — characters
are often introduced by a title before their name.

"role" is one of: protagonist, antagonist, love-interest, mentor, supporting, minor.
Assign it by the character's FUNCTION in the story, not by how they feel to read:
- protagonist: the story follows them and their goal drives the plot.
- antagonist: their goal actively blocks a protagonist's. Cruelty, rudeness, a bad
temper or a single hostile scene is NOT enough. An ally who disagrees with the hero
is not an antagonist. Someone who is unpleasant but helps the plot along is
"supporting". If you are unsure, use "supporting".
- love-interest: a romantic thread with a principal character exists.
- mentor: guides or teaches a principal character.
- supporting: recurring, wants things, but does not drive the plot.
- minor: named once or twice.

"description" is ONE sentence about who they are as a person — temperament,
motivation, manner — never their plot situation or rank.

Return only a JSON array:
[{"name": "...", "aliases": ["..."], "kind": "person", "role": "...", "description": "..."}]

List anything that fails the PERSON test too, but label it honestly with "kind" as
"place", "group", "object" or "other". Those entries are discarded, so it costs you
nothing to mention them."""

# Models invent their own vocabulary for roles ("villain", "sidekick", "love interest").
# Map the common ones onto the canonical set so chips stay consistent.
_ROLE_ALIASES = {
    "main character": "protagonist",
    "main": "protagonist",
    "hero": "protagonist",
    "heroine": "protagonist",
    "villain": "antagonist",
    "antagonist/villain": "antagonist",
    "love interest": "love-interest",
    "romantic interest": "love-interest",
    "romance": "love-interest",
    "teacher": "mentor",
    "ally": "supporting",
    "sidekick": "supporting",
    "friend": "supporting",
    "secondary": "supporting",
    "supporting character": "supporting",
    "minor character": "minor",
    "background": "minor",
    "cameo": "minor",
}

_PROFILE_SYSTEM = """You are writing a character profile that must survive being transplanted.

The character will later be cast into a completely different setting — a fantasy
prince may be written as a barista in a contemporary romance. Every field must
therefore describe the PERSON, not their world.

Two rules, applied to every line you write:
1. CAUSE -> TRAIT. A formative experience is kept only if it explains core
   behaviour, and it is phrased as its meaning rather than its events. Good:
   "Raised their siblings alone after everything was taken, so love means
   sacrifice and rest feels like a debt." Bad: "Is the prince of Vintas."
2. PORTABILITY TEST. Could this line describe the same person working in a
   modern city? If not, either translate it into the trait it produced, or move
   the raw fact into "situational_anchors".

Only state what the excerpts support. If appearance is never described, say
"the text does not establish this" rather than inventing details.

Return only a JSON object with exactly these keys:
{
  "archetype": "short phrase, e.g. 'the prodigy who burned his own legend'",
  "summary": "one sentence, situation-free",
  "core_traits": ["4-7 adjectives"],
  "motivations": {"wants": "...", "needs": "..."},
  "fears": ["..."],
  "flaws": ["..."],
  "values": ["..."],
  "voice": {"tone": "speech register", "rhythm": "sentence shape",
            "tells": ["verbal habits, quoted if possible"], "humour": "..."},
  "mannerisms": ["physical habits and tells"],
  "appearance": {"signature": "only portable physical facts: build, colouring, marks, posture",
                 "presentation": "how they carry and present themselves"},
  "relationships": [{"dynamic": "reusable pattern, e.g. 'protective older sibling'",
                     "behaviour": "how the pattern shows up"}],
  "formative_experience": "2-4 sentences, cause -> trait",
  "arc_pattern": "the shape of their growth, from X to Y",
  "situational_anchors": ["canon facts that only make sense in the original world"]
}"""

_PROFILE_USER = """Character: {name}
Also known as: {aliases}
Role in the work: {role}
Existing one-line description: {description}
{guidance}
Excerpts from the work:
{evidence}

Write the profile JSON now."""


def _canonical_role(value) -> Optional[str]:
    role = str(value or "").strip().lower()
    if not role:
        return None
    role = _ROLE_ALIASES.get(role, role)
    return role[:32]


def _guidance_block(guidance: str) -> str:
    """The user's own casting notes, given authority over the model's reading."""
    return (
        "The user knows this work and is correcting your reading. Their notes are\n"
        "authoritative: when they contradict your inference, follow them.\n\n"
        f"{guidance.strip()}"
    )


def _parse_json(raw: str):
    """Pull the first JSON array/object out of a model reply."""
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|```$", "", text, flags=re.MULTILINE).strip()
    for opener, closer in (("[", "]"), ("{", "}")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError("The model did not return valid JSON")


def _as_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _as_dict(value, keys: tuple[str, ...]) -> dict:
    src = value if isinstance(value, dict) else {}
    return {key: str(src.get(key) or "").strip() for key in keys}


def _normalise_profile(data: dict, model: str) -> dict:
    voice = data.get("voice") or {}
    appearance = data.get("appearance") or {}
    motivations = data.get("motivations") or {}

    relationships = []
    for rel in data.get("relationships") or []:
        if isinstance(rel, dict):
            dynamic = str(rel.get("dynamic") or "").strip()
            behaviour = str(rel.get("behaviour") or "").strip()
            if dynamic or behaviour:
                relationships.append({"dynamic": dynamic, "behaviour": behaviour})

    return {
        "archetype": str(data.get("archetype") or "").strip() or None,
        "summary": str(data.get("summary") or "").strip() or None,
        "core_traits": _as_list(data.get("core_traits")),
        "motivations": _as_dict(motivations, ("wants", "needs")),
        "fears": _as_list(data.get("fears")),
        "flaws": _as_list(data.get("flaws")),
        "values": _as_list(data.get("values")),
        "voice": {
            "tone": str(voice.get("tone") or "").strip(),
            "rhythm": str(voice.get("rhythm") or "").strip(),
            "tells": _as_list(voice.get("tells")),
            "humour": str(voice.get("humour") or "").strip(),
        },
        "mannerisms": _as_list(data.get("mannerisms")),
        "appearance": {
            "signature": str(appearance.get("signature") or "").strip(),
            "presentation": str(appearance.get("presentation") or "").strip(),
        },
        "relationships": relationships,
        "formative_experience": str(data.get("formative_experience") or "").strip() or None,
        "arc_pattern": str(data.get("arc_pattern") or "").strip() or None,
        "situational_anchors": _as_list(data.get("situational_anchors")),
        "status": "complete",
        "error": None,
        "model": model,
    }


class CharacterExtractor:
    def __init__(self, settings: AppSettings, chat_engine: ChatEngine):
        self.s = settings
        self.chat = chat_engine
        self._ollama = Client(host=settings.ollama_base_url)

    # ------------------------------------------------------------------ #
    # Ollama                                                             #
    # ------------------------------------------------------------------ #

    def _complete(self, system: str, user: str, temperature: float, num_predict: int) -> str:
        """One blocking completion, with reasoning turned off.

        Extraction is a transcription task — the model is reporting what the text
        says, not solving a puzzle — so thinking only burns the token budget and
        pushes the JSON out of the reply.
        """
        kwargs = {
            "model": self.s.extraction_model_effective,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "options": {"temperature": temperature, "num_predict": num_predict},
        }
        try:
            response = self._ollama.chat(think=False, **kwargs)
        except TypeError:
            # ollama-python older than the `think` parameter.
            response = self._ollama.chat(**kwargs)

        content = (response.get("message") or {}).get("content") or ""
        if not content.strip():
            reason = response.get("done_reason") or "unknown"
            raise ValueError(f"The model returned no text (finish reason: {reason})")
        return content

    # ------------------------------------------------------------------ #
    # Phase A — discovery                                                #
    # ------------------------------------------------------------------ #

    def _sample_chunks(self, calibre_id: int) -> list[dict]:
        """Evenly spread samples across the book, not the first N chunks."""
        collection = self.chat.collection
        res = collection.get(where={"_cid": {"$in": [int(calibre_id)]}}, include=["metadatas"])
        ids = list(res.get("ids") or [])
        if not ids:
            return []
        if len(ids) > _SAMPLE_CHUNKS:
            step = len(ids) / _SAMPLE_CHUNKS
            ids = [ids[int(i * step)] for i in range(_SAMPLE_CHUNKS)]

        got = collection.get(ids=ids, include=["documents", "metadatas"])
        documents = got.get("documents") or []
        metadatas = got.get("metadatas") or []
        chunks = []
        for document, metadata in zip(documents, metadatas):
            metadata = metadata or {}
            chunks.append({
                "text": document or "",
                "title": metadata.get("title") or "",
                "chapter": metadata.get("_chapter") or "",
            })
        return chunks

    def discover_book(self, calibre_id: int, guidance: str = "") -> tuple[list[dict], list[dict]]:
        """One book's cast list, plus the entries rejected as non-characters."""
        chunks = self._sample_chunks(calibre_id)
        if not chunks:
            return [], []
        title = chunks[0]["title"] or f"book #{calibre_id}"
        excerpts = "\n\n".join(
            f"[{c['chapter'] or 'excerpt'}]\n{c['text'][:_DISCOVERY_EXCERPT_CHARS]}" for c in chunks
        )
        prompt = f'Book: "{title}"\n\nExcerpts:\n{excerpts}'
        if guidance.strip():
            prompt += "\n\n" + _guidance_block(guidance)
        raw = self._complete(
            _DISCOVERY_SYSTEM,
            prompt + "\n\nReturn the JSON array now.",
            _DISCOVERY_TEMPERATURE,
            _DISCOVERY_TOKENS,
        )
        parsed = _parse_json(raw)
        if isinstance(parsed, dict):
            parsed = parsed.get("characters") or []
        if not isinstance(parsed, list):
            raise ValueError("Unexpected discovery payload")

        candidates: list[dict] = []
        rejected: list[dict] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            kind = str(item.get("kind") or "person").strip().lower()
            if kind not in ("", "person", "character"):
                # A place, faction or object that the model named as cast. Keep the
                # name so the UI can report what was dropped, but never profile it.
                rejected.append({"name": name, "kind": kind})
                continue
            candidates.append({
                "name": name,
                "aliases": [a for a in _as_list(item.get("aliases")) if normalize_name(a) != normalize_name(name)],
                "role": _canonical_role(item.get("role")),
                "description": str(item.get("description") or "").strip() or None,
                "source_book_ids": [int(calibre_id)],
            })
        return candidates, rejected

    @staticmethod
    def _keys(candidate: dict) -> set[str]:
        keys = {normalize_name(candidate["name"])}
        keys.update(normalize_name(a) for a in candidate.get("aliases") or [])
        keys.discard("")
        return keys

    def discover(
        self,
        calibre_ids: list[int],
        titles: Optional[dict[int, str]] = None,
        guidance: str = "",
    ) -> Iterator[dict]:
        """Yield progress events, ending with the merged candidate list."""
        titles = titles or {}
        merged: dict[str, dict] = {}
        errors: list[dict] = []
        filtered: list[dict] = []

        for calibre_id in calibre_ids:
            title = titles.get(calibre_id) or f"#{calibre_id}"
            yield {"event": "book", "calibre_id": calibre_id, "title": title}
            try:
                found, rejected = self.discover_book(calibre_id, guidance)
                filtered.extend(rejected)
            except Exception as exc:  # noqa: BLE001 — reported per book, not fatal
                logger.warning("Discovery failed for %s", calibre_id, exc_info=exc)
                errors.append({"calibre_id": calibre_id, "title": title, "error": str(exc)})
                yield {"event": "error", "calibre_id": calibre_id, "title": title, "error": str(exc)}
                continue

            for candidate in found:
                candidate_keys = self._keys(candidate)
                match = None
                for entry in merged.values():
                    if candidate_keys & self._keys(entry):
                        match = entry
                        break

                if match is None:
                    merged[normalize_name(candidate["name"])] = candidate
                else:
                    # Same person under another name: union the names and sources.
                    known = {normalize_name(match["name"]), *(normalize_name(a) for a in match["aliases"])}
                    for alias in [candidate["name"], *candidate["aliases"]]:
                        if normalize_name(alias) not in known:
                            match["aliases"].append(alias)
                            known.add(normalize_name(alias))
                    for source in candidate["source_book_ids"]:
                        if source not in match["source_book_ids"]:
                            match["source_book_ids"].append(source)
                    match["role"] = match.get("role") or candidate.get("role")
                    match["description"] = match.get("description") or candidate.get("description")

            yield {"event": "found", "calibre_id": calibre_id, "count": len(found)}

        yield {
            "event": "candidates",
            "candidates": sorted(merged.values(), key=lambda c: normalize_name(c["name"])),
            "filtered": filtered,
            "errors": errors,
        }

    # ------------------------------------------------------------------ #
    # Phase B — synthesis                                                #
    # ------------------------------------------------------------------ #

    def gather_evidence(self, name: str, aliases: list[str], calibre_ids: list[int]) -> list[dict]:
        queries = [
            name,
            f"{name} appearance",
            f"{name} wanted felt feared",
            f"{name} said",
        ]
        queries.extend(aliases[:3])

        seen: set[str] = set()
        scored: list[dict] = []
        for calibre_id in calibre_ids:
            for query in queries:
                try:
                    found = self.chat.retrieve_chunks(query=query, calibre_ids=[calibre_id], n=_EVIDENCE_PER_QUERY)
                except RuntimeError:
                    raise
                for chunk in found:
                    if chunk["id"] in seen:
                        continue
                    seen.add(chunk["id"])
                    scored.append(chunk)

        scored.sort(key=lambda c: c.get("distance") or 0.0)

        evidence: list[dict] = []
        budget = 0
        for chunk in scored:
            snippet = (chunk.get("text") or "")[:_EVIDENCE_CHUNK_CHARS]
            if budget + len(snippet) > _EVIDENCE_BUDGET:
                break
            budget += len(snippet)
            evidence.append({**chunk, "text": snippet})
        return evidence

    def build_profile(
        self,
        name: str,
        aliases: Optional[list[str]] = None,
        calibre_ids: Optional[list[int]] = None,
        role: Optional[str] = None,
        description: Optional[str] = None,
        guidance: str = "",
    ) -> dict:
        aliases = aliases or []
        calibre_ids = calibre_ids or []
        evidence = self.gather_evidence(name, aliases, calibre_ids)
        if not evidence:
            raise RuntimeError(
                "No indexed text found for this character — are the source books indexed?"
            )

        blocks = "\n\n".join(
            f"[cid:{c.get('book_id')} — {c.get('book_title') or 'unknown'} — {c.get('chapter') or 'chapter unknown'}]\n{c['text']}"
            for c in evidence
        )
        raw = self._complete(
            _PROFILE_SYSTEM,
            _PROFILE_USER.format(
                name=name,
                aliases=", ".join(aliases) or "none",
                role=role or "unknown",
                description=description or "none given",
                guidance=("\n" + _guidance_block(guidance) + "\n") if guidance.strip() else "",
                evidence=blocks,
            ),
            _PROFILE_TEMPERATURE,
            _PROFILE_TOKENS,
        )
        parsed = _parse_json(raw)
        if not isinstance(parsed, dict):
            raise ValueError("The model returned a list where a profile object was expected")
        return _normalise_profile(parsed, self.s.extraction_model_effective)

    def stream_profiles(self, requests: list[dict], guidance: str = "") -> Iterator[dict]:
        """Yield one event per character so the UI can fill cards as they land."""
        for item in requests:
            name = item["name"]
            yield {"event": "started", "name": name}
            try:
                profile = self.build_profile(
                    name=name,
                    aliases=item.get("aliases") or [],
                    calibre_ids=item.get("calibre_ids") or [],
                    role=item.get("role"),
                    description=item.get("description"),
                    guidance=guidance,
                )
            except Exception as exc:  # noqa: BLE001 — one failure must not stop the rest
                logger.warning("Profile synthesis failed for %s", name, exc_info=exc)
                yield {"event": "error", "name": name, "error": str(exc)}
                continue
            yield {"event": "ok", "name": name, "profile": profile}
        yield {"event": "done"}
