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
import { parseIds, initials } from "@/lib/format";
import { BookmarkIcon, CheckIcon, ClearIcon, CharacterIcon } from "@/components/icons";

function applyCastParam(ids: number[]) {
  const query = ids.length ? `?chars=${ids.join(",")}` : "";
  window.history.replaceState(null, "", `/write${query}`);
}

export default function WritePage() {
  return (
    <Suspense fallback={<div className="py-8 text-muted">Loading…</div>}>
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
          className={`flex items-center gap-1 rounded-full shadow-xs shadow-border p-1.5 pr-2.5 text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
            saved
              ? "bg-green-500/60 hover:bg-green-500 text-white"
              : "bg-card text-muted hover:bg-highlight hover:text-card"
          }`}
        >
          {saved ? (
            <><CheckIcon /> Saved</>
          ) : (
            <><BookmarkIcon className="w-4 h-4" strokeWidth={2} /> Save</>
          )}
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
    <div className="flex h-[calc(100vh-5.5rem)] flex-col overflow-hidden pt-4 pb-2">
      <h1 className="text-2xl font-bold tracking-tight">Write</h1>
      <p className="text-sm text-muted mt-1 mb-4">
        {cast.length === 0 ? (
          "Pick a cast on the left to start a scene."
        ) : (
          <>
            Casting <strong className="text-highlight">{cast.map((c) => c.name).join(", ")}</strong>.
          </>
        )}
      </p>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Same shape as the chat page's context column: the selection, then a picker. */}
        <aside className="flex w-[200px] flex-shrink-0 min-h-0 flex-col gap-3 overflow-hidden rounded-xl bg-card p-3 shadow-md shadow-border">
          <div className="flex flex-shrink-0 items-center justify-between">
            <p className="text-xs font-semibold text-muted uppercase tracking-wide">Cast</p>
            {castIds.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setCastIds([]);
                  applyCastParam([]);
                }}
                className="text-xs text-muted hover:text-accent cursor-pointer transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex-shrink-0 rounded-lg px-2.5 py-2 text-xs leading-snug bg-accent/20 border border-accent">
            <p className="flex items-center gap-1">
              <CharacterIcon className="w-5 h-5" />
              {castIds.length === 0
                ? "No cast selected"
                : `${castIds.length} character${castIds.length === 1 ? "" : "s"} selected`}
            </p>
          </div>

          {castIds.length > 0 ? (
            <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 content-start gap-2 overflow-y-auto">
              {castIds.map((id) => {
                const character = (characters ?? []).find((c) => c.id === id);
                return (
                  <div key={id} className="group/cast relative aspect-[2/3] rounded-lg bg-border">
                    {/* Clipping lives on the link, not the grid item — same reason as chat. */}
                    <Link
                      href={`/characters/${id}`}
                      className="block h-full w-full overflow-hidden rounded-lg shadow-sm shadow-border"
                    >
                      {character?.thumbnail ? (
                        <img
                          src={character.thumbnail}
                          alt={character.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-base font-black text-muted">
                          {character ? initials(character.name) : `#${id}`}
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-card rounded-b-md p-1 opacity-0 transition-opacity group-hover/cast:opacity-100">
                        <p className="line-clamp-2 text-xs font-medium leading-tight">
                          {character?.name ?? `#${id}`}
                        </p>
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={() => toggleCast(id)}
                      aria-label={`Remove ${character?.name ?? `character ${id}`} from the cast`}
                      className="absolute top-1 right-1 h-5 w-5 rounded-full opacity-0 group-hover/cast:opacity-100 transition-colors flex items-center justify-center bg-card shadow-xs shadow-border cursor-pointer hover:bg-red-500 hover:text-background"
                    >
                      <ClearIcon className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="min-h-0 flex-1 rounded-lg border border-dashed border-muted px-2 py-4 text-center">
              <p className="text-xs text-muted leading-relaxed">
                No characters selected.
                <br />
                Add one below to start writing.
              </p>
            </div>
          )}

          {/* Add characters — the collapsible equivalent of chat's "+ Add books" */}
          <div className="flex min-h-0 flex-shrink-0 flex-col gap-2 pt-2">
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              className="w-full py-1.5 rounded-lg text-xs font-semibold bg-background shadow-sm shadow-border text-muted hover:cursor-pointer hover:bg-highlight hover:text-card transition-colors"
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
                  className="w-full bg-card shadow-sm shadow-border rounded-lg px-2.5 py-1.5 text-xs placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <div className="max-h-[180px] space-y-0.5 overflow-y-auto">
                  {pickable.map((character) => {
                    const checked = castIds.includes(character.id);
                    return (
                      <label
                        key={character.id}
                        className="flex items-center gap-2 py-1 cursor-pointer hover:ring-2 hover:ring-accent mx-2.5 my-1 rounded"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCast(character.id)}
                          className="flex-shrink-0 accent-accent"
                        />
                        <span className="h-7 w-5 flex-shrink-0 overflow-hidden rounded bg-muted">
                          {character.thumbnail ? (
                            <img src={character.thumbnail} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-[7px] font-bold text-background">
                              {initials(character.name)}
                            </span>
                          )}
                        </span>
                        <span className="line-clamp-2 text-xs leading-tight">
                          {character.name}
                        </span>
                      </label>
                    );
                  })}
                  {pickable.length === 0 && (
                    <p className="px-1 py-2 text-xs text-muted">
                      {characters ? "No characters match." : "Loading…"}
                    </p>
                  )}
                </div>
                <p className="text-xs leading-tight">
                  Up to 5 characters get their full profile; beyond that the cast is condensed.
                </p>
              </div>
            )}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-background shadow-sm shadow-border">
          {genres.length > 0 && (
            <div className="flex flex-shrink-0 flex-wrap gap-1.5 px-6 pt-4">
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
                        ? { backgroundColor: color, borderColor: color, color: "#000000" }
                        : { borderColor: `${color}66`, color }
                    }
                    className="rounded-full border px-3 py-1 text-xs font-semibold transition-colors cursor-pointer"
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {/* Same message layout as the chat page: a right-aligned brief, then
                the reply in a thin-bordered container. */}
            {earlierTurns.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="flex flex-col">
                  <div className="self-end rounded-lg px-4 py-2 text-sm bg-accent/20 border border-accent">
                    {turn.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col">
                  <div className="w-3/4 space-y-2 self-start">
                    <div className="whitespace-pre-wrap rounded-lg bg-card shadow-md shadow-border p-4 text-sm leading-relaxed">
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
                  <div className="whitespace-pre-wrap rounded-lg bg-card shadow-md shadow-border p-4 text-sm leading-relaxed">
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
                          className="flex min-h-7 max-w-full items-center rounded-full shadow-xs shadow-border bg-card px-3 py-1 text-left text-xs leading-snug text-muted cursor-pointer transition-colors hover:bg-highlight hover:text-card"
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
                          className="flex h-7 w-7 items-center justify-center rounded-full shadow-xs shadow-border bg-card text-xs text-muted cursor-pointer transition-colors hover:bg-highlight hover:text-card disabled:cursor-wait"
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
              <p className="animate-pulse text-sm text-muted">
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
                  <p className="text-xs">
                    Every reply is <strong>third person, past tense</strong>, 500 words or fewer.
                  </p>
                </>
              </ThreadEmpty>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
              setDraft("");
            }}
            className="flex w-full flex-shrink-0 gap-2 p-4"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={cast.length ? "What happens next?" : "Pick a cast first…"}
              disabled={cast.length === 0 || pending}
              className="min-w-0 flex-1 rounded-lg px-4 py-4 text-sm placeholder-muted focus:outline-none bg-card shadow-sm shadow-border focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={cast.length === 0 || pending || !draft.trim() || (needsGenre && !genre)}
              title={needsGenre && !genre ? "Pick a genre first" : undefined}
              className="disabled:opacity-30 disabled:cursor-not-allowed transition-colors px-6 py-2.5 rounded-lg text-sm font-semibold cursor-pointer bg-card hover:bg-highlight hover:text-background"
            >
              Write
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
