"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ThreadEmpty from "@/components/ThreadEmpty";
import Tooltip from "@/components/Tooltip";
import { BookmarkIcon, CheckIcon, ClearIcon } from "@/components/icons";
import {
  createBookmark,
  deleteBookmark,
  distillReply,
  regenerateSceneSuggestions,
  streamScene,
  updateBookmark,
} from "@/lib/api";
import { useWriteSession } from "./session";

export const PILL =
  "flex min-h-7 max-w-full items-center gap-1 rounded-full shadow-xs shadow-border bg-card px-3 py-1 text-left text-xs leading-snug text-muted cursor-pointer transition-colors hover:bg-highlight hover:text-card disabled:cursor-wait disabled:opacity-50";

type Mode = "write" | "discuss";

/**
 * The Prose and Discuss workspaces. Both are a conversation with the model about the
 * shared context; they differ in what comes back (a scene, or analysis) and in what can
 * be done with a reply. Tone is steered in the message itself.
 */
export default function ThreadWorkspace({ mode }: { mode: Mode }) {
  const s = useWriteSession();
  const queryClient = useQueryClient();
  const tab = mode === "write" ? "prose" : "discuss";
  const thread = s.threads[mode];
  const turns = thread.turns;

  // The Prose input lives in the session so Discuss and Plan can hand a brief to it.
  const [localDraft, setLocalDraft] = useState("");
  const draft = mode === "write" ? s.proseDraft : localDraft;
  const setDraft = mode === "write" ? s.setProseDraft : setLocalDraft;
  const inputRef = useRef<HTMLInputElement>(null);

  // A brief handed over from Discuss or Plan lands in the Prose input: focus it there.
  useEffect(() => {
    if (mode === "write" && s.tab === "prose") inputRef.current?.focus();
  }, [mode, s.tab]);

  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [distilling, setDistilling] = useState<string | null>(null);
  const [savedBookmarks, setSavedBookmarks] = useState<Record<number, number>>({});
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  const hasContext = mode === "write" ? s.castIds.length > 0 : s.castIds.length > 0 || s.worldIds.length > 0;
  const busy = s.busy !== null;
  const thisPending = s.busy === tab;
  const locked = !hasContext || busy || s.ollamaDown;

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy || s.ollamaDown || !hasContext) return;

      const history = turns;
      const context = s.contextFor(tab);
      const cardId = mode === "write" ? s.proseCardId : null;
      s.setBusy(tab);
      setError(null);
      setThinking(false);
      s.patchThread(mode, { live: "", suggestions: [], turns: [...history, { role: "user", content: message }] });

      let streamed = "";
      try {
        for await (const event of streamScene(
          { ...context, message, history },
          mode === "discuss" ? "/write/discuss" : "/write/stream"
        )) {
          if (event.kind === "token") {
            streamed += event.text;
            setThinking(false);
            s.patchThread(mode, { live: streamed });
          } else if (event.kind === "thinking") {
            setThinking(true);
          } else if (event.kind === "done") {
            const answer = event.answer || streamed;
            s.patchThread(mode, (t) => ({
              live: "",
              suggestions: event.suggestions,
              turns: [...t.turns, { role: "assistant", content: answer }],
            }));
            // A scene written from a plan card ticks that card off.
            if (cardId) {
              s.setPlan((plan) => plan.map((c) => (c.id === cardId ? { ...c, status: "drafted" } : c)));
            }
            if (mode === "discuss") {
              // Follow-up questions arrive after the reply, so the answer is never held up.
              regenerateSceneSuggestions({
                ...context,
                mode: "discuss",
                history: [...history, { role: "user", content: message }, { role: "assistant", content: answer }],
              })
                .then((suggestions) => s.patchThread("discuss", { suggestions }))
                .catch(() => undefined);
            }
          } else if (event.kind === "error") {
            setError(event.error);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : mode === "discuss" ? "Discussion failed" : "Writing failed");
      } finally {
        s.setBusy(null);
        setThinking(false);
        s.patchThread(mode, { live: "" });
      }
    },
    [busy, hasContext, mode, s, tab, turns]
  );

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
          const turn = turns[index];
          if (turn?.role !== "assistant" || !turn.content) return;
          const saved = await createBookmark({
            question: index > 0 && turns[index - 1].role === "user" ? turns[index - 1].content : "",
            answer: turn.content,
            citations: [],
            scope: mode,
            calibre_ids: [],
            note: "",
            color: "yellow",
          });
          setSavedBookmarks((prev) => ({ ...prev, [index]: saved.id }));
        }
        await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
      } catch {
        // Leave the button usable; the bookmark wall is the source of truth if this fails.
      } finally {
        setSavingIndex(null);
      }
    },
    [mode, queryClient, savedBookmarks, turns]
  );

  // Pinning saves the reply as a bookmark (if it is not one already) and pins it, so it
  // reaches the model as a note. The bookmark's note holds a one-line distillation of the
  // reply; the full reply stays in the bookmark. If condensing fails it is pinned as it is.
  const togglePin = useCallback(
    async (index: number) => {
      const existing = (s.bookmarks ?? []).find((b) => b.id === savedBookmarks[index]);
      setDistilling(`note:${index}`);
      try {
        if (existing?.pinned) {
          await updateBookmark(existing.id, { pinned: false });
        } else {
          const turn = turns[index];
          if (turn?.role !== "assistant" || !turn.content) return;
          let note = "";
          try {
            note = await distillReply({ content: turn.content, kind: "note", character_ids: s.castIds });
          } catch {
            // pin the reply itself
          }
          const saved = existing
            ? await updateBookmark(existing.id, { pinned: true, ...(note && !existing.note ? { note } : {}) })
            : await createBookmark({
                question: index > 0 && turns[index - 1].role === "user" ? turns[index - 1].content : "",
                answer: turn.content,
                citations: [],
                scope: mode,
                calibre_ids: [],
                note,
                color: "yellow",
                pinned: true,
              });
          setSavedBookmarks((prev) => ({ ...prev, [index]: saved.id }));
        }
        await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't pin that reply");
      } finally {
        setDistilling(null);
      }
    },
    [mode, queryClient, s.bookmarks, s.castIds, savedBookmarks, turns]
  );

  const sendReplyToProse = useCallback(
    async (index: number) => {
      setDistilling(`brief:${index}`);
      try {
        const brief = await distillReply({ content: turns[index].content, kind: "brief", character_ids: s.castIds });
        if (brief) s.sendToProse(brief);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't condense that reply");
      } finally {
        setDistilling(null);
      }
    },
    [s, turns]
  );

  const refreshSuggestions = useCallback(async () => {
    if (!hasContext || turns.length === 0 || regenerating) return;
    setRegenerating(true);
    try {
      s.patchThread(mode, {
        suggestions: await regenerateSceneSuggestions({ ...s.contextFor(tab), mode, history: turns }),
      });
    } catch {
      setError("Couldn't regenerate suggestions");
    } finally {
      setRegenerating(false);
    }
  }, [hasContext, mode, regenerating, s, tab, turns]);

  const body = (content: string) =>
    mode === "discuss" ? (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        className="rounded-lg bg-card shadow-md shadow-border p-4 prose prose-sm max-w-none [&_p]:leading-[1.35] [&_li]:leading-[1.35]"
      >
        {content}
      </ReactMarkdown>
    ) : (
      <div className="whitespace-pre-wrap rounded-lg bg-card shadow-md shadow-border p-4 text-sm leading-relaxed">
        {content}
      </div>
    );

  const writingCard = mode === "write" ? s.plan.findIndex((c) => c.id === s.proseCardId) : -1;
  const width = mode === "discuss" ? "w-[85%]" : "w-3/4";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex flex-col">
              <div className="self-end rounded-lg border border-accent bg-accent/20 px-4 py-2 text-sm">{turn.content}</div>
            </div>
          ) : (
            <div key={i} className="flex flex-col">
              <div className={`space-y-2 self-start ${width}`}>
                {body(turn.content)}
                <div className="flex flex-wrap items-center gap-2">
                  <Tooltip label={savedBookmarks[i] ? "Saved — click to remove" : "Save this reply"} align="left">
                    <button
                      type="button"
                      onClick={() => toggleBookmark(i)}
                      disabled={savingIndex === i}
                      aria-label={savedBookmarks[i] ? "Remove bookmark" : "Bookmark this reply"}
                      className={`flex cursor-pointer items-center gap-1 rounded-full p-1.5 pr-2.5 text-xs shadow-xs shadow-border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        savedBookmarks[i]
                          ? "bg-green-500/60 text-white hover:bg-green-500"
                          : "bg-card text-muted hover:bg-highlight hover:text-card"
                      }`}
                    >
                      {savedBookmarks[i] ? (
                        <>
                          <CheckIcon /> Saved
                        </>
                      ) : (
                        <>
                          <BookmarkIcon className="h-4 w-4" strokeWidth={2} /> Save
                        </>
                      )}
                    </button>
                  </Tooltip>
                  {mode === "discuss" && (
                    <button
                      type="button"
                      onClick={() => sendReplyToProse(i)}
                      disabled={distilling !== null || busy || s.ollamaDown}
                      className={PILL}
                      title="Turn this into a scene brief in the Prose tab"
                    >
                      {distilling === `brief:${i}` ? "Condensing…" : "Send to Prose →"}
                    </button>
                  )}
                  {(() => {
                    const isPinned = Boolean((s.bookmarks ?? []).find((b) => b.id === savedBookmarks[i])?.pinned);
                    return (
                      <button
                        type="button"
                        onClick={() => togglePin(i)}
                        disabled={distilling !== null || busy || s.ollamaDown}
                        className={PILL}
                        title={
                          isPinned
                            ? "Unpin: stop sending this to the model as a note"
                            : "Save as a bookmark and pin it: the model treats it as established canon"
                        }
                      >
                        {distilling === `note:${i}` ? "Condensing…" : isPinned ? "Pinned ✓" : "Pin as note"}
                      </button>
                    );
                  })()}
                  {i === turns.length - 1 && !thisPending && (
                    <>
                      {thread.suggestions.map((beat, bi) => (
                        <button key={`${bi}-${beat}`} type="button" onClick={() => send(beat)} title={beat} className={PILL}>
                          {beat}
                        </button>
                      ))}
                      <Tooltip
                        label={
                          regenerating
                            ? "Generating suggestions…"
                            : mode === "discuss"
                              ? "Suggest more questions"
                              : "Suggest three more routes"
                        }
                        align="left"
                      >
                        <button
                          type="button"
                          onClick={refreshSuggestions}
                          disabled={regenerating}
                          aria-busy={regenerating}
                          aria-label="Regenerate suggestions"
                          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-card text-xs text-muted shadow-xs shadow-border transition-colors hover:bg-highlight hover:text-card disabled:cursor-wait"
                        >
                          <span aria-hidden className={regenerating ? "inline-block animate-spin" : "inline-block"}>
                            ↻
                          </span>
                        </button>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        )}

        {thisPending && thread.live && (
          <div className="flex flex-col">
            <div className={`space-y-2 self-start ${width}`}>{body(thread.live)}</div>
          </div>
        )}
        {thisPending && !thread.live && (
          <p className="animate-pulse text-sm text-muted">
            {thinking ? "Thinking…" : mode === "discuss" ? "Considering…" : "Writing…"}
          </p>
        )}

        {turns.length === 0 && !thisPending && (
          <ThreadEmpty>
            {mode === "write" ? (
              <>
                <p>
                  Hi! Cast a character or two, then describe the scene: a setting, a tension, who speaks first.
                  Or write a scene straight from a card in the Plan tab.
                </p>
                <p className="text-xs">
                  Every reply is <strong>third person, past tense</strong>, 500 words or fewer.
                </p>
              </>
            ) : (
              <>
                <p>
                  Talk it through before you write it. Ask how these characters would clash, which setting would
                  break them, or what should happen next.
                </p>
                <p className="text-xs">
                  Replies are analysis, not prose. Use <strong>Send to Prose</strong> on a reply, or switch to the{" "}
                  <strong>Plan</strong> tab to turn the conversation into scenes.
                </p>
              </>
            )}
          </ThreadEmpty>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      {writingCard >= 0 && (
        <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-1 text-xs text-muted">
          <span className="rounded-full border border-accent bg-accent/20 px-2.5 py-1 text-foreground">
            Writing scene {writingCard + 1}: {s.plan[writingCard].title || "Untitled"}
          </span>
          <button
            type="button"
            onClick={() => s.setProseCardId(null)}
            className="flex cursor-pointer items-center gap-1 transition-colors hover:text-foreground"
            title="Stop linking this to the plan"
          >
            <ClearIcon /> unlink
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
          setDraft("");
        }}
        className="flex w-full flex-shrink-0 gap-2 p-4"
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            s.ollamaDown
              ? "Ollama is unreachable…"
              : !hasContext
                ? mode === "write"
                  ? "Pick a cast first…"
                  : "Pick a cast or a world first…"
                : mode === "write"
                  ? "What happens next?"
                  : "Ask about the characters, the setting, the plot…"
          }
          disabled={locked}
          className="min-w-0 flex-1 rounded-lg bg-card px-4 py-4 text-sm shadow-sm shadow-border placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={locked || !draft.trim()}
          className="cursor-pointer rounded-lg bg-card px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:opacity-30"
        >
          {mode === "write" ? "Write" : "Ask"}
        </button>
      </form>
    </div>
  );
}
