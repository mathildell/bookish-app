"use client";

import { useRef, useState } from "react";
import { uploadImage } from "@/lib/api";

/**
 * Change or reset a sheet's picture. It uploads the chosen file and hands back the new
 * URL; `onChange("")` means "back to the default" (a collage of covers, or initials).
 */
export default function ImageEditor({
  hasImage,
  onChange,
  resetLabel = "Use default",
}: {
  /** Whether the sheet has its own uploaded picture (so a reset does something). */
  hasImage: boolean;
  onChange: (url: string) => Promise<unknown> | void;
  resetLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<unknown> | void) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          className="cursor-pointer rounded-full border border-background px-2 py-1 leading-3 text-muted transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
        >
          {busy ? "Working…" : "Change image"}
        </button>
        {hasImage && (
          <button
            type="button"
            onClick={() => run(() => onChange(""))}
            disabled={busy}
            className="cursor-pointer rounded-full border border-background px-2 py-1 leading-3 text-muted transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
          >
            {resetLabel}
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void run(async () => onChange(await uploadImage(file)));
        }}
      />
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}
