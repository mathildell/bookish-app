// Typed client for the FastAPI backend (proxied under /api by next.config.js).

import { useQuery } from "@tanstack/react-query";
import type { ArcBook, BookDetail, BooksListResponse, Citation, FilterMetadata } from "@/types/book";
import type { Character, CharacterInput } from "@/types/character";
import type { AppSettings, OllamaModelList } from "@/types/settings";

const BASE = "/api";

type QueryParams = Record<string, string | number | boolean | undefined | null>;

/** `?a=1&b=2`, skipping empty values; "" when nothing is left. */
function qs(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** Message of the Error thrown on a non-2xx response. */
  error?: string;
  timeoutMs?: number;
};

/** Fetch `/api{path}` and parse its JSON, throwing `error` on a failed response. */
async function request<T>(path: string, { method = "GET", body, error, timeoutMs }: RequestOptions = {}): Promise<T> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: controller?.signal,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(error ?? `Request failed: ${res.statusText}`);
    return res.json();
  } catch (e: unknown) {
    if ((e as DOMException).name === "AbortError") throw new Error("Request timed out. Please try again.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** POST a JSON body to a streaming endpoint; throws with the server's detail on failure. */
async function openStream(
  path: string,
  body: unknown,
  error: string,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error((await errorDetail(res)) || `${error}: ${res.statusText}`);
  }
  return res.body;
}

/** FastAPI's `{"detail": "..."}` message, or the raw body text. */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.detail === "string") return parsed.detail;
  } catch {
    // not JSON — fall through to the raw text
  }
  return text;
}

/** Yield the JSON payload of every `data:` line in a Server-Sent Events body. */
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

// ----- Books -----

export function fetchBooks(
  page: number,
  pageSize: number,
  {
    query = "",
    status,
    indexed,
    sort,
    tags,
    list_id,
  }: { query?: string; status?: string; indexed?: boolean | null; sort?: string; tags?: string[]; list_id?: number } = {}
): Promise<BooksListResponse> {
  const params = qs({
    offset: page * pageSize,
    limit: pageSize,
    query,
    status,
    indexed,
    sort,
    selected_tags: tags?.length ? tags.join(",") : undefined,
    list_id,
  });
  return request(`/books${params}`, { error: "Failed to fetch books", timeoutMs: 30_000 });
}

export function fetchBook(id: number): Promise<BookDetail> {
  return request(`/books/${id}`, { error: "Book not found" });
}

export function fetchFilterMetadata(): Promise<FilterMetadata> {
  return request("/books/filters/metadata", { error: "Failed to fetch filters" });
}

export function fetchArcs(): Promise<ArcBook[]> {
  return request("/arcs", { error: "Failed to fetch arcs" });
}

// ----- Settings -----

export function fetchSettings(): Promise<AppSettings> {
  return request("/settings", { error: "Failed to load settings" });
}

export function fetchModels(): Promise<OllamaModelList> {
  return request("/models", { error: "Failed to load Ollama models" });
}

export function updateSettings(data: Partial<AppSettings>) {
  // genre_categories is derived from the library, never persisted.
  const { genre_categories: _derived, ...payload } = data;
  return request<{ ok: boolean; message: string }>("/settings", {
    method: "PUT",
    body: payload,
    error: "Failed to save settings",
  });
}

export type SettingsSummary = Pick<AppSettings, "genre_colors" | "calibre_url">;

export async function fetchSettingsSummary(): Promise<SettingsSummary> {
  const data = await fetchSettings();
  return { genre_colors: data.genre_colors ?? {}, calibre_url: data.calibre_url ?? "" };
}

// ----- Index / unindex -----

type IndexResult = { ok: boolean; message: string };

export function indexBook(calibreId: number): Promise<IndexResult> {
  return request(`/index/${calibreId}`, { method: "POST", error: "Index failed" });
}

export function unindexBook(calibreId: number): Promise<IndexResult> {
  return request(`/unindex/${calibreId}`, { method: "POST", error: "Unindex failed" });
}

export type BatchIndexEvent =
  | { kind: "started"; id: number; title: string }
  | { kind: "ok"; id: number; title: string; chunks: number }
  | { kind: "error"; id: number; title: string; errors: string[] }
  | { kind: "skipped"; id: number; title: string; reason: string }
  | { kind: "done"; total: number };

function toBatchEvent(raw: Record<string, unknown>): BatchIndexEvent {
  if (raw.done === true) return { kind: "done", total: Number(raw.total ?? 0) };
  const id = Number(raw.id ?? 0);
  const title = String(raw.title ?? "");
  switch (String(raw.status ?? "")) {
    case "ok":
      return { kind: "ok", id, title, chunks: Number(raw.chunks ?? 0) };
    case "error":
      return { kind: "error", id, title, errors: Array.isArray(raw.errors) ? (raw.errors as string[]) : [String(raw.errors)] };
    case "skipped":
      return { kind: "skipped", id, title, reason: String(raw.reason ?? "unknown") };
    default:
      return { kind: "started", id, title };
  }
}

export async function* batchIndexBooks(
  calibreIds: number[],
  onEvent?: (event: BatchIndexEvent) => void
): AsyncGenerator<BatchIndexEvent> {
  const body = await openStream("/batch-index", { calibre_ids: calibreIds }, "Batch index failed");
  for await (const raw of readSse(body)) {
    const event = toBatchEvent(raw);
    onEvent?.(event);
    yield event;
  }
}

// ----- Chat -----

export type ChatStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "token"; text: string }
  | { type: "done"; answer: string; citations: Citation[] }
  | { type: "error"; error: string };

export async function* streamChat(
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  calibreIds?: number[],
  scope: "book" | "multi_book" = "book"
): AsyncGenerator<ChatStreamEvent> {
  let body: ReadableStream<Uint8Array>;
  try {
    body = await openStream("/chat/stream", { message, history, calibre_ids: calibreIds, scope }, "Chat request failed");
  } catch (e) {
    yield { type: "error", error: e instanceof Error ? e.message : String(e) };
    return;
  }

  for await (const data of readSse(body)) {
    if (data.thinking !== undefined) yield { type: "thinking", text: String(data.thinking) };
    else if (data.token !== undefined) yield { type: "token", text: String(data.token) };
    else if (data.done) yield { type: "done", answer: String(data.answer ?? ""), citations: (data.citations ?? []) as Citation[] };
    else if (data.error) yield { type: "error", error: String(data.error) };
  }
}

// ----- Obsidian review -----

export function writeObsidianReview(calibreId: number, content: string): Promise<{ ok: boolean }> {
  return request(`/obsidian/${calibreId}`, { method: "POST", body: { review: content }, error: "Failed to save review" });
}

export function deleteObsidianReview(calibreId: number): Promise<{ ok: boolean }> {
  return request(`/obsidian/${calibreId}`, { method: "DELETE", error: "Failed to delete review" });
}

// ----- Book lists -----

export type BookList = { id: number; name: string; book_ids: number[] };

export function fetchLists(): Promise<BookList[]> {
  return request("/lists", { error: "Failed to fetch lists" });
}

export function createList(name: string): Promise<BookList> {
  return request("/lists", { method: "POST", body: { name }, error: "Failed to create list" });
}

export function renameList(id: number, name: string): Promise<BookList> {
  return request(`/lists/${id}`, { method: "PATCH", body: { name }, error: "Failed to rename list" });
}

export function setListBooks(id: number, bookIds: number[]): Promise<BookList> {
  return request(`/lists/${id}`, { method: "PATCH", body: { book_ids: bookIds }, error: "Failed to update list books" });
}

export function deleteList(id: number): Promise<void> {
  return request(`/lists/${id}`, { method: "DELETE", error: "Failed to delete list" });
}

export function useBookLists() {
  return useQuery({ queryKey: ["bookLists"], queryFn: fetchLists });
}

// ----- Character lists (a cast — never the same thing as a book list) -----

export type CharacterList = { id: number; name: string; character_ids: number[] };

export function fetchCharacterLists(): Promise<CharacterList[]> {
  return request("/character-lists", { error: "Failed to fetch character lists" });
}

export function createCharacterList(name: string): Promise<CharacterList> {
  return request("/character-lists", { method: "POST", body: { name }, error: "Failed to create character list" });
}

export function renameCharacterList(id: number, name: string): Promise<CharacterList> {
  return request(`/character-lists/${id}`, { method: "PATCH", body: { name }, error: "Failed to rename character list" });
}

export function setCharacterListMembers(id: number, characterIds: number[]): Promise<CharacterList> {
  return request(`/character-lists/${id}`, {
    method: "PATCH",
    body: { character_ids: characterIds },
    error: "Failed to update character list",
  });
}

export function deleteCharacterList(id: number): Promise<void> {
  return request(`/character-lists/${id}`, { method: "DELETE", error: "Failed to delete character list" });
}

export function useCharacterLists() {
  return useQuery({ queryKey: ["characterLists"], queryFn: fetchCharacterLists });
}

// ----- Bookmarks -----

export type BookmarkCitation = { calibre_id?: number | null; title: string };

export type BookmarkInput = {
  question: string;
  answer: string;
  citations: BookmarkCitation[];
  scope: string;
  calibre_ids: number[];
  note?: string;
  color?: string;
};

export type Bookmark = Required<BookmarkInput> & { id: number; created_at: string };

export function fetchBookmarks(): Promise<Bookmark[]> {
  return request("/bookmarks", { error: "Failed to fetch bookmarks" });
}

export function createBookmark(payload: BookmarkInput): Promise<Bookmark> {
  return request("/bookmarks", { method: "POST", body: payload, error: "Failed to save bookmark" });
}

export function updateBookmark(id: number, patch: { note?: string; color?: string }): Promise<Bookmark> {
  return request(`/bookmarks/${id}`, { method: "PATCH", body: patch, error: "Failed to update bookmark" });
}

export function deleteBookmark(id: number): Promise<void> {
  return request(`/bookmarks/${id}`, { method: "DELETE", error: "Failed to delete bookmark" });
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
  const body = await openStream("/write/stream", payload, "Writing failed");
  for await (const data of readSse(body)) {
    if (typeof data.token === "string") yield { kind: "token", text: data.token };
    else if (typeof data.thinking === "string") yield { kind: "thinking", text: data.thinking };
    else if (data.done)
      yield { kind: "done", answer: String(data.answer ?? ""), suggestions: (data.suggestions ?? []) as string[] };
    else if (typeof data.error === "string") yield { kind: "error", error: data.error };
  }
}

export async function regenerateSceneSuggestions(payload: {
  character_ids: number[];
  history: SceneTurn[];
}): Promise<string[]> {
  const data = await request<{ suggestions?: string[] }>("/write/suggestions", {
    method: "POST",
    body: payload,
    error: "Failed to regenerate suggestions",
  });
  return data.suggestions ?? [];
}

// ----- Characters -----

export function fetchCharacters(params: { q?: string; calibreId?: number } = {}): Promise<Character[]> {
  return request(`/characters${qs({ q: params.q, calibre_id: params.calibreId })}`, {
    error: "Failed to fetch characters",
  });
}

export function fetchCharacter(id: number): Promise<Character> {
  return request(`/characters/${id}`, { error: "Character not found" });
}

export function createCharacter(payload: Partial<CharacterInput> & { name: string }): Promise<Character> {
  return request("/characters", { method: "POST", body: payload, error: "Failed to create character" });
}

export function updateCharacter(id: number, patch: Partial<CharacterInput>): Promise<Character> {
  return request(`/characters/${id}`, { method: "PATCH", body: patch, error: "Failed to save character" });
}

export function deleteCharacter(id: number): Promise<void> {
  return request(`/characters/${id}`, { method: "DELETE", error: "Failed to delete character" });
}

export function useCharacters(q?: string) {
  return useQuery({ queryKey: ["characters", q ?? ""], queryFn: () => fetchCharacters({ q }) });
}

// Discovery and profile synthesis stream over SSE (see backend/routers/characters.py).

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

/** A named thing the extractor judged not to be a character (place, group, object). */
export type FilteredEntry = { name: string; kind: string };

export type DiscoverEvent =
  | { kind: "book"; calibre_id: number; title: string }
  | { kind: "found"; calibre_id: number; count: number }
  | { kind: "book_error"; calibre_id?: number; title?: string; error: string }
  | { kind: "candidates"; candidates: CharacterCandidate[]; filtered: FilteredEntry[] }
  | { kind: "done" };

export type ProfileEvent =
  | { kind: "started"; name: string }
  | { kind: "progress"; name: string; message: string }
  | { kind: "ok"; name: string; character: Character; notes?: string[] }
  | { kind: "profile_error"; name: string; error: string }
  | { kind: "done" };

export async function* discoverCharacters(calibreIds: number[], guidance = ""): AsyncGenerator<DiscoverEvent> {
  const body = await openStream("/characters/discover", { calibre_ids: calibreIds, guidance }, "Discovery failed");
  for await (const data of readSse(body)) {
    switch (String(data.event ?? "")) {
      case "candidates":
        yield {
          kind: "candidates",
          candidates: (data.candidates ?? []) as CharacterCandidate[],
          filtered: (data.filtered ?? []) as FilteredEntry[],
        };
        break;
      case "book":
        yield { kind: "book", calibre_id: Number(data.calibre_id ?? 0), title: String(data.title ?? "") };
        break;
      case "found":
        yield { kind: "found", calibre_id: Number(data.calibre_id ?? 0), count: Number(data.count ?? 0) };
        break;
      case "error":
        yield {
          kind: "book_error",
          calibre_id: data.calibre_id === undefined ? undefined : Number(data.calibre_id),
          title: data.title === undefined ? undefined : String(data.title),
          error: String(data.error ?? "discovery failed"),
        };
        break;
    }
  }
  yield { kind: "done" };
}

export async function* streamProfiles(
  characters: Array<{ name: string; aliases: string[]; role?: string | null; description?: string | null; calibre_ids: number[] }>,
  guidance = "",
  selection: number[] = []
): AsyncGenerator<ProfileEvent> {
  // `selection` is the whole run: evidence comes from every book in it, so a
  // character is not profiled from a discovery sample's subset.
  const body = await openStream(
    "/characters/profiles",
    { characters, guidance, calibre_ids: selection },
    "Profile generation failed"
  );
  for await (const data of readSse(body)) {
    const name = String(data.name ?? "");
    switch (String(data.event ?? "")) {
      case "started":
        yield { kind: "started", name };
        break;
      case "progress":
        yield { kind: "progress", name, message: String(data.message ?? "") };
        break;
      case "ok":
        yield { kind: "ok", name, character: data.character as Character };
        break;
      case "error":
        yield { kind: "profile_error", name, error: String(data.error ?? "failed") };
        break;
    }
  }
  yield { kind: "done" };
}

/**
 * Another pass over a saved profile: reads passages earlier passes skipped and
 * reviews the sheet against all the evidence. Hand-edited fields are kept.
 */
export async function* refineCharacter(
  id: number,
  guidance = "",
  signal?: AbortSignal
): AsyncGenerator<ProfileEvent> {
  const body = await openStream(`/characters/${id}/refine`, { guidance }, "Refine failed", signal);
  for await (const data of readSse(body)) {
    const name = String(data.name ?? "");
    switch (String(data.event ?? "")) {
      case "progress":
        yield { kind: "progress", name, message: String(data.message ?? "") };
        break;
      case "ok":
        yield { kind: "ok", name, character: data.character as Character, notes: (data.notes ?? []) as string[] };
        break;
      case "error":
        yield { kind: "profile_error", name, error: String(data.error ?? "failed") };
        break;
    }
  }
  yield { kind: "done" };
}
