// The on-air host: turns new trades into short, brutal commentary.
// LLM is pluggable:
//   default  → Claude (ANTHROPIC_API_KEY, model RADIO_MODEL or claude-haiku-5-5)
//   RADIO_LLM_PROVIDER=openai → any OpenAI-compatible API (RADIO_LLM_BASE_URL, RADIO_LLM_API_KEY, RADIO_MODEL)
// Without a key it uses built-in template lines.

import { TRADERS } from "./traders.js";

export const HOST_NAME = "DJ Exit Liquidity";

// The list is ordered by fame: the first STAR_COUNT traders are the headliners the host goes wild for.
export const STAR_COUNT = 20;
const RANK = Object.fromEntries(TRADERS.map((t, i) => [t.id, i]));
export const isStar = (id) => (RANK[id] ?? 999) < STAR_COUNT;

const fmtUsd = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} million` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`);

/** One line per trade, written to be read by the model. Pure. */
export function describeEvent(e) {
  const who = e.x ? `${e.n} (@${e.x})` : e.n;
  const what = e.side === "buy" ? "BOUGHT" : "SOLD";
  const size = e.sol ? `${e.sol} SOL` : e.usd ? `$${e.usd}` : "a bag";
  const mcap = e.mcap ? ` at ${fmtUsd(e.mcap)} market cap` : "";
  return `${isStar(e.t) ? "[STAR] " : ""}${who} ${what} $${e.sym} for ${size}${mcap}`;
}

/** Which trades to read out: every star trade first, then the biggest sizes. Max 10, in time order. Pure. */
export function pickEvents(events, max = 10) {
  const ranked = [...events].sort((a, b) => (isStar(b.t) - isStar(a.t)) || ((b.sol || 0) - (a.sol || 0)));
  return ranked.slice(0, max).sort((a, b) => a.ts - b.ts);
}

export function buildPrompt(events, recentLines, stats) {
  const trades = events.length
    ? events.map((e) => "- " + describeEvent(e)).join("\n")
    : "- (nothing new in the last minute)";
  return `You are ${HOST_NAME}, the host of DEGEN RADIO: a 24/7 live show that commentates real Solana memecoin trades by famous crypto traders, like a hyped-up, trash-talking sports commentator crossed with a roast comic.

Style:
- Brutal, fast, funny trash talk. Roast the TRADES and the decisions: aping tops, paper hands, panic sells, tiny sizes, buying 9-figure caps, round trips, exit liquidity. Swearing is allowed.
- Call traders by their name. Use real tickers, sizes and market caps from the trades. Hype the big plays, mock the bad ones.
- Memecoin slang: aped, jeeted, paper hands, diamond hands, cooked, rugged, exit liquidity, top blast, bagholder, ngmi, send it.
- Traders marked [STAR] are the famous headliners (like Ansem, Frank DeGods, Cupsey, Orangie). When a star trades, that is THE story: lead with them, go full stadium-announcer hype ("LADIES AND GENTLEMEN", "drop everything"), then roast or praise the move. Regular traders get a quick one-liner or get lumped together, unless their trade is huge or hilarious.
- No slurs. Nothing about anyone's race, religion, nationality, gender, sexuality, disability, family or body. No threats. Don't claim anyone committed a crime or a scam; just roast what the trades show.
- This is SPOKEN live on air, so write the way a DJ actually talks, not the way people write: contractions, short punchy bursts, fragments are fine, interjections ("oh my god", "yo", "listen", "nah"), rhetorical questions, and commas, dashes and "..." for rhythm and pauses before the punchline. No emojis, hashtags, markdown, lists or stage directions. Write numbers so they read well ("12 SOL", "45k market cap"); write tickers without the dollar sign.
- 1 to 3 sentences, at most 55 words. Don't repeat jokes or openers from the previous lines. Never start with "And".
${events.length ? "" : "- Nothing new happened: do quick filler banter about the quiet trenches, who's been the biggest clown today, or tease the listeners. Keep it short."}

Today so far: ${stats || "no trades yet"}

Your previous lines (don't repeat them):
${recentLines.length ? recentLines.map((l) => "- " + l).join("\n") : "- (show just started)"}

New trades since your last line:
${trades}

Reply with only your next spoken line.`;
}

function clean(text) {
  return String(text || "")
    .replace(/[*_#`>~]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/^\s*(DJ Exit Liquidity|Host)\s*:\s*/i, "")
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export async function speakLine(prompt, env = process.env) {
  const provider = (env.RADIO_LLM_PROVIDER || "").toLowerCase();
  if (provider === "openai" && env.RADIO_LLM_API_KEY) {
    const base = (env.RADIO_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.RADIO_LLM_API_KEY}` },
      body: JSON.stringify({ model: env.RADIO_MODEL || "gpt-4o-mini", max_tokens: 160, temperature: 1, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`llm_${res.status}`);
    const j = await res.json();
    return clean(j?.choices?.[0]?.message?.content);
  }
  // Also accept a key saved under another name (e.g. "Radio") as long as it is an Anthropic key
  const anthropicKey = env.ANTHROPIC_API_KEY || Object.entries(env).find(([k, v]) => /radio/i.test(k) && /^sk-ant-/.test(String(v || "").trim()))?.[1]?.trim();
  if (anthropicKey) {
    const call = (extra) => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.RADIO_MODEL || "claude-haiku-5-5", messages: [{ role: "user", content: prompt }], ...extra }),
    });
    // Newer models may think before answering; switch that off so the short budget goes to the line itself
    let res = await call({ max_tokens: 300, thinking: { type: "disabled" } });
    if (res.status === 400) res = await call({ max_tokens: 2000 });
    if (!res.ok) throw new Error(`llm_${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    const j = await res.json();
    const out = clean((j.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" "));
    if (!out) throw new Error(`empty_reply stop=${j.stop_reason} model=${j.model} types=${(j.content || []).map((c) => c.type).join(",")}`);
    return out;
  }
  return null;
}

// ---- built-in lines when no LLM is set up ----------------------------------
const pick = (a) => a[Math.floor(Math.random() * a.length)];
export function templateLine(events, statsLeader) {
  if (!events.length) {
    return pick([
      "Dead quiet in the trenches. Everybody's either sleeping, rugged, or staring at a chart that hasn't moved since Tuesday.",
      `Quiet minute. Perfect time to remember ${statsLeader || "somebody"} has been aping like rent isn't due.`,
      "Nothing happening. Somewhere a dev is deploying a coin called something with cat in the name. Stay tuned.",
      "No trades, no pain. Enjoy it, because the next ape is already loading his wallet.",
    ]);
  }
  const big = [...events].sort((a, b) => (isStar(b.t) - isStar(a.t)) || ((b.sol || 0) - (a.sol || 0)))[0];
  const mc = big.mcap ? ` at ${fmtUsd(big.mcap)}` : "";
  if (isStar(big.t)) {
    return big.side === "buy"
      ? pick([
        `LADIES AND GENTLEMEN, ${big.n} IS IN THE BUILDING! ${big.sol} SOL into ${big.sym}${mc}. The trenches just went quiet out of respect.`,
        `Drop everything. ${big.n} just aped ${big.sol} SOL into ${big.sym}${mc}. Copy traders, start your engines.`,
      ])
      : pick([
        `Breaking news: ${big.n} is DUMPING ${big.sym}. ${big.sol} SOL out the door. If you're still holding, congratulations, you're the exit liquidity.`,
        `${big.n} just sold ${big.sym}${mc} for ${big.sol} SOL. When the headliner leaves the party, you don't stay for the cleanup.`,
      ]);
  }
  if (big.side === "buy") {
    return pick([
      `${big.n} just slammed ${big.sol} SOL into ${big.sym}${mc}. Either genius or the most expensive lesson of the week.`,
      `Here we go, ${big.n} apes ${big.sol} SOL into ${big.sym}${mc}. Somebody check on him in an hour.`,
      `${big.n} buying ${big.sym}${mc} with ${big.sol} SOL. Exit liquidity has entered the building.`,
    ]);
  }
  return pick([
    `${big.n} dumps ${big.sym} for ${big.sol} SOL. Paper hands, folks, paper hands live on air.`,
    `${big.n} is out of ${big.sym}. ${big.sol} SOL back. Whoever bought that is now officially the bag.`,
    `And ${big.n} jeets ${big.sym}${mc}. Watch it pump ten x the second he leaves, it always does.`.replace(/^And /, ""),
  ]);
}
