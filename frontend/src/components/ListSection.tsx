"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/** Row-level icon button, shared so both sidebars' shortcuts look identical. */
export const LIST_ICON =
  "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-zinc-700/70 bg-zinc-900/60 text-[11px] leading-none transition-colors";

export type ListSectionItem = { id: number; name: string; ids: number[] };

export type ListSectionProps = {
  title: string;
  /** Singular noun for counts: "book" or "character". */
  unit: string;
  lists: ListSectionItem[] | undefined;
  isLoading?: boolean;
  activeListId: number | null;
  onPick: (id: number | null) => void;
  /** Query key to invalidate after a create, rename or delete. */
  queryKey: readonly unknown[];
  onCreate: (name: string) => Promise<unknown>;
  onRename: (id: number, name: string) => Promise<unknown>;
  onDelete: (id: number) => Promise<unknown>;
  /** Optional per-row shortcut rendered before rename/delete (💬, ✨). */
  shortcut?: (list: ListSectionItem) => ReactNode;
};

/**
 * One saved-list section for both sidebars. The library feeds it books, the
 * characters page feeds it casts; the chevron, the active-list notice, inline
 * create and rename/delete all live here so the two never drift apart again.
 */
export default function ListSection({
  title,
  unit,
  lists,
  isLoading = false,
  activeListId,
  onPick,
  queryKey,
  onCreate,
  onRename,
  onDelete,
  shortcut,
}: ListSectionProps) {
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey]
  );

  const createMut = useMutation({
    mutationFn: onCreate,
    onSuccess: () => {
      setCreating(false);
      setCreateName("");
      refresh();
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => onRename(id, name),
    onSuccess: () => {
      setEditingId(null);
      refresh();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => onDelete(id),
    onSuccess: (_data, id) => {
      // Deleting the list you are filtered by would leave a phantom view.
      if (activeListId === id) onPick(null);
      refresh();
    },
  });

  const activeList = lists?.find((l) => l.id === activeListId);

  return (
    <section>
      <label className="text-xs font-semibold uppercase text-zinc-500 mb-1 block">{title}</label>

      {isLoading && <p className="px-2 text-[11px] text-zinc-600">Loading lists…</p>}

      {!isLoading && (!lists || lists.length === 0) && (
        <p className="px-2 text-[11px] leading-relaxed text-zinc-600">
          No lists yet. Click below to create one.
        </p>
      )}

      <div className="space-y-1">
        {(lists ?? []).map((list) =>
          editingId === list.id ? (
            <div key={list.id} className="flex items-center gap-1">
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && editName.trim())
                    renameMut.mutate({ id: list.id, name: editName.trim() });
                  else if (e.key === "Escape") setEditingId(null);
                }}
                className="flex-1 min-w-0 rounded border border-yellow-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
              />
              <button
                type="button"
                title="Save name"
                onClick={() => editName.trim() && renameMut.mutate({ id: list.id, name: editName.trim() })}
                className={`${LIST_ICON} text-green-400 hover:border-green-800/70 hover:text-green-300`}
              >
                ✓
              </button>
              <button
                type="button"
                title="Cancel"
                onClick={() => setEditingId(null)}
                className={`${LIST_ICON} text-zinc-500 hover:border-zinc-600 hover:text-zinc-200`}
              >
                ✕
              </button>
            </div>
          ) : (
            <div
              key={list.id}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 gap-1 transition-colors ${
                activeListId === list.id
                  ? "bg-yellow-900/30 border border-yellow-800/40"
                  : "hover:bg-zinc-800/60 border border-transparent"
              }`}
            >
              {/* Click body → toggle as filter. The chevron marks the active list. */}
              <button
                type="button"
                onClick={() => onPick(activeListId === list.id ? null : list.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span
                  className={`flex-shrink-0 text-[9px] leading-none ${
                    activeListId === list.id ? "text-yellow-400" : "opacity-0"
                  }`}
                >
                  ▶
                </span>
                <div className="min-w-0">
                  <p
                    className={`truncate text-xs leading-tight ${
                      activeListId === list.id ? "text-yellow-300 font-semibold" : "text-zinc-200"
                    }`}
                  >
                    {list.name}
                  </p>
                  <p className="text-[10px] text-zinc-500">
                    {list.ids.length} {unit}
                    {list.ids.length === 1 ? "" : "s"}
                  </p>
                </div>
              </button>

              <span className="flex gap-1">
                {shortcut?.(list)}
                <button
                  type="button"
                  title="Rename"
                  onClick={() => {
                    setEditingId(list.id);
                    setEditName(list.name);
                  }}
                  className={`${LIST_ICON} text-zinc-400 hover:border-zinc-600 hover:text-yellow-400`}
                >
                  ✏️
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => deleteMut.mutate(list.id)}
                  className={`${LIST_ICON} text-zinc-400 hover:border-red-800/70 hover:text-red-400`}
                >
                  🗑
                </button>
              </span>
            </div>
          )
        )}
      </div>

      {activeList && (
        <div className="mt-2 rounded-lg border border-yellow-800/50 bg-yellow-900/10 px-3 py-2">
          <p className="text-[11px] text-yellow-300/80 leading-relaxed">
            Showing <strong>{activeList.ids.length}</strong> {unit}
            {activeList.ids.length === 1 ? "" : "s"} in <strong>&quot;{activeList.name}&quot;</strong>
          </p>
        </div>
      )}

      {creating ? (
        <div className="mt-2 flex items-center gap-1">
          <input
            autoFocus
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && createName.trim()) createMut.mutate(createName.trim());
              else if (e.key === "Escape") setCreating(false);
            }}
            placeholder="List name…"
            className="flex-1 min-w-0 rounded border border-yellow-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
          />
          <button
            type="button"
            title="Create"
            onClick={() => createName.trim() && createMut.mutate(createName.trim())}
            className={`${LIST_ICON} text-green-400 hover:border-green-800/70 hover:text-green-300`}
          >
            ✓
          </button>
          <button
            type="button"
            title="Cancel"
            onClick={() => setCreating(false)}
            className={`${LIST_ICON} text-zinc-500 hover:border-zinc-600 hover:text-zinc-200`}
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setCreating(true);
            setCreateName("");
          }}
          className="mt-2 text-[11px] text-yellow-500/80 hover:text-yellow-400 transition-colors bg-none border-none cursor-pointer p-0"
        >
          + New list
        </button>
      )}
    </section>
  );
}
