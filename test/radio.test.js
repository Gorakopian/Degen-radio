// Run with: node test/radio.test.js
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { txsToEvents, storeEvents, recentEvents } from "../lib/feed.js";
import { describeEvent, buildPrompt, templateLine } from "../lib/host.js";
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
assert.equal(describeEvent(e), `${T.name} (@${T.x}) BOUGHT $GOBLIN for 12.5 SOL at 45k market cap`);
const p = buildPrompt([e], ["Old line"], "3 trades.");
assert.match(p, /No slurs/);
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
console.log("radio OK");
