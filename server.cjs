// server.cjs — Dual-provider backend (KIE + FAL) + ElevenLabs + optional mux
console.log("[BOOT] starting veo3-backend-dual …");
process.on("uncaughtException", e => console.error("[FATAL]", e));
process.on("unhandledRejection", e => console.error("[FATAL-PROMISE]", e));

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const fetch = global.fetch || ((...a)=>import("node-fetch").then(m=>m.default(...a)));

const app = express();
app.use(express.json({ limit: "2mb" }));

// Explicit CORS (handles preflight cleanly)
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

// KIE
const KIE_KEY = process.env.KIE_KEY || "";
const KIE_API_PREFIX = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1/veo3").replace(/\/$/, "");
const KIE_FAST_PATH = process.env.KIE_FAST_PATH || "/generate";
const KIE_QUALITY_PATH = process.env.KIE_QUALITY_PATH || "/generate";
const KIE_RESULT_PATHS = (process.env.KIE_RESULT_PATHS || "/result/:id,/status/:id").split(",");

// FAL (Basic auth)
const FAL_KEY_ID = process.env.FAL_KEY_ID || "";
const FAL_KEY_SECRET = process.env.FAL_KEY_SECRET || "";
const FAL_KEY = process.env.FAL_KEY || "";
let FAL_BASIC = "";
if (FAL_KEY_ID && FAL_KEY_SECRET) FAL_BASIC = Buffer.from(`${FAL_KEY_ID}:${FAL_KEY_SECRET}`).toString("base64");
else if (FAL_KEY.includes(":")) FAL_BASIC = Buffer.from(FAL_KEY).toString("base64");
const FAL_BASE = (process.env.FAL_API_BASE || "https://api.fal.ai").replace(/\/$/, "");
const FAL_SUBMIT_PATH = process.env.FAL_SUBMIT_PATH || "/v1/pipelines/google/veo/submit";
const FAL_RESULT_BASE = (process.env.FAL_RESULT_BASE || "/v1/pipelines/google/veo/requests").replace(/\/$/, "");

// Models
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

// Writable static dirs
const TMP_ROOT = "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR = path.join(STATIC_ROOT, "tts");
const MUX_DIR = path.join(STATIC_ROOT, "mux");
(async () => {
  try { await fs.mkdir(TTS_DIR, { recursive: true }); await fs.mkdir(MUX_DIR, { recursive: true }); } catch {}
})();

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function providerFrom(req) {
  // allow ?provider=, body.provider, or /provider/:prov
  return (req.params?.prov || req.query.provider || req.body?.provider || DEFAULT_PROVIDER || "kie").toLowerCase();
}
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
        for (const k of Object.keys(v)) stack.push(v[k]);
      }
    }
  } catch {}
  return null;
}
const falHeaders = (extra={}) => ({ "Content-Type": "application/json", ...(FAL_BASIC? {Authorization:`Basic ${FAL_BASIC}`} : {}), ...extra });
const kieHeaders = (extra={}) => ({ "Content-Type": "application/json", ...(KIE_KEY? {Authorization:`Bearer ${KIE_KEY}`} : {}), ...extra });

// ---------- Providers ----------
async function submitAndMaybeWaitFAL(body, modelName) {
  const payload = { ...body, model: modelName };
  const submitURL = FAL_BASE + FAL_SUBMIT_PATH;
  const r = await fetch(submitURL, { method: "POST", headers: falHeaders(), body: JSON.stringify(payload) });
  const t = await r.text(); let j={}; try{ j=JSON.parse(t);}catch{ j={raw:t}; }
  if (!r.ok) return { ok:false, status:r.status, error:j?.error||t||`FAL submit ${r.status}`, raw:j };

  const jid = j.request_id || j.id || j.job_id || j?.data?.request_id || j?.data?.id || null;
  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok:true, status:200, job_id:jid, video_url:urlNow, raw:j };
  if (!jid) return { ok:true, status:202, pending:true, job_id:null, raw:j };

  const resultBase = FAL_BASE + FAL_RESULT_BASE;
  for (let i=0;i<5;i++){
    await sleep(i===0?3000:5000);
    const rr = await fetch(`${resultBase}/${encodeURIComponent(jid)}`, { headers: falHeaders() });
    const tt = await rr.text(); let jj={}; try{ jj=JSON.parse(tt);}catch{ jj={raw:tt}; }
    if (rr.ok) {
      const u = findVideoUrl(jj);
      if (u) return { ok:true, status:200, job_id:jid, video_url:u, raw:jj };
      if (/pending|running|processing/i.test(JSON.stringify(jj))) continue;
    }
  }
  return { ok:true, status:202, pending:true, job_id:jid, raw:j };
}

async function submitAndMaybeWaitKIE(body, modelName) {
  const payload = { ...body, model: modelName };
  const submitPath = modelName === VEO_MODEL_FAST ? KIE_FAST_PATH : KIE_QUALITY_PATH;
  const submitURL = `${KIE_API_PREFIX}${submitPath.startsWith("/")?"":"/"}${submitPath}`;
  const r = await fetch(submitURL, { method:"POST", headers: kieHeaders(), body: JSON.stringify(payload) });
  const t = await r.text(); let j={}; try{ j=JSON.parse(t);}catch{ j={raw:t}; }
  if (!r.ok) return { ok:false, status:r.status, error:j?.error||t||`KIE submit ${r.status}`, raw:j };

  const jid = j.taskId || j.task_id || j.id || j.job_id || j?.data?.taskId || j?.data?.id || j?.result?.taskId || null;
  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok:true, status:200, job_id:jid, video_url:urlNow, raw:j };
  if (!jid) return { ok:true, status:202, pending:true, job_id:null, raw:j };

  for (let i=0;i<5;i++){
    await sleep(i===0?3000:5000);
    for (const pat of KIE_RESULT_PATHS){
      const p = pat.trim().replace(":id", encodeURIComponent(jid));
      if (!p) continue;
      const url = `${KIE_API_PREFIX}${p.startsWith("/")?"":"/"}${p}`;
      try{
        const rr = await fetch(url, { headers: kieHeaders() });
        const tt = await rr.text(); let jj={}; try{ jj=JSON.parse(tt);}catch{ jj={raw:tt}; }
        if (rr.ok){
          const u = findVideoUrl(jj);
          if (u) return { ok:true, status:200, job_id:jid, video_url:u, raw:jj };
        }
      }catch{}
    }
  }
  return { ok:true, status:202, pending:true, job_id:jid, raw:j };
}

// ---------- Routes (root + /provider/:prov/* mirrors) ----------
app.get("/health", (_req, res) => {
  res.json({ ok:true, ts:new Date().toISOString(), defaultProvider: DEFAULT_PROVIDER });
});
app.get("/provider/:prov/health", (req, res) => {
  res.json({ ok:true, ts:new Date().toISOString(), provider: providerFrom(req) });
});

// submit (fast)
async function handleFast(req, res){
  try{
    const prov = providerFrom(req);
    const fn = prov === "fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
    const out = await fn(req.body||{}, VEO_MODEL_FAST);
    res.status(out.status||200).json({
      success: !!out.ok, provider: prov, job_id: out.job_id||null,
      pending: !!out.pending, video_url: out.video_url||null, meta: out.raw,
      error: out.ok ? undefined : out.error
    });
  }catch(e){ res.status(502).json({ success:false, error:e?.message||String(e) }); }
}
// submit (quality)
async function handleQuality(req, res){
  try{
    const prov = providerFrom(req);
    const fn = prov === "fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
    const out = await fn(req.body||{}, VEO_MODEL_QUALITY);
    res.status(out.status||200).json({
      success: !!out.ok, provider: prov, job_id: out.job_id||null,
      pending: !!out.pending, video_url: out.video_url||null, meta: out.raw,
      error: out.ok ? undefined : out.error
    });
  }catch(e){ res.status(502).json({ success:false, error:e?.message||String(e) }); }
}

// root
app.post(["/generate","/generate-fast"], handleFast);
app.post("/generate-quality", handleQuality);

// provider-prefixed
app.post(["/provider/:prov/generate","/provider/:prov/generate-fast"], handleFast);
app.post("/provider/:prov/generate-quality", handleQuality);

// result polling (root + provider)
async function handleResult(req, res){
  try{
    const prov = providerFrom(req);
    const id = req.params.jobId;
    if (prov === "fal"){
      if (!FAL_BASIC) return res.status(401).json({ success:false, error:"FAL auth missing" });
      const url = `${FAL_BASE}${FAL_RESULT_BASE}/${encodeURIComponent(id)}`;
      const r = await fetch(url,{ headers: falHeaders() });
      const t = await r.text(); let j={}; try{ j=JSON.parse(t);}catch{ j={raw:t}; }
      const video_url = findVideoUrl(j);
      return res.status(r.status).json({ success:r.ok, provider:prov, job_id:id, pending:!video_url, video_url, raw:j });
    } else {
      if (!KIE_KEY) return res.status(401).json({ success:false, error:"KIE auth missing" });
      for (const pat of KIE_RESULT_PATHS){
        const p = pat.trim().replace(":id", encodeURIComponent(id));
        const url = `${KIE_API_PREFIX}${p.startsWith("/")?"":"/"}${p}`;
        try{
          const r = await fetch(url,{ headers: kieHeaders() });
          const t = await r.text(); let j={}; try{ j=JSON.parse(t);}catch{ j={raw:t}; }
          if (r.ok){
            const video_url = findVideoUrl(j);
            if (video_url) return res.status(200).json({ success:true, provider:prov, job_id:id, pending:false, video_url, raw:j });
          }
        }catch{}
      }
      return res.status(202).json({ success:true, provider:prov, job_id:id, pending:true });
    }
  }catch(e){ res.status(502).json({ success:false, error:e?.message||String(e) }); }
}
app.get("/result/:jobId", handleResult);
app.get("/provider/:prov/result/:jobId", handleResult);

// ---------- ElevenLabs ----------
app.get("/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error:"ElevenLabs key missing" });
  try{
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers:{ "xi-api-key": ELEVEN_KEY } });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    const voices = (j.voices||[]).map(v=>({ id: v.voice_id||v.id, name: v.name, category: v.category||"" }));
    res.json({ voices });
  }catch(e){ res.status(502).json({ error:e?.message||String(e) }); }
});

// raw stream for preview
app.post("/eleven/tts.stream", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(401).send("Missing ElevenLabs key");
  const { voice_id, text, model_id, params } = req.body || {};
  if (!voice_id || !text) return res.status(400).send("voice_id and text required");
  try{
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?optimize_streaming_latency=0`;
    const payload = {
      text, model_id: model_id || "eleven_multilingual_v2",
      voice_settings: {
        stability: params?.stability ?? 0.45,
        similarity_boost: params?.similarity_boost ?? 0.8,
        style: params?.style ?? 0.0,
        use_speaker_boost: params?.use_speaker_boost ?? true
      }
    };
    const r = await fetch(url, {
      method:"POST",
      headers:{ "xi-api-key": ELEVEN_KEY, "Content-Type":"application/json", "Accept":"audio/mpeg" },
      body: JSON.stringify(payload)
    });
    res.status(r.status);
    r.body.pipeTo(new WritableStream({
      start(){ res.setHeader("Content-Type","audio/mpeg"); },
      write(c){ res.write(c); },
      close(){ res.end(); },
      abort(){ try{ res.end(); }catch{} }
    })).catch(()=>{ try{ res.end(); }catch{} });
  }catch{ res.status(502).end("TTS stream error"); }
});

// ---------- Mux (optional) ----------
app.post("/mux", async (req, res) => {
  if (!ENABLE_MUX) return res.status(403).json({ error:"Mux disabled. Set ENABLE_MUX=1." });
  const { video_url, audio_url } = req.body || {};
  if (!video_url || !audio_url) return res.status(400).json({ error:"video_url and audio_url required" });

  const vPath = path.join(TMP_ROOT, `v_${Date.now()}.mp4`);
  const aPath = path.join(TMP_ROOT, `a_${Date.now()}.mp3`);
  const outPath = path.join(MUX_DIR, `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
  try{
    const dl = async (u, fp) => { const r=await fetch(u); if(!r.ok) throw new Error(`Download ${r.status}`); const b=Buffer.from(await r.arrayBuffer()); await fs.writeFile(fp,b); };
    await dl(video_url, vPath); await dl(audio_url, aPath);
    const { spawn } = require("child_process");
    const args = ["-y","-i",vPath,"-i",aPath,"-c:v","copy","-c:a","aac","-shortest",outPath];
    const proc = spawn(FFMPEG_PATH, args);
    proc.on("error", err => res.status(500).json({ error:"FFmpeg spawn failed", detail:String(err) }));
    proc.on("close", async (code)=>{
      try{ await fs.rm(vPath,{force:true}); await fs.rm(aPath,{force:true}); }catch{}
      if (code!==0) return res.status(500).json({ error:`FFmpeg exit ${code}` });
      res.json({ merged_url: `/static/mux/${path.basename(outPath)}` });
    });
  }catch(e){ res.status(500).json({ error:e?.message||String(e) }); }
});

// Static & root
app.use("/static", express.static(STATIC_ROOT, { setHeaders: r=>r.setHeader("Cache-Control","public, max-age=31536000, immutable") }));
app.get("/", (_req, res) => res.status(404).send("OK"));

app.listen(PORT, () => {
  console.log(`[OK] backend listening on :${PORT}`);
  console.log(`[DEFAULT] provider: ${DEFAULT_PROVIDER}`);
  console.log(`[KIE] prefix: ${KIE_API_PREFIX}, fastPath: ${KIE_FAST_PATH}, qualityPath: ${KIE_QUALITY_PATH}, hasAuth: ${!!KIE_KEY}`);
  console.log(`[FAL] base: ${FAL_BASE}, submit: ${FAL_SUBMIT_PATH}, resultBase: ${FAL_RESULT_BASE}, hasAuth: ${!!FAL_BASIC}`);
  console.log(`[ElevenLabs] key present: ${!!ELEVEN_KEY}, mux: ${ENABLE_MUX}`);
});
