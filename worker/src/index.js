// Jev Fighter brain proxy (Cloudflare Worker). Same contract as server.mjs:
//   GET  /api/status -> { jev: boolean }
//   POST /api/brain  { state, questions } -> TypeSafe System One answers + latencyMs
// Only the allowed origins may call it, requests are size-capped, the model is fixed, and each
// visitor is rate limited.

const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY = 64_000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "Origin" }
      : null;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(cors ?? {}) } });

    if (!cors) return json(403, { error: "origin not allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    if (pathname === "/api/status" && request.method === "GET") return json(200, { jev: !!env.TYPESAFE_API_KEY });
    if (pathname !== "/api/brain" || request.method !== "POST") return json(404, { error: "not found" });
    if (!env.TYPESAFE_API_KEY) return json(503, { error: "TYPESAFE_API_KEY not configured" });

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json(429, { error: "slow down" });
    }

    const text = await request.text();
    if (text.length > MAX_BODY) return json(413, { error: "request too large" });
    let payload;
    try { payload = JSON.parse(text); } catch { return json(400, { error: "invalid json" }); }
    const { state, questions } = payload ?? {};
    if (!state || typeof questions !== "object" || !questions) return json(400, { error: "expected { state, questions }" });

    const t0 = Date.now();
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
    });
    const latencyMs = Date.now() - t0;
    if (!upstream.ok) return json(upstream.status, { error: (await upstream.text()).slice(0, 500) });
    return json(200, { ...(await upstream.json()), latencyMs });
  },
};
