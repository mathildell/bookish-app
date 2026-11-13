"use client";

import { useState, useCallback, useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import BookGrid from "@/components/BookGrid";
import SearchBar from "@/components/SearchBar";
import NavSearchPortal from "@/components/NavSearchPortal";
import FilterSidebar from "@/components/FilterSidebar";
import Tooltip from "@/components/Tooltip";
import type { Filters } from "@/components/FilterSidebar";
import Link from "next/link";
import { batchIndexBooks, createList, setListBooks, unindexBook, useBookLists, type BatchIndexEvent } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChatIcon, CharacterIcon, IndexAdd, IndexRemove, ListAdd, ListRemove, FolderAdd, ClearIcon } from "@/components/icons";

// Height of the sticky nav (h-14 + pt-2 + 1px border) — the header sticks just below it.
const NAV_HEIGHT = 65;

// Icon-only buttons in the selection toolbar; each button's tooltip carries its wording.
const ACTION_BTN =
  "flex h-12 w-12 items-center justify-center bg-card shadow-sm shadow-border hover:shadow-md rounded-full text-base leading-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * One rail entry: a link while the action applies, otherwise the same chip as a
 * disabled button whose tooltip says what the selection is missing.
 */
function RailAction({
  href,
  label,
  hint,
  disabled,
  children,
}: {
  href: ComponentProps<typeof Link>["href"];
  label: string;
  hint: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={disabled ? hint : label} placement="left">
      {disabled ? (
        <button disabled aria-label={hint} className={`${ACTION_BTN} text-muted bg-background cursor-not-allowed`}>
          {children}
        </button>
      ) : (
        <Link href={href} aria-label={label} className={`${ACTION_BTN} hover:bg-highlight hover:text-background cursor-pointer`}>
          {children}
        </Link>
      )}
    </Tooltip>
  );
}

// The fixed selection rail floats this far right of the book grid, and never closer
// than RAIL_EDGE to the viewport edge. RAIL_WIDTH mirrors the rail's own width: a
// 48px chip plus the column's px-2, so the clamp keeps the whole rail on screen.
const RAIL_GAP = 20;
const RAIL_WIDTH = 64;
const RAIL_EDGE = 8;

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

  // ── selection rail state ─────────────────────────────────────
  // The rail's list button opens a flyout of lists: a native <select> can't sit in a
  // column of icon-only buttons.
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const activeList = lists?.find((l) => l.id === filters.listId);

  // Mutate a list's book_ids by ID
  // The grid is filtered by the same list, so its cached pages are stale after a change.
  const mutateBooks = useMutation({
    mutationFn: ({ listId, ids }: { listId: number; ids: number[] }) => setListBooks(listId, ids),
    onSuccess: () => {
      refetchLists();
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });

  // Add the selection to one list, chosen from the rail's flyout.
  const addToList = useCallback(
    (list: NonNullable<typeof lists>[number]) => {
      if (selectedIds.length === 0) return;
      mutateBooks.mutate({
        listId: list.id,
        ids: [...new Set([...list.book_ids, ...selectedIds])],
      });
      setSelectedIds([]);
      setListMenuOpen(false);
    },
    [selectedIds, mutateBooks],
  );

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

  // The rail is position: fixed, so its horizontal offset has to be measured: it sits
  // RAIL_GAP right of the grid's right edge, and that edge moves with the container.
  const booksRef = useRef<HTMLDivElement | null>(null);
  const [railLeft, setRailLeft] = useState<number | null>(null);

  useEffect(() => {
    const el = booksRef.current;
    if (!el) return;
    const measure = () => {
      // Drop the wrapper's own right padding: the grid ends at its content edge.
      const gridRight = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
      setRailLeft(Math.min(gridRight + RAIL_GAP, window.innerWidth - RAIL_WIDTH - RAIL_EDGE));
    };
    measure();
    // Width changes (container or window) both move the edge, so watch the element
    // and the window.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Track the header's height so the sidebar can stick right under it (it grows when
  // the selection actions wrap or the batch progress panel appears).
  const headerRef = useRef<HTMLDivElement | null>(null);
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

  // Toolbar counts for the icon tooltips.
  const selectionLabel = `${selectedIds.length} book${selectedIds.length !== 1 ? "s" : ""}`;
  const unindexedLabel = `${selectedUnindexed.length} book${selectedUnindexed.length !== 1 ? "s" : ""}`;
  const indexedLabel = `${selectedIndexed.length} book${selectedIndexed.length !== 1 ? "s" : ""}`;

  // The page scrolls normally (document-level scrollbar); the header sticks under the
  // nav and the sidebar sticks under the header.
  const stickyOffset = NAV_HEIGHT + headerHeight;
  return (
    <div className="relative">
       <NavSearchPortal>
        <SearchBar
          value={filters.query}
          onChange={(query) => setFilters((f) => ({ ...f, query }))}
          placeholder="Search titles, authors, series, tags…"
        />
      </NavSearchPortal>

      <section className="grid grid-cols-[240px_1fr] gap-6">
        {/* Sidebar — sticks below the header; scrolls internally only if it outgrows the viewport */}
        <aside
          className="sticky self-start overflow-y-auto pr-2 pb-8 pt-4"
          style={{ top: stickyOffset, maxHeight: `calc(100vh - ${stickyOffset + 12}px)` }}
        >
          <FilterSidebar filters={filters} setFilters={setFilters} />
        </aside>

        {/* Books — scroll with the page, like normal document flow. This wrapper is
            measured: the fixed selection rail sits RAIL_GAP off its right edge, so it
            follows the grid instead of the window. */}
        <div ref={booksRef} className="min-w-0 pb-16 pl-1 pr-8 pt-6">
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


      {/* Selection rail — a column of emoji buttons floating at the right edge,
          vertically centred. Fixed, so selecting books never reflows the grid. */}
      {selectedIds.length > 0 && (
        <aside
          className="fixed top-1/2 z-[55] -translate-y-1/2"
          style={{ left: railLeft ?? undefined }}
        >
          <div className="flex flex-col items-center gap-2.5 rounded-xl bg-background/50 px-2 py-4 shadow-sm shadow-border backdrop-blur-md">
            {/* Chat with books — only from books whose text is in the index */}
            <RailAction
              href={{ pathname: "/chat", query: { ids: selectedIds.join(",") } }}
              label={`Chat with ${selectionLabel}`}
              hint={`Chat with ${selectionLabel}`}
              disabled={selectedUnindexed.length > 0}
            >
              <ChatIcon className="h-6 w-6" />
            </RailAction>

            {/* Extract characters — only from books whose text is in the index */}
            <RailAction
              href={{ pathname: "/characters/extract", query: { ids: selectedIds.join(",") } }}
              label={`Extract characters from ${selectionLabel}`}
              hint="Index these books first — characters are read from the search index"
              disabled={selectedUnindexed.length > 0}
            >
              <CharacterIcon />
            </RailAction>

            {/* Index only the selected books that are not indexed yet */}
            {selectedUnindexed.length > 0 && (
              <Tooltip label={`Add ${unindexedLabel} to the search index`} placement="left">
                <button
                  onClick={handleBatchIndex}
                  disabled={progress.running || selectedIds.length < 2}
                  aria-label={`Add ${unindexedLabel} to the search index`}
                  className={`${ACTION_BTN}${progress.running || selectedIds.length < 2 ? 
                    ' text-muted bg-background cursor-not-allowed' : 
                    ' bg-green-500/60 hover:bg-green-500 text-white cursor-pointer'}`}
                >
                  <IndexAdd />
                </button>
              </Tooltip>
            )}

            {/* Remove the selected books that are already indexed */}
            {selectedIndexed.length > 0 && (
              <Tooltip label={`Remove ${indexedLabel} from the search index`} placement="left">
                <button
                  onClick={handleBatchUnindex}
                  disabled={progress.running}
                  aria-label={`Remove ${indexedLabel} from the search index`}
                  className={`${ACTION_BTN}${progress.running || selectedIds.length < 2 ? 
                    ' text-muted bg-background cursor-not-allowed' : 
                    ' bg-red-500/60 hover:bg-red-500 text-white cursor-pointer'}`}
                >
                  <IndexRemove />
                </button>
              </Tooltip>
            )}

            {/* Lists: the flyout replaces the old select + confirm pair */}
            {activeList ? (
              <Tooltip label={`Remove ${selectionLabel} from "${activeList.name}"`} placement="left">
                <button
                  onClick={handleRemoveFromList}
                  disabled={selectedIds.length >= (activeList.book_ids.length ?? 0) || mutateBooks.isPending}
                  aria-label={`Remove ${selectionLabel} from "${activeList.name}"`}
                  className={`${ACTION_BTN} bg-red-500/60 hover:bg-red-500 text-white cursor-pointer`}
                >
                  <ListRemove />
                </button>
              </Tooltip>
            ) : (
              <div className="relative">
                <Tooltip
                  label={
                    lists && lists.length > 0
                      ? `Add ${selectionLabel} to a list`
                      : "No lists yet"
                  }
                  placement="left"
                >
                  <button
                    type="button"
                    onClick={() => setListMenuOpen((open) => !open)}
                    disabled={!lists || lists.length === 0 || mutateBooks.isPending}
                    aria-label={`Add ${selectionLabel} to a list`}
                    aria-expanded={listMenuOpen}
                    aria-haspopup="menu"
                    className={`${ACTION_BTN} bg-green-500/60 hover:bg-green-500 text-white cursor-pointer`}
                  >
                    <ListAdd />
                  </button>
                </Tooltip>

                {listMenuOpen && (
                  <>
                    {/* Click-away layer so the flyout closes without a second click on the button */}
                    <button
                      type="button"
                      aria-hidden="true"
                      tabIndex={-1}
                      onClick={() => setListMenuOpen(false)}
                      className="fixed inset-0 z-[55]"
                    />
                    <div
                      role="menu"
                      aria-label={`Add ${selectionLabel} to a list`}
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
                            onClick={() => addToList(list)}
                            className="cursor-pointer rounded-md flex w-full items-center justify-between gap-2 py-1.5 px-1 text-left text-xs transition-colors text-foreground hover:bg-highlight hover:text-background"
                          >
                            <span className="truncate">{list.name}</span>
                            <span className="tabular-nums text-zinc-500">{list.book_ids.length}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            <Tooltip label="Save selection as a new list" placement="left">
              <button
                onClick={handleSaveAsNewList}
                aria-label="Save selection as a new list"
                className={`${ACTION_BTN} hover:bg-highlight hover:text-background cursor-pointer`}
              >
                <FolderAdd />
              </button>
            </Tooltip>

            <div className="my-1.5 h-px w-8 bg-border" />

            {/* Dismiss the whole selection */}
            <Tooltip label="Clear selection" placement="left">
              <button
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