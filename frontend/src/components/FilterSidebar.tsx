"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createList, deleteList, fetchFilterMetadata, fetchLists, renameList } from "@/lib/api";
import ListSection, { LIST_ICON, type ListSectionItem } from "@/components/ListSection";
import { ChatIcon } from "@/components/icons";

export type SortOption = "date_added_desc" | "date_added_asc" | "date_read_desc" | "date_read_asc";
export type Filters = {
  query: string;
  status: string | null;
  indexed: boolean | null;
  sort: SortOption;
  listId: number | null; // active saved-list filter
};

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
  // ── filter metadata ──────────────────────────────────────────────
  const { data } = useQuery({
    queryKey: ["filterMetadata"],
    queryFn: fetchFilterMetadata,
  });

  const STATUS_LABELS: Record<string, string> = {
    dnf: "Did not finish",
    read: "Read",
    to_read: "TBR",
    "to-read": "TBR",
  };

  const statuses = [null, ...(data?.statuses ?? []).filter(
    (s: string) => s !== "wont-read" && s !== "won't-read"
  )];

  const statusLabel = (s: string): string => {
    const mapped = STATUS_LABELS[s] ?? STATUS_LABELS[s.replace(/-/g, "_")] ?? s;
    return mapped.charAt(0).toUpperCase() + mapped.slice(1);
  };

  // ── lists data ───────────────────────────────────────────────────
  const { data: lists, isLoading: listsLoading } = useQuery({
    queryKey: ["bookLists"],
    queryFn: () => fetchLists(),
  });

  // picking a list as filter
  const pickList = useCallback(
    (lid: number | null) => {
      setFilters((f) => ({ ...f, listId: lid }));
    },
    [setFilters]
  );

  const listItems: ListSectionItem[] | undefined = lists?.map((list) => ({
    id: list.id,
    name: list.name,
    ids: list.book_ids,
  }));

  return (
    <aside className="w-56 flex-shrink-0 space-y-5">
      {/* Sort control */}
      <section>
        <label className="text-xs font-semibold uppercase text-muted mb-1 block">Sort by</label>
        <select
          value={filters.sort}
          onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as SortOption }))}
          className="w-full rounded-md px-3 py-2 text-sm bg-card shadow-sm shadow-border focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </section>

      {/* Index filter */}
      <section>
        <label className="text-xs font-semibold uppercase text-muted mb-1 block">Index</label>
        <div className="space-y-2">
          {[null, true, false].map((val) => (
            <label key={String(val)} className="flex items-center gap-2 text-sm">
              <input
                type="radio" name="idx-filter"
                checked={filters.indexed === val}
                onChange={() => setFilters((f) => ({ ...f, indexed: val }))}
                className="accent-accent"
              />{val === null ? "All" : val ? "Indexed" : "Not Indexed"}
            </label>
          ))}
        </div>
      </section>

      {/* Status filter */}
      <section>
        <label className="text-xs font-semibold uppercase text-muted mb-1 block">Status</label>
        <div className="space-y-2">
          {statuses.map((s) => (
            <label key={s ?? "all"} className="flex items-center gap-2 text-sm">
              <input
                type="radio" name="status-filter"
                checked={filters.status === s}
                onChange={() => setFilters((f) => ({ ...f, status: s }))}
                className="accent-accent"
              />{s === null ? "All" : statusLabel(s)}
            </label>
          ))}
        </div>
      </section>

      {/* ── Saved Lists (shared with the characters page) ─────────── */}
      <ListSection
        title="Lists"
        unit="book"
        lists={listItems}
        isLoading={listsLoading}
        activeListId={filters.listId}
        onPick={pickList}
        queryKey={["bookLists"]}
        onCreate={createList}
        onRename={renameList}
        onDelete={deleteList}
        shortcut={(list) =>
          list.ids.length > 0 ? (
            <Link
              href={{ pathname: "/chat", query: { ids: list.ids.join(",") } }}
              title={`Chat with the ${list.ids.length} book${list.ids.length !== 1 ? "s" : ""} in "${list.name}"`}
              className={LIST_ICON}
            >
              <ChatIcon />
            </Link>
          ) : (
            <button
              type="button"
              disabled
              title="This list has no books yet"
              className={`${LIST_ICON} cursor-not-allowed`}
            >
              <ChatIcon />
            </button>
          )
        }
      />
    </aside>
  );
}
