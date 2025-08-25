// server.cjs — Dual-provider backend (KIE + FAL) + ElevenLabs + Mux
// Node 18+, CommonJS

console.log("[BOOT] starting veo3-backend-dual …");
process.on("uncaughtException", e => console.error("[FATAL]", e));
process.on("unhandledRejection", e => console.error("[FATAL-PROMISE]", e));

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- CORS ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- ENV ----------
const PORT = process.env.PORT || 8080;
const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "kie").toLowerCase();

const KIE_KEY = process.env.KIE_KEY || "";
let KIE_API_PREFIX = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1/veo").replace(/\/$/, "");
KIE_API_PREFIX = KIE_API_PREFIX.replace(/\/veo3(\/|$)/, "/veo$1");
const KIE_FAST_PATH = process.env.KIE_FAST_PATH || "/generate";
const KIE_QUALITY_PATH = process.env.KIE_QUALITY_PATH || "/generate";
const KIE_RESULT_PATHS = (process.env.KIE_RESULT_PATHS || "/record-info?taskId=:id").split(",");
const KIE_HD_PATH = process.env.KIE_HD_PATH || "/get-1080p-video?taskId=:id";

const FAL_KEY_ID = process.env.FAL_KEY_ID || "";
const FAL_KEY_SECRET = process.env.FAL_KEY_SECRET || "";
const FAL_KEY = process.env.FAL_KEY || "";
let FAL_BASIC = "";
if (FAL_KEY_ID && FAL_KEY_SECRET) FAL_BASIC = Buffer.from(`${FAL_KEY_ID}:${FAL_KEY_SECRET}`).toString("base64");
else if (FAL_KEY.includes(":")) FAL_BASIC = Buffer.from(FAL_KEY).toString("base64");

const FAL_BASE = (process.env.FAL_API_BASE || "https://api.fal.ai").replace(/\/$/, "");
const FAL_SUBMIT_PATH = process.env.FAL_SUBMIT_PATH || "/v1/pipelines/google/veo/submit";
const FAL_RESULT_BASE = (process.env.FAL_RESULT_BASE || "/v1/pipelines/google/veo/requests").replace(/\/$/, "");

const VEO_MODEL_FAST = process.env.VEO_MODEL_FAST || "veo3_fast";
const VEO_MODEL_QUALITY = process.env.VEO_MODEL_QUALITY || "veo3";

const ELEVEN_KEY =
  process.env.ELEVEN_LABS ||
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_LABS_API_KEY ||
  process.env["11_Labs"] || "";

const ENABLE_MUX = String(process.env.ENABLE_MUX || "") === "1";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

// Writable static
const TMP_ROOT = "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR = path.join(STATIC_ROOT, "tts");
const MUX_DIR = path.join(STATIC_ROOT, "mux");
(async () => {
  await fs.mkdir(TTS_DIR, { recursive: true });
  await fs.mkdir(MUX_DIR, { recursive: true });
})();

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function providerFrom(req) {
  return (req.query.provider || req.body?.provider || DEFAULT_PROVIDER || "kie").toLowerCase();
}
function falHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (FAL_BASIC) h["Authorization"] = `Basic ${FAL_BASIC}`;
  return h;
}
function kieHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (KIE_KEY) h["Authorization"] = `Bearer ${KIE_KEY}`;
  return h;
}

// Extract video URL
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
        if (v.data && (typeof v.data.url === "string" || typeof v.data.video_url === "string"))
          return v.data.video_url || v.data.url;
        const ru = v.data && (v.data.resultUrls || v.data.resultUrl || v.data.videoUrl);
        if (typeof ru === "string" && /https?:\/\//.test(ru)) return ru;
        if (Array.isArray(ru) && ru.length && typeof ru[0] === "string") return ru[0];
        for (const k of Object.keys(v)) stack.push(v[k]);
      }
    }
  } catch {}
  return null;
}

const cache = new Map();
async function backgroundPollKIE(taskId) {
  if (!taskId) return;
  for (let i = 0; i < 8; i++) {
    await sleep(i === 0 ? 4000 : 8000);
    for (const pat of KIE_RESULT_PATHS) {
      const url = `${KIE_API_PREFIX}${pat.trim().replace(":id", encodeURIComponent(taskId))}`;
      try {
        const rr = await fetch(url, { headers: kieHeaders() });
        const tt = await rr.text();
        let jj = {};
        try { jj = JSON.parse(tt); } catch {}
        if (rr.ok) {
          const u = findVideoUrl(jj);
          if (u) { cache.set(taskId, u); return; }
        }
      } catch {}
    }
  }
}

// ---------- Providers ----------
async function submitAndMaybeWaitFAL(body, modelName) {
  const payload = { ...body, model: modelName };
  const r = await fetch(FAL_BASE + FAL_SUBMIT_PATH, { method: "POST", headers: falHeaders(), body: JSON.stringify(payload) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false, status: r.status, error: j?.error || t };
  const jid = j.request_id || j.id;
  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok: true, status: 200, job_id: jid, video_url: urlNow };
  return { ok: true, status: 202, pending: true, job_id: jid };
}

async function submitAndMaybeWaitKIE(body, modelName) {
  const payload = { ...body, model: modelName };
  const r = await fetch(`${KIE_API_PREFIX}${modelName===VEO_MODEL_FAST?KIE_FAST_PATH:KIE_QUALITY_PATH}`, {
    method: "POST", headers: kieHeaders(), body: JSON.stringify(payload)
  });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false, status: r.status, error: j?.msg || j?.error || t };
  const jid = j.taskId || j.data?.taskId;
  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok: true, status: 200, job_id: jid, video_url: urlNow };
  backgroundPollKIE(jid).catch(()=>{});
  return { ok: true, status: 202, pending: true, job_id: jid };
}

// ---------- ROUTES ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), provider: DEFAULT_PROVIDER, elevenKey: !!ELEVEN_KEY, mux: ENABLE_MUX });
});

app.post(["/generate","/generate-fast"], async (req, res) => {
  const fn = providerFrom(req)==="fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
  const out = await fn(req.body, VEO_MODEL_FAST);
  res.status(out.status).json({ success: out.ok, ...out });
});

app.post("/generate-quality", async (req, res) => {
  const fn = providerFrom(req)==="fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
  const out = await fn(req.body, VEO_MODEL_QUALITY);
  res.status(out.status).json({ success: out.ok, ...out });
});

app.get("/result/:jobId", async (req, res) => {
  const prov = providerFrom(req), id=req.params.jobId;
  if (cache.has(id)) return res.json({ success: true, provider: prov, job_id: id, pending: false, video_url: cache.get(id) });
  return res.json({ success: true, provider: prov, job_id: id, pending: true });
});

// ---------- ElevenLabs ----------
app.get("/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } });
  const j = await r.json();
  if (!r.ok) return res.status(r.status).json(j);
  res.json({ voices: (j.voices||[]).map(v => ({ id: v.voice_id||v.id, name:v.name })) });
});

app.post("/eleven/tts", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  const { voice_id, text, model_id } = req.body||{};
  if (!voice_id || !text) return res.status(400).json({ error:"voice_id and text required" });
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?optimize_streaming_latency=0`;
  const r = await fetch(url, { method:"POST", headers:{ "xi-api-key":ELEVEN_KEY,"Content-Type":"application/json","Accept":"audio/mpeg" },
    body: JSON.stringify({ text, model_id: model_id||"eleven_multilingual_v2" }) });
  if (!r.ok) return res.status(r.status).json({ error:"ElevenLabs error" });
  const buf = Buffer.from(await r.arrayBuffer());
  const fname = `tts_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp3`;
  await fs.writeFile(path.join(TTS_DIR,fname),buf);
  res.json({ audio_url:`/static/tts/${fname}`, bytes:buf.length });
});

// Alias for frontend
app.post("/eleven/tts.stream", (req,res,next)=>{ req.url="/eleven/tts"; app._router.handle(req,res,next); });

// ---------- Mux ----------
app.post("/mux", async (req,res)=>{
  if (!ENABLE_MUX) return res.status(403).json({ error:"Mux disabled" });
  const { video_url, audio_url }=req.body||{};
  if (!video_url||!audio_url) return res.status(400).json({ error:"video_url and audio_url required" });
  const vPath=path.join(TMP_ROOT,`v_${Date.now()}.mp4`), aPath=path.join(TMP_ROOT,`a_${Date.now()}.mp3`),
        outPath=path.join(MUX_DIR,`out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
  const dl=async(u,f)=>{ const r=await fetch(u); const b=Buffer.from(await r.arrayBuffer()); await fs.writeFile(f,b); };
  await dl(video_url,vPath); await dl(audio_url,aPath);
  const args=["-y","-i",vPath,"-i",aPath,"-c:v","copy","-c:a","aac","-shortest",outPath];
  const proc=spawn(FFMPEG_PATH,args); proc.on("close",async(code)=>{ try{await fs.rm(vPath);await fs.rm(aPath);}catch{} 
    if(code!==0) return res.status(500).json({ error:`ffmpeg exit ${code}` });
    res.json({ merged_url:`/static/mux/${path.basename(outPath)}` }); });
});

// Static
app.use("/static", express.static(STATIC_ROOT));

app.listen(PORT, ()=> console.log(`[OK] listening :${PORT}, provider=${DEFAULT_PROVIDER}, mux=${ENABLE_MUX}`));
