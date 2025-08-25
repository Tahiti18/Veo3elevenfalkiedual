// server.cjs — Dual-provider backend (KIE + FAL) + ElevenLabs + optional mux + robust DL
// Node 18+, CommonJS
console.log("[BOOT] starting veo3-backend-dual …");
process.on("uncaughtException", e => console.error("[FATAL]", e));
process.on("unhandledRejection", e => console.error("[FATAL-PROMISE]", e));

const express = require("express");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- CORS (explicit preflight 204) ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Range");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- ENV ----------
const PORT = process.env.PORT || 8080;
const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "kie").toLowerCase(); // "kie" | "fal"

// Proxy/download safety & behavior
const MAX_PROXY_BYTES = Number(process.env.MAX_PROXY_BYTES || 1024 * 1024 * 1024); // 1GB cap
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 120000); // 120s
const ENABLE_DL_CACHE = String(process.env.ENABLE_DL_CACHE || "") === "1";

// ----- KIE -----
const KIE_KEY = process.env.KIE_KEY || "";
let KIE_API_PREFIX = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1/veo").replace(/\/$/, "");
KIE_API_PREFIX = KIE_API_PREFIX.replace(/\/veo3(\/|$)/, "/veo$1"); // normalize if someone put /veo3
const KIE_FAST_PATH = process.env.KIE_FAST_PATH || "/generate";
const KIE_QUALITY_PATH = process.env.KIE_QUALITY_PATH || "/generate";
const KIE_RESULT_PATHS = (process.env.KIE_RESULT_PATHS || "/record-info?taskId=:id").split(",");
const KIE_HD_PATH = process.env.KIE_HD_PATH || "/get-1080p-video?taskId=:id";

// ----- FAL -----
const FAL_KEY_ID = process.env.FAL_KEY_ID || "";
const FAL_KEY_SECRET = process.env.FAL_KEY_SECRET || "";
const FAL_KEY = process.env.FAL_KEY || ""; // optional "id:secret"
let FAL_BASIC = "";
if (FAL_KEY_ID && FAL_KEY_SECRET) FAL_BASIC = Buffer.from(`${FAL_KEY_ID}:${FAL_KEY_SECRET}`).toString("base64");
else if (FAL_KEY.includes(":")) FAL_BASIC = Buffer.from(FAL_KEY).toString("base64");

const FAL_BASE = (process.env.FAL_API_BASE || "https://api.fal.ai").replace(/\/$/, "");
const FAL_SUBMIT_PATH = process.env.FAL_SUBMIT_PATH || "/v1/pipelines/google/veo/submit";
const FAL_RESULT_BASE = (process.env.FAL_RESULT_BASE || "/v1/pipelines/google/veo/requests").replace(/\/$/, "");

// Models (docs)
const VEO_MODEL_FAST = process.env.VEO_MODEL_FAST || "veo3_fast";
const VEO_MODEL_QUALITY = process.env.VEO_MODEL_QUALITY || "veo3";

// ----- ElevenLabs -----
const ELEVEN_KEY =
  process.env.ELEVEN_LABS ||
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_LABS_API_KEY ||
  process.env["11_Labs"] || "";

// ----- Optional mux -----
const ENABLE_MUX = String(process.env.ENABLE_MUX || "") === "1";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

// Writable static
const TMP_ROOT = "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR = path.join(STATIC_ROOT, "tts");
const MUX_DIR = path.join(STATIC_ROOT, "mux");
const VID_DIR = path.join(STATIC_ROOT, "vid"); // optional cache for downloads

(async () => {
  try {
    await fs.mkdir(TTS_DIR, { recursive: true });
    await fs.mkdir(MUX_DIR, { recursive: true });
    await fs.mkdir(VID_DIR, { recursive: true });
  } catch {}
})();

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// Host allowlist for redirects/downloads
const ALLOWED_HOSTS = new Set([
  "r2.cloudflarestorage.com",
  "s3.amazonaws.com",
  "storage.googleapis.com",
  "cdn.runwayml.com",
  "runwayml.com",
  "files.kie.ai",
  "cdn.kie.ai",
  "tempfile.aiquickdraw.com"
]);
function isAllowedHost(u) {
  try { return ALLOWED_HOSTS.has(new URL(u).host); } catch { return false; }
}

// Extract first playable URL from a messy payload
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

        // KIE specific: data.resultUrls string or array
        if (v.data) {
          const ru = v.data.resultUrls || v.data.resultUrl || v.data.videoUrl;
          if (typeof ru === "string") {
            try {
              const arr = JSON.parse(ru);
              if (Array.isArray(arr) && arr.length && typeof arr[0] === "string") return arr[0];
              if (/https?:\/\//.test(ru)) return ru;
            } catch {
              if (/https?:\/\//.test(ru)) return ru;
            }
          } else if (Array.isArray(ru) && ru.length && typeof ru[0] === "string") {
            return ru[0];
          }
        }
        for (const k of Object.keys(v)) stack.push(v[k]);
      }
    }
  } catch {}
  return null;
}

// Small in-memory cache of jobId -> video_url (helps the frontend auto-show in history)
const cache = new Map();
async function backgroundPollKIE(taskId) {
  if (!taskId) return;
  // Try up to ~60–70s
  for (let i = 0; i < 8; i++) {
    await sleep(i === 0 ? 4000 : 8000);
    for (const pat of KIE_RESULT_PATHS) {
      const p = pat.trim();
      if (!p) continue;
      const url = `${KIE_API_PREFIX}${p.startsWith("/") ? "" : "/"}${p.replace(":id", encodeURIComponent(taskId))}`;
      try {
        const rr = await fetch(url, { headers: kieHeaders() });
        const tt = await rr.text();
        let jj = {};
        try { jj = JSON.parse(tt); } catch { jj = { raw: tt }; }
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
  const submitURL = FAL_BASE + FAL_SUBMIT_PATH;

  const r = await fetch(submitURL, { method: "POST", headers: falHeaders(), body: JSON.stringify(payload) });
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) return { ok: false, status: r.status, error: j?.error || t || `FAL submit ${r.status}`, raw: j };

  const jid = j.request_id || j.id || j.job_id || (j.data && (j.data.request_id || j.data.id)) || null;
  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok: true, status: 200, job_id: jid, video_url: urlNow, raw: j };
  if (!jid) return { ok: true, status: 202, pending: true, job_id: null, raw: j };

  const resultBase = FAL_BASE + FAL_RESULT_BASE;
  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 3000 : 5000);
    const rr = await fetch(`${resultBase}/${encodeURIComponent(jid)}`, { headers: falHeaders() });
    const tt = await rr.text();
    let jj = {};
    try { jj = JSON.parse(tt); } catch { jj = { raw: tt }; }
    if (rr.ok) {
      const u = findVideoUrl(jj);
      if (u) return { ok: true, status: 200, job_id: jid, video_url: u, raw: jj };
      if (/pending|running|processing/i.test(JSON.stringify(jj))) continue;
    }
  }
  return { ok: true, status: 202, pending: true, job_id: jid, raw: j };
}

async function submitAndMaybeWaitKIE(body, modelName) {
  const payload = { ...body, model: modelName }; // model must be "veo3" or "veo3_fast"
  const submitPath = modelName === VEO_MODEL_FAST ? KIE_FAST_PATH : KIE_QUALITY_PATH;
  const submitURL = `${KIE_API_PREFIX}${submitPath.startsWith("/") ? "" : "/"}${submitPath}`;

  const r = await fetch(submitURL, { method: "POST", headers: kieHeaders(), body: JSON.stringify(payload) });
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) return { ok: false, status: r.status, error: j?.msg || j?.error || t || `KIE submit ${r.status}`, raw: j };

  // success shape: { code:200, data:{ taskId: "..." }, msg:"success" }
  const jid =
    j.taskId || j.task_id || j.id || j.job_id ||
    (j.data && (j.data.taskId || j.data.task_id || j.data.id)) ||
    (j.result && (j.result.taskId || j.result.id)) ||
    null;

  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok: true, status: 200, job_id: jid, video_url: urlNow, raw: j };
  if (!jid) return { ok: true, status: 202, pending: true, job_id: null, raw: j };

  backgroundPollKIE(jid).catch(()=>{});
  return { ok: true, status: 202, pending: true, job_id: jid, raw: j };
}

// ---------- ROUTES ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    provider: DEFAULT_PROVIDER,
    elevenKeyPresent: !!ELEVEN_KEY,
    muxEnabled: ENABLE_MUX
  });
});

app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    defaultProvider: DEFAULT_PROVIDER,
    kie: {
      prefix: KIE_API_PREFIX,
      fastPath: KIE_FAST_PATH,
      qualityPath: KIE_QUALITY_PATH,
      resultPaths: KIE_RESULT_PATHS,
      hasAuth: !!KIE_KEY,
    },
    fal: {
      base: FAL_BASE,
      submitPath: FAL_SUBMIT_PATH,
      resultBase: FAL_RESULT_BASE,
      hasAuth: !!FAL_BASIC,
    },
    fastModel: VEO_MODEL_FAST,
    qualityModel: VEO_MODEL_QUALITY,
    elevenKeyPresent: !!ELEVEN_KEY,
    muxEnabled: ENABLE_MUX,
  });
});

// Generate — fast
app.post(["/generate", "/generate-fast"], async (req, res) => {
  try {
    const prov = providerFrom(req);
    const body = req.body || {};
    const fn = prov === "fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
    const out = await fn(body, VEO_MODEL_FAST);
    res.status(out.status || 200).json({
      success: !!out.ok,
      provider: prov,
      job_id: out.job_id || null,
      pending: !!out.pending,
      video_url: out.video_url || (out.job_id ? (cache.get(out.job_id) || null) : null),
      meta: out.raw,
      error: out.ok ? undefined : out.error,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e?.message || String(e) });
  }
});

// Generate — quality
app.post("/generate-quality", async (req, res) => {
  try {
    const prov = providerFrom(req);
    const body = req.body || {};
    const fn = prov === "fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
    const out = await fn(body, VEO_MODEL_QUALITY);
    res.status(out.status || 200).json({
      success: !!out.ok,
      provider: prov,
      job_id: out.job_id || null,
      pending: !!out.pending,
      video_url: out.video_url || (out.job_id ? (cache.get(out.job_id) || null) : null),
      meta: out.raw,
      error: out.ok ? undefined : out.error,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e?.message || String(e) });
  }
});

// Poll
app.get("/result/:jobId", async (req, res) => {
  try {
    const prov = providerFrom(req);
    const id = req.params.jobId;

    // serve from cache if present
    const cached = cache.get(id);
    if (cached) return res.status(200).json({ success: true, provider: prov, job_id: id, pending: false, video_url: cached });

    if (prov === "fal") {
      if (!FAL_BASIC) return res.status(401).json({ success: false, error: "FAL auth missing" });
      const url = `${FAL_BASE}${FAL_RESULT_BASE}/${encodeURIComponent(id)}`;
      const r = await fetch(url, { headers: falHeaders() });
      const t = await r.text();
      let j = {};
      try { j = JSON.parse(t); } catch { j = { raw: t }; }
      const video_url = findVideoUrl(j);
      if (video_url) cache.set(id, video_url);
      return res.status(r.status).json({ success: r.ok, provider: prov, job_id: id, pending: !video_url, video_url, raw: j });
    } else {
      if (!KIE_KEY) return res.status(401).json({ success: false, error: "KIE auth missing" });
      for (const pat of KIE_RESULT_PATHS) {
        const p = pat.trim().replace(":id", encodeURIComponent(id));
        const url = `${KIE_API_PREFIX}${p.startsWith("/") ? "" : "/"}${p}`;
        try {
          const r = await fetch(url, { headers: kieHeaders() });
          const t = await r.text();
          let j = {};
          try { j = JSON.parse(t); } catch { j = { raw: t }; }
          if (r.ok) {
            const video_url = findVideoUrl(j) || (j.data && (j.data.videoUrl || j.data.url));
            if (video_url) { cache.set(id, video_url); return res.status(200).json({ success: true, provider: prov, job_id: id, pending: false, video_url, raw: j }); }
          }
        } catch {}
      }
      return res.status(202).json({ success: true, provider: prov, job_id: id, pending: true });
    }
  } catch (e) {
    res.status(502).json({ success: false, error: e?.message || String(e) });
  }
});

// ---------- Download helpers (streaming, Range, optional cache) ----------
async function proxyStreamToClient(req, res, fileUrl, opts = {}) {
  const { attachmentName = null, passRange = true, cacheId = null } = opts;
  if (!isAllowedHost(fileUrl)) return res.status(400).json({ error: "disallowed_host", host: new URL(fileUrl).host });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  const headers = {};
  if (passRange && req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(fileUrl, { method: "GET", headers, signal: controller.signal });
  } catch (e) {
    clearTimeout(t);
    return res.status(504).json({ error: "upstream_timeout_or_network", detail: String(e) });
  }
  clearTimeout(t);

  if (!upstream.ok && upstream.status !== 206) {
    const text = await upstream.text().catch(()=> "");
    return res.status(upstream.status || 502).json({ error: "upstream_error", detail: text.slice(0, 500) });
  }

  // Pass through content type & length if present
  const ct = upstream.headers.get("content-type") || "video/mp4";
  const cl = upstream.headers.get("content-length");
  const acceptRanges = upstream.headers.get("accept-ranges");
  const status = upstream.status || 200;

  res.status(status);
  res.setHeader("Content-Type", ct);
  if (cl) res.setHeader("Content-Length", cl);
  if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);

  if (attachmentName) {
    const safe = attachmentName.replace(/[^a-z0-9_\-\.]/gi, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  }

  // Optional local cache (full file only, no partial writes)
  if (ENABLE_DL_CACHE && cacheId && !req.headers.range) {
    const outPath = path.join(VID_DIR, `${cacheId}.mp4`);
    // If already cached, serve from disk
    if (fssync.existsSync(outPath)) {
      const stat = fssync.statSync(outPath);
      res.setHeader("Content-Length", stat.size);
      return fssync.createReadStream(outPath).pipe(res);
    }
    // Cache as we stream (with size guard)
    let written = 0;
    const file = fssync.createWriteStream(outPath);
    upstream.body.on("data", chunk => {
      written += chunk.length;
      if (written > MAX_PROXY_BYTES) {
        try { file.destroy(); fssync.rmSync(outPath, { force: true }); } catch {}
        res.destroy(new Error("max_proxy_bytes_exceeded"));
        upstream.body.destroy();
      }
    });
    upstream.body.on("error", () => {
      try { file.destroy(); fssync.rmSync(outPath, { force: true }); } catch {}
    });
    upstream.body.on("end", () => {
      try { file.end(); } catch {}
    });
    // Pipe both to client and file
    upstream.body.pipe(file);
    return upstream.body.pipe(res);
  }

  // No caching: just stream to client (with size guard)
  let sent = 0;
  upstream.body.on("data", chunk => {
    sent += chunk.length;
    if (sent > MAX_PROXY_BYTES) {
      res.destroy(new Error("max_proxy_bytes_exceeded"));
      upstream.body.destroy();
    }
  });
  return upstream.body.pipe(res);
}

// Nightly cache cleanup (best-effort)
if (ENABLE_DL_CACHE) {
  setInterval(async () => {
    try {
      const now = Date.now();
      const files = await fs.readdir(VID_DIR);
      for (const f of files) {
        const fp = path.join(VID_DIR, f);
        const st = await fs.stat(fp);
        if (now - st.mtimeMs > 24 * 3600 * 1000) {
          await fs.rm(fp, { force: true });
        }
      }
    } catch {}
  }, 6 * 3600 * 1000); // every 6h
}

// ---------- DOWNLOAD ROUTES ----------
// 1) Clean redirect by job id: GET /dl/:jobId  -> preview 302, or forced download ?download=1
app.get("/dl/:jobId", async (req, res) => {
  try {
    const id = req.params.jobId;

    // Try cache map first
    let file = cache.get(id);
    if (!file) {
      // Resolve via our own /result
      const base = `${req.protocol}://${req.get("host")}`;
      const r = await fetch(`${base}/result/${encodeURIComponent(id)}?provider=${encodeURIComponent(providerFrom(req))}`);
      const j = await r.json().catch(()=> ({}));
      file = j?.video_url || null;
    }

    if (!file) return res.status(409).json({ error: "not_ready", id });

    const forceDownload = String(req.query.download || "") === "1";
    if (!forceDownload) {
      if (!isAllowedHost(file)) return res.status(400).json({ error: "disallowed_host", host: new URL(file).host });
      return res.redirect(302, file);
    }

    // Forced download with Range support + (optional) cache
    return proxyStreamToClient(req, res, file, {
      attachmentName: `${id}.mp4`,
      passRange: true,
      cacheId: id
    });
  } catch (err) {
    console.error("DL route error:", err?.message || err);
    return res.status(500).json({ error: "server_error" });
  }
});

// 2) Simple passthrough: GET /dl?u=<encoded url> -> preview 302 or forced download with ?download=1
app.get("/dl", async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).json({ error: "missing_u" });
    if (!isAllowedHost(u)) return res.status(400).json({ error: "disallowed_host", host: new URL(u).host });

    const forceDownload = String(req.query.download || "") === "1";
    if (!forceDownload) return res.redirect(302, u);

    const name = req.query.name ? String(req.query.name) : `video_${Date.now()}.mp4`;
    return proxyStreamToClient(req, res, u, {
      attachmentName: name,
      passRange: true,
      cacheId: null
    });
  } catch {
    return res.status(400).json({ error: "bad_url" });
  }
});

// --- /api/* aliases so frontends calling /api/... also work ---
app.get("/api/result/:jobId", (req,res,next)=>{ req.url=`/result/${req.params.jobId}`; app._router.handle(req,res,next); });
app.get("/api/dl/:jobId", (req,res,next)=>{ req.url=`/dl/${req.params.jobId}`; app._router.handle(req,res,next); });
app.get("/api/dl", (req,res,next)=>{ req.url="/dl"; app._router.handle(req,res,next); });

// ---------- ElevenLabs ----------
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

// --- Alias so frontend /eleven/tts.stream also works ---
app.post("/eleven/tts.stream", (req, res, next) => {
  req.url = "/eleven/tts";
  app._router.handle(req, res, next);
});

// --- /api/* aliases so frontend calling /api/eleven/* also works ---
app.get("/api/eleven/voices", (req,res,next)=>{ req.url="/eleven/voices"; app._router.handle(req,res,next); });
app.post("/api/eleven/tts", (req,res,next)=>{ req.url="/eleven/tts"; app._router.handle(req,res,next); });
app.post("/api/eleven/tts.stream", (req,res,next)=>{ req.url="/eleven/tts.stream"; app._router.handle(req,res,next); });

// ---------- Mux ----------
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

// Static
app.use("/static", express.static(STATIC_ROOT, {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
}));

// Root catch
app.get("/", (_req, res) => res.status(404).send("OK"));

app.listen(PORT, () => {
  console.log(`[OK] backend listening on :${PORT}`);
  console.log(`[DEFAULT] provider: ${DEFAULT_PROVIDER}`);
  console.log(`[KIE] prefix: ${KIE_API_PREFIX}, fastPath: ${KIE_FAST_PATH}, qualityPath: ${KIE_QUALITY_PATH}, hasAuth: ${!!KIE_KEY}`);
  console.log(`[FAL] base: ${FAL_BASE}, submit: ${FAL_SUBMIT_PATH}, resultBase: ${FAL_RESULT_BASE}, hasAuth: ${!!FAL_BASIC}`);
  console.log(`[ElevenLabs] key present: ${!!ELEVEN_KEY}, mux: ${ENABLE_MUX}`);
});
