// GET /api/voice?id=<line id> → that host line as an MP3 in the AI voice.
// Cached by Vercel's CDN, so each line is generated once no matter how many people listen.
import { recentSegments } from "../lib/show.js";
import { synthesize, ttsProvider, TTS_DAILY_MAX } from "../lib/tts.js";
import { redis } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (!ttsProvider()) return send(res, 404, { error: "no_voice" });
  const id = Number(query(req).id);
  if (!id) return send(res, 400, { error: "id needed" });
  const seg = (await recentSegments(60)).find((s) => s.id === id);
  if (!seg) return send(res, 404, { error: "line not found" });

  const day = new Date().toISOString().slice(0, 10);
  const n = await redis("INCR", `radio:tts:${day}`);
  if (n === 1) await redis("EXPIRE", `radio:tts:${day}`, 172800);
  if (n > TTS_DAILY_MAX) return send(res, 429, { error: "daily voice limit reached" });

  try {
    const mp3 = await synthesize(seg.text);
    res.statusCode = 200;
    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("content-length", mp3.length);
    res.setHeader("cache-control", "public, max-age=86400, s-maxage=86400, immutable");
    res.end(mp3);
  } catch (e) {
    await redis("SET", "radio:ttsError", String(e.message || e).slice(0, 200), "EX", 3600);
    return send(res, 502, { error: "voice failed" });
  }
}
