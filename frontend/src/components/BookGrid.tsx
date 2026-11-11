"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchBooks } from "@/lib/api";
import type { BooksListResponse, BookCard as BookCardType } from "@/types/book";
import type { SortOption } from "@/components/FilterSidebar";
import { useEffect, useRef } from "react";
import BookCard from "./BookCard";

const PAGE_SIZE = 24;

interface Props {
  query: string;
  status: string | null;
  indexed: boolean | null;
  sort: SortOption;
  listId?: number | null;
  totalRef?: React.MutableRefObject<number>;
  indexedRef?: React.MutableRefObject<number>;
  indexedUnknownRef?: React.MutableRefObject<boolean>;
  selectedIds?: number[];
  onToggleSelect?: (id: number) => void;
  /** Book currently being indexed by the batch flow, if any. */
  indexingId?: number | null;
  /** Kept up to date by the grid so the toolbar knows each selected book's index state. */
  bookMetaRef?: React.MutableRefObject<Record<number, { title: string; indexed: boolean }>>;
}

export default function BookGrid({ query, status, indexed, sort, listId, totalRef, indexedRef, indexedUnknownRef, selectedIds = [], onToggleSelect, indexingId, bookMetaRef }: Props) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch } = useInfiniteQuery<BooksListResponse>({
    queryKey: ["books", query, status, indexed, sort, listId],
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const totalCardsLoaded = lastPage.offset + lastPage.cards.length;
      return totalCardsLoaded < lastPage.total ? totalCardsLoaded : undefined;
    },
    queryFn: async ({ pageParam }) => {
      const pageNum = typeof pageParam === "number" ? Math.floor(pageParam / PAGE_SIZE) : 0;
      return fetchBooks(pageNum, PAGE_SIZE, { query, status: status ?? undefined, indexed: indexed ?? undefined, sort, list_id: listId ?? undefined });
    },
    staleTime: 10_000,
  });

  // Infinite scroll: detect when sentinel element enters the viewport
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) fetchNextPage();
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Expose total count
  const allCards = data?.pages.flatMap((p) => p.cards);
  if (totalRef && data?.pages.length) {
    totalRef.current = data.pages[data.pages.length - 1].total;
  }
  if (indexedRef && data?.pages.length) {
    indexedRef.current = data.pages[data.pages.length - 1].indexed_total;
  }
  if (indexedUnknownRef && data?.pages.length) {
    indexedUnknownRef.current = !!data.pages[data.pages.length - 1].indexed_unknown;
  }
  if (bookMetaRef && allCards) {
    for (const c of allCards) {
      bookMetaRef.current[c.id] = { title: c.title, indexed: !!c.indexed };
    }
  }

  if (isLoading) {
    return <div className="text-muted text-sm py-2">Loading your library…</div>;
  }

  if (isError) {
    const message = error instanceof Error ? error.message : "Failed to load books";
    return (
      <div className="text-red-400 text-center py-12 space-y-3">
        <p>{message}</p>
        <button
          onClick={() => refetch()}
          className="bg-accent hover:bg-accent text-zinc-900 font-semibold px-4 py-2 rounded-md text-sm transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!allCards?.length) {
    return <div className="text-muted text-center py-12">No books match current filters.</div>;
  }

  return (
    <>
      <div className="flex flex-wrap gap-4 justify-center pb-8">
        {allCards.map((book) => (
          <BookCard
            key={book.id}
            book={book}
            selectedId={selectedIds.includes(book.id) ? book.id : null}
            onToggleSelect={onToggleSelect ?? undefined}
            indexing={indexingId === book.id}
          />
        ))}
      </div>

      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} className="h-4" />

      {isFetchingNextPage && (
        <div className="text-muted text-xs text-center py-3">Loading more…</div>
      )}
    </>
  );
}
