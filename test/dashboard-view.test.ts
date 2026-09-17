import { describe, expect, test } from "bun:test";
import { renderPage, type DashboardData } from "../scripts/dashboard-view.ts";
import fixtures from "../dashboard/sample.json";

const f = fixtures as Record<string, DashboardData>;
const body = (html: string) => html.slice(html.indexOf('<div id="main">'), html.indexOf("<script>"));

describe("renderPage", () => {
  test("losing money says so in words, with the sign, not only colour", () => {
    const html = body(renderPage(f.losing!));
    expect(html).toContain("Costing you $18.36");
    expect(html).toContain('class="hero over"');
    expect(html).toContain("↑");
  });

  test("saving money is the opposite state", () => {
    const html = body(renderPage(f.saving!));
    expect(html).toContain("Saving $35.07");
    expect(html).toContain('class="hero under"');
    expect(html).not.toContain("Costing");
  });

  test("empty log gets the setup instructions, not a zero verdict", () => {
    const html = body(renderPage(f.empty!));
    expect(html).toContain("No decisions yet");
    expect(html).toContain("bun run up");
    expect(html).not.toContain("Breaking even");
  });

  test("never prints raw floats, NaN or undefined", () => {
    for (const d of Object.values(f)) {
      const html = body(renderPage(d));
      expect(html).not.toMatch(/\d\.\d{5,}/);
      expect(html).not.toMatch(/NaN|undefined|null/);
    }
  });

  test("tolerates missing, empty and unknown fields", () => {
    expect(() => renderPage({} as DashboardData)).not.toThrow();
    expect(() => renderPage(null as unknown as DashboardData)).not.toThrow();
    const html = renderPage({ records: 3, verdict: { overall: { delta: 1.5 } }, rows: [{ delta: "" }, { at: 1 }], surprise: { deep: true } });
    expect(html).toContain("Costing you $1.50");
    expect(body(html)).not.toMatch(/NaN|undefined/);
  });

  test("escapes prompt text and flags rows that cost more", () => {
    const html = body(renderPage(f.losing!));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<tr class="over">');
    expect(html).toContain("+$0.412");
    expect(html).toContain("-$0.213");
  });

  test("formats tokens and latency as their own kinds of number", () => {
    const html = body(renderPage(f.losing!));
    expect(html).toContain("57.4M read");
    expect(html).toContain("332 ms");
    expect(html).toContain("1.4 s");
  });

  test("the browser re-renders with the same code the server used", () => {
    const html = renderPage(f.losing!);
    const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
    const src = script.slice(script.indexOf("const render = ") + 15, script.indexOf(";\nconst main"));
    const render = new Function("return " + src)() as (d: unknown) => string;
    expect('<div id="main">' + render(f.losing!) + "</div>").toBe(body(html).replace(/<\/div><\/main>\n$/, "</div>"));
  });

  test("passthrough says routing is off in words, not only in colour", () => {
    const html = body(renderPage({ ...f.saving!, health: { mode: "passthrough", restarts: 3, last_crash: { code: 1, at: "2026-09-17T08:00:00.000Z" } } }));
    expect(html).toContain("Passthrough mode: routing is off");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Last exit code 1 at 08:00:00");
    expect(html).toContain("Restarts so far: 3");
    // Above the verdict, so it is read first.
    expect(html.indexOf("Passthrough mode")).toBeLessThan(html.indexOf("Saving $35.07"));
  });

  test("the banner shows on the empty page too, and never when routing is on or health is unknown", () => {
    expect(body(renderPage({ ...f.empty!, health: { mode: "passthrough", restarts: 1, last_crash: null } }))).toContain("Passthrough mode");
    expect(body(renderPage({ ...f.saving!, health: { mode: "routing", restarts: 0, last_crash: null } }))).not.toContain("Passthrough");
    expect(body(renderPage({ ...f.saving!, health: null }))).not.toContain("Passthrough");
    expect(body(renderPage(f.saving!))).not.toContain("Passthrough");
  });

  test("no em dashes, no CDN, no external assets", () => {
    const html = renderPage(f.saving!);
    expect(html).not.toContain(String.fromCharCode(0x2014));
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/);
  });
});
