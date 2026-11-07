"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  discoverCharacters,
  streamProfiles,
  type CharacterCandidate,
  type FilteredEntry,
} from "@/lib/api";

type RowState = "idle" | "queued" | "running" | "ok" | "error";

// Same six roles the extractor emits, listed in the order the picker offers them.
const ROLES = ["protagonist", "antagonist", "love-interest", "mentor", "supporting", "minor"];

// Display order for the candidate list: plot importance, then alphabetical.
function roleRank(role?: string | null) {
  const index = ROLES.indexOf((role ?? "").toLowerCase());
  return index === -1 ? ROLES.length : index;
}

function isMinor(character: CharacterCandidate) {
  return (character.role ?? "").toLowerCase() === "minor";
}

function byImportance(a: CharacterCandidate, b: CharacterCandidate) {
  const rank = roleRank(a.role) - roleRank(b.role);
  return rank !== 0 ? rank : a.name.localeCompare(b.name);
}

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  );
}

export default function ExtractCharactersPage() {
  return (
    <Suspense fallback={<div className="py-8 text-zinc-500">Loading…</div>}>
      <ExtractContent />
    </Suspense>
  );
}

function ExtractContent() {
  const searchParams = useSearchParams();
  const [bookIds, setBookIds] = useState<number[]>([]);

  const [phase, setPhase] = useState<"discovering" | "ready" | "generating">("discovering");
  const [progress, setProgress] = useState("Reading your books…");
  const [candidates, setCandidates] = useState<CharacterCandidate[]>([]);
  const [filtered, setFiltered] = useState<FilteredEntry[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [savedIds, setSavedIds] = useState<Record<string, number>>({});
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Freeform notes handed to the model as authoritative casting instructions.
  const [guidance, setGuidance] = useState("");
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  // Passing mentions are hidden by default; the toggle keeps them reachable.
  const [showMinor, setShowMinor] = useState(false);

  const startedRef = useRef(false);

  useEffect(() => {
    setBookIds(parseIds(searchParams.get("ids")));
  }, [searchParams]);

  const runDiscovery = useCallback(
    async (notes: string) => {
      setPhase("discovering");
      setDiscoverError(null);
      setRunError(null);
      setProgress("Reading your books…");
      setRowState({});
      setRowError({});
      setSavedIds({});
      setCandidates([]);
      setFiltered([]);
      setSelected({});

      try {
        for await (const event of discoverCharacters(bookIds, notes)) {
          switch (event.kind) {
            case "book":
              setProgress(`Reading “${event.title}”…`);
              break;
            case "found":
              setProgress(`Found ${event.count} character${event.count === 1 ? "" : "s"} so far…`);
              break;
            case "book_error":
              setProgress(`Skipped “${event.title ?? event.calibre_id}” — ${event.error}`);
              break;
            case "candidates": {
              setCandidates(event.candidates);
              setFiltered(event.filtered);
              // Preselect everything that doesn't already exist.
              setSelected(
                Object.fromEntries(event.candidates.map((c) => [c.name, !c.already_extracted]))
              );
              setPhase("ready");
              break;
            }
          }
        }
        setPhase((p) => (p === "discovering" ? "ready" : p));
      } catch (err) {
        setDiscoverError(err instanceof Error ? err.message : "Discovery failed");
        setPhase("ready");
      }
    },
    [bookIds]
  );

  useEffect(() => {
    if (bookIds.length === 0 || startedRef.current) return;
    startedRef.current = true;
    void runDiscovery("");
  }, [bookIds, runDiscovery]);

  const toggle = useCallback((name: string) => {
    setSelected((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const setRole = useCallback((name: string, role: string) => {
    setCandidates((prev) =>
      prev.map((c) => (c.name === name ? { ...c, role: role || null } : c))
    );
  }, []);

  const addManual = useCallback(() => {
    const name = manualName.trim();
    if (!name) return;
    setCandidates((prev) =>
      prev.some((c) => c.name.toLowerCase() === name.toLowerCase())
        ? prev
        : [
            {
              name,
              aliases: [],
              role: null,
              description: null,
              source_book_ids: bookIds,
              already_extracted: false,
              possible_duplicate: false,
              existing_id: null,
            },
            ...prev,
          ]
    );
    setSelected((prev) => ({ ...prev, [name]: true }));
    setManualName("");
  }, [bookIds, manualName]);

  const minorCount = candidates.filter(isMinor).length;
  const visible = useMemo(
    () => candidates.filter((c) => showMinor || !isMinor(c)).sort(byImportance),
    [candidates, showMinor]
  );
  const chosen = visible.filter((c) => selected[c.name] && !c.already_extracted);

  const selectAll = useCallback(() => {
    setSelected((prev) => ({
      ...prev,
      ...Object.fromEntries(visible.filter((c) => !c.already_extracted).map((c) => [c.name, true])),
    }));
  }, [visible]);

  const clearAll = useCallback(() => {
    setSelected((prev) => ({
      ...prev,
      ...Object.fromEntries(visible.map((c) => [c.name, false])),
    }));
  }, [visible]);

  const handleGenerate = useCallback(async () => {
    if (chosen.length === 0) return;
    setPhase("generating");
    setRunError(null);
    setRowState(Object.fromEntries(chosen.map((c) => [c.name, "queued"])));

    try {
      for await (const event of streamProfiles(
        chosen.map((c) => ({
          name: c.name,
          aliases: c.aliases,
          role: c.role,
          description: c.description,
          calibre_ids: c.source_book_ids.length ? c.source_book_ids : bookIds,
        })),
        guidance,
        bookIds
      )) {
        if (event.kind === "started") {
          setProgress(`Profiling ${event.name}…`);
          setRowState((prev) => ({ ...prev, [event.name]: "running" }));
        } else if (event.kind === "ok") {
          setRowState((prev) => ({ ...prev, [event.name]: "ok" }));
          setSavedIds((prev) => ({ ...prev, [event.name]: event.character.id }));
        } else if (event.kind === "profile_error") {
          setRowState((prev) => ({ ...prev, [event.name]: "error" }));
          setRowError((prev) => ({ ...prev, [event.name]: event.error }));
        }
      }
      setProgress("Done.");
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Profile generation failed");
    } finally {
      setPhase("ready");
    }
  }, [bookIds, chosen, guidance]);

  const done = Object.values(rowState).filter((s) => s === "ok").length;
  const failed = Object.values(rowState).filter((s) => s === "error").length;
  const busy = phase === "discovering" || phase === "generating";

  return (
    <div className="space-y-6 pt-5 pb-16">
      <header className="space-y-1">
        <Link href="/" className="text-xs text-zinc-500 hover:text-yellow-400">
          ← Library
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Extract characters</h1>
        <p className="text-sm text-zinc-500">
          Analysing {bookIds.length} book{bookIds.length === 1 ? "" : "s"} — the whole body of
          work at once, so a series is read as one story.
        </p>
      </header>

      {/* Orientation notes: the model's reading of the cast is fallible and the user
          often knows better. These notes outrank its inferences. */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
        <button
          type="button"
          onClick={() => setGuidanceOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-sm font-medium text-zinc-200">
            Steer the model
            {guidance.trim() && <span className="ml-2 text-[11px] text-yellow-500">notes active</span>}
          </span>
          <span className="text-xs text-zinc-500">{guidanceOpen ? "hide" : "show"}</span>
        </button>

        {guidanceOpen && (
          <div className="space-y-2 border-t border-zinc-800 px-4 py-3">
            <p className="text-xs leading-relaxed text-zinc-500">
              Tell it what you know: who matters, who is not a character, and what each one
              really is. Names and roles from the user always win over its guesses.
            </p>
            <textarea
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              rows={5}
              placeholder={
                "Laurent is the protagonist, Damen is the protagonist, Uncle is the antagonist.\nArles and Vere are places, not characters.\nThe Regent is Laurent's uncle — same person."
              }
              className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-yellow-600 focus:outline-none"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-zinc-600">
                Applied to the cast list and to every profile.
              </p>
              <button
                type="button"
                onClick={() => void runDiscovery(guidance)}
                disabled={busy || !guidance.trim()}
                className="rounded-lg border border-yellow-700/60 bg-yellow-600/10 px-3 py-1.5 text-sm font-medium text-yellow-400 transition-colors hover:bg-yellow-600/20 disabled:opacity-40"
              >
                Re-read with these notes
              </button>
            </div>
          </div>
        )}
      </section>

      {discoverError && (
        <p className="rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {discoverError}
        </p>
      )}

      {busy && (
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <p className="flex items-center gap-2 text-sm text-zinc-300">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-yellow-400" />
            {progress}
          </p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-xs uppercase tracking-wider text-zinc-500">
                {visible.length} candidate{visible.length === 1 ? "" : "s"} · {chosen.length} selected
              </p>
              <div className="flex items-center gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={selectAll}
                  disabled={busy || visible.length === 0}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 transition-colors hover:border-yellow-600 hover:text-yellow-400 disabled:opacity-40"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={busy || visible.length === 0}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 transition-colors hover:border-yellow-600 hover:text-yellow-400 disabled:opacity-40"
                >
                  Unselect all
                </button>
              </div>
            </div>
            {phase === "generating" ? (
              <span className="text-xs text-zinc-400 tabular-nums">
                {done} done{failed > 0 ? `, ${failed} failed` : ""}
              </span>
            ) : (
              <button
                type="button"
                onClick={handleGenerate}
                disabled={chosen.length === 0 || busy}
                className="rounded-lg bg-yellow-600 px-3 py-2 text-sm font-semibold text-zinc-900 transition-colors hover:bg-yellow-500 disabled:opacity-40"
              >
                Generate {chosen.length || ""} profile{chosen.length === 1 ? "" : "s"}
              </button>
            )}
          </div>

          {runError && <p className="text-sm text-red-400">{runError}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManual();
                }
              }}
              placeholder="Add a name it missed…"
              className="min-w-[14rem] flex-1 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-yellow-600 focus:outline-none"
            />
            <button
              type="button"
              onClick={addManual}
              disabled={!manualName.trim() || busy}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-yellow-600 hover:text-yellow-400 disabled:opacity-40"
            >
              Add
            </button>
          </div>

          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
            {visible.map((candidate) => {
              const state = rowState[candidate.name] ?? "idle";
              const disabled = candidate.already_extracted || phase === "generating";
              const savedId = savedIds[candidate.name];

              return (
                <li key={candidate.name} className="flex items-start gap-3 bg-zinc-900/40 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => !disabled && toggle(candidate.name)}
                    disabled={disabled}
                    aria-label={`Select ${candidate.name}`}
                    className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md transition-colors ${
                      candidate.already_extracted
                        ? "cursor-not-allowed border border-zinc-700 bg-zinc-800/60 opacity-60"
                        : selected[candidate.name]
                          ? "bg-yellow-500"
                          : "border border-zinc-600 bg-zinc-900 hover:border-yellow-500"
                    }`}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M2 6L5 9L10 3"
                        stroke={selected[candidate.name] && !candidate.already_extracted ? "#18181b" : "transparent"}
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-zinc-100">{candidate.name}</p>
                      <select
                        value={candidate.role ?? ""}
                        onChange={(e) => setRole(candidate.name, e.target.value)}
                        disabled={disabled}
                        aria-label={`Role for ${candidate.name}`}
                        className={`rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-[10px] capitalize text-zinc-300 focus:border-yellow-600 focus:outline-none disabled:opacity-50 ${
                          candidate.role ? "" : "text-zinc-500"
                        }`}
                      >
                        <option value="">role?</option>
                        {ROLES.map((role) => (
                          <option key={role} value={role} className="capitalize">
                            {role}
                          </option>
                        ))}
                      </select>
                      {candidate.aliases.length > 0 && (
                        <span className="text-[11px] text-zinc-500">aka {candidate.aliases.join(", ")}</span>
                      )}
                      {candidate.already_extracted && (
                        <span className="text-[11px] text-zinc-500">· already profiled</span>
                      )}
                      {candidate.possible_duplicate && (
                        <span className="rounded-full bg-red-900/50 px-2 py-0.5 text-[10px] text-red-200">
                          possible duplicate
                        </span>
                      )}
                    </div>
                    {candidate.description && (
                      <p className="mt-0.5 text-xs leading-snug text-zinc-400">{candidate.description}</p>
                    )}
                    {rowError[candidate.name] && (
                      <p className="mt-1 text-[11px] text-red-400">{rowError[candidate.name]}</p>
                    )}
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-3 text-[11px]">
                    {candidate.already_extracted && candidate.existing_id && (
                      <Link
                        href={`/characters/${candidate.existing_id}`}
                        className="text-yellow-500 hover:text-yellow-400"
                      >
                        View profile
                      </Link>
                    )}
                    {savedId && (
                      <Link href={`/characters/${savedId}`} className="text-green-400 hover:text-green-300">
                        Open →
                      </Link>
                    )}
                    {state === "running" && <span className="text-yellow-400">profiling…</span>}
                    {state === "queued" && <span className="text-zinc-600">queued</span>}
                    {state === "ok" && <span className="text-green-400">✓</span>}
                    {state === "error" && <span className="text-red-400">failed</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          {minorCount > 0 && (
            <p className="text-[11px] text-zinc-600">
              {minorCount} minor character{minorCount === 1 ? "" : "s"} — named in passing or not
              relevant to the plot — {showMinor ? "shown" : "hidden"}.{" "}
              <button
                type="button"
                onClick={() => setShowMinor((v) => !v)}
                className="text-yellow-600 underline-offset-2 hover:text-yellow-400 hover:underline"
              >
                {showMinor ? "Hide them" : "Show them"}
              </button>
            </p>
          )}

          {filtered.length > 0 && (
            <p className="text-[11px] leading-relaxed text-zinc-600">
              Ignored {filtered.length} non-character entr
              {filtered.length === 1 ? "y" : "ies"}:{" "}
              {filtered
                .slice(0, 8)
                .map((f) => `${f.name} (${f.kind})`)
                .join(", ")}
              {filtered.length > 8 ? "…" : ""} — add one above if it is a person after all.
            </p>
          )}

          <div className="flex justify-end pt-2">
            <Link href="/characters" className="text-sm text-yellow-500 hover:text-yellow-400">
              All characters →
            </Link>
          </div>
        </div>
      )}

      {!discoverError && phase === "ready" && candidates.length === 0 && (
        <p className="py-12 text-center text-sm text-zinc-500">
          No named characters came back for this selection.
        </p>
      )}
    </div>
  );
}
