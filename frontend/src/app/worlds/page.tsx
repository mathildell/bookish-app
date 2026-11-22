"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import NavSearchPortal from "@/components/NavSearchPortal";
import SearchBar from "@/components/SearchBar";
import Tooltip from "@/components/Tooltip";
import WorldCard from "@/components/WorldCard";
import { createWorld, deleteWorld, useWorlds } from "@/lib/api";
import { ClearIcon, SparklesIcon, TrashIcon, WorldIcon } from "@/components/icons";

// Round icon buttons of the selection rail — identical to the characters page's rail.
const ACTION_BTN =
  "flex h-12 w-12 items-center justify-center bg-card shadow-sm shadow-border hover:shadow-md rounded-full text-base leading-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

// The fixed rail floats RAIL_GAP right of the card grid, never closer than RAIL_EDGE
// to the viewport edge. RAIL_WIDTH mirrors the rail's own width (48px chip + px-2).
const RAIL_GAP = 20;
const RAIL_WIDTH = 64;
const RAIL_EDGE = 8;

export default function WorldsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const { data: worlds, isLoading, isError } = useWorlds(query || undefined);
  // Unfiltered set: the sidebar count describes the whole library, not the current search.
  const { data: allWorlds } = useWorlds();

  const createMut = useMutation({
    mutationFn: () => createWorld({ name: "New world" }),
    onSuccess: (world) => {
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      router.push(`/worlds/${world.id}`);
    },
  });

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const clearSelection = useCallback(() => setSelectedIds([]), []);

  // Mass delete: permanent, so ask first. allSettled keeps one failure from hiding the rest.
  const deleteSelected = useMutation({
    mutationFn: (ids: number[]) => Promise.allSettled(ids.map((id) => deleteWorld(id))),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      setSelectedIds([]);
    },
  });

  const visible = worlds ?? [];
  const selectedLabel = `${selectedIds.length} world${selectedIds.length !== 1 ? "s" : ""}`;

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
        <SearchBar value={query} onChange={setQuery} placeholder="Search world names and premises…" />
      </NavSearchPortal>

      <section className="grid grid-cols-[240px_1fr] gap-6">
        {/* Sidebar — sticks below the nav, like the characters page */}
        <aside
          className="sticky self-start overflow-y-auto pr-2 pb-8 pt-4 space-y-5"
          style={{ top: 65, maxHeight: "calc(100vh - 77px)" }}
        >
          <section>
            <p className="text-xs font-semibold uppercase text-muted mb-1">Worlds</p>
            <p className="text-xs text-muted mb-2">
              {isLoading ? "Loading…" : `${visible.length} world${visible.length === 1 ? "" : "s"}`}
              {query && allWorlds ? ` of ${allWorlds.length}` : ""}
            </p>
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="w-full rounded-md px-3 py-2 text-sm font-semibold bg-card shadow-sm shadow-border cursor-pointer transition-colors hover:bg-highlight hover:text-background disabled:opacity-50"
            >
              + New world
            </button>
          </section>

          <section>
            <p className="text-xs font-semibold uppercase text-muted mb-1">Extract</p>
            <p className="text-xs text-muted mb-2">
              Select books in the library, then use the globe button on the selection rail to read a world
              out of them.
            </p>
            <Link
              href="/"
              className="block w-full rounded-md px-3 py-2 text-center text-sm font-semibold bg-card shadow-sm shadow-border transition-colors hover:bg-highlight hover:text-background"
            >
              Go to the library
            </Link>
          </section>
        </aside>

        <div ref={gridRef} className="min-w-0 pb-16 pl-1 pr-8 pt-6">
          {isError && (
            <div className="py-12 text-center text-red-500">Couldn&apos;t load worlds. Is the API running?</div>
          )}

          {!isError && !isLoading && visible.length === 0 && (
            <div className="space-y-3 py-20 text-center text-muted">
              <p className="text-4xl">
                <WorldIcon className="w-10 h-10 inline" />
              </p>
              <p className="text-sm">
                {query
                  ? "No worlds match that search."
                  : "No worlds yet. Extract one from your indexed books, or start a blank sheet."}
              </p>
              <Link href="/" className="inline-block text-xs text-foreground hover:text-highlight">
                ← Back to the library
              </Link>
            </div>
          )}

          {visible.length > 0 && (
            <div className="flex flex-wrap gap-4 pb-8">
              {visible.map((world) => (
                <WorldCard
                  key={world.id}
                  world={world}
                  selected={selectedIds.includes(world.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Selection rail — same floating column of round buttons as the characters page. */}
      {selectedIds.length > 0 && (
        <aside className="fixed top-1/2 z-[55] -translate-y-1/2" style={{ left: railLeft ?? undefined }}>
          <div className="flex flex-col items-center gap-2.5 rounded-xl bg-background/50 px-2 py-4 shadow-sm shadow-border backdrop-blur-md">
            <Tooltip label={`Write with ${selectedLabel}`} placement="left">
              <Link
                href={{ pathname: "/write", query: { worlds: selectedIds.join(",") } }}
                aria-label={`Write with ${selectedLabel}`}
                className={`${ACTION_BTN} hover:bg-highlight hover:text-background cursor-pointer`}
              >
                <SparklesIcon className="h-6 w-6" />
              </Link>
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
