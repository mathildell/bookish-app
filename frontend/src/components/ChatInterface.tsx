"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ChatMessage, Citation } from "@/types/book";
import { createBookmark, deleteBookmark, streamChat } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import Tooltip from "@/components/Tooltip";

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
        <span className="absolute inline-flex h-full w-full animate-spin rounded-full border-[2px] border-zinc-600 border-t-yellow-500" />
      </span>
      <span className="text-sm text-zinc-400 select-none">Searching{dots}</span>
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
            { role: "assistant", content: `⚠️ ${event.error}`, citations: [] },
          ]);
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { role: "assistant", content: `⚠️ Connection error: ${err}` },
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
      className={`flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 ${
        fill ? "h-full min-h-0" : "h-[360px] min-h-[300px]"
      } ${className}`}
    >
      {/* Messages area */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {welcomeMessage && messages.length === 0 && (
          <div className="bg-zinc-800/60 rounded-lg p-4 text-sm text-zinc-300">
            {welcomeMessage}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className="flex flex-col">
            {msg.role === "user" ? (
              <div className="self-end bg-yellow-600/30 text-zinc-100 rounded-lg px-4 py-2 text-sm">
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
                      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-200"
                    >
                      <span aria-hidden>💭</span>
                      {isStreaming && i === messages.length - 1 && !msg.content
                        ? "Thinking…"
                        : "Thinking"}
                      <span aria-hidden className="text-[9px]">
                        {expandedThinking[i] ? "▲" : "▼"}
                      </span>
                    </button>
                    {expandedThinking[i] && (
                      <div className="max-h-48 w-full overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-700/60 bg-zinc-950/60 p-3 text-[12px] leading-5 text-zinc-500">
                        {msg.thinking}
                      </div>
                    )}
                  </div>
                )}
                {msg.content && (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    className="w-full bg-zinc-800/60 rounded-lg p-4 text-sm text-zinc-300 prose prose-invert prose-sm max-w-none [&_p]:leading-[1.45] [&_li]:leading-[1.45]"
                  >
                    {msg.content}
                  </ReactMarkdown>
                )}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {msg.citations.map((c, ci) => (
                      <span key={ci} className="text-[11px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full">
                        📖 {c.title}
                      </span>
                    ))}
                  </div>
                )}

                {/* Save the finished answer (never the streaming placeholder) */}
                {msg.content && !(isStreaming && i === messages.length - 1) && (
                  <Tooltip
                    label={savedBookmarks[i] ? "Saved — click to remove" : "Save this answer"}
                    align="left"
                  >
                    <button
                      type="button"
                      onClick={() => toggleBookmark(i)}
                      disabled={savingIndex === i}
                      aria-label={savedBookmarks[i] ? "Remove bookmark" : "Bookmark this answer"}
                      className={`flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors disabled:opacity-50 ${
                        savedBookmarks[i]
                          ? "border-yellow-600/60 bg-yellow-500/10 text-yellow-300"
                          : "border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      🔖
                      {savedBookmarks[i] ? "Saved" : "Save"}
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
      <div className="flex-shrink-0 border-t border-zinc-800 p-4">
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
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/40 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="bg-yellow-600 hover:bg-yellow-500 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-900 font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
          >
            {isStreaming ? "…" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
