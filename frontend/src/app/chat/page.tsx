"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueries, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import ChatInterface from "@/components/ChatInterface";
import { fetchBook, fetchBooks } from "@/lib/api";
import type { BookCard, BookDetail } from "@/types/book";
import { ClearIcon, LibraryIcon, BooksIcon, BookIcon } from "@/components/icons";

const PICKER_PAGE_SIZE = 30;

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return Array.from(new Set(ids));
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="text-muted py-8">Loading…</div>}>
      <ChatPageContent />
    </Suspense>
  );
}

function ChatPageContent() {
  const searchParams = useSearchParams();

  // The selection is the mode: 0 books = whole library, 1 = focused, 2+ = multi-book
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  useEffect(() => {
    setSelectedIds(parseIds(searchParams.get("ids")));
  }, [searchParams]);

  // Update the selection and keep the URL shareable. Only user actions write the
  // URL — syncing it from an effect would race the effect above on first load and
  // can wipe ?ids= before it is applied.
  const applySelection = useCallback((next: number[]) => {
    setSelectedIds(next);
    const query = next.length ? `?ids=${next.join(",")}` : "";
    window.history.replaceState(null, "", `/chat${query}`);
  }, []);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const bookQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["book", id],
      queryFn: () => fetchBook(id) as Promise<BookDetail>,
    })),
  });
  const selectedBooks = bookQueries
    .map((q) => q.data)
    .filter((b): b is BookDetail => Boolean(b));

  const { data: pickerData, isFetching: pickerFetching } = useQuery({
    queryKey: ["chat-picker", pickerQuery],
    queryFn: () => fetchBooks(0, PICKER_PAGE_SIZE, { query: pickerQuery, indexed: true }),
    enabled: pickerOpen,
  });
  const pickerCards: BookCard[] = pickerData?.cards ?? [];

  const removeBook = useCallback(
    (id: number) => applySelection(selectedIds.filter((x) => x !== id)),
    [applySelection, selectedIds]
  );

  const toggleBook = useCallback(
    (id: number) =>
      applySelection(
        selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
      ),
    [applySelection, selectedIds]
  );

  const mode = selectedIds.length === 0 ? "library" : selectedIds.length === 1 ? "focus" : "multi";
  const onlyBook = selectedIds.length === 1 ? selectedBooks[0] : undefined;

  const description =
    mode === "library" ? (
      <>
        Searching your <strong className="text-zinc-300">whole indexed library</strong>. Pick books in the sidebar to focus the conversation.
      </>
    ) : mode === "focus" ? (
      <>
        Focused on <strong className="text-zinc-300">{onlyBook?.title ?? "1 book"}</strong>. Questions are answered from this book.
      </>
    ) : (
      <>
        Comparing <strong className="text-zinc-300">{selectedIds.length}</strong> books. Ask comparative questions and the assistant will reference which book each passage comes from.
      </>
    );

  const placeholder =
    mode === "library"
      ? "Ask about your library…"
      : mode === "focus"
        ? `Ask about ${onlyBook?.title ?? "this book"}…`
        : `Ask a comparative question about ${selectedIds.length} books…`;

  const welcomeMessage =
    mode === "library" ? (
      <>
        Explore your book collection: themes, characters, quotes, summaries... Select books on the left to narrow the search.
      </>
    ) : mode === "focus" ? (
      <>
        📖 Ask me anything about <strong>{onlyBook?.title ?? "this book"}</strong>.
      </>
    ) : (
      <>
        📚 Comparing <strong>{selectedIds.length}</strong> books.
      </>
    );

  // Remount the chat when the selection changes so history can't leak across contexts
  const chatKey = selectedIds.length ? selectedIds.slice().sort((a, b) => a - b).join("-") : "library";

  return (
    <div className="flex h-[calc(100vh-5.5625rem)] flex-col overflow-hidden pt-4">
      <h1 className="text-2xl font-bold tracking-tight">Chat</h1>
      <p className="text-sm text-muted mt-1 mb-4">{description}</p>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Sidebar: context selection */}
        <aside className="w-[200px] flex-shrink-0 min-h-0 overflow-hidden bg-card rounded-xl p-3 flex flex-col gap-3 shadow-md shadow-border">
          <div className="flex items-center justify-between flex-shrink-0">
            <p className="text-xs font-semibold text-muted uppercase tracking-wide">Context</p>
            {selectedIds.length > 0 && (
              <button
                type="button"
                onClick={() => applySelection([])}
                className="text-xs text-muted hover:text-accent cursor-pointer transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex-shrink-0 rounded-lg px-2.5 py-2 text-xs leading-snug bg-accent/20 border border-accent">
            {mode === "library" ? (
              <p className="flex gap-1 items-center"><LibraryIcon /> Whole library</p>
            ) : mode === "focus" ? (
              <p className="flex gap-1 items-center"><BookIcon className="h-5 w-5" /> 1 book in focus</p>
            ) : (
              <p className="flex gap-1 items-center"><BooksIcon /> {selectedIds.length} books selected</p>
            )}
          </div>

          {/* Selected books grid */}
          {selectedIds.length > 0 ? (
            <div className="grid flex-1 min-h-0 auto-rows-max grid-cols-2 content-start gap-2 overflow-y-auto">
              {/* Only the cover grid scrolls: the header and the add-books footer
                  stay pinned, so a long selection can never push the picker out
                  of reach. */}
              {selectedIds.map((id) => {
                const book = selectedBooks.find((b) => b.id === id);
                return (
                  <div key={id} className="group/book relative aspect-[5/7] rounded-lg bg-border">
                    {/* Clipping lives on the link, not on this grid item: overflow-hidden
                        on a grid item zeroes its automatic minimum size, which lets the
                        row collapse under the cover and overlap the next row. */}
                    <Link href={`/book/${id}`} className="block w-full h-full overflow-hidden rounded-lg shadow-sm shadow-border">
                      {book?.cover_uri ? (
                        <img src={book.cover_uri} alt={book.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted text-xs text-center px-1">
                          {book?.title ?? `#${id}`}
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-card rounded-b-md p-1 transition-opacity opacity-0 group-hover/book:opacity-100">
                        <p className="text-xs leading-tight line-clamp-2 font-medium">
                          {book?.title ?? `#${id}`}
                        </p>
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={() => removeBook(id)}
                      aria-label={`Remove ${book?.title ?? `book ${id}`} from chat`}
                      className="absolute top-1 right-1 h-5 w-5 rounded-full opacity-0 group-hover/book:opacity-100 transition-colors flex items-center justify-center bg-card shadow-xs shadow-border cursor-pointer hover:bg-red-500 hover:text-background"
                    >
                      <ClearIcon className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 min-h-0 rounded-lg border border-dashed border-muted px-2 py-4 text-center">
              <p className="text-xs text-muted leading-relaxed">
                No books selected.
              </p>
            </div>
          )}

          {/* Add books */}
          <div className="flex-shrink-0 pt-2 flex flex-col gap-2 min-h-0">
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              className="w-full py-1.5 rounded-lg text-xs font-semibold bg-background shadow-sm shadow-border text-muted hover:cursor-pointer hover:bg-highlight hover:text-card transition-colors"
            >
              {pickerOpen ? "− Close picker" : "+ Add books"}
            </button>

            {pickerOpen && (
              <div className="flex flex-col gap-2 min-h-0">
                <input
                  type="text"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="Search indexed books…"
                  className="w-full bg-card shadow-sm shadow-border rounded-lg px-2.5 py-1.5 text-xs placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <div className="max-h-[180px] overflow-y-auto space-y-0.5">
                  {pickerCards.map((card) => {
                    const checked = selectedIds.includes(card.id);
                    return (
                      <label
                        key={card.id}
                        className="flex items-center gap-2 py-1 cursor-pointer hover:ring-2 hover:ring-accent mx-2.5 my-1 rounded"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBook(card.id)}
                          className="accent-accent flex-shrink-0"
                        />
                        <span className="w-5 h-7 flex-shrink-0 rounded overflow-hidden bg-muted">
                          {card.cover_uri ? (
                            <img src={card.cover_uri} alt="" className="w-full h-full object-cover" />
                          ) : null}
                        </span>
                        <span className="text-xs leading-tight line-clamp-2">{card.title}</span>
                      </label>
                    );
                  })}
                  {pickerCards.length === 0 && (
                    <p className="text-xs text-muted px-1 py-2">
                      {pickerFetching ? "Searching…" : "No indexed books match."}
                    </p>
                  )}
                </div>
                {pickerData && pickerData.total > pickerCards.length && (
                  <p className="text-xs text-muted">
                    Showing {pickerCards.length} of {pickerData.total}
                  </p>
                )}
                <p className="text-xs leading-tight">
                  Changing selection starts a new conversation.
                </p>
              </div>
            )}
          </div>
        </aside>

        {/* Chat */}
        <div className="flex-1 min-w-0 min-h-0">
          <ChatInterface
            key={chatKey}
            calibreIds={selectedIds.length ? selectedIds : undefined}
            scope={selectedIds.length > 1 ? "multi_book" : "book"}
            placeholder={placeholder}
            welcomeMessage={welcomeMessage}
            fill
            className="flex flex-col"
          />
        </div>
      </div>
    </div>
  );
}