// GET /api/lab            → the list of voices you can compare (with which ones are available)
// GET /api/lab?v=<option> → the same roast line in that voice (MP3). Cached, so it's generated once.
import { improvise, synthesize, openaiKey } from "../lib/tts.js";
import { redis } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

const LINE = "Ladies and gentlemen, drop everything! Ansem just aped 40 SOL into GOBLIN at a 2 million cap... and Cupsey? Cupsey sold the exact same coin ten minutes ago for 3 SOL. Paper hands so weak they need a support group. Somebody check on that man.";
const LINE_TAGGED = "[shouting] Ladies and gentlemen, drop everything! [excited] Ansem just aped 40 SOL into GOBLIN at a 2 million cap... [pause] and Cupsey? [laughs] Cupsey sold the exact same coin ten minutes ago for 3 SOL. [sarcastic] Paper hands so weak they need a support group. [laughs] Somebody check on that man.";

export const OPTIONS = {
  "improv-mini-ash":    { label: "Improvises · cheap · voice Ash",       kind: "improv", model: "gpt-audio-mini", voice: "ash" },
  "improv-mini-verse":  { label: "Improvises · cheap · voice Verse",     kind: "improv", model: "gpt-audio-mini", voice: "verse" },
  "improv-mini-ballad": { label: "Improvises · cheap · voice Ballad",    kind: "improv", model: "gpt-audio-mini", voice: "ballad" },
  "improv-mini-cedar":  { label: "Improvises · cheap · voice Cedar",     kind: "improv", model: "gpt-audio-mini", voice: "cedar" },
  "improv-mini-marin":  { label: "Improvises · cheap · voice Marin (female)", kind: "improv", model: "gpt-audio-mini", voice: "marin" },
  "improv-full-cedar":  { label: "Improvises · best OpenAI · voice Cedar", kind: "improv", model: "gpt-audio", voice: "cedar" },
  "improv-full-ash":    { label: "Improvises · best OpenAI · voice Ash",   kind: "improv", model: "gpt-audio", voice: "ash" },
  "read-ash":           { label: "Reads the script · voice Ash",         kind: "read", voice: "ash" },
  "eleven-v3":          { label: "ElevenLabs v3 · most realistic · laughs & shouts", kind: "eleven" },
};

export default async function handler(req, res) {
  const v = query(req).v;
  const hasOpenai = !!openaiKey(), hasEleven = !!process.env.ELEVENLABS_API_KEY;
  if (!v) {
    return send(res, 200, { line: LINE, options: Object.entries(OPTIONS).map(([id, o]) => ({ id, label: o.label, available: o.kind === "eleven" ? hasEleven : hasOpenai })) });
  }
  const o = OPTIONS[v];
  if (!o) return send(res, 404, { error: "unknown voice" });
  // safety cap: the lab can't be used to burn credits
  const n = await redis("INCR", `radio:lab:${new Date().toISOString().slice(0, 10)}`);
  if (n === 1) await redis("EXPIRE", `radio:lab:${new Date().toISOString().slice(0, 10)}`, 172800);
  if (n > 60) return send(res, 429, { error: "lab limit for today reached" });
  try {
    let mp3, transcript = null;
    if (o.kind === "improv") ({ mp3, transcript } = await improvise(LINE, { ...process.env, RADIO_AUDIO_MODEL: o.model, RADIO_TTS_VOICE: o.voice }));
    else if (o.kind === "read") mp3 = await synthesize(LINE, { ...process.env, RADIO_TTS_VOICE: o.voice }, "openai");
    else if (hasEleven) mp3 = await synthesize(LINE_TAGGED, process.env, "elevenlabs");
    else return send(res, 404, { error: "Add ELEVENLABS_API_KEY in Vercel to hear this one." });
    res.statusCode = 200;
    if (transcript) res.setHeader("x-transcript", encodeURIComponent(transcript.slice(0, 1200)));
    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "public, max-age=604800, s-maxage=604800, immutable");
    res.end(mp3);
  } catch (e) {
    return send(res, 502, { error: String(e.message || e).slice(0, 200) });
  }
}
