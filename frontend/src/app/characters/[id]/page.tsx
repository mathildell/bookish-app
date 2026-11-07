"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteCharacter,
  fetchBook,
  fetchCharacter,
  setCharacterListMembers,
  updateCharacter,
  useCharacterLists,
} from "@/lib/api";
import type { Character, CharacterInput } from "@/types/character";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const INPUT =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40";

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
    return <p className="italic text-zinc-600">None yet</p>;
  }

  const books = data ?? ids.map((id) => ({ id, title: `#${id}` }));

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {books.map(({ id, title }) => (
        <Link
          key={id}
          href={`/book/${id}`}
          title={`Calibre #${id}`}
          className="max-w-full truncate rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:text-white"
        >
          📖 {title}
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
      <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] text-zinc-400">
        <p className="text-zinc-500">Lists:</p>
        <p className="italic text-zinc-600">No character lists yet — create one on the Characters page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] text-zinc-400">
      <p className="text-zinc-500">Lists:</p>
      {lists.map((list) => {
        const member = list.character_ids.includes(characterId);
        return (
          <label key={list.id} className="flex items-center gap-2 text-zinc-300">
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
              className="accent-yellow-500"
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
    <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div>
        <h2 className="text-sm font-bold text-zinc-200">{title}</h2>
        {hint && <p className="text-[11px] text-zinc-500">{hint}</p>}
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
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className={`${INPUT} resize-y`} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className={INPUT} />
      )}
    </label>
  );
}

/** One line per entry; blank lines are dropped on save. */
function ListField({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  return (
    <label className="block space-y-1">
      <span className={LABEL}>{label}</span>
      <textarea
        value={toLines(values)}
        onChange={(e) => onChange(fromLines(e.target.value))}
        rows={Math.min(8, Math.max(2, values.length + 1))}
        className={`${INPUT} resize-y`}
      />
    </label>
  );
}

function Prose({ text }: { text?: string | null }) {
  if (!text) return <p className="text-sm italic text-zinc-600">Not filled in.</p>;
  return <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{text}</p>;
}

function Chips({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <p className="text-sm italic text-zinc-600">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span key={value} className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[11px] text-zinc-300">
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

  const deleteMut = useMutation({
    mutationFn: () => deleteCharacter(characterId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      router.push("/characters");
    },
  });

  if (isLoading) return <div className="py-8 text-zinc-500">Loading profile…</div>;
  if (isError || !character) {
    return (
      <div className="space-y-3 py-16 text-center text-zinc-500">
        <p>That character doesn&apos;t exist (it may have been merged away).</p>
        <Link href="/characters" className="text-yellow-500 hover:text-yellow-400">
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
    const { id: _id, created_at: _created, updated_at: _updated, ...patch } = draft;
    saveMut.mutate(patch);
  };

  return (
    <div className="space-y-6 pt-5 pb-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/characters" className="text-xs text-zinc-500 hover:text-yellow-400">
            ← All characters
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{character.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
            {character.role && <span className="capitalize">{character.role}</span>}
            {character.archetype && <span className="text-yellow-500/90">· {character.archetype}</span>}
            {character.aliases.length > 0 && <span>· also: {character.aliases.join(", ")}</span>}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saveMut.isPending}
                className="rounded-lg bg-yellow-600 px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-yellow-500 disabled:opacity-50"
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setDraft(structuredClone(character))}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-700"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete ${character.name}?`)) deleteMut.mutate();
                }}
                className="rounded-lg bg-red-900/50 px-3 py-2 text-sm font-semibold text-red-200 hover:bg-red-800/70"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </header>

      {saveMut.isError && <p className="text-sm text-red-400">Couldn&apos;t save — try again.</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="space-y-4">
          <div className="aspect-[2/3] overflow-hidden rounded-xl bg-zinc-800">
            {character.thumbnail ? (
              <img src={character.thumbnail} alt={character.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-zinc-600">
                No thumbnail
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] text-zinc-400">
            <p>
              <span className="text-zinc-500">Status: </span>
              <span className={character.status === "complete" ? "text-green-400" : "text-yellow-400"}>
                {character.status}
              </span>
            </p>
            {character.model && (
              <p className="truncate">
                <span className="text-zinc-500">Extracted by: </span>
                {character.model}
              </p>
            )}
            <div>
              <p className="text-zinc-500">Sources:</p>
              <SourceBooks ids={character.source_book_ids} />
            </div>
          </div>

          <CharacterLists characterId={character.id} />
        </aside>

        <div className="min-w-0 space-y-4">
          {editing && draft ? (
            <>
              <Section title="Identity">
                <Field label="Name" value={draft.name} onChange={(v) => patchDraft({ name: v })} />
                <Field label="Aliases (one per line)" value={toLines(draft.aliases)} onChange={(v) => patchDraft({ aliases: fromLines(v) })} rows={2} />
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
                        className={`${INPUT} resize-y`}
                      />
                      <button
                        type="button"
                        onClick={() => patchDraft({ relationships: draft.relationships.filter((_, i) => i !== index) })}
                        className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => patchDraft({ relationships: [...draft.relationships, { dynamic: "", behaviour: "" }] })}
                    className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
                  >
                    ＋ Add pattern
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
                    <ul className="ml-4 list-disc space-y-0.5 text-sm text-zinc-300">
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
                  <p className="text-sm text-zinc-400">{character.appearance.presentation}</p>
                )}
              </Section>

              <Section title="Relationship patterns">
                {character.relationships.length === 0 ? (
                  <p className="text-sm italic text-zinc-600">None recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {character.relationships.map((rel, index) => (
                      <li key={index} className="rounded-lg bg-zinc-950/40 px-3 py-2">
                        <p className="text-sm font-semibold text-yellow-400/90">{rel.dynamic}</p>
                        <p className="text-sm leading-relaxed text-zinc-300">{rel.behaviour}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Backstory & arc">
                <Prose text={character.formative_experience} />
                {character.arc_pattern && (
                  <p className="text-sm text-zinc-400">
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
