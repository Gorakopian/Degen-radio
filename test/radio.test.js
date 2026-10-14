// Run with: node test/radio.test.js
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { txsToEvents, storeEvents, recentEvents } from "../lib/feed.js";
import { describeEvent, buildPrompt, templateLine, pickEvents } from "../lib/host.js";
import { tick, snapshot, dayStats } from "../lib/show.js";
import { redis } from "../lib/redis.js";
import { TRADERS } from "../lib/traders.js";

const T = TRADERS[1]; // Frank DeGods
const MINT = "CoinXXXX11111111111111111111111111111111111";
const swap = (sig, sol, tok, ts) => ({
  signature: sig, timestamp: ts, feePayer: T.id,
  accountData: [
    { account: T.id, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: [] },
    { account: "ata", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: T.id, mint: MINT, rawTokenAmount: { tokenAmount: String(tok * 1e6), decimals: 6 } }] },
  ],
});

// Parsing trades from a Helius webhook
const ev = txsToEvents([swap("a", -12.5, 1000, 100), swap("b", 20, -1000, 200), { signature: "c", feePayer: "someoneElse", accountData: [] }]);
assert.equal(ev.length, 2);
assert.deepEqual([ev[0].side, ev[0].sol, ev[0].n], ["buy", 12.5, T.name]);
assert.equal(ev[1].side, "sell");

// Host text
const e = { ...ev[0], sym: "GOBLIN", mcap: 45000 };
assert.equal(describeEvent(e), `[STAR] ${T.name} (@${T.x}) BOUGHT $GOBLIN for 12.5 SOL at 45k market cap`);
const nobody = { ...e, t: TRADERS[90].id, n: TRADERS[90].name, x: null };
assert.ok(!describeEvent(nobody).startsWith("[STAR]"));
// Stars are read out first, even when smaller
const picked = pickEvents([...Array(12)].map((_, i) => ({ ...nobody, id: "n" + i, sol: 50 + i, ts: i })).concat([{ ...e, id: "s", sol: 1, ts: 5 }]), 3);
assert.ok(picked.some((x) => x.id === "s"));
assert.equal(picked.length, 3);
assert.match(templateLine([{ ...e, sol: 12.5 }]), new RegExp(T.name));
const p = buildPrompt([e], ["Old line"], "3 trades.");
assert.match(p, /No slurs/);
assert.match(p, /\[STAR\]/);
assert.match(p, /BOUGHT \$GOBLIN/);
assert.match(p, /Old line/);
assert.ok(templateLine([e]).includes("GOBLIN"));
assert.ok(templateLine([]).length > 20);

// Day stats
const s = dayStats([{ ...e, ts: 1000 }, { ...e, side: "sell", sol: 3, ts: 1000 }], 2000);
assert.equal(s.trades, 2);
assert.equal(s.topApers[0].bought, 12.5);

// The show in demo mode: trades appear, a line gets written, then waits for the gap
const env = {}; // no keys → demo trades + template lines
const now = 1_800_000_000;
let r = await tick({ host: "localhost", nowTs: now, env });
assert.equal(r.wrote, true);
r = await tick({ host: "localhost", nowTs: now + 5, env });
assert.equal(r.wrote, false, "waits at least 12 seconds between lines");
r = await tick({ host: "localhost", nowTs: now + 60, env });
assert.equal(r.wrote, true);
const snap = await snapshot({ after: 0, nowTs: now + 60, env });
assert.equal(snap.mode, "demo");
assert.equal(snap.segments.length, 2);
assert.ok(snap.segments[0].id < snap.segments[1].id, "oldest first");
const later = await snapshot({ after: snap.segments[1].id, nowTs: now + 61, env });
assert.equal(later.segments.length, 0);

// With an AI key: the prompt goes to the model and its line is used
globalThis.fetch = async (url, init) => {
  if (String(url).includes("anthropic")) {
    const body = JSON.parse(init.body);
    assert.match(body.messages[0].content, /DEGEN RADIO/);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "**Frank** just aped. 🔥 Absolute clown behaviour." }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
await storeEvents([{ ...e, id: "x1", ts: now + 100 }]);
r = await tick({ host: "localhost", nowTs: now + 120, env: { ANTHROPIC_API_KEY: "k" } });
assert.equal(r.seg.text, "Frank just aped. Absolute clown behaviour.");
assert.equal(r.seg.ai, true);
assert.ok(r.seg.events.includes("x1"));

// Webhook endpoint rejects calls without the secret, accepts with it
const { default: hook } = await import("../api/hook.js");
const call = (headers, body) => new Promise((resolve) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: "POST", url: "/api/hook", headers });
  hook(req, { statusCode: 200, setHeader() {}, end(x) { resolve({ status: this.statusCode, body: JSON.parse(x) }); } });
});
await redis("SET", "radio:hookAuth", "secret123");
assert.equal((await call({}, [])).status, 401);
const ok = await call({ authorization: "secret123" }, [swap("z", -3, 50, now + 200)]);
assert.equal(ok.status, 200);
assert.equal(ok.body.events, 1);
assert.equal((await recentEvents(1))[0].id.startsWith("z:"), true);

// Wallets added in Exit Alarm: forwarded to the alarm, never on the radio
const W = "Whale1111111111111111111111111111111111111";
const wswap = (sig, sol, tok) => ({ ...swap(sig, sol, tok, now + 300), feePayer: W,
  accountData: [{ account: W, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: [] },
    { account: "ata2", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: W, mint: MINT, rawTokenAmount: { tokenAmount: String(tok * 1e6), decimals: 6 } }] }] });
assert.equal(txsToEvents([wswap("w0", 5, -10)]).length, 0, "unknown wallet ignored by default");
const forwarded = [];
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://alarm/api/hook") forwarded.push(...JSON.parse(init.body));
  return { ok: true, json: async () => ({}), text: async () => "" };
};
await redis("SET", "alarm:inbox", JSON.stringify({ url: "https://alarm/api/hook", secret: "s" }));
await redis("HSET", "alarm:wallets", W, "1");
const w1 = await call({ authorization: "secret123" }, [wswap("w1", 5, -10)]);
assert.equal(w1.body.events, 1);
assert.deepEqual([forwarded.at(-1).t, forwarded.at(-1).custom, forwarded.at(-1).side], [W, true, "sell"]);
assert.notEqual((await recentEvents(1))[0].t, W, "custom wallet stays off the radio");
// A spam bot wallet gets dropped after the daily limit
const { CUSTOM_DAILY_LIMIT } = await import("../api/hook.js");
await redis("SET", `alarm:rate:${W}:${new Date().toISOString().slice(0, 10)}`, String(CUSTOM_DAILY_LIMIT));
await call({ authorization: "secret123" }, [wswap("w2", 5, -10)]);
assert.equal(forwarded.at(-1).dropped, true);
assert.equal(await redis("HGET", "alarm:wallets", W), null);
// AI voice: line → MP3 through OpenAI, cached, falls back when no key
const { speakable } = await import("../lib/tts.js");
assert.equal(speakable("Ansem aped $WIF at 45k, ngmi"), "Ansem aped WIF at 45K, N G M I");
const { default: voice } = await import("../api/voice.js");
const getVoice = (id) => new Promise((resolve) => {
  const headers = {};
  voice({ method: "GET", url: "/api/voice?id=" + id, headers: {} }, { statusCode: 200, setHeader(k, v) { headers[k] = v; }, end(x) { resolve({ status: this.statusCode, headers, body: x }); } });
});
assert.equal((await getVoice(1)).status, 404, "no key → no AI voice");
process.env.OPENAI_API_KEY = "sk-test";
let ttsBody, improvBody, improvOk = false;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("audio/speech")) { ttsBody = JSON.parse(init.body); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; }
  if (String(url).includes("chat/completions")) {
    improvBody = JSON.parse(init.body);
    if (!improvOk) return { ok: false, status: 404, text: async () => "model not found" };
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from("MP3").toString("base64"), transcript: "Yo yo yo, Frank just aped!" } } }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
const segId = (await (await import("../lib/show.js")).recentSegments(1))[0].id;
const v = await getVoice(segId);
assert.equal(v.status, 200);
assert.equal(v.headers["content-type"], "audio/mpeg");
assert.match(v.headers["cache-control"], /s-maxage/);
assert.match(ttsBody.instructions, /radio DJ/, "improv failed → falls back to reading it out");
improvOk = true;
await redis("SET", "radio:segs:dummy", "1");
const { improvise } = await import("../lib/tts.js");
const imp = await improvise("Frank aped $WIF", { OPENAI_API_KEY: "sk-test" });
assert.equal(imp.transcript, "Yo yo yo, Frank just aped!");
assert.equal(imp.mp3.toString(), "MP3");
assert.deepEqual(improvBody.modalities, ["text", "audio"]);
assert.match(improvBody.messages[1].content, /Frank aped WIF/);
assert.equal((await snapshot({})).speech, "ai");
delete process.env.OPENAI_API_KEY;
console.log("radio OK");
