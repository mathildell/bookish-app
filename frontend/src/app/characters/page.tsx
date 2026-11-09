"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import CharacterCard from "@/components/CharacterCard";
import CharacterListSidebar from "@/components/CharacterListSidebar";
import SearchBar from "@/components/SearchBar";
import Tooltip from "@/components/Tooltip";
import {
  createCharacter,
  setCharacterListMembers,
  useCharacterLists,
  useCharacters,
} from "@/lib/api";

// Height of the sticky nav (h-14 + pt-2 + 1px border) — the header sticks just below it.
const NAV_HEIGHT = 65;

// Icon-only buttons in the selection toolbar; each button's tooltip carries its wording.
const ACTION_BTN =
  "flex h-9 w-9 items-center justify-center rounded-lg text-base leading-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

export default function CharactersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  // Membership filter over a character list — unrelated to book lists.
  const [listId, setListId] = useState<number | null>(null);

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [targetListId, setTargetListId] = useState<number | null>(null);
  const [addedTo, setAddedTo] = useState<string | null>(null);

  const { data: characters, isLoading, isError } = useCharacters(query || undefined);
  // Unfiltered set: sidebar counts describe the whole library, not the current search.
  const { data: allCharacters } = useCharacters();
  const { data: lists } = useCharacterLists();

  const createMut = useMutation({
    mutationFn: () => createCharacter({ name: "New character" }),
    onSuccess: (character) => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      router.push(`/characters/${character.id}`);
    },
  });

  const toggleSelect = useCallback((id: number) => {
    setAddedTo(null);
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const addToList = useMutation({
    mutationFn: ({ id, ids }: { id: number; ids: number[] }) =>
      setCharacterListMembers(id, ids),
    onSuccess: (list) => {
      queryClient.invalidateQueries({ queryKey: ["characterLists"] });
      setAddedTo(list.name);
      setSelectedIds([]);
      setTargetListId(null);
    },
  });

  const activeList = lists?.find((l) => l.id === listId);

  const visible = useMemo(() => {
    const all = characters ?? [];
    if (!activeList) return all;
    const members = new Set(activeList.character_ids);
    return all.filter((character) => members.has(character.id));
  }, [characters, activeList]);

  const selectedLabel = `${selectedIds.length} character${selectedIds.length !== 1 ? "s" : ""}`;

  const activeBadge = activeList ? (
    <span className="flex items-center gap-2 whitespace-nowrap rounded-full bg-yellow-900/30 px-2.5 py-1 text-xs text-yellow-300">
      🎭 &quot;{activeList.name}&quot; ({activeList.character_ids.length})
      <button
        type="button"
        onClick={() => setListId(null)}
        aria-label="Clear list filter"
        className="text-sm font-bold leading-none text-zinc-400 hover:text-red-400"
      >
        ✕
      </button>
    </span>
  ) : null;

  // Track the header's height so the sidebar can stick right under it, exactly as the
  // library page does.
  const headerRef = useRef<HTMLElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setHeaderHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const stickyOffset = NAV_HEIGHT + headerHeight;

  return (
    <div className="relative">
      <header
        ref={headerRef}
        className="sticky top-[65px] z-[50] border-b border-zinc-800 bg-background pr-6"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-4 pb-3 pt-5 mb-2">
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder="Search names, archetypes, roles, summaries…"
          />

          {!isLoading && (
            <span className="whitespace-nowrap text-xs text-zinc-500">
              {visible.length} character{visible.length === 1 ? "" : "s"}
            </span>
          )}

          {activeBadge}

          {selectedIds.length > 0 ? (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Tooltip label={`Write a scene with ${selectedLabel}`} align="right">
                <Link
                  href={{ pathname: "/write", query: { chars: selectedIds.join(",") } }}
                  aria-label={`Write a scene with ${selectedLabel}`}
                  className={`${ACTION_BTN} bg-yellow-600 text-zinc-900 hover:bg-yellow-500`}
                >
                  ✍️
                </Link>
              </Tooltip>

              {lists && lists.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <select
                    value={targetListId ?? ""}
                    onChange={(e) => setTargetListId(e.target.value ? Number(e.target.value) : null)}
                    className="h-9 appearance-auto rounded-lg border border-zinc-600 bg-zinc-800 px-2 text-sm font-semibold text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  >
                    <option value="">+ Add to list…</option>
                    {(lists ?? []).map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                  </select>
                  <Tooltip label={`Add ${selectedLabel} to the chosen list`} align="right">
                    <button
                      type="button"
                      aria-label={`Add ${selectedLabel} to the chosen list`}
                      disabled={!targetListId || addToList.isPending}
                      onClick={() => {
                        const list = lists?.find((l) => l.id === targetListId);
                        if (!list) return;
                        addToList.mutate({
                          id: list.id,
                          ids: [...new Set([...list.character_ids, ...selectedIds])],
                        });
                      }}
                      className={`${ACTION_BTN} bg-zinc-700 text-zinc-100 hover:bg-zinc-600`}
                    >
                      ✓
                    </button>
                  </Tooltip>
                </div>
              )}

              <Tooltip label="Clear selection" align="right">
                <button
                  type="button"
                  onClick={() => setSelectedIds([])}
                  aria-label="Clear selection"
                  className={`${ACTION_BTN} border border-zinc-700/60 bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100`}
                >
                  ✕
                </button>
              </Tooltip>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="ml-auto rounded-lg bg-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              ＋ New profile
            </button>
          )}
        </div>

        {addedTo && (
          <p className="pb-2 text-[11px] text-green-400">
            Added to &quot;{addedTo}&quot;
          </p>
        )}

        {/* Content scrolls beneath the header's border */}
        <div className="absolute left-0 right-0 bottom-0 h-[1px]" />
      </header>

      <section className="grid grid-cols-[240px_1fr] gap-6">
        {/* Sidebar — sticks below the header, like the library's filters */}
        <aside
          className="sticky self-start overflow-y-auto pr-2 pb-8 pt-4"
          style={{ top: stickyOffset, maxHeight: `calc(100vh - ${stickyOffset + 12}px)` }}
        >
          <CharacterListSidebar
            characters={allCharacters ?? []}
            activeListId={listId}
            onPick={setListId}
          />
        </aside>

        <div className="min-w-0 pb-16 pt-6 pl-1">
          {isError && (
            <div className="py-12 text-center text-red-400">
              Couldn&apos;t load character profiles. Is the API running?
            </div>
          )}

          {!isError && !isLoading && visible.length === 0 && (
            <div className="space-y-3 py-20 text-center text-zinc-500">
              <p className="text-4xl">👥</p>
              {activeList ? (
                <>
                  <p className="text-sm">Nobody in &quot;{activeList.name}&quot; yet.</p>
                  <p className="text-xs text-zinc-600">
                    Open a character and tick this list in their sidebar, or select several here
                    and add them to it.
                  </p>
                  <button
                    type="button"
                    onClick={() => setListId(null)}
                    className="text-xs text-yellow-500 hover:text-yellow-400"
                  >
                    Show all characters
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm">
                    {query
                      ? "No profiles match that search."
                      : "No character profiles yet. Extract them from your indexed books to get started."}
                  </p>
                  <Link href="/" className="inline-block text-xs text-yellow-500 hover:text-yellow-400">
                    ← Back to the library
                  </Link>
                </>
              )}
            </div>
          )}

          {visible.length > 0 && (
            <div className="flex flex-wrap justify-center gap-4 pb-8">
              {visible.map((character) => (
                <CharacterCard
                  key={character.id}
                  character={character}
                  selected={selectedIds.includes(character.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
