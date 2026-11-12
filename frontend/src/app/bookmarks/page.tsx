"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import NavSearchPortal from "@/components/NavSearchPortal";
import SearchBar from "@/components/SearchBar";
import { BookIcon, ChevronIcon, TrashIcon } from "@/components/icons";
import { deleteBookmark, fetchBookmarks, updateBookmark, type Bookmark } from "@/lib/api";
import { fmtDate } from "@/lib/format";

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
        <p className="text-sm">
          {shown.length} saved answer{shown.length === 1 ? "" : "s"}
          {q && all.length !== shown.length ? ` of ${all.length}` : ""}
        </p>
        <NavSearchPortal>
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search questions, answers, books…"
            debounceMs={0}
          />
        </NavSearchPortal>
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
    <article className="mb-4 break-inside-avoid rounded-xl shadow-sm shadow-border bg-card p-4 space-y-3">
      <p className="text-xs uppercase tracking-wider text-muted">In response to</p>
      <blockquote className="text-sm leading-snug border-l border-l-4 border-accent pl-4">
        {bookmark.question ? `“${bookmark.question}”` : "(question not recorded)"}
      </blockquote>

      <div
        className={`text-sm prose prose-sm max-w-none ${
          expanded ? "" : "max-h-40 overflow-hidden"
        }`}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{bookmark.answer}</ReactMarkdown>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs cursor-pointer transition-colors hover:text-foreground text-muted"
      >
        {expanded ? "Show less" : "Show full answer"}
        <span
          className={`inline-flex transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
        >
          <ChevronIcon />
        </span>
      </button>

      {bookmark.citations.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-background pt-4">
          {bookmark.citations.map((c, i) =>
            c.calibre_id ? (
              <Link
                key={`${c.calibre_id}-${i}`}
                href={`/book/${c.calibre_id}`}
                className="text-xs border border-background text-muted px-2 py-1 rounded-full transition-colors leading-3 hover:text-foreground hover:border-border flex gap-2"
              >
                <BookIcon /> <span>{c.title}</span>
              </Link>
            ) : (
              <span
                key={`${c.title}-${i}`}
                className="text-xs border border-background text-muted px-2 py-1 rounded-full transition-colors leading-3 hover:text-foreground hover:border-border flex gap-2"
              >
                <BookIcon /> {c.title}
              </span>
            )
          )}
        </div>
      )}

      <div className="pt-3 border-t border-background">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== (bookmark.note ?? "")) onSaveNote(note);
          }}
          rows={2}
          placeholder="Add a note…"
          className="w-full bg-background shadow-sm shadow-border rounded-lg px-2 py-1.5 text-xs placeholder-muted resize-none focus:outline-none focus:ring-1 focus:ring-accent focus:border-yellow"
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-muted mt-2">
        <span>
          {fmtDate(bookmark.created_at)} · {scopeLabel(bookmark)}
        </span>
        <span className="flex items-center gap-3">
          <Link href={chatHref(bookmark)} className="hover:text-highlight transition-colors">
            {bookmark.scope === "write" ? "Open in Write" : "Open in chat"}
          </Link>
          <button
            type="button"
            onClick={onDelete}
            title="Delete note"
            className="cursor-pointer hover:text-red-500 transition-colors"
          >
            <TrashIcon />
          </button>
        </span>
      </div>
    </article>
  );
}
