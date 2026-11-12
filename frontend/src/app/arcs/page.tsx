"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchArcs } from "@/lib/api";
import type { ArcBook } from "@/types/book";
import Link from "next/link";
import { useState } from "react";
import { fmtDate } from "@/lib/format";

const sortModes = ["deadline ↑", "deadline ↓", "overdue first"] as const;

/** NetGalley deadline as a timestamp, or null when unset/unparseable. */
function deadlineValue(arc: ArcBook): number | null {
  if (!arc.netgalley_deadline) return null;
  const t = new Date(arc.netgalley_deadline).getTime();
  return Number.isNaN(t) ? null : t;
}

/** True when the NetGalley deadline is before today (reviewed ARCs are no longer flagged overdue by the API). */
function isPastDeadline(iso?: string | null) {
  if (!iso) return false;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

export default function ArcTrackerPage() {
  const [sortMode, setSortMode] = useState<(typeof sortModes)[number]>("deadline ↓");

  const { data: arcs, isLoading } = useQuery({
    queryKey: ["arcs"],
    queryFn: fetchArcs,
  });

  if (isLoading) return <div className="text-foreground py-8">Loading…</div>;

  // Sort by the actual NetGalley date; ARCs without a deadline go last
  const sorted = [...(arcs || [])].sort((a: ArcBook, b: ArcBook) => {
    const aDue = deadlineValue(a);
    const bDue = deadlineValue(b);
    const missingLast = (): number => {
      if (aDue === null && bDue === null) return 0;
      if (aDue === null) return 1;
      if (bDue === null) return -1;
      return 0;
    };

    switch (sortMode) {
      case "deadline ↑":
        return missingLast() || (aDue as number) - (bDue as number);
      case "deadline ↓":
        return missingLast() || (bDue as number) - (aDue as number);
      case "overdue first":
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        return missingLast() || (bDue as number) - (aDue as number);
      default:
        return 0;
    }
  });

  // Counters
  const total = sorted.length;
  const overdueCount = sorted.filter((a) => a.overdue).length;
  const unreviewed = total - sorted.filter((a) => a.has_review).length;

  return (
    <div className="space-y-6 pt-6">
      <h1 className="text-2xl font-bold tracking-tight">ARC Tracker</h1>
      <p className="text-sm -mt-4">
        Track Advance Reader Copies: deadlines, review status, and quick-glance metrics.
      </p>

      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total ARCs", value: total },
          { label: "Overdue", value: overdueCount },
          { label: "Unreviewed", value: unreviewed },
        ].map(({ label, value }) => (
          <div key={label} className="bg-card shadow-sm shadow-border rounded-xl p-4 text-center">
            <dt className="text-xs uppercase tracking-wider mb-1">{label}</dt>
            <dd className="text-2xl font-bold">{value}</dd>
          </div>
        ))}
      </div>

      {/* Sort buttons */}
      <div className="flex gap-3 items-center">
        <label className="text-xs font-semibold uppercase text-muted mr-1">Sort:</label>
        {sortModes.map((m) => (
          <button
            key={m}
            onClick={() => setSortMode(m)}
            className={`px-3 py-1 rounded-full text-xs transition-colors ${
              sortMode === m ? "bg-highlight text-accent font-semibold" : "bg-card hover:bg-highlight hover:text-background"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* ARC list */}
      {!sorted.length ? (
        <div className="text-center py-12">No ARCs in your library.</div>
      ) : (
        <div className="space-y-3">
          {sorted.map((arc: ArcBook) => {
            const doneAndLate = arc.has_review && isPastDeadline(arc.netgalley_deadline);
            return (
              <Link
                key={arc.calibre_id}
                href={`/book/${arc.calibre_id}`}
                className={`flex items-center gap-4 bg-card shadow-sm shadow-border hover:shadow-md rounded-lg px-4 py-3 transition-colors ${
                  doneAndLate ? "opacity-50" : ""
                }`}
              >
                {/* Cover */}
                <div className="w-12 flex-shrink-0 aspect-[3/4] rounded overflow-hidden bg-background">
                  {arc.cover_uri ? (
                    <img src={arc.cover_uri} alt="" className="w-full h-full object-cover" />
                  ) : null}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    <span className="mr-2 select-none">
                      {arc.has_review ? "✅" : arc.overdue ? "⚠️" : arc.netgalley_deadline ? "📅" : "🔖"}
                    </span>
                    {arc.title}
                  </p>
                  <div className="flex gap-3 text-xs mt-1">
                    {arc.netgalley_deadline && (
                      <span>Due: {fmtDate(arc.netgalley_deadline)}</span>
                    )}
                    {arc.has_notes && <span>✔ Notes</span>}
                    {arc.has_review && <span>🗒 Obsidian</span>}
                  </div>
                </div>

                {/* Overdue badge */}
                {arc.overdue && arc.days_past_due > 0 && (
                  <span className="text-xs text-orange-400 font-semibold flex-shrink-0">
                    {arc.days_past_due}d overdue
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
