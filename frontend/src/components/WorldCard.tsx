"use client";

import Link from "next/link";
import { useState } from "react";
import type { World } from "@/types/world";
import { CheckIcon } from "@/components/icons";
import WorldImage from "@/components/WorldImage";

/** A world as a card in the same 180x270 format as a character, so the grids read alike. */
export default function WorldCard({
  world,
  selected,
  onToggleSelect,
}: {
  world: World;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isSelected = Boolean(selected) && Boolean(onToggleSelect);

  return (
    <Link
      href={`/worlds/${world.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group relative block h-[270px] w-[180px] overflow-hidden rounded-xl cursor-pointer shadow-sm shadow-border hover:shadow-lg hover:shadow-black/50 transition-shadow duration-200"
    >
      {/* Its own picture, else a collage of its source covers, else a globe over its initials. */}
      <div className="absolute inset-0 bg-background">
        <WorldImage world={world} />
      </div>

      {onToggleSelect && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSelect(world.id);
          }}
          aria-label={isSelected ? `Deselect ${world.name}` : `Select ${world.name}`}
          className={`absolute top-2 left-2 z-20 flex h-6 w-6 items-center justify-center rounded-md border shadow-xs shadow-black/60 transition-all cursor-pointer hover:ring-2 hover:ring-accent ${
            isSelected ? "bg-highlight/90 border-accent" : "bg-card/80 border-border hover:bg-card"
          }`}
        >
          <CheckIcon className={isSelected ? "text-accent p-0.5" : "text-transparent"} />
        </button>
      )}

      {world.source_book_ids.length > 0 && (
        <span className="absolute right-2 top-2 rounded-full bg-card/90 px-2 py-0.5 text-[10px] font-medium text-foreground">
          {world.source_book_ids.length} book{world.source_book_ids.length === 1 ? "" : "s"}
        </span>
      )}

      {/* Hover overlay — same card-coloured panel as the character and book cards */}
      <div
        className={
          "absolute inset-x-0 bottom-0 bg-card p-4 transition-all duration-300 ease-out" +
          (hovered ? " max-h-[100%] opacity-100" : " max-h-0 opacity-0 overflow-hidden")
        }
      >
        <p className="font-bold text-sm leading-snug line-clamp-3 mb-1">{world.name}</p>
        {world.premise && <p className="text-xs text-muted mt-1 line-clamp-5">{world.premise}</p>}
        <p className="text-xs text-muted mt-2">
          {world.rules.length} rule{world.rules.length === 1 ? "" : "s"} · {world.terminology.length} term
          {world.terminology.length === 1 ? "" : "s"}
        </p>
      </div>
    </Link>
  );
}
