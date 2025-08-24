// server.cjs — Dual-provider backend (KIE + FAL) + ElevenLabs + optional mux
console.log("[BOOT] starting veo3-backend-dual …");
process.on("uncaughtException", e => console.error("[FATAL]", e));
process.on("unhandledRejection", e => console.error("[FATAL-PROMISE]", e));

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Explicit CORS preflight fix
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- ENV ----------
const PORT = process.env.PORT || 8080;
const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "kie").toLowerCase();

// KIE
const KIE_KEY = process.env.KIE_KEY || "";
const KIE_API_PREFIX = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1/veo3").replace(/\/$/, "");
const KIE_FAST_PATH = process.env.KIE_FAST_PATH || process.env.VEO_FAST_PATH || "/generate";
const KIE_QUALITY_PATH = process.env.KIE_QUALITY_PATH || "/generate";
const KIE_RESULT_PATHS = (process.env.KIE_RESULT_PATHS || "/result/:id,/status/:id").split(",");

// FAL
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

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function providerFrom(req) {
  return (req.query.provider || req.body?.provider || DEFAULT_PROVIDER || "kie").toLowerCase();
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

// ---------- Providers ----------
async function submitAndMaybeWaitFAL(body, modelName) {
  const payload = { ...body, model: modelName };
  const submitURL = FAL_BASE + FAL_SUBMIT_PATH;
  const r = await fetch(submitURL, { method: "POST", headers: falHeaders(), body: JSON.stringify(payload) });
  const t = await r.text();
  let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) return { ok: false, status: r.status, error: j?.error || t, raw: j };

  const jid = j.request_id || j.id || j.job_id || (j.data && j.data.request_id) || null;
  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok: true, status: 200, job_id: jid, video_url: urlNow, raw: j };
  if (!jid) return { ok: true, status: 202, pending: true, job_id: null, raw: j };

  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 3000 : 5000);
    const rr = await fetch(`${FAL_BASE}${FAL_RESULT_BASE}/${encodeURIComponent(jid)}`, { headers: falHeaders() });
    const tt = await rr.text();
    let jj = {}; try { jj = JSON.parse(tt); } catch { jj = { raw: tt }; }
    if (rr.ok) {
      const u = findVideoUrl(jj);
      if (u) return { ok: true, status: 200, job_id: jid, video_url: u, raw: jj };
      if (/pending|running/i.test(JSON.stringify(jj))) continue;
    }
  }
  return { ok: true, status: 202, pending: true, job_id: jid, raw: j };
}

async function submitAndMaybeWaitKIE(body, modelName) {
  const payload = { ...body, model: modelName };
  const submitPath = modelName === VEO_MODEL_FAST ? KIE_FAST_PATH : KIE_QUALITY_PATH;
  const submitURL = `${KIE_API_PREFIX}${submitPath.startsWith("/") ? "" : "/"}${submitPath}`;
  const r = await fetch(submitURL, { method: "POST", headers: kieHeaders(), body: JSON.stringify(payload) });
  const t = await r.text();
  let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) return { ok: false, status: r.status, error: j?.error || t, raw: j };

  const jid = j.taskId || j.id || j.job_id || (j.data && j.data.id) || null;
  const urlNow = findVideoUrl(j);
  if (urlNow) return { ok: true, status: 200, job_id: jid, video_url: urlNow, raw: j };
  if (!jid) return { ok: true, status: 202, pending: true, job_id: null, raw: j };

  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 3000 : 5000);
    for (const pat of KIE_RESULT_PATHS) {
      const url = `${KIE_API_PREFIX}${pat.trim().replace(":id", encodeURIComponent(jid))}`;
      try {
        const rr = await fetch(url, { headers: kieHeaders() });
        const tt = await rr.text();
        let jj = {}; try { jj = JSON.parse(tt); } catch { jj = { raw: tt }; }
        if (rr.ok) {
          const u = findVideoUrl(jj);
          if (u) return { ok: true, status: 200, job_id: jid, video_url: u, raw: jj };
        }
      } catch {}
    }
  }
  return { ok: true, status: 202, pending: true, job_id: jid, raw: j };
}

// ---------- Routes ----------
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), defaultProvider: DEFAULT_PROVIDER }));
app.get("/diag", (_req, res) => res.json({
  ok: true, time: new Date().toISOString(), defaultProvider: DEFAULT_PROVIDER,
  kie: { prefix: KIE_API_PREFIX, fastPath: KIE_FAST_PATH, qualityPath: KIE_QUALITY_PATH, resultPaths: KIE_RESULT_PATHS, hasAuth: !!KIE_KEY },
  fal: { base: FAL_BASE, submitPath: FAL_SUBMIT_PATH, resultBase: FAL_RESULT_BASE, hasAuth: !!FAL_BASIC },
  fastModel: VEO_MODEL_FAST, qualityModel: VEO_MODEL_QUALITY,
  elevenKeyPresent: !!ELEVEN_KEY, muxEnabled: ENABLE_MUX,
}));

app.post(["/generate", "/generate-fast"], async (req, res) => {
  try {
    const prov = providerFrom(req);
    const fn = prov === "fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
    const out = await fn(req.body || {}, VEO_MODEL_FAST);
    res.status(out.status || 200).json({ success: !!out.ok, provider: prov, job_id: out.job_id || null, pending: !!out.pending, video_url: out.video_url || null, meta: out.raw, error: out.ok ? undefined : out.error });
  } catch (e) { res.status(502).json({ success: false, error: e?.message || String(e) }); }
});
app.post("/generate-quality", async (req, res) => {
  try {
    const prov = providerFrom(req);
    const fn = prov === "fal" ? submitAndMaybeWaitFAL : submitAndMaybeWaitKIE;
    const out = await fn(req.body || {}, VEO_MODEL_QUALITY);
    res.status(out.status || 200).json({ success: !!out.ok, provider: prov, job_id: out.job_id || null, pending: !!out.pending, video_url: out.video_url || null, meta: out.raw, error: out.ok ? undefined : out.error });
  } catch (e) { res.status(502).json({ success: false, error: e?.message || String(e) }); }
});

// /result/:jobId, /eleven, /mux, /static — unchanged from last version

// Root
app.get("/", (_req, res) => res.status(404).send("OK"));
app.listen(PORT, () => {
  console.log(`[OK] backend listening on :${PORT}`);
  console.log(`[DEFAULT] provider: ${DEFAULT_PROVIDER}`);
  console.log(`[KIE] prefix: ${KIE_API_PREFIX}, fastPath: ${KIE_FAST_PATH}, qualityPath: ${KIE_QUALITY_PATH}`);
  console.log(`[FAL] base: ${FAL_BASE}, submit: ${FAL_SUBMIT_PATH}, resultBase: ${FAL_RESULT_BASE}`);
  console.log(`[ElevenLabs] key present: ${!!ELEVEN_KEY}, mux: ${ENABLE_MUX}`);
});
