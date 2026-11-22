"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { extractWorld, useBookTitles, useWorlds } from "@/lib/api";
import { parseIds } from "@/lib/format";
import { BookIcon } from "@/components/icons";

export default function ExtractWorldPage() {
  return (
    <Suspense fallback={<div className="py-8 text-muted">Loading…</div>}>
      <ExtractContent />
    </Suspense>
  );
}

function ExtractContent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [bookIds, setBookIds] = useState<number[]>([]);
  const [name, setName] = useState("");
  const [guidance, setGuidance] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { data: worlds } = useWorlds();

  useEffect(() => {
    setBookIds(parseIds(searchParams.get("ids")));
  }, [searchParams]);

  const { titleOf } = useBookTitles(bookIds);

  // Leaving the page stops the run instead of leaving the model working for nobody.
  useEffect(() => () => abortRef.current?.abort(), []);

  const existing = (worlds ?? []).find((w) => w.name.trim().toLowerCase() === name.trim().toLowerCase());

  async function start() {
    if (!name.trim() || bookIds.length === 0 || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setLog([]);
    try {
      for await (const event of extractWorld(
        { name: name.trim(), calibre_ids: bookIds, guidance },
        controller.signal
      )) {
        if (event.kind === "progress") setLog((prev) => [...prev, event.message]);
        else if (event.kind === "error") setError(event.error);
        else if (event.kind === "ok") {
          queryClient.invalidateQueries({ queryKey: ["worlds"] });
          router.push(`/worlds/${event.world.id}`);
          return;
        }
      }
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") {
        setError(e instanceof Error ? e.message : "World extraction failed");
      }
    } finally {
      setRunning(false);
    }
  }

  const INPUT =
    "w-full rounded-lg bg-background px-3 py-2 text-sm placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50";

  return (
    <div className="mx-auto max-w-2xl space-y-5 py-6">
      <div>
        <Link href="/worlds" className="text-xs text-muted hover:text-accent">
          ← Worlds
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Extract a world</h1>
        <p className="mt-1 text-sm text-muted">
          Reads passages across the selected books and writes one worldbuilding sheet: the rules,
          society, conventions and vocabulary. Where the books disagree, the difference is kept.
        </p>
      </div>

      <section className="space-y-2 rounded-xl bg-card p-4 shadow-sm shadow-border">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Books</p>
        {bookIds.length === 0 ? (
          <p className="text-sm italic text-muted">
            No books selected. Pick some in the <Link href="/" className="underline">library</Link> first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {bookIds.map((id) => (
              <span
                key={id}
                className="max-w-full truncate rounded-full border border-background px-2 py-1 text-xs leading-3 text-muted"
              >
                <BookIcon className="mr-0.5 inline h-4 w-4" /> {titleOf(id)}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl bg-card p-4 shadow-sm shadow-border">
        <label className="block space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">World name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Omegaverse"
            disabled={running}
            className={INPUT}
          />
          {existing && (
            <span className="block text-xs text-muted">
              A world with this name exists. It will be extended; fields you edited by hand stay as they are.
            </span>
          )}
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Notes for the reader (optional)
          </span>
          <textarea
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            rows={3}
            placeholder="e.g. Focus on biology and scent bonding; ignore the workplace setting."
            disabled={running}
            className={INPUT}
          />
        </label>
        <button
          type="button"
          onClick={start}
          disabled={running || !name.trim() || bookIds.length === 0}
          className="cursor-pointer rounded-lg bg-background px-5 py-2 text-sm font-semibold shadow-sm shadow-border transition-colors hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? "Reading…" : "Extract world"}
        </button>
        <p className="text-xs text-muted">
          This takes a few minutes: about 70 passages are read across the books, then merged.
        </p>
      </section>

      {(log.length > 0 || error) && (
        <section className="space-y-1 rounded-xl bg-card p-4 text-xs shadow-sm shadow-border">
          {log.map((line, i) => (
            <p key={i} className={i === log.length - 1 && running ? "animate-pulse" : "text-muted"}>
              {line}
            </p>
          ))}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </section>
      )}
    </div>
  );
}
