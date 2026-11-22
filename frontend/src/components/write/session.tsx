"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  bookmarkNoteText,
  updateBookmark,
  useBookmarks,
  useCharacters,
  useOllamaHealth,
  useWorlds,
  type Bookmark,
  type SceneContext,
  type SceneTurn,
} from "@/lib/api";
import { parseIds } from "@/lib/format";
import type { Character } from "@/types/character";
import type { World } from "@/types/world";

export type Tab = "prose" | "discuss" | "plan";
export type Thread = { turns: SceneTurn[]; live: string; suggestions: string[] };
export type PlanCard = {
  id: string;
  title: string;
  setting: string;
  conflict: string;
  brief: string;
  /** "drafted" once a scene has been written from the card in the Prose tab. */
  status: "planned" | "drafted";
};

const EMPTY_THREAD: Thread = { turns: [], live: "", suggestions: [] };
const NOTES_KEY = "bookish.write.notes";
const TABS: Tab[] = ["discuss", "plan", "prose"];
/** The workspace the page opens on. A tab left out of the URL means this one. */
const DEFAULT_TAB: Tab = "discuss";

let cardCounter = 0;
export const newCardId = () => `card-${Date.now().toString(36)}-${(cardCounter++).toString(36)}`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** Everything the three workspaces share. Nothing here is saved: a story is one session. */
type Session = {
  // what the model is given
  characters: Character[] | undefined;
  worlds: World[] | undefined;
  castIds: number[];
  worldIds: number[];
  cast: Character[];
  activeWorlds: World[];
  toggleCast: (id: number) => void;
  toggleWorld: (id: number) => void;
  setCastIds: (ids: number[]) => void;
  // notes: pinned bookmarks + freeform
  bookmarks: Bookmark[] | undefined;
  pinned: Bookmark[];
  notes: string[];
  saveNotes: (next: string[]) => void;
  setBookmarkPinned: (bookmark: Bookmark, value: boolean) => Promise<void>;
  saveBookmarkNote: (bookmark: Bookmark, note: string) => Promise<void>;
  // the scene plan, shared by all three workspaces
  plan: PlanCard[];
  setPlan: (next: PlanCard[] | ((prev: PlanCard[]) => PlanCard[])) => void;
  /** The model-facing context for a workspace (notes include the plan where it helps). */
  contextFor: (tab: Tab) => SceneContext;
  // workspaces
  tab: Tab;
  setTab: (tab: Tab) => void;
  threads: Record<"write" | "discuss", Thread>;
  patchThread: (which: "write" | "discuss", patch: Partial<Thread> | ((t: Thread) => Partial<Thread>)) => void;
  /** Which workspace has a model call running; only one runs at a time. */
  busy: Tab | null;
  setBusy: (tab: Tab | null) => void;
  // hand-off from Discuss / Plan to Prose
  proseDraft: string;
  setProseDraft: (text: string) => void;
  proseCardId: string | null;
  setProseCardId: (id: string | null) => void;
  sendToProse: (brief: string, cardId?: string | null) => void;
  // context picker
  picker: { open: boolean; tab: "characters" | "worlds" | "bookmarks" };
  openPicker: (tab?: "characters" | "worlds" | "bookmarks") => void;
  closePicker: () => void;
  // Ollama
  ollamaDown: boolean;
  ollamaHost?: string;
};

const SessionContext = createContext<Session | null>(null);

export function useWriteSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useWriteSession must be used inside WriteSessionProvider");
  return session;
}

function syncUrl(chars: number[], worlds: number[], tab: Tab) {
  const params = new URLSearchParams();
  if (chars.length) params.set("chars", chars.join(","));
  if (worlds.length) params.set("worlds", worlds.join(","));
  if (tab !== DEFAULT_TAB) params.set("tab", tab);
  const query = params.toString();
  window.history.replaceState(null, "", `/write${query ? `?${query}` : ""}`);
}

function outlineLines(plan: PlanCard[], detail: "short" | "full"): string {
  return plan
    .map((card, i) => {
      const where = card.setting ? ` (${card.setting})` : "";
      const body = detail === "full" ? ` ${clip(card.brief, 240)}` : "";
      return `${i + 1}. ${card.title || "Untitled"}${where}.${body}`;
    })
    .join("\n");
}

export function WriteSessionProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [castIds, setCastIdsState] = useState<number[]>([]);
  const [worldIds, setWorldIds] = useState<number[]>([]);
  const [tab, setTabState] = useState<Tab>(DEFAULT_TAB);
  useEffect(() => {
    setCastIdsState(parseIds(searchParams.get("chars")));
    setWorldIds(parseIds(searchParams.get("worlds")));
    const wanted = searchParams.get("tab");
    setTabState(wanted && (TABS as string[]).includes(wanted) ? (wanted as Tab) : DEFAULT_TAB);
  }, [searchParams]);

  const { data: characters } = useCharacters();
  const { data: worlds } = useWorlds();
  const { data: bookmarks } = useBookmarks();
  const { data: ollamaHealth } = useOllamaHealth();

  const cast = useMemo(() => (characters ?? []).filter((c) => castIds.includes(c.id)), [characters, castIds]);
  const activeWorlds = useMemo(() => (worlds ?? []).filter((w) => worldIds.includes(w.id)), [worlds, worldIds]);
  const pinned = useMemo(() => (bookmarks ?? []).filter((b) => Boolean(b.pinned)), [bookmarks]);

  // The URL write stays out of state updaters: React may run an updater during render,
  // and rewriting history there fires a Router update mid-render.
  const setCastIds = useCallback(
    (ids: number[]) => {
      setCastIdsState(ids);
      syncUrl(ids, worldIds, tab);
    },
    [worldIds, tab]
  );
  const toggleCast = useCallback(
    (id: number) => setCastIds(castIds.includes(id) ? castIds.filter((x) => x !== id) : [...castIds, id]),
    [castIds, setCastIds]
  );
  const toggleWorld = useCallback(
    (id: number) => {
      const next = worldIds.includes(id) ? worldIds.filter((x) => x !== id) : [...worldIds, id];
      setWorldIds(next);
      syncUrl(castIds, next, tab);
    },
    [castIds, worldIds, tab]
  );
  const setTab = useCallback(
    (next: Tab) => {
      setTabState(next);
      syncUrl(castIds, worldIds, next);
    },
    [castIds, worldIds]
  );

  // Freeform notes are the writer's own and never bookmarks, so they stay in the browser.
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "[]");
      if (Array.isArray(raw)) setNotes(raw.filter((n): n is string => typeof n === "string"));
    } catch {
      // Storage can be unavailable (private window); notes then last for the session.
    }
  }, []);
  const saveNotes = useCallback((next: string[]) => {
    setNotes(next);
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(next));
    } catch {
      // see above
    }
  }, []);

  const setBookmarkPinned = useCallback(
    async (bookmark: Bookmark, value: boolean) => {
      await updateBookmark(bookmark.id, { pinned: value });
      await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
    },
    [queryClient]
  );
  const saveBookmarkNote = useCallback(
    async (bookmark: Bookmark, note: string) => {
      if (note.trim() === (bookmark.note ?? "").trim()) return;
      await updateBookmark(bookmark.id, { note });
      await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
    },
    [queryClient]
  );

  const [plan, setPlan] = useState<PlanCard[]>([]);
  const [threads, setThreads] = useState<Record<"write" | "discuss", Thread>>({
    write: EMPTY_THREAD,
    discuss: EMPTY_THREAD,
  });
  const patchThread = useCallback(
    (which: "write" | "discuss", patch: Partial<Thread> | ((t: Thread) => Partial<Thread>)) =>
      setThreads((prev) => ({
        ...prev,
        [which]: { ...prev[which], ...(typeof patch === "function" ? patch(prev[which]) : patch) },
      })),
    []
  );
  const [busy, setBusy] = useState<Tab | null>(null);

  const [proseDraft, setProseDraft] = useState("");
  const [proseCardId, setProseCardId] = useState<string | null>(null);
  const sendToProse = useCallback(
    (brief: string, cardId: string | null = null) => {
      setProseDraft(brief);
      setProseCardId(cardId);
      setTab("prose");
    },
    [setTab]
  );

  const [picker, setPicker] = useState<Session["picker"]>({ open: false, tab: "characters" });
  const openPicker = useCallback(
    (which: Session["picker"]["tab"] = "characters") => setPicker({ open: true, tab: which }),
    []
  );
  const closePicker = useCallback(() => setPicker((p) => ({ ...p, open: false })), []);

  // Pinned bookmarks and freeform notes go to every workspace. The plan goes too: Discuss
  // and Plan see it whole, so they can talk about it and extend it; Prose sees it only as
  // orientation while it writes a planned scene, with an instruction not to run ahead.
  const contextFor = useCallback(
    (which: Tab): SceneContext => {
      const base = [...pinned.map((b) => bookmarkNoteText(b)), ...notes];
      const extra: string[] = [];
      if (plan.length > 0) {
        if (which === "prose") {
          const index = plan.findIndex((c) => c.id === proseCardId);
          if (index >= 0) {
            extra.push(
              "Story outline, for orientation only. Write ONLY the scene you are asked for; never narrate later scenes:\n" +
                outlineLines(plan, "short") +
                `\nYou are writing scene ${index + 1}: ${plan[index].title || "Untitled"}.`
            );
          }
        } else {
          extra.push("Current scene plan, in order:\n" + outlineLines(plan, "full"));
        }
      }
      return { character_ids: castIds, world_ids: worldIds, notes: [...base, ...extra] };
    },
    [castIds, worldIds, notes, pinned, plan, proseCardId]
  );

  const value: Session = {
    characters, worlds, castIds, worldIds, cast, activeWorlds, toggleCast, toggleWorld, setCastIds,
    bookmarks, pinned, notes, saveNotes, setBookmarkPinned, saveBookmarkNote,
    plan, setPlan, contextFor,
    tab, setTab, threads, patchThread, busy, setBusy,
    proseDraft, setProseDraft, proseCardId, setProseCardId, sendToProse,
    picker, openPicker, closePicker,
    ollamaDown: ollamaHealth?.ok === false,
    ollamaHost: ollamaHealth?.host,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
