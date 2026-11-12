// Pass-through proxies for streaming endpoints.
//
// The `rewrites()` proxy in next.config.js buffers the whole upstream body, which
// turns a token stream into "nothing, then everything at once". Route handlers are
// matched before `afterFiles` rewrites, so a handler built from `proxyStream` takes
// over its path and pipes the backend response through unbuffered.

const BACKEND = process.env.BACKEND_API_URL ?? "http://127.0.0.1:8000";

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function forward(path: string, request: Request, body: string) {
  return fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
    signal: request.signal,
    // @ts-expect-error -- Node fetch accepts this to avoid a second buffering layer
    duplex: "half",
  });
}

/** A POST handler that relays `path`'s Server-Sent Events as they arrive. */
export function proxyStream(path: string) {
  return async function POST(request: Request) {
    const upstream = await forward(path, request, await request.text());
    if (!upstream.ok || !upstream.body) {
      // Errors (400/503 with a JSON detail) are passed on as they are.
      return new Response(upstream.body, {
        status: upstream.ok ? 502 : upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
      });
    }
    return new Response(upstream.body, { status: upstream.status, headers: STREAM_HEADERS });
  };
}

/** A POST handler that relays a plain JSON response without caching it. */
export function proxyJson(path: string) {
  return async function POST(request: Request) {
    const upstream = await forward(path, request, await request.text());
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  };
}
