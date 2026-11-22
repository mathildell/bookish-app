"use client";

import { Suspense, type KeyboardEvent, type ReactNode } from "react";
import ContextPicker from "@/components/write/ContextPicker";
import ContextRail from "@/components/write/ContextRail";
import PlanWorkspace from "@/components/write/PlanWorkspace";
import ThreadWorkspace from "@/components/write/ThreadWorkspace";
import OllamaWarning from "@/components/OllamaWarning";
import { ChatIcon, EditIcon, PlanIcon } from "@/components/icons";
import { WriteSessionProvider, useWriteSession, type Tab } from "@/components/write/session";

// In the order you naturally work: talk it through, plan the scenes, then write them.
const TABS: { id: Tab; label: string; hint: string; icon: ReactNode }[] = [
  { id: "discuss", label: "Discuss", hint: "Ask about the characters, setting and plot", icon: <ChatIcon className="h-4 w-4" /> },
  { id: "plan", label: "Plan", hint: "Plan the story as scenes", icon: <PlanIcon className="h-4 w-4" /> },
  { id: "prose", label: "Prose", hint: "Write scenes", icon: <EditIcon className="h-4 w-4" /> },
];

export default function WritePage() {
  return (
    <Suspense fallback={<div className="py-8 text-muted">Loading…</div>}>
      <WriteSessionProvider>
        <WriteShell />
      </WriteSessionProvider>
    </Suspense>
  );
}

/**
 * Three workspaces over one shared context. The cast, worlds, notes and scene plan
 * live in the session; each workspace is a different way of using them. All three stay
 * mounted so switching tabs never loses a conversation. Nothing is saved yet: a story
 * lasts as long as the page is open.
 */
function WriteShell() {
  const { tab, setTab, cast, activeWorlds, castIds, worldIds, plan, busy, ollamaDown, ollamaHost } = useWriteSession();
  const hasContext = castIds.length > 0 || worldIds.length > 0;
  const contextLabel = [
    cast.length ? cast.map((c) => c.name).join(", ") : "",
    activeWorlds.length ? `${cast.length ? "in " : "World: "}${activeWorlds.map((w) => w.name).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Arrow keys move between tabs, Home and End jump to the ends: the standard tab pattern.
  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(`write-tab-${TABS[next].id}`)?.focus();
  }

  const panelClass = (id: Tab) => (tab === id ? "flex min-h-0 flex-1 flex-col" : "hidden");

  return (
    <div className="flex h-[calc(100vh-5.5rem)] flex-col overflow-hidden pt-4 pb-2">
      <h1 className="text-2xl font-bold tracking-tight">Write</h1>
      <p className="mb-4 mt-1 text-sm text-muted">
        {hasContext ? (
          <>
            {tab === "prose" ? "Casting" : tab === "discuss" ? "Discussing" : "Planning with"}{" "}
            <strong className="text-highlight">{contextLabel}</strong>.
          </>
        ) : (
          "Pick a cast or a world on the left to get started. Everything you add is shared by all three workspaces."
        )}
      </p>

      <div className="flex min-h-0 flex-1 gap-4">
        <ContextRail />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The tabs sit on the panel they open: the active one shares its background,
              so it reads as a tab of that page rather than a button above it. */}
          <div role="tablist" aria-label="Workspace" onKeyDown={onTabKeyDown} className="flex flex-shrink-0 items-end gap-1">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  id={`write-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`write-panel-${t.id}`}
                  tabIndex={active ? 0 : -1}
                  title={t.hint}
                  onClick={() => setTab(t.id)}
                  className={`relative flex cursor-pointer items-center gap-2 rounded-t-lg px-5 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    active
                      ? "z-10 -mb-px bg-background text-foreground shadow-[0_-2px_6px_-3px] shadow-border"
                      : "bg-card text-muted hover:bg-background/60 hover:text-foreground"
                  }`}
                >
                  <span className={active ? "text-accent" : ""}>{t.icon}</span>
                  {t.label}
                  {t.id === "plan" && plan.length > 0 && (
                    <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] leading-none">{plan.length}</span>
                  )}
                  {busy === t.id && (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-highlight" role="status" aria-label="working" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl rounded-tr-xl bg-background shadow-sm shadow-border">
            {ollamaDown && (
              <div className="flex-shrink-0 px-4 pt-2">
                <OllamaWarning host={ollamaHost} />
              </div>
            )}
            <div id="write-panel-discuss" role="tabpanel" aria-labelledby="write-tab-discuss" className={panelClass("discuss")}>
              <ThreadWorkspace mode="discuss" />
            </div>
            <div id="write-panel-plan" role="tabpanel" aria-labelledby="write-tab-plan" className={panelClass("plan")}>
              <PlanWorkspace />
            </div>
            <div id="write-panel-prose" role="tabpanel" aria-labelledby="write-tab-prose" className={panelClass("prose")}>
              <ThreadWorkspace mode="write" />
            </div>
          </div>
        </div>
      </div>

      <ContextPicker />
    </div>
  );
}
