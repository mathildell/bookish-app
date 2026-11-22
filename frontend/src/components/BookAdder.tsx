"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchBooks } from "@/lib/api";
import { BookIcon, ClearIcon } from "@/components/icons";

export type AddedBook = { id: number; title: string };

/**
 * Pick extra source books for a refine: search the indexed library, click to add,
 * click a chip to take it back out. Books already used as sources are not offered.
 */
export default function BookAdder({
  added,
  onChange,
  excludeIds,
  disabled,
}: {
  added: AddedBook[];
  onChange: (books: AddedBook[]) => void;
  /** Books the sheet already has as sources. */
  excludeIds: number[];
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");

  const { data: results } = useQuery({
    queryKey: ["books", "source-picker", search],
    queryFn: () => fetchBooks(0, 8, { query: search, indexed: true }),
    enabled: search.trim().length >= 2,
    staleTime: 60_000,
  });
  const candidates = (results?.cards ?? []).filter(
    (book) => !excludeIds.includes(book.id) && !added.some((a) => a.id === book.id)
  );

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider mb-2">Add books</p>
      {added.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {added.map((book) => (
            <button
              key={book.id}
              type="button"
              onClick={() => onChange(added.filter((a) => a.id !== book.id))}
              disabled={disabled}
              title="Remove"
              className="flex max-w-full cursor-pointer items-center gap-1.5 truncate rounded-full border border-accent bg-accent/20 px-2 py-1 text-xs leading-3 transition-colors hover:border-red-500 disabled:opacity-50"
            >
              <BookIcon className="h-4 w-4" /> <span className="truncate">{book.title}</span> <ClearIcon />
            </button>
          ))}
        </div>
      )}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search your indexed books…"
        disabled={disabled}
        className="w-full rounded-lg bg-background px-3 py-2 text-sm text-foreground placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {search.trim().length >= 2 && (
        <div className="max-h-44 space-y-0.5 overflow-y-auto">
          {candidates.map((book) => (
            <button
              key={book.id}
              type="button"
              onClick={() => onChange([...added, { id: book.id, title: book.title }])}
              className="flex w-full cursor-pointer items-baseline gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-background"
            >
              <span className="truncate font-medium">{book.title}</span>
              <span className="truncate text-muted">{book.authors.join(", ")}</span>
            </button>
          ))}
          {results && candidates.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted">No more indexed books match.</p>
          )}
        </div>
      )}
    </div>
  );
}
