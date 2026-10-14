// Real AI voice for the host. Every line is turned into an MP3 once (Vercel's CDN caches it for all listeners).
// Providers, first one with a key wins:
//   OPENAI_API_KEY      → OpenAI gpt-4o-mini-tts, told to sound like a hyped radio DJ (cheap, sounds natural)
//   ELEVENLABS_API_KEY  → ElevenLabs (most natural, pricier). Voice: ELEVENLABS_VOICE_ID
// No key → the page falls back to the phone/browser voice.

export const TTS_DAILY_MAX = 4000; // lines per day, a safety cap on cost

const DJ_STYLE = `You are a hyped-up late-night radio DJ and sports commentator roasting crypto traders live on air.
Talk fast, loud and loose, like you're riffing live, not reading. Big energy on hype moments, smug and sarcastic on the roasts,
little laughs and disbelief in your voice, punchy pauses before punchlines. Natural, conversational, never robotic.`;

/** The OpenAI key, whatever the env var is called (OpenAI keys start with "sk-", Anthropic ones with "sk-ant-"). */
export function openaiKey(env = process.env) {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY.trim();
  for (const [k, v] of Object.entries(env)) {
    const val = String(v || "").trim();
    if (/^sk-/.test(val) && !/^sk-ant-/.test(val) && (/openai|voice|tts|radio|key/i.test(k) || /^sk-proj-/.test(val))) return val;
  }
  return null;
}

export function ttsProvider(env = process.env) {
  if (openaiKey(env)) return "openai";
  if (env.ELEVENLABS_API_KEY) return "elevenlabs";
  return null;
}

/** Make the line easier to say out loud. Pure. */
export function speakable(text) {
  return String(text || "")
    .replace(/\$([A-Za-z][A-Za-z0-9]*)/g, "$1")          // $WIF → WIF
    .replace(/(\d)k\b/gi, "$1K")
    .replace(/\bSOL\b/g, "sol")
    .replace(/\bngmi\b/gi, "N G M I")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export async function synthesize(text, env = process.env) {
  const provider = ttsProvider(env);
  const input = speakable(text);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    let res;
    if (provider === "openai") {
      res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey(env)}` },
        body: JSON.stringify({
          model: env.RADIO_TTS_MODEL || "gpt-4o-mini-tts",
          voice: env.RADIO_TTS_VOICE || "ash",
          input,
          instructions: DJ_STYLE,
          response_format: "mp3",
        }),
      });
    } else if (provider === "elevenlabs") {
      const voice = env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
      res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
        body: JSON.stringify({
          text: input,
          model_id: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
          voice_settings: { stability: 0.3, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true },
        }),
      });
    } else {
      throw new Error("no_tts_key");
    }
    if (!res.ok) throw new Error(`tts_${res.status}: ${(await res.text()).slice(0, 160)}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// ---- Improv mode: a speech-native model performs the line in its own words (sounds live, not read) ----
const IMPROV_MODELS = ["gpt-audio-mini", "gpt-4o-mini-audio-preview"];

const IMPROV_SYSTEM = `You are DJ Exit Liquidity, live on DEGEN RADIO, a 24/7 show roasting real Solana memecoin trades by famous crypto traders.
You are ON AIR right now, talking, not reading. Sound like a real hyped-up radio DJ / sports commentator riffing off the screen in front of you:
loose, fast, playful, natural breaths, little laughs, "yo", "oh my god", "nah nah nah", reactions, stretching words for hype, a beat of silence before the punchline.
Rules: no slurs; nothing about anyone's race, religion, nationality, gender, sexuality, disability, family or body; no threats; don't claim anyone committed a crime or a scam. Roast the trades only.`;

/** What we ask the audio model to say. Pure. */
export function improvPrompt(line) {
  return `Here is what just happened and the joke to land. Say it live in your own words (you can reorder, shorten, react, ad-lib), but keep every trader name, coin name and number correct. Coin tickers are said as words, no dollar sign. 8 to 18 seconds, then stop. Don't announce that you're reading anything.

${speakable(line)}`;
}

/** → { mp3: Buffer, transcript } — the model improvises the line out loud. */
export async function improvise(line, env = process.env) {
  const key = openaiKey(env);
  if (!key) throw new Error("no_openai_key");
  const models = env.RADIO_AUDIO_MODEL ? [env.RADIO_AUDIO_MODEL] : IMPROV_MODELS;
  let last;
  for (const model of models) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 22000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          modalities: ["text", "audio"],
          audio: { voice: env.RADIO_TTS_VOICE || "ash", format: "mp3" },
          temperature: 1,
          messages: [{ role: "system", content: IMPROV_SYSTEM }, { role: "user", content: improvPrompt(line) }],
        }),
      });
      if (!res.ok) { last = new Error(`${model}_${res.status}: ${(await res.text()).slice(0, 140)}`); continue; }
      const data = await res.json();
      const audio = data?.choices?.[0]?.message?.audio;
      if (!audio?.data) { last = new Error(`${model}_no_audio`); continue; }
      return { mp3: Buffer.from(audio.data, "base64"), transcript: String(audio.transcript || "").trim(), model };
    } catch (e) { last = e; }
    finally { clearTimeout(timer); }
  }
  throw last || new Error("improv_failed");
}

/** Improvise when possible (OpenAI key, not switched off with RADIO_VOICE_MODE=read), else read it out. */
export async function perform(line, env = process.env) {
  perform.lastError = null;
  if (openaiKey(env) && (env.RADIO_VOICE_MODE || "improv") !== "read") {
    try { return await improvise(line, env); }
    catch (e) { perform.lastError = String(e.message || e).slice(0, 200); }
  }
  return { mp3: await synthesize(line, env), transcript: null };
}
