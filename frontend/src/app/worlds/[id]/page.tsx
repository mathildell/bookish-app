"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import BookAdder, { type AddedBook } from "@/components/BookAdder";
import ImageEditor from "@/components/ImageEditor";
import SourceList, { type SourceWeight } from "@/components/SourceList";
import WorldImage from "@/components/WorldImage";
import { deleteWorld, fetchWorld, refineWorld, resetWorldReading, resolveWorldVariant, updateWorld } from "@/lib/api";
import type { World, WorldEvidence, WorldTerm } from "@/types/world";
import { ClearIcon, EditIcon, LockIcon, SparklesIcon, TrashIcon } from "@/components/icons";

// Human names for the lockable fields, as the sections label them.
const FIELD_LABELS: Record<string, string> = {
  premise: "Premise",
  rules: "Rules",
  social_structure: "Social structure",
  tropes: "Conventions",
  settings: "Typical settings",
  terminology: "Terminology",
  tensions: "Tensions",
  variants: "Where sources differ",
};

const LABEL = "text-xs font-semibold uppercase tracking-wider mb-2";
const INPUT =
  "w-full rounded-lg bg-background px-3 py-2 text-sm text-foreground placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent";
const BTN =
  "flex gap-2 items-center rounded-lg cursor-pointer bg-card hover:bg-highlight hover:text-background px-4 py-2.5 text-sm font-medium transition-colors disabled:bg-muted disabled:cursor-not-allowed disabled:text-foreground";

const toLines = (values: string[]) => values.join("\n");
const fromLines = (value: string) =>
  value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const termsToText = (terms: WorldTerm[]) => terms.map((t) => `${t.term} — ${t.meaning}`).join("\n");
function textToTerms(value: string): WorldTerm[] {
  return fromLines(value).map((line) => {
    const [term, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
    return { term: term.trim(), meaning: rest.join(" — ").trim() };
  });
}

/** What the sheet rests on, and the fields a refine will leave alone. */
function EvidencePanel({
  evidence,
  locked,
  onUnlock,
  onReadAgain,
  message,
  busy,
}: {
  evidence?: WorldEvidence | null;
  locked: string[];
  onUnlock: (field: string) => void;
  onReadAgain: () => void;
  message: string;
  busy: boolean;
}) {
  return (
    <div className="space-y-2 rounded-xl p-3 text-xs bg-card shadow-sm shadow-border">
      <p className="text-muted">Evidence</p>
      {evidence ? (
        <p>
          {evidence.notes} quoted notes from {evidence.passages} passages, read in {evidence.passes} pass
          {evidence.passes === 1 ? "" : "es"}.
        </p>
      ) : (
        <p className="italic text-muted">No notes recorded yet. Refine to start building them.</p>
      )}
      <button
        type="button"
        onClick={onReadAgain}
        disabled={busy}
        title="Mark every passage unread, so the next refine can read from the start. Nothing is deleted."
        className="cursor-pointer rounded-full border border-background px-2 py-1 leading-3 text-muted transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
      >
        ↺ Read everything again
      </button>
      {message && <p className="text-muted">{message}</p>}
      {locked.length > 0 && (
        <div>
          <p className="text-muted">Locked fields</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {locked.map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => onUnlock(field)}
                title="Unlock: let refine rewrite this field"
                className="max-w-full truncate text-xs border border-background text-muted px-2 py-1 rounded-full transition-colors leading-3 hover:text-foreground hover:border-border flex items-center gap-2 cursor-pointer"
              >
                <LockIcon /> {FIELD_LABELS[field] ?? field} <ClearIcon />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl p-4 bg-card shadow-sm shadow-border">
      <div>
        <h2 className="font-bold">{title}</h2>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Prose({ text }: { text?: string | null }) {
  if (!text) return <p className="text-sm italic">Not filled in.</p>;
  return <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>;
}

function Bullets({ values }: { values: string[] }) {
  return (
    <ul className="ml-4 list-disc space-y-1 text-sm leading-relaxed">
      {values.map((value, i) => (
        <li key={`${i}-${value}`}>{value}</li>
      ))}
    </ul>
  );
}

function Chips({ values }: { values: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value, i) => (
        <span
          key={`${i}-${value}`}
          className="max-w-full truncate text-sm border px-2 py-1 rounded-full transition-colors leading-3 text-foreground border-border/60 flex items-center gap-2 bg-background"
        >
          {value}
        </span>
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  rows = 1,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label className="block space-y-1">
      <span className={LABEL}>{label}</span>
      {rows > 1 ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className={`${INPUT} resize-none`} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className={INPUT} />
      )}
    </label>
  );
}

/**
 * One line per entry, parsed on every edit. The textarea keeps the raw text:
 * deriving its value from the parsed list on each keystroke would swallow the
 * newline or space just typed at the end of a line.
 */
function LinesField<T>({
  label,
  values,
  onChange,
  toText,
  fromText,
  placeholder,
}: {
  label: string;
  values: T[];
  onChange: (v: T[]) => void;
  toText: (v: T[]) => string;
  fromText: (s: string) => T[];
  placeholder?: string;
}) {
  const [text, setText] = useState(() => toText(values));
  useEffect(() => {
    // Adopt changes from elsewhere (reset), but not the echo of our own edit.
    setText((current) => (toText(fromText(current)) === toText(values) ? current : toText(values)));
  }, [values, toText, fromText]);
  return (
    <label className="block space-y-1">
      <span className={LABEL}>{label}</span>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(fromText(e.target.value));
        }}
        rows={Math.min(10, Math.max(3, values.length + 1))}
        placeholder={placeholder}
        className={`${INPUT} resize-none`}
      />
    </label>
  );
}

/**
 * Another pass over the sheet: reads passages earlier passes skipped, plus every
 * passage of any books added here, and revises the sheet. Hand-edited (locked)
 * fields are kept as they are.
 */
function RefinePanel({ world, onClose }: { world: World; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [guidance, setGuidance] = useState("");
  const [added, setAdded] = useState<AddedBook[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // A pass takes minutes and the first steps emit nothing, so show that time is passing.
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Leaving the page drops the stream, which stops the backend job at its next step.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function start() {
    if (running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setDone(false);
    setLog([]);
    try {
      for await (const event of refineWorld(
        world.id,
        { guidance, calibre_ids: added.map((a) => a.id) },
        controller.signal
      )) {
        if (event.kind === "progress") setLog((prev) => [...prev, event.message]);
        else if (event.kind === "error") setError(event.error);
        else if (event.kind === "ok") {
          queryClient.setQueryData(["world", world.id], event.world);
          queryClient.invalidateQueries({ queryKey: ["worlds"] });
          queryClient.invalidateQueries({ queryKey: ["books", "sources"] });
          setAdded([]);
          setGuidance("");
          setDone(true);
        }
      }
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") {
        setError(e instanceof Error ? e.message : "Refine failed");
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl bg-card shadow-sm shadow-border p-4">
      <div>
        <h2 className="text-sm font-bold mb-2">Refine this world</h2>
        <p className="text-xs text-muted">
          Reads passages earlier passes skipped and revises the sheet from all the notes gathered so far,
          keeping what is already there. Add books to bring in new sources: every passage of a new book is read
          first. Fields you edited by hand are kept, so lock anything you like before refining. Takes a few
          minutes.
        </p>
      </div>

      <BookAdder added={added} onChange={setAdded} excludeIds={world.source_book_ids} disabled={running} />

      <textarea
        value={guidance}
        onChange={(e) => setGuidance(e.target.value)}
        disabled={running}
        rows={2}
        placeholder="Optional notes, e.g. “Dig into the legal side, and how heats work at work.”"
        className={`${INPUT} resize-none`}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted">
          {running && <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-highlight" />}
          {log.length > 0 && log[log.length - 1]}
          {running && ` · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
          {done && !running && <span className="text-green-400">Refined</span>}
        </div>

        <div className="flex gap-2 items-center">
          <button
            type="button"
            onClick={start}
            disabled={running}
            className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:bg-muted/20 disabled:text-muted"
          >
            {running
              ? "Refining…"
              : added.length
                ? `Start with ${added.length} new book${added.length === 1 ? "" : "s"}`
                : "Start"}
          </button>
          {running ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-red-600 hover:text-red-100"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-highlight hover:text-background"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}

/** The options inside a "where sources differ" entry: "Most books: X; one book: Y" -> [X, Y]. */
function variantOptions(variant: string): string[] {
  const parts = variant
    .split(/;\s+/)
    .map((p) => p.trim().replace(/\.$/, ""))
    .filter(Boolean);
  return parts.length > 1 ? parts : [variant.trim()];
}

/** The adopted version without its source label: "one book: heats last two weeks" -> "Heats last two weeks". */
function asDecision(option: string): string {
  const bare = option.replace(/^[^:]{1,60}:\s*/, "").trim() || option.trim();
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/**
 * Where the sources disagree, one entry per disagreement. Picking a version (or writing
 * your own) settles it: the model edits the sheet so nothing contradicts the decision,
 * the entry goes away, and the decision is kept so a refine does not bring it back.
 * Unresolved entries are not sent to the writing model.
 */
function VariantResolver({ world }: { world: World }) {
  const queryClient = useQueryClient();
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ changes: string[]; lockedSkipped: string[] } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function settle(variant: string, payload: { decision?: string; dismiss?: boolean }) {
    setPending(variant);
    setError(null);
    setResult(null);
    try {
      const out = await resolveWorldVariant(world.id, { variant, ...payload });
      queryClient.setQueryData(["world", world.id], out.world);
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      setResult({ changes: out.changes, lockedSkipped: out.locked_skipped ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't apply that decision");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {world.variants.map((variant) => {
        const options = variantOptions(variant);
        const busy = pending === variant;
        return (
          <div key={variant} className="space-y-2 rounded-lg border border-muted/20 bg-background px-3 py-2">
            <p className="text-xs text-muted">Which is right for your stories?</p>
            <div className="space-y-1.5">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => settle(variant, { decision: asDecision(option) })}
                  className="flex w-full cursor-pointer items-start gap-2 rounded-md bg-card px-2.5 py-1.5 text-left text-sm leading-snug transition-colors hover:bg-highlight hover:text-background disabled:cursor-wait disabled:opacity-50"
                >
                  <span className="mt-0.5 flex-none text-xs text-muted">Use</span>
                  <span>{option}</span>
                </button>
              ))}
            </div>
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const text = (custom[variant] ?? "").trim();
                if (text) void settle(variant, { decision: text });
              }}
            >
              <input
                value={custom[variant] ?? ""}
                onChange={(e) => setCustom({ ...custom, [variant]: e.target.value })}
                disabled={pending !== null}
                placeholder="Or write your own version…"
                className={`${INPUT} min-w-0 flex-1`}
              />
              <button
                type="submit"
                disabled={pending !== null || !(custom[variant] ?? "").trim()}
                className="flex-none cursor-pointer rounded-lg bg-card px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:opacity-40"
              >
                Use mine
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => settle(variant, { dismiss: true })}
                title="Drop this entry without changing the sheet"
                className="flex-none cursor-pointer rounded-lg bg-card px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Dismiss
              </button>
            </form>
            {busy && <p className="animate-pulse text-xs text-muted">Updating the sheet to match…</p>}
          </div>
        );
      })}

      {error && <p className="text-sm text-red-400">{error}</p>}
      {result && (
        <div className="rounded-lg bg-background px-3 py-2 text-xs">
          <p className="font-semibold">{result.changes.length ? "Sheet updated" : "Settled, no sheet changes needed"}</p>
          {result.changes.length > 0 && (
            <ul className="ml-4 mt-1 list-disc space-y-0.5 text-muted">
              {result.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          {result.lockedSkipped.length > 0 && (
            <p className="mt-1 text-orange-400">
              Not changed because locked: {result.lockedSkipped.map((f) => FIELD_LABELS[f] ?? f).join(", ")}. Unlock and
              edit by hand if something there still disagrees.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function WorldDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const worldId = Number(params?.id);
  const [draft, setDraft] = useState<World | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);

  const { data: world, isLoading, isError } = useQuery({
    queryKey: ["world", worldId],
    queryFn: () => fetchWorld(worldId),
    enabled: Number.isFinite(worldId),
  });

  const saveMut = useMutation({
    mutationFn: (d: World) =>
      updateWorld(worldId, {
        name: d.name,
        premise: d.premise ?? "",
        rules: d.rules,
        social_structure: d.social_structure,
        tropes: d.tropes,
        settings: d.settings,
        terminology: d.terminology,
        tensions: d.tensions,
        variants: d.variants,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["world", worldId], saved);
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      setDraft(null);
    },
  });

  const [memoryNote, setMemoryNote] = useState("");

  const weightMut = useMutation({
    mutationFn: (weights: Record<string, string>) => updateWorld(worldId, { source_weights: weights }),
    onSuccess: (saved) => queryClient.setQueryData(["world", worldId], saved),
  });

  const resetMut = useMutation({
    mutationFn: (payload: { calibre_id?: number }) => resetWorldReading(worldId, payload),
    onSuccess: (result, payload) => {
      queryClient.setQueryData(["world", worldId], result.world);
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      setMemoryNote(
        `${result.unread_passages} passage${result.unread_passages === 1 ? "" : "s"} from ${
          payload.calibre_id === undefined ? "every book" : "that book"
        } marked unread. Your sheet and notes are untouched; refine to read them again.`
      );
    },
    onError: () => setMemoryNote("Couldn't reset."),
  });

  const unlockMut = useMutation({
    mutationFn: (lockedFields: string[]) => updateWorld(worldId, { locked_fields: lockedFields }),
    onSuccess: (saved) => queryClient.setQueryData(["world", worldId], saved),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteWorld(worldId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      router.push("/worlds");
    },
  });

  if (isLoading) return <div className="py-8 text-muted">Loading world…</div>;
  if (isError || !world) {
    return (
      <div className="space-y-3 py-16 text-center text-muted">
        <p>That world doesn&apos;t exist (it may have been deleted).</p>
        <Link href="/worlds" className="text-highlight hover:text-accent">
          ← All worlds
        </Link>
      </div>
    );
  }

  const editing = draft !== null;
  const patchDraft = (patch: Partial<World>) => setDraft((current) => ({ ...(current ?? world), ...patch }));
  const locked = world.locked_fields ?? [];

  return (
    <div className="space-y-6 pt-5 pb-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/worlds" className="text-xs text-muted hover:text-highlight">
            ← All worlds
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{world.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span>
              {world.rules.length} rule{world.rules.length === 1 ? "" : "s"}
            </span>
            <span>
              · {world.terminology.length} term{world.terminology.length === 1 ? "" : "s"}
            </span>
            <span>
              · {world.source_book_ids.length} source{world.source_book_ids.length === 1 ? "" : "s"}
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-lg cursor-pointer bg-card hover:bg-red-600 hover:text-red-100 px-4 py-2.5 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => draft && saveMut.mutate(draft)}
                disabled={saveMut.isPending || !draft?.name.trim()}
                className="rounded-lg cursor-pointer bg-card hover:bg-highlight hover:text-background px-4 py-2.5 text-sm font-medium transition-colors disabled:bg-muted"
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setRefineOpen((open) => !open)}
                title="Read more of the source books, or add new ones, and revise this sheet"
                className={BTN}
              >
                <SparklesIcon /> Refine
              </button>
              <button type="button" onClick={() => setDraft(structuredClone(world))} className={BTN}>
                <EditIcon /> Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete ${world.name}?`)) deleteMut.mutate();
                }}
                className="flex gap-2 items-center rounded-lg cursor-pointer bg-card hover:bg-red-600 hover:text-red-100 px-4 py-2.5 text-sm font-medium transition-colors"
              >
                <TrashIcon /> Delete
              </button>
            </>
          )}
        </div>
      </header>

      {saveMut.isError && <p className="text-sm text-red-400">Couldn&apos;t save, try again.</p>}

      {refineOpen && !editing && <RefinePanel world={world} onClose={() => setRefineOpen(false)} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        {/* Sticky from large screens up, like the character page's column. */}
        <aside className="space-y-4 self-start lg:sticky lg:top-[68px] lg:max-h-[calc(100vh-5.5rem)] lg:overflow-y-auto">
          <div className="space-y-2">
            <div className="aspect-[2/3] overflow-hidden rounded-xl bg-card shadow-sm shadow-border">
              <WorldImage world={world} />
            </div>
            <ImageEditor
              hasImage={Boolean(world.image)}
              resetLabel="Use cover collage"
              onChange={async (url) => {
                const saved = await updateWorld(worldId, { image: url });
                queryClient.setQueryData(["world", worldId], saved);
                queryClient.invalidateQueries({ queryKey: ["worlds"] });
              }}
            />
          </div>

          <div className="space-y-2 rounded-xl bg-card shadow-border shadow-sm p-3 text-xs">
            <p>
              <span className="text-muted">Status: </span>
              <span className={world.status === "complete" ? "text-green-400" : "text-orange-400"}>
                {world.status}
              </span>
            </p>
            {world.model && (
              <p className="truncate">
                <span className="text-muted">Extracted by: </span>
                <span>{world.model}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 items-center">
              <p className="text-muted">Sources:</p>
              <SourceList
                ids={world.source_book_ids}
                weights={world.source_weights}
                busy={weightMut.isPending || resetMut.isPending}
                onWeight={(id, level: SourceWeight) => {
                  const next = { ...world.source_weights };
                  if (level === "normal") delete next[String(id)];
                  else next[String(id)] = level;
                  weightMut.mutate(next);
                }}
                onReset={(id) => resetMut.mutate({ calibre_id: id })}
              />
            </div>
          </div>

          <EvidencePanel
            evidence={world.evidence}
            locked={locked}
            onUnlock={(field) => unlockMut.mutate(locked.filter((f) => f !== field))}
            busy={resetMut.isPending}
            message={memoryNote}
            onReadAgain={() => resetMut.mutate({})}
          />

          <div className="space-y-2 rounded-xl bg-card shadow-border shadow-sm p-3 text-xs">
            <p className="text-muted">Use it</p>
            <Link
              href={{ pathname: "/write", query: { worlds: String(world.id) } }}
              className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 font-medium transition-colors hover:bg-highlight hover:text-background"
            >
              <SparklesIcon /> Write in this world
            </Link>
            <p className="leading-snug text-muted">
              Opens Discuss with this world selected. Add characters there to talk it through, then plan and
              write scenes from the other tabs.
            </p>
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          {editing && draft ? (
            <>
              <Section title="Name & premise" hint="What is different about this world, and what everyday life looks like because of it.">
                <Field label="Name" value={draft.name} onChange={(v) => patchDraft({ name: v })} />
                <Field label="Premise" value={draft.premise ?? ""} onChange={(v) => patchDraft({ premise: v })} rows={4} />
              </Section>
              <Section title="Rules & society" hint="One entry per line. Edited fields are locked against refine.">
                <LinesField
                  label="Rules: the mechanics a new story must obey"
                  values={draft.rules}
                  onChange={(v) => patchDraft({ rules: v })}
                  toText={toLines}
                  fromText={fromLines}
                />
                <LinesField
                  label="Social structure: hierarchy, law, class, norms, taboos"
                  values={draft.social_structure}
                  onChange={(v) => patchDraft({ social_structure: v })}
                  toText={toLines}
                  fromText={fromLines}
                />
              </Section>
              <Section title="Texture" hint="One entry per line.">
                <LinesField
                  label="Conventions: what readers of this setting expect"
                  values={draft.tropes}
                  onChange={(v) => patchDraft({ tropes: v })}
                  toText={toLines}
                  fromText={fromLines}
                />
                <LinesField
                  label="Typical settings"
                  values={draft.settings}
                  onChange={(v) => patchDraft({ settings: v })}
                  toText={toLines}
                  fromText={fromLines}
                />
                <LinesField
                  label="Tensions: conflicts the world produces by itself"
                  values={draft.tensions}
                  onChange={(v) => patchDraft({ tensions: v })}
                  toText={toLines}
                  fromText={fromLines}
                />
              </Section>
              <Section title="Terminology & variants">
                <LinesField
                  label="Terminology: one per line as “term — meaning”"
                  values={draft.terminology}
                  onChange={(v) => patchDraft({ terminology: v })}
                  toText={termsToText}
                  fromText={textToTerms}
                  placeholder="knot — …"
                />
                <LinesField
                  label="Where sources differ"
                  values={draft.variants}
                  onChange={(v) => patchDraft({ variants: v })}
                  toText={toLines}
                  fromText={fromLines}
                  placeholder="Most books: X; one book: Y"
                />
              </Section>
            </>
          ) : (
            <>
              <Section title="Premise">
                <Prose text={world.premise} />
              </Section>

              <Section title="Rules" hint="What a new story set here has to obey.">
                {world.rules.length > 0 ? <Bullets values={world.rules} /> : <p className="text-sm italic">Not filled in.</p>}
              </Section>

              {world.social_structure.length > 0 && (
                <Section title="Social structure">
                  <Bullets values={world.social_structure} />
                </Section>
              )}

              {(world.tropes.length > 0 || world.settings.length > 0) && (
                <Section title="Conventions & settings">
                  {world.tropes.length > 0 && (
                    <div>
                      <p className={LABEL}>Conventions</p>
                      <Chips values={world.tropes} />
                    </div>
                  )}
                  {world.settings.length > 0 && (
                    <div>
                      <p className={LABEL}>Typical settings</p>
                      <Chips values={world.settings} />
                    </div>
                  )}
                </Section>
              )}

              {world.tensions.length > 0 && (
                <Section title="Tensions" hint="Conflicts the world produces by itself: story engines.">
                  <Bullets values={world.tensions} />
                </Section>
              )}

              {world.terminology.length > 0 && (
                <Section title="Terminology">
                  <dl className="space-y-2">
                    {world.terminology.map((entry, i) => (
                      <div key={`${i}-${entry.term}`} className="rounded-lg bg-background border border-muted/20 px-3 py-2">
                        <dt className="text-sm font-semibold">{entry.term}</dt>
                        <dd className="text-sm leading-relaxed">{entry.meaning}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              )}

              {world.variants.length > 0 && (
                <Section
                  title={`Where sources differ (${world.variants.length} unresolved)`}
                  hint="Contradictions are no use when writing. Pick the version that is right for your stories: the sheet is edited to agree with it. Unresolved ones are not sent to the writing model."
                >
                  <VariantResolver world={world} />
                </Section>
              )}
              {(world.decisions?.length ?? 0) > 0 && (
                <Section title="Settled" hint="Disagreements you decided. A refine keeps the sheet consistent with them.">
                  <Bullets values={world.decisions ?? []} />
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
