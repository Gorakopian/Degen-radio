// GET /api/radio?after=<last line id>  → new host lines, latest trades, today's stats.
// Each call also keeps the show running (writes the next line when it's due).
import { tick, snapshot } from "../lib/show.js";
import { hasDatabase, redis } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The radio's database isn't connected yet." });
  try {
    const after = Number(query(req).after) || 0;
    const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim();
    const t0 = Date.now();
    const result = await tick({ host }).catch(async (e) => {
      await redis("SET", "radio:tickError", String(e?.stack || e).slice(0, 300), "EX", 3600);
      return { error: String(e?.message || e).slice(0, 120) };
    });
    const snap = await snapshot({ after });
    snap.tick = { ...(result || {}), seg: undefined, ms: Date.now() - t0, tickError: await redis("GET", "radio:tickError") };
    return send(res, 200, snap);
  } catch {
    return send(res, 500, { error: "The radio hit a snag. Retrying…" });
  }
}
