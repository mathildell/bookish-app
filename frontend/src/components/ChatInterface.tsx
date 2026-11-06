"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ChatMessage, Citation } from "@/types/book";
import { streamChat } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";

interface Props {
  calibreIds?: number[];
  scope: "book" | "multi_book";
  placeholder?: string;
  welcomeMessage?: ReactNode;
  className?: string;
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
    try {
      for await (const event of streamChat(
        userMsg.content,
        history,
        calibreIds?.length ? calibreIds : undefined,
        scope
      )) {
        if (event.type === "token") {
          fullText += event.text;
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: fullText, citations: [] },
          ]);
        } else if (event.type === "done") {
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { role: "assistant", content: event.answer, citations: event.citations },
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

  /* Determine whether the last message is an empty assistant placeholder
     that still has no content while streaming — i.e. the searching phase. */
  const isSearching = isStreaming &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    !messages[messages.length - 1].content;

  return (
    <div className={`flex flex-col bg-zinc-900/50 rounded-xl border border-zinc-800 overflow-hidden h-[360px] min-h-[300px] ${className}`}>
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
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
              <div className="self-start space-y-2">
                {msg.content && (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    className="bg-zinc-800/60 rounded-lg p-4 text-sm text-zinc-300 leading-7 prose prose-invert prose-sm max-w-none"
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
              </div>
            )}
          </div>
        ))}

        {/* Thinking indicator when still waiting for the first token */}
        {isSearching && <ThinkingDots />}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-zinc-800 p-4">
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
