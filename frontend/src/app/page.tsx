"use client";

import { useState, useCallback, useRef } from "react";
import BookGrid from "@/components/BookGrid";
import SearchBar from "@/components/SearchBar";
import FilterSidebar from "@/components/FilterSidebar";
import type { Filters } from "@/components/FilterSidebar";
import Link from "next/link";
import { batchIndexBooks, type BatchIndexEvent } from "@/lib/api";

type BatchProgress = {
  running: boolean;
  current: string;
  done: number;
  errors: { title: string; error: string }[];
  total: number;
};

export default function LibraryPage() {
  const [filters, setFilters] = useState<Filters>({
    query: "",
    status: null,
    indexed: null,
    sort: "date_added_desc",
    tags: {},
  });

  const totalRef = useRef(0);
  const indexedRef = useRef(0);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [progress, setProgress] = useState<BatchProgress>({
    running: false,
    current: "",
    done: 0,
    errors: [],
    total: 0,
  });

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const handleBatchIndex = useCallback(async () => {
    if (selectedIds.length === 0) return;

    setProgress({ running: true, current: "Starting…", done: 0, errors: [], total: selectedIds.length });

    for await (const event of batchIndexBooks(selectedIds)) {
      if (event.kind === "done") {
        setProgress((p) => ({ ...p, running: false, current: `Done — ${p.done} indexed${p.errors.length ? `, ${p.errors.length} error${p.errors.length > 1 ? "s" : ""}` : ""}` }));
        setSelectedIds([]);
        return;
      }

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
            updated.errors.push({ title: event.title, error: event.errors?.[0] ?? "unknown" });
            updated.done += 1;
            break;
          case "skipped":
            updated.current = `#${event.id}: ${event.reason}`;
            break;
        }
        return updated;
      });
    }
  }, [selectedIds]);

  return (
    <div className="space-y-4">
      {/* Search + Chat row */}
      <div className="flex items-center gap-4 flex-wrap">
        <SearchBar
          value={filters.query}
          onChange={(query) => setFilters((f) => ({ ...f, query }))}
          placeholder="Search titles, authors, series… (live)"
        />
        {totalRef.current > 0 && (
          <span className="text-xs text-zinc-500 whitespace-nowrap">
            {totalRef.current} books matched{indexedRef.current > 0 && indexedRef.current < totalRef.current && ` · ${indexedRef.current} indexed`}
          </span>
        )}
        {selectedIds.length > 0 && (
          <>
            <Link
              href={{ pathname: "/chat", query: { ids: selectedIds.join(",") } }}
              className="ml-auto bg-yellow-600 hover:bg-yellow-500 text-zinc-900 font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
            >
              Chat with {selectedIds.length} book{selectedIds.length > 1 ? "s" : ""}
            </Link>
            <button
              onClick={handleBatchIndex}
              disabled={progress.running}
              className={`font-semibold px-4 py-2 rounded-lg text-sm transition-colors ${
                progress.running
                  ? "bg-zinc-600 text-zinc-400 cursor-not-allowed"
                  : "bg-green-700 hover:bg-green-600 text-white"
              }`}
            >
              {progress.running ? `Indexing… (${progress.done}/${progress.total})` : `Index ${selectedIds.length} book${selectedIds.length > 1 ? "s" : ""}`}
            </button>
          </>
        )}
      </div>

      {/* Batch index progress */}
      {progress.running && (
        <div className="bg-zinc-800/60 border border-green-700/40 rounded-lg px-4 py-3 text-sm space-y-1">
          <p className="text-green-400">{progress.current}</p>
          {progress.errors.length > 0 && (
            <ul className="text-red-400 pl-4 list-disc">
              {progress.errors.map((e, i) => (
                <li key={i}>{e.title}: {e.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex gap-6">
        {/* Sidebar filters */}
        <FilterSidebar filters={filters} setFilters={setFilters} />

        {/* Infinite scroll grid */}
        <div className="flex-1 min-w-0 pb-8">
          <BookGrid
            query={filters.query}
            status={filters.status}
            indexed={filters.indexed}
            sort={filters.sort}
            tags={filters.tags}
            totalRef={totalRef as React.MutableRefObject<number>}
            indexedRef={indexedRef as React.MutableRefObject<number>}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        </div>
      </div>
    </div>
  );
}
