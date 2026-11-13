"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteCharacter,
  fetchBook,
  fetchCharacter,
  refineCharacter,
  setCharacterListMembers,
  updateCharacter,
  useCharacterLists,
} from "@/lib/api";
import type { Character, CharacterEvidence, CharacterInput } from "@/types/character";
import { BookIcon, LockIcon, ClearIcon, TrashIcon, EditIcon, SparklesIcon } from "@/components/icons";

// Human names for the lockable fields, as the edit form labels them.
const FIELD_LABELS: Record<string, string> = {
  archetype: "Archetype",
  summary: "Summary",
  core_traits: "Core traits",
  motivations: "Wants & needs",
  fears: "Fears",
  flaws: "Flaws",
  values: "Values",
  voice: "Voice",
  mannerisms: "Mannerisms",
  appearance: "Appearance",
  relationships: "Relationship patterns",
  formative_experience: "Formative experience",
  arc_pattern: "Arc",
  situational_anchors: "Situational anchors",
};

/** What the profile rests on, and the fields refine will leave alone. */
function EvidencePanel({
  evidence,
  locked,
  onUnlock,
}: {
  evidence?: CharacterEvidence | null;
  locked: string[];
  onUnlock: (field: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-xl p-3 text-xs bg-card shadow-sm shadow-border">
      <p className="text-muted">Evidence</p>
      {evidence ? (
        <p>
          {evidence.observations} quoted observations from {evidence.chapters} chapters, grouped into{" "}
          {evidence.themes} themes ({evidence.established} established). {evidence.passages} passages read in{" "}
          {evidence.passes} pass{evidence.passes === 1 ? "" : "es"}.
        </p>
      ) : (
        <p className="italic text-muted">Made before evidence was recorded, refine to rebuild it.</p>
      )}
      {locked.length > 0 && (
        <div>
          <p className="text-muted">Locked fields</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {locked.map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => onUnlock(field)}
                title="Unlock: let refine and regeneration rewrite this field"
                className="*max-w-full truncate text-xs border border-background text-muted px-2 py-1 rounded-full transition-colors leading-3 hover:text-foreground hover:border-border flex items-center gap-2 cursor-pointer"
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

const LABEL = "text-xs font-semibold uppercase tracking-wider mb-2";
const INPUT =
  "w-full rounded-lg bg-background px-3 py-2 text-sm text-foreground placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent";

function toLines(values: string[]) {
  return values.join("\n");
}

function fromLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Source books, shown by title. Titles come from one query for the whole set so a
 * profile with three sources still makes a single render pass; each falls back to
 * its Calibre id until the lookup lands (or if the book is missing).
 */
function SourceBooks({ ids }: { ids: number[] }) {
  const { data } = useQuery({
    queryKey: ["books", "sources", ids],
    queryFn: async () => {
      const books = await Promise.all(
        ids.map(async (id) => {
          try {
            const book = await fetchBook(id);
            return { id, title: String(book.title || `#${id}`) };
          } catch {
            return { id, title: `#${id}` };
          }
        })
      );
      return books;
    },
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
  });

  if (ids.length === 0) {
    return <p className="italic text-muted">None yet</p>;
  }

  const books = data ?? ids.map((id) => ({ id, title: `#${id}` }));

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {books.map(({ id, title }) => (
        <Link
          key={id}
          href={`/book/${id}`}
          title={`Calibre #${id}`}
          className="max-w-full truncate text-xs border border-background text-muted px-2 py-1 rounded-full transition-colors leading-3 hover:text-foreground hover:border-border flex items-center gap-2"
        >
          <BookIcon /> {title}
        </Link>
      ))}
    </div>
  );
}

/** Tick the character lists this profile belongs to. Character lists only — never book lists. */
function CharacterLists({ characterId }: { characterId: number }) {
  const { data: lists } = useCharacterLists();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ id, characterIds }: { id: number; characterIds: number[] }) =>
      setCharacterListMembers(id, characterIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["characterLists"] }),
  });

  if (!lists || lists.length === 0) {
    return (
      <div className="space-y-2 rounded-xl text-xs bg-card shadow-sm shadow-border">
        <p className="text-muted">Lists</p>
        <p className="italic text-muted">No character lists yet — create one on the Characters page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl text-xs bg-card shadow-sm shadow-border p-3">
      <p className="text-muted">Lists</p>
      {lists.map((list) => {
        const member = list.character_ids.includes(characterId);
        return (
          <label key={list.id} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={member}
              onChange={() =>
                toggle.mutate({
                  id: list.id,
                  characterIds: member
                    ? list.character_ids.filter((id) => id !== characterId)
                    : [...list.character_ids, characterId],
                })
              }
              className="accent-accent"
            />
            <span className="min-w-0 truncate">{list.name}</span>
          </label>
        );
      })}
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

function Field({ label, value, onChange, rows = 1 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
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

/** One line per entry; blank lines are dropped on save. */
function ListField({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  // The textarea keeps the raw text: deriving its value from the parsed list on every
  // keystroke would swallow the newline or space just typed at the end of a line.
  const [text, setText] = useState(() => toLines(values));

  // Adopt changes that came from elsewhere (reset, refine, another field), but not the
  // echo of our own edit — that only differs from the parsed list by pending whitespace.
  useEffect(() => {
    setText((current) =>
      fromLines(current).join("\n") === values.join("\n") ? current : toLines(values)
    );
  }, [values]);

  return (
    <label className="block space-y-1">
      <span className={LABEL}>{label}</span>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(fromLines(e.target.value));
        }}
        rows={Math.min(8, Math.max(2, values.length + 1))}
        className={`${INPUT} resize-none`}
      />
    </label>
  );
}

function Prose({ text }: { text?: string | null }) {
  if (!text) return <p className="text-sm italic">Not filled in.</p>;
  return <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>;
}

function Chips({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <p className="text-sm italic text-muted">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <span key={value} className="max-w-full truncate text-sm border px-2 py-1 rounded-full transition-colors leading-3 text-foreground border-border/60 flex items-center gap-2 bg-background">
          {value}
        </span>
      ))}
    </div>
  );
}

export default function CharacterDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const characterId = Number(params?.id);
  const [draft, setDraft] = useState<Character | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineNotes, setRefineNotes] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineStatus, setRefineStatus] = useState("");
  const [refineError, setRefineError] = useState("");
  const [revisionNotes, setRevisionNotes] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const refineAbort = useRef<AbortController | null>(null);

  // A refine takes minutes and the first steps emit nothing, so show that time is passing.
  useEffect(() => {
    if (!refining) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [refining]);

  // Leaving the page drops the stream, which stops the backend job at its next step.
  useEffect(() => () => refineAbort.current?.abort(), []);

  const { data: character, isLoading, isError } = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => fetchCharacter(characterId),
    enabled: Number.isFinite(characterId),
  });

  const saveMut = useMutation({
    mutationFn: (patch: Partial<CharacterInput>) => updateCharacter(characterId, patch),
    onSuccess: (saved) => {
      queryClient.setQueryData(["character", characterId], saved);
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      setDraft(null);
    },
  });

  const unlockMut = useMutation({
    mutationFn: (lockedFields: string[]) => updateCharacter(characterId, { locked_fields: lockedFields }),
    onSuccess: (saved) => queryClient.setQueryData(["character", characterId], saved),
  });

  const runRefine = async () => {
    const abort = new AbortController();
    refineAbort.current = abort;
    setRefining(true);
    setRefineError("");
    setRefineStatus("Starting…");
    setRevisionNotes([]);
    try {
      for await (const event of refineCharacter(characterId, refineNotes, abort.signal)) {
        if (event.kind === "progress") {
          setRefineStatus(event.message);
        } else if (event.kind === "ok") {
          queryClient.setQueryData(["character", characterId], event.character);
          queryClient.invalidateQueries({ queryKey: ["characters"] });
          setRefineStatus("Refined.");
          setRevisionNotes(event.notes ?? []);
          setRefineNotes("");
        } else if (event.kind === "profile_error") {
          setRefineError(event.error);
        }
      }
    } catch (err) {
      if (abort.signal.aborted) setRefineStatus("Cancelled.");
      else setRefineError(err instanceof Error ? err.message : "Refine failed");
    } finally {
      refineAbort.current = null;
      setRefining(false);
    }
  };

  const deleteMut = useMutation({
    mutationFn: () => deleteCharacter(characterId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      router.push("/characters");
    },
  });

  if (isLoading) return <div className="py-8 text-muted">Loading profile…</div>;
  if (isError || !character) {
    return (
      <div className="space-y-3 py-16 text-center text-muted">
        <p>That character doesn&apos;t exist (it may have been deleted).</p>
        <Link href="/characters" className="text-highlight hover:text-accent">
          ← All characters
        </Link>
      </div>
    );
  }

  const editing = draft !== null;
  const view = draft ?? character;
  const patchDraft = (patch: Partial<Character>) => setDraft((current) => ({ ...(current ?? character), ...patch }));

  const handleSave = () => {
    if (!draft) return;
    const { id: _id, created_at: _created, updated_at: _updated, evidence: _evidence, ...patch } = draft;
    saveMut.mutate(patch);
  };

  return (
    <div className="space-y-6 pt-5 pb-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/characters" className="text-xs text-muted hover:text-highlight">
            ← All characters
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{character.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {character.role && <span className="capitalize">{character.role}</span>}
            {character.archetype && <span className="text-highlight">· {character.archetype}</span>}
            {character.aliases.length > 0 && <span className="text-muted">· a.k.a: <i>{character.aliases.join(", ")}</i></span>}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-lg cursor-pointer bg-card hover:bg-red-600 hover:text-red-100 px-4 py-2.5 text-sm font-medium transition-colors disabled:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saveMut.isPending}
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
                disabled={refining || character.source_book_ids.length === 0}
                title="Read more of the source books and review this sheet against all the evidence"
                className="flex gap-2 items-center rounded-lg cursor-pointer bg-card hover:bg-highlight hover:text-background px-4 py-2.5 text-sm font-medium transition-colors disabled:bg-muted disabled:cursor-not-allowed disabled:text-foreground"
              >
                <SparklesIcon /> {refining ? "Refining…" : "Refine"}
              </button>
              <button
                type="button"
                onClick={() => setDraft(structuredClone(character))}
                disabled={refining}
                className="flex gap-2 items-center rounded-lg cursor-pointer bg-card hover:bg-highlight hover:text-background px-4 py-2.5 text-sm font-medium transition-colors disabled:bg-muted disabled:cursor-not-allowed disabled:text-foreground"
              >
                <EditIcon/> Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete ${character.name}?`)) deleteMut.mutate();
                }}
                className="flex gap-2 items-center rounded-lg cursor-pointer bg-card hover:bg-red-600 hover:text-red-100 px-4 py-2.5 text-sm font-medium transition-colors disabled:bg-muted"
              >
                <TrashIcon />Delete
              </button>
            </>
          )}
        </div>
      </header>

      {saveMut.isError && <p className="text-sm text-red-400">Couldn&apos;t save, try again.</p>}

      {(refineOpen || refining || refineError) && !editing && (
        <section className="space-y-2 rounded-xl bg-card shadow-sm shadow-border p-4">
          <div>
            <h2 className="text-sm font-bold mb-2">Refine this profile</h2>
            <p className="text-xs text-muted">
              Reads passages earlier passes skipped (the least-covered parts of the story first), adds them to the
              evidence already gathered, and rewrites the sheet from all of it — what recurs across the story leads,
              what only holds for part of it goes to the arc, one-off moments drop out. Fields you edited by hand are
              kept, so lock anything you like before refining. Takes a few minutes.
            </p>
          </div>
          <textarea
            value={refineNotes}
            onChange={(e) => setRefineNotes(e.target.value)}
            disabled={refining}
            rows={2}
            placeholder="Optional notes, e.g. “His cruelty is mostly a mask — weigh the later books more.”"
            className={`${INPUT} resize-none`}
          />

          <div className="flex items-center justify-end">
            <div className="flex gap-2 items-center">
              <button
                type="button"
                onClick={runRefine}
                disabled={refining}
                className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:bg-muted/20 disabled:text-muted"
              >
                {refining ? "Refining…" : "Start"}
              </button>

              {refining && (
                <button
                  type="button"
                  onClick={() => refineAbort.current?.abort()}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-red-600 hover:text-red-100"
                >
                  Cancel
                </button>
              )}

              {!refining && (
                <button
                  type="button"
                  onClick={() => {
                    setRefineOpen(false);
                    setRefineError("");
                  }}
                className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:bg-muted/20 disabled:text-muted"
                >
                  Close
                </button>
              )}

              {refineStatus && (
                <span className="flex items-center gap-2 text-xs text-muted">
                  {refining && (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-highlight" />
                  )}
                  {refineStatus}
                  {refining && ` · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
                </span>
              )}
            </div>
          </div>

          {refineError && (
            <p className="text-sm text-red-400">{refineError}</p>
          )}

          {revisionNotes.length > 0 && (
            <div>
              <p className={LABEL}>What changed</p>
              <ul className="ml-4 list-disc space-y-0.5 text-sm">
                {revisionNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        {/* Sticky from large screens up: on narrow layouts the column stacks above the
            sheet, where pinning it would hide the profile. It scrolls internally when
            the panels outgrow the viewport. */}
        <aside className="space-y-4 self-start lg:sticky lg:top-[68px] lg:max-h-[calc(100vh-5.5rem)] lg:overflow-y-auto">
          <div className="aspect-[2/3] overflow-hidden rounded-xl bg-card shadow-sm shadow-border">
            {character.thumbnail ? (
              <img src={character.thumbnail} alt={character.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted">
                No thumbnail
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-xl bg-card shadow-border shadow-sm p-3 text-xs">
            <p>
              <span className="text-muted">Status: </span>
              <span className={character.status === "complete" ? "text-green-400" : "text-orange-400"}>
                {character.status}
              </span>
            </p>
            {character.model && (
              <p className="truncate">
                <span className="text-muted">Extracted by: </span>
                <span className="">{character.model}</span>
              </p>
            )}

            <div className="flex flex-wrap gap-1.5 items-center">
              <p className="text-muted">Sources:</p>
              <SourceBooks ids={character.source_book_ids} />
            </div>
          </div>

          <EvidencePanel
            evidence={character.evidence}
            locked={character.locked_fields ?? []}
            onUnlock={(field) => unlockMut.mutate((character.locked_fields ?? []).filter((f) => f !== field))}
          />

          <CharacterLists characterId={character.id} />
        </aside>

        <div className="min-w-0 space-y-4">
          {editing && draft ? (
            <>
              <Section title="Identity">
                <Field label="Name" value={draft.name} onChange={(v) => patchDraft({ name: v })} />
                <ListField label="Aliases (one per line)" values={draft.aliases} onChange={(v) => patchDraft({ aliases: v })} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Role" value={draft.role ?? ""} onChange={(v) => patchDraft({ role: v })} />
                  <Field label="Archetype" value={draft.archetype ?? ""} onChange={(v) => patchDraft({ archetype: v })} />
                </div>
                <Field label="One-sentence summary" value={draft.summary ?? ""} onChange={(v) => patchDraft({ summary: v })} rows={2} />
              </Section>

              <Section title="Personality">
                <ListField label="Core traits" values={draft.core_traits} onChange={(v) => patchDraft({ core_traits: v })} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Wants" value={draft.motivations.wants} onChange={(v) => patchDraft({ motivations: { ...draft.motivations, wants: v } })} rows={2} />
                  <Field label="Needs" value={draft.motivations.needs} onChange={(v) => patchDraft({ motivations: { ...draft.motivations, needs: v } })} rows={2} />
                </div>
                <ListField label="Fears" values={draft.fears} onChange={(v) => patchDraft({ fears: v })} />
                <ListField label="Flaws" values={draft.flaws} onChange={(v) => patchDraft({ flaws: v })} />
                <ListField label="Values" values={draft.values} onChange={(v) => patchDraft({ values: v })} />
              </Section>

              <Section title="Voice & mannerisms">
                <Field label="Register" value={draft.voice.tone} onChange={(v) => patchDraft({ voice: { ...draft.voice, tone: v } })} />
                <Field label="Rhythm" value={draft.voice.rhythm} onChange={(v) => patchDraft({ voice: { ...draft.voice, rhythm: v } })} />
                <Field label="Humour" value={draft.voice.humour} onChange={(v) => patchDraft({ voice: { ...draft.voice, humour: v } })} />
                <ListField label="Tells (one per line)" values={draft.voice.tells} onChange={(v) => patchDraft({ voice: { ...draft.voice, tells: v } })} />
                <ListField label="Mannerisms" values={draft.mannerisms} onChange={(v) => patchDraft({ mannerisms: v })} />
              </Section>

              <Section title="Appearance" hint="Only what travels: build, colouring, marks, posture.">
                <Field label="Signature" value={draft.appearance.signature} onChange={(v) => patchDraft({ appearance: { ...draft.appearance, signature: v } })} rows={2} />
                <Field label="Presentation" value={draft.appearance.presentation} onChange={(v) => patchDraft({ appearance: { ...draft.appearance, presentation: v } })} rows={2} />
              </Section>

              <Section title="Relationship patterns" hint="Dynamics they fall into, not the original cast.">
                <div className="space-y-3">
                  {draft.relationships.map((rel, index) => (
                    <div key={index} className="grid grid-cols-[1fr_2fr_auto] items-start gap-2">
                      <input
                        value={rel.dynamic}
                        onChange={(e) => {
                          const next = [...draft.relationships];
                          next[index] = { ...rel, dynamic: e.target.value };
                          patchDraft({ relationships: next });
                        }}
                        placeholder="dynamic"
                        className={INPUT}
                      />
                      <textarea
                        value={rel.behaviour}
                        onChange={(e) => {
                          const next = [...draft.relationships];
                          next[index] = { ...rel, behaviour: e.target.value };
                          patchDraft({ relationships: next });
                        }}
                        rows={2}
                        placeholder="how it shows up"
                        className={`${INPUT} resize-none`}
                      />
                      <button
                        type="button"
                        onClick={() => patchDraft({ relationships: draft.relationships.filter((_, i) => i !== index) })}
                        className="rounded-lg p-3 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-red-600 hover:text-red-100"
                      >
                        <ClearIcon />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => patchDraft({ relationships: [...draft.relationships, { dynamic: "", behaviour: "" }] })}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer bg-background hover:bg-highlight hover:text-background"
                  >
                    ＋Add pattern
                  </button>
                </div>
              </Section>

              <Section title="Backstory & arc">
                <Field label="Formative experience" value={draft.formative_experience ?? ""} onChange={(v) => patchDraft({ formative_experience: v })} rows={4} />
                <Field label="Arc pattern" value={draft.arc_pattern ?? ""} onChange={(v) => patchDraft({ arc_pattern: v })} rows={2} />
              </Section>

              <Section title="Situational anchors" hint="Canon that only makes sense in the original world. Never used in the writing prompt.">
                <ListField label="One per line" values={draft.situational_anchors} onChange={(v) => patchDraft({ situational_anchors: v })} />
              </Section>
            </>
          ) : (
            <>
              <Section title="Summary">
                <Prose text={character.summary} />
              </Section>

              <Section title="Personality">
                <div className="space-y-3">
                  <Chips values={character.core_traits} empty="No traits recorded." />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <p className={LABEL}>Wants</p>
                      <Prose text={character.motivations.wants} />
                    </div>
                    <div>
                      <p className={LABEL}>Needs</p>
                      <Prose text={character.motivations.needs} />
                    </div>
                  </div>
                  {character.fears.length > 0 && (
                    <div>
                      <p className={LABEL}>Fears</p>
                      <Chips values={character.fears} empty="" />
                    </div>
                  )}
                  {character.flaws.length > 0 && (
                    <div>
                      <p className={LABEL}>Flaws</p>
                      <Chips values={character.flaws} empty="" />
                    </div>
                  )}
                  {character.values.length > 0 && (
                    <div>
                      <p className={LABEL}>Values</p>
                      <Chips values={character.values} empty="" />
                    </div>
                  )}
                </div>
              </Section>

              <Section title="Voice & mannerisms">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <p className={LABEL}>Register</p>
                    <Prose text={character.voice.tone} />
                  </div>
                  <div>
                    <p className={LABEL}>Rhythm</p>
                    <Prose text={character.voice.rhythm} />
                  </div>
                  <div>
                    <p className={LABEL}>Humour</p>
                    <Prose text={character.voice.humour} />
                  </div>
                </div>
                {character.voice.tells.length > 0 && (
                  <div>
                    <p className={LABEL}>Tells</p>
                    <ul className="ml-4 list-disc space-y-0.5 text-sm">
                      {character.voice.tells.map((tell) => (
                        <li key={tell}>{tell}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {character.mannerisms.length > 0 && (
                  <div>
                    <p className={LABEL}>Mannerisms</p>
                    <Chips values={character.mannerisms} empty="" />
                  </div>
                )}
              </Section>

              <Section title="Appearance">
                <Prose text={character.appearance.signature} />
                {character.appearance.presentation && (
                  <p className="text-sm text-muted">{character.appearance.presentation}</p>
                )}
              </Section>

              <Section title="Relationship patterns">
                {character.relationships.length === 0 ? (
                  <p className="text-sm italic text-muted">None recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {character.relationships.map((rel, index) => (
                      <li key={index} className="rounded-lg bg-background border border-muted/20 px-3 py-2">
                        <p className="text-sm font-semibold">{rel.dynamic}</p>
                        <p className="text-sm leading-relaxed">{rel.behaviour}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Backstory & arc">
                <Prose text={character.formative_experience} />
                {character.arc_pattern && (
                  <p className="text-sm">
                    <span className={LABEL}>Arc: </span>
                    {character.arc_pattern}
                  </p>
                )}
              </Section>

              {character.situational_anchors.length > 0 && (
                <Section title="Situational anchors" hint="Canon tied to the original world — kept out of the writing prompt.">
                  <Chips values={character.situational_anchors} empty="" />
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
