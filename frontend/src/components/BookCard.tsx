"use client";

import type { BookCard as BookCardType } from "@/types/book";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { indexBook, unindexBook } from "@/lib/api";
import { CheckIcon } from "@/components/icons";

function renderMoons(rating: number | null | undefined) {
  if (rating == null) return "";
  const halves = Math.round(rating);
  const full = Math.floor(halves / 2);
  const half = halves % 2;
  const empty = 5 - full - half;
  return "🌕".repeat(full) + "🌗".repeat(half) + "🌑".repeat(empty);
}

export default function BookCard({ book, selectedId, onToggleSelect, indexing }: { book: BookCardType; selectedId?: number | null; onToggleSelect?: (id: number) => void; indexing?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSelected = selectedId === book.id && !!onToggleSelect;
  // `indexing` comes from the batch flow, `loading` from this card's own button.
  const busy = loading || !!indexing;

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const showNotice = (ok: boolean, text: string) => {
    setNotice({ ok, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  };

  const handleToggleIndex = async (e: React.MouseEvent) => {
    // The whole card is a link — without preventDefault the click follows it to /book/{id}.
    e.preventDefault();
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      if (book.indexed) {
        await unindexBook(book.id);
        showNotice(true, "Removed from index");
      } else {
        // Indexing can take a while
        await indexBook(book.id);
        showNotice(true, "Indexed");
      }
      // Refresh the grid so the card's state and the "N indexed" counter stay truthful.
      queryClient.invalidateQueries({ queryKey: ["books"] });
    } catch {
      showNotice(false, "Couldn't update index");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Link
      href={`/book/${book.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group relative w-[180px] h-[270px] rounded-xl overflow-hidden cursor-pointer shadow-lg shadow-black/30 hover:shadow-xl transition-shadow duration-200${book.indexed ? "" : " opacity-50"}`}
    >
      {/* Selection checkbox */}
      {onToggleSelect && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSelect(book.id);
          }}
          className={`absolute top-2 left-2 z-20 w-6 h-6 rounded-md flex items-center justify-center transition-all ${
            isSelected
              ? "bg-yellow-500 shadow-md"
              : "bg-zinc-900/80 border border-zinc-600 hover:border-yellow-500"
          }`}
        >
          <CheckIcon className={isSelected ? "text-zinc-900" : "text-transparent"} />
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
          disabled={busy}
          className={
            "mt-3 w-full text-xs font-semibold py-2 rounded-md border-none cursor-pointer transition-opacity hover:brightness-110 disabled:opacity-50" +
            (book.indexed ? " bg-green-600 text-white" : " bg-orange-500 text-white")
          }
        >
          {busy ? "…" : book.indexed ? "Remove from index" : "Index"}
        </button>
      </div>

      {/* Discreet in-card loading overlay */}
      {busy && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-zinc-950/70">
          <span className="flex items-center gap-2 text-[11px] font-semibold text-zinc-100">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-yellow-400" />
            {book.indexed ? "Removing…" : "Indexing…"}
          </span>
        </div>
      )}

      {/* Transient result of the last index action */}
      {notice && (
        <div
          className={`pointer-events-none absolute right-2 top-2 z-40 rounded-md px-2 py-1 text-[11px] font-semibold text-white shadow-md ${
            notice.ok ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {notice.ok ? "✓ " : "! "}
          {notice.text}
        </div>
      )}
    </Link>
  );
}
