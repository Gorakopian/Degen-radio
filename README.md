# Degen Radio

A 24/7 live show where **DJ Exit Liquidity** roasts the real trades of 100 famous memecoin traders as they happen,
like a trash-talking sports commentator. Listen in the browser, or put it on a livestream (X, Twitch, pump.fun) with Stream mode.

## How it works

1. **Helius** sends every new transaction of the 100 traders to `/api/hook` (a webhook). The site sets this up
   **by itself** the first time someone opens it, so there's nothing to configure.
2. Swaps become trades on **the wire**: who, buy or sell, which coin, how much SOL, market cap.
3. While someone is listening, the page asks for news every 6 seconds. Every ~12 seconds (or every 45 seconds when
   it's quiet) the host writes a new line about the latest trades with the AI.
4. The page reads the line aloud with the browser's built-in voice and shows it as a big caption.

Nobody listening means no AI calls, so it costs nothing when it's quiet.

## Put it online (Vercel)

1. Import this repository in Vercel → **Deploy**.
2. Add the free database: **vercel.com/marketplace/upstash** → Install → Upstash for Redis → connect it to this project.
3. **Settings → Environment Variables**:
   - `HELIUS_API_KEY`: your Helius key (same as Roaster/League is fine). Without it the radio runs on made-up demo trades.
   - `ANTHROPIC_API_KEY`: for the AI host. Without it the host uses a small set of built-in lines.
4. **Redeploy**, then open the site once on its **public** address (that's the address the webhook gets).
5. Make sure the site isn't behind Vercel's login: **Settings → Deployment Protection → Vercel Authentication → Disabled**.

## The host's personality

The prompt is in `lib/host.js`. The host is told to trash-talk and swear about the trades, but not to use slurs,
attack anyone's background, body or family, threaten, or claim crimes. That keeps the stream from getting banned.

Change the AI with settings (no code changes):
- `RADIO_MODEL`: which Claude model (default `claude-haiku-5-5`, fast and cheap).
- Another provider with an OpenAI-compatible API: `RADIO_LLM_PROVIDER=openai`, `RADIO_LLM_BASE_URL`
  (for example `https://api.x.ai/v1`), `RADIO_LLM_API_KEY`, `RADIO_MODEL`.

## Streaming it

Open `https://YOUR-SITE/?stream`, click **GO LIVE**, and capture that browser window in OBS (window capture + desktop audio).
Stream mode shows only the big caption and the ON AIR light.

## Costs to watch

- **Helius:** 1 credit per trade event from the 100 traders. Busy traders make many trades, so check your Helius usage
  after the first day. Remove traders from `lib/traders.js` if it's too much.
- **AI:** at most one short request every 12 seconds, only while someone is listening.

## Files

| File | What it does |
|---|---|
| `index.html` | The radio: caption, listen button, voice picker, transcript, the wire, biggest apers, stream mode |
| `api/radio.js` | What the page polls: new lines, latest trades, today's stats; keeps the show running |
| `api/hook.js` | Receives the traders' transactions from Helius |
| `lib/host.js` | The host's prompt, the AI call (Claude or OpenAI-compatible) and backup lines |
| `lib/show.js` | When to speak, today's stats |
| `lib/feed.js` | Turns transactions into trades, coin names and market caps, sets up the Helius webhook, demo trades |
| `lib/traders.js` | The 100 traders (same list as Degen League) |
| `scripts/dev.js` | Run it on your own computer: `npm run dev` |

`npm test` runs the tests.
