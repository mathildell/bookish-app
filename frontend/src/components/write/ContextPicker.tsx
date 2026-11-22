"use client";

import { useEffect, useMemo, useState } from "react";
import WorldImage from "@/components/WorldImage";
import { CheckIcon, ClearIcon } from "@/components/icons";
import { bookmarkNoteText, useCharacterLists } from "@/lib/api";
import { initials } from "@/lib/format";
import { bookmarkKind } from "./NotesPanel";
import { useWriteSession } from "./session";

type PickerTab = "characters" | "worlds" | "bookmarks";

/** A 2:3 tile, the same shape as the Characters page cards, with a check when chosen. */
function PickTile({
  label,
  hint,
  selected,
  onToggle,
  children,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      title={hint ?? label}
      className={`group relative aspect-[2/3] cursor-pointer overflow-hidden rounded-xl bg-background shadow-sm shadow-border transition-shadow hover:shadow-lg hover:shadow-black/50 ${
        selected ? "ring-2 ring-accent" : ""
      }`}
    >
      {children}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6 text-left">
        <p className="line-clamp-2 text-xs font-semibold leading-tight text-white">{label}</p>
      </div>
      <span
        className={`absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border shadow-xs shadow-black/60 transition-all ${
          selected ? "border-accent bg-highlight/90" : "border-border bg-card/80 group-hover:bg-card"
        }`}
      >
        <CheckIcon className={selected ? "p-0.5 text-accent" : "text-transparent"} />
      </span>
    </button>
  );
}

/**
 * Add characters, worlds and pinned bookmarks to the story's context. One place, three
 * tabs of the same kind of tile, replacing the accordions the sidebar used to carry.
 */
export default function ContextPicker() {
  const {
    picker, closePicker, characters, worlds, castIds, worldIds, toggleCast, toggleWorld, setCastIds,
    bookmarks, setBookmarkPinned,
  } = useWriteSession();
  const { data: lists } = useCharacterLists();
  const [tab, setTab] = useState<PickerTab>("characters");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Open on whichever tab the caller asked for, with a fresh search.
  useEffect(() => {
    if (picker.open) {
      setTab(picker.tab);
      setQuery("");
      setError(null);
    }
  }, [picker.open, picker.tab]);

  useEffect(() => {
    if (!picker.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePicker();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker.open, closePicker]);

  const q = query.trim().toLowerCase();
  const shownCharacters = useMemo(
    () =>
      (characters ?? []).filter(
        (c) => !q || c.name.toLowerCase().includes(q) || (c.archetype ?? "").toLowerCase().includes(q)
      ),
    [characters, q]
  );
  const shownWorlds = useMemo(
    () => (worlds ?? []).filter((w) => !q || w.name.toLowerCase().includes(q) || (w.premise ?? "").toLowerCase().includes(q)),
    [worlds, q]
  );
  const shownBookmarks = useMemo(
    () =>
      (bookmarks ?? []).filter(
        (b) => !q || `${b.question} ${b.answer} ${b.note ?? ""}`.toLowerCase().includes(q)
      ),
    [bookmarks, q]
  );

  if (!picker.open) return null;

  const tabs: { id: PickerTab; label: string; count: number }[] = [
    { id: "characters", label: "Characters", count: castIds.length },
    { id: "worlds", label: "Worlds", count: worldIds.length },
    { id: "bookmarks", label: "Bookmarks", count: (bookmarks ?? []).filter((b) => b.pinned).length },
  ];

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && closePicker()}
      role="dialog"
      aria-modal="true"
      aria-label="Add to the story's context"
    >
      <div className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-card shadow-lg shadow-black/50">
        <div className="flex flex-wrap items-center gap-3 border-b border-background px-4 py-3">
          <div role="tablist" className="flex rounded-lg bg-background p-0.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setQuery("");
                }}
                className={`cursor-pointer rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                  tab === t.id ? "bg-accent/30 text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                {t.label}
                {t.count ? ` (${t.count})` : ""}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab}…`}
            autoFocus
            className="min-w-0 flex-1 rounded-lg bg-background px-3 py-1.5 text-sm placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            onClick={closePicker}
            className="cursor-pointer rounded-lg bg-background px-4 py-1.5 text-xs font-semibold transition-colors hover:bg-highlight hover:text-background"
          >
            Done
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === "characters" && (
            <div className="space-y-4">
              {(lists ?? []).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Add a whole cast</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(lists ?? []).map((list) => (
                      <button
                        key={list.id}
                        type="button"
                        onClick={() => setCastIds([...new Set([...castIds, ...list.character_ids])])}
                        disabled={list.character_ids.length === 0}
                        className="cursor-pointer rounded-full border border-background px-3 py-1 text-xs transition-colors hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {list.name} <span className="text-muted">({list.character_ids.length})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))]">
                {shownCharacters.map((c) => (
                  <PickTile
                    key={c.id}
                    label={c.name}
                    hint={c.summary ?? c.name}
                    selected={castIds.includes(c.id)}
                    onToggle={() => toggleCast(c.id)}
                  >
                    {c.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.thumbnail} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-2xl font-black text-muted">
                        {initials(c.name)}
                      </div>
                    )}
                  </PickTile>
                ))}
              </div>
              {characters && shownCharacters.length === 0 && (
                <p className="text-sm text-muted">No characters match.</p>
              )}
            </div>
          )}

          {tab === "worlds" && (
            <div className="space-y-3">
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))]">
                {shownWorlds.map((w) => (
                  <PickTile
                    key={w.id}
                    label={w.name}
                    hint={w.premise ?? w.name}
                    selected={worldIds.includes(w.id)}
                    onToggle={() => toggleWorld(w.id)}
                  >
                    <WorldImage world={w} />
                  </PickTile>
                ))}
              </div>
              {worlds && shownWorlds.length === 0 && (
                <p className="text-sm text-muted">
                  {worlds.length === 0
                    ? "No worlds yet. Extract one from your books on the Worlds page."
                    : "No worlds match."}
                </p>
              )}
            </div>
          )}

          {tab === "bookmarks" && (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Pinned bookmarks reach the model as established canon. Pin a saved scene, discussion or answer.
              </p>
              <ul className="space-y-1.5">
                {shownBookmarks.map((b) => (
                  <li key={b.id} className="flex items-start gap-3 rounded-lg bg-background px-3 py-2">
                    <div className="min-w-0 flex-1 text-xs leading-snug">
                      <p className="text-muted">
                        {bookmarkKind(b)}
                        {b.question ? ` · ${b.question.slice(0, 80)}` : ""}
                      </p>
                      <p className="mt-0.5 line-clamp-3">{bookmarkNoteText(b, 300)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setBookmarkPinned(b, !b.pinned).catch(() => setError("Couldn't update that bookmark"))}
                      aria-pressed={Boolean(b.pinned)}
                      className={`flex-none cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors ${
                        b.pinned
                          ? "border-accent bg-accent/20"
                          : "border-border text-muted hover:border-accent hover:text-foreground"
                      }`}
                    >
                      {b.pinned ? (
                        <span className="flex items-center gap-1">
                          Pinned <ClearIcon />
                        </span>
                      ) : (
                        "Pin"
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {bookmarks && shownBookmarks.length === 0 && (
                <p className="text-sm text-muted">
                  {bookmarks.length === 0 ? "No bookmarks saved yet." : "No bookmarks match."}
                </p>
              )}
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
