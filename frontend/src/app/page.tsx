"use client";

import { useState, useCallback, useRef } from "react";
import BookGrid from "@/components/BookGrid";
import SearchBar from "@/components/SearchBar";
import FilterSidebar from "@/components/FilterSidebar";
import type { Filters } from "@/components/FilterSidebar";
import Link from "next/link";

export default function LibraryPage() {
  const [filters, setFilters] = useState<Filters>({
    query: "",
    status: null,
    indexed: null,
    sort: "date_added_desc",
    tags: {},
  });

  const totalRef = useRef(0);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

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
            {totalRef.current} books matched
          </span>
        )}
        {selectedIds.length > 0 && (
          <Link
            href={{ pathname: "/chat", query: { ids: selectedIds.join(",") } }}
            className="ml-auto bg-yellow-600 hover:bg-yellow-500 text-zinc-900 font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
          >
            Chat with {selectedIds.length} book{selectedIds.length > 1 ? "s" : ""}
          </Link>
        )}
      </div>

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
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        </div>
      </div>
    </div>
  );
}
