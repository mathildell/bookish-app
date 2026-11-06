"use client";

import { useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchFilterMetadata, fetchLists, createList, renameList, deleteList, type BookList } from "@/lib/api";

export type SortOption = "date_added_desc" | "date_added_asc" | "date_read_desc" | "date_read_asc";
export type Filters = {
  query: string;
  status: string | null;
  indexed: boolean | null;
  sort: SortOption;
  listId: number | null; // active saved-list filter
};

// Shared look for the small square icon buttons in the list rows.
const ICON_BTN =
  "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-zinc-700/70 bg-zinc-900/60 text-[11px] leading-none transition-colors";

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
  const queryClient = useQueryClient();

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

  const statuses = (data?.statuses ?? []).filter(
    (s: string) => s !== "wont-read" && s !== "won't-read"
  );

  const statusLabel = (s: string): string => {
    const mapped = STATUS_LABELS[s] ?? STATUS_LABELS[s.replace(/-/g, "_")] ?? s;
    return mapped.charAt(0).toUpperCase() + mapped.slice(1);
  };

  // ── lists data ───────────────────────────────────────────────────
  const { data: lists } = useQuery({
    queryKey: ["bookLists"],
    queryFn: () => fetchLists(),
  });

  // inline-edit / create state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNameValue, setEditNameValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [createNameValue, setCreateNameValue] = useState("");

  // force refresh lists after mutation
  const mutateLists = () => queryClient.invalidateQueries({ queryKey: ["bookLists"] });

  const createMutate = useMutation({
    mutationFn: createList,
    onSuccess: () => { setCreating(false); setCreateNameValue(""); mutateLists(); },
  });

  const renameMutate = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => renameList(id, name),
    onSuccess: () => { setEditingId(null); mutateLists(); },
  });

  const deleteMutate = useMutation({
    mutationFn: (id: number) => deleteList(id),
    onSuccess: () => mutateLists(),
  });

  // picking a list as filter
  const pickList = useCallback((lid: number | null) => {
    setFilters((f) => ({ ...f, listId: lid }));
  }, [setFilters]);

  // inline rename helpers
  const startRename = useCallback((list: BookList) => {
    setEditingId(list.id);
    setEditNameValue(list.name);
  }, []);

  const handleRenameConfirm = useCallback(() => {
    if (editingId == null || !editNameValue.trim()) return;
    renameMutate.mutateAsync({ id: editingId, name: editNameValue.trim() });
  }, [editingId, editNameValue, renameMutate]);

  const cancelRename = useCallback(() => setEditingId(null), []);

  const handleDelete = useCallback((id: number) => {
    deleteMutate.mutate(id);
    setFilters((f) => (f.listId === id ? { ...f, listId: null } : f));
  }, [deleteMutate, setFilters]);

  // create helpers
  const handleCreate = useCallback(() => { setCreating(true); setCreateNameValue(""); }, []);
  const confirmCreate = useCallback(() => {
    if (!createNameValue.trim()) return;
    createMutate.mutateAsync(createNameValue.trim());
  }, [createNameValue, createMutate]);
  const cancelCreate = useCallback(() => { setCreating(false); setCreateNameValue(""); }, []);

  const activeList = lists?.find((l) => l.id === filters.listId);


  return (
    <aside className="w-56 flex-shrink-0 space-y-5">
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

      {/* Index filter */}
      <section>
        <label className="text-xs font-semibold uppercase text-zinc-500 mb-1 block">Index</label>
        <div className="space-y-2">
          {[null, true, false].map((val) => (
            <label key={String(val)} className="flex items-center gap-2 text-sm">
              <input
                type="radio" name="idx-filter"
                checked={filters.indexed === val}
                onChange={() => setFilters((f) => ({ ...f, indexed: val }))}
                className="accent-yellow-500"
              />{val === null ? "All" : val ? "Indexed" : "Not Indexed"}
            </label>
          ))}
        </div>
      </section>

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
              />{statusLabel(s)}
            </label>
          ))}
        </div>
      </section>

      {/* ── Saved Lists ─────────────────────────────────────────── */}
      <section>
        <label className="text-xs font-semibold uppercase text-zinc-500 mb-1 block">Lists</label>

        {!lists || lists.length === 0 ? (
          <p className="text-[11px] text-zinc-600 leading-relaxed">
            No lists yet. Click below to create one.
          </p>
        ) : (
          <div className="space-y-1">
            {lists.map((list) => (
              <ListRow
                key={list.id}
                list={list}
                isActive={filters.listId === list.id}
                isEditing={editingId === list.id}
                editNameValue={editNameValue}
                onPick={() => pickList(filters.listId === list.id ? null : list.id)}
                onStartEdit={() => startRename(list)}
                onConfirmEdit={handleRenameConfirm}
                onCancelEdit={cancelRename}
                onDelete={() => handleDelete(list.id)}
                setEditNameValue={setEditNameValue}
              />
            ))}
          </div>
        )}

        {/* Inline create */}
        {creating ? (
          <div className="mt-2 flex gap-1 items-center">
            <input
              autoFocus
              value={createNameValue}
              onChange={(e) => setCreateNameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmCreate(); else if (e.key === "Escape") cancelCreate(); }}
              placeholder="List name…"
              className="flex-1 min-w-0 bg-zinc-900 border border-yellow-700 rounded-md px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
            />
            <button type="button" title="Create" onClick={confirmCreate} className={`${ICON_BTN} text-green-400 hover:text-green-300 hover:border-green-800/70`}>✓</button>
            <button type="button" title="Cancel" onClick={cancelCreate} className={`${ICON_BTN} text-zinc-500 hover:text-zinc-200 hover:border-zinc-600`}>✕</button>
          </div>
        ) : (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleCreate}
            className="mt-2 text-[11px] text-yellow-500/80 hover:text-yellow-400 transition-colors bg-none border-none cursor-pointer p-0"
          >
            + New list
          </button>
        )}
      </section>

      {/* Active list badge when a list is selected */}
      {activeList && (
        <div className="rounded-lg border border-yellow-800/50 bg-yellow-900/10 px-3 py-2">
          <p className="text-[11px] text-yellow-300/80 leading-relaxed">
            Showing <strong>{activeList.book_ids.length}</strong> book{activeList.book_ids.length !== 1 ? "s" : ""} in <strong>"{activeList.name}"</strong>
          </p>
        </div>
      )}
    </aside>
  );
}


/* ── ListRow ─────────────────────────────────────────────────────────────── */

function ListRow({
  list, isActive, isEditing, editNameValue, onPick, onStartEdit, onConfirmEdit, onCancelEdit, onDelete, setEditNameValue
}: {
  list: BookList;
  isActive: boolean;
  isEditing: boolean;
  editNameValue: string;
  onPick: () => void;
  onStartEdit: () => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  setEditNameValue: (v: string) => void;
}) {
  if (isEditing) {
    return (
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={editNameValue}
          onChange={(e) => setEditNameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirmEdit();
            else if (e.key === "Escape") onCancelEdit();
          }}
          className="flex-1 bg-zinc-900 border border-yellow-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
        />
        <button type="button" title="Save name" onClick={onConfirmEdit} className={`${ICON_BTN} text-green-400 hover:text-green-300 hover:border-green-800/70`}>✓</button>
        <button type="button" title="Cancel" onClick={onCancelEdit} className={`${ICON_BTN} text-zinc-500 hover:text-zinc-200 hover:border-zinc-600`}>✕</button>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-between rounded-md px-2 py-1.5 gap-1 transition-colors ${
        isActive ? "bg-yellow-900/30 border border-yellow-800/40" : "hover:bg-zinc-800/60 border border-transparent"
      }`}
    >
      {/* Click body → toggle as filter */}
      <button
        type="button"
        onMouseDown={(e) => { e.stopPropagation(); onPick(); }}
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
      >
        <span className={`text-[9px] leading-none flex-shrink-0 ${isActive ? "text-yellow-400" : "opacity-0"}`}>▶</span>
        <div className="min-w-0">
          <p className={`text-xs leading-tight truncate ${isActive ? "text-yellow-300 font-semibold" : "text-zinc-200"}`}>
            {list.name}
          </p>
          <p className="text-[10px] text-zinc-500">
            {list.book_ids.length} book{list.book_ids.length !== 1 ? "s" : ""}
          </p>
        </div>
      </button>

      {/* Management icons — only show when not the active filter */}
      <span className="flex gap-1">
        <button
          type="button"
          title="Rename"
          onMouseDown={(e) => { e.stopPropagation(); onStartEdit(); }}
          className={`${ICON_BTN} text-zinc-400 hover:text-yellow-400 hover:border-zinc-600`}
        >✏️</button>
        <button
          type="button"
          title="Delete"
          onMouseDown={(e) => { e.stopPropagation(); onDelete(); }}
          className={`${ICON_BTN} text-zinc-400 hover:text-red-400 hover:border-red-800/70`}
        >🗑</button>
      </span>
    </div>
  );
}