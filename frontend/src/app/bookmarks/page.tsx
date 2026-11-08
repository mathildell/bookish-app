"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { deleteBookmark, fetchBookmarks, updateBookmark, type Bookmark } from "@/lib/api";

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** How much of the library the answer was actually grounded in. */
function scopeLabel(bookmark: Bookmark) {
  if (bookmark.scope === "write") return "written scene";
  const n = bookmark.calibre_ids?.length ?? 0;
  if (n === 0) return "whole library";
  if (n === 1) return "1 book";
  return `${n} books`;
}

function chatHref(bookmark: Bookmark) {
  if (bookmark.scope === "write") return "/write";
  const ids = bookmark.calibre_ids ?? [];
  return ids.length ? `/chat?ids=${ids.join(",")}` : "/chat";
}

export default function BookmarksPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: bookmarks, isLoading } = useQuery({
    queryKey: ["bookmarks"],
    queryFn: fetchBookmarks,
  });

  const removeMut = useMutation({
    mutationFn: (id: number) => deleteBookmark(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bookmarks"] }),
  });

  const noteMut = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => updateBookmark(id, { note }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bookmarks"] }),
  });

  const all = bookmarks ?? [];
  const q = search.trim().toLowerCase();
  const shown = q
    ? all.filter(
        (b) =>
          b.question.toLowerCase().includes(q) ||
          b.answer.toLowerCase().includes(q) ||
          (b.note ?? "").toLowerCase().includes(q) ||
          b.citations.some((c) => c.title.toLowerCase().includes(q))
      )
    : all;

  if (isLoading) return <div className="text-zinc-500 py-8">Loading your notes…</div>;

  return (
    <div className="space-y-6 pt-5 pb-16">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Bookmarks</h1>
        <p className="text-sm text-zinc-500">
          {shown.length} saved answer{shown.length === 1 ? "" : "s"}
          {q && all.length !== shown.length ? ` of ${all.length}` : ""} — hit 🔖 on any chat answer to
          keep it here.
        </p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search questions, answers, notes, cited books…"
          className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
        />
      </header>

      {shown.length === 0 ? (
        <div className="text-zinc-500 text-center py-16">
          {all.length > 0 ? (
            "No notes match your search."
          ) : (
            <>
              No bookmarks yet. Ask something in{" "}
              <Link href="/chat" className="text-yellow-500 underline">
                chat
              </Link>{" "}
              and save the answer.
            </>
          )}
        </div>
      ) : (
        <div className="columns-1 md:columns-2 xl:columns-3 gap-4">
          {shown.map((bookmark) => (
            <BookmarkCard
              key={bookmark.id}
              bookmark={bookmark}
              onDelete={() => removeMut.mutate(bookmark.id)}
              onSaveNote={(note) => noteMut.mutate({ id: bookmark.id, note })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BookmarkCard({
  bookmark,
  onDelete,
  onSaveNote,
}: {
  bookmark: Bookmark;
  onDelete: () => void;
  onSaveNote: (note: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState(bookmark.note ?? "");

  return (
    <article className="mb-4 break-inside-avoid rounded-xl border border-yellow-600/25 bg-yellow-500/[0.05] p-4 space-y-3">
      <p className="text-[10px] uppercase tracking-wider text-yellow-600/90">In response to</p>
      <p className="text-sm text-zinc-200 leading-snug">
        {bookmark.question ? `“${bookmark.question}”` : "(question not recorded)"}
      </p>

      <div
        className={`text-sm text-zinc-300 prose prose-invert prose-sm max-w-none ${
          expanded ? "" : "max-h-40 overflow-hidden"
        }`}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{bookmark.answer}</ReactMarkdown>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-yellow-500 hover:text-yellow-400 transition-colors"
      >
        {expanded ? "Show less" : "Show full answer"}
      </button>

      {bookmark.citations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {bookmark.citations.map((c, i) =>
            c.calibre_id ? (
              <Link
                key={`${c.calibre_id}-${i}`}
                href={`/book/${c.calibre_id}`}
                className="text-[11px] bg-zinc-800/80 text-zinc-300 px-2 py-0.5 rounded-full hover:text-white transition-colors"
              >
                📖 {c.title}
              </Link>
            ) : (
              <span
                key={`${c.title}-${i}`}
                className="text-[11px] bg-zinc-800/80 text-zinc-400 px-2 py-0.5 rounded-full"
              >
                📖 {c.title}
              </span>
            )
          )}
        </div>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== (bookmark.note ?? "")) onSaveNote(note);
        }}
        rows={2}
        placeholder="Add a note…"
        className="w-full bg-zinc-950/60 border border-zinc-700/70 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:ring-1 focus:ring-yellow-500/40"
      />

      <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
        <span>
          {fmtDate(bookmark.created_at)} · {scopeLabel(bookmark)}
        </span>
        <span className="flex items-center gap-3">
          <Link href={chatHref(bookmark)} className="hover:text-yellow-400 transition-colors">
            {bookmark.scope === "write" ? "Open in Write" : "Open in chat"}
          </Link>
          <button
            type="button"
            onClick={onDelete}
            title="Delete note"
            className="hover:text-red-400 transition-colors"
          >
            🗑
          </button>
        </span>
      </div>
    </article>
  );
}
