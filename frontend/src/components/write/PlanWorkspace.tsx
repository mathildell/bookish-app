"use client";

import { useState } from "react";
import ThreadEmpty from "@/components/ThreadEmpty";
import { planScenes } from "@/lib/api";
import { PILL } from "./ThreadWorkspace";
import { newCardId, useWriteSession, type PlanCard } from "./session";

// `field-sizing: content` lets a textarea grow to fit what is written in it.
const FIELD =
  "w-full resize-none rounded-lg [field-sizing:content] bg-background px-2.5 py-1.5 text-xs placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent";

/**
 * The scene plan: an ordered board of cards, editable, shared with the other workspaces.
 * Generate cards from the discussion, add your own, reorder them, and write any of them
 * in the Prose tab. A card is marked drafted once a scene has been written from it.
 */
export default function PlanWorkspace() {
  const s = useWriteSession();
  const { plan, setPlan } = s;
  const [steer, setSteer] = useState("");
  const [count, setCount] = useState(3);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasContext = s.castIds.length > 0 || s.worldIds.length > 0;
  const busy = s.busy !== null;
  const locked = !hasContext || busy || s.ollamaDown;

  async function generate(replace: boolean) {
    if (locked) return;
    if (replace && plan.length > 0 && !confirm("Replace the whole plan, including cards you edited?")) return;
    setPlanning(true);
    s.setBusy("plan");
    setError(null);
    try {
      const ask = steer.trim();
      const message = replace
        ? `Ignore any current plan and propose a fresh one. ${ask}`.trim()
        : `Add ${count} scenes that come after the current plan and follow from it. ${ask}`.trim();
      const cards = await planScenes({
        ...s.contextFor("plan"),
        message,
        history: s.threads.discuss.turns,
        count,
      });
      const made: PlanCard[] = cards.map((c) => ({ ...c, id: newCardId(), status: "planned" }));
      setPlan(replace ? made : [...plan, ...made]);
      setSteer("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to plan scenes");
    } finally {
      s.setBusy(null);
      setPlanning(false);
    }
  }

  const patchCard = (id: string, patch: Partial<PlanCard>) =>
    setPlan((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const move = (index: number, by: number) =>
    setPlan((prev) => {
      const next = [...prev];
      const target = index + by;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-shrink-0 space-y-2 border-b border-background px-6 py-4">
        <p className="text-xs text-muted">
          Plan the story as scenes. Cards are generated from your cast, world, notes and the Discuss conversation,
          and you can edit, reorder and add to them. Write any card in the Prose tab.
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <textarea
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            rows={2}
            disabled={locked}
            placeholder={
              !hasContext
                ? "Pick a cast or a world first…"
                : "Optional: steer the plan, e.g. “a slow burn, with the confession in scene 4”"
            }
            className="min-w-[240px] flex-1 resize-none rounded-lg bg-card px-3 py-2 text-sm shadow-sm shadow-border placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                disabled={locked}
                aria-label="Number of scenes"
                className="cursor-pointer rounded-lg bg-card px-2 py-2 text-sm shadow-sm shadow-border focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              >
                {[3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} scenes
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => generate(plan.length === 0)}
                disabled={locked}
                className="cursor-pointer rounded-lg bg-card px-4 py-2 text-sm font-semibold shadow-sm shadow-border transition-colors hover:bg-highlight hover:text-background disabled:cursor-not-allowed disabled:opacity-30"
              >
                {planning ? "Planning…" : plan.length === 0 ? "Plan scenes" : "Add scenes"}
              </button>
            </div>
            <div className="flex gap-1.5">
              {plan.length > 0 && (
                <button
                  type="button"
                  onClick={() => generate(true)}
                  disabled={locked}
                  className={PILL}
                  title="Throw the plan away and generate a fresh one"
                >
                  Replace plan
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setPlan([...plan, { id: newCardId(), title: "", setting: "", conflict: "", brief: "", status: "planned" }])
                }
                className={PILL}
              >
                + Blank card
              </button>
            </div>
          </div>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {plan.length === 0 && !planning ? (
          <ThreadEmpty>
            <>
              <p>
                No scenes planned yet. Generate a few from your cast and world, or start with a blank card and write
                your own.
              </p>
              <p className="text-xs">
                Talking it through in <strong>Discuss</strong> first gives the plan more to work with.
              </p>
            </>
          </ThreadEmpty>
        ) : (
          <ol className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {plan.map((card, i) => (
              <li key={card.id} className="flex flex-col gap-2 rounded-xl bg-card p-4 shadow-md shadow-border">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-muted">{i + 1}.</span>
                  <input
                    value={card.title}
                    onChange={(e) => patchCard(card.id, { title: e.target.value })}
                    placeholder="Scene title"
                    aria-label={`Scene ${i + 1} title`}
                    className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-sm font-bold focus:bg-background focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <button
                    type="button"
                    onClick={() => patchCard(card.id, { status: card.status === "drafted" ? "planned" : "drafted" })}
                    title="Click to toggle. It switches to drafted by itself once you write the scene."
                    className={`flex-none cursor-pointer rounded-full border px-2 py-0.5 text-xs leading-3 transition-colors ${
                      card.status === "drafted"
                        ? "border-green-500/60 bg-green-500/20 text-green-300"
                        : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {card.status === "drafted" ? "drafted ✓" : "planned"}
                  </button>
                </div>
                <input
                  value={card.setting}
                  onChange={(e) => patchCard(card.id, { setting: e.target.value })}
                  placeholder="Setting"
                  aria-label={`Scene ${i + 1} setting`}
                  className={FIELD}
                />
                <textarea
                  value={card.conflict}
                  onChange={(e) => patchCard(card.id, { conflict: e.target.value })}
                  rows={2}
                  placeholder="Conflict"
                  aria-label={`Scene ${i + 1} conflict`}
                  className={FIELD}
                />
                <textarea
                  value={card.brief}
                  onChange={(e) => patchCard(card.id, { brief: e.target.value })}
                  rows={4}
                  placeholder="Brief for the prose writer: who is present, what they know of each other, what the scene must do"
                  aria-label={`Scene ${i + 1} brief`}
                  className={FIELD}
                />
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => s.sendToProse(card.brief, card.id)}
                    disabled={!card.brief.trim() || s.castIds.length === 0}
                    title={s.castIds.length === 0 ? "Pick a cast first" : "Put this brief in the Prose tab"}
                    className={PILL}
                  >
                    Write this scene →
                  </button>
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-background hover:text-foreground disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === plan.length - 1}
                      aria-label="Move down"
                      className="cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-background hover:text-foreground disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => setPlan(plan.filter((c) => c.id !== card.id))}
                      aria-label="Delete card"
                      className="cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-red-600 hover:text-red-100"
                    >
                      ✕
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
        {planning && <p className="mt-3 animate-pulse text-sm text-muted">Planning scenes…</p>}
      </div>
    </div>
  );
}
