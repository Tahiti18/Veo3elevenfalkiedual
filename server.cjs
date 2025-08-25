// server.cjs — Dual-provider backend (KIE-first) + ElevenLabs + optional mux
// Node 18+, CommonJS

console.log("[BOOT] starting veo3-backend-dual …");
process.on("uncaughtException", e => console.error("[FATAL]", e));
process.on("unhandledRejection", e => console.error("[FATAL-PROMISE]", e));

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ---- CORS (explicit preflight; returns 204/200) ------------------------ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---- ENV --------------------------------------------------------------- */
const PORT = process.env.PORT || 8080;

// KIE
const KIE_KEY = process.env.KIE_KEY || "";
const KIE_API_PREFIX = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1/veo3").replace(/\/$/, "");
// many KIE installs expose a single /generate and infer the model; we keep both routes the same
const KIE_FAST_PATH = process.env.KIE_FAST_PATH || "/generate";
const KIE_QUALITY_PATH = process.env.KIE_QUALITY_PATH || "/generate";
const KIE_RESULT_PATHS = (process.env.KIE_RESULT_PATHS || "/result/:id,/status/:id").split(",");

// Models (forwarded inside the POST body for providers that need it)
const VEO_MODEL_FAST = process.env.VEO_MODEL_FAST || "V3_5";
const VEO_MODEL_QUALITY = process.env.VEO_MODEL_QUALITY || "V4_5PLUS";

// ElevenLabs
const ELEVEN_KEY =
  process.env.ELEVEN_LABS ||
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_LABS_API_KEY ||
  process.env["11_Labs"] || "";

// Optional mux
const ENABLE_MUX = String(process.env.ENABLE_MUX || "") === "1";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

// Writable static
const TMP_ROOT = "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR = path.join(STATIC_ROOT, "tts");
const MUX_DIR = path.join(STATIC_ROOT, "mux");
(async () => {
  try {
    await fs.mkdir(TTS_DIR, { recursive: true });
    await fs.mkdir(MUX_DIR, { recursive: true });
  } catch {}
})();

/* ---- Helpers ----------------------------------------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function kieHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (KIE_KEY) h.Authorization = `Bearer ${KIE_KEY}`;
  return h;
}

// aggressively digs for a playable URL anywhere in a provider payload
function findVideoUrl(maybe) {
  if (!maybe) return null;
  try {
    const stack = [maybe];
    while (stack.length) {
      const v = stack.pop();
      if (typeof v === "string" && /https?:\/\/.+\.(mp4|mov|m4v|m3u8)(\?|$)/i.test(v)) return v;
      if (v && typeof v === "object") {
        if (typeof v.video_url === "string") return v.video_url;
        if (v.output && typeof v.output.video_url === "string") return v.output.video_url;
        if (v.video && typeof v.video.url === "string") return v.video.url;
        if (typeof v.url === "string" && /^https?:\/\//.test(v.url)) return v.url;
        if (v.data && (v.data.video_url || v.data.url)) return v.data.video_url || v.data.url;
        Object.keys(v).forEach(k => stack.push(v[k]));
      }
    }
  } catch {}
  return null;
}

/* ---- KIE submit + short poll ------------------------------------------ */
async function submitKIE(body, modelName, submitPath) {
  if (!KIE_KEY) {
    return { ok: false, status: 401, error: "Missing KIE_KEY on the server" };
  }

  // pass through UI body and include model hint (harmless if KIE ignores it)
  const payload = { ...body, model: modelName };
  const submitURL = `${KIE_API_PREFIX}${submitPath.startsWith("/") ? "" : "/"}${submitPath}`;

  const r = await fetch(submitURL, { method: "POST", headers: kieHeaders(), body: JSON.stringify(payload) });
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch { j = { raw: t }; }

  if (!r.ok) return { ok: false, status: r.status, error: j?.error || t || `KIE submit ${r.status}`, raw: j };

  // try direct URL or job id immediately
  const jobId =
    j.taskId || j.task_id || j.id || j.job_id ||
    (j.data && (j.data.taskId || j.data.task_id || j.data.id)) ||
    (j.result && (j.result.taskId || j.result.id)) || null;

  const directURL = findVideoUrl(j);
  if (directURL) return { ok: true, status: 200, job_id: jobId, video_url: directURL, raw: j };
  if (!jobId)  return { ok: true, status: 202, pending: true, job_id: null, raw: j };

  // short poll a few times on multiple result paths
  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 3000 : 5000);
    for (const pat of KIE_RESULT_PATHS) {
      const p = (pat || "").trim().replace(":id", encodeURIComponent(jobId));
      if (!p) continue;
      const url = `${KIE_API_PREFIX}${p.startsWith("/") ? "" : "/"}${p}`;
      try {
        const rr = await fetch(url, { headers: kieHeaders() });
        const tt = await rr.text();
        let jj = {};
        try { jj = JSON.parse(tt); } catch { jj = { raw: tt }; }
        if (rr.ok) {
          const u = findVideoUrl(jj);
          if (u) return { ok: true, status: 200, job_id: jobId, video_url: u, raw: jj };
        }
      } catch {}
    }
  }
  return { ok: true, status: 202, pending: true, job_id: jobId, raw: j };
}

/* ---- Routes: health & diag -------------------------------------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), provider: "kie" });
});

app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    kie: {
      prefix: KIE_API_PREFIX,
      fastPath: KIE_FAST_PATH,
      qualityPath: KIE_QUALITY_PATH,
      resultPaths: KIE_RESULT_PATHS,
      keyPresent: !!KIE_KEY
    },
    models: { fast: VEO_MODEL_FAST, quality: VEO_MODEL_QUALITY },
    elevenKeyPresent: !!ELEVEN_KEY,
    mux: ENABLE_MUX
  });
});

/* ---- Routes: video generation (THIS is what was missing) --------------- */
// POST /generate-fast
app.post("/generate-fast", async (req, res) => {
  try {
    const out = await submitKIE(req.body || {}, VEO_MODEL_FAST, KIE_FAST_PATH);
    return res.status(out.status || 200).json({
      success: !!out.ok,
      provider: "kie",
      job_id: out.job_id || null,
      pending: !!out.pending,
      video_url: out.video_url || null,
      meta: out.raw,
      error: out.ok ? undefined : out.error
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e?.message || String(e) });
  }
});

// POST /generate-quality
app.post("/generate-quality", async (req, res) => {
  try {
    const out = await submitKIE(req.body || {}, VEO_MODEL_QUALITY, KIE_QUALITY_PATH);
    return res.status(out.status || 200).json({
      success: !!out.ok,
      provider: "kie",
      job_id: out.job_id || null,
      pending: !!out.pending,
      video_url: out.video_url || null,
      meta: out.raw,
      error: out.ok ? undefined : out.error
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e?.message || String(e) });
  }
});

// GET /result/:jobId  (poll KIE /status/:id or /result/:id)
app.get("/result/:jobId", async (req, res) => {
  try {
    if (!KIE_KEY) return res.status(401).json({ success: false, error: "Missing KIE_KEY on the server" });
    const id = req.params.jobId;
    for (const pat of KIE_RESULT_PATHS) {
      const p = (pat || "").trim().replace(":id", encodeURIComponent(id));
      if (!p) continue;
      const url = `${KIE_API_PREFIX}${p.startsWith("/") ? "" : "/"}${p}`;
      try {
        const r = await fetch(url, { headers: kieHeaders() });
        const t = await r.text();
        let j = {};
        try { j = JSON.parse(t); } catch { j = { raw: t }; }
        if (r.ok) {
          const u = findVideoUrl(j);
          return res.status(200).json({ success: true, provider: "kie", job_id: id, pending: !u, video_url: u || null, raw: j });
        }
      } catch {}
    }
    res.status(202).json({ success: true, provider: "kie", job_id: id, pending: true });
  } catch (e) {
    res.status(502).json({ success: false, error: e?.message || String(e) });
  }
});

/* ---- ElevenLabs (unchanged behavior) ---------------------------------- */
// GET /eleven/voices
app.get("/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    const voices = (j.voices || []).map(v => ({ id: v.voice_id || v.id, name: v.name, category: v.category || "" }));
    res.json({ voices });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

// POST /eleven/tts  -> returns a JSON with saved file URL
app.post("/eleven/tts", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  const { voice_id, text, model_id, params } = req.body || {};
  if (!voice_id || !text) return res.status(400).json({ error: "voice_id and text required" });
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?optimize_streaming_latency=0`;
    const payload = {
      text,
      model_id: model_id || "eleven_multilingual_v2",
      voice_settings: {
        stability: params?.stability ?? 0.45,
        similarity_boost: params?.similarity_boost ?? 0.8,
        style: params?.style ?? 0.0,
        use_speaker_boost: params?.use_speaker_boost ?? true
      }
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const errTxt = await r.text().catch(()=> "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errTxt });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const fname = `tts_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp3`;
    await fs.writeFile(path.join(TTS_DIR, fname), buf);
    res.json({ audio_url: `/static/tts/${fname}`, bytes: buf.length });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

// POST /eleven/tts.stream  -> raw audio/mpeg stream for immediate playback
app.post("/eleven/tts.stream", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(401).send("Missing ElevenLabs key");
  const { voice_id, text, model_id, params } = req.body || {};
  if (!voice_id || !text) return res.status(400).send("voice_id and text required");
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?optimize_streaming_latency=0`;
    const payload = {
      text,
      model_id: model_id || "eleven_multilingual_v2",
      voice_settings: {
        stability: params?.stability ?? 0.45,
        similarity_boost: params?.similarity_boost ?? 0.8,
        style: params?.style ?? 0.0,
        use_speaker_boost: params?.use_speaker_boost ?? true
      }
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify(payload)
    });
    res.status(r.status);
    r.body.pipeTo(new WritableStream({
      start() { res.setHeader("Content-Type", "audio/mpeg"); },
      write(chunk) { res.write(chunk); },
      close() { res.end(); },
      abort() { try { res.end(); } catch {} }
    })).catch(() => { try { res.end(); } catch {} });
  } catch {
    res.status(502).end("TTS stream error");
  }
});

/* ---- Optional /mux ----------------------------------------------------- */
app.post("/mux", async (req, res) => {
  if (!ENABLE_MUX) return res.status(403).json({ error: "Mux disabled. Set ENABLE_MUX=1 and ensure ffmpeg is available." });
  const { video_url, audio_url } = req.body || {};
  if (!video_url || !audio_url) return res.status(400).json({ error: "video_url and audio_url required" });

  const vPath = path.join(TMP_ROOT, `v_${Date.now()}.mp4`);
  const aPath = path.join(TMP_ROOT, `a_${Date.now()}.mp3`);
  const outPath = path.join(MUX_DIR, `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);

  try {
    const dl = async (u, fp) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Download failed: ${u} -> ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(fp, b);
    };
    await dl(video_url, vPath);
    await dl(audio_url, aPath);

    const { spawn } = require("child_process");
    const args = ["-y", "-i", vPath, "-i", aPath, "-c:v", "copy", "-c:a", "aac", "-shortest", outPath];
    const proc = spawn(FFMPEG_PATH, args);
    proc.on("error", err => res.status(500).json({ error: "FFmpeg spawn failed", detail: String(err) }));
    proc.on("close", async (code) => {
      try { await fs.rm(vPath,{force:true}); await fs.rm(aPath,{force:true}); } catch {}
      if (code !== 0) return res.status(500).json({ error: `FFmpeg exit ${code}` });
      res.json({ merged_url: `/static/mux/${path.basename(outPath)}` });
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ---- Static + root ----------------------------------------------------- */
app.use("/static", express.static(STATIC_ROOT, {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
}));

app.get("/", (_req, res) => res.status(200).send("OK"));

app.listen(PORT, () => {
  console.log(`[OK] listening on :${PORT}`);
  console.log(`[KIE] prefix: ${KIE_API_PREFIX}, fastPath: ${KIE_FAST_PATH}, qualityPath: ${KIE_QUALITY_PATH}, key: ${!!KIE_KEY}`);
  console.log(`[Models] fast=${VEO_MODEL_FAST}, quality=${VEO_MODEL_QUALITY}`);
  console.log(`[ElevenLabs] key present: ${!!ELEVEN_KEY}, mux: ${ENABLE_MUX}`);
});
