"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { ChatMessage, Citation } from "@/types/book";
import { createBookmark, deleteBookmark, streamChat } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import Tooltip from "@/components/Tooltip";
import ThreadEmpty from "@/components/ThreadEmpty";
import { BookIcon, BookmarkIcon, CheckIcon } from "@/components/icons"

interface Props {
  calibreIds?: number[];
  scope: "book" | "multi_book";
  placeholder?: string;
  welcomeMessage?: ReactNode;
  className?: string;
  /** Fill the parent's height instead of using the fixed 360px card height. */
  fill?: boolean;
}

/* ── Animated thinking dots (searching phase) ── */
function ThinkingDots() {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 420);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 py-1">
      <span className="relative flex h-4 w-4">
        <span className="absolute inline-flex h-full w-full animate-spin rounded-full border-[2px] border-muted border-t-highlight" />
      </span>
      <span className="text-sm text-muted select-none">Searching{dots}</span>
    </div>
  );
}

export default function ChatInterface({
  calibreIds,
  scope = "book",
  placeholder = "Ask a question…",
  welcomeMessage,
  className = "",
  fill = false,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () =>
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const send = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    const history = messages.map(({ role, content }) => ({ role, content }));

    // Placeholder assistant message that we'll update as tokens arrive
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", citations: [] },
    ]);

    let fullText = "";
    let fullThinking = "";
    try {
      for await (const event of streamChat(
        userMsg.content,
        history,
        calibreIds?.length ? calibreIds : undefined,
        scope
      )) {
        if (event.type === "thinking") {
          // Keep the buffer bounded in case the model starts repeating itself.
          fullThinking = (fullThinking + event.text).slice(-12000);
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: fullText, thinking: fullThinking, citations: [] },
          ]);
        } else if (event.type === "token") {
          fullText += event.text;
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: fullText, thinking: fullThinking, citations: [] },
          ]);
        } else if (event.type === "done") {
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: event.answer, thinking: fullThinking, citations: event.citations },
          ]);
        } else if (event.type === "error") {
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: `⚠️ ${event.error}`, citations: [], error: true },
          ]);
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { role: "assistant", content: `⚠️ Connection error: ${err}`, error: true },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming, messages, calibreIds, scope]);

  // Bookmark toggle state: message index -> saved note id
  const [savedBookmarks, setSavedBookmarks] = useState<Record<number, number>>({});
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  // Reasoning is collapsed by default; per-message toggle keeps it available
  // after the answer renders.
  const [expandedThinking, setExpandedThinking] = useState<Record<number, boolean>>({});
  const toggleThinking = useCallback((index: number) => {
    setExpandedThinking((prev) => ({ ...prev, [index]: !prev[index] }));
  }, []);

  const toggleBookmark = useCallback(
    async (index: number) => {
      const existingId = savedBookmarks[index];
      setSavingIndex(index);
      try {
        if (existingId) {
          await deleteBookmark(existingId);
          setSavedBookmarks((prev) => {
            const next = { ...prev };
            delete next[index];
            return next;
          });
        } else {
          const answer = messages[index];
          if (!answer?.content) return;
          const question =
            index > 0 && messages[index - 1].role === "user" ? messages[index - 1].content : "";
          const saved = await createBookmark({
            question,
            answer: answer.content,
            citations: answer.citations ?? [],
            scope,
            calibre_ids: calibreIds ?? [],
            note: "",
            color: "yellow",
          });
          setSavedBookmarks((prev) => ({ ...prev, [index]: saved.id }));
        }
      } catch {
        // Leave the button usable; the bookmark wall is the source of truth if this fails.
      } finally {
        setSavingIndex(null);
      }
    },
    [savedBookmarks, messages, scope, calibreIds]
  );

  /* Determine whether the last message is an empty assistant placeholder
     that still has no content while streaming — i.e. the searching phase. */
  const isSearching = isStreaming &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    !messages[messages.length - 1].content &&
    !messages[messages.length - 1].thinking;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-xl bg-background shadow-sm shadow-border ${
        fill ? "h-full min-h-0" : "h-[360px] min-h-[300px]"
      } ${className}`}
    >
      {/* Messages area */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {welcomeMessage && messages.length === 0 && <ThreadEmpty>{welcomeMessage}</ThreadEmpty>}

        {messages.map((msg, i) => (
          <div key={i} className="flex flex-col">
            {msg.role === "user" ? (
              <div className="self-end rounded-lg px-4 py-2 text-sm bg-accent/20 border border-accent">
                {msg.content}
              </div>
            ) : (
              <div className="self-start w-3/4 space-y-2">
                {msg.thinking && (
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => toggleThinking(i)}
                      aria-expanded={!!expandedThinking[i]}
                      aria-label="Toggle thinking process"
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-card border border-muted/40 text-xs text-muted transition-colors hover:text-highlight"
                    >
                      <span aria-hidden>💭</span>
                      {isStreaming && i === messages.length - 1 && !msg.content
                        ? "Thinking…"
                        : "Thinking"}
                      <span aria-hidden className="text-xs">
                        {expandedThinking[i] ? "▲" : "▼"}
                      </span>
                    </button>
                    {expandedThinking[i] && (
                      <div className="max-h-48 w-full overflow-y-auto whitespace-pre-wrap rounded-lg p-3 text-xs leading-5 bg-card/60 text-muted">
                        {msg.thinking}
                      </div>
                    )}
                  </div>
                )}
                {msg.content && (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    className="w-full rounded-lg bg-card shadow-md shadow-border p-4 prose prose-invert prose-sm max-w-none [&_p]:leading-[1.25] [&_li]:leading-[1.25]"
                  >
                    {msg.content}
                  </ReactMarkdown>
                )}

                {msg.citations && msg.citations.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 border-t border-background pt-4">
                    {msg.citations.map((c, i) =>
                      c.calibre_id ? (
                        <Link
                          key={`${c.calibre_id}-${i}`}
                          href={`/book/${c.calibre_id}`}
                          className="text-xs border border-background text-muted px-2 py-1 rounded-full transition-colors leading-3 hover:text-foreground hover:border-border flex items-center gap-2"
                        >
                          <BookIcon /> <span>{c.title}</span>
                        </Link>
                      ) : (
                        <span
                          key={`${c.title}-${i}`}
                          className="text-xs border border-background text-muted px-2 py-1 rounded-full transition-colors leading-3 hover:text-foreground hover:border-border flex items-center gap-2"
                        >
                          <BookIcon /> {c.title}
                        </span>
                      )
                    )}
                  </div>
                )}

                {/* Save the finished answer (never the streaming placeholder or a failure notice) */}
                {msg.content && !msg.error && !(isStreaming && i === messages.length - 1) && (
                  <Tooltip
                    label={savedBookmarks[i] ? "Saved (click to remove)" : "Bookmark this answer"}
                    align="left"
                  >
                    <button
                      type="button"
                      onClick={() => toggleBookmark(i)}
                      disabled={savingIndex === i}
                      aria-label={savedBookmarks[i] ? "Remove bookmark" : "Bookmark this answer"}
                      className={`flex items-center gap-1 rounded-full shadow-xs shadow-border mt-2 p-1.5 pr-2.5 text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                        savedBookmarks[i]
                          ? "bg-green-500/60 hover:bg-green-500 text-white"
                          : "bg-card text-muted hover:bg-highlight hover:text-card"
                      }`}
                    >
                      
                      {savedBookmarks[i] ? (
                        <><CheckIcon /> Saved</>
                      ) : (
                        <><BookmarkIcon className="w-4 h-4" strokeWidth={2} /> Bookmark</>
                      )}
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Thinking indicator when still waiting for the first token */}
        {isSearching && <ThinkingDots />}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex gap-2 w-full"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder}
            disabled={isStreaming}
            className="flex-1 rounded-lg px-4 py-4 text-sm placeholder-muted focus:outline-none bg-card shadow-sm shadow-border focus:ring-2 focus:ring-accent disabled:opacity-50 shadow-sm shadow-border"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="disabled:opacity-30 disabled:cursor-not-allowed transition-colors px-6 py-2.5 rounded-lg text-sm font-semibold cursor-pointer bg-card hover:bg-highlight hover:text-background"
          >
            {isStreaming ? "…" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
