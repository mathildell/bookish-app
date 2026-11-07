import type { BookCard, BooksListResponse } from "@/types/book";
import type { Character, CharacterInput } from "@/types/character";
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

// ----- Creative writing -----

export type SceneTurn = { role: "user" | "assistant"; content: string };

export type SceneEvent =
  | { kind: "token"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "done"; answer: string; suggestions: string[] }
  | { kind: "error"; error: string };

export async function* streamScene(payload: {
  message: string;
  history: SceneTurn[];
  character_ids: number[];
  genre: string;
}): AsyncGenerator<SceneEvent> {
  const res = await fetch(`${BASE}/write/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Writing failed: ${res.statusText}`);
  }

  for await (const data of readSse(res.body)) {
    if (typeof data.token === "string") yield { kind: "token", text: data.token };
    else if (typeof data.thinking === "string") yield { kind: "thinking", text: data.thinking };
    else if (data.done)
      yield {
        kind: "done",
        answer: String(data.answer ?? ""),
        suggestions: (data.suggestions ?? []) as string[],
      };
    else if (typeof data.error === "string") yield { kind: "error", error: data.error };
  }
}

export async function regenerateSceneSuggestions(payload: {
  character_ids: number[];
  history: SceneTurn[];
}): Promise<string[]> {
  const res = await fetch(`${BASE}/write/suggestions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to regenerate suggestions");
  const data = await res.json();
  return (data.suggestions ?? []) as string[];
}

// ----- Custom hooks -----

export function useBookLists() {
  return useQuery({
    queryKey: ["bookLists"],
    queryFn: fetchLists,
  });
}

// ----- Character lists (a cast — never the same thing as a book list) -----

export type CharacterList = { id: number; name: string; character_ids: number[] };

export async function fetchCharacterLists(): Promise<CharacterList[]> {
  const res = await fetch(`${BASE}/character-lists`);
  if (!res.ok) throw new Error(`Failed to fetch character lists: ${res.statusText}`);
  return res.json();
}

export async function createCharacterList(name: string): Promise<CharacterList> {
  const res = await fetch(`${BASE}/character-lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to create character list: ${res.statusText}`);
  return res.json();
}

export async function renameCharacterList(id: number, name: string): Promise<CharacterList> {
  const res = await fetch(`${BASE}/character-lists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to rename character list");
  return res.json();
}

export async function setCharacterListMembers(id: number, characterIds: number[]): Promise<CharacterList> {
  const res = await fetch(`${BASE}/character-lists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ character_ids: characterIds }),
  });
  if (!res.ok) throw new Error("Failed to update character list");
  return res.json();
}

export async function deleteCharacterList(id: number): Promise<void> {
  const res = await fetch(`${BASE}/character-lists/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete character list");
  return res.json();
}

export function useCharacterLists() {
  return useQuery({
    queryKey: ["characterLists"],
    queryFn: fetchCharacterLists,
  });
}

// ----- Characters -----

export async function fetchCharacters(params: { q?: string; calibreId?: number } = {}): Promise<Character[]> {
  const res = await fetch(`${BASE}/characters${qs({ q: params.q, calibre_id: params.calibreId })}`);
  if (!res.ok) throw new Error(`Failed to fetch characters: ${res.statusText}`);
  return res.json();
}

export async function fetchCharacter(id: number): Promise<Character> {
  const res = await fetch(`${BASE}/characters/${id}`);
  if (!res.ok) throw new Error("Character not found");
  return res.json();
}

export async function createCharacter(payload: Partial<CharacterInput> & { name: string }): Promise<Character> {
  const res = await fetch(`${BASE}/characters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to create character: ${res.statusText}`);
  return res.json();
}

export async function updateCharacter(id: number, patch: Partial<CharacterInput>): Promise<Character> {
  const res = await fetch(`${BASE}/characters/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to save character");
  return res.json();
}

export async function deleteCharacter(id: number): Promise<void> {
  const res = await fetch(`${BASE}/characters/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete character");
  return res.json();
}

export async function mergeCharacters(id: number, otherId: number): Promise<Character> {
  const res = await fetch(`${BASE}/characters/${id}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ other_id: otherId }),
  });
  if (!res.ok) throw new Error("Failed to merge characters");
  return res.json();
}

// Discovery + profile synthesis stream over SSE (see backend/routers/characters.py).

export type CharacterCandidate = {
  name: string;
  aliases: string[];
  role?: string | null;
  description?: string | null;
  source_book_ids: number[];
  existing_id?: number | null;
  existing_name?: string | null;
  already_extracted?: boolean;
  possible_duplicate?: boolean;
};

export type DiscoverEvent =
  | { kind: "book"; calibre_id: number; title: string }
  | { kind: "found"; calibre_id: number; count: number }
  | { kind: "book_error"; calibre_id?: number; title?: string; error: string }
  | { kind: "candidates"; candidates: CharacterCandidate[]; filtered: FilteredEntry[] }
  | { kind: "done" };

/** A named thing the extractor judged not to be a character (place, group, object). */
export type FilteredEntry = { name: string; kind: string };

export type ProfileEvent =
  | { kind: "started"; name: string }
  | { kind: "ok"; name: string; character: Character }
  | { kind: "profile_error"; name: string; error: string }
  | { kind: "done" };

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        yield JSON.parse(line.slice(6)) as Record<string, unknown>;
      } catch (e) {
        console.warn("Malformed SSE event:", line, e);
      }
    }
  }
}

export async function* discoverCharacters(
  calibreIds: number[],
  guidance = ""
): AsyncGenerator<DiscoverEvent> {
  const res = await fetch(`${BASE}/characters/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calibre_ids: calibreIds, guidance }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Discovery failed: ${res.statusText}`);
  }

  for await (const data of readSse(res.body)) {
    const event = String(data.event ?? "");
    if (event === "candidates") {
      yield {
        kind: "candidates",
        candidates: (data.candidates ?? []) as CharacterCandidate[],
        filtered: (data.filtered ?? []) as FilteredEntry[],
      };
    } else if (event === "book") {
      yield { kind: "book", calibre_id: Number(data.calibre_id ?? 0), title: String(data.title ?? "") };
    } else if (event === "found") {
      yield { kind: "found", calibre_id: Number(data.calibre_id ?? 0), count: Number(data.count ?? 0) };
    } else if (event === "error") {
      yield {
        kind: "book_error",
        calibre_id: data.calibre_id === undefined ? undefined : Number(data.calibre_id),
        title: data.title === undefined ? undefined : String(data.title),
        error: String(data.error ?? "discovery failed"),
      };
    }
  }
  yield { kind: "done" };
}

export async function* streamProfiles(
  characters: Array<{ name: string; aliases: string[]; role?: string | null; description?: string | null; calibre_ids: number[] }>,
  guidance = "",
  selection: number[] = []
): AsyncGenerator<ProfileEvent> {
  const res = await fetch(`${BASE}/characters/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `selection` is the whole run: evidence comes from every book in it, so a
    // character is not profiled from a discovery sample's subset.
    body: JSON.stringify({ characters, guidance, calibre_ids: selection }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Profile generation failed: ${res.statusText}`);
  }

  for await (const data of readSse(res.body)) {
    const event = String(data.event ?? "");
    if (event === "started") {
      yield { kind: "started", name: String(data.name ?? "") };
    } else if (event === "ok") {
      yield { kind: "ok", name: String(data.name ?? ""), character: data.character as Character };
    } else if (event === "error") {
      yield { kind: "profile_error", name: String(data.name ?? ""), error: String(data.error ?? "failed") };
    }
  }
  yield { kind: "done" };
}

export function useCharacters(q?: string) {
  return useQuery({
    queryKey: ["characters", q ?? ""],
    queryFn: () => fetchCharacters({ q }),
  });
}
