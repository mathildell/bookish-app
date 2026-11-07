// The `rewrites()` proxy in next.config.js buffers the whole upstream body, which
// would turn streamed discovery progress into "nothing, then everything at once".
// Route handlers are matched before `afterFiles` rewrites, so this one takes over
// /api/characters/discover and pipes the backend response through unbuffered.

export const dynamic = "force-dynamic";

const BACKEND = process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000";

export async function POST(request: Request) {
  const body = await request.text();

  const upstream = await fetch(`${BACKEND}/api/characters/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
    // @ts-expect-error -- Node fetch accepts this to avoid a second buffering layer
    duplex: "half",
  });

  if (!upstream.body) {
    return new Response(
      JSON.stringify({ error: "No response body from character backend" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
