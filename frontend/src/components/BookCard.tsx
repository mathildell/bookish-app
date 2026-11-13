"use client";

import type { BookCard as BookCardType } from "@/types/book";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { indexBook } from "@/lib/api";
import { CheckIcon, ChatIcon, IndexAdd } from "@/components/icons";

// Card action chip: same base for both states, colour differs.
const CARD_ACTION =
  "mt-3 flex w-full items-center justify-center gap-1.5 rounded-md shadow-xs shadow-border border-none py-2 text-xs font-semibold cursor-pointer transition-colors";

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
  const router = useRouter();
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

  const handleIndex = async (e: React.MouseEvent) => {
    // The whole card is a link — without preventDefault the click follows it to /book/{id}.
    e.preventDefault();
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      // Indexing can take a while
      await indexBook(book.id);
      showNotice(true, "Indexed");
      // Refresh the grid so the card's state and the "N indexed" counter stay truthful.
      queryClient.invalidateQueries({ queryKey: ["books"] });
    } catch {
      showNotice(false, "Couldn't update index");
    } finally {
      setLoading(false);
    }
  };

  const openChat = (e: React.MouseEvent) => {
    // Not a nested <Link>: an <a> inside the card's <a> breaks hydration.
    e.preventDefault();
    e.stopPropagation();
    router.push(`/chat?ids=${book.id}`);
  };

  return (
    <Link
      href={`/book/${book.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group relative w-[180px] h-[270px] rounded-xl overflow-hidden cursor-pointer shadow-sm shadow-border hover:shadow-lg hover:shadow-black/50 transition-shadow duration-200${book.indexed ? "" : " opacity-50"}`}
    >
      {/* Selection checkbox */}
      {onToggleSelect && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSelect(book.id);
          }}
          className={`absolute top-2 left-2 z-20 w-6 h-6 border shadow-xs shadow-black/60 rounded-md flex items-center justify-center transition-all cursor-pointer hover:ring-2 hover:ring-accent ${
            isSelected
              ? "bg-highlight/90 border border-accent"
              : "bg-card/80 border-border hover:bg-card"
          }`}
        >
          <CheckIcon className={isSelected ? "text-accent p-0.5" : "text-transparent"} />
        </button>
      )}
      {/* Cover image (fallback placeholder) */}
      <div className="absolute inset-0 bg-background flex items-center justify-center">
        {book.cover_uri ? (
          <img
            src={book.cover_uri}
            alt={book.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-muted text-xs">No cover</span>
        )}
      </div>

      {/* Hover overlay */}
      <div
        className={
          "absolute inset-x-0 bottom-0 bg-card p-4 transition-all duration-300 ease-out" +
          (hovered ? " max-h-[100%] opacity-100" : " max-h-0 opacity-0 overflow-hidden")
        }
      >
        <p className="font-bold text-sm leading-snug line-clamp-3 mb-1">{book.title}</p>
        <p className="text-xs text-muted italic line-clamp-2">
          {book.authors.join(", ") || "Unknown"}
        </p>
        {book.series_name && (
          <p className="text-xs text-muted mt-0.5 line-clamp-1">
            {book.series_name}
            {book.series_index != null ? ` #${book.series_index}` : ""}
          </p>
        )}
        {book.goodreads_rating != null && (
          <p className="text-xs mt-1">{renderMoons(book.goodreads_rating)}</p>
        )}

        {book.indexed ? (
          // Indexed → its text is searchable, so offer the chat right from the card.
          <button onClick={openChat} className={`${CARD_ACTION} bg-background hover:bg-highlight hover:text-background`}>
            <ChatIcon className="h-4 w-4" />
            Chat
          </button>
        ) : (
          <button onClick={handleIndex} disabled={busy} className={`${CARD_ACTION} bg-green-600/80 hover:bg-green-700 text-white disabled:bg-muted`}>
            <IndexAdd className="h-4 w-4" />
            Index
          </button>
        )}
      </div>

      {/* Discreet in-card loading overlay */}
      {busy && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-zinc-950/70">
          <span className="flex items-center gap-2 text-[11px] font-semibold text-zinc-100">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-highlight" />
            Indexing…
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
