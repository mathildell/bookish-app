"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useCallback, useEffect, useRef } from "react";

interface SettingsData {
  calibre_db_path: string;
  calibre_url: string;
  obsidian_vault_path: string;
  chroma_db_path: string;
  ollama_host: string;
  ollama_port: number;
  chat_model: string;
  extraction_model: string;
  writing_model: string;
  writing_temperature: number;
  writing_top_p: number;
  writing_num_predict: number;
  chat_num_ctx: number;
  chat_num_predict: number;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  ignored_books: string[];
  genre_colors: Record<string, string>;
  genre_categories: string[];
}

// Matches the default chip tint used for genres without a configured color
const DEFAULT_GENRE_COLOR = "#eab308";

async function fetchSettings(): Promise<SettingsData> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

async function updateSettings(data: Partial<SettingsData>) {
  // genre_categories is derived from the library, never persisted
  const payload = { ...data };
  delete payload.genre_categories;
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to save settings");
  return res.json();
}

function IgnoredBookInput({ onAdd }: { onAdd: (val: string) => void }) {
  const [input, setInput] = useState("");

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed) {
      onAdd(trimmed);
      setInput("");
    }
  };

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        placeholder='Type a title (eg. "Metadata holder")…'
        className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
      />
      <button
        type="button"
        onClick={handleAdd}
        disabled={!input.trim()}
        className="px-3 py-1 rounded-lg text-xs font-semibold bg-zinc-700 text-zinc-300 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        + Add
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold text-zinc-300 pb-2 border-b border-zinc-800">{title}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
    </section>
  );
}

function TextRow({ label, value, onChange, help }: { 
  label: string; value: string | number; onChange: (v: string) => void; help?: string 
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs uppercase font-semibold text-zinc-500">{label}</label>
      <input
        type={typeof value === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
      />
      {help && <p className="text-[11px] text-zinc-600">{help}</p>}
    </div>
  );
}

export default function SettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });

  const [form, setForm] = useState<SettingsData | null>(null);
  const initialSync = useRef(false);

  // Populate form on first successful fetch — preserves local edits across refetches
  useEffect(() => {
    if (data && !initialSync.current) {
      initialSync.current = true;
      setForm(data);
    }
  }, [data]);

  const updateMut = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => window.location.reload(),
  });

  const handleChange = useCallback((key: keyof SettingsData, val: string) => {
    setForm((prev) => prev ? { ...prev, [key]: val } : null);
  }, []);

  const setGenreColor = useCallback((category: string, color: string) => {
    setForm((prev) =>
      prev ? { ...prev, genre_colors: { ...prev.genre_colors, [category]: color } } : null
    );
  }, []);

  const clearGenreColor = useCallback((category: string) => {
    setForm((prev) => {
      if (!prev) return null;
      const next = { ...prev.genre_colors };
      delete next[category];
      return { ...prev, genre_colors: next };
    });
  }, []);

  if (isLoading || !form) return <div className="text-zinc-500 py-8">Loading…</div>;

  const hasChanges = data && Object.keys(form).some(
    (k) => JSON.stringify(form[k as keyof SettingsData]) !== JSON.stringify(data[k as keyof SettingsData])
  );

  return (
    <div className="space-y-8 max-w-3xl pt-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      {/* App paths */}
      <Section title="Paths">
        <TextRow label="Calibre Database" value={form.calibre_db_path} 
          onChange={(v) => handleChange("calibre_db_path", v)}
          help="Path to your Calibre metadata.db file" />
        <TextRow label="Calibre URL" value={form.calibre_url ?? ""}
          onChange={(v) => handleChange("calibre_url", v)}
          help="Web address of your Calibre library, used by the Calibre tab on book pages. The book ID is appended as &book_id=… (e.g. http://host:8080/#library_id=Calibre_Library)" />
        <TextRow label="Obsidian Vault" value={form.obsidian_vault_path} 
          onChange={(v) => handleChange("obsidian_vault_path", v)}
          help="Root directory for book reviews and ARC notes" />
        <TextRow label="ChromaDB Storage" value={form.chroma_db_path} 
          onChange={(v) => handleChange("chroma_db_path", v)}
          help="Where vector embeddings are persisted" />
      </Section>

      {/* Ollama config */}
      <Section title="Ollama">
        <TextRow label="Host" value={form.ollama_host} 
          onChange={(v) => handleChange("ollama_host", v)}
          help="IP or hostname of the remote Ollama server" />
        <TextRow label="Port" value={form.ollama_port}
          onChange={(v) => handleChange("ollama_port", v)}
          help="Default 11434" />
        <TextRow label="Chat Model" value={form.chat_model} 
          onChange={(v) => handleChange("chat_model", v)}
          help="Model used for conversation responses" />
        <TextRow label="Context Window" value={form.chat_num_ctx}
          onChange={(v) => handleChange("chat_num_ctx", v)}
          help="num_ctx sent with every chat request. Ollama defaults to 4096 whatever the model supports, which truncates the retrieved passages and the history." />
        <TextRow label="Max Output Tokens" value={form.chat_num_predict}
          onChange={(v) => handleChange("chat_num_predict", v)}
          help="num_predict per answer, reasoning included. Caps a model that would otherwise think until it starves the host." />
        <TextRow label="Extraction Model" value={form.extraction_model ?? ""}
          onChange={(v) => handleChange("extraction_model", v)}
          help="Model used to discover and profile characters. Falls back to the Chat Model when empty." />
        <TextRow label="Embedding Model" value={form.embedding_model} 
          onChange={(v) => handleChange("embedding_model", v)}
          help="Model used for text vectorization during indexing" />
      </Section>

      {/* Creative writing tuning */}
      <Section title="Creative Writing">
        <TextRow label="Writing Model" value={form.writing_model ?? ""}
          onChange={(v) => handleChange("writing_model", v)}
          help="Model used for scenes on the Write page. Leave empty to reuse the Chat Model — a reasoning model will spend the whole budget thinking and return no prose." />
        <TextRow label="Temperature" value={form.writing_temperature}
          onChange={(v) => handleChange("writing_temperature", v)}
          help="Higher is more surprising, lower more controlled (default: 0.95)" />
        <TextRow label="Top-P" value={form.writing_top_p}
          onChange={(v) => handleChange("writing_top_p", v)}
          help="Nucleus sampling cut-off (default: 0.95)" />
        <TextRow label="Max Tokens" value={form.writing_num_predict}
          onChange={(v) => handleChange("writing_num_predict", v)}
          help="Token budget per generation round (default: 1200). A scene that hits it is continued automatically." />
      </Section>

      {/* Ingestion tuning */}
      <Section title="Ingestion">
        <TextRow label="Chunk Size" value={form.chunk_size} 
          onChange={(v) => handleChange("chunk_size", v)}
          help="Max tokens per text chunk (default: 600)" />
        <TextRow label="Chunk Overlap" value={form.chunk_overlap} 
          onChange={(v) => handleChange("chunk_overlap", v)}
          help="Overlap between adjacent chunks for better context preservation" />
        <TextRow label="Top-K Retrieval" value={form.top_k} 
          onChange={(v) => handleChange("top_k", v)}
          help="Number of relevant passages to retrieve per query" />
      </Section>

      {/* Ignored books */}
      <Section title="Ignored Books">
        <div className="md:col-span-2 space-y-3">
          <p className="text-xs text-zinc-500">
            Titles matching these patterns will be hidden from the library grid. Partial, case-insensitive matches are supported.
          </p>
          {form.ignored_books.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {form.ignored_books.map((title, i) => (
                <span
                  key={`${title}-${i}`}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs bg-zinc-800 text-zinc-300 border border-zinc-700"
                >
                  {title}
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...form.ignored_books];
                      next.splice(i, 1);
                      setForm((prev) => prev ? { ...prev, ignored_books: next } : null);
                    }}
                    className="ml-1 text-zinc-500 hover:text-red-400 transition-colors select-none"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <IgnoredBookInput
            onAdd={(val) => {
              setForm((prev) => prev ? { ...prev, ignored_books: [...prev.ignored_books, val] } : null);
            }}
          />
        </div>
      </Section>

      {/* Genre colors */}
      <Section title="Genre Colors">
        <div className="md:col-span-2 space-y-3">
          <p className="text-xs text-zinc-500">
            Colors the genre chips on book pages. Pick one per main genre category — every subgenre
            inherits it (e.g. Fantasy.High and Fantasy.Dark both use the Fantasy color).
          </p>
          {form.genre_categories.length === 0 ? (
            <p className="text-xs text-zinc-600">No genres found in your Calibre library.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {form.genre_categories.map((category) => {
                const color = form.genre_colors[category];
                return (
                  <div
                    key={category}
                    className="flex items-center gap-3 bg-zinc-900/60 border border-zinc-800 rounded-lg px-3 py-2"
                  >
                    <input
                      type="color"
                      value={color ?? DEFAULT_GENRE_COLOR}
                      onChange={(e) => setGenreColor(category, e.target.value)}
                      aria-label={`${category} color`}
                      className="h-8 w-10 shrink-0 cursor-pointer rounded border border-zinc-700 bg-transparent p-0.5"
                    />
                    <span className="flex-1 text-sm text-zinc-200">{category}</span>
                    {color ? (
                      <button
                        type="button"
                        onClick={() => clearGenreColor(category)}
                        className="text-[11px] text-zinc-500 hover:text-red-400 transition-colors"
                      >
                        Reset
                      </button>
                    ) : (
                      <span className="text-[11px] text-zinc-600">default</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Section>

      {/* Save button */}
      <div className="pt-4 flex items-center gap-4">
        <button
          onClick={() => updateMut.mutate(form)}
          disabled={!hasChanges || updateMut.isPending}
          className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
            hasChanges 
              ? "bg-yellow-600 hover:bg-yellow-500 text-zinc-900" 
              : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
          }`}
        >
          {updateMut.isPending ? "Saving…" : updateMut.isSuccess ? "Saved ✓" : hasChanges ? "Save Changes" : "No changes"}
        </button>
      </div>
    </div>
  );
}
