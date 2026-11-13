"""Character discovery and deep-profile synthesis.

The model is given narrow jobs and the code does everything that can be measured.

**Discovery** (one model call for the whole selection)
  1. `book_text` loads every *story* chunk — acknowledgements, author bios,
     copyright pages and newsletter plugs are dropped before anything else runs.
  2. Proper names are counted over the full text, with how many chapters each
     spans and whether it speaks or follows "in"/"at". Prominence is measured, not
     guessed from a dozen samples.
  3. The model only *classifies* the most frequent names — person, place, group,
     title… — from short real contexts, and says which names are the same person.
     It cannot add a name the text does not contain.

**Profiles** (a few calls per character)
  1. Evidence is the paragraphs that name the character, spread across the whole
     story, with dialogue they speak ranked first.
  2. *Observation* pass: per batch of evidence, the model lists what the text
     shows about this one person, each with a verbatim quote. Quotes that are not
     in the text are discarded, which is what stops invented or borrowed traits.
  3. *Synthesis* pass: verified observations only (no raw prose, so no plot to
     copy) are abstracted into a setting-free profile.
  4. *Portability check*: any book-specific name left in a portable field gets one
     rewrite pass; what still leaks is moved to `situational_anchors`.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Iterator, Optional

import httpx
from ollama import Client

from .book_text import Corpus, NameStat, contexts, load_corpus, name_stats
from .characters import normalize_name
from .chat import ChatEngine
from .llm import chat_without_thinking
from .models import AppSettings

logger = logging.getLogger(__name__)

# Discovery
_MAX_CANDIDATES = 40         # names sent to the model for classification
_MIN_MENTIONS = 5            # mid-sentence mentions below which a name is a walk-on
_EXTRA_CANDIDATES = 15       # room for cast-list and user-named names on top
_DECLARED_MIN = 10
_CONTEXTS_PER_NAME = 3
_CONTEXTS_PER_TITLE = 6
_DISCOVERY_TEMPERATURE = 0.1
_DISCOVERY_TOKENS = 8192
# Below this share of the lead's mentions a character is "minor" whatever the
# model thinks; the UI hides minor characters by default.
_MINOR_SHARE = 0.03
_MINOR_FLOOR = 8
_LEAD_SHARE = 0.15           # a "protagonist" with less than this is supporting
_SUPPORTING_SHARE = 0.05     # a "minor" character with more than this is supporting

# Profiles
_EVIDENCE_BATCH_CHARS = 16000
# Batches read for a first profile, by how many paragraphs name the character: a
# walk-on is covered by two, a trilogy lead gets six (~96k characters).
_BATCH_STEPS = ((120, 2), (300, 3), (800, 4), (float("inf"), 6))
_REFINE_BATCHES = 3
_CONSOLIDATE_TOKENS = 8192
_ESTABLISHED_CHAPTERS = 3    # chapters a theme needs before it can be a headline trait
_MAX_OBSERVATIONS = 300
_MAX_STORED_LINES = 30
_PARAGRAPH_CHARS = 700
_FOLLOW_ON_CHARS = 400
_OBSERVE_TEMPERATURE = 0.1
_OBSERVE_TOKENS = 6144
_PROFILE_TEMPERATURE = 0.3
_PROFILE_TOKENS = 4096
_MAX_LINES = 12
_MAX_ANCHORS = 8

_CORPUS_CACHE_SIZE = 3

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
_ROLES = tuple(_ROLE_RANK)

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

_KINDS = ("person", "group", "place", "title", "object", "other")

# The generated fields of a profile: what a refine reviews and a lock protects.
_PROFILE_FIELDS = (
    "archetype", "summary", "core_traits", "motivations", "fears", "flaws", "values",
    "voice", "mannerisms", "appearance", "relationships", "formative_experience",
    "arc_pattern", "situational_anchors",
)


@dataclass
class Passage:
    """One paragraph of evidence and where in the selection it sits."""
    book: int           # 1-based, in reading order
    book_id: int
    section: int
    position: float
    order: int
    text: str
    fingerprint: str

# --------------------------------------------------------------------------- #
# Prompts                                                                     #
# --------------------------------------------------------------------------- #

_CLASSIFY_SYSTEM = """You are sorting the proper names found in a work of fiction.

Every capitalised name that recurs in the story text has already been counted by a
program. For each one you get its counts and a few short passages where it occurs.
Your job is to say what each name IS, using those passages — not your memory of
the book or series.

For every entry return:
- "name": exactly as given.
- "kind": one of
    person — one specific individual who acts, speaks or is spoken of.
    group  — a family, house, army, crew, order or people ("the Mulvaneys", "Veretians").
    place  — a country, city, building, region, planet or ship.
    title  — a rank or form of address shared by several people or used loosely
             ("King", "Captain", "Highness", "Prince"). But when the passages all
             point at the same one individual, who acts and speaks under that
             title as if it were their name ("the Regent" in a story with a single
             regent), it is a "person".
    object — a thing: weapon, vehicle, brand, artwork.
    other  — anything else: adjectives of nationality, languages, events, gods,
             concepts, exclamations, words capitalised only for emphasis.
  Hints in the counts: "speaks" and "acts" point to a person; "after in/at/from"
  points to a place. The passages decide.
- "same_as": for a person known by more than one name in this list (a nickname,
  full name or surname used for one individual), the name of the entry that is the
  SAME individual; otherwise "". Never link two different people, never link a
  title, and when unsure use "".
- "role" (persons only, else "none"), by the character's FUNCTION in the story:
    protagonist   — the story follows them; their goal drives the plot.
    antagonist    — their goal actively blocks a protagonist's. Rudeness or one
                    hostile scene is NOT enough; an ally who argues is "supporting".
    love-interest — a romantic thread with a principal character.
    mentor        — guides or teaches a principal character.
    supporting    — recurring, wants things, does not drive the plot.
    minor         — appears briefly.
  Many mentions across many chapters usually means a principal character.
- "description" (persons only, else ""): ONE sentence about who they are as a
  person — temperament, manner, what drives them. No plot events, no rank, no
  other character's deeds.

Return every entry, in the order given."""

_OBSERVE_SYSTEM = """You are reading excerpts from a novel to record what they SHOW about one
person. Another step will turn your notes into a character profile, so your only
job is accurate, attributable observation.

Record an observation only when the excerpt makes clear that the subject is
{name}: they are named in the sentence, or the sentence plainly continues a
sentence about them. Several people appear in these excerpts; when you cannot tell
whether "he", "she" or "they" means {name}, skip it. Never record what someone
else does, feels or wants, even if it is done TO {name}.

Each observation has:
- "aspect": trait | value | want | need | fear | flaw | voice | mannerism |
  appearance | relationship | history
    voice        — how they speak: register, rhythm, verbal habits, humour.
    mannerism    — physical habits and tells.
    relationship — how they behave toward someone (describe the dynamic, e.g.
                   "protective of a younger sibling", "needles people he likes").
    history      — a formative past experience the text states.
    need         — what they lack and the story shows they must learn or accept.
- "note": what it shows about the PERSON, in a short phrase. Describe behaviour and
  psychology, not plot events.
- "source": where the claim comes from — this matters as much as the claim.
    shown — the narration shows them doing, feeling or thinking it, or the way they
            speak demonstrates it. The strongest evidence.
    self  — their own words ABOUT themselves ("I have always been cruel"). Guarded,
            ironic, manipulative or self-hating characters often describe themselves
            falsely; record it as "self" and say so in the note if the context
            suggests it is a performance.
    other — someone else's opinion or description of them. Fill "by" with who.
- "by": who voices it when source is "other"; otherwise "".
- "quote": a short verbatim quotation (at most 25 words) copied exactly from the
  excerpts that shows it. Observations without an exact quote are discarded.

Also list in "lines" up to 6 lines of dialogue that {name} speaks, copied exactly,
that best show how they talk.

Each excerpt is labelled with its book and how far through that book it is. Cover
the whole batch, not just its first excerpts. Prefer what recurs over what happens
once. Return JSON only."""

_OBSERVE_USER = """Person: {name}
Other names for them: {aliases}
Other people in these excerpts (never attribute their actions to {name}): {others}
{guidance}
Excerpts:
{evidence}

Record what these excerpts show about {name}."""

_CONSOLIDATE_SYSTEM = """You are grouping notes about one fictional character into themes.

Each numbered note records one thing a book shows about {name}. Group notes that
describe the SAME underlying quality, even when worded differently or seen in
different situations ("cold to strangers" and "freezes people out with formality"
are one theme). Do not merge opposites: if the notes disagree, keep them as separate
themes — the disagreement is information about how the character changes or what
they hide.

For each theme give:
- "aspect": the aspect most of its notes share.
- "statement": the quality, in one plain, setting-free sentence: no names, places,
  ranks or plot events.
- "members": the numbers of every note in the theme.

Every note belongs to exactly one theme. A note that matches nothing is a theme of
its own. Return JSON only."""

_PROFILE_SYSTEM = """You are writing a character profile that must survive being transplanted.

The character will later be cast into a completely different setting — a fantasy
prince may be written as a barista in a contemporary romance. Every field must
therefore describe the PERSON: their psychology, behaviour and voice. Never their
world, their plot, or the other people in their story.

You are given THEMES distilled from the whole selection of books, each with how
much of the story supports it, and sorted into tiers. The tiers are binding:

ESTABLISHED — recurs across many chapters (and books, when there are several).
  The only themes that may become the archetype, summary, core traits, flaws,
  values, fears, mannerisms or voice.
CHANGES OVER TIME — strong in some books or stretches and absent or reversed in
  others. These describe the ARC: put them in "arc_pattern" as a movement from the
  early state to the later one. Do not present an early state as who they are.
SELF-DESCRIPTIONS — only their own words about themselves, never shown by the
  narration. Characters misdescribe themselves. Use one only where established
  themes back it up, or as what they believe about themselves (fears, needs).
OTHERS' VIEWS — what other characters say about them. Use for relationship
  patterns and reputation, never as fact about their nature.
MOMENTS — seen in only one or two scenes. Do not use them for any headline field
  (archetype, summary, core traits, flaws); at most a detail that colours an
  established theme.

Rules for every line you write:
1. ONE IDEA, ONE PLACE. Do not restate the same quality in several fields; a flaw
   that is already a core trait does not need repeating in the summary and the arc.
2. THE WHOLE CHARACTER. Weight the profile by how much of the story supports each
   theme, not by how vivid one scene is.
3. CAUSE -> TRAIT. A formative experience is kept only if it explains behaviour,
   phrased as its meaning rather than its events: what happened to them in general
   terms, then the behaviour it produced. Never a title, place or event name.
4. PORTABILITY TEST. Could this line describe the same person working in a modern
   city? If not, translate it into the trait it produced, or move the raw fact to
   "situational_anchors".
5. NO PROPER NOUNS. Never name another character, a place, a nation, a family, an
   institution or an invented term in any field except "situational_anchors". Say
   "his younger brother", "a rival", "his homeland", "the court" instead. The
   forbidden words are listed below the themes.
6. BEHAVIOUR, CONCRETELY. "core_traits" are short descriptors; "mannerisms" are
   visible habits a writer could put in a scene; "voice.tells" are verbal habits
   with a short example where the lines support one.
7. ANCHORS ARE FEW. "situational_anchors" holds at most 6 short facts about this
   character's original circumstances (rank, abilities, world rules). Never a list
   of names or other characters.
8. ONLY WHAT IS SUPPORTED. If appearance is never observed, write "the text does
   not establish this". Leave a list short rather than pad it.

Return the JSON object with every key."""

_PROFILE_USER = """Character: {name}
Role in the story: {role}
Books, in reading order: {books}
{guidance}{draft}
{themes}

Lines of dialogue they speak:
{lines}

Never use these words outside "situational_anchors": {forbidden}

Write the portable profile for {name}."""

# A refine never shows the model the previous sheet: given one, it copies it. It
# writes afresh from all the evidence (earlier observations included, so nothing
# supported is lost) and only sees the fields the user wrote, to stay consistent.
_LOCKED_NOTE = """
The user wrote these fields themselves. They are kept exactly as they are; keep
everything else consistent with them:
{locked}
"""

_REPAIR_SYSTEM = """You are editing a character profile so it can be used in any setting.
Some fields name people, places or terms from the original book. Rewrite only those
lines so they keep their meaning without the proper nouns: replace a person with
the relationship ("his younger brother", "a rival he respects"), a place or
institution with a generic equivalent ("his homeland", "the court"). Facts that
make no sense outside the original world go in "situational_anchors", which may
keep proper nouns. Return the whole profile as JSON with every key."""


# --------------------------------------------------------------------------- #
# JSON schemas (Ollama structured output)                                     #
# --------------------------------------------------------------------------- #

def _str_list() -> dict:
    return {"type": "array", "items": {"type": "string"}}


_CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "entries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": list(_KINDS)},
                    "same_as": {"type": "string"},
                    "role": {"type": "string", "enum": [*_ROLES, "none"]},
                    "description": {"type": "string"},
                },
                "required": ["name", "kind", "same_as", "role", "description"],
            },
        }
    },
    "required": ["entries"],
}

_ASPECTS = ("trait", "value", "want", "need", "fear", "flaw", "voice", "mannerism",
            "appearance", "relationship", "history")

_SOURCES = ("shown", "self", "other")

_OBSERVE_SCHEMA = {
    "type": "object",
    "properties": {
        "observations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "aspect": {"type": "string", "enum": list(_ASPECTS)},
                    "note": {"type": "string"},
                    "source": {"type": "string", "enum": list(_SOURCES)},
                    "by": {"type": "string"},
                    "quote": {"type": "string"},
                },
                "required": ["aspect", "note", "source", "by", "quote"],
            },
        },
        "lines": _str_list(),
    },
    "required": ["observations", "lines"],
}

_CONSOLIDATE_SCHEMA = {
    "type": "object",
    "properties": {
        "themes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "aspect": {"type": "string", "enum": list(_ASPECTS)},
                    "statement": {"type": "string"},
                    "members": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["aspect", "statement", "members"],
            },
        }
    },
    "required": ["themes"],
}

_PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "archetype": {"type": "string", "description": "a short phrase naming the kind of person, setting-free"},
        "summary": {"type": "string", "description": "one sentence, setting-free"},
        "core_traits": {**_str_list(), "description": "4-7 adjectives"},
        "motivations": {
            "type": "object",
            "properties": {"wants": {"type": "string"}, "needs": {"type": "string"}},
            "required": ["wants", "needs"],
        },
        "fears": _str_list(),
        "flaws": _str_list(),
        "values": _str_list(),
        "voice": {
            "type": "object",
            "properties": {
                "tone": {"type": "string", "description": "speech register"},
                "rhythm": {"type": "string", "description": "sentence shape"},
                "tells": {**_str_list(), "description": "verbal habits, with short examples"},
                "humour": {"type": "string"},
            },
            "required": ["tone", "rhythm", "tells", "humour"],
        },
        "mannerisms": {**_str_list(), "description": "visible physical habits and tells"},
        "appearance": {
            "type": "object",
            "properties": {
                "signature": {"type": "string", "description": "portable physical facts: build, colouring, marks, posture"},
                "presentation": {"type": "string", "description": "how they carry and present themselves"},
            },
            "required": ["signature", "presentation"],
        },
        "relationships": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "dynamic": {"type": "string", "description": "reusable pattern, e.g. 'protective older sibling'"},
                    "behaviour": {"type": "string", "description": "how the pattern shows up"},
                },
                "required": ["dynamic", "behaviour"],
            },
        },
        "formative_experience": {"type": "string", "description": "2-4 sentences: what shaped them, in general terms, and the behaviour it produced"},
        "arc_pattern": {"type": "string", "description": "the shape of their growth, from X to Y"},
        "situational_anchors": {**_str_list(), "description": "canon facts that only make sense in the original world"},
    },
    "required": [
        "archetype", "summary", "core_traits", "motivations", "fears", "flaws", "values",
        "voice", "mannerisms", "appearance", "relationships", "formative_experience",
        "arc_pattern", "situational_anchors",
    ],
}


# --------------------------------------------------------------------------- #
# Small helpers                                                               #
# --------------------------------------------------------------------------- #

def _best_role(first: Optional[str], second: Optional[str]) -> Optional[str]:
    return first if _ROLE_RANK.get(str(first or ""), -1) >= _ROLE_RANK.get(str(second or ""), -1) else second


def _canonical_role(value) -> Optional[str]:
    role = str(value or "").strip().lower()
    if not role or role in ("null", "none"):
        return None
    role = _ROLE_ALIASES.get(role, role)
    return role[:32]


def _guidance_block(guidance: str) -> str:
    """The user's own casting notes, given authority over the model's reading."""
    if not guidance.strip():
        return ""
    return (
        "\nThe user knows this work and is correcting your reading. Their notes are\n"
        "authoritative: when they contradict your inference, follow them.\n"
        f"{guidance.strip()}\n"
    )


def _parse_json(raw: str):
    """Pull the first JSON object/array out of a model reply."""
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
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
    """True when a name is a rank, role or relation rather than an identity."""
    return any(token in _TITLE_WORDS for token in _alias_tokens(alias))


def _name_pattern(name: str) -> Optional[re.Pattern]:
    """Whole-word, capitalised match for a name, tolerant of a possessive.

    Case-sensitive on purpose: "Will", "Grace" and "Hunter" are names only when
    capitalised, and a portable line saying "a natural prince" names nobody.
    """
    raw = re.sub(r"^(?:the|a|an)\s+", "", (name or "").strip(), flags=re.IGNORECASE)
    if not raw:
        return None
    words = [w[:1].upper() + w[1:] for w in raw.split()]
    body = r"\s+".join(re.escape(w) for w in words)
    return re.compile(rf"(?<![\w]){body}(?:[’']s)?(?![\w])")


# Books often declare their cast outright: an all-caps name followed by a
# parenthetical ("DAMIANOS (Damen), heir to the throne of Akielos") or a title
# ("ENGUERRAN, Captain of Ravenel's troops"). Those lines are the one place the
# text itself says which names belong to the same person — and which belong to
# somebody else entirely. Only an unquoted, line-initial shout counts.
_DECLARED_NAME_RE = re.compile(
    r"^[ \t]*([A-Z][A-Z’'\-]{1,}(?:[ \t]+[A-Z][A-Z’'\-]{1,}){0,3})"
    r"[ \t]*(?:\(([^)\n]{1,40})\))?[ \t]*,[ \t]*",
    re.MULTILINE,
)
_DECLARED_NON_NAMES = frozenset("""
no yes stop wait look run come go what why how who now then again please thanks
thank sorry damn hell god oh ah hey hello goodbye ok okay never always
""".split())


def _declared_names(texts: list[str]) -> dict[str, str]:
    """Map every name a cast list declares onto its person: {name: primary name}."""
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


def _squash(text: str) -> str:
    """Comparable form of prose: lower case, letters and digits only."""
    text = (text or "").lower().replace("’", "'").replace("‘", "'")
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text)).strip()


def _quote_in(quote: str, haystack: str) -> bool:
    """True when *quote* is (near-)verbatim in *haystack* (both already squashed).

    Models re-punctuate and drop a word or two when quoting, so exact matching
    would throw away good evidence; a quote mostly made up would not survive this.
    """
    if len(quote) < 8:
        return False
    if quote in haystack:
        return True
    matcher = difflib.SequenceMatcher(None, quote, haystack, autojunk=False)
    match = matcher.find_longest_match(0, len(quote), 0, len(haystack))
    if match.size >= 0.8 * len(quote):
        return True
    # Two long pieces of the quote, each verbatim, also count.
    words = quote.split()
    if len(words) >= 8:
        half = len(words) // 2
        return " ".join(words[:half]) in haystack and " ".join(words[half:]) in haystack
    return False


_SENTENCE_RE = re.compile(r"[^.!?]+[.!?’”\"']*")


def _focus(text: str, patterns: list[re.Pattern], limit: int) -> str:
    """Trim a long paragraph to the sentences that name the character, plus the next."""
    if len(text) <= limit:
        return text
    sentences = [s.strip() for s in _SENTENCE_RE.findall(text) if s.strip()]
    hits = [i for i, s in enumerate(sentences) if any(p.search(s) for p in patterns)]
    keep = sorted({j for i in hits for j in (i, i + 1) if j < len(sentences)})
    out, total = [], 0
    for i in keep:
        if total + len(sentences[i]) > limit:
            break
        out.append(sentences[i])
        total += len(sentences[i]) + 1
    return " ".join(out) or text[:limit]


_SPEECH_RE = (
    r"(?:said|says|asked|asks|replied|answered|whispered|murmured|muttered|shouted|"
    r"snapped|called|cried|yelled|added|continued|told|growled|hissed|demanded|"
    r"insisted|admitted|agreed|offered|repeated|breathed|drawled|teased|warned)"
)
# A follow-on paragraph that opens on a pronoun usually continues the same person.
# One that opens on a quote is usually the *other* speaker's reply, so it is not used.
_PRONOUN_START_RE = re.compile(r"^(?:he|she|they|his|her|their)\b", re.IGNORECASE)


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


# Portable fields of a normalised profile, as (key, sub-key) paths.
_PORTABLE_STRINGS = (
    ("archetype", None), ("summary", None), ("formative_experience", None),
    ("arc_pattern", None), ("motivations", "wants"), ("motivations", "needs"),
    ("voice", "tone"), ("voice", "rhythm"), ("voice", "humour"),
    ("appearance", "signature"), ("appearance", "presentation"),
)
_PORTABLE_LISTS = ("core_traits", "fears", "flaws", "values", "mannerisms")


def _leaks(profile: dict, forbidden: list[re.Pattern]) -> list[str]:
    """Every portable line that still names something from the book."""
    def dirty(text: str) -> bool:
        return any(p.search(text or "") for p in forbidden)

    found = []
    for key, sub in _PORTABLE_STRINGS:
        value = profile.get(key) if sub is None else (profile.get(key) or {}).get(sub)
        if value and dirty(value):
            found.append(value)
    for key in _PORTABLE_LISTS:
        found.extend(v for v in profile.get(key) or [] if dirty(v))
    found.extend(t for t in (profile.get("voice") or {}).get("tells") or [] if dirty(t))
    for rel in profile.get("relationships") or []:
        found.extend(v for v in (rel.get("dynamic"), rel.get("behaviour")) if v and dirty(v))
    return found


def _quarantine(profile: dict, forbidden: list[re.Pattern]) -> dict:
    """Move list items that still name book specifics into situational_anchors."""
    def dirty(text: str) -> bool:
        return any(p.search(text or "") for p in forbidden)

    anchors = list(profile.get("situational_anchors") or [])
    for key in _PORTABLE_LISTS:
        keep = []
        for item in profile.get(key) or []:
            (anchors if dirty(item) else keep).append(item)
        profile[key] = keep
    keep_rel = []
    for rel in profile.get("relationships") or []:
        if dirty(rel.get("dynamic")) or dirty(rel.get("behaviour")):
            anchors.append(f"{rel.get('dynamic')}: {rel.get('behaviour')}".strip(": "))
        else:
            keep_rel.append(rel)
    profile["relationships"] = keep_rel
    profile["situational_anchors"] = anchors
    return profile


def _tidy_anchors(profile: dict, forbidden: list[re.Pattern]) -> dict:
    """Drop anchors that are just roll-calls of names, and cap the list."""
    kept = [
        a for a in profile.get("situational_anchors") or []
        if sum(1 for p in forbidden if p.search(a)) < 4
    ]
    profile["situational_anchors"] = kept[:_MAX_ANCHORS]
    return profile


# --------------------------------------------------------------------------- #
# Extractor                                                                   #
# --------------------------------------------------------------------------- #

def _revision_notes(old: dict, new: dict, added: int) -> list[str]:
    """What a refine changed, computed rather than asked for (models misreport it)."""
    notes = [f"Read {added} new observation{'s' if added != 1 else ''} from passages not used before."]
    labels = {
        "core_traits": "Core traits", "fears": "Fears", "flaws": "Flaws", "values": "Values",
        "mannerisms": "Mannerisms", "situational_anchors": "Anchors",
    }
    for key, label in labels.items():
        before, after = old.get(key) or [], new.get(key) or []
        gone = [v for v in before if v not in after]
        came = [v for v in after if v not in before]
        if came:
            notes.append(f"{label} added: " + "; ".join(came))
        if gone:
            notes.append(f"{label} removed: " + "; ".join(gone))
    for key, label in (("archetype", "Archetype"), ("summary", "Summary"),
                       ("formative_experience", "Formative experience"), ("arc_pattern", "Arc")):
        if (old.get(key) or "") != (new.get(key) or ""):
            notes.append(f"{label} rewritten.")
    for key, label in (("motivations", "Wants & needs"), ("voice", "Voice"), ("appearance", "Appearance")):
        if (old.get(key) or {}) != (new.get(key) or {}):
            notes.append(f"{label} updated.")
    old_rel = [r.get("dynamic") for r in old.get("relationships") or []]
    new_rel = [r.get("dynamic") for r in new.get("relationships") or []]
    if old_rel != new_rel:
        notes.append("Relationship patterns: " + (", ".join(new_rel) or "none"))
    if len(notes) == 1:
        notes.append("The new evidence confirmed the existing sheet; nothing changed.")
    return notes


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
        self._cache: OrderedDict[tuple[int, ...], tuple[Corpus, dict[str, NameStat]]] = OrderedDict()
        self._cache_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Ollama                                                             #
    # ------------------------------------------------------------------ #

    def _complete(
        self,
        system: str,
        user: str,
        temperature: float,
        num_predict: int,
        schema: Optional[dict] = None,
    ):
        """One completion, consumed as a stream, reasoning off, parsed as JSON.

        Extraction is a transcription task, so thinking only burns the token
        budget. `schema` is passed as Ollama structured output, which constrains
        decoding to valid JSON of that shape.

        Streaming is not for the UI here. A non-streaming Ollama request cannot be
        abandoned: it holds the shared runner until it finishes. Reading the
        stream lets us stop at a deadline and close the connection, which is what
        actually aborts the generation on the host.
        """
        kwargs = {
            "model": self.s.extraction_model_effective,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "options": {
                "temperature": temperature,
                # Without an explicit num_ctx Ollama uses the model's own default,
                # whose KV cache may not fit beside the weights on the host.
                "num_ctx": self.s.chat_num_ctx or 40960,
                "num_predict": num_predict,
            },
            "stream": True,
        }
        if schema:
            kwargs["format"] = schema
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
            raise ValueError(f"The model returned no text (finish reason: {reason or 'unknown'})")
        if reason == "length":
            logger.warning("Extraction reply hit num_predict; JSON may be truncated")
        return _parse_json(content)

    # ------------------------------------------------------------------ #
    # Corpus                                                             #
    # ------------------------------------------------------------------ #

    def _corpus(self, calibre_ids: list[int]) -> tuple[Corpus, dict[str, NameStat]]:
        """Story text and name statistics for a selection, cached across requests.

        Discovery and the profile run that follows it read the same books; loading
        them once saves a full pass over the vector store per character.
        """
        # Order matters: it is reading order (series order, from the router), and a
        # profile's arc is built from it.
        key = tuple(dict.fromkeys(int(c) for c in calibre_ids))
        with self._cache_lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        return self._assemble(key, {cid: load_corpus(self.chat.collection, [cid]) for cid in key})

    def _assemble(self, key: tuple[int, ...], parts: dict[int, Corpus]) -> tuple[Corpus, dict[str, NameStat]]:
        corpus = Corpus()
        for calibre_id in key:
            part = parts[calibre_id]
            corpus.chunks.extend(part.chunks)
            corpus.cast_lists.extend(part.cast_lists)
            corpus.dropped_sections.extend(part.dropped_sections)
        if corpus.dropped_sections:
            logger.info("Skipped non-story sections: %s", "; ".join(corpus.dropped_sections))
        stats = name_stats(corpus)
        with self._cache_lock:
            self._cache[key] = (corpus, stats)
            while len(self._cache) > _CORPUS_CACHE_SIZE:
                self._cache.popitem(last=False)
        return corpus, stats

    # ------------------------------------------------------------------ #
    # Phase A — discovery                                                #
    # ------------------------------------------------------------------ #

    def discover(
        self,
        calibre_ids: list[int],
        titles: Optional[dict[int, str]] = None,
        guidance: str = "",
    ) -> Iterator[dict]:
        """Yield progress events, ending with the merged candidate list."""
        titles = titles or {}
        errors: list[dict] = []
        readable: list[int] = []
        parts: dict[int, Corpus] = {}

        for calibre_id in dict.fromkeys(int(c) for c in calibre_ids):
            title = titles.get(calibre_id) or f"#{calibre_id}"
            yield {"event": "book", "calibre_id": calibre_id, "title": title}
            part = parts[calibre_id] = load_corpus(self.chat.collection, [calibre_id])
            if not part.chunks:
                error = "No story text found — is this book indexed?"
                errors.append({"calibre_id": calibre_id, "title": title, "error": error})
                yield {"event": "error", "calibre_id": calibre_id, "title": title, "error": error}
                continue
            readable.append(calibre_id)

        if not readable:
            yield {"event": "candidates", "candidates": [], "filtered": [], "errors": errors}
            return

        corpus, stats = self._assemble(tuple(readable), parts)
        try:
            candidates, filtered = self._classify(corpus, stats, guidance)
        except Exception as exc:  # noqa: BLE001 — reported to the UI, not fatal
            logger.warning("Discovery failed", exc_info=exc)
            errors.append({"calibre_id": readable[0], "title": "selection", "error": str(exc)})
            yield {"event": "error", "calibre_id": readable[0], "title": "selection", "error": str(exc)}
            candidates, filtered = [], []

        yield {"event": "found", "calibre_id": readable[-1], "count": len(candidates)}
        yield {
            "event": "candidates",
            "candidates": candidates,
            "filtered": filtered,
            "errors": errors,
        }

    def _shortlist(self, corpus: Corpus, stats: dict[str, NameStat], guidance: str) -> list[NameStat]:
        """The names worth classifying: frequent, and present in more than one chapter.

        A name confined to one chapter is a walk-on (or, if matter detection ever
        misses one, a person being thanked in the acknowledgements).
        """
        sections = {(c.book_id, c.section) for c in corpus.chunks}
        min_sections = 2 if len(sections) > 3 else 1
        wanted = {normalize_name(w) for w in re.findall(r"[A-Z][\w’'\-]+", guidance or "")}
        declared = _declared_names(corpus.cast_lists)

        ranked = sorted(stats.values(), key=lambda stat: stat.mid, reverse=True)
        shortlist = [
            stat for stat in ranked
            if stat.mid >= _MIN_MENTIONS and len(stat.sections) >= min_sections
        ][:_MAX_CANDIDATES]
        # Names the user typed always get classified; a cast list's names only when
        # the story uses them enough to matter. Neither displaces the frequent names:
        # a book listing seventy people would otherwise crowd out its villain.
        chosen = {stat.name for stat in shortlist}
        for stat in ranked:
            if len(shortlist) >= _MAX_CANDIDATES + _EXTRA_CANDIDATES or stat.name in chosen:
                continue
            key = normalize_name(stat.name)
            if (key in wanted and stat.mid >= 2) or (key in declared and stat.mid >= _DECLARED_MIN):
                shortlist.append(stat)
                chosen.add(stat.name)
        return sorted(shortlist, key=lambda stat: stat.mid, reverse=True)

    def _classify(
        self, corpus: Corpus, stats: dict[str, NameStat], guidance: str
    ) -> tuple[list[dict], list[dict]]:
        shortlist = self._shortlist(corpus, stats, guidance)
        if not shortlist:
            return [], []
        total_sections = len({(c.book_id, c.section) for c in corpus.chunks})

        blocks = []
        for i, stat in enumerate(shortlist, 1):
            facts = [
                f"{stat.mid} mentions in {len(stat.sections)} of {total_sections} chapters",
                f"speaks {stat.speech}×",
                f"acts {stat.person}×",
                f"after in/at/from {stat.place}×",
            ]
            if stat.full_name:
                facts.append(f'often "{stat.full_name}"')
            # A title can be one person's name ("the Regent") or several people's
            # rank ("the King"); only more passages can tell which.
            count = _CONTEXTS_PER_TITLE if stat.name.lower() in _TITLE_WORDS else _CONTEXTS_PER_NAME
            passages = "\n".join(f"   · {c}" for c in contexts(corpus, stat.name, count))
            blocks.append(f"{i}. {stat.name} — {'; '.join(facts)}\n{passages}")

        parsed = self._complete(
            _CLASSIFY_SYSTEM,
            "Names:\n\n" + "\n\n".join(blocks) + "\n" + _guidance_block(guidance)
            + "\nClassify every name.",
            _DISCOVERY_TEMPERATURE,
            _DISCOVERY_TOKENS,
            _CLASSIFY_SCHEMA,
        )
        entries = parsed.get("entries") if isinstance(parsed, dict) else parsed
        if not isinstance(entries, list):
            raise ValueError("Unexpected discovery payload")

        by_name = {s.name.lower(): s for s in shortlist}
        verdicts: dict[str, dict] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            stat = by_name.get(_text(entry.get("name")).lower())
            if stat is None:
                continue  # the model may only classify names the text contains
            verdicts[stat.name] = entry

        filtered: list[dict] = []
        people: dict[str, dict] = {}
        for stat in shortlist:
            entry = verdicts.get(stat.name)
            if entry is None:
                # Omitted by the model: fall back on the counts.
                is_person = stat.speech + stat.person >= 5 and stat.place * 2 < stat.speech + stat.person
                entry = {"kind": "person" if is_person else "other", "role": None, "description": ""}
            kind = _text(entry.get("kind")).lower() or "other"
            if kind != "person":
                filtered.append({"name": stat.name, "kind": kind})
                continue
            people[stat.name] = {
                "name": stat.name,
                "aliases": [],
                "role": _canonical_role(entry.get("role")),
                "description": _text(entry.get("description")) or None,
                "mentions": stat.mid,
                "sections": set(stat.sections),
                "source_book_ids": sorted(stat.books),
                "_same_as": _text(entry.get("same_as")),
            }

        self._merge_same_person(people, corpus)

        guided = {normalize_name(w) for w in re.findall(r"[A-Z][\w’'\-]+", guidance or "")}
        lead = max((p["mentions"] for p in people.values()), default=1) or 1
        candidates = []
        for person in people.values():
            share = person["mentions"] / lead
            named_by_user = any(normalize_name(n) in guided for n in [person["name"], *person["aliases"]])
            if not named_by_user:
                if share < _MINOR_SHARE or person["mentions"] < _MINOR_FLOOR:
                    person["role"] = "minor"
                elif person["role"] == "protagonist" and share < _LEAD_SHARE:
                    person["role"] = "supporting"
                elif person["role"] in (None, "minor") and share >= _SUPPORTING_SHARE:
                    # The UI hides minor characters; one this present must not vanish.
                    person["role"] = "supporting"
            candidates.append({
                "name": person["name"],
                "aliases": person["aliases"],
                "role": person["role"],
                "description": person["description"],
                "mentions": person["mentions"],
                "source_book_ids": person["source_book_ids"],
            })
        candidates.sort(key=lambda c: c["mentions"], reverse=True)
        return candidates, filtered

    @staticmethod
    def _merge_same_person(people: dict[str, dict], corpus: Corpus) -> None:
        """Fold nicknames and surnames into one entry, in place.

        Links come from the model ("Damianos is the same as Damen") and from the
        book's own cast list. A link is refused when it would merge a title, or
        when the cast list says the two names belong to different people.
        """
        declared = _declared_names(corpus.cast_lists)
        parent = {name: name for name in people}

        def root(name: str) -> str:
            while parent[name] != name:
                name = parent[name]
            return name

        def link(a: str, b: str) -> None:
            ra, rb = root(a), root(b)
            if ra == rb:
                return
            ka, kb = normalize_name(a), normalize_name(b)
            if ka in declared and kb in declared and declared[ka] != declared[kb]:
                logger.info("Not merging %s and %s: the cast list separates them", a, b)
                return
            if _looks_like_title(a) or _looks_like_title(b):
                logger.info("Not merging %s and %s: a title is not an identity", a, b)
                return
            # The better-known name becomes the display name.
            keep, drop = (ra, rb) if people[ra]["mentions"] >= people[rb]["mentions"] else (rb, ra)
            parent[drop] = keep

        lookup = {name.lower(): name for name in people}
        for name, person in people.items():
            target = lookup.get(person.pop("_same_as", "").lower())
            if target and target != name:
                link(name, target)
        groups: dict[str, list[str]] = {}
        for name in people:
            group = declared.get(normalize_name(name))
            if group:
                groups.setdefault(group, []).append(name)
        for names in groups.values():
            for other in names[1:]:
                link(names[0], other)

        for name in list(people):
            keep = root(name)
            if keep == name:
                continue
            into, gone = people[keep], people.pop(name)
            into["aliases"].append(gone["name"])
            into["aliases"].extend(a for a in gone["aliases"] if a not in into["aliases"])
            into["sections"] |= gone["sections"]
            into["mentions"] += gone["mentions"]
            into["source_book_ids"] = sorted(set(into["source_book_ids"]) | set(gone["source_book_ids"]))
            into["role"] = _best_role(into["role"], gone["role"])
            into["description"] = into["description"] or gone["description"]

    # ------------------------------------------------------------------ #
    # Phase B — profiles                                                 #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _people_names(stats: dict[str, NameStat]) -> list[str]:
        """Names in the text that behave like people, for 'who else is here'."""
        return [
            s.name for s in stats.values()
            if s.speech + s.person >= 3 and s.place * 2 < s.speech + s.person
        ]

    def gather_evidence(
        self,
        name: str,
        aliases: list[str],
        corpus: Corpus,
        others: list[str],
        books: list[int],
        exclude: Optional[set[str]] = None,
        coverage: Optional[dict[tuple[int, int], int]] = None,
        batches: Optional[int] = None,
    ) -> tuple[list[list[Passage]], int]:
        """Paragraphs about this character, split evenly by book, in batches.

        Paragraphs where they speak come first, then ones where they are the only
        named person, then shared scenes. A paragraph that mentions only them may
        carry on into the next one (their reaction) when it opens with a pronoun
        and names nobody else.

        The budget grows with how much text there is about them — a lead in a
        trilogy gets several times a walk-on's — and is shared equally between
        books, so no single volume defines them. Within a book the least covered
        chapters (by `coverage`, from earlier passes) are read first, and
        paragraphs in `exclude` (already read) are skipped.

        Returns the batches and how many unread paragraphs were available.
        """
        exclude = exclude or set()
        coverage = coverage or {}
        own = [p for p in (_name_pattern(n) for n in [name, *aliases]) if p]
        if not own:
            return [], 0
        own_keys = {normalize_name(n) for n in [name, *aliases]}
        other_patterns = [
            p for p in (_name_pattern(o) for o in others if normalize_name(o) not in own_keys) if p
        ]
        names_alt = "|".join(re.escape(re.sub(r"^(?:the|a|an)\s+", "", n, flags=re.I)) for n in [name, *aliases])
        speaks = re.compile(
            rf"[’”\"']\s*,?\s*(?:{_SPEECH_RE})\s+(?:{names_alt})\b|\b(?:{names_alt})\s+(?:{_SPEECH_RE})\b",
            re.IGNORECASE,
        )
        book_index = {book_id: i + 1 for i, book_id in enumerate(books)}

        # book_id -> (book_id, section) -> [(score, passage)]
        found: dict[int, dict[tuple[int, int], list[tuple[int, Passage]]]] = {}
        seen: set[str] = set()
        for chunk in corpus.chunks:
            paragraphs = [p.strip() for p in chunk.text.split("\n") if p.strip()]
            for i, para in enumerate(paragraphs):
                if not any(p.search(para) for p in own):
                    continue
                fingerprint = _squash(para)[:160]
                if fingerprint in seen:
                    continue  # chunk overlap, or the same book twice in the library
                seen.add(fingerprint)
                if fingerprint in exclude:
                    continue
                solo = not any(p.search(para) for p in other_patterns)
                text = _focus(para, own, _PARAGRAPH_CHARS)
                if solo and i + 1 < len(paragraphs):
                    nxt = paragraphs[i + 1]
                    if _PRONOUN_START_RE.search(nxt) and not any(p.search(nxt) for p in other_patterns):
                        text += "\n" + nxt[:_FOLLOW_ON_CHARS]
                score = (3 if speaks.search(para) else 0) + (2 if solo else 0)
                passage = Passage(
                    book=book_index.get(chunk.book_id, 0),
                    book_id=chunk.book_id,
                    section=chunk.section,
                    position=chunk.position,
                    order=chunk.order,
                    text=text,
                    fingerprint=fingerprint,
                )
                found.setdefault(chunk.book_id, {}).setdefault(
                    (chunk.book_id, chunk.section), []
                ).append((score, passage))

        available = sum(len(items) for chapters in found.values() for items in chapters.values())
        if not available:
            return [], 0
        if batches is None:
            batches = next(n for limit, n in _BATCH_STEPS if available < limit)
        budget = batches * _EVIDENCE_BATCH_CHARS

        def queues_for(chapters: dict) -> list[list[Passage]]:
            # Least-covered chapters first, then story order; best paragraph first.
            keys = sorted(chapters, key=lambda key: (coverage.get(key, 0), key[1]))
            return [
                [passage for _, passage in sorted(chapters[key], key=lambda item: (-item[0], item[1].order))]
                for key in keys
            ]

        def take(queues: list[list[Passage]], limit: int) -> int:
            used = 0
            while queues and used < limit:
                for queue in list(queues):
                    if not queue:
                        queues.remove(queue)
                        continue
                    passage = queue[0]
                    if used + len(passage.text) > limit:
                        queues.remove(queue)
                        continue
                    picked.append(queue.pop(0))
                    used += len(passage.text)
            return used

        picked: list[Passage] = []
        per_book = budget // len(found)
        leftovers: list[list[Passage]] = []
        spent = 0
        for book_id in books:
            if book_id not in found:
                continue
            queues = queues_for(found[book_id])
            spent += take(queues, per_book)
            leftovers.extend(q for q in queues if q)
        # A book with little about them leaves budget for the others.
        if spent < budget and leftovers:
            take(leftovers, budget - spent)

        picked.sort(key=lambda p: (p.book, p.order))
        out: list[list[Passage]] = []
        current: list[Passage] = []
        size = 0
        for passage in picked:
            if current and size + len(passage.text) > _EVIDENCE_BATCH_CHARS:
                out.append(current)
                current, size = [], 0
            current.append(passage)
            size += len(passage.text) + 30
        if current:
            out.append(current)
        return out, available

    def _observe(
        self,
        name: str,
        aliases: list[str],
        passages: list[Passage],
        others: list[str],
        guidance: str,
        book_count: int,
    ) -> tuple[list[dict], list[str]]:
        """Observations about one person from one batch, each pinned to its passage.

        The model only reports what it saw and quotes it. The code finds the quote
        in the batch — dropping it if it is not there — and takes the book, chapter
        and position from the passage it came from, so where a trait is seen is
        measured rather than reported.
        """
        def label(passage: Passage) -> str:
            book = f"Book {passage.book}" if book_count > 1 else "Book"
            return f"[{book} · {round(passage.position * 100)}% through]"

        batch = "\n\n".join(f"{label(p)}\n{p.text}" for p in passages)
        parsed = self._complete(
            _OBSERVE_SYSTEM.replace("{name}", name),
            _OBSERVE_USER.format(
                name=name,
                aliases=", ".join(aliases) or "none",
                others=", ".join(others[:15]) or "none",
                guidance=_guidance_block(guidance),
                evidence=batch,
            ),
            _OBSERVE_TEMPERATURE,
            _OBSERVE_TOKENS,
            _OBSERVE_SCHEMA,
        )
        if not isinstance(parsed, dict):
            return [], []
        squashed = [(p, _squash(p.text)) for p in passages]
        haystack = _squash(batch)

        kept, dropped = [], 0
        for obs in parsed.get("observations") or []:
            if not isinstance(obs, dict):
                continue
            note, quote = _text(obs.get("note")), _text(obs.get("quote"))
            q = _squash(quote)
            home = next((p for p, text in squashed if _quote_in(q, text)), None)
            if not note or (home is None and not _quote_in(q, haystack)):
                dropped += 1
                continue
            source = _text(obs.get("source")).lower()
            kept.append({
                "aspect": _text(obs.get("aspect")) or "trait",
                "note": note,
                "source": source if source in _SOURCES else "shown",
                "by": _text(obs.get("by")) if source == "other" else "",
                "quote": quote,
                "book": home.book if home else 0,
                "book_id": home.book_id if home else 0,
                "section": home.section if home else 0,
                "pos": round(home.position, 2) if home else None,
            })
        lines = [line for line in _as_list(parsed.get("lines")) if _quote_in(_squash(line), haystack)]
        logger.info("%s: kept %d observations, dropped %d unquoted", name, len(kept), dropped)
        return kept, lines

    def _consolidate(self, name: str, observations: list[dict], book_count: int) -> list[dict]:
        """Group observations into themes. Falls back to one theme per observation."""
        def where(obs: dict) -> str:
            pct = f"{round((obs.get('pos') or 0) * 100)}%"
            book = f"B{obs.get('book') or '?'} " if book_count > 1 else ""
            who = f"other: {obs['by']}" if obs.get("source") == "other" and obs.get("by") else obs.get("source", "shown")
            return f"{book}{pct} · {who}"

        listing = "\n".join(
            f"{i}. [{where(o)}] {o['aspect']}: {o['note']}" for i, o in enumerate(observations, 1)
        )
        themes: list[dict] = []
        claimed: set[int] = set()
        try:
            parsed = self._complete(
                _CONSOLIDATE_SYSTEM.replace("{name}", name),
                f"Notes about {name}:\n{listing}\n\nGroup every note into themes.",
                _OBSERVE_TEMPERATURE,
                _CONSOLIDATE_TOKENS,
                _CONSOLIDATE_SCHEMA,
            )
            for theme in (parsed.get("themes") if isinstance(parsed, dict) else None) or []:
                if not isinstance(theme, dict):
                    continue
                members = []
                for raw in theme.get("members") or []:
                    try:
                        index = int(raw) - 1
                    except (TypeError, ValueError):
                        continue
                    if 0 <= index < len(observations) and index not in claimed:
                        members.append(index)
                        claimed.add(index)
                statement = _text(theme.get("statement"))
                if members and statement:
                    themes.append({"aspect": _text(theme.get("aspect")) or observations[members[0]]["aspect"],
                                   "statement": statement, "members": members})
        except Exception as exc:  # noqa: BLE001 — themes are an aid; singletons still work
            logger.warning("Theme grouping failed for %s", name, exc_info=exc)
        for index, obs in enumerate(observations):
            if index not in claimed:
                themes.append({"aspect": obs["aspect"], "statement": obs["note"], "members": [index]})
        return themes

    @staticmethod
    def _tier(themes: list[dict], observations: list[dict], book_count: int, new_from: Optional[int] = None) -> list[dict]:
        """Measure each theme's support and sort it into a tier.

        The tier, not the model, decides what may become a headline trait: a
        quality seen in one scene, or only in the character's own (possibly
        ironic) words, or only in another character's opinion, cannot.
        """
        chapters_seen = {(o["book_id"], o["section"]) for o in observations if o.get("section")}
        books_seen = {o["book"] for o in observations if o.get("book")}
        established_min = _ESTABLISHED_CHAPTERS if len(chapters_seen) >= 10 else 2

        for theme in themes:
            members = [observations[i] for i in theme["members"]]
            chapters = {(o["book_id"], o["section"]) for o in members if o.get("section")}
            books = {o["book"] for o in members if o.get("book")}
            sources = {key: sum(1 for o in members if o.get("source") == key) for key in _SOURCES}
            positions = [o["pos"] for o in members if o.get("pos") is not None]

            if sources["shown"] == 0 and sources["self"] and not sources["other"]:
                tier = "self"
            elif sources["other"] > sources["shown"] + sources["self"]:
                tier = "others"
            elif len(chapters) < established_min:
                tier = "moment"
            elif len(books_seen) >= 2 and len(books) == 1:
                tier = "changes"
            elif len(books_seen) <= 1 and positions and max(positions) - min(positions) < 0.35:
                tier = "changes"
            else:
                tier = "established"

            if book_count > 1:
                spread = " ".join(
                    f"B{b}:{sum(1 for o in members if o.get('book') == b)}" for b in range(1, book_count + 1)
                )
            else:
                thirds = [0, 0, 0]
                for pos in positions:
                    thirds[min(2, int(pos * 3))] += 1
                spread = f"early {thirds[0]} · middle {thirds[1]} · late {thirds[2]}"
            quotes = [o["quote"] for o in sorted(members, key=lambda o: o.get("source") != "shown")][:2]
            by = sorted({o["by"] for o in members if o.get("by")})
            theme.update({
                "new": sum(1 for i in theme["members"] if new_from is not None and i >= new_from),
                "tier": tier,
                "chapters": len(chapters),
                "books": len(books),
                "sources": sources,
                "spread": spread,
                "quotes": quotes,
                "by": by,
            })
        themes.sort(key=lambda t: (t["chapters"], len(t["members"])), reverse=True)
        return themes

    @staticmethod
    def _render_themes(themes: list[dict], book_count: int) -> str:
        sections = (
            ("established", "ESTABLISHED", 40),
            ("changes", "CHANGES OVER TIME", 15),
            ("self", "SELF-DESCRIPTIONS (their own words only)", 8),
            ("others", "OTHERS' VIEWS", 10),
            ("moment", "MOMENTS (one or two scenes — no headline fields)", 15),
        )
        out = []
        for tier, heading, cap in sections:
            rows = [t for t in themes if t["tier"] == tier][:cap]
            if not rows:
                continue
            out.append(f"## {heading}")
            for t in rows:
                support = f"{t['chapters']} chapter{'s' if t['chapters'] != 1 else ''}"
                if book_count > 1:
                    support += f", {t['books']}/{book_count} books"
                src = t["sources"]
                support += f"; shown {src['shown']}, self {src['self']}, others {src['other']}"
                if t["by"]:
                    support += f" (said by {', '.join(t['by'][:3])})"
                line = f"- {t['aspect']}: {t['statement']}  [{support}; {t['spread']}]"
                if tier != "moment" and t["quotes"]:
                    line += "\n    e.g. " + " / ".join(f"“{q}”" for q in t["quotes"])
                out.append(line)
            out.append("")
        return "\n".join(out).strip()

    def profile_events(
        self,
        name: str,
        aliases: Optional[list[str]] = None,
        calibre_ids: Optional[list[int]] = None,
        role: Optional[str] = None,
        guidance: str = "",
        others: Optional[list[str]] = None,
        previous: Optional[dict] = None,
    ) -> Iterator[dict]:
        """Build (or, with `previous`, refine) one profile, yielding progress.

        `previous` is {"profile": current fields, "analysis": stored analysis,
        "locked": [field names]}. A refine reads only passages no earlier pass
        used, merges what it finds with the stored observations, and asks the
        model to review the current sheet against the combined themes. Locked
        fields — ones the user edited by hand — are returned untouched.

        Ends with {"event": "result", "profile": ..., "analysis": ...}.
        """
        aliases = aliases or []
        books = list(dict.fromkeys(int(c) for c in (calibre_ids or [])))
        corpus, stats = self._corpus(books)
        own_keys = {normalize_name(n) for n in [name, *aliases]}
        cast = list(dict.fromkeys([*(others or []), *self._people_names(stats)]))
        cast = [c for c in cast if normalize_name(c) not in own_keys]

        prior = (previous or {}).get("analysis") or {}
        prior_observations = [o for o in prior.get("observations") or [] if isinstance(o, dict)]
        prior_lines = _as_list(prior.get("lines"))
        used = set(prior.get("used") or [])
        if prior.get("books") and list(prior["books"]) != books:
            # Book numbering is per selection; re-number what the old pass saw.
            old_order = list(prior["books"])
            for obs in prior_observations:
                if obs.get("book_id") in books:
                    obs["book"] = books.index(obs["book_id"]) + 1
            logger.info("%s: re-numbered stored observations from %s to %s", name, old_order, books)
        coverage: dict[tuple[int, int], int] = {}
        for obs in prior_observations:
            key = (obs.get("book_id"), obs.get("section"))
            coverage[key] = coverage.get(key, 0) + 1

        refining = previous is not None
        yield {"event": "progress", "name": name, "message": "Choosing passages…"}
        batches, available = self.gather_evidence(
            name, aliases, corpus, cast, books,
            exclude=used,
            coverage=coverage,
            batches=_REFINE_BATCHES if refining and prior_observations else None,
        )
        if not batches and not prior_observations:
            raise RuntimeError("No story text names this character — are the source books indexed?")
        logger.info("%s: %d unread paragraphs, reading %d batches", name, available, len(batches))

        observations: list[dict] = list(prior_observations)
        lines: list[str] = list(prior_lines)
        known = {(_squash(o["quote"]), o["aspect"]) for o in observations}
        for i, batch in enumerate(batches, 1):
            yield {"event": "progress", "name": name, "message": f"Reading passages ({i}/{len(batches)})…"}
            try:
                got, said = self._observe(name, aliases, batch, cast, guidance, len(books))
            except Exception as exc:  # noqa: BLE001 — one bad batch must not sink the profile
                logger.warning("%s: batch %d failed", name, i, exc_info=exc)
                yield {"event": "progress", "name": name, "message": f"Skipped batch {i}: {exc}"}
                continue
            for obs in got:
                key = (_squash(obs["quote"]), obs["aspect"])
                if key not in known:
                    known.add(key)
                    observations.append(obs)
            lines.extend(line for line in said if line not in lines)
            used.update(p.fingerprint for p in batch)
        if not batches:
            yield {"event": "progress", "name": name,
                   "message": "Every passage has been read; re-weighing the existing evidence…"}
        if len(observations) < 3:
            raise RuntimeError(
                f"Only {len(observations)} observation(s) about {name} could be verified "
                "against the text — too little to profile reliably."
            )
        added = len(observations) - len(prior_observations)
        observations = observations[-_MAX_OBSERVATIONS:]
        new_from = len(observations) - added if refining else None

        yield {"event": "progress", "name": name, "message": f"Grouping {len(observations)} observations into themes…"}
        themes = self._tier(
            self._consolidate(name, observations, len(books)), observations, len(books), new_from
        )

        # Every proper name in the text except their own is book-specific.
        own_tokens = {t for n in [name, *aliases] for t in normalize_name(n).split()}
        forbidden_names = sorted(
            (s.name for s in stats.values() if normalize_name(s.name) not in own_tokens),
            key=lambda n: -stats[n].mid,
        )
        forbidden = [p for p in (_name_pattern(n) for n in forbidden_names) if p]

        locked = [f for f in (previous or {}).get("locked") or [] if f in _PROFILE_FIELDS]
        current = (previous or {}).get("profile") or {}
        draft = ""
        if locked:
            draft = _LOCKED_NOTE.format(locked=json.dumps(
                {k: current.get(k) for k in locked}, ensure_ascii=False, indent=1
            ))

        titles = []
        for i, book_id in enumerate(books, 1):
            title = next((c.title for c in corpus.chunks if c.book_id == book_id), "") or f"#{book_id}"
            titles.append(f"{i}. {title}")

        yield {"event": "progress", "name": name, "message": "Writing the profile…"}
        raw = self._complete(
            _PROFILE_SYSTEM,
            _PROFILE_USER.format(
                name=name,
                role=role or "unknown",
                books="; ".join(titles) or "unknown",
                guidance=_guidance_block(guidance),
                themes=self._render_themes(themes, len(books)),
                lines="\n".join(f"- {line}" for line in lines[:_MAX_LINES]) or "none recorded",
                forbidden=", ".join(forbidden_names[:60]) or "none",
                draft=draft,
            ),
            _PROFILE_TEMPERATURE,
            _PROFILE_TOKENS,
            _PROFILE_SCHEMA,
        )
        if not isinstance(raw, dict):
            raise ValueError("The model returned a list where a profile object was expected")
        profile = _normalise_profile(raw, self.s.extraction_model_effective)

        leaks = _leaks(profile, forbidden)
        if leaks:
            yield {"event": "progress", "name": name, "message": "Removing book-specific names…"}
            logger.info("%s: %d portable lines name book specifics; rewriting", name, len(leaks))
            names_used = sorted({n for n in forbidden_names for line in leaks if _name_pattern(n).search(line)})
            try:
                fixed = self._complete(
                    _REPAIR_SYSTEM,
                    f"Remove these words outside situational_anchors: {', '.join(names_used)}\n\n"
                    f"Profile:\n{json.dumps(raw, ensure_ascii=False, indent=1)}",
                    _PROFILE_TEMPERATURE,
                    _PROFILE_TOKENS,
                    _PROFILE_SCHEMA,
                )
                if isinstance(fixed, dict):
                    profile = _normalise_profile(fixed, self.s.extraction_model_effective)
            except Exception as exc:  # noqa: BLE001 — the unrepaired profile still stands
                logger.warning("Portability rewrite failed for %s", name, exc_info=exc)
            profile = _quarantine(profile, forbidden)
        profile = _tidy_anchors(profile, forbidden)

        for field_name in locked:
            if field_name in current:
                profile[field_name] = current[field_name]
        notes = _revision_notes(current, profile, added) if refining else []

        analysis = {
            "version": 2,
            "books": books,
            "observations": observations,
            "lines": lines[:_MAX_STORED_LINES],
            "used": sorted(used),
            "passes": int(prior.get("passes") or 0) + 1,
            "themes": [
                {k: t[k] for k in ("aspect", "statement", "tier", "chapters", "books")}
                for t in themes
            ],
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        yield {"event": "result", "name": name, "profile": profile, "analysis": analysis, "notes": notes}

    def build_profile(
        self,
        name: str,
        aliases: Optional[list[str]] = None,
        calibre_ids: Optional[list[int]] = None,
        role: Optional[str] = None,
        description: Optional[str] = None,  # noqa: ARG002 — kept for API compatibility
        guidance: str = "",
        others: Optional[list[str]] = None,
    ) -> dict:
        """The profile alone, without progress events (scripts and tests)."""
        for event in self.profile_events(name, aliases, calibre_ids, role, guidance, others):
            if event["event"] == "result":
                return {**event["profile"], "analysis": event["analysis"]}
        raise RuntimeError("Profile generation ended without a result")

    def stream_profiles(self, requests: list[dict], guidance: str = "") -> Iterator[dict]:
        """Yield one event per character so the UI can fill cards as they land."""
        cast_names = [str(item.get("name") or "") for item in requests]
        for item in requests:
            name = item["name"]
            yield {"event": "started", "name": name}
            try:
                for event in self.profile_events(
                    name=name,
                    aliases=item.get("aliases") or [],
                    calibre_ids=item.get("calibre_ids") or [],
                    role=item.get("role"),
                    guidance=guidance,
                    others=[c for c in cast_names if c and c != name],
                ):
                    if event["event"] == "result":
                        yield {"event": "ok", "name": name,
                               "profile": {**event["profile"], "analysis": event["analysis"]}}
                    else:
                        yield event
            except Exception as exc:  # noqa: BLE001 — one failure must not stop the rest
                logger.warning("Profile synthesis failed for %s", name, exc_info=exc)
                yield {"event": "error", "name": name, "error": str(exc)}
        yield {"event": "done"}

    def refine(self, character: dict, calibre_ids: list[int], guidance: str = "") -> Iterator[dict]:
        """Another pass over a saved profile; see `profile_events`."""
        name = character["name"]
        yield {"event": "started", "name": name}
        try:
            for event in self.profile_events(
                name=name,
                aliases=character.get("aliases") or [],
                calibre_ids=calibre_ids,
                role=character.get("role"),
                guidance=guidance,
                previous={
                    "profile": {k: character.get(k) for k in _PROFILE_FIELDS},
                    "analysis": character.get("analysis") or {},
                    "locked": character.get("locked_fields") or [],
                },
            ):
                if event["event"] == "result":
                    yield {"event": "ok", "name": name, "notes": event["notes"],
                           "profile": {**event["profile"], "analysis": event["analysis"]}}
                else:
                    yield event
        except Exception as exc:  # noqa: BLE001 — reported to the UI
            logger.warning("Refine failed for %s", name, exc_info=exc)
            yield {"event": "error", "name": name, "error": str(exc)}
        yield {"event": "done"}
