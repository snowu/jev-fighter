// Local dev server: serves ./public and proxies /api/brain to TypeSafe so the
// API key stays on this machine (read from the env, never sent to the page).
//
//   npm start      (loads ~/.config/typesafe/env if present)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 5173);
const ROOT = join(import.meta.dirname, "public");
const KEY = process.env.TYPESAFE_API_KEY;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

async function brain(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) return send(res, 413, { error: "request too large" });
  }
  const { state, questions } = JSON.parse(body);
  const t0 = performance.now();
  const upstream = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  const latencyMs = performance.now() - t0;
  if (!upstream.ok) return send(res, upstream.status, { error: (await upstream.text()).slice(0, 500) });
  send(res, 200, { ...(await upstream.json()), latencyMs });
}

function send(res, status, json) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(json));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/status") return send(res, 200, { jev: !!KEY });
    if (url.pathname === "/api/brain" && req.method === "POST") {
      if (!KEY) return send(res, 503, { error: "TYPESAFE_API_KEY not configured" });
      return await brain(req, res);
    }
    const path = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!path.startsWith(ROOT)) return send(res, 403, { error: "forbidden" });
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, { error: "not found" });
    console.error(err);
    send(res, 500, { error: String(err.message ?? err) });
  }
}).listen(PORT, () => {
  console.log(`Jev Fighter on http://localhost:${PORT}  (Jev ${KEY ? "enabled" : "DISABLED: no TYPESAFE_API_KEY, local brain only"})`);
});
