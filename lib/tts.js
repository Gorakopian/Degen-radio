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
