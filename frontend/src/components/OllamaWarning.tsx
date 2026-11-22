"use client";

/** Shown while the configured Ollama host does not answer: the inputs are disabled. */
export default function OllamaWarning({
  host,
  className = "",
}: {
  host?: string;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={`rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-snug text-red-500 ${className}`}
    >
      ⚠️ Ollama host unreachable
      {host ? (
        <>
          {" at "}
          <span className="font-semibold">{host}</span>
        </>
      ) : null}
      {" — check the host in Settings."}
    </p>
  );
}
