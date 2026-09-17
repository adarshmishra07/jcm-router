// Serves dashboard/sample.json through renderPage so the view can be looked at without a log.
// Usage: bun scripts/dashboard-preview.ts [--port 8795]
//   /            the "losing" fixture      /?fixture=saving   /?fixture=empty
//   /api.json    the same fixture as JSON, so the page's own auto-refresh works.

import { renderPage, type DashboardData } from "./dashboard-view.ts";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8795;
const fixtures = (await Bun.file(new URL("../dashboard/sample.json", import.meta.url)).json()) as Record<string, DashboardData>;
const pick = (url: URL): DashboardData => fixtures[url.searchParams.get("fixture") ?? "losing"] ?? fixtures.losing ?? {};

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const data = { ...pick(url), generated_at: new Date().toISOString() };
    if (url.pathname === "/api.json") return Response.json(data);
    return new Response(renderPage(data), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`preview on http://localhost:${PORT}  (?fixture=${Object.keys(fixtures).join("|")})`);
