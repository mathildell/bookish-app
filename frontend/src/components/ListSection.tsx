"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { CancelIcon, EditIcon, TrashIcon, ValidateIcon } from "@/components/icons";

/** Row-level icon button, shared so both sidebars' shortcuts look identical. */
export const LIST_ICON =
  "flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-full text-xs leading-none transition-colors bg-background hover:bg-highlight hover:text-accent";

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

/** Payload for the inline create/rename form: the list id, or null when creating. */
type UpsertVars = { id: number | null; name: string };

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

  // Create and rename share one payload shape, so the same inline form can drive both.
  const createMut = useMutation({
    mutationFn: ({ name }: UpsertVars) => onCreate(name),
    onSuccess: () => {
      setCreating(false);
      setCreateName("");
      refresh();
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: UpsertVars) => {
      // Renaming only starts from an existing row, so the id is always present.
      return id === null ? Promise.reject(new Error("Rename needs a list id")) : onRename(id, name);
    },
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

  const ListItem = ({ list }: { list: ListSectionItem }) => (
    <div
      key={list.id}
      className="bg-white my-2 mx-0.5 rounded-md"
    >
      <div className={`flex items-center justify-between rounded-md px-2 py-1.5 gap-1 transition-colors hover:ring-2 hover:ring-accent ${
        activeListId === list.id
          ? "bg-accent/20 border border-accent"
          : "bg-card shadow-sm shadow-border"
      }`}> 
        <button
          type="button"
          onClick={() => onPick(activeListId === list.id ? null : list.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
        >
          <div className="min-w-0">
            <p
              className={`truncate text-xs leading-tight ${
                activeListId === list.id ? "font-bold" : ""
              }`}
            >
              {list.name}
            </p>
            <p className="text-xs text-muted">
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
            className={LIST_ICON}
          >
            <EditIcon />
          </button>
          <button
            type="button"
            title="Delete"
            onClick={() => deleteMut.mutate(list.id)}
            className={`${LIST_ICON} hover:bg-red-500`}
          >
            <TrashIcon />
          </button>
        </span>
      </div>
    </div>
  );

  const UpsertForm = ({
    name,
    setfunc,
    setbool,
    mut,
    list,
  }: {
    name: string;
    setfunc: (value: string) => void;
    /** Dismisses the form (Escape or Cancel). */
    setbool: () => void;
    mut: UseMutationResult<unknown, Error, UpsertVars, unknown>;
    /** The list being renamed, or null while creating a new one. */
    list: ListSectionItem | null;
  }) => (
    <div className="mt-3 flex items-center gap-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => setfunc(e.target.value)}
        onKeyDown={(e) => {
          // if (e.key === "Enter" && name.trim()) mut.mutate(name.trim());
          if (e.key === "Enter" && name.trim()) mut.mutate({ id: list?.id ?? null, name: name.trim() });
          else if (e.key === "Escape") setbool();
        }}
        placeholder="List name…"
        className="flex-1 min-w-0 rounded-md px-2 py-3 mx-0.5 shadow-sm shadow-border bg-card text-xs placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <button
        type="button"
        title="Confirm"
        onClick={() => name.trim() && mut.mutate({ id: list?.id ?? null, name: name.trim() })}
        className={`${LIST_ICON} bg-card text-muted -mr-0.5`}
      >
        <ValidateIcon />
      </button>
      <button
        type="button"
        title="Cancel"
        onClick={() => setbool()}
        className={`${LIST_ICON} bg-card text-muted`}
      >
        <CancelIcon />
      </button>
    </div>
  );
  
  return (
    <section>
      <label className="text-xs font-semibold uppercase text-muted mb-1 block">{title}</label>

      {isLoading && <p className="px-2 text-xs text-muted">Loading lists…</p>}

      {!isLoading && (!lists || lists.length === 0) && (
        <p className="px-2 text-xs text-muted leading-relaxed">
          No lists yet. Click below to create one.
        </p>
      )}

      <div className="space-y-1">
        {(lists ?? []).map((list) =>
          editingId === list.id ? (
            <UpsertForm
                key={list.id}  
                name={editName}
                setfunc={setEditName}
                setbool={() => setEditingId(null)}
                mut={renameMut}
                list={list}
              />
          ) : (
            <ListItem
                key={list.id}
                list={list} 
              />
          )
        )}
      </div>

      {activeList && (
        <div className="bg-white mt-2 rounded-lg">
          <div className="px-3 py-2 rounded-lg bg-accent/20 border border-accent">
            <p className="text-xs leading-relaxed">
              Showing <strong>{activeList.ids.length}</strong> {unit}
              {activeList.ids.length === 1 ? "" : "s"} in <strong>&quot;{activeList.name}&quot;</strong>
            </p>
          </div>
        </div>
      )}

      {creating ? (
        <UpsertForm 
            name={createName}
            setfunc={setCreateName}
            setbool={() => setCreating(false)}
            mut={createMut}
            list={null}
          />
      ) : (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setCreating(true);
            setCreateName("");
          }}
          className="mt-2 text-xs text-muted hover:text-highlight transition-colors bg-none border-none cursor-pointer p-0"
        >
          + New list
        </button>
      )}
    </section>
  );
}
