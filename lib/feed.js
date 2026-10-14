// The live trade feed: Helius calls our webhook whenever one of the traders does something,
// we turn swaps into simple events and keep the latest 300.
import { randomBytes } from "node:crypto";
import { TRADERS, TRADER_BY_ID } from "./traders.js";
import { walletDeltas, fetchTokenMeta, fetchPrices, WSOL, SOL_NOISE } from "./chain.js";
import { redis, pipeline } from "./redis.js";

export const EVENTS_KEY = "radio:events";
const MAX_EVENTS = 300;

/**
 * Turn Helius enhanced transactions into trade events for our traders. Pure (no names or prices yet).
 * `extra` = wallets people added in Exit Alarm: their trades get `custom: true` (not for the radio).
 */
export function txsToEvents(txs, extra = new Set()) {
  const watched = (a) => !!TRADER_BY_ID[a] || extra.has(a);
  const out = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx || tx.transactionError) continue;
    const involved = new Set();
    if (watched(tx.feePayer)) involved.add(tx.feePayer);
    for (const acc of tx.accountData || []) if (watched(acc.account)) involved.add(acc.account);
    for (const id of involved) {
      const { sol, usd, coins } = walletDeltas(tx, id);
      if (coins.length !== 1) continue;
      const [mint, amount] = coins[0];
      const quote = Math.abs(sol) > SOL_NOISE ? Math.abs(sol) : 0;
      if (!quote && Math.abs(usd) < 1) continue;
      const side = amount > 0 && (sol < 0 || usd < 0) ? "buy" : amount < 0 && (sol > 0 || usd > 0) ? "sell" : null;
      if (!side) continue;
      const t = TRADER_BY_ID[id];
      out.push({
        id: `${tx.signature}:${id.slice(0, 6)}`, ts: tx.timestamp || Math.floor(Date.now() / 1000),
        t: id, n: t?.name || null, x: t?.x || null, side, mint, amt: Math.abs(amount),
        sol: +quote.toFixed(3), usd: quote ? null : +Math.abs(usd).toFixed(0),
        ...(t ? {} : { custom: true }),
      });
    }
  }
  return out;
}

/** Add coin symbol and market cap to events (cached per coin). */
export async function enrich(events, heliusKey) {
  const mints = [...new Set(events.map((e) => e.mint))];
  if (!mints.length) return events;
  const cached = await pipeline(mints.map((m) => ["HGET", "radio:tok", m]));
  const meta = {};
  const need = [];
  mints.forEach((m, i) => { if (cached[i]) meta[m] = JSON.parse(cached[i]); else need.push(m); });
  if (need.length) {
    const fresh = await fetchTokenMeta(need, heliusKey);
    const save = [];
    for (const m of need) { meta[m] = fresh[m] || { sym: "", supply: null, dec: 0 }; save.push(m, JSON.stringify(meta[m])); }
    await redis("HSET", "radio:tok", ...save);
  }
  const prices = await fetchPrices([...mints, WSOL]);
  for (const e of events) {
    const m = meta[e.mint] || {};
    e.sym = m.sym || e.mint.slice(0, 4).toUpperCase();
    const p = prices[e.mint];
    e.mcap = p && m.supply ? Math.round((m.supply / Math.pow(10, m.dec || 0)) * p) : null;
    if (e.sol == null || e.sol === 0) e.sol = e.usd && prices[WSOL] ? +(e.usd / prices[WSOL]).toFixed(3) : 0;
  }
  return events;
}

/** Wallets Exit Alarm users added themselves (shared database). */
export async function customWallets() {
  const flat = (await redis("HGETALL", "alarm:wallets")) || [];
  const out = new Set();
  for (let i = 0; i < flat.length; i += 2) out.add(flat[i]);
  return out;
}

/** Which watched wallets appear in these transactions (for the spam-bot limit). Pure. */
export function customHits(txs, extra) {
  const hits = {};
  for (const tx of Array.isArray(txs) ? txs : []) {
    const seen = new Set([tx?.feePayer, ...(tx?.accountData || []).map((a) => a.account)].filter((a) => extra.has(a)));
    for (const a of seen) hits[a] = (hits[a] || 0) + 1;
  }
  return hits;
}

export async function storeEvents(events) {
  if (!events.length) return 0;
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  await redis("LPUSH", EVENTS_KEY, ...sorted.map((e) => JSON.stringify(e)));
  await redis("LTRIM", EVENTS_KEY, 0, MAX_EVENTS - 1);
  return sorted.length;
}

export async function recentEvents(n = 60) {
  const raw = (await redis("LRANGE", EVENTS_KEY, 0, n - 1)) || [];
  return raw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

// ---- Helius webhook setup -------------------------------------------------
const HELIUS_HOSTS = ["https://api-mainnet.helius-rpc.com", "https://api.helius.xyz"];

async function heliusApi(path, apiKey, init) {
  let last;
  for (const host of HELIUS_HOSTS) {
    try {
      const res = await fetch(`${host}/v0/${path}${path.includes("?") ? "&" : "?"}api-key=${apiKey}`, init);
      if (res.ok) return res.json();
      last = new Error(`helius_${res.status}: ${(await res.text()).slice(0, 120)}`);
      if (res.status === 401 || res.status === 403) break;
    } catch (e) { last = e; }
  }
  throw last;
}

/**
 * Point a Helius webhook at https://<host>/api/hook for all 100 traders. Creates it the first time,
 * updates it afterwards. Costs 100 Helius credits per call, so it only runs when needed.
 */
export async function setupWebhook(host, apiKey) {
  let auth = await redis("GET", "radio:hookAuth");
  if (!auth) { auth = randomBytes(18).toString("hex"); await redis("SET", "radio:hookAuth", auth); }
  const body = {
    webhookURL: `https://${host}/api/hook`,
    transactionTypes: ["ANY"],
    accountAddresses: [...new Set([...TRADERS.map((t) => t.id), ...(await customWallets())])],
    webhookType: "enhanced",
    authHeader: auth,
  };
  const existing = await redis("GET", "radio:hookId");
  const res = existing
    ? await heliusApi(`webhooks/${existing}`, apiKey, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    : await heliusApi("webhooks", apiKey, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const id = res?.webhookID || res?.webhookId || existing;
  if (id) await redis("SET", "radio:hookId", id);
  await redis("SET", "radio:hookHost", host);
  return { id, url: body.webhookURL, traders: body.accountAddresses.length };
}

// ---- Demo trades (no Helius key) ------------------------------------------
const DEMO_COINS = [["GOBLIN", 45e3], ["WIFHAT", 2.1e6], ["PEPE2", 8e6], ["CATJAM", 120e3], ["TURBOCAT", 600e3], ["MOONDOG", 30e3], ["BONKER", 1.4e6], ["GIGACAT", 9e3], ["SADFROG", 75e3], ["CHAD", 3.3e6]];
let demoN = 0;
export function demoEvents(nowTs, count = 1 + Math.floor(Math.random() * 2)) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = TRADERS[Math.floor(Math.random() ** 1.6 * TRADERS.length)];
    const [sym, base] = DEMO_COINS[Math.floor(Math.random() * DEMO_COINS.length)];
    const side = Math.random() < 0.58 ? "buy" : "sell";
    out.push({
      id: `demo${nowTs}-${demoN++}`, ts: nowTs, t: t.id, n: t.name, x: t.x || null, side,
      mint: "demo-" + sym, sym, amt: 0, sol: +(0.5 + Math.random() ** 2 * 40).toFixed(2),
      mcap: Math.round(base * (0.5 + Math.random() * 1.5)), demo: true,
    });
  }
  return out;
}
