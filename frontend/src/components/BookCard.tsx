"use client";

import type { BookCard as BookCardType } from "@/types/book";
import Link from "next/link";
import { useState } from "react";
import { indexBook, unindexBook } from "@/lib/api";
import { useRouter } from "next/navigation";

function renderMoons(rating: number | null | undefined) {
  if (rating == null) return "";
  const halves = Math.round(rating);
  const full = Math.floor(halves / 2);
  const half = halves % 2;
  const empty = 5 - full - half;
  return "🌕".repeat(full) + "🌗".repeat(half) + "🌑".repeat(empty);
}

export default function BookCard({ book, selectedId, onToggleSelect }: { book: BookCardType; selectedId?: number | null; onToggleSelect?: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const isSelected = selectedId === book.id && !!onToggleSelect;

  const handleToggleIndex = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      if (book.indexed) {
        await unindexBook(book.id);
      } else {
        // Indexing can take a while — optimistic update + reload
        await indexBook(book.id);
      }
      router.refresh();
    } catch {
      /* noop */ 
    } finally {
      setLoading(false);
    }
  };

  return (
    <Link
      href={`/book/${book.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group relative w-[180px] h-[270px] rounded-xl overflow-hidden cursor-pointer shadow-lg shadow-black/30 hover:shadow-xl transition-shadow duration-200"
      style={{ opacity: book.indexed ? 1 : 0.5 }}
    >
      {/* Selection checkbox */}
      {onToggleSelect && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSelect(book.id);
          }}
          disabled={!book.indexed}
          className={`absolute top-2 left-2 z-20 w-6 h-6 rounded-md flex items-center justify-center transition-all ${
            isSelected
              ? "bg-yellow-500 shadow-md"
              : book.indexed
                ? "bg-zinc-900/80 border border-zinc-600 hover:border-yellow-500"
                : "bg-zinc-900/40 border border-zinc-700/50 cursor-not-allowed"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6L5 9L10 3" stroke={isSelected ? "#18181b" : "transparent"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {/* Cover image (fallback placeholder) */}
      <div className="absolute inset-0 bg-zinc-800 flex items-center justify-center">
        {book.cover_uri ? (
          <img
            src={book.cover_uri}
            alt={book.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-zinc-600 text-xs">No cover</span>
        )}
      </div>

      {/* Hover overlay */}
      <div
        className={
          "absolute inset-x-0 bottom-0 bg-zinc-950/90 p-4 text-white transition-all duration-300 ease-out" +
          (hovered ? " max-h-[100%] opacity-100" : " max-h-0 opacity-0 overflow-hidden")
        }
      >
        <p className="font-bold text-sm leading-snug line-clamp-3 mb-1">{book.title}</p>
        <p className="text-xs text-zinc-400 italic line-clamp-2">
          {book.authors.join(", ") || "Unknown"}
        </p>
        {book.series_name && (
          <p className="text-[11px] text-yellow-400 mt-0.5 line-clamp-1">
            {book.series_name}
            {book.series_index != null ? ` #${book.series_index}` : ""}
          </p>
        )}
        {book.goodreads_rating != null && (
          <p className="text-xs mt-1">{renderMoons(book.goodreads_rating)}</p>
        )}
        <button
          onClick={handleToggleIndex}
          disabled={loading}
          className={
            "mt-3 w-full text-xs font-semibold py-2 rounded-md border-none cursor-pointer transition-opacity hover:brightness-110 disabled:opacity-50" +
            (book.indexed ? " bg-green-600 text-white" : " bg-orange-500 text-white")
          }
        >
          {loading ? "…" : book.indexed ? "Remove from index" : "Index"}
        </button>
      </div>
    </Link>
  );
}
