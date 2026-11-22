"use client";

import { useState } from "react";
import { collageUrl } from "@/lib/api";
import { WorldIcon } from "@/components/icons";
import { initials } from "@/lib/format";
import type { World } from "@/types/world";

/** The URL a world's picture comes from: its own image, else a collage of its covers. */
export function worldImageSrc(world: Pick<World, "image" | "source_book_ids">): string | null {
  return world.image || collageUrl(world.source_book_ids);
}

/**
 * A world's picture, filling its container. It falls back to a globe over the world's
 * initials when there is no image, no source covers, or the image fails to load.
 */
export default function WorldImage({
  world,
  className = "",
}: {
  world: Pick<World, "name" | "image" | "source_book_ids">;
  className?: string;
}) {
  const src = worldImageSrc(world);
  const [failed, setFailed] = useState<string | null>(null);

  if (src && failed !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={world.name}
        loading="lazy"
        onError={() => setFailed(src)}
        className={`h-full w-full object-cover ${className}`}
      />
    );
  }
  return (
    <div className={`flex h-full w-full flex-col items-center justify-center gap-2 bg-background ${className}`}>
      <WorldIcon className="h-1/4 w-1/4 min-h-6 min-w-6 text-accent/60" />
      <span className="px-2 text-center text-lg font-black tracking-tight text-muted">{initials(world.name)}</span>
    </div>
  );
}
