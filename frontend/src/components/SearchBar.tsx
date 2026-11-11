"use client";

import { useState, useEffect, useRef } from "react";
import { ClearIcon, SearchIcon } from "@/components/icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Milliseconds to wait after typing before onChange fires. 0 filters immediately. */
  debounceMs?: number;
}

export default function SearchBar({ value, onChange, placeholder, debounceMs = 350 }: Props) {
  const [local, setLocal] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => {
    const id = setTimeout(() => {
      // Only report real changes: callers often pass a fresh inline callback, which
      // would otherwise re-arm this timer forever.
      if (local !== value) onChange(local);
    }, debounceMs);
    return () => clearTimeout(id);
  }, [local, value, onChange, debounceMs]);

  return (
    <div className="relative w-full max-w-sm">
      <input
        ref={inputRef}
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder || "Search titles, authors..."}
        aria-label={placeholder || "Search"}
        className={`w-full rounded-full border border-border shadow-xs shadow-border bg-card/70 py-1.5 pl-4 ${local !== "" ? "pr-13" : "pr-4"} text-sm text-foreground placeholder:text-muted transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent`}
      />

      {local !== "" && (
      <div 
        className="absolute right-9 top-1/2">
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => {
            setLocal("");
            onChange("");
            inputRef.current?.focus();
          }}
          className="h-3 w-3 cursor-pointer -translate-y-1/2 flex items-center justify-center text-muted hover:text-foreground"
        >
          <ClearIcon />
        </button>
      </div>
      )}

      <div 
        className="absolute right-0.5 top-1/2 cursor-pointer -translate-y-1/2 bg-border/40 hover:bg-highlight transition-colors p-1.5 rounded-full">
        <SearchIcon className="h-4 w-4 text-muted" />
      </div>
    </div>
  );
}
