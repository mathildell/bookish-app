"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import CharacterCard from "@/components/CharacterCard";
import CharacterListSidebar from "@/components/CharacterListSidebar";
import SearchBar from "@/components/SearchBar";
import NavSearchPortal from "@/components/NavSearchPortal";
import Tooltip from "@/components/Tooltip";
import {
  createCharacter,
  createCharacterList,
  deleteCharacter,
  setCharacterListMembers,
  useCharacterLists,
  useCharacters,
} from "@/lib/api";
import { ClearIcon, FolderAdd, ListAdd, SparklesIcon, TrashIcon } from "@/components/icons";

// Round icon buttons of the selection rail — identical to the library's rail.
const ACTION_BTN =
  "flex h-12 w-12 items-center justify-center bg-card shadow-sm shadow-border hover:shadow-md rounded-full text-base leading-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

// The fixed rail floats RAIL_GAP right of the card grid, never closer than RAIL_EDGE
// to the viewport edge. RAIL_WIDTH mirrors the rail's own width (48px chip + px-2).
const RAIL_GAP = 20;
const RAIL_WIDTH = 64;
const RAIL_EDGE = 8;

export default function CharactersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  // Membership filter over a character list — unrelated to book lists.
  const [listId, setListId] = useState<number | null>(null);
  const [role, setRole] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [listMenuOpen, setListMenuOpen] = useState(false);

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
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const clearSelection = useCallback(() => setSelectedIds([]), []);

  const addToList = useMutation({
    mutationFn: ({ id, ids }: { id: number; ids: number[] }) => setCharacterListMembers(id, ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characterLists"] });
      setSelectedIds([]);
      setListMenuOpen(false);
    },
  });

  // Save the selection as a brand-new list, like the library's folder button.
  const saveAsList = useMutation({
    mutationFn: async (ids: number[]) => {
      const list = await createCharacterList("New list");
      return setCharacterListMembers(list.id, ids);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characterLists"] });
      setSelectedIds([]);
    },
  });

  // Mass delete: permanent, so ask first. allSettled keeps one failure from hiding the rest.
  const deleteSelected = useMutation({
    mutationFn: (ids: number[]) => Promise.allSettled(ids.map((id) => deleteCharacter(id))),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      queryClient.invalidateQueries({ queryKey: ["characterLists"] });
      setSelectedIds([]);
    },
  });

  const activeList = lists?.find((l) => l.id === listId);

  const visible = useMemo(() => {
    let all = characters ?? [];
    if (role) all = all.filter((character) => (character.role ?? "") === role);
    if (!activeList) return all;
    const members = new Set(activeList.character_ids);
    return all.filter((character) => members.has(character.id));
  }, [characters, activeList, role]);

  // Roles come from the data (the extractor's vocabulary can grow), taken from the
  // unfiltered set so picking one doesn't empty the dropdown.
  const roles = useMemo(
    () => [...new Set((allCharacters ?? []).map((c) => c.role).filter((r): r is string => Boolean(r)))].sort(),
    [allCharacters]
  );

  const selectedLabel = `${selectedIds.length} character${selectedIds.length !== 1 ? "s" : ""}`;

  // The rail is position: fixed, so measure the grid's right edge.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [railLeft, setRailLeft] = useState<number | null>(null);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const gridRight = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
      setRailLeft(Math.min(gridRight + RAIL_GAP, window.innerWidth - RAIL_WIDTH - RAIL_EDGE));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div className="relative">
      <NavSearchPortal>
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="Search names, archetypes, roles, summaries…"
        />
      </NavSearchPortal>

      <section className="grid grid-cols-[240px_1fr] gap-6">
        {/* Sidebar — sticks below the nav, like the library's filters */}
        <aside
          className="sticky self-start overflow-y-auto pr-2 pb-8 pt-4 space-y-5"
          style={{ top: 65, maxHeight: "calc(100vh - 77px)" }}
        >
          <section>
            <p className="text-xs font-semibold uppercase text-muted mb-1">Characters</p>
            <p className="text-xs text-muted mb-2">
              {isLoading ? "Loading…" : `${visible.length} character${visible.length === 1 ? "" : "s"}`}
            </p>
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="w-full rounded-md px-3 py-2 text-sm font-semibold bg-card shadow-sm shadow-border cursor-pointer transition-colors hover:bg-highlight hover:text-background disabled:opacity-50"
            >
              + New profile
            </button>
          </section>

          <section>
            <label className="text-xs font-semibold uppercase text-muted mb-1 block">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-md px-3 py-2 text-sm capitalize bg-card shadow-sm shadow-border focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">All roles</option>
              {roles.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </section>

          <CharacterListSidebar
            characters={allCharacters ?? []}
            activeListId={listId}
            onPick={setListId}
          />
        </aside>

        <div ref={gridRef} className="min-w-0 pb-16 pl-1 pr-8 pt-6">
          {isError && (
            <div className="py-12 text-center text-red-500">
              Couldn&apos;t load character profiles. Is the API running?
            </div>
          )}

          {!isError && !isLoading && visible.length === 0 && (
            <div className="space-y-3 py-20 text-center text-muted">
              <p className="text-4xl">👥</p>
              {activeList ? (
                <>
                  <p className="text-sm">Nobody in &quot;{activeList.name}&quot; yet.</p>
                  <p className="text-xs">
                    Open a character and tick this list in their sidebar, or select several here
                    and add them to it.
                  </p>
                  <button
                    type="button"
                    onClick={() => setListId(null)}
                    className="text-xs text-foreground hover:text-highlight cursor-pointer"
                  >
                    Show all characters
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm">
                    {query || role
                      ? "No profiles match those filters."
                      : "No character profiles yet. Extract them from your indexed books to get started."}
                  </p>
                  <Link href="/" className="inline-block text-xs text-foreground hover:text-highlight">
                    ← Back to the library
                  </Link>
                </>
              )}
            </div>
          )}

          {visible.length > 0 && (
            <div className="flex flex-wrap gap-4 pb-8">
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

      {/* Selection rail — same floating column of round buttons as the library. */}
      {selectedIds.length > 0 && (
        <aside className="fixed top-1/2 z-[55] -translate-y-1/2" style={{ left: railLeft ?? undefined }}>
          <div className="flex flex-col items-center gap-2.5 rounded-xl bg-background/50 px-2 py-4 shadow-sm shadow-border backdrop-blur-md">
            <Tooltip label={`Write a scene with ${selectedLabel}`} placement="left">
              <Link
                href={{ pathname: "/write", query: { chars: selectedIds.join(",") } }}
                aria-label={`Write a scene with ${selectedLabel}`}
                className={`${ACTION_BTN} hover:bg-highlight hover:text-background cursor-pointer`}
              >
                <SparklesIcon className="h-6 w-6" />
              </Link>
            </Tooltip>

            <div className="relative">
              <Tooltip
                label={lists && lists.length > 0 ? `Add ${selectedLabel} to a list` : "No lists yet"}
                placement="left"
              >
                <button
                  type="button"
                  onClick={() => setListMenuOpen((open) => !open)}
                  disabled={!lists || lists.length === 0 || addToList.isPending}
                  aria-label={`Add ${selectedLabel} to a list`}
                  aria-expanded={listMenuOpen}
                  aria-haspopup="menu"
                  className={`${ACTION_BTN} bg-green-500/60 hover:bg-green-500 text-white cursor-pointer`}
                >
                  <ListAdd />
                </button>
              </Tooltip>

              {listMenuOpen && (
                <>
                  <button
                    type="button"
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={() => setListMenuOpen(false)}
                    className="fixed inset-0 z-[55]"
                  />
                  <div
                    role="menu"
                    aria-label={`Add ${selectedLabel} to a list`}
                    className="absolute right-full top-0 z-[60] mr-2 w-60 overflow-y-auto rounded-lg shadow-sm shadow-border bg-card p-1"
                    style={{ maxHeight: "min(60vh, 20rem)" }}
                  >
                    <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted">
                      Add to list
                    </p>
                    <div className="divide-y divide-muted/20 mx-1">
                      {lists?.map((list) => (
                        <button
                          key={list.id}
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            addToList.mutate({
                              id: list.id,
                              ids: [...new Set([...list.character_ids, ...selectedIds])],
                            })
                          }
                          className="cursor-pointer rounded-md flex w-full items-center justify-between gap-2 py-1.5 px-1 text-left text-xs transition-colors text-foreground hover:bg-highlight hover:text-background"
                        >
                          <span className="truncate">{list.name}</span>
                          <span className="tabular-nums text-muted">{list.character_ids.length}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            <Tooltip label="Save selection as a new list" placement="left">
              <button
                type="button"
                onClick={() => saveAsList.mutate(selectedIds)}
                disabled={saveAsList.isPending}
                aria-label="Save selection as a new list"
                className={`${ACTION_BTN} hover:bg-highlight hover:text-background cursor-pointer`}
              >
                <FolderAdd />
              </button>
            </Tooltip>

            <Tooltip label={`Delete ${selectedLabel}`} placement="left">
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Permanently delete ${selectedLabel}? This cannot be undone.`)) {
                    deleteSelected.mutate(selectedIds);
                  }
                }}
                disabled={deleteSelected.isPending}
                aria-label={`Delete ${selectedLabel}`}
                className={`${ACTION_BTN} bg-red-500/60 hover:bg-red-500 text-white cursor-pointer`}
              >
                <TrashIcon className="h-6 w-6" />
              </button>
            </Tooltip>

            <div className="my-1.5 h-px w-8 bg-border" />

            <Tooltip label="Clear selection" placement="left">
              <button
                type="button"
                onClick={clearSelection}
                aria-label="Clear selection"
                className={`${ACTION_BTN} hover:bg-highlight hover:text-background cursor-pointer`}
              >
                <ClearIcon className="w-4.5 h-4.5 mt-1 ml-0.5" />
              </button>
            </Tooltip>
          </div>
        </aside>
      )}
    </div>
  );
}
