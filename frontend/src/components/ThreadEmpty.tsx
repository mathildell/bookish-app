"use client";

import type { ReactNode } from "react";

/**
 * The first thing either thread shows: centred, muted copy with no card or border
 * around it. Chat and Write share it so their opening states cannot drift apart.
 */
export default function ThreadEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center text-sm leading-relaxed text-zinc-500 [&_strong]:font-semibold [&_strong]:text-zinc-300">
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  );
}
