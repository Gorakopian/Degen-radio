// GET /api/radio?after=<last line id>  → new host lines, latest trades, today's stats.
// Each call also keeps the show running (writes the next line when it's due).
import { tick, snapshot } from "../lib/show.js";
import { hasDatabase } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The radio's database isn't connected yet." });
  try {
    const after = Number(query(req).after) || 0;
    const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim();
    await tick({ host }).catch(() => null);
    return send(res, 200, await snapshot({ after }));
  } catch {
    return send(res, 500, { error: "The radio hit a snag. Retrying…" });
  }
}
