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
  tags: Record<string, boolean>;
  totalRef?: React.MutableRefObject<number>;
  selectedIds?: number[];
  onToggleSelect?: (id: number) => void;
}

export default function BookGrid({ query, status, indexed, sort, tags, totalRef, selectedIds = [], onToggleSelect }: Props) {
  const selectedTagKeys = Object.keys(tags).filter((k) => tags[k]);

  const sentinelRef = useRef<HTMLDivElement>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery<BooksListResponse>({
    queryKey: ["books", query, status, indexed, sort, JSON.stringify(selectedTagKeys)],
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const totalCardsLoaded = lastPage.offset + lastPage.cards.length;
      return totalCardsLoaded < lastPage.total ? totalCardsLoaded : undefined;
    },
    queryFn: async ({ pageParam }) => {
      const pageNum = typeof pageParam === "number" ? Math.floor(pageParam / PAGE_SIZE) : 0;
      return fetchBooks(pageNum, PAGE_SIZE, { query, status: status ?? undefined, indexed: indexed ?? undefined, sort, tags: selectedTagKeys });
    },
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

  if (isLoading) {
    return <div className="text-zinc-500 text-sm py-2">Loading your library…</div>;
  }

  if (!allCards?.length) {
    return <div className="text-zinc-500 text-center py-12">No books match current filters.</div>;
  }

  return (
    <>
      <div className="flex flex-wrap gap-4 justify-center pb-8">
        {allCards.map((book) => (
          <BookCard key={book.id} book={book} selectedId={selectedIds.includes(book.id) ? book.id : null} onToggleSelect={onToggleSelect ?? undefined} />
        ))}
      </div>

      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} className="h-4" />

      {isFetchingNextPage && (
        <div className="text-zinc-500 text-xs text-center py-3">Loading more…</div>
      )}
    </>
  );
}
