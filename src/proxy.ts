// Forwarding to the Anthropic API. Streams the response body through.

// host and accept-encoding: fetch sets its own. content-length: the body may have been rewritten.
const DROP_REQUEST_HEADERS = ["host", "accept-encoding", "content-length"];
// fetch already decompressed the body, so these would be lies.
const DROP_RESPONSE_HEADERS = ["content-encoding", "content-length"];

function without(headers: Headers, names: string[]): Headers {
  const next = new Headers(headers);
  for (const n of names) next.delete(n);
  return next;
}

// Betas that only 1M-context models accept. Haiku 4.5 (200K) returns 400 if Claude Code's header carries one.
const LONG_CONTEXT_BETA = /^context-1m-/;

export function withoutLongContextBeta(headers: Headers): Headers {
  const beta = headers.get("anthropic-beta");
  if (!beta) return headers;
  const kept = beta.split(",").map((b) => b.trim()).filter((b) => b && !LONG_CONTEXT_BETA.test(b));
  const next = new Headers(headers);
  if (kept.length > 0) next.set("anthropic-beta", kept.join(","));
  else next.delete("anthropic-beta");
  return next;
}

export async function forward(upstream: string, req: Request, body: string | undefined, headers: Headers = req.headers): Promise<Response> {
  const url = new URL(req.url);
  const res = await fetch(upstream + url.pathname + url.search, {
    method: req.method,
    headers: without(headers, DROP_REQUEST_HEADERS),
    body: body === "" ? undefined : body,
  });
  return new Response(res.body, { status: res.status, headers: without(res.headers, DROP_RESPONSE_HEADERS) });
}

// A rewritten request that upstream rejects is retried with the original body. Auth and rate limits are not our doing.
export const isRewriteRejection = (status: number): boolean =>
  status >= 400 && status <= 499 && ![401, 403, 429].includes(status);
