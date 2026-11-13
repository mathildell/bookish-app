"""The story text of indexed books, separated from everything that is not story.

Character extraction used to sample a dozen chunks and let the model find names
in them. That had three failure modes this module removes in code, before any
model sees the text:

* **Front and back matter.** Acknowledgements, "About the Author", dedications,
  copyright pages, "Also by" lists and newsletter plugs are full of real people's
  names. They are dropped by heading, by EPUB file name and by position.
* **Sampling.** Twelve excerpts cannot tell a protagonist from a walk-on. Names are
  counted over the *whole* story instead, with how many chapters each one spans, so
  prominence is measured rather than guessed.
* **Drop caps.** Many EPUBs split a chapter's first letter into its own element,
  which the ingestor turns into "L\\noth sighed". That is stitched back together.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

# --------------------------------------------------------------------------- #
# Front / back matter                                                         #
# --------------------------------------------------------------------------- #

# The first line of a section that is never story.
_MATTER_HEADING_RE = re.compile(
    r"""^\W*(?:
        (?:table\ of\ )?contents
      | acknowledge?ments?
      | about\ (?:the\ )?authors?
      | (?:also|other\ books|more\ books|books)\ by
      | by\ the\ same\ author
      | copyright
      | dedication
      | afterword
      | (?:a\ )?(?:note|letter)\ (?:from|to)\ (?:the\ )?(?:author|reader)s?
      | author'?s?’?s?\ notes?
      | thank\ you\ (?:so\ much\ )?for\ reading
      | (?:trigger|content)\ (?:warnings?|notes?)
      | praise\ for
      | (?:an\ )?excerpt
      | sneak\ peek
      | bonus\ (?:scene|chapter|content|epilogue)
      | (?:join|sign\ up|subscribe)
      | newsletter
      | glossary
      | pronunciation
      | maps?\b
      | playlist
      | reading\ group
      | discussion\ questions
      | title\ page
      | cover
    )""",
    re.IGNORECASE | re.VERBOSE,
)

# Headings that are matter only at either end of a book: "About Lisa Henry" or
# "About Red Heir" (the blurb) there, but "About an hour later" mid-story.
_OUTER_HEADING_RE = re.compile(r"^\W*about\s+\S+", re.IGNORECASE)

# A list of the cast. Not story, but the one place a book states who is who.
_CAST_HEADING_RE = re.compile(
    r"^\W*(?:(?:list|cast)\ of\ )?characters\b|^\W*dramatis\ personae|^\W*the\ cast\b|^\W*who'?s\ who",
    re.IGNORECASE | re.VERBOSE,
)

# Phrases that only appear in matter. Checked near the start of a section in the
# outer fifth of a book, where "thanks to" is not a line of dialogue.
_MATTER_MARKERS = (
    "all rights reserved", "isbn", "©", "copyright", "is dedicated to",
    "thank you for reading", "thank you so much for reading", "thanks for reading",
    "i would like to thank", "i'd like to thank", "i’d like to thank", "i want to thank",
    "thanks to", "my thanks", "beta reader", "sign up for", "newsletter",
    "www.", "http", ".com", "first published", "published by", "cover design",
    "cover by", "edited by", "this is a work of fiction", "printed in",
    "please consider leaving a review", "leave a review",
)

# EPUB file names that give the game away ("…_ack_r1.htm", "copyright.xhtml").
_MATTER_FILE_RE = re.compile(
    r"(?:^|[/_\-.])(?:ack\w*|acknowledg\w*|cop|copyright\w*|toc|contents|dedication|dedi|"
    r"about\w*|author\w*|alsoby|also|adcard|ad|titlepage|title|halftitle|fm\d*|bm\d*|"
    r"cover|praise|newsletter|signup|teaser|excerpt)(?:[/_\-.\d]|$)",
    re.IGNORECASE,
)

_OUTER = 0.2  # sections within this share of either end are suspect


def fix_drop_caps(text: str) -> str:
    """Rejoin a chapter's first letter to its word: "L\\noth" -> "Loth"."""
    return re.sub(r"(?m)^([‘“\"']?[A-Z])\n(?=[A-Za-z])", r"\1", text or "")


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def _section_kind(name: str, text: str, position: float) -> str:
    """'story', 'matter' or 'cast' for one EPUB section."""
    head = _first_line(text)
    # Headings are short lines; "Contents of the chest spilled…" is prose.
    heading = len(head) <= 50
    if heading and _CAST_HEADING_RE.match(head):
        return "cast"
    if heading and _MATTER_HEADING_RE.match(head):
        return "matter"
    outer = position < _OUTER or position > 1 - _OUTER
    if not outer:
        return "story"
    if heading and _OUTER_HEADING_RE.match(head):
        return "matter"
    if _MATTER_FILE_RE.search(name or ""):
        return "matter"
    opening = text[:600].lower()
    if any(marker in opening for marker in _MATTER_MARKERS):
        return "matter"
    # A short section with no dialogue at either end is a title page, an epigraph
    # or a list; a real opening chapter is longer or has someone speaking.
    if len(text) < 1500 and not re.search(r"[“”\"‘’]\s*\w", text):
        return "matter"
    return "story"


# --------------------------------------------------------------------------- #
# Corpus                                                                      #
# --------------------------------------------------------------------------- #

@dataclass
class Chunk:
    text: str
    book_id: int
    title: str
    chapter: str        # the EPUB section id
    section: int        # running section number within the book, story only
    order: int          # running chunk number within the book
    position: float = 0.0  # 0..1 through the book's story text


@dataclass
class Corpus:
    chunks: list[Chunk] = field(default_factory=list)     # story only, in reading order
    cast_lists: list[str] = field(default_factory=list)  # "CHARACTERS" pages
    dropped_sections: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(c.text for c in self.chunks)


def _chunk_index(chunk_id: str) -> int:
    match = re.search(r"_c(\d+)$", chunk_id or "")
    return int(match.group(1)) if match else 0


def load_corpus(collection, calibre_ids: list[int]) -> Corpus:
    """Every story chunk of the selected books, read from the vector store."""
    corpus = Corpus()
    for calibre_id in calibre_ids:
        rows: list[tuple[int, str, dict]] = []
        offset = 0
        while True:
            page = collection.get(
                where={"_cid": {"$in": [int(calibre_id)]}},
                include=["documents", "metadatas"],
                limit=500,
                offset=offset,
            )
            ids = page.get("ids") or []
            for chunk_id, document, metadata in zip(
                ids, page.get("documents") or [], page.get("metadatas") or []
            ):
                rows.append((_chunk_index(chunk_id), document or "", metadata or {}))
            offset += len(ids)
            if len(ids) < 500:
                break
        rows.sort(key=lambda row: row[0])
        if not rows:
            continue

        # Group consecutive chunks into their EPUB sections.
        sections: list[tuple[str, list[tuple[str, dict]]]] = []
        for _, document, metadata in rows:
            name = metadata.get("_chapter") or ""
            if not sections or sections[-1][0] != name:
                sections.append((name, []))
            sections[-1][1].append((fix_drop_caps(document), metadata))

        total = max(1, sum(len(parts) for _, parts in sections))
        seen = 0
        story_section = 0
        for name, parts in sections:
            position = (seen + len(parts) / 2) / total
            seen += len(parts)
            full = "\n".join(doc for doc, _ in parts)
            kind = _section_kind(name, full, position)
            if kind == "cast":
                corpus.cast_lists.append(full)
                continue
            if kind == "matter":
                corpus.dropped_sections.append(f"{calibre_id}:{_first_line(full)[:40]}")
                continue
            story_section += 1
            for document, metadata in parts:
                # `order` is per book: corpora for a selection are concatenated.
                corpus.chunks.append(Chunk(
                    text=document,
                    book_id=int(metadata.get("_cid") or calibre_id),
                    title=metadata.get("title") or "",
                    chapter=name,
                    section=story_section,
                    order=len(corpus.chunks),
                ))
        book_chunks = [c for c in corpus.chunks if c.book_id == int(calibre_id)]
        for index, chunk in enumerate(book_chunks):
            chunk.position = index / max(1, len(book_chunks) - 1)
    return corpus


# --------------------------------------------------------------------------- #
# Name statistics                                                             #
# --------------------------------------------------------------------------- #

# Capitalised words that are never a character's name on their own.
_NOT_NAMES = frozenset("""
i i'm i'd i'll i've a an the and but or so if then when while what why how who whom
whose where which that this these those there here he she it we they you his her its
our their your him them me my mine yes no not oh ah okay ok hey well now just
mr mrs ms miss mister sir madam madame dr
monday tuesday wednesday thursday friday saturday sunday
january february march april may june july august september october november december
god christ heaven hell chapter part book prologue epilogue
english french spanish german christmas easter
""".split())

# Words around a capitalised token that say what it is. Matched as whole tokens in
# one pass over the text, so every capitalised word gets them for free.
_HONORIFICS = frozenset("""
mr mrs ms miss mister sir lady lord dr doctor master mistress king queen prince
princess duke duchess captain commander general professor aunt uncle
""".split())
_SPEECH_VERBS = frozenset("""
said says asked asks replied answered whispered murmured muttered shouted snapped
called cried yelled added continued began told growled hissed laughed sighed
demanded insisted admitted agreed offered repeated breathed drawled grumbled
mumbled teased warned protested
""".split())
_PERSON_VERBS = frozenset("""
smiled grinned nodded frowned shrugged laughed sighed stared glanced looked turned
felt thought knew wanted wondered hesitated swallowed blinked winced flinched
scowled smirked kissed touched reached leaned stood sat walked watched realized
realised decided remembered was had could would didn't wasn't didn’t wasn’t
""".split())
_PLACE_PREPS = frozenset("in at from into toward towards across near outside inside throughout within beyond".split())
_BODY = frozenset("eyes hand hands face voice mouth lips hair gaze shoulder shoulders smile jaw chest arm arms fingers body".split())

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z’'\-]*")
_NAME_TOKEN_RE = re.compile(r"[A-Z][a-z]+(?:[’'\-][A-Z]?[a-z]+)*(?:[’']s)?")


def _possessive(word: str) -> str:
    return re.sub(r"[’']s$", "", word)


@dataclass
class NameStat:
    name: str
    mentions: int = 0          # capitalised occurrences anywhere
    mid: int = 0               # capitalised mid-sentence (the reliable count)
    sections: set = field(default_factory=set)
    books: set = field(default_factory=set)
    speech: int = 0            # next to a speech verb
    person: int = 0            # other signs of a person (body parts, verbs, honorifics)
    place: int = 0             # after "in", "at", "from"…
    full_name: str = ""        # "Thomas Mulvaney" when the pair is used often


def name_stats(corpus: Corpus) -> dict[str, NameStat]:
    """Capitalised words that behave like proper names, with evidence of what they are.

    A word counts as a name when it is capitalised in the middle of sentences and
    rarely appears in lower case. Everything else about it — how many chapters it
    spans, whether it speaks, whether it follows "in" or "at" — is recorded so the
    model can classify it and the code can rank it, instead of either guessing.
    """
    lower: Counter[str] = Counter()
    stats: dict[str, NameStat] = {}
    bigrams: dict[str, Counter[str]] = defaultdict(Counter)

    for chunk in corpus.chunks:
        text = chunk.text
        tokens = list(_TOKEN_RE.finditer(text))
        words = [m.group(0) for m in tokens]
        for i, match in enumerate(tokens):
            raw = words[i]
            if raw[0].islower():
                lower[_possessive(raw)] += 1
                continue
            if not _NAME_TOKEN_RE.fullmatch(raw):
                continue  # ALL CAPS, initials
            word = _possessive(raw)
            if len(word) < 2 or word.lower() in _NOT_NAMES:
                continue
            stat = stats.get(word)
            if stat is None:
                stat = stats[word] = NameStat(word)
            stat.mentions += 1
            stat.sections.add((chunk.book_id, chunk.section))
            stat.books.add(chunk.book_id)

            gap = text[tokens[i - 1].end() : match.start()] if i else "\n"
            if i and re.fullmatch(r"[\s,;:\-–—]*", gap) and "\n" not in gap:
                stat.mid += 1
            prev = words[i - 1].lower() if i else ""
            nxt = words[i + 1] if i + 1 < len(words) else ""
            nxt_low = nxt.lower()
            if prev in _SPEECH_VERBS or nxt_low in _SPEECH_VERBS:
                stat.speech += 1
            if (
                nxt_low in _PERSON_VERBS
                or prev.rstrip(".") in _HONORIFICS
                or (raw != word and nxt_low in _BODY)
            ):
                stat.person += 1
            if prev in _PLACE_PREPS and gap.strip() == "":
                stat.place += 1
            if raw == word and nxt and nxt[0].isupper() and _NAME_TOKEN_RE.fullmatch(nxt):
                second = _possessive(nxt)
                if second.lower() not in _NOT_NAMES and text[match.end() : tokens[i + 1].start()] == " ":
                    bigrams[word][second] += 1

    candidates: dict[str, NameStat] = {}
    for word, stat in stats.items():
        if stat.mid < 3:
            continue
        # A name that is also a common word (Will, Rose, Hunter) survives on
        # speech: "the Great Hall" never says anything.
        if lower.get(word.lower(), 0) < max(2, stat.mid * 0.2) or (stat.mid >= 8 and stat.speech >= 3):
            candidates[word] = stat
            if bigrams[word]:
                second, count = bigrams[word].most_common(1)[0]
                if count >= 3 and count >= stat.mentions * 0.1:
                    stat.full_name = f"{word} {second}"
    return candidates


def contexts(corpus: Corpus, name: str, count: int = 3, width: int = 110) -> list[str]:
    """Short windows around *name*, spread evenly through the story."""
    pattern = re.compile(rf"(?<![\w]){re.escape(name)}(?![\w])")
    hits: list[tuple[int, int]] = []
    for index, chunk in enumerate(corpus.chunks):
        for match in pattern.finditer(chunk.text):
            hits.append((index, match.start()))
    if not hits:
        return []
    if len(hits) > count:
        step = len(hits) / count
        hits = [hits[int(i * step + step / 2)] for i in range(count)]
    out = []
    for index, start in hits:
        text = corpus.chunks[index].text
        lo, hi = max(0, start - width), min(len(text), start + len(name) + width)
        snippet = re.sub(r"\s+", " ", text[lo:hi]).strip()
        out.append(("…" if lo else "") + snippet + ("…" if hi < len(text) else ""))
    return out
