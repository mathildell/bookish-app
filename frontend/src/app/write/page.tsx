"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import ThreadEmpty from "@/components/ThreadEmpty";
import Tooltip from "@/components/Tooltip";
import {
  createBookmark,
  deleteBookmark,
  fetchSettingsSummary,
  regenerateSceneSuggestions,
  streamScene,
  useCharacters,
  type SceneTurn,
} from "@/lib/api";

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return Array.from(new Set(ids));
}

function applyCastParam(ids: number[]) {
  const query = ids.length ? `?chars=${ids.join(",")}` : "";
  window.history.replaceState(null, "", `/write${query}`);
}

/** Two initials, used when a character has no thumbnail yet. */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function WritePage() {
  return (
    <Suspense fallback={<div className="py-8 text-zinc-500">Loading…</div>}>
      <WritePageContent />
    </Suspense>
  );
}

function WritePageContent() {
  const searchParams = useSearchParams();
  const [castIds, setCastIds] = useState<number[]>([]);
  useEffect(() => {
    setCastIds(parseIds(searchParams.get("chars")));
  }, [searchParams]);

  const { data: characters } = useCharacters();
  const { data: settings } = useQuery({
    queryKey: ["settingsSummary"],
    queryFn: fetchSettingsSummary,
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<SceneTurn[]>([]);
  const [scene, setScene] = useState("");
  const [thinking, setThinking] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Turn index -> saved bookmark id, mirroring the chat page's 🔖 affordance.
  const [savedBookmarks, setSavedBookmarks] = useState<Record<number, number>>({});
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const cast = useMemo(
    () => (characters ?? []).filter((c) => castIds.includes(c.id)),
    [characters, castIds]
  );

  const pickable = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return (characters ?? []).filter(
      (c) => !q || c.name.toLowerCase().includes(q) || (c.archetype ?? "").toLowerCase().includes(q)
    );
  }, [characters, pickerQuery]);

  const genres = useMemo(() => Object.keys(settings?.genre_colors ?? {}), [settings]);
  // A library with no configured genres has no chip to pick, so don't lock the
  // whole page behind a selection that is impossible to make.
  const needsGenre = genres.length > 0;

  // The URL write must stay out of the state updater: React may run an updater during
  // render, and rewriting history there fires a Router update mid-render.
  const toggleCast = useCallback(
    (id: number) => {
      const next = castIds.includes(id)
        ? castIds.filter((x) => x !== id)
        : [...castIds, id];
      setCastIds(next);
      applyCastParam(next);
    },
    [castIds]
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || pending || castIds.length === 0 || (needsGenre && !genre)) return;

      const history = turns;
      setPending(true);
      setError(null);
      setScene("");
      setSuggestions([]);
      setThinking(false);
      setTurns([...history, { role: "user", content: message }]);

      let streamed = "";
      try {
        for await (const event of streamScene({
          message,
          history,
          character_ids: castIds,
          genre,
        })) {
          if (event.kind === "token") {
            streamed += event.text;
            setThinking(false);
            setScene(streamed);
          } else if (event.kind === "thinking") {
            setThinking(true);
          } else if (event.kind === "done") {
            const answer = event.answer || streamed;
            setScene(answer);
            setSuggestions(event.suggestions);
            setTurns((prev) => [...prev, { role: "assistant", content: answer }]);
          } else if (event.kind === "error") {
            setError(event.error);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Writing failed");
      } finally {
        setPending(false);
        setThinking(false);
      }
    },
    [castIds, genre, needsGenre, pending, turns]
  );

  const toggleBookmark = useCallback(
    async (index: number) => {
      const existingId = savedBookmarks[index];
      setSavingIndex(index);
      try {
        if (existingId) {
          await deleteBookmark(existingId);
          setSavedBookmarks((prev) => {
            const next = { ...prev };
            delete next[index];
            return next;
          });
        } else {
          const turn = turns[index];
          if (turn?.role !== "assistant" || !turn.content) return;
          const question =
            index > 0 && turns[index - 1].role === "user" ? turns[index - 1].content : "";
          const saved = await createBookmark({
            question,
            answer: turn.content,
            citations: [],
            scope: "write",
            calibre_ids: [],
            note: "",
            color: "yellow",
          });
          setSavedBookmarks((prev) => ({ ...prev, [index]: saved.id }));
        }
      } catch {
        // Leave the button usable; the bookmark wall is the source of truth if this fails.
      } finally {
        setSavingIndex(null);
      }
    },
    [savedBookmarks, turns]
  );

  const renderSaveButton = (index: number) => {
    const saved = savedBookmarks[index];
    return (
      <Tooltip label={saved ? "Saved — click to remove" : "Save this scene"} align="left">
        <button
          type="button"
          onClick={() => toggleBookmark(index)}
          disabled={savingIndex === index}
          aria-label={saved ? "Remove bookmark" : "Bookmark this scene"}
          className={`flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors disabled:opacity-50 ${
            saved
              ? "border-yellow-600/60 bg-yellow-500/10 text-yellow-300"
              : "border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          🔖
          {saved ? "Saved" : "Save"}
        </button>
      </Tooltip>
    );
  };

  const refreshSuggestions = useCallback(async () => {
    if (castIds.length === 0 || turns.length === 0 || regenerating) return;
    setRegenerating(true);
    try {
      setSuggestions(await regenerateSceneSuggestions({ character_ids: castIds, history: turns }));
    } catch {
      setError("Couldn't regenerate suggestions");
    } finally {
      setRegenerating(false);
    }
  }, [castIds, turns, regenerating]);

  // Only the last exchange is prose; earlier briefs stay as a quiet transcript.
  const earlierTurns = turns.slice(0, -1);

  return (
    <div className="flex h-[calc(100vh-5.5625rem)] flex-col overflow-hidden pt-4">
      <h1 className="text-2xl font-bold tracking-tight">Write</h1>
      <p className="mb-4 mt-1 text-sm text-zinc-500">
        {cast.length === 0
          ? "Pick a cast on the left to start a scene."
          : `Casting ${cast.map((c) => c.name).join(", ")}.`}
      </p>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Same shape as the chat page's context column: the selection, then a picker. */}
        <aside className="flex w-[200px] flex-shrink-0 flex-col gap-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="flex flex-shrink-0 items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Cast</p>
            {castIds.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setCastIds([]);
                  applyCastParam([]);
                }}
                className="text-[11px] text-zinc-500 transition-colors hover:text-yellow-400"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex-shrink-0 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[11px] leading-snug text-zinc-400">
            {castIds.length === 0
              ? "🎭 No cast selected"
              : `🎭 ${castIds.length} character${castIds.length === 1 ? "" : "s"} selected`}
          </div>

          {castIds.length > 0 ? (
            <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 content-start gap-2 overflow-y-auto">
              {castIds.map((id) => {
                const character = (characters ?? []).find((c) => c.id === id);
                return (
                  <div key={id} className="group/cast relative aspect-[2/3] rounded-lg bg-zinc-800">
                    {/* Clipping lives on the link, not the grid item — same reason as chat. */}
                    <Link
                      href={`/characters/${id}`}
                      className="block h-full w-full overflow-hidden rounded-lg"
                    >
                      {character?.thumbnail ? (
                        <img
                          src={character.thumbnail}
                          alt={character.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 px-1 text-center text-base font-black text-zinc-600">
                          {character ? initials(character.name) : `#${id}`}
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-zinc-950/80 p-1 opacity-0 transition-opacity group-hover/cast:opacity-100">
                        <p className="line-clamp-2 text-[10px] font-medium leading-tight text-zinc-200">
                          {character?.name ?? `#${id}`}
                        </p>
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={() => toggleCast(id)}
                      aria-label={`Remove ${character?.name ?? `character ${id}`} from the cast`}
                      className="absolute right-1 top-1 h-5 w-5 rounded-full bg-zinc-950/80 text-[11px] leading-5 text-zinc-300 opacity-0 transition-colors group-hover/cast:opacity-100 hover:bg-red-600 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="min-h-0 flex-1 rounded-lg border border-dashed border-zinc-800 px-2 py-4 text-center">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                No characters selected.
                <br />
                Add one below to start writing.
              </p>
            </div>
          )}

          {/* Add characters — the collapsible equivalent of chat's "+ Add books" */}
          <div className="flex min-h-0 flex-shrink-0 flex-col gap-2 border-t border-zinc-800 pt-2">
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              className="w-full rounded-lg bg-zinc-800 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              {pickerOpen ? "− Close picker" : "+ Add characters"}
            </button>

            {pickerOpen && (
              <div className="flex min-h-0 flex-col gap-2">
                <input
                  type="text"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="Search characters…"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
                />
                <div className="max-h-[180px] space-y-0.5 overflow-y-auto">
                  {pickable.map((character) => {
                    const checked = castIds.includes(character.id);
                    return (
                      <label
                        key={character.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-zinc-800/60"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCast(character.id)}
                          className="flex-shrink-0 accent-yellow-500"
                        />
                        <span className="h-7 w-5 flex-shrink-0 overflow-hidden rounded bg-zinc-800">
                          {character.thumbnail ? (
                            <img src={character.thumbnail} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-[7px] font-bold text-zinc-600">
                              {initials(character.name)}
                            </span>
                          )}
                        </span>
                        <span className="line-clamp-2 text-[11px] leading-tight text-zinc-300">
                          {character.name}
                        </span>
                      </label>
                    );
                  })}
                  {pickable.length === 0 && (
                    <p className="px-1 py-2 text-[11px] text-zinc-600">
                      {characters ? "No characters match." : "Loading…"}
                    </p>
                  )}
                </div>
                <p className="text-[10px] leading-snug text-zinc-600">
                  Up to 5 characters get their full profile; beyond that the cast is condensed.
                </p>
              </div>
            )}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {genres.map((name) => {
                const color = settings?.genre_colors?.[name] ?? "#eab308";
                const active = genre === name;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setGenre(active ? "" : name)}
                    style={
                      active
                        ? { backgroundColor: color, borderColor: color, color: "#18181b" }
                        : { borderColor: `${color}66`, color }
                    }
                    className="rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors"
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
            {/* Same message layout as the chat page: a right-aligned brief, then
                the reply in a thin-bordered container. */}
            {earlierTurns.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="flex flex-col">
                  <div className="self-end rounded-lg border border-yellow-600/40 bg-yellow-600/30 px-4 py-2 text-sm text-zinc-100">
                    {turn.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col">
                  <div className="w-3/4 space-y-2 self-start">
                    <div className="whitespace-pre-wrap rounded-lg border border-zinc-700/70 bg-zinc-800/60 p-4 text-sm leading-relaxed text-zinc-300">
                      {turn.content}
                    </div>
                    {renderSaveButton(i)}
                  </div>
                </div>
              )
            )}

            {scene && (
              <div className="flex flex-col">
                <div className="w-3/4 space-y-2 self-start">
                  <div className="whitespace-pre-wrap rounded-lg border border-zinc-700/70 bg-zinc-800/60 p-4 text-sm leading-relaxed text-zinc-100">
                    {scene}
                  </div>
                  {/* Only a finished scene is saveable — the last turn is still
                      the user's brief while it streams. */}
                  {/* Save and the next-route nudges share one wrapping row, so the
                      pills sit under the scene they belong to rather than in a
                      fixed strip at the bottom of the page. */}
                  {!pending && turns[turns.length - 1]?.role === "assistant" && (
                    <div className="flex flex-wrap items-center gap-2">
                      {renderSaveButton(turns.length - 1)}
                      {suggestions.map((beat, bi) => (
                        <button
                          key={`${bi}-${beat}`}
                          type="button"
                          onClick={() => send(beat)}
                          title={beat}
                          className="flex min-h-7 max-w-full items-center rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-left text-[11px] leading-snug text-zinc-300 transition-colors hover:border-yellow-600 hover:text-yellow-300"
                        >
                          {beat}
                        </button>
                      ))}
                      <Tooltip
                        label={regenerating ? "Generating suggestions…" : "Suggest three more routes"}
                        align="left"
                      >
                        <button
                          type="button"
                          onClick={refreshSuggestions}
                          disabled={regenerating}
                          aria-busy={regenerating}
                          aria-label={regenerating ? "Generating suggestions" : "Regenerate suggestions"}
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/60 text-[11px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-wait disabled:text-yellow-400"
                        >
                          <span
                            aria-hidden
                            className={regenerating ? "inline-block animate-spin" : "inline-block"}
                          >
                            ↻
                          </span>
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </div>
              </div>
            )}

            {pending && !scene && (
              <p className="animate-pulse text-sm text-zinc-500">
                {thinking ? "Thinking…" : "Writing…"}
              </p>
            )}

            {!scene && !pending && turns.length === 0 && (
              <ThreadEmpty>
                <>
                  <p>
                    Hi! Cast a character or two, then describe the scene — a setting, a
                    tension, who speaks first.
                  </p>
                  <p className="text-xs text-zinc-600">
                    Every reply is <strong>third person, past tense</strong>, 500 words or fewer.
                  </p>
                </>
              </ThreadEmpty>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
              setDraft("");
            }}
            className="flex flex-shrink-0 gap-2"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={cast.length ? "What happens next?" : "Pick a cast first…"}
              disabled={cast.length === 0 || pending}
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={cast.length === 0 || pending || !draft.trim() || (needsGenre && !genre)}
              title={needsGenre && !genre ? "Pick a genre first" : undefined}
              className="rounded-lg bg-yellow-600 px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors hover:bg-yellow-500 disabled:opacity-40"
            >
              Write
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
