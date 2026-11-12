// Small formatting and parsing helpers shared across pages.

/** Unique positive ids from a comma-separated query value ("3,1,3" → [3, 1]). */
export function parseIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return Array.from(new Set(ids));
}

/** "05 Mar 2025" for an ISO date, "—" when there is none. */
export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" });
}

/** Two initials for an avatar placeholder ("Damianos of Akielos" → "DA"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
