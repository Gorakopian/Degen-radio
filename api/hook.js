// POST /api/hook  ← Helius sends the traders' new transactions here (set up automatically).
// New trades are also passed on to Exit Alarm when it's set up (it leaves its address in the shared database).
// Exit Alarm users can add their own wallets to watch: those trades go only to the alarm, never on the radio.
import { txsToEvents, enrich, storeEvents, customWallets, customHits, setupWebhook } from "../lib/feed.js";
import { redis } from "../lib/redis.js";
import { readBody, send } from "../lib/http.js";

// A wallet added by a user that makes more transactions than this per day is probably a bot: stop watching it
// (every transaction costs a Helius credit).
export const CUSTOM_DAILY_LIMIT = 400;

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

/** Count today's transactions per added wallet; drop the ones over the limit. Returns dropped wallets. */
async function dropBusyWallets(txs, extra) {
  const day = new Date().toISOString().slice(0, 10);
  const dropped = [];
  for (const [addr, n] of Object.entries(customHits(txs, extra))) {
    const key = `alarm:rate:${addr}:${day}`;
    let count = 0;
    for (let i = 0; i < n; i++) count = await redis("INCR", key);
    if (count === n) await redis("EXPIRE", key, 172800);
    if (count > CUSTOM_DAILY_LIMIT) { await redis("HDEL", "alarm:wallets", addr); dropped.push(addr); }
  }
  if (dropped.length && process.env.HELIUS_API_KEY) {
    const host = await redis("GET", "radio:hookHost");
    if (host) await setupWebhook(host, process.env.HELIUS_API_KEY).catch(() => {});
  }
  return dropped;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const expected = await redis("GET", "radio:hookAuth");
  const got = req.headers?.authorization || req.headers?.Authorization || "";
  if (!expected || got !== expected) return send(res, 401, { error: "unauthorized" });
  try {
    const body = await readBody(req);
    const txs = Array.isArray(body) ? body : body?.transactions || [];
    const extra = await customWallets();
    const events = txsToEvents(txs, extra);
    const dropped = extra.size ? await dropBusyWallets(txs, extra) : [];
    const toAlarm = events.filter((e) => !dropped.includes(e.t));
    if (toAlarm.length) {
      await enrich(toAlarm, process.env.HELIUS_API_KEY);
      await storeEvents(toAlarm.filter((e) => !e.custom)); // the radio only talks about the famous 100
    }
    const notices = dropped.map((addr) => ({ id: `drop:${addr}:${Date.now()}`, t: addr, dropped: true }));
    if (toAlarm.length || notices.length) await forwardToAlarm([...toAlarm, ...notices]);
    return send(res, 200, { ok: true, events: events.length });
  } catch {
    return send(res, 200, { ok: false }); // never make Helius retry-storm us
  }
}
