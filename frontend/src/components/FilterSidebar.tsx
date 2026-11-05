"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchFilterMetadata } from "@/lib/api";
import type { SortOption } from "@/components/FilterSidebar";

const TAG_CHECKS = ["ARC", "monthly-tbr", "fav", "nonfic"];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "date_added_desc", label: "Date added (newest first)" },
  { value: "date_added_asc", label: "Date added (oldest first)" },
  { value: "date_read_desc", label: "Date read (newest first)" },
  { value: "date_read_asc", label: "Date read (oldest first)" },
];


export default function FilterSidebar({
  filters,
  setFilters,
}: {
  filters: Filters;
  setFilters: (fn: (prev: Filters) => Filters) => void;
}) {
  const { data } = useQuery({
    queryKey: ["filterMetadata"],
    queryFn: fetchFilterMetadata,
  });

  const statuses = data?.statuses ?? [];

  return (
    <aside className="w-56 flex-shrink-0 space-y-5">
      {/* Status filter */}
      <section>
        <label className="text-xs font-semibold uppercase text-zinc-500 mb-1 block">Status</label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio" name="status-filter"
              checked={filters.status === null}
              onChange={() => setFilters((f) => ({ ...f, status: null }))}
              className="accent-yellow-500"
            />All
          </label>
          {statuses.map((s: string) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input
                type="radio" name="status-filter"
                checked={filters.status === s}
                onChange={() => setFilters((f) => ({ ...f, status: s }))}
                className="accent-yellow-500"
              />{s}
            </label>
          ))}
        </div>
      </section>

      {/* Index filter */}
      <section>
        <label className="text-xs font-semibold uppercase text-zinc-500 mb-1 block">Index</label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio" name="idx-filter"
              checked={filters.indexed === null}
              onChange={() => setFilters((f) => ({ ...f, indexed: null }))}
              className="accent-yellow-500"
            />All
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio" name="idx-filter"
              checked={filters.indexed === true}
              onChange={() => setFilters((f) => ({ ...f, indexed: true }))}
              className="accent-yellow-500"
            />Indexed
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio" name="idx-filter"
              checked={filters.indexed === false}
              onChange={() => setFilters((f) => ({ ...f, indexed: false }))}
              className="accent-yellow-500"
            />Not Indexed
          </label>
        </div>
      </section>

      {/* Sort control */}
      <section>
        <label className="text-xs font-semibold uppercase text-zinc-500 mb-1 block">Sort by</label>
        <select
          value={filters.sort}
          onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as SortOption }))}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </section>

      {/* Tag checkboxes */}
      <section>
        <label className="text-xs font-semibold uppercase text-zinc-500 mb-1 block">Tags</label>
        <div className="space-y-2">
          {TAG_CHECKS.map((tag) => (
            <label key={tag} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!filters.tags[tag]}
                onChange={(e) => {
                  const updated = { ...filters.tags };
                  if (e.target.checked) {
                    updated[tag] = true;
                  } else {
                    delete updated[tag];
                  }
                  setFilters((f) => ({ ...f, tags: updated }));
                }}
                className="accent-yellow-500"
              />
              {tag}
            </label>
          ))}
        </div>
      </section>
    </aside>
  );
}
