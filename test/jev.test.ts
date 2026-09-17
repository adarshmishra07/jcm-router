import { describe, expect, test } from "bun:test";
import { askJev, parseJevResponse } from "../src/jev.ts";
import { QUESTIONS } from "../src/routing-policy.ts";

const good = {
  model: "jev-latest",
  answers: {
    model: { type: "choice", choice: "opus", probabilities: { opus: 0.8, sonnet: 0.2 }, confidence: 0.75 },
    effort: { type: "choice", choice: "high", probabilities: { high: 0.6 }, confidence: 0.6 },
    is_followup: { type: "noul", noul: 0.05 },
  },
};

describe("parseJevResponse", () => {
  test("accepts a well-formed response", () => {
    const parsed = parseJevResponse(good, QUESTIONS);
    expect(parsed?.model).toEqual({ type: "choice", choice: "opus", probabilities: { opus: 0.8, sonnet: 0.2 }, confidence: 0.75 });
    expect(parsed?.is_followup).toEqual({ type: "noul", noul: 0.05 });
  });

  test("rejects a missing answer, a wrong type, or a non-numeric confidence", () => {
    const { is_followup: _drop, ...partial } = good.answers;
    expect(parseJevResponse({ answers: partial }, QUESTIONS)).toBeNull();
    expect(parseJevResponse({ answers: { ...good.answers, model: { type: "noul", noul: 1 } } }, QUESTIONS)).toBeNull();
    expect(parseJevResponse({ answers: { ...good.answers, effort: { ...good.answers.effort, confidence: "high" } } }, QUESTIONS)).toBeNull();
    expect(parseJevResponse("nope", QUESTIONS)).toBeNull();
    expect(parseJevResponse({ error: "rate limited" }, QUESTIONS)).toBeNull();
  });
});

describe("askJev", () => {
  test("returns answers and timing on success", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json(good) });
    try {
      const r = await askJev({ url: `http://localhost:${server.port}/`, apiKey: "apikey_test", timeoutMs: 1000 }, {}, QUESTIONS);
      expect(r).toMatchObject({ ok: true, answers: { model: { choice: "opus" } } });
      expect(r.ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop(true);
    }
  });

  test("reports http errors, bad json, and timeouts as failures without throwing", async () => {
    let mode: "500" | "garbage" | "hang" = "500";
    const server = Bun.serve({
      port: 0,
      async fetch() {
        if (mode === "500") return new Response("boom", { status: 500 });
        if (mode === "garbage") return new Response("not json", { headers: { "content-type": "application/json" } });
        await Bun.sleep(500);
        return Response.json(good);
      },
    });
    const client = { url: `http://localhost:${server.port}/v1/systemone`, apiKey: "apikey_test", timeoutMs: 100 };
    try {
      expect(await askJev(client, {}, QUESTIONS)).toMatchObject({ ok: false, error: "http 500" });
      mode = "garbage";
      expect(await askJev(client, {}, QUESTIONS)).toMatchObject({ ok: false, error: expect.stringContaining("JSON") });
      mode = "hang";
      const timedOut = await askJev(client, {}, QUESTIONS);
      expect(timedOut).toMatchObject({ ok: false, error: expect.stringContaining("Timeout") });
      expect(JSON.stringify(timedOut)).not.toContain("apikey_test");
    } finally {
      server.stop(true);
    }
  });
});
