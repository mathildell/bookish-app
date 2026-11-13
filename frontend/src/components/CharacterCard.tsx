"use client";

import Link from "next/link";
import { useState } from "react";
import type { Character } from "@/types/character";
import { CheckIcon } from "@/components/icons";
import { initials } from "@/lib/format";

export default function CharacterCard({
  character,
  selected,
  onToggleSelect,
}: {
  character: Character;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const busy = character.status === "generating";
  const failed = character.status === "failed";
  const isSelected = Boolean(selected) && Boolean(onToggleSelect);

  return (
    <Link
      href={`/characters/${character.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group relative block h-[270px] w-[180px] overflow-hidden rounded-xl cursor-pointer shadow-sm shadow-border hover:shadow-lg hover:shadow-black/50 transition-shadow duration-200"
    >
      {/* Portrait (fallback: initials) */}
      <div className="absolute inset-0 flex items-center justify-center bg-background">
        {character.thumbnail ? (
          <img src={character.thumbnail} alt={character.name} className="h-full w-full object-cover" />
        ) : (
          <span className="text-3xl font-black tracking-tight text-muted">{initials(character.name)}</span>
        )}
      </div>

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
          className={`absolute top-2 left-2 z-20 flex h-6 w-6 items-center justify-center rounded-md border shadow-xs shadow-black/60 transition-all cursor-pointer hover:ring-2 hover:ring-accent ${
            isSelected ? "bg-highlight/90 border-accent" : "bg-card/80 border-border hover:bg-card"
          }`}
        >
          <CheckIcon className={isSelected ? "text-accent p-0.5" : "text-transparent"} />
        </button>
      )}

      {(busy || failed) && (
        <span
          className={`absolute top-2 z-10 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            onToggleSelect ? "left-10" : "left-2"
          } ${failed ? "bg-red-600 text-white" : "bg-accent text-highlight"}`}
        >
          {failed ? "failed" : "generating…"}
        </span>
      )}

      {character.role && (
        <span className="absolute right-2 top-2 rounded-full bg-card/90 px-2 py-0.5 text-[10px] font-medium capitalize text-foreground">
          {character.role}
        </span>
      )}

      {/* Hover overlay — same card-coloured panel as the book cards */}
      <div
        className={
          "absolute inset-x-0 bottom-0 bg-card p-4 transition-all duration-300 ease-out" +
          (hovered ? " max-h-[100%] opacity-100" : " max-h-0 opacity-0 overflow-hidden")
        }
      >
        <p className="font-bold text-sm leading-snug line-clamp-3 mb-1">{character.name}</p>
        {character.archetype && (
          <p className="text-xs text-muted italic line-clamp-2">{character.archetype}</p>
        )}
        {character.summary && (
          <p className="text-xs text-muted mt-1 line-clamp-4">{character.summary}</p>
        )}
      </div>
    </Link>
  );
}
