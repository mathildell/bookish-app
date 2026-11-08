"""Creative writing: cast saved character profiles into a scene.

Profiles are personality-first, so only portable fields go into the prompt —
`situational_anchors` (canon tied to the original world) is always left out.
"""

from __future__ import annotations

import inspect
import json
import logging
from typing import Callable, Iterator, Optional

from ollama import Client

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
        items = data.get("suggestions") or data.get("beats") or []
    elif isinstance(data, list):
        items = data
    else:
        return []
    if not isinstance(items, list):
        return []
    return [beat for beat in (_tidy_beat(item) for item in items) if beat][:3]


def parse_suggestions(text: str) -> list[str]:
    """Pull the three beats out of the sentinel block; [] if it never arrived."""
    start = text.find(_SUGGEST_OPEN)
    if start < 0:
        return []
    end = text.find(_SUGGEST_CLOSE, start)
    if end < 0:
        return []
    raw = text[start + len(_SUGGEST_OPEN) : end].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    beats = [beat for beat in (_tidy_beat(item) for item in data) if beat]
    return beats[:3]


class WritingEngine:
    """Scene generation on top of the configured writing model."""

    def __init__(self, settings: AppSettings):
        self.s = settings
        self._client = Client(host=settings.ollama_base_url)
        self._think_supported = self._supports_think()

    @property
    def model(self) -> str:
        """Fall back to the chat model when no writing model is configured."""
        return self.s.writing_model or self.s.chat_model

    def _supports_think(self) -> bool:
        """Newer clients can switch reasoning models out of their think phase."""
        try:
            return "think" in inspect.signature(self._client.chat).parameters
        except (TypeError, ValueError):
            return False

    def _options(self) -> dict:
        return {
            "temperature": self.s.writing_temperature,
            "top_p": self.s.writing_top_p,
            "num_predict": self.s.writing_num_predict,
        }

    def _system(self, profiles: list[dict], genre: str) -> str:
        system = _SYSTEM.format(cast=format_cast(profiles))
        genre = (genre or "").strip()
        if genre:
            system += f"\n\nGenre: {genre}. Let it colour the setting and diction."
        return system

    def _open_stream(self, messages: list[dict]):
        """Start a streaming turn.

        Reasoning tokens share `num_predict` with the prose, which is how a 500-word
        scene ends up cut in half on a thinking model. Where the client supports it,
        reasoning is switched off for writing.
        """
        kwargs = {
            "model": self.model,
            "messages": messages,
            "options": self._options(),
            "stream": True,
        }
        if self._think_supported:
            try:
                return self._client.chat(think=False, **kwargs)
            except TypeError:
                # Older client that forwards kwargs but does not accept the flag.
                self._think_supported = False
        return self._client.chat(**kwargs)

    def stream_scene(
        self,
        *,
        message: str,
        history: list[dict],
        profiles: list[dict],
        genre: str = "",
        on_token: Optional[Callable[[str], None]] = None,
    ) -> Iterator[tuple[str, object]]:
        """Yield ("thinking"|"token"|"error"|"result", payload).

        The suggestion block is never streamed as prose: the tail is held back until
        it is either ruled out or recognised, so the reader never sees the sentinel.
        A reply that hits the token limit is continued rather than silently cut off.
        """
        messages = [{"role": "system", "content": self._system(profiles, genre)}]
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
                for frame in self._open_stream(messages):
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
            )

        yield ("result", {"answer": answer, "suggestions": suggestions})

    def suggest(self, profiles: list[dict], history: list[dict]) -> list[str]:
        """The three next beats, from a JSON-mode call.

        Kept separate from the prose call on purpose: asking a scene model to append
        a machine-readable block to its prose is unreliable, and a missing block used
        to leave the reader with no way forward.
        """
        cast = format_cast(profiles)
        # Only the tail of the last scene is needed to pick three beats; sending a
        # whole 1200-word reply makes the call slow and eats the token budget.
        trimmed: list[dict] = []
        for turn in history[-4:]:
            content = turn["content"]
            if turn["role"] == "assistant" and len(content) > 1600:
                content = "…" + content[-1600:]
            trimmed.append({"role": turn["role"], "content": content})
        messages = [
            {"role": "system", "content": f"{_SUGGEST_SYSTEM}\n\nThe cast:\n{cast}"},
            *trimmed,
            {"role": "user", "content": "Propose the three next beats for this scene."},
        ]
        kwargs = {
            "model": self.model,
            "messages": messages,
            "options": self._options(),
            "stream": False,
            "format": "json",
        }
        try:
            if self._think_supported:
                try:
                    response = self._client.chat(think=False, **kwargs)
                except TypeError:
                    self._think_supported = False
                    response = self._client.chat(**kwargs)
            else:
                response = self._client.chat(**kwargs)
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
