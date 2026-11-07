"use client";

import Link from "next/link";
import type { Character } from "@/types/character";

/** Two initials, used when a profile has no thumbnail yet. */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function CharacterCard({
  character,
  selected,
  onToggleSelect,
}: {
  character: Character;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}) {
  const busy = character.status === "generating";
  const failed = character.status === "failed";
  const isSelected = Boolean(selected) && Boolean(onToggleSelect);

  return (
    <Link
      href={`/characters/${character.id}`}
      className="group relative block h-[270px] w-[180px] overflow-hidden rounded-xl bg-zinc-800 shadow-lg shadow-black/30 transition-shadow duration-200 hover:shadow-xl"
    >
      {character.thumbnail ? (
        <img
          src={character.thumbnail}
          alt={character.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-zinc-800 to-zinc-900">
          <span className="text-3xl font-black tracking-tight text-zinc-600">
            {initials(character.name)}
          </span>
        </div>
      )}

      {/* Selection checkbox — same affordance as the library's book cards. */}
      {onToggleSelect && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSelect(character.id);
          }}
          aria-label={isSelected ? `Deselect ${character.name}` : `Select ${character.name}`}
          className={`absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-md transition-all ${
            isSelected
              ? "bg-yellow-500 shadow-md"
              : "border border-zinc-600 bg-zinc-900/80 hover:border-yellow-500"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6L5 9L10 3"
              stroke={isSelected ? "#18181b" : "transparent"}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {(busy || failed) && (
        <span
          className={`absolute top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            onToggleSelect ? "left-10" : "left-2"
          } ${failed ? "bg-red-600 text-white" : "bg-yellow-500 text-zinc-900"}`}
        >
          {failed ? "failed" : "generating…"}
        </span>
      )}

      {character.role && (
        <span className="absolute right-2 top-2 rounded-full bg-zinc-950/80 px-2 py-0.5 text-[10px] font-medium capitalize text-zinc-300">
          {character.role}
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 bg-zinc-950/90 p-3 text-white">
        <p className="text-sm font-bold leading-snug line-clamp-2">{character.name}</p>
        {character.archetype && (
          <p className="mt-0.5 text-[11px] italic text-yellow-400 line-clamp-1">
            {character.archetype}
          </p>
        )}
        {character.summary && (
          <p className="mt-1 hidden text-[11px] leading-snug text-zinc-400 line-clamp-3 group-hover:block">
            {character.summary}
          </p>
        )}
      </div>
    </Link>
  );
}
