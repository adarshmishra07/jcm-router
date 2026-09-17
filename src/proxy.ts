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

export async function forward(upstream: string, req: Request, body: string | undefined): Promise<Response> {
  const url = new URL(req.url);
  const res = await fetch(upstream + url.pathname + url.search, {
    method: req.method,
    headers: without(req.headers, DROP_REQUEST_HEADERS),
    body: body === "" ? undefined : body,
  });
  return new Response(res.body, { status: res.status, headers: without(res.headers, DROP_RESPONSE_HEADERS) });
}

// A rewritten request that upstream rejects is retried with the original body. Auth and rate limits are not our doing.
export const isRewriteRejection = (status: number): boolean =>
  status >= 400 && status <= 499 && ![401, 403, 429].includes(status);
