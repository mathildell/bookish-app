"use client";

import Link from "next/link";
import WorldImage from "@/components/WorldImage";
import { ClearIcon } from "@/components/icons";
import { initials } from "@/lib/format";
import NotesPanel from "./NotesPanel";
import { useWriteSession } from "./session";

/** One selected item as a small 2:3 tile that links to its sheet and can be removed. */
function RailTile({
  href,
  label,
  onRemove,
  children,
}: {
  href: string;
  label: string;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="group/tile relative aspect-[2/3] rounded-lg bg-border">
      {/* Clipping lives on the link, not the grid item: overflow-hidden on a grid item
          zeroes its automatic minimum size, which lets rows collapse and overlap. */}
      <Link href={href} className="block h-full w-full overflow-hidden rounded-lg shadow-sm shadow-border">
        {children}
        <div className="absolute inset-x-0 bottom-0 rounded-b-md bg-card p-1 opacity-0 transition-opacity group-hover/tile:opacity-100">
          <p className="line-clamp-2 text-xs font-medium leading-tight">{label}</p>
        </div>
      </Link>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} from the context`}
        className="absolute right-1 top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-card opacity-0 shadow-xs shadow-border transition-colors hover:bg-red-500 hover:text-background group-hover/tile:opacity-100"
      >
        <ClearIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

function SectionHeader({ title, count, onClear }: { title: string; count: number; onClear: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
        {count ? ` (${count})` : ""}
      </p>
      {count > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="cursor-pointer text-xs text-muted transition-colors hover:text-accent"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** The context every workspace shares: who is in the story, where, and what is settled. */
export default function ContextRail() {
  const { cast, castIds, setCastIds, characters, activeWorlds, worldIds, toggleWorld, toggleCast, openPicker } =
    useWriteSession();

  return (
    <aside className="flex min-h-0 w-[220px] flex-shrink-0 flex-col gap-4 overflow-y-auto rounded-xl bg-card p-3 shadow-md shadow-border">
      <section className="space-y-2">
        <SectionHeader title="Cast" count={castIds.length} onClear={() => setCastIds([])} />
        {castIds.length > 0 ? (
          <div className="grid auto-rows-max grid-cols-2 content-start gap-2">
            {castIds.map((id) => {
              const character = (characters ?? []).find((c) => c.id === id);
              const label = character?.name ?? `Character #${id}`;
              return (
                <RailTile key={id} href={`/characters/${id}`} label={label} onRemove={() => toggleCast(id)}>
                  {character?.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={character.thumbnail} alt={label} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-background px-1 text-center text-base font-black text-muted">
                      {character ? initials(character.name) : `#${id}`}
                    </div>
                  )}
                </RailTile>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-muted px-2 py-3 text-center text-xs leading-relaxed text-muted">
            No characters yet.
          </p>
        )}
        <button
          type="button"
          onClick={() => openPicker("characters")}
          className="w-full cursor-pointer rounded-lg bg-background py-1.5 text-xs font-semibold text-muted shadow-sm shadow-border transition-colors hover:bg-highlight hover:text-card"
        >
          + Add characters
        </button>
      </section>

      <section className="space-y-2 border-t border-background pt-3">
        <SectionHeader
          title="Worlds"
          count={worldIds.length}
          onClear={() => worldIds.forEach((id) => toggleWorld(id))}
        />
        {activeWorlds.length > 0 ? (
          <div className="grid auto-rows-max grid-cols-2 content-start gap-2">
            {activeWorlds.map((world) => (
              <RailTile
                key={world.id}
                href={`/worlds/${world.id}`}
                label={world.name}
                onRemove={() => toggleWorld(world.id)}
              >
                <WorldImage world={world} />
              </RailTile>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-muted px-2 py-3 text-center text-xs leading-relaxed text-muted">
            No world selected.
          </p>
        )}
        <button
          type="button"
          onClick={() => openPicker("worlds")}
          className="w-full cursor-pointer rounded-lg bg-background py-1.5 text-xs font-semibold text-muted shadow-sm shadow-border transition-colors hover:bg-highlight hover:text-card"
        >
          + Add a world
        </button>
      </section>

      <section className="border-t border-background pt-3">
        <NotesPanel />
      </section>

      {cast.length > 5 && (
        <p className="text-xs leading-tight text-muted">
          Up to 5 characters get their full profile; beyond that the cast is condensed.
        </p>
      )}
    </aside>
  );
}
