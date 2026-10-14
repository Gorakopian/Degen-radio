// Solana helpers: what a transaction did to a wallet, token names, prices.
export const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([USDC, USDT]);
const QUOTES = new Set([WSOL, USDC, USDT]);
export const SOL_NOISE = 0.01;

/** SOL change (incl. wrapped SOL), stablecoin change and memecoin changes for one wallet in one Helius enhanced tx. */
export function walletDeltas(tx, wallet) {
  let sol = 0;
  const tokens = new Map();
  for (const acc of tx.accountData || []) {
    if (acc.account === wallet) sol += (Number(acc.nativeBalanceChange) || 0) / 1e9;
    for (const ch of acc.tokenBalanceChanges || []) {
      if (ch.userAccount !== wallet) continue;
      const raw = ch.rawTokenAmount || {};
      const amt = Number(raw.tokenAmount) / Math.pow(10, Number(raw.decimals) || 0);
      if (!Number.isFinite(amt) || amt === 0) continue;
      tokens.set(ch.mint, (tokens.get(ch.mint) || 0) + amt);
    }
  }
  sol += tokens.get(WSOL) || 0;
  let usd = 0;
  for (const m of STABLES) usd += tokens.get(m) || 0;
  const coins = [...tokens.entries()].filter(([m, a]) => !QUOTES.has(m) && Math.abs(a) > 0);
  return { sol, usd, coins };
}

/** Symbol, supply and decimals for coins, from Helius. */
export async function fetchTokenMeta(mints, apiKey) {
  const out = {};
  const ids = [...new Set(mints)].slice(0, 100);
  if (!ids.length || !apiKey) return out;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "radio", method: "getAssetBatch", params: { ids } }),
    });
    if (!res.ok) return out;
    const json = await res.json();
    for (const a of json.result || []) {
      if (!a?.id) continue;
      const ti = a.token_info || {};
      out[a.id] = {
        sym: (ti.symbol || a.content?.metadata?.symbol || "").trim().slice(0, 16),
        supply: Number(ti.supply) || null,
        dec: Number(ti.decimals) || 0,
      };
    }
  } catch { /* names are optional */ }
  return out;
}

/** Current USD prices from Jupiter. */
export async function fetchPrices(mints) {
  const out = {};
  const ids = [...new Set(mints)];
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.slice(i, i + 50).join(",")}`);
      if (!res.ok) continue;
      const j = await res.json();
      for (const [mint, v] of Object.entries(j || {})) {
        const p = Number(v?.usdPrice);
        if (p > 0) out[mint] = p;
      }
    } catch { /* keep going */ }
  }
  return out;
}
