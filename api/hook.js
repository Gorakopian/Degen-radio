// POST /api/hook  ← Helius sends the traders' new transactions here (set up automatically).
import { txsToEvents, enrich, storeEvents } from "../lib/feed.js";
import { redis } from "../lib/redis.js";
import { readBody, send } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const expected = await redis("GET", "radio:hookAuth");
  const got = req.headers?.authorization || req.headers?.Authorization || "";
  if (!expected || got !== expected) return send(res, 401, { error: "unauthorized" });
  try {
    const body = await readBody(req);
    const events = txsToEvents(Array.isArray(body) ? body : body?.transactions || []);
    if (events.length) await storeEvents(await enrich(events, process.env.HELIUS_API_KEY));
    return send(res, 200, { ok: true, events: events.length });
  } catch {
    return send(res, 200, { ok: false }); // never make Helius retry-storm us
  }
}
