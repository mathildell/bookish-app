"""Creative writing: cast saved character profiles into a scene.

Profiles are personality-first, so only portable fields go into the prompt —
`situational_anchors` (canon tied to the original world) is always left out.
"""

from __future__ import annotations

import json
import logging
from typing import Callable, Iterator, Optional

from ollama import Client

from .llm import chat_without_thinking
from .models import AppSettings

logger = logging.getLogger(__name__)

_SUGGEST_OPEN = "<<<SUGGEST>>>"
_SUGGEST_CLOSE = "<<<END>>>"

# Beyond this many characters the cast is condensed, so the prompt stays a prompt.
_FULL_PROFILE_LIMIT = 5

# A scene can outrun `num_predict`; each continuation buys another budget-sized run.
_MAX_CONTINUATIONS = 2

_SYSTEM = (
    "You are a fiction writer. Write in third person, past tense. At most 500 words. "
    "Prose only — no preamble, no scene headings, no commentary.\n\n"
    "Cast these characters into the setting the user describes. Keep their psychology, "
    "voice and relational patterns. Do not import their original world unless asked.\n\n"
    "Continuity rules:\n"
    "- Follow the user's premise literally. If they say the characters meet for the "
    "first time, they are strangers: no shared past, no knowing each other's names or "
    "histories until it is said aloud in the scene.\n"
    "- Characters know only what they have witnessed or been told in this scene. The "
    "profiles are private background for you; relationships listed there are not "
    "established in this story unless the user says so.\n"
    "- Stay in one moment and move forward in time. No flashbacks, no jumping ahead, "
    "and never contradict something already written, including earlier turns.\n"
    "- Keep each character's voice and behaviour consistent with their profile.\n"
    "- When sources conflict, the user's message wins, then the story notes, then the "
    "world sheet, then a character's backstory. Obey the world's rules without "
    "explaining them: show them through behaviour and detail.\n\n"
    "{cast}\n\n"
    "End every reply with exactly three suggestions for what could happen next, in this "
    "shape and nothing else:\n"
    f"{_SUGGEST_OPEN}\n"
    '["...", "...", "..."]\n'
    f"{_SUGGEST_CLOSE}\n"
    "Each suggestion is a nudge of at most eight words — a vague direction for the "
    "scene, never a sentence of prose: no trailing full stop, no emotion words, no "
    "summary of what just happened. Make the three differ in register: one raises the "
    "stakes, one softens and turns romantic, one is unexpected and wry."
)


def _bullets(label: str, items) -> str:
    values = [str(i).strip() for i in (items or []) if str(i).strip()]
    return f"{label}: " + "; ".join(values) if values else ""


def _format_full(profile: dict) -> str:
    """Every portable field, in the order a writer needs them."""
    voice = profile.get("voice") or {}
    appearance = profile.get("appearance") or {}
    motivations = profile.get("motivations") or {}

    lines = [f"### {profile.get('name', 'Unnamed')}"]
    if profile.get("role"):
        lines.append(f"role: {profile['role']}")
    if profile.get("archetype"):
        lines.append(f"archetype: {profile['archetype']}")
    if profile.get("summary"):
        lines.append(f"summary: {profile['summary']}")

    for label, key in (
        ("core traits", "core_traits"),
        ("fears", "fears"),
        ("flaws", "flaws"),
        ("values", "values"),
    ):
        line = _bullets(label, profile.get(key))
        if line:
            lines.append(line)

    if motivations.get("wants"):
        lines.append(f"wants: {motivations['wants']}")
    if motivations.get("needs"):
        lines.append(f"needs: {motivations['needs']}")

    for label, value in (
        ("voice", voice.get("tone")),
        ("rhythm", voice.get("rhythm")),
    ):
        if value:
            lines.append(f"{label}: {value}")
    for label, value in (
        ("speech tells", _bullets("", voice.get("tells"))[2:]),
        ("mannerisms", _bullets("", profile.get("mannerisms"))[2:]),
    ):
        if value:
            lines.append(f"{label}: {value}")
    if voice.get("humour"):
        lines.append(f"humour: {voice['humour']}")
    if appearance.get("signature"):
        lines.append(f"appearance: {appearance['signature']}")

    for rel in profile.get("relationships") or []:
        dynamic = (rel.get("dynamic") or "").strip()
        behaviour = (rel.get("behaviour") or "").strip()
        if dynamic or behaviour:
            lines.append(f"relationship — {dynamic}: {behaviour}".rstrip(": "))

    if profile.get("formative_experience"):
        lines.append(f"formative experience: {profile['formative_experience']}")
    if profile.get("arc_pattern"):
        lines.append(f"arc: {profile['arc_pattern']}")
    return "\n".join(lines)


def _format_condensed(profile: dict) -> str:
    """Summary + traits + voice, for casts too large to read in full."""
    traits = ", ".join((profile.get("core_traits") or [])[:4])
    tone = (profile.get("voice") or {}).get("tone") or ""
    head = f"### {profile.get('name', 'Unnamed')}"
    if profile.get("summary"):
        head += f" — {profile['summary']}"
    detail = traits + (f"; voice: {tone}" if tone else "")
    return f"{head}\n{detail}" if detail else head


def format_cast(profiles: list[dict]) -> str:
    """The cast block for the system prompt."""
    if not profiles:
        return "No characters were selected — invent a small cast that fits the request."
    formatter = _format_full if len(profiles) <= _FULL_PROFILE_LIMIT else _format_condensed
    return "\n\n".join(formatter(p) for p in profiles)


def format_world(world: dict) -> str:
    """One worldbuilding sheet as a compact prompt block."""
    lines = [f"### World: {world.get('name', 'Unnamed')}"]
    if world.get("premise"):
        lines.append(world["premise"])
    for label, key in (
        ("rules", "rules"),
        ("social structure", "social_structure"),
        ("conventions", "tropes"),
        ("typical settings", "settings"),
        ("tensions", "tensions"),
    ):
        items = [str(i).strip() for i in (world.get(key) or []) if str(i).strip()]
        if items:
            lines.append(f"{label}:")
            lines.extend(f"- {item}" for item in items)
    terms = [
        f"{t.get('term', '').strip()} — {t.get('meaning', '').strip()}"
        for t in (world.get("terminology") or [])
        if str(t.get("term", "")).strip()
    ]
    if terms:
        lines.append("terminology:")
        lines.extend(f"- {t}" for t in terms)
    return "\n".join(lines)


def format_notes(notes: list[str]) -> str:
    items = [" ".join(str(n).split()) for n in (notes or []) if str(n).strip()]
    if not items:
        return ""
    return "### Story notes (established in this story — treat as fact)\n" + "\n".join(
        f"- {n}" for n in items
    )


def format_context(profiles: list[dict], worlds: list[dict], notes: list[str]) -> str:
    """World sheets, then the cast, then pinned notes: everything the model is given."""
    blocks = [format_world(w) for w in (worlds or [])]
    if profiles or not worlds:
        blocks.append(format_cast(profiles))
    note_block = format_notes(notes)
    if note_block:
        blocks.append(note_block)
    return "\n\n".join(blocks)


# The scene stream asks for a sentinel block, but small models routinely ignore it.
# The dedicated call below uses JSON mode and a schema-shaped instruction instead.
_SUGGEST_SYSTEM = (
    "You are a story editor. Given a scene, propose exactly three routes it could take "
    "next. Each is a short nudge of at most eight words — a direction, not prose: who "
    "acts, what shifts, what is revealed. Vague and tantalising is good. Do not "
    "summarise the scene, do not write the next paragraph, do not name emotions, no "
    "trailing full stop. Vary the register: one raises the stakes, one softens toward "
    "romance, one is unexpected and wry.\n\n"
    'Example for a scene about a locked study: {"suggestions": ["The key is already '
    'in the door", "She admits why she lied", "A cat knocks something over"]}\n\n'
    'Reply as JSON only: {"suggestions": ["beat one", "beat two", "beat three"]}'
)

_FOLLOWUP_SYSTEM = (
    "You help a fiction writer explore their characters and world. Given the discussion "
    "so far, propose exactly three follow-up questions the writer could ask next. Each "
    "is a short question of at most twelve words, specific to these characters or this "
    "world, never generic. Vary them: one digs into a relationship, one tests a "
    "character against a setting or situation, one looks at plot or structure.\n\n"
    'Reply as JSON only: {"suggestions": ["question one", "question two", "question three"]}'
)

_DISCUSS_SYSTEM = (
    "You are a sharp story editor and character analyst, talking with a fiction writer "
    "about their cast, their world and their plot. You answer as analysis, never as a "
    "scene: no prose narration, though you may quote a line of dialogue to make a point.\n\n"
    "How to answer:\n"
    "- Ground every claim in the profiles and world sheet below: name the trait, fear, "
    "want, rule or tension that makes you say it. If you are speculating beyond them, "
    "say so.\n"
    "- Take a position. Writers want a recommendation, not a survey: say what you would "
    "do and why, then mention the strongest alternative briefly.\n"
    "- Look for friction and chemistry between specific characters: where their wants "
    "collide, which of their flaws the other triggers, what each one can give the other.\n"
    "- When asked about a setting, test it against each character's fears and values: "
    "where would they thrive, and where would they crack.\n"
    "- When asked about plot or scenes, suggest concrete beats that follow from the "
    "characters' own psychology, in an order that escalates.\n"
    "- Respect the story notes: they are already decided. Do not contradict them; build "
    "on them.\n"
    "- Be concise. Short paragraphs or a tight bullet list; use markdown sparingly.\n\n"
    "{cast}"
)

_PLAN_SYSTEM = (
    "You are a story editor turning a discussion into a short list of scenes a writer "
    "can draft next. Use the cast, world and story notes below, and the discussion so "
    "far. Each scene has:\n"
    '- "title": two to five words.\n'
    '- "setting": where and when, one short phrase.\n'
    '- "conflict": what pulls the characters against each other, one sentence.\n'
    '- "brief": a two-to-three sentence instruction to a prose writer: who is present, '
    "what each already knows about the others (say plainly if they are strangers), "
    "where it happens, what the scene must accomplish. No prose, no dialogue.\n"
    "Order the scenes so each follows from the last and tension rises.\n\n"
    "{cast}\n\n"
    'Reply as JSON only: {{"scenes": [{{"title": "", "setting": "", "conflict": "", "brief": ""}}]}}'
)

_DISTILL_BRIEF = (
    "Rewrite the text below as a scene brief for a prose writer: two to four sentences "
    "in the imperative, saying who is present, where, what each already knows of the "
    "others (state plainly if they are strangers), and what the scene must accomplish. "
    "Keep only what the text supports. No prose, no preamble."
)
_DISTILL_NOTE = (
    "Reduce the text below to ONE short factual sentence a writer can pin as established "
    "story canon (e.g. who knows what, a decision made, a rule of the setting). "
    "No preamble, no quotation marks."
)

# A pill, not a paragraph: models still overshoot, so a beat is cut at its first
# sentence end or the last word before the cap.
_MAX_BEAT_CHARS = 80


def _tidy_beat(beat: str) -> str:
    """One short nudge, no trailing stop, bounded for the pill."""
    text = " ".join(str(beat).split())
    if not text:
        return ""
    for stop in (". ", "! ", "? ", " — "):
        index = text.find(stop)
        if 0 <= index <= _MAX_BEAT_CHARS:
            text = text[:index]
            break
    text = text.rstrip(" .,;:!?…—-")
    if len(text) > _MAX_BEAT_CHARS:
        text = text[:_MAX_BEAT_CHARS].rsplit(" ", 1)[0].rstrip(" .,;:—-") + "…"
    return text


def _tidy_beats(items) -> list[str]:
    """At most three non-empty, pill-sized beats."""
    if not isinstance(items, list):
        return []
    return [beat for beat in (_tidy_beat(item) for item in items) if beat][:3]


def parse_json_suggestions(text: str) -> list[str]:
    """Read beats from a JSON reply, tolerating fences and stray prose around it."""
    text = (text or "").strip()
    if not text:
        return []
    data = None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if 0 <= start < end:
            try:
                data = json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                data = None
    if isinstance(data, dict):
        data = data.get("suggestions") or data.get("beats") or []
    return _tidy_beats(data)


def parse_suggestions(text: str) -> list[str]:
    """Pull the three beats out of the sentinel block; [] if it never arrived."""
    start = text.find(_SUGGEST_OPEN)
    if start < 0:
        return []
    end = text.find(_SUGGEST_CLOSE, start)
    if end < 0:
        return []
    try:
        return _tidy_beats(json.loads(text[start + len(_SUGGEST_OPEN) : end].strip()))
    except json.JSONDecodeError:
        return []


class WritingEngine:
    """Scene generation on top of the configured writing model."""

    def __init__(self, settings: AppSettings):
        self.s = settings
        self._client = Client(host=settings.ollama_base_url)

    def _options(self) -> dict:
        return {
            "temperature": self.s.writing_temperature,
            "top_p": self.s.writing_top_p,
            "min_p": self.s.writing_min_p,
            "repeat_penalty": self.s.writing_repeat_penalty,
            "num_ctx": self.s.writing_num_ctx,
            "num_predict": self.s.writing_num_predict,
        }

    def _system(
        self,
        profiles: list[dict],
        worlds: Optional[list[dict]] = None,
        notes: Optional[list[str]] = None,
    ) -> str:
        system = _SYSTEM.format(cast=format_context(profiles, worlds or [], notes or []))
        return system

    def _chat(self, messages: list[dict], **kwargs):
        """One call to the writing model (the chat model if none is set), reasoning off.

        Reasoning tokens share `num_predict` with the prose, which is how a 500-word
        scene ends up cut in half on a thinking model.
        """
        return chat_without_thinking(
            self._client,
            model=self.s.writing_model_effective,
            messages=messages,
            options=self._options(),
            **kwargs,
        )

    def stream_scene(
        self,
        *,
        message: str,
        history: list[dict],
        profiles: list[dict],
        worlds: Optional[list[dict]] = None,
        notes: Optional[list[str]] = None,
        on_token: Optional[Callable[[str], None]] = None,
    ) -> Iterator[tuple[str, object]]:
        """Yield ("thinking"|"token"|"error"|"result", payload).

        The suggestion block is never streamed as prose: the tail is held back until
        it is either ruled out or recognised, so the reader never sees the sentinel.
        A reply that hits the token limit is continued rather than silently cut off.
        """
        messages = [{"role": "system", "content": self._system(profiles, worlds, notes)}]
        for turn in history:
            messages.append({"role": turn["role"], "content": turn["content"]})
        messages.append({"role": "user", "content": message or "Continue the scene."})

        written: list[str] = []
        held = ""           # text we have received but not yet released
        in_suggest = False  # sentinel seen — swallow everything after it

        def release(text: str):
            if text:
                if on_token:
                    on_token(text)
                return ("token", text)
            return None

        for round_index in range(_MAX_CONTINUATIONS + 1):
            truncated = False
            try:
                for frame in self._chat(messages, stream=True):
                    msg = frame.get("message", {}) or {}
                    if frame.get("done"):
                        truncated = (frame.get("done_reason") or "") == "length"

                    thought = msg.get("thinking") or ""
                    if thought:
                        yield ("thinking", thought)

                    delta = msg.get("content") or ""
                    if not delta:
                        continue
                    written.append(delta)
                    if in_suggest:
                        continue

                    held += delta
                    index = held.find(_SUGGEST_OPEN)
                    if index >= 0:
                        if index:
                            event = release(held[:index])
                            if event:
                                yield event
                        in_suggest = True
                        held = ""
                        continue

                    # Keep enough of the tail to notice a sentinel split across frames.
                    keep = min(len(held), len(_SUGGEST_OPEN) - 1)
                    safe = held[:-keep] if keep else held
                    if safe:
                        event = release(safe)
                        if event:
                            yield event
                    held = held[-keep:] if keep else ""
            except Exception as exc:  # surfaced to the client as an SSE error event
                logger.error("Scene generation failed", exc_info=exc)
                yield ("error", str(exc))
                return

            if in_suggest or not truncated:
                break
            if round_index == _MAX_CONTINUATIONS:
                logger.warning("Scene still truncated after %s continuations", round_index)
                break

            # The budget ran out mid-scene: continue the same assistant turn.
            logger.info("Scene hit the token limit; continuing (round %s)", round_index + 2)
            messages = messages + [
                {"role": "assistant", "content": "".join(written)},
                {
                    "role": "user",
                    "content": "Continue the scene from exactly where you stopped. Do not repeat anything already written.",
                },
            ]

        if held and not in_suggest:
            event = release(held)
            if event:
                yield event

        full = "".join(written)
        cut = full.find(_SUGGEST_OPEN)
        answer = (full[:cut] if cut >= 0 else full).strip()

        suggestions = parse_suggestions(full)
        if not suggestions and answer:
            # The sentinel never arrived (usually a truncated reply). Ask for the
            # beats separately rather than shipping a scene with no way forward.
            logger.info("No suggestion block in the reply; generating beats separately")
            suggestions = self.suggest(
                profiles,
                history
                + [
                    {"role": "user", "content": message or "Continue the scene."},
                    {"role": "assistant", "content": answer},
                ],
                worlds=worlds,
                notes=notes,
            )

        yield ("result", {"answer": answer, "suggestions": suggestions})

    def suggest(
        self,
        profiles: list[dict],
        history: list[dict],
        worlds: Optional[list[dict]] = None,
        notes: Optional[list[str]] = None,
        mode: str = "write",
    ) -> list[str]:
        """The three next beats, from a JSON-mode call.

        Kept separate from the prose call on purpose: asking a scene model to append
        a machine-readable block to its prose is unreliable, and a missing block used
        to leave the reader with no way forward.
        """
        cast = format_context(profiles, worlds or [], notes or [])
        discuss = mode == "discuss"
        # Only the tail of the last scene is needed to pick three beats; sending a
        # whole 1200-word reply makes the call slow and eats the token budget.
        trimmed: list[dict] = []
        for turn in history[-4:]:
            content = turn["content"]
            if turn["role"] == "assistant" and len(content) > 1600:
                content = "…" + content[-1600:]
            trimmed.append({"role": turn["role"], "content": content})
        messages = [
            {
                "role": "system",
                "content": f"{_FOLLOWUP_SYSTEM if discuss else _SUGGEST_SYSTEM}\n\nThe cast:\n{cast}",
            },
            *trimmed,
            {
                "role": "user",
                "content": (
                    "Propose three follow-up questions the writer could ask next."
                    if discuss
                    else "Propose the three next beats for this scene."
                ),
            },
        ]
        try:
            response = (
                self._analysis_chat(messages, stream=False, format="json")
                if discuss
                else self._chat(messages, stream=False, format="json")
            )
            content = (response.get("message", {}) or {}).get("content") or ""
        except Exception as exc:
            logger.error("Suggestion generation failed", exc_info=exc)
            return []
        beats = parse_json_suggestions(content)
        if not beats:
            beats = parse_suggestions(content)
        if not beats:
            logger.warning("Suggestion call returned nothing usable: %r", content[:200])
        return beats

    # ------------------------------------------------------------------ #
    # Discuss mode: analysis instead of prose                            #
    # ------------------------------------------------------------------ #

    def _analysis_chat(self, messages: list[dict], **kwargs):
        """One call to the chat model (a better analyst than a prose fine-tune)."""
        options = {
            "temperature": 0.6,
            "top_p": 0.9,
            "num_ctx": self.s.writing_num_ctx,
            "num_predict": 3000,
        }
        return chat_without_thinking(
            self._client, model=self.s.chat_model, messages=messages, options=options, **kwargs
        )

    def stream_discussion(
        self,
        *,
        message: str,
        history: list[dict],
        profiles: list[dict],
        worlds: Optional[list[dict]] = None,
        notes: Optional[list[str]] = None,
    ) -> Iterator[tuple[str, object]]:
        """Yield ("thinking"|"token"|"error"|"result", payload) for an analysis reply."""
        system = _DISCUSS_SYSTEM.format(cast=format_context(profiles, worlds or [], notes or []))
        messages = [{"role": "system", "content": system}]
        for turn in history:
            messages.append({"role": turn["role"], "content": turn["content"]})
        messages.append({"role": "user", "content": message})

        parts: list[str] = []
        try:
            for frame in self._analysis_chat(messages, stream=True):
                msg = frame.get("message", {}) or {}
                if msg.get("thinking"):
                    yield ("thinking", msg["thinking"])
                delta = msg.get("content") or ""
                if delta:
                    parts.append(delta)
                    yield ("token", delta)
        except Exception as exc:  # surfaced to the client as an SSE error event
            logger.error("Discussion failed", exc_info=exc)
            yield ("error", str(exc))
            return
        yield ("result", {"answer": "".join(parts).strip()})

    def plan_scenes(
        self,
        *,
        message: str,
        history: list[dict],
        profiles: list[dict],
        worlds: Optional[list[dict]] = None,
        notes: Optional[list[str]] = None,
        count: int = 3,
    ) -> list[dict]:
        """Scene cards (title, setting, conflict, brief) from the discussion so far."""
        count = max(1, min(int(count or 3), 6))
        system = _PLAN_SYSTEM.format(cast=format_context(profiles, worlds or [], notes or []))
        ask = (message or "").strip() or "Plan the next scenes."
        messages = [
            {"role": "system", "content": system},
            *[{"role": t["role"], "content": t["content"]} for t in history[-8:]],
            {"role": "user", "content": f"{ask}\n\nPlan exactly {count} scenes."},
        ]
        response = self._analysis_chat(messages, stream=False, format="json")
        content = (response.get("message", {}) or {}).get("content") or ""
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            start, end = content.find("{"), content.rfind("}")
            data = json.loads(content[start : end + 1]) if 0 <= start < end else {}
        cards = []
        for item in (data.get("scenes") if isinstance(data, dict) else None) or []:
            if not isinstance(item, dict):
                continue
            card = {k: " ".join(str(item.get(k) or "").split()) for k in ("title", "setting", "conflict", "brief")}
            if card["brief"] or card["title"]:
                cards.append(card)
        return cards[:count]

    def distill(self, content: str, kind: str, profiles: list[dict]) -> str:
        """A scene brief or a one-line note from a discussion reply."""
        instruction = _DISTILL_NOTE if kind == "note" else _DISTILL_BRIEF
        cast = format_cast(profiles) if profiles else ""
        system = instruction + (f"\n\nThe cast, for reference:\n{cast}" if cast else "")
        response = self._analysis_chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": content[-6000:]},
            ],
            stream=False,
        )
        return ((response.get("message", {}) or {}).get("content") or "").strip().strip('"')
