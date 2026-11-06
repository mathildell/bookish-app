"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import BookGrid from "@/components/BookGrid";
import SearchBar from "@/components/SearchBar";
import FilterSidebar from "@/components/FilterSidebar";
import type { Filters } from "@/components/FilterSidebar";
import Link from "next/link";
import { batchIndexBooks, createList, setListBooks, unindexBook, useBookLists, type BatchIndexEvent } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";

// Height of the sticky nav (h-14 + pt-2 + 1px border) — the header sticks just below it.
const NAV_HEIGHT = 65;

type BatchProgress = {
  running: boolean;
  current: string;
  done: number;
  errors: { title: string; error: string }[];
  total: number;
};

export default function LibraryPage() {
  const queryClient = useQueryClient();
  const { data: lists, refetch: refetchLists } = useBookLists();

  const [filters, setFilters] = useState<Filters>({
    query: "",
    status: null,
    indexed: null,
    sort: "date_added_desc",
    listId: null,
  });

  const totalRef = useRef(0);
  const indexedRef = useRef(0);
  const indexedUnknownRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [indexingId, setIndexingId] = useState<number | null>(null);
  const [progressKind, setProgressKind] = useState<"index" | "unindex" | null>(null);
  // Filled by the grid: title + indexed flag for every loaded book, so the toolbar can
  // tell which selected books are already indexed.
  const bookMetaRef = useRef<Record<number, { title: string; indexed: boolean }>>({});
  const [progress, setProgress] = useState<BatchProgress>({
    running: false,
    current: "",
    done: 0,
    errors: [],
    total: 0,
  });

  // ── target-list state (decoupled from filter) ────────────────
  const [targetListId, setTargetListId] = useState<number | null>(null);
  const activeList = lists?.find((l) => l.id === filters.listId);
  const targetList = lists?.find((l) => l.id === targetListId);

  // Mutate a list's book_ids by ID
  // The grid is filtered by the same list, so its cached pages are stale after a change.
  const mutateBooks = useMutation({
    mutationFn: ({ listId, ids }: { listId: number; ids: number[] }) => setListBooks(listId, ids),
    onSuccess: () => {
      refetchLists();
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });

  // Add selected books to the target list (or active filter list as fallback)
  const _destinationList = targetList || activeList;

  const handleAddToList = useCallback(() => {
    if (!_destinationList || selectedIds.length === 0) return;
    mutateBooks.mutate({
      listId: _destinationList.id,
      ids: [...new Set([..._destinationList.book_ids, ...selectedIds])],
    });
    setSelectedIds([]);
    if (targetListId) setTargetListId(null);
  }, [selectedIds, _destinationList, mutateBooks]);

  // Remove selected books from the active list (keep list >=1 book so users can't destroy lists by accident)
  const handleRemoveFromList = useCallback(() => {
    if (!activeList || selectedIds.length === 0 || (activeList.book_ids.length - selectedIds.length) < 1) return;
    mutateBooks.mutate({
      listId: filters.listId!,
      ids: activeList.book_ids.filter((id) => !selectedIds.includes(id)),
    });
    setSelectedIds([]);
  }, [selectedIds, activeList, filters.listId, mutateBooks]);

  // Save selection as a new list
  const createMutate = useMutation({
    mutationFn: async ({ bookIds }: { bookIds: number[] }) => {
      const newList = await createList("New list");
      return setListBooks(newList.id, bookIds);
    },
    onSuccess: () => {
      refetchLists();
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["bookLists"] });
    },
  });

  const handleSaveAsNewList = useCallback(() => {
    if (selectedIds.length === 0) return;
    createMutate.mutate({ bookIds: [...selectedIds] });
  }, [selectedIds, createMutate]);

  // ── batch index flow ─────────────────────────────────────────
  const handleBatchIndex = useCallback(async () => {
    if (selectedIds.length === 0) return;
    const ids = [...selectedIds];

    setProgress({ running: true, current: "Starting…", done: 0, errors: [], total: ids.length });
    setProgressKind("index");
    setIndexingId(null);

    // Ends the run in the UI and refreshes the grid so cards show their new state.
    const finish = (message?: string) => {
      setIndexingId(null);
      setProgressKind(null);
      setProgress((p) => ({
        ...p,
        running: false,
        current:
          message ??
          `Done — ${p.done - p.errors.length} indexed${p.errors.length ? `, ${p.errors.length} error${p.errors.length > 1 ? "s" : ""}` : ""}`,
      }));
      queryClient.invalidateQueries({ queryKey: ["books"] });
    };

    try {
      for await (const event of batchIndexBooks(ids)) {
        if (event.kind === "done") {
          finish();
          setSelectedIds([]);
          return;
        }

        if (event.kind === "started") setIndexingId(event.id);

        setProgress((p) => {
          const updated = { ...p };
          switch (event.kind) {
            case "started":
              updated.current = `Indexing: ${event.title}…`;
              break;
            case "ok":
              updated.done += 1;
              updated.current = `${event.title} ✓ (${event.chunks} chunks)`;
              break;
            case "error":
              updated.errors = [...p.errors, { title: event.title, error: event.errors?.[0] ?? "unknown" }];
              updated.done += 1;
              break;
            case "skipped":
              updated.done += 1;
              updated.current = `#${event.id}: ${event.reason}`;
              break;
          }
          return updated;
        });
      }

      // The stream can end without a final "done" event (e.g. server error) — don't stay stuck.
      finish("Stream ended before every book was processed");
    } catch (err) {
      finish(err instanceof Error ? err.message : "Batch indexing failed");
    }
  }, [selectedIds, queryClient]);

  const handleBatchUnindex = useCallback(async () => {
    const ids = selectedIds.filter((id) => bookMetaRef.current[id]?.indexed);
    if (ids.length === 0) return;

    setProgress({ running: true, current: "Starting…", done: 0, errors: [], total: ids.length });
    setProgressKind("unindex");
    setIndexingId(null);

    let done = 0;
    const failures: { title: string; error: string }[] = [];

    for (const id of ids) {
      const title = bookMetaRef.current[id]?.title ?? `#${id}`;
      setIndexingId(id);
      setProgress((p) => ({ ...p, current: `Removing: ${title}…` }));
      try {
        await unindexBook(id);
        setProgress((p) => ({ ...p, done: p.done + 1, current: `${title} ✓ removed` }));
      } catch (err) {
        const failure = { title, error: err instanceof Error ? err.message : "failed" };
        failures.push(failure);
        setProgress((p) => ({ ...p, done: p.done + 1, errors: [...p.errors, failure] }));
      }
      done += 1;
    }

    setIndexingId(null);
    setProgressKind(null);
    setProgress((p) => ({
      ...p,
      running: false,
      done,
      current: `Done — ${done - failures.length} removed${failures.length ? `, ${failures.length} error${failures.length > 1 ? "s" : ""}` : ""}`,
    }));
    setSelectedIds([]);
    queryClient.invalidateQueries({ queryKey: ["books"] });
  }, [selectedIds, queryClient]);

  const clearListFilter = useCallback(() => setFilters((f) => ({ ...f, listId: null })), []);
  const toggleSelect = useCallback((id: number) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]), []);
  const clearSelection = useCallback(() => setSelectedIds([]), []);

  // Track the header's height so the sidebar can stick right under it (it grows when
  // the selection actions wrap or the batch progress panel appears).
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

  // Split the selection by index state so the toolbar offers the right action.
  const selectedIndexed = selectedIds.filter((id) => bookMetaRef.current[id]?.indexed);
  const selectedUnindexed = selectedIds.filter((id) => !bookMetaRef.current[id]?.indexed);

  // Active list badge showing count + name when list filter is applied
  const activeBadge = activeList ? (
    <span className="text-xs bg-yellow-900/30 text-yellow-300 px-2.5 py-1 rounded-full whitespace-nowrap flex items-center gap-2">
      📋 "{activeList.name}" ({activeList.book_ids.length})
      <button onClick={clearListFilter} className="text-zinc-400 hover:text-red-400 text-sm leading-none font-bold">✕</button>
    </span>
  ) : null;

  // The page scrolls normally (document-level scrollbar); the header sticks under the
  // nav and the sidebar sticks under the header.
  const stickyOffset = NAV_HEIGHT + headerHeight;
  return (
    <div className="relative">
      <header ref={headerRef} className="sticky top-[65px] z-[50] border-b border-zinc-800 bg-[#0a0a0f] pr-6">
        <div className="flex items-center gap-4 flex-wrap pt-5 pb-3 mb-2 min-w-0">
          <SearchBar
            value={filters.query}
            onChange={(query) => setFilters((f) => ({ ...f, query }))}
            placeholder="Search titles, authors, series, tags… (live)"
          />
          {totalRef.current > 0 && (
            <span className="text-xs text-zinc-500 whitespace-nowrap">
              {totalRef.current} books matched{indexedUnknownRef.current ? ' (index status unavailable)' : indexedRef.current > 0 && indexedRef.current < totalRef.current ? ` · ${indexedRef.current} indexed` : ''}
            </span>
          )}

          {/* Active list filter */}
          {activeBadge}

          {/* Selected books action buttons */}
          {selectedIds.length > 0 && (
            <>
              <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                {/* Chat button */}
                <Link
                  href={{ pathname: "/chat", query: { ids: selectedIds.join(",") } }}
                  className="bg-yellow-600 hover:bg-yellow-500 text-zinc-900 font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
                >
                  💬 Chat with {selectedIds.length} book{selectedIds.length > 1 ? "s" : ""}
                </Link>

                {/* Index only the selected books that are not indexed yet */}
                {selectedUnindexed.length > 0 && (
                  <button
                    onClick={handleBatchIndex}
                    disabled={progress.running || selectedIds.length < 2}
                    className={`font-semibold px-4 py-2 rounded-lg text-sm transition-colors ${
                      progress.running
                        ? "bg-zinc-600 text-zinc-400 cursor-not-allowed"
                        : "bg-green-700 hover:bg-green-600 text-white"
                    }`}
                  >
                    {progress.running && progressKind === "index"
                      ? `Indexing… (${progress.done}/${progress.total})`
                      : `Index ${selectedUnindexed.length} book${selectedUnindexed.length > 1 ? "s" : ""}`}
                  </button>
                )}

                {/* Remove the selected books that are already indexed */}
                {selectedIndexed.length > 0 && (
                  <button
                    onClick={handleBatchUnindex}
                    disabled={progress.running}
                    className={`font-semibold px-4 py-2 rounded-lg text-sm transition-colors ${
                      progress.running
                        ? "bg-zinc-600 text-zinc-400 cursor-not-allowed"
                        : "bg-red-900/60 hover:bg-red-800/80 text-red-200"
                    }`}
                  >
                    {progress.running && progressKind === "unindex"
                      ? `Removing… (${progress.done}/${progress.total})`
                      : `Remove ${selectedIndexed.length} from index`}
                  </button>
                )}

                {/* List management buttons */}
                {activeList ? (
                  <>
                    <button
                      onClick={handleRemoveFromList}
                      disabled={selectedIds.length >= (activeList.book_ids.length ?? 0) || mutateBooks.isPending}
                      className="bg-red-900/60 hover:bg-red-800/80 text-red-200 font-semibold px-3 py-2 rounded-lg text-sm transition-colors disabled:opacity-50"
                    >
                      − Remove from list
                    </button>
                  </>
                ) : (
                  <>
                    {/* Add to existing list — dropdown + confirm button */}
                    {lists && lists.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <select
                          value={targetListId ?? ""}
                          onChange={(e) => setTargetListId(e.target.value ? Number(e.target.value) : null)}
                          className="bg-zinc-800 border border-zinc-600 text-zinc-100 font-semibold px-2 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 appearance-auto"
                        >
                          <option value="">+ Add to list…</option>
                          {lists.map((l) => (
                            <option key={l.id} value={l.id}>{l.name}</option>
                          ))}
                        </select>
                        <button
                          onClick={handleAddToList}
                          disabled={!targetListId || mutateBooks.isPending}
                          className="bg-blue-800 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-3 py-2 rounded-lg text-sm transition-colors"
                        >
                          OK
                        </button>
                      </div>
                    )}
                    <button
                      onClick={handleSaveAsNewList}
                      className="bg-zinc-700 hover:bg-zinc-600 text-zinc-100 font-semibold px-3 py-2 rounded-lg text-sm transition-colors"
                    >
                      📋 Save as new list…
                    </button>
                  </>
                )}

                {/* Dismiss the whole selection */}
                <button
                  onClick={clearSelection}
                  title="Clear selection"
                  className="bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-semibold px-3 py-2 rounded-lg text-sm border border-zinc-700/60 transition-colors"
                >
                  ✕ Clear selection
                </button>
              </div>
            </>
          )}
        </div>

        {/* Batch index progress — the bar advances as each book finishes */}
        {(progress.running || progress.total > 0) && (
          <div className="bg-zinc-800/60 border border-green-700/40 rounded-lg px-4 py-3 text-sm space-y-2 mb-2">
            <div className="flex items-center justify-between gap-3">
              <p className={`truncate ${progress.running ? "text-green-400" : "text-zinc-300"}`}>
                {progress.current || "Starting…"}
              </p>
              <div className="flex items-center gap-3 whitespace-nowrap">
                <span className="text-xs text-zinc-400 tabular-nums">
                  {progress.done} / {progress.total}
                </span>
                {!progress.running && (
                  <button
                    onClick={() => setProgress({ running: false, current: "", done: 0, errors: [], total: 0 })}
                    title="Dismiss"
                    className="text-zinc-500 hover:text-zinc-200 text-sm leading-none"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-900">
              <div
                className={`h-full rounded-full transition-all duration-300 ${progress.running ? "bg-green-500" : "bg-green-600/70"}`}
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
              />
            </div>

            {progress.errors.length > 0 && (
              <ul className="text-red-400 pl-4 list-disc text-xs space-y-0.5">
                {progress.errors.map((e, i) => (
                  <li key={i}>{e.title}: {e.error}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Books scroll beneath the header's border */}
        <div className="absolute left-0 right-0 bottom-0 h-[1px]" />
      </header>

      <section className="grid grid-cols-[240px_1fr] gap-6">
        {/* Sidebar — sticks below the header; scrolls internally only if it outgrows the viewport */}
        <aside
          className="sticky self-start overflow-y-auto pr-2 pb-8 pt-4"
          style={{ top: stickyOffset, maxHeight: `calc(100vh - ${stickyOffset + 12}px)` }}
        >
          <FilterSidebar filters={filters} setFilters={setFilters} />
        </aside>

        {/* Books — scroll with the page, like normal document flow */}
        <div className="min-w-0 pb-16 pl-1">
          <BookGrid
            query={filters.query}
            status={filters.status}
            indexed={filters.indexed}
            sort={filters.sort}
            listId={filters.listId}
            totalRef={totalRef as React.MutableRefObject<number>}
            indexedRef={indexedRef as React.MutableRefObject<number>}
            indexedUnknownRef={indexedUnknownRef as React.MutableRefObject<boolean>}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            indexingId={indexingId}
            bookMetaRef={bookMetaRef}
          />
        </div>
      </section>
    </div>
  );
}
