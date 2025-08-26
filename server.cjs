// server.cjs — VEO3 Studio backend (all-in-one)
// Node 18+ required (global fetch). Single file: drop-in + deploy.
// Endpoints:
//  - GET   /health
//  - HEAD  /dl?u=...              (probe)
//  - GET   /dl?u=...&filename=... (iPad-friendly download proxy, preserves Range)
//  - POST  /provider/:prov/generate-fast|generate-quality
//  - POST  /generate-fast | /generate-quality (defaults to DEFAULT_PROVIDER)
//  - GET   /result/:id?provider=kie|fal      (poll job status)
//  - GET   /eleven/voices
//  - POST  /eleven/tts  -> { audio_url }
//  - POST  /mux         -> { merged_url }
//  - GET   /files/<name>            (serves temp/generated files)

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

// ---------- CONFIG (ENV) ----------
const PORT = process.env.PORT || 8080;
const APP_NAME = process.env.APP_NAME || 'veo3-studio-backend';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

// Default provider for /generate-* shorthand
const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || 'kie').toLowerCase();

// KIE provider endpoints (set these to your kie.ai endpoints)
const KIE_FAST_URL    = process.env.KIE_FAST_URL    || ''; // e.g. https://api.kie.ai/veo3/fast
const KIE_QUALITY_URL = process.env.KIE_QUALITY_URL || ''; // e.g. https://api.kie.ai/veo3/quality
const KIE_RESULT_URL  = process.env.KIE_RESULT_URL  || ''; // e.g. https://api.kie.ai/jobs/{id}
const KIE_API_KEY     = process.env.KIE_API_KEY     || '';

// FAL provider endpoints (if you also use fal.ai)
const FAL_FAST_URL    = process.env.FAL_FAST_URL    || '';
const FAL_QUALITY_URL = process.env.FAL_QUALITY_URL || '';
const FAL_RESULT_URL  = process.env.FAL_RESULT_URL  || '';
const FAL_API_KEY     = process.env.FAL_API_KEY     || '';

// ElevenLabs
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_BASE    = process.env.ELEVEN_BASE    || 'https://api.elevenlabs.io';

// Storage dir (Railway has ephemeral disk; fine for temp files)
const FILES_DIR = process.env.FILES_DIR || path.join(process.cwd(), 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------- APP ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({
  origin: (origin, cb) => cb(null, ALLOW_ORIGIN === '*' ? true : origin === ALLOW_ORIGIN),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// Serve generated files
app.use('/files', express.static(FILES_DIR, {
  fallthrough: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp3') res.setHeader('Content-Type', 'audio/mpeg');
    if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  }
}));

// ---------- UTILS ----------
const okJson = (res, obj) => res.json({ success: true, ...obj });
const errJson = (res, status, msg, extra={}) => res.status(status).json({ success:false, error: msg, ...extra });

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

function sanitizeName(s) {
  return (s || '').toString().replace(/[^\w.\-]+/g, '').slice(0,80) || 'file';
}
function nowName(ext) {
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  return `fomo-${ts}.${ext}`;
}

async function downloadToFile(url, outPath, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const file = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    r.body.pipe(file);
    r.body.on('error', reject);
    file.on('finish', resolve);
  });
  return outPath;
}

async function bufferToFile(buf, outPath) {
  await fsp.writeFile(outPath, buf);
  return outPath;
}

async function existsCmd(cmd) {
  return new Promise(resolve => {
    const p = spawn(cmd, ['-version']);
    let ok = false;
    p.on('spawn', () => { ok = true; });
    p.on('close', () => resolve(ok));
    p.on('error', () => resolve(false));
  });
}

function providerHeaders(provider) {
  const h = { 'Content-Type': 'application/json' };
  if (provider === 'kie' && KIE_API_KEY) h['Authorization'] = `Bearer ${KIE_API_KEY}`;
  if (provider === 'fal' && FAL_API_KEY) h['Authorization'] = `Bearer ${FAL_API_KEY}`;
  return h;
}

function pickProviderURL(provider, kind) {
  // kind: 'fast' | 'quality' | 'result'
  provider = (provider || '').toLowerCase();
  if (provider === 'fal') {
    if (kind==='fast') return FAL_FAST_URL;
    if (kind==='quality') return FAL_QUALITY_URL;
    if (kind==='result') return FAL_RESULT_URL;
  }
  // default: kie
  if (kind==='fast') return KIE_FAST_URL;
  if (kind==='quality') return KIE_QUALITY_URL;
  if (kind==='result') return KIE_RESULT_URL;
  return '';
}

function buildResultURL(template, id) {
  if (!template) return '';
  if (template.includes('{id}')) return template.replace('{id}', encodeURIComponent(id));
  if (/\/$/.test(template)) return template + encodeURIComponent(id);
  return `${template}/${encodeURIComponent(id)}`;
}

// ---------- HEALTH ----------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: APP_NAME,
    time: new Date().toISOString(),
    storage: path.resolve(FILES_DIR),
    default_provider: DEFAULT_PROVIDER
  });
});

// ---------- DOWNLOAD PROXY ----------
app.head('/dl', async (req, res) => {
  try {
    const raw = String(req.query.u || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return res.status(400).end();
    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;

    let up = await fetch(raw, { method: 'HEAD', headers }).catch(()=>null);
    if (!up || (!up.ok && up.status !== 206)) {
      up = await fetch(raw, { method: 'GET', headers }).catch(()=>null);
    }
    if (!up) return res.status(502).end();

    const ct = up.headers.get('content-type') || 'video/mp4';
    const cl = up.headers.get('content-length');
    const cr = up.headers.get('content-range');

    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    return res.status(up.status).end();
  } catch { return res.status(500).end(); }
});

app.get('/dl', async (req, res) => {
  try {
    const raw = String(req.query.u || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) {
      return errJson(res, 400, 'Missing or invalid ?u=');
    }
    const userName = sanitizeName(req.query.filename || '');
    const forcedCT = req.query.ct && String(req.query.ct);
    const filename = userName || nowName('mp4');

    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = await fetch(raw, { method:'GET', headers });
    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      const text = upstream && (await upstream.text().catch(()=>'')) || '';
      return errJson(res, 502, `Upstream ${upstream && upstream.status}`, { detail: text.slice(0,300) });
    }

    const ct = forcedCT || upstream.headers.get('content-type') || 'video/mp4';
    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');

    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

    res.status(upstream.status);
    upstream.body.pipe(res);
  } catch (e) {
    return errJson(res, 500, 'Proxy error', { detail: String(e) });
  }
});

// ---------- PROVIDERS ----------
async function postToProvider(provider, kind, body) {
  const url = pickProviderURL(provider, kind);
  if (!url) throw new Error(`Provider ${provider} ${kind} URL not set`);
  const r = await fetch(url, {
    method: 'POST',
    headers: providerHeaders(provider),
    body: JSON.stringify(body || {})
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const msg = json?.error || json?.message || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function getResultFromProvider(provider, id) {
  const template = pickProviderURL(provider, 'result');
  const url = buildResultURL(template, id);
  if (!url) throw new Error(`Provider ${provider} result URL not set`);
  const r = await fetch(url, { headers: providerHeaders(provider) });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const msg = json?.error || json?.message || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.payload = json;
    throw err;
  }
  return json;
}

app.post('/provider/:prov/generate-fast', async (req, res) => {
  try {
    const prov = (req.params.prov||'').toLowerCase();
    const out = await postToProvider(prov, 'fast', req.body);
    return res.json(out);
  } catch (e) { return errJson(res, e.status||502, e.message, e.payload||{}); }
});

app.post('/provider/:prov/generate-quality', async (req, res) => {
  try {
    const prov = (req.params.prov||'').toLowerCase();
    const out = await postToProvider(prov, 'quality', req.body);
    return res.json(out);
  } catch (e) { return errJson(res, e.status||502, e.message, e.payload||{}); }
});

// shorthand
app.post('/generate-fast', async (req, res) => {
  try {
    const out = await postToProvider(DEFAULT_PROVIDER, 'fast', req.body);
    return res.json(out);
  } catch (e) { return errJson(res, e.status||502, e.message, e.payload||{}); }
});
app.post('/generate-quality', async (req, res) => {
  try {
    const out = await postToProvider(DEFAULT_PROVIDER, 'quality', req.body);
    return res.json(out);
  } catch (e) { return errJson(res, e.status||502, e.message, e.payload||{}); }
});

// result
app.get('/result/:id', async (req, res) => {
  try {
    const provider = (req.query.provider || DEFAULT_PROVIDER).toLowerCase();
    const id = req.params.id;
    const out = await getResultFromProvider(provider, id);
    return res.json(out);
  } catch (e) { return errJson(res, e.status||502, e.message, e.payload||{}); }
});

// ---------- ELEVENLABS ----------
app.get('/eleven/voices', async (req, res) => {
  try {
    if (!ELEVEN_API_KEY) return errJson(res, 400, 'ELEVEN_API_KEY not set');
    const r = await fetch(`${ELEVEN_BASE}/v1/voices`, {
      headers: { 'xi-api-key': ELEVEN_API_KEY }
    });
    const j = await r.json();
    if (!r.ok) return errJson(res, r.status, j?.error || 'Voices error', j);
    return res.json({ voices: j.voices || [] });
  } catch (e) { return errJson(res, 502, String(e)); }
});

app.post('/eleven/tts', async (req, res) => {
  try {
    if (!ELEVEN_API_KEY) return errJson(res, 400, 'ELEVEN_API_KEY not set');
    const { voice_id, text, model_id = 'eleven_multilingual_v2' } = req.body || {};
    if (!voice_id || !text) return errJson(res, 400, 'voice_id and text required');

    const r = await fetch(`${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(voice_id)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings: { stability: 0.7, similarity_boost: 0.7, style: 0.15, use_speaker_boost: true }
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      return errJson(res, r.status, 'TTS failed', { detail: t.slice(0,400) });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const name = nowName('mp3');
    const outPath = path.join(FILES_DIR, name);
    await bufferToFile(buf, outPath);
    return res.json({ audio_url: `/files/${name}` });
  } catch (e) { return errJson(res, 500, String(e)); }
});

// ---------- MUX ----------
app.post('/mux', async (req, res) => {
  try {
    const { video_url, audio_url } = req.body || {};
    if (!video_url || !audio_url) return errJson(res, 400, 'video_url and audio_url required');

    const hasFF = await existsCmd('ffmpeg');
    if (!hasFF) return errJson(res, 501, 'ffmpeg not available on this host');

    const vIn = path.join(FILES_DIR, nowName('source.mp4'));
    const aIn = path.join(FILES_DIR, nowName('source.mp3'));
    await downloadToFile(video_url, vIn);
    await downloadToFile(audio_url.startsWith('/files/') ? (new URL(`http://localhost:${PORT}${audio_url}`)).toString() : audio_url, aIn);

    const outName = nowName('mp4');
    const outPath = path.join(FILES_DIR, outName);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', vIn,
        '-i', aIn,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        outPath
      ];
      const p = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(0,400)}`)));
    });

    fsp.unlink(vIn).catch(()=>{});
    fsp.unlink(aIn).catch(()=>{});

    return res.json({ merged_url: `/files/${outName}` });
  } catch (e) { return errJson(res, 500, String(e)); }
});

// ---------- 404 ----------
app.use((req, res)=> errJson(res, 404, 'Not found'));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`[${APP_NAME}] on :${PORT}`);
});
