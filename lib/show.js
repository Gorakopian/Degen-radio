// Runs the show. There's no always-on server: whenever someone is listening, their page asks
// for news every few seconds, and if it's time for a new line the host writes one.
// Nobody listening = no AI calls = no cost.
import { redis, getJSON } from "./redis.js";
import { recentEvents, storeEvents, demoEvents, setupWebhook } from "./feed.js";
import { buildPrompt, speakLine, templateLine, HOST_NAME } from "./host.js";

const SEG_KEY = "radio:segs";
export const MIN_GAP = 12;    // seconds between lines when trades are coming in
export const QUIET_GAP = 45;  // seconds between filler lines when nothing happens

export async function recentSegments(n = 30) {
  const raw = (await redis("LRANGE", SEG_KEY, 0, n - 1)) || [];
  return raw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

/** Who did what in the last 24 hours, from the stored trades. Pure. */
export function dayStats(events, nowTs) {
  const day = events.filter((e) => nowTs - e.ts < 86400);
  const by = {};
  for (const e of day) {
    const r = by[e.t] || (by[e.t] = { name: e.n, x: e.x, trades: 0, bought: 0, sold: 0 });
    r.trades++;
    if (e.side === "buy") r.bought += e.sol || 0; else r.sold += e.sol || 0;
  }
  const rows = Object.values(by).map((r) => ({ ...r, bought: +r.bought.toFixed(1), sold: +r.sold.toFixed(1) }));
  return {
    trades: day.length,
    topApers: [...rows].sort((a, b) => b.bought - a.bought).slice(0, 5),
    busiest: [...rows].sort((a, b) => b.trades - a.trades)[0] || null,
  };
}

function statsText(s) {
  if (!s.trades) return "";
  const apes = s.topApers.slice(0, 3).map((r) => `${r.name} spent ${r.bought} SOL`).join(", ");
  return `${s.trades} trades. Biggest spenders: ${apes}.${s.busiest ? ` Most trades: ${s.busiest.name} (${s.busiest.trades}).` : ""}`;
}

/**
 * Called on every poll. Sets up the live feed if needed, adds demo trades in demo mode,
 * and writes the next line when it's due. Safe to call from many listeners at once.
 */
export async function tick({ host, nowTs = Math.floor(Date.now() / 1000), env = process.env } = {}) {
  const helius = env.HELIUS_API_KEY;
  // 1) Live feed: connect the Helius webhook automatically the first time. Only re-point it when it
  //    was set up on a private one-off deployment address and someone now visits a real public address,
  //    so visitors on different addresses don't make it flip back and forth (each change costs Helius credits).
  const oneOff = (h) => /-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/i.test(h || "");
  if (helius && host && !/localhost|127\.0\.0\.1/.test(host)) {
    const hookHost = await redis("GET", "radio:hookHost");
    const needed = !hookHost || (hookHost !== host && oneOff(hookHost) && !oneOff(host));
    if (needed && (await redis("SET", "lock:hook", "1", "NX", "EX", 600)) === "OK") {
      try { await setupWebhook(host, helius); } catch (e) { await redis("SET", "radio:hookError", String(e.message || e).slice(0, 200), "EX", 3600); }
    }
  }
  // 2) Demo mode: invent some trades every ~10 seconds
  if (!helius) {
    const last = Number(await redis("GET", "radio:demoAt")) || 0;
    if (nowTs - last >= 10) {
      await redis("SET", "radio:demoAt", String(nowTs));
      if (Math.random() < 0.8) await storeEvents(demoEvents(nowTs));
    }
  }
  // 3) Next line, if due
  const lastSeg = (await recentSegments(1))[0];
  const lastTs = lastSeg?.ts || 0;
  if (nowTs - lastTs < MIN_GAP) return { wrote: false };
  const cursor = Number(await redis("GET", "radio:cursor")) || 0;
  const events = await recentEvents(80);
  const fresh = events.filter((e) => e.ts > cursor).sort((a, b) => a.ts - b.ts);
  if (!fresh.length && nowTs - lastTs < QUIET_GAP) return { wrote: false };
  if ((await redis("SET", "lock:seg", "1", "NX", "EX", 25)) !== "OK") return { wrote: false, busy: true };
  try {
    const use = fresh.slice(-10); // never read out more than 10 trades at once
    const stats = dayStats(events, nowTs);
    const prev = (await recentSegments(4)).map((s) => s.text);
    let text = null, ai = false;
    try { text = await speakLine(buildPrompt(use, prev, statsText(stats)), env); ai = !!text; } catch { text = null; }
    if (!text) text = templateLine(use, stats.topApers[0]?.name);
    const id = await redis("INCR", "radio:segId");
    const seg = { id, ts: nowTs, text, ai, host: HOST_NAME, events: use.map((e) => e.id) };
    await redis("LPUSH", SEG_KEY, JSON.stringify(seg));
    await redis("LTRIM", SEG_KEY, 0, 199);
    if (fresh.length) await redis("SET", "radio:cursor", String(fresh[fresh.length - 1].ts));
    return { wrote: true, seg };
  } finally {
    await redis("DEL", "lock:seg");
  }
}

export async function snapshot({ after = 0, nowTs = Math.floor(Date.now() / 1000), env = process.env } = {}) {
  const [segs, events, hookErr, hookId] = await Promise.all([
    recentSegments(after ? 20 : 8), recentEvents(120), redis("GET", "radio:hookError"), redis("GET", "radio:hookId"),
  ]);
  return {
    now: nowTs,
    host: HOST_NAME,
    mode: env.HELIUS_API_KEY ? (hookId ? "live" : "connecting") : "demo",
    voice: env.ANTHROPIC_API_KEY || env.RADIO_LLM_API_KEY ? "ai" : "templates",
    feedError: hookErr || null,
    segments: segs.filter((s) => s.id > after).reverse(),
    trades: events.slice(0, 30),
    today: dayStats(events, nowTs),
  };
}
