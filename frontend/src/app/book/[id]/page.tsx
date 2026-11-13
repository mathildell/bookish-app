"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchBook } from "@/lib/api";
import type { BookDetail } from "@/types/book";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import { indexBook, unindexBook, writeObsidianReview, fetchSettingsSummary } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { CharacterIcon, ChatIcon } from "@/components/icons";

/* Calibre is READ-ONLY — the app must never write to the Calibre database.
   All note/field mutations go only to Obsidian review files or local state. */

/** Genre chips are tinted by their main category ("Fantasy" for "Fantasy.Dark"). */
function genreCategory(genre: string) {
  return genre.split(".", 1)[0].trim();
}

function withAlpha(hex: string, alpha: string) {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : undefined;
}

// Shared look for the external-link chips (Goodreads, Calibre).
const LINK_CHIP =
  "rounded-lg bg-card hover:bg-highlight hover:text-background px-3 py-1.5 text-xs font-medium transition-colors";

export default function BookDetailPage() {
  const params = useParams();
  const id = Number(params.id ?? 0);
  const router = useRouter();

  const { data: book, isLoading } = useQuery({
    queryKey: ["book", id],
    queryFn: () => fetchBook(id),
  });

  if (isLoading) return <div className="py-8 text-muted">Loading…</div>;
  if (!book)
    return (
      <div className="text-center py-12 text-muted">
        Book not found.{" "}
        <a href="/" className="underline">
          Back to library
        </a>
      </div>
    );

  return <BookDetailContent book={book} />;
}

function BookDetailContent({ book }: { book: BookDetail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ["settings", "summary"],
    queryFn: fetchSettingsSummary,
  });
  const genreColors = settings?.genre_colors;
  // Configured library URL; a trailing "&" would double up with the book_id we append.
  const calibreUrl = (settings?.calibre_url ?? "").trim().replace(/&+$/, "");
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

  // Index state decides whether the chat button exists, so refresh the cached
  // book record as well as the server-rendered tree.
  const refreshBook = () => {
    queryClient.invalidateQueries({ queryKey: ["book", book.id] });
    router.refresh();
  };

  const onIndex = async () => {
    await indexBook(book.id);
    refreshBook();
  };
  const onUnindex = async () => {
    await unindexBook(book.id);
    refreshBook();
  };

  return (
    <div className="grid grid-cols-4 gap-8 pt-4">
      {/* Left: cover + metadata */}
      <div className="col-span-1 space-y-4">
        <div className="rounded-xl overflow-hidden shadow-lg bg-card w-full max-w-xs mx-auto">
          {book.cover_uri ? (
            <img src={book.cover_uri} alt={book.title} className="w-full object-contain" />
          ) : (
            <div className="flex items-center justify-center h-full text-muted py-6">No cover</div>
          )}
        </div>

        {/* Index toggle + chat */}
        <div className="space-y-2">
          <button
            onClick={book.indexed ? onUnindex : onIndex}
            className={`w-full py-2 rounded-lg text-sm font-semibold text-white border-none cursor-pointer transition-colors ${
              book.indexed
                ? "bg-red-500 hover:bg-red-700"
                : "bg-green-500 hover:bg-green-700"
            }`}
          >
            {book.indexed ? "Remove from index" : "Index this book"}
          </button>

          {/* Chat and character extraction both read the index, so they only
              appear once the book has content in it. */}
          {book.indexed && (
            <>
              <Link
                href={`/chat?ids=${book.id}`}
                className="flex gap-2 items-center justify-center w-full py-2 rounded-lg text-center text-sm font-semibold bg-card shadow-sm shadow-accent hover:shadow-none hover:bg-accent transition-colors"
              >
                <ChatIcon className="w-6 h-6" /> Chat with this book
              </Link>
              <Link
                href={`/characters/extract?ids=${book.id}`}
                className="flex gap-2 items-center justify-center w-full py-2 rounded-lg text-center text-sm font-semibold bg-card shadow-sm shadow-accent hover:shadow-none hover:bg-accent transition-colors"
              >
                <CharacterIcon /> Extract characters
              </Link>
            </>
          )}
        </div>

        {/* Metadata */}
        <dl className="space-y-2 text-sm">
          {book.authors.length > 0 && (
            <div><dt className="text-muted">Authors</dt><dd>{book.authors.join(", ")}</dd></div>
          )}
          {book.series_name && (
            <div><dt className="text-muted">Series</dt><dd>{book.series_name}{book.series_index != null ? ` #${book.series_index}` : ""}</dd></div>
          )}
          {book.publisher && (
            <div><dt className="text-muted">Publisher</dt><dd>{book.publisher}</dd></div>
          )}
          <div><dt className="text-muted">My Rating</dt><dd>{renderRating(book.goodreads_rating)}</dd></div>
          {book.page_count != null && (
            <div><dt className="text-muted">Pages</dt><dd>{book.page_count}</dd></div>
          )}
          {book.word_count != null && (
            <div><dt className="text-muted">Words</dt><dd>{book.word_count.toLocaleString()}</dd></div>
          )}
          <div><dt className="text-muted">Added</dt><dd>{fmtDate(book.date_added)}</dd></div>
          <div><dt className="text-muted">Read</dt><dd>{fmtDate(book.date_read)}</dd></div>
          {isArc && (
            <div><dt className="text-muted">NetGalley deadline</dt><dd>{fmtDate(book.netgalley_deadline)}</dd></div>
          )}
        </dl>

      </div>

      {/* Right: tags, links, blurb, notes, review */}
      <div className="col-span-3 space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">{book.title}</h1>

        {/* Genres (tinted by category) followed by tags */}
        {(genres.length > 0 || tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {genres.map((genre) => {
              const color = genreColors?.[genreCategory(genre)];
              return (
                <span
                  key={`genre-${genre}`}
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    color ? "" : "bg-card border-transparent"
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
            {tags.map((tag) => (
              <span
                key={`tag-${tag}`}
                className="bg-card rounded-full px-2 py-0.5 text-xs"
              >
                <span className="text-muted">#</span> {tag}
              </span>
            ))}
          </div>
        )}

        {/* External links */}
        {(book.goodreads_id || calibreUrl) && (
          <div className="flex flex-wrap gap-2">
            {book.goodreads_id && (
              <a
                href={`https://www.goodreads.com/book/show/${book.goodreads_id}`}
                target="_blank"
                rel="noreferrer"
                title="Open this book on Goodreads"
                className={LINK_CHIP}
              >
                Goodreads ↗
              </a>
            )}
            {calibreUrl && (
              <a
                href={`${calibreUrl}&book_id=${book.id}`}
                target="_blank"
                rel="noreferrer"
                title="Open this book in Calibre"
                className={LINK_CHIP}
              >
                Calibre ↗
              </a>
            )}
          </div>
        )}

        {/* Blurb */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Blurb</h2>
          <div className="w-full text-foreground max-w-none min-h-[120px] max-h-[420px] overflow-auto bg-card shadow-sm shadow-border rounded-lg px-4 py-3 text-sm prose prose-sm rich-text">
            {book.blurb ? (
              <div dangerouslySetInnerHTML={{ __html: book.blurb }} />
            ) : (
              <div className="text-muted italic py-6 text-center">No blurb for this book.</div>
            )}
          </div>
        </section>

        {/* Calibre notes */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Calibre notes</h2>
          <div className="w-full max-w-none min-h-[120px] max-h-[420px] overflow-auto bg-card shadow-sm shadow-border rounded-lg px-4 py-3 text-sm prose prose-sm rich-text">
            {book.personal_notes ? (
              <div dangerouslySetInnerHTML={{ __html: book.personal_notes }} />
            ) : (
              <div className="text-muted italic py-6 text-center">No Calibre notes for this book.</div>
            )}
          </div>
        </section>

        {/* Obsidian review (markdown) */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Obsidian review</h2>
          <ObsidianTab book={book} />
        </section>
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
    <div className="space-y-3 mb-6">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
        }}
        placeholder="Write your review in markdown…"
        className="w-full h-[500px] bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono text-zinc-100 resize-none focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-card transition-colors hover:text-background hover:bg-highlight font-semibold px-4 py-2 rounded-lg text-sm disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {status && (
          <span
            role="status"
            className={`text-sm ${status.ok ? "text-green-700" : "text-red-700"}`}
          >
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}
