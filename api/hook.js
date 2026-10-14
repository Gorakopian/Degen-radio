// POST /api/hook  ← Helius sends the traders' new transactions here (set up automatically).
// New trades are also passed on to Exit Alarm when it's set up (it leaves its address in the shared database).
import { txsToEvents, enrich, storeEvents } from "../lib/feed.js";
import { redis } from "../lib/redis.js";
import { readBody, send } from "../lib/http.js";

async function forwardToAlarm(events) {
  const raw = await redis("GET", "alarm:inbox");
  if (!raw) return;
  let inbox;
  try { inbox = JSON.parse(raw); } catch { return; }
  if (!inbox?.url || !inbox?.secret) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    await fetch(inbox.url, { method: "POST", headers: { "content-type": "application/json", "x-alarm-secret": inbox.secret }, body: JSON.stringify(events), signal: ctl.signal });
  } catch { /* the radio keeps working even if the alarm is down */ }
  finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const expected = await redis("GET", "radio:hookAuth");
  const got = req.headers?.authorization || req.headers?.Authorization || "";
  if (!expected || got !== expected) return send(res, 401, { error: "unauthorized" });
  try {
    const body = await readBody(req);
    const events = txsToEvents(Array.isArray(body) ? body : body?.transactions || []);
    if (events.length) {
      await storeEvents(await enrich(events, process.env.HELIUS_API_KEY));
      await forwardToAlarm(events);
    }
    return send(res, 200, { ok: true, events: events.length });
  } catch {
    return send(res, 200, { ok: false }); // never make Helius retry-storm us
  }
}
