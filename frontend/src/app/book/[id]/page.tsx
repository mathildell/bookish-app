"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchBook } from "@/lib/api";
import type { BookDetail } from "@/types/book";
import { useParams, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import ChatInterface from "@/components/ChatInterface";
import { indexBook, unindexBook, writeObsidianReview, fetchGenreColors } from "@/lib/api";

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" });
  } catch {
    return iso;
  }
}

/* Calibre is READ-ONLY — the app must never write to the Calibre database.
   All note/field mutations go only to Obsidian review files or local state. */

/** Genre chips are tinted by their main category ("Fantasy" for "Fantasy.Dark"). */
function genreCategory(genre: string) {
  return genre.split(".", 1)[0].trim();
}

function withAlpha(hex: string, alpha: string) {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : undefined;
}

export default function BookDetailPage() {
  const params = useParams();
  const id = Number(params.id ?? 0);
  const router = useRouter();

  const { data: book, isLoading } = useQuery({
    queryKey: ["book", id],
    queryFn: () => fetchBook(id),
  });

  if (isLoading) return <div className="text-zinc-500 py-8">Loading…</div>;
  if (!book)
    return (
      <div className="text-center py-12 text-zinc-400">
        Book not found.{" "}
        <a href="/" className="text-yellow-500 underline">
          Back to library
        </a>
      </div>
    );

  return <BookDetailContent book={book} />;
}

function BookDetailContent({ book }: { book: BookDetail }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"blurb" | "notes" | "obsidian">("blurb");
  const { data: genreColors } = useQuery({
    queryKey: ["settings", "genre-colors"],
    queryFn: fetchGenreColors,
  });
  const isArc = (book.tags ?? []).some((t) => t.trim().toLowerCase() === "arc");
  const tags = (book.tags ?? []).filter((t) => t.trim());
  const genres = (book.genres ?? []).filter((g) => g.trim());

  const renderRating = (rating: number | null | undefined) => {
    if (rating == null) return "—";
    const halves = Math.round(rating);
    const full = Math.floor(halves / 2);
    const half = halves % 2;
    const empty = 5 - full - half;
    return "🌕".repeat(full) + "🌗".repeat(half) + "🌑".repeat(empty);
  };

  const onIndex = async () => {
    await indexBook(book.id);
    router.refresh();
  };
  const onUnindex = async () => {
    await unindexBook(book.id);
    router.refresh();
  };

  return (
    <div className="grid grid-cols-4 gap-8">
      {/* Left: cover + metadata */}
      <div className="col-span-1 space-y-4">
        <div className="rounded-xl overflow-hidden shadow-lg bg-zinc-900 w-full max-w-xs mx-auto">
          {book.cover_uri ? (
            <img src={book.cover_uri} alt={book.title} className="w-full object-contain" />
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-600">No cover</div>
          )}
        </div>

        {/* Index toggle */}
        <div>
          <button
            onClick={book.indexed ? onUnindex : onIndex}
            className={`w-full py-2 rounded-lg text-sm font-semibold border-none cursor-pointer ${
              book.indexed
                ? "bg-green-600 hover:bg-green-500 text-white"
                : "bg-orange-500 hover:bg-orange-400 text-white"
            }`}
          >
            {book.indexed ? "Remove from index" : "Index this book"}
          </button>
        </div>

        {/* Metadata */}
        <dl className="space-y-2 text-sm">
          {book.authors.length > 0 && (
            <div><dt className="text-zinc-500">Authors</dt><dd>{book.authors.join(", ")}</dd></div>
          )}
          {book.series_name && (
            <div><dt className="text-zinc-500">Series</dt><dd>{book.series_name}{book.series_index != null ? ` #${book.series_index}` : ""}</dd></div>
          )}
          {book.publisher && (
            <div><dt className="text-zinc-500">Publisher</dt><dd>{book.publisher}</dd></div>
          )}
          <div><dt className="text-zinc-500">My Rating</dt><dd>{renderRating(book.goodreads_rating)}</dd></div>
          {book.page_count != null && (
            <div><dt className="text-zinc-500">Pages</dt><dd>{book.page_count}</dd></div>
          )}
          {book.word_count != null && (
            <div><dt className="text-zinc-500">Words</dt><dd>{book.word_count.toLocaleString()}</dd></div>
          )}
          <div><dt className="text-zinc-500">Added</dt><dd>{fmtDate(book.date_added)}</dd></div>
          <div><dt className="text-zinc-500">Read</dt><dd>{fmtDate(book.date_read)}</dd></div>
          {isArc && (
            <div><dt className="text-zinc-500">NetGalley deadline</dt><dd>{fmtDate(book.netgalley_deadline)}</dd></div>
          )}
        </dl>

        {/* Tags and genres */}
        {tags.length > 0 && (
          <div>
            <div className="text-sm text-zinc-500 mb-1">Tags</div>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="bg-zinc-800 text-zinc-200 rounded-full px-2 py-0.5 text-xs"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {genres.length > 0 && (
          <div>
            <div className="text-sm text-zinc-500 mb-1">Genres</div>
            <div className="flex flex-wrap gap-1.5">
              {genres.map((genre) => {
                const color = genreColors?.[genreCategory(genre)];
                return (
                  <span
                    key={genre}
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      color ? "" : "bg-yellow-500/10 text-yellow-300 border-transparent"
                    }`}
                    style={
                      color
                        ? {
                            backgroundColor: withAlpha(color, "1a"),
                            borderColor: withAlpha(color, "40"),
                            color,
                          }
                        : undefined
                    }
                  >
                    {genre}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Right: tabs + chat */}
      <div className="col-span-3 space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">{book.title}</h1>

        {/* Tags */}

        {/* Tabs */}
        <div>
          <div className="flex gap-4 border-b border-zinc-800 mb-4">
            {(["blurb", "notes", "obsidian"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`pb-2 text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? "text-yellow-400 border-b-2 border-yellow-400"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {activeTab === "blurb" && (
            <div className="w-full min-h-[200px] max-h-screen overflow-auto bg-stone-900 border border-stone-700 rounded-lg px-4 py-3 text-sm text-stone-200 prose prose-invert prose-sm rich-text">
              {book.blurb ? (
                <div dangerouslySetInnerHTML={{ __html: book.blurb }} />
              ) : (
                <div className="text-stone-500 italic py-8 text-center">No blurb for this book.</div>
              )}
            </div>
          )}

          {activeTab === "notes" && (
            <div className="w-full min-h-[200px] max-h-screen overflow-auto bg-stone-900 border border-stone-700 rounded-lg px-4 py-3 text-sm text-stone-200 prose prose-invert prose-sm rich-text">
              {book.personal_notes ? (
                <div dangerouslySetInnerHTML={{ __html: book.personal_notes }} />
              ) : (
                <div className="text-stone-500 italic py-8 text-center">No Calibre notes for this book.</div>
              )}
            </div>
          )}

          {activeTab === "obsidian" && (
            <ObsidianTab book={book} />
          )}
        </div>

        {/* Single-book chat */}
        <ChatInterface
          calibreIds={[book.id]}
          scope="book"
          placeholder={`Ask about ${book.title}…`}
          welcomeMessage={<>📖 Ask me anything about <strong>{book.title}</strong>! I'll search the indexed content.</>}
        />
      </div>
    </div>
  );
}

function ObsidianTab({ book }: { book: BookDetail }) {
  const router = useRouter();
  const [text, setText] = useState(book.obsidian_review ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // Sync local state when the fetched review changes (e.g. after save refresh)
  useEffect(() => {
    setText(book.obsidian_review ?? "");
  }, [book.obsidian_review]);

  const onSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const result = await writeObsidianReview(book.id, text);
      if (result?.ok) {
        setStatus({ ok: true, message: "Review saved to your Obsidian vault." });
        router.refresh();
      } else {
        setStatus({
          ok: false,
          message:
            "Could not write the review to disk. The book may be missing a Goodreads ID, the review may be empty, or the vault path may not be writable.",
        });
      }
    } catch (err) {
      setStatus({
        ok: false,
        message: `Could not write the review to disk: ${err instanceof Error ? err.message : "unknown error"}`,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
        }}
        placeholder="Write your review in markdown…"
        className="w-full h-[500px] bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono text-zinc-100 resize-none focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-yellow-600 hover:bg-yellow-500 text-zinc-900 font-semibold px-4 py-2 rounded-lg text-sm disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {status && (
          <span
            role="status"
            className={`text-sm ${status.ok ? "text-green-400" : "text-red-400"}`}
          >
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}
