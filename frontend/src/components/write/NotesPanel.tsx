"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { bookmarkNoteText, type Bookmark } from "@/lib/api";
import { ClearIcon } from "@/components/icons";
import { useWriteSession } from "./session";

/** What kind of thing a bookmark is, in the writer's terms. */
export function bookmarkKind(b: Bookmark): string {
  if (b.scope === "write") return "scene";
  if (b.scope === "discuss") return "discussion";
  return "answer";
}

/**
 * A pinned bookmark as a note. It shows what the model is sent: the bookmark's own note
 * if it has one, otherwise the start of the saved text. Editing sets that note.
 */
function PinnedNote({ bookmark, onError }: { bookmark: Bookmark; onError: (m: string) => void }) {
  const { saveBookmarkNote, setBookmarkPinned } = useWriteSession();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(bookmark.note ?? "");
  useEffect(() => setText(bookmark.note ?? ""), [bookmark.note]);

  return (
    <li className="space-y-1 rounded-lg bg-background px-2 py-1.5 text-xs leading-snug">
      <div className="flex items-center justify-between gap-1">
        <span className="text-muted">{bookmarkKind(bookmark)}</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing((on) => !on)}
            className="cursor-pointer text-muted transition-colors hover:text-foreground"
            title="Edit the note the model sees"
          >
            {editing ? "done" : "edit"}
          </button>
          <button
            type="button"
            onClick={() => setBookmarkPinned(bookmark, false).catch(() => onError("Couldn't unpin that bookmark"))}
            aria-label="Unpin"
            title="Unpin (the bookmark is kept)"
            className="cursor-pointer text-muted transition-colors hover:text-red-500"
          >
            <ClearIcon />
          </button>
        </span>
      </div>
      {editing ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => saveBookmarkNote(bookmark, text).catch(() => onError("Couldn't save that note"))}
          rows={3}
          placeholder="What the model should know…"
          className="w-full resize-none rounded bg-card px-1.5 py-1 text-xs placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
      ) : (
        <p className="line-clamp-4">{bookmarkNoteText(bookmark, 240)}</p>
      )}
    </li>
  );
}

/** Canon the model is told to respect: pinned bookmarks first, then freeform notes. */
export default function NotesPanel() {
  const { pinned, notes, saveNotes, openPicker } = useWriteSession();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const total = pinned.length + notes.length;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted hover:text-foreground"
      >
        <span>Notes{total ? ` (${total})` : ""}</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-muted">Pinned bookmarks</p>
            {pinned.length === 0 && (
              <p className="text-xs leading-snug text-muted">
                Pin a saved scene, discussion or answer and the model treats it as established canon.
                &ldquo;Pin as note&rdquo; under any reply saves and pins it in one go.
              </p>
            )}
            <ul className="space-y-1.5">
              {pinned.map((bookmark) => (
                <PinnedNote key={bookmark.id} bookmark={bookmark} onError={setError} />
              ))}
            </ul>
            <button
              type="button"
              onClick={() => openPicker("bookmarks")}
              className="w-full cursor-pointer rounded-lg bg-background py-1 text-xs font-semibold text-muted shadow-sm shadow-border transition-colors hover:bg-highlight hover:text-card"
            >
              + Pin a bookmark
            </button>
            <Link href="/bookmarks" className="block text-xs text-muted underline transition-colors hover:text-foreground">
              Manage bookmarks
            </Link>
          </div>

          <div className="space-y-1.5 border-t border-background pt-2">
            <p className="text-xs font-semibold text-muted">Freeform notes</p>
            <p className="text-xs leading-snug text-muted">Not saved as bookmarks; kept in this browser.</p>
            <ul className="space-y-1">
              {notes.map((note, i) => (
                <li key={`${i}-${note}`} className="group/note flex items-start gap-1.5 text-xs leading-snug">
                  <span className="min-w-0 flex-1">{note}</span>
                  <button
                    type="button"
                    onClick={() => saveNotes(notes.filter((_, j) => j !== i))}
                    aria-label="Remove note"
                    className="mt-0.5 flex-none cursor-pointer text-muted opacity-0 transition-opacity hover:text-red-500 group-hover/note:opacity-100 focus:opacity-100"
                  >
                    <ClearIcon />
                  </button>
                </li>
              ))}
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const text = draft.trim();
                if (text) saveNotes([...notes, text]);
                setDraft("");
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add a note…"
                className="w-full rounded-lg bg-background px-2.5 py-1.5 text-xs placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </form>
            {notes.length > 0 && (
              <button
                type="button"
                onClick={() => saveNotes([])}
                className="cursor-pointer text-xs text-muted transition-colors hover:text-accent"
              >
                Clear freeform notes
              </button>
            )}
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
