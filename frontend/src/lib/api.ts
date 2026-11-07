import type { BookCard, BooksListResponse } from "@/types/book";
import { useQuery } from "@tanstack/react-query";

const BASE = "/api";

type QueryParams = Record<string, string | number | boolean | undefined | null>;


function qs(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

// ----- Books -----

export async function fetchBooks(
  page: number,
  pageSize: number,
  { query = "", status, indexed, sort, tags, list_id }: { query?: string; status?: string; indexed?: boolean | null; sort?: string; tags?: string[]; list_id?: number } = {}
): Promise<BooksListResponse> {
  const params: QueryParams = {
    offset: page * pageSize,
    limit: pageSize,
    query,
    status,
    indexed,
    sort,
    selected_tags: tags?.length ? tags.join(",") : undefined,
    list_id,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE}/books${qs(params)}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch books: ${res.statusText}`);
    return res.json();
  } catch (e: unknown) {
    if ((e as DOMException).name === "AbortError") throw new Error("Request timed out. Please try again.");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBook(id: number) {
  const res = await fetch(`${BASE}/books/${id}`);
  if (!res.ok) throw new Error(`Book not found`);
  return res.json();
}

// ----- Settings -----

export type SettingsSummary = {
  genre_colors: Record<string, string>;
  calibre_url: string;
};

export async function fetchSettingsSummary(): Promise<SettingsSummary> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) throw new Error(`Failed to fetch settings: ${res.statusText}`);
  const data = await res.json();
  return {
    genre_colors: data.genre_colors ?? {},
    calibre_url: data.calibre_url ?? "",
  };
}

// ----- Filters -----

export async function fetchFilterMetadata() {
  const res = await fetch(`${BASE}/books/filters/metadata`);
  return res.json();
}

// ----- ARC tracker -----

export async function fetchArcs() {
  const res = await fetch(`${BASE}/arcs`);
  if (!res.ok) throw new Error(`Failed to fetch arcs: ${res.statusText}`);
  return res.json();
}

// ----- Index / unindex -----

export async function indexBook(calibreId: number) {
  const res = await fetch(`${BASE}/index/${calibreId}`, { method: "POST" });
  if (!res.ok) throw new Error(`Index failed`);
  return res.json();
}

export async function unindexBook(calibreId: number) {
  const res = await fetch(`${BASE}/unindex/${calibreId}`, { method: "POST" });
  if (!res.ok) throw new Error(`Unindex failed`);
  return res.json();
}

export type BatchIndexEvent =
  | { kind: "started"; id: number; title: string }
  | { kind: "ok"; id: number; title: string; chunks: number }
  | { kind: "error"; id: number; title: string; errors: string[] }
  | { kind: "skipped"; id: number; title: string; reason: string }
  | { kind: "done"; total: number };

export async function* batchIndexBooks(
  calibreIds: number[],
  onEvent?: (event: BatchIndexEvent) => void
): AsyncGenerator<BatchIndexEvent> {
  const res = await fetch(`${BASE}/batch-index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calibre_ids: calibreIds }),
  });

  if (!res.ok) {
    throw new Error(`Batch index failed: ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const raw = JSON.parse(line.slice(6)) as Record<string, unknown>;
          let event: BatchIndexEvent;
          if (raw.done === true) {
            event = { kind: "done", total: Number(raw.total ?? 0) };
          } else {
            const status = String(raw.status ?? "");
            const id = Number(raw.id ?? 0);
            const title = String(raw.title ?? "");
            switch (status) {
              case "ok":
                event = { kind: "ok", id, title, chunks: Number(raw.chunks ?? 0) };
                break;
              case "error":
                event = { kind: "error", id, title, errors: Array.isArray(raw.errors) ? raw.errors as string[] : [String(raw.errors)] };
                break;
              case "skipped":
                event = { kind: "skipped", id, reason: String(raw.reason ?? "unknown"), title };
                break;
              default:
                event = { kind: status as "started", id, title };
            }
          }
          onEvent?.(event);
          yield event;
        } catch (e) {
          console.warn("Malformed batch-index SSE event:", line, e);
        }
      }
    }
  }
}

// ----- Chat streaming (returns an async iterable of parsed SSE events) -----

export async function* streamChat(
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  calibreIds?: number[],
  scope: "book" | "multi_book" = "book"
): AsyncGenerator<{ type: "thinking"; text: string } | { type: "token"; text: string } | { type: "done"; answer: string; citations: Array<{ calibre_id?: number; title: string }> } | { type: "error"; error: string }> {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, calibre_ids: calibreIds, scope }),
  });

  if (!res.ok) {
    yield { type: "error", error: `Chat request failed: ${res.statusText}` };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.thinking !== undefined) yield { type: "thinking", text: data.thinking };
          else if (data.token !== undefined) yield { type: "token", text: data.token };
          else if (data.done) yield { type: "done", answer: data.answer, citations: data.citations };
          else if (data.error) yield { type: "error", error: data.error };
        } catch (e) {
          console.warn("Malformed chat SSE event:", line, e);
        }
      }
    }
  }
}

// ----- Obsidian review -----

export async function writeObsidianReview(calibreId: number, content: string) {
  const res = await fetch(`${BASE}/obsidian/${calibreId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ review: content }),
  });
  if (!res.ok) throw new Error("Failed to save review");
  return res.json();
}

export async function deleteObsidianReview(calibreId: number) {
  const res = await fetch(`${BASE}/obsidian/${calibreId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete review");
  return res.json();
}

// ----- Lists -----

export type BookList = { id: number; name: string; book_ids: number[] };

export async function fetchLists(): Promise<BookList[]> {
  const res = await fetch(`${BASE}/lists`);
  if (!res.ok) throw new Error(`Failed to fetch lists: ${res.statusText}`);
  return res.json();
}

export async function createList(name: string): Promise<BookList> {
  const res = await fetch(`${BASE}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to create list: ${res.statusText}`);
  return res.json();
}

export async function renameList(id: number, name: string): Promise<BookList> {
  const res = await fetch(`${BASE}/lists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to rename list");
  return res.json();
}

export async function setListBooks(id: number, bookIds: number[]): Promise<BookList> {
  const res = await fetch(`${BASE}/lists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_ids: bookIds }),
  });
  if (!res.ok) throw new Error("Failed to update list books");
  return res.json();
}

export async function deleteList(id: number): Promise<void> {
  const res = await fetch(`${BASE}/lists/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete list");
  return res.json();
}

// ----- Bookmarks -----

export type BookmarkCitation = { calibre_id?: number | null; title: string };

export type Bookmark = {
  id: number;
  created_at: string;
  question: string;
  answer: string;
  citations: BookmarkCitation[];
  scope: string;
  calibre_ids: number[];
  note: string;
  color: string;
};

export type BookmarkInput = {
  question: string;
  answer: string;
  citations: BookmarkCitation[];
  scope: string;
  calibre_ids: number[];
  note?: string;
  color?: string;
};

export async function fetchBookmarks(): Promise<Bookmark[]> {
  const res = await fetch(`${BASE}/bookmarks`);
  if (!res.ok) throw new Error(`Failed to fetch bookmarks: ${res.statusText}`);
  return res.json();
}

export async function createBookmark(payload: BookmarkInput): Promise<Bookmark> {
  const res = await fetch(`${BASE}/bookmarks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save bookmark: ${res.statusText}`);
  return res.json();
}

export async function updateBookmark(id: number, patch: { note?: string; color?: string }): Promise<Bookmark> {
  const res = await fetch(`${BASE}/bookmarks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update bookmark");
  return res.json();
}

export async function deleteBookmark(id: number): Promise<void> {
  const res = await fetch(`${BASE}/bookmarks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete bookmark");
  return res.json();
}

// ----- Custom hooks -----

export function useBookLists() {
  return useQuery({
    queryKey: ["bookLists"],
    queryFn: fetchLists,
  });
}
