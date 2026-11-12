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
import time
from typing import Iterator, Optional

import httpx
from ollama import Client

from .characters import normalize_name
from .chat import ChatEngine
from .llm import chat_without_thinking
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

# Ollama serialises requests per model instance and a *non-streaming* request
# cannot be cancelled by the client at all: one slow generation holds the runner
# until it reaches num_predict, and every later chat/extraction/scene request
# queues behind it with no output — which reads as a frozen app. Streaming plus a
# deadline lets us drop the connection, which is what makes Ollama abort.
_READ_TIMEOUT = 180.0
_CONNECT_TIMEOUT = 15.0
_DEADLINE_SECONDS = 600.0

# Words that make an alias a *title* rather than an identity. In a two-hander every
# principal is "the prince" or "the captain" at some point, so these can never be
# attributed reliably — and they were the main way two characters got fused.
_TITLE_WORDS = frozenset("""
prince princes princess king kings queen queens lord lords lady ladies duke duchess
count countess baron baroness emperor empress heir pretender regent consort steward
captain commander general admiral colonel lieutenant sergeant soldier knight squire
guard guards slave slaves servant servants master mistress sir madam madame
highness majesty excellency grace chieftain chief warlord page boy girl man woman
brother sister son daughter father mother uncle aunt cousin nephew niece
""".split())
_NOISE_TOKENS = frozenset("the a an of my his her their our your and de von van".split())

# "the herald", "the dying man", "the soldier" are descriptions, not identities.
# Some are real handles though ("the Regent"), so a description is only rejected
# when the books barely use it.
_GENERIC_NAME_RE = re.compile(r"^(?:the|a|an)\s+\S", re.IGNORECASE)
_GENERIC_MIN_CHUNKS = 6

# Roles flap between books (a lead is "supporting" in a volume that mostly follows
# someone else), so the most principal reading wins when candidates are merged.
_ROLE_RANK = {
    "protagonist": 5,
    "antagonist": 4,
    "love-interest": 3,
    "mentor": 2,
    "supporting": 1,
    "minor": 0,
}


def _best_role(first: Optional[str], second: Optional[str]) -> Optional[str]:
    return first if _ROLE_RANK.get(str(first or ""), -1) >= _ROLE_RANK.get(str(second or ""), -1) else second

_DISCOVERY_SYSTEM = """You are cataloguing the recurring CAST of a work of fiction: the
people who act, speak and want things.

A candidate must pass five tests.

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
5. SEPARATE. Two people who appear together are still two people. Never give a
   character another's deeds, family, rank or history, and never merge two people
   into one entry to explain a scene.

These excerpts are the only evidence. If you recognise this work, ignore everything
you remember about it: what you know from elsewhere is exactly what invents cast
members that are not here.

"name" is the form used most often in the text.

"aliases" lists only the NAMES the text uses for that same person: another given
name, a surname, a distinct nickname or epithet ("the Bloodless"). Titles, ranks and
descriptions are NOT aliases. "the prince", "the captain", "the king", "my lord",
"the pretender", "Prince of Vere" are words the text applies loosely, often to
several people, so listing them fuses one character into another. Leave a title out
unless it is unmistakably one person's own epithet, and never list another
character's name as an alias. When in doubt, list no alias.

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
motivation, manner — never their plot situation or rank, and never another
character's deeds.

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

Rules applied to every line you write:
1. CAUSE -> TRAIT. A formative experience is kept only if it explains core
   behaviour, and it is phrased as its meaning rather than its events. Good:
   "Raised their siblings alone after everything was taken, so love means
   sacrifice and rest feels like a debt." Bad: "Is the prince of Vintas."
2. PORTABILITY TEST. Could this line describe the same person working in a
   modern city? If not, either translate it into the trait it produced, or move
   the raw fact into "situational_anchors".
3. NO BLENDING. Several people appear in these excerpts. A motive, feeling,
   history, deed or line of dialogue belongs to this character only when the text
   attaches it to one of their names; if you cannot tell who a sentence is about,
   leave it out. Never give them another character's rank, family, role or history,
   and never let a second person's traits leak into theirs. The character named
   below is the SUBJECT of every line.
4. THE EXCERPTS WIN. The alias list and the one-line note come from a rough first
   pass and are often wrong. Where they contradict the excerpts, follow the
excerpts.

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
Names the text uses for them: {aliases}
Role in the work: {role}
Others who appear in these excerpts (never describe them as {name}): {others}
Unverified one-line note from a first pass (the excerpts override it): {description}
{guidance}
Excerpts, cut down to the sentences that name {name}:
{evidence}

Write the profile JSON for {name} only, using nothing that belongs to anyone else."""


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


def _text(value) -> str:
    return str(value or "").strip()


def _as_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _as_dict(value, keys: tuple[str, ...]) -> dict:
    src = value if isinstance(value, dict) else {}
    return {key: _text(src.get(key)) for key in keys}


def _alias_tokens(alias: str) -> list[str]:
    return [t for t in normalize_name(alias).split() if t and t not in _NOISE_TOKENS]


def _looks_like_title(alias: str) -> bool:
    """True when an alias is a rank, role or relation rather than a name.

    "Prince of Vere", "Veretian Prince" and "Pretender Prince" all describe a
    position that more than one character occupies at different points, so they
    say nothing about identity and everything about confusion.
    """
    return any(token in _TITLE_WORDS for token in _alias_tokens(alias))


def _contains_name(alias_key: str, name_key: str) -> bool:
    """True when *name_key* appears as whole words inside *alias_key*.

    Catches "King Laurent" and "Prince Damianos" proposed as someone else's alias.
    """
    alias_tokens, name_tokens = alias_key.split(), name_key.split()
    if not name_tokens or len(name_tokens) > len(alias_tokens):
        return False
    span = len(name_tokens)
    return any(alias_tokens[i : i + span] == name_tokens for i in range(len(alias_tokens) - span + 1))


def _name_pattern(name: str) -> Optional[re.Pattern]:
    key = normalize_name(name)
    if not key:
        return None
    return re.compile(rf"(?<!\w){re.escape(key)}(?!\w)", re.IGNORECASE)


# Books often declare their cast outright: an all-caps name followed by a
# parenthetical ("DAMIANOS (Damen), heir to the throne of Akielos") or a title
# ("ENGUERRAN, Captain of Ravenel's troops"). Those lines are the one place the
# text itself says which names belong to the same person — and which names belong to
# somebody else entirely, which is precisely what a sampled discovery pass cannot
# know. Only an unquoted, line-initial shout counts, so dialogue does not qualify.
_DECLARED_NAME_RE = re.compile(
    r"^[ \t]*([A-Z][A-Z\u2019'\-]{1,}(?:[ \t]+[A-Z][A-Z\u2019'\-]{1,}){0,3})"
    r"[ \t]*(?:\(([^)\n]{1,40})\))?[ \t]*,[ \t]*",
    re.MULTILINE,
)
_DECLARED_NON_NAMES = frozenset("""
no yes stop wait look run come go what why how who now then again please thanks
thank sorry damn hell god oh ah hey hello goodbye ok okay never always
""".split())


def _declared_names(texts: list[str]) -> dict[str, str]:
    """Map every name the book's cast headings declare onto one person.

    Returns {name: group} where a group is the heading's primary name, so
    "damianos" and "damen" share the group "damianos" while "enguerran" has its
    own. Used as authority: a name declared for someone else is never an alias.
    """
    groups: dict[str, str] = {}
    for text in texts:
        for match in _DECLARED_NAME_RE.finditer(text or ""):
            base = normalize_name(match.group(1))
            if not base or base in _DECLARED_NON_NAMES:
                continue
            groups.setdefault(base, base)
            alias = normalize_name(match.group(2) or "")
            if alias:
                groups.setdefault(alias, base)
    return groups


_SENTENCE_RE = re.compile(r"[^.!?\n]+[.!?]*")


def _focus_on_names(text: str, patterns: list[re.Pattern], limit: int = _EVIDENCE_CHUNK_CHARS) -> str:
    """Keep only the sentences a character's names are bound to, plus one before.

    A 900-character chunk is mostly other people talking. Handing it to the model
    whole is how one character's motives end up in another's profile; the sentence
    before each hit is kept so the reader still knows who acted.
    """
    sentences = [s.strip() for s in _SENTENCE_RE.findall(text or "")]
    hits = [i for i, sentence in enumerate(sentences) if any(p.search(sentence) for p in patterns)]
    if not hits:
        return ""

    keep: set[int] = set()
    for i in hits:
        keep.update({i, max(0, i - 1)})

    chosen: list[str] = []
    total = 0
    for i in sorted(keep):
        sentence = sentences[i]
        if not sentence:
            continue
        if total + len(sentence) > limit:
            break
        chosen.append(sentence)
        total += len(sentence) + 1
    return " ".join(chosen)


def _normalise_profile(data: dict, model: str) -> dict:
    voice = data.get("voice") if isinstance(data.get("voice"), dict) else {}
    relationships = [
        rel
        for rel in (
            _as_dict(r, ("dynamic", "behaviour"))
            for r in (data.get("relationships") or [])
            if isinstance(r, dict)
        )
        if rel["dynamic"] or rel["behaviour"]
    ]

    return {
        "archetype": _text(data.get("archetype")) or None,
        "summary": _text(data.get("summary")) or None,
        "core_traits": _as_list(data.get("core_traits")),
        "motivations": _as_dict(data.get("motivations"), ("wants", "needs")),
        "fears": _as_list(data.get("fears")),
        "flaws": _as_list(data.get("flaws")),
        "values": _as_list(data.get("values")),
        "voice": {
            **_as_dict(voice, ("tone", "rhythm", "humour")),
            "tells": _as_list(voice.get("tells")),
        },
        "mannerisms": _as_list(data.get("mannerisms")),
        "appearance": _as_dict(data.get("appearance"), ("signature", "presentation")),
        "relationships": relationships,
        "formative_experience": _text(data.get("formative_experience")) or None,
        "arc_pattern": _text(data.get("arc_pattern")) or None,
        "situational_anchors": _as_list(data.get("situational_anchors")),
        "status": "complete",
        "error": None,
        "model": model,
    }


class CharacterExtractor:
    def __init__(self, settings: AppSettings, chat_engine: ChatEngine):
        self.s = settings
        self.chat = chat_engine
        # A read timeout is the only thing that fires while a runner sends
        # nothing at all (prefill stall, queue wait, wedged generation).
        self._ollama = Client(
            host=settings.ollama_base_url,
            timeout=httpx.Timeout(_READ_TIMEOUT, connect=_CONNECT_TIMEOUT),
        )

    # ------------------------------------------------------------------ #
    # Ollama                                                             #
    # ------------------------------------------------------------------ #

    def _complete(self, system: str, user: str, temperature: float, num_predict: int) -> str:
        """One completion, consumed as a stream, with reasoning turned off.

        Extraction is a transcription task — the model is reporting what the text
        says, not solving a puzzle — so thinking only burns the token budget and
        pushes the JSON out of the reply.

        Streaming is not for the UI here. A non-streaming Ollama request cannot be
        abandoned: it holds the shared runner until it finishes, and every later
        request queues behind it with no output at all. Reading the stream lets us
        stop at a deadline and close the connection, which is what actually aborts
        the generation on the host.
        """
        kwargs = {
            "model": self.s.extraction_model_effective,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "options": {
                "temperature": temperature,
                # Without an explicit num_ctx Ollama uses the model's own default
                # (98k for this one), whose KV cache does not fit beside the
                # weights on the host: generation drops to a crawl. Chat sends
                # the configured window for exactly this reason.
                "num_ctx": self.s.chat_num_ctx or 40960,
                "num_predict": num_predict,
            },
            "stream": True,
        }
        frames = chat_without_thinking(self._ollama, **kwargs)

        parts: list[str] = []
        reason = ""
        deadline = time.monotonic() + _DEADLINE_SECONDS
        try:
            for frame in frames:
                message = frame.get("message") or {}
                if message.get("content"):
                    parts.append(message["content"])
                if frame.get("done"):
                    reason = frame.get("done_reason") or ""
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(
                        "Character extraction timed out after "
                        f"{_DEADLINE_SECONDS:.0f}s "
                        f"({len(''.join(parts))} characters generated)"
                    )
        finally:
            close = getattr(frames, "close", None)
            if callable(close):
                close()

        content = "".join(parts)
        if not content.strip():
            raise ValueError(
                f"The model returned no text (finish reason: {reason or 'unknown'})"
            )
        if reason == "length":
            logger.warning("Extraction reply hit num_predict; JSON may be truncated")
        return content

    # ------------------------------------------------------------------ #
    # Corpus access                                                      #
    # ------------------------------------------------------------------ #

    def _book_chunks(self, calibre_ids: list[int]) -> list[dict]:
        """Every chunk of the selected books, read from the vector store.

        Chroma will not return a whole library in one call (SQLite caps the number
        of bound variables), so this pages through it per book.
        """
        collection = self.chat.collection
        chunks: list[dict] = []
        for calibre_id in calibre_ids:
            offset = 0
            while True:
                page = collection.get(
                    where={"_cid": {"$in": [int(calibre_id)]}},
                    include=["documents", "metadatas"],
                    limit=500,
                    offset=offset,
                )
                documents = page.get("documents") or []
                metadatas = page.get("metadatas") or []
                for document, metadata in zip(documents, metadatas):
                    metadata = metadata or {}
                    chunks.append({
                        "text": document or "",
                        "title": metadata.get("title") or "",
                        "chapter": metadata.get("_chapter") or "",
                        "book_id": int(metadata.get("_cid") or calibre_id),
                    })
                offset += len(documents)
                if len(documents) < 500:
                    break
        return chunks

    def _verify_aliases(self, candidates: list[dict], calibre_ids: list[int]) -> tuple[list[dict], list[dict]]:
        """Drop aliases the books do not support, in place, and log why.

        Discovery reads a dozen excerpts and reasons from there, so its alias lists
        are guesses: a shared title ("the Prince", "Pretender Prince") or the other
        lead's name gets attached to whoever happened to be nearby. Because those
        aliases are then used as *retrieval keys* for the profile, a bad alias does
        not just look wrong — it pulls the other character's scenes into this
        character's evidence and the profiles blend too.

        Four checks, cheapest first:
          1. never another character's name, nor a title built around one
             ("King Laurent", "Prince Damianos");
          2. never an alias claimed by two people at once;
          3. never a bare title or role ("the Captain", "Prince of Vere");
          4. it must actually co-occur with this character in the selected books.
        """
        if not candidates:
            return candidates, []
        chunks = self._book_chunks(calibre_ids)
        if not chunks:
            return candidates, []

        names = {normalize_name(c["name"]): c["name"] for c in candidates}
        patterns = {key: _name_pattern(key) for key in names}
        present: list[tuple[str, set[str]]] = []
        for chunk in chunks:
            text = chunk["text"]
            if not text:
                continue
            present.append((text, {key for key, pat in patterns.items() if pat and pat.search(text)}))

        declared = _declared_names([chunk["text"] for chunk in chunks])
        corpus = "\n".join(chunk["text"] for chunk in chunks)
        mentions: dict[str, int] = {key: 0 for key in names}
        for _, found in present:
            for key in found:
                mentions[key] += 1

        claims: dict[str, set[str]] = {}
        for candidate in candidates:
            for alias in candidate.get("aliases") or []:
                claims.setdefault(normalize_name(alias), set()).add(normalize_name(candidate["name"]))

        kept_candidates: list[dict] = []
        dropped: list[dict] = []
        for candidate in candidates:
            mine = normalize_name(candidate["name"])
            if _GENERIC_NAME_RE.match(candidate["name"]):
                # A handle the book capitalises ("the Regent") is a name; a common
                # noun it leaves lowercase ("the man", "the soldier") is a
                # description, however often it recurs.
                noun = mine.split()[-1] if mine else ""
                total = len(_name_pattern(noun).findall(corpus)) if noun else 0
                capped = len(re.findall(rf"(?<!\w){re.escape(noun.capitalize())}(?!\w)", corpus)) if noun else 0
                if mentions.get(mine, 0) < _GENERIC_MIN_CHUNKS or (total and capped / total < 0.5):
                    logger.info(
                        "Candidate %r dropped: a description, not a name (%d mentions, %d/%d capitalised)",
                        candidate["name"], mentions.get(mine, 0), capped, total,
                    )
                    dropped.append({"name": candidate["name"], "kind": "description"})
                    continue
            kept: list[str] = []
            for alias in candidate.get("aliases") or []:
                key = normalize_name(alias)
                if not key or key == mine:
                    continue
                if any(other != mine and _contains_name(key, other) for other in names):
                    logger.info("Alias %r dropped from %s: it names another character", alias, candidate["name"])
                    continue
                if len(claims.get(key, ())) > 1:
                    logger.info("Alias %r dropped from %s: claimed by %d characters", alias, candidate["name"], len(claims[key]))
                    continue
                owner = declared.get(key)
                if owner:
                    if owner != declared.get(mine, mine):
                        logger.info(
                            "Alias %r dropped from %s: the book's cast list assigns it to %s",
                            alias, candidate["name"], owner,
                        )
                        continue
                    kept.append(alias)
                    continue
                if _looks_like_title(alias):
                    logger.info("Alias %r dropped from %s: a title, not a name", alias, candidate["name"])
                    continue

                pattern = _name_pattern(alias)
                with_me = other_only = 0
                for text, found in present:
                    if not pattern or not pattern.search(text):
                        continue
                    if mine in found:
                        with_me += 1
                    elif found:
                        other_only += 1
                if with_me == 0 or with_me * 2 < other_only:
                    logger.info(
                        "Alias %r dropped from %s: %d co-occurrences with them, %d with others",
                        alias, candidate["name"], with_me, other_only,
                    )
                    continue
                kept.append(alias)
            candidate["aliases"] = kept
            kept_candidates.append(candidate)

        return kept_candidates, dropped

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
                    match["role"] = _best_role(match.get("role"), candidate.get("role"))
                    match["description"] = match.get("description") or candidate.get("description")

            yield {"event": "found", "calibre_id": calibre_id, "count": len(found)}

        # Names come from the model; the alias lists are guesses. Check them against
        # the full text of every selected book before they reach the profile phase.
        verified, dropped = self._verify_aliases(list(merged.values()), calibre_ids)
        filtered.extend(dropped)

        yield {
            "event": "candidates",
            "candidates": sorted(verified, key=lambda c: normalize_name(c["name"])),
            "filtered": filtered,
            "errors": errors,
        }

    # ------------------------------------------------------------------ #
    # Phase B — synthesis                                                #
    # ------------------------------------------------------------------ #

    def gather_evidence(self, name: str, aliases: list[str], calibre_ids: list[int]) -> list[dict]:
        """Excerpts found by counting mentions, not by embedding similarity.

        Retrieving on a *name* embeds the string "Laurent", which matches tone and
        topic rather than mentions; the old version then handed the profile prompt
        whole unlabelled chunks in which the other lead is the one acting. Counting
        names directly is exact, needs no model, and lets each chunk be cut down to
        the sentences this character is bound to.
        """
        patterns = [p for p in (_name_pattern(n) for n in [name, *aliases] if n) if p]
        if not patterns:
            return []

        scored: list[tuple[float, dict]] = []
        seen: set[str] = set()
        for chunk in self._book_chunks(calibre_ids):
            text = chunk["text"]
            if not text:
                continue
            hits = sum(len(p.findall(text)) for p in patterns)
            if not hits:
                continue
            snippet = _focus_on_names(text, patterns)
            if not snippet:
                continue
            # Libraries hold the same book twice (omnibus plus single volumes, two
            # editions). Without this the budget is spent twice on one passage.
            fingerprint = re.sub(r"\W+", " ", snippet.lower())[:240]
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            # Density (mentions per 1000 characters), so a long chunk that mentions
            # them twice does not outrank a short one that is about them.
            scored.append((hits / (len(text) / 1000.0 or 1.0), {**chunk, "text": snippet}))

        scored.sort(key=lambda item: item[0], reverse=True)

        # Round-robin across books so a profile of a trilogy character is not built
        # entirely from whichever book scored highest.
        by_book: dict[int, list[dict]] = {}
        for _, chunk in scored:
            by_book.setdefault(chunk["book_id"], []).append(chunk)
        queues = [list(book) for book in by_book.values()]
        ordered: list[dict] = []
        while queues:
            for queue in list(queues):
                if queue:
                    ordered.append(queue.pop(0))
                if not queue:
                    queues.remove(queue)

        evidence: list[dict] = []
        budget = 0
        for chunk in ordered:
            if budget + len(chunk["text"]) > _EVIDENCE_BUDGET:
                continue
            budget += len(chunk["text"])
            evidence.append(chunk)
        return evidence

    def build_profile(
        self,
        name: str,
        aliases: Optional[list[str]] = None,
        calibre_ids: Optional[list[int]] = None,
        role: Optional[str] = None,
        description: Optional[str] = None,
        guidance: str = "",
        others: Optional[list[str]] = None,
    ) -> dict:
        aliases = aliases or []
        calibre_ids = calibre_ids or []
        others = [o for o in (others or []) if normalize_name(o) != normalize_name(name)]
        evidence = self.gather_evidence(name, aliases, calibre_ids)
        if not evidence:
            raise RuntimeError(
                "No indexed text found for this character — are the source books indexed?"
            )

        # Naming who else is present in each excerpt is what stops the model from
        # reading a scene between two people as one person's inner life.
        cast = [name, *aliases, *others]
        cast_patterns = [(display, _name_pattern(display)) for display in cast if normalize_name(display)]
        blocks = []
        for chunk in evidence:
            found = [
                display
                for display, pattern in cast_patterns
                if pattern and pattern.search(chunk["text"])
            ]
            label = (
                f"[book {chunk['book_id']} — {chunk['title'] or 'unknown'} — "
                f"{chunk['chapter'] or 'chapter unknown'}"
            )
            if found:
                label += "; names in this excerpt: " + ", ".join(found[:6])
            blocks.append(f"{label}]\n{chunk['text']}")

        raw = self._complete(
            _PROFILE_SYSTEM,
            _PROFILE_USER.format(
                name=name,
                aliases=", ".join(aliases) or "none",
                role=role or "unknown",
                others=", ".join(others[:12]) or "none",
                description=description or "none given",
                guidance=("\n" + _guidance_block(guidance) + "\n") if guidance.strip() else "",
                evidence="\n\n".join(blocks),
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
        cast_names = [str(item.get("name") or "") for item in requests]
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
                    others=[c for c in cast_names if c and c != name],
                )
            except Exception as exc:  # noqa: BLE001 — one failure must not stop the rest
                logger.warning("Profile synthesis failed for %s", name, exc_info=exc)
                yield {"event": "error", "name": name, "error": str(exc)}
                continue
            yield {"event": "ok", "name": name, "profile": profile}
        yield {"event": "done"}
