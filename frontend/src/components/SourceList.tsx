"use client";

import Link from "next/link";
import { useBookTitles } from "@/lib/api";
import { BookIcon } from "@/components/icons";

export type SourceWeight = "normal" | "emphasise" | "primary";

const WEIGHT_HINT =
  "Normal: read in proportion to its length.\n" +
  "Emphasise: read about 3x as much in each refine.\n" +
  "Primary: emphasised, and wins when books disagree.";

/**
 * The books a sheet was built from, one row each. A sheet can offer a reading weight
 * per book (`onWeight`) and a way to mark a book's passages unread (`onReset`), so a
 * refine can read them again. Resetting deletes nothing.
 */
export default function SourceList({
  ids,
  weights,
  onWeight,
  onReset,
  busy,
  empty = "None. Written by hand.",
}: {
  ids: number[];
  /** Calibre id (as a string) -> weight; a book that is absent is "normal". */
  weights?: Record<string, string>;
  onWeight?: (id: number, weight: SourceWeight) => void;
  onReset?: (id: number, title: string) => void;
  busy?: boolean;
  empty?: string;
}) {
  const { titleOf } = useBookTitles(ids);

  if (ids.length === 0) return <p className="italic text-muted">{empty}</p>;
  const books = ids.map((id) => ({ id, title: titleOf(id) }));

  return (
    <ul className="mt-1 w-full space-y-1.5">
      {books.map(({ id, title }) => {
        const weight = (weights?.[String(id)] as SourceWeight | undefined) ?? "normal";
        return (
          <li key={id} className="space-y-1 rounded-lg bg-background px-2 py-1.5">
            <Link
              href={`/book/${id}`}
              title={`${title} (Calibre #${id})`}
              className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
            >
              <BookIcon className="h-4 w-4" /> <span className="min-w-0 truncate">{title}</span>
            </Link>
            {(onWeight || onReset) && (
              <div className="flex items-center gap-1">
                {onWeight && (
                  <select
                    value={weight}
                    onChange={(e) => onWeight(id, e.target.value as SourceWeight)}
                    disabled={busy}
                    title={WEIGHT_HINT}
                    aria-label={`Reading weight for ${title}`}
                    className={`min-w-0 flex-1 cursor-pointer rounded bg-card px-1 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 ${
                      weight === "normal" ? "text-muted" : "text-highlight"
                    }`}
                  >
                    <option value="normal">Normal</option>
                    <option value="emphasise">Emphasise</option>
                    <option value="primary">Primary</option>
                  </select>
                )}
                {onReset && (
                  <button
                    type="button"
                    onClick={() => onReset(id, title)}
                    disabled={busy}
                    title="Mark this book's passages unread, so the next refine can read them all again. Nothing is deleted."
                    aria-label={`Mark ${title} unread`}
                    className="flex h-6 flex-none cursor-pointer items-center justify-center rounded bg-card px-1.5 text-xs text-muted transition-colors hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    ↺ Re-read
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
