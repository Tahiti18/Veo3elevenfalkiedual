<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Unity Lab AI — VEO3 Studio</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
  <style>
    :root{ --bg:#0b1118; --panel:#0f1621; --raised:#121b27; --ink:#e8ecf1; --muted:#9aa6b2; --line:#1e2a3a; --accent:#5aa2ff; --accent-2:#8b5cf6; --brand:#d84fd6; --ok:#23c383; --warn:#f2a356; --err:#ef6b6b; --radius:14px; --shadow:0 10px 30px rgba(0,0,0,.35);}
    *{box-sizing:border-box;margin:0;padding:0} html,body{height:100%}
    body{background:radial-gradient(1000px 600px at -10% -10%, #122031 0%, transparent 60%) no-repeat, radial-gradient(1200px 700px at 110% -20%, #141f2c 0%, transparent 60%) no-repeat, var(--bg); color:var(--ink); font-family:"Playfair Display",serif; line-height:1.45;}
    .appbar{position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:rgba(13,18,27,.85); border-bottom:1px solid var(--line); backdrop-filter: blur(14px); gap:12px;}
    .brand{display:flex; align-items:center; gap:12px;} .brand img{height:34px; width:auto;} .title{font-size:20px; font-weight:700;}
    .status{display:flex;align-items:center;gap:8px;font-family:"Inter",sans-serif;} .dot{width:10px;height:10px;border-radius:50%}
    .dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)} .dot.err{background:var(--err)} .status span:last-child{color:var(--muted);font-size:12px}
    .bar-right{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
    .input.small{height:34px;padding:6px 8px;font-size:12px}
    .btnbar .btn{height:34px}
    .wrap{max-width:1400px;margin:18px auto;padding:0 16px;display:grid;grid-template-columns:380px 1fr 320px;gap:16px}
    .panel{background:linear-gradient(180deg, rgba(255,255,255,.02), transparent 40%), var(--panel); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:16px}
    .panel h2{font-size:20px;margin-bottom:12px;font-weight:700;color:#eaf1ff;display:flex;justify-content:space-between;align-items:center}
    .hint{color:var(--muted); font-size:12px; font-family:"Inter",sans-serif;}
    .field{margin-bottom:14px;} label{display:block; font-size:15px; font-weight:600; margin-bottom:6px; color:#dfe7f5}
    textarea.input, input.input, select.input{width:100%; background:var(--raised); color:var(--ink); border:1px solid var(--line); border-radius:10px; outline:none; padding:12px 12px; font-size:14px; font-family:"Inter",sans-serif;}
    textarea.input{min-height:110px; resize:vertical;} .row{display:grid; gap:10px} .row2{grid-template-columns:1fr 1fr} .row3{grid-template-columns:1fr 1fr 1fr}
    .seg{display:flex; gap:8px}
    .seg-radio{display:inline-flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--raised); cursor:pointer; user-select:none; transition:.18s ease; font-weight:600;}
    .seg-radio input{appearance:none; width:0; height:0; position:absolute; pointer-events:none;}
    .seg-radio:has(input:checked){background: linear-gradient(135deg, rgba(216,79,214,.15), rgba(90,162,255,.18)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand), #2b3a50 40%);}
    .toggle{display:flex; align-items:center; gap:8px} .switch{width:42px;height:24px;background:#243245;border-radius:999px;position:relative;border:1px solid var(--line);cursor:pointer}
    .switch input{display:none} .knob{position:absolute; top:2px; left:2px; width:20px; height:20px; background:#cfd7e2; border-radius:50%; transition:.18s}
    .switch input:checked + .knob{left:20px;background:#fff}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:10px 12px;border-radius:12px;cursor:pointer;font-weight:700;user-select:none;font-family:"Inter",sans-serif}
    .btn.primary{width:100%; color:#0d1020; background: linear-gradient(135deg, color-mix(in srgb, var(--brand), white 12%), var(--brand)); border:1px solid color-mix(in srgb, var(--brand), black 25%); box-shadow: 0 10px 22px rgba(216,79,214,.25);}
    .btn.ghost{border:1px solid var(--line); background:transparent; color:#eaf1ff}
    .btn.small{padding:6px 8px; font-size:12px}
    .preview-area{ position:relative; overflow:hidden; border-radius:12px; border:1px solid var(--line); background:#000; }
    video.player{ width:100%; height:auto; display:none; }
    .placeholder{ display:flex; align-items:center; justify-content:center; color:var(--muted); min-height:380px; font-family:"Inter",sans-serif; }
    .overlay{ position:absolute; inset:0; display:none; align-items:center; justify-content:center; background:rgba(7,10,16,.55); backdrop-filter: blur(4px); }
    .spinner{ width:46px;height:46px;border:4px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%; animation:spin 1s linear infinite; } @keyframes spin{ to{ transform: rotate(360deg); } }
    .history-list{ display:grid; gap:10px; grid-auto-rows:minmax(90px,auto); }
    .thumb{ display:flex; gap:10px; padding:8px; border:1px solid var(--line); border-radius:10px; background:var(--raised); }
    .thumb video{ width:110px; height:62px; background:#000; border-radius:6px; }
    .thumb .meta{ font-family:"Inter",sans-serif; font-size:12px; color:#9fb0c5; display:flex; flex-direction:column; gap:6px }
    .chip{font-size:11px; padding:2px 6px; border-radius:999px; border:1px solid var(--line); color:#cfe2ff; display:inline-block}
    .toast{ position:fixed; right:16px; bottom:16px; z-index:50; padding:12px 14px; border-radius:10px; background:#0f1826; border:1px solid var(--line);
      display:none; gap:10px; align-items:center; box-shadow:var(--shadow); font-family:"Inter",sans-serif; }
    .toast.ok{ border-color:rgba(35,195,131,.4) } .toast.err{ border-color:rgba(239,107,107,.45) } .toast.warn{ border-color:rgba(242,163,86,.45) }
    @media (max-width:1200px){ .wrap{ grid-template-columns:1fr } }
    .app-inp{min-width:280px}
  </style>
</head>
<body>
  <header class="appbar">
    <div class="brand">
      <img src="logo.png" alt="logo" onerror="this.style.display='none'">
      <div class="title">VEO3 Studio</div>
    </div>

    <div class="bar-right">
      <input id="backendUrl" class="input small app-inp" placeholder="https://your-backend.up.railway.app">
      <select id="providerSel" class="input small">
        <option value="kie" selected>KIE</option>
        <option value="fal">FAL</option>
      </select>
      <div class="btnbar">
        <button id="btnSaveCfg" class="btn ghost small">Save</button>
        <button id="btnHealth" class="btn ghost small">Health</button>
        <button id="btnDiag" class="btn ghost small">Diag</button>
        <button id="btnDebug" class="btn ghost small">Debug</button>
      </div>
      <div class="status"><span class="dot ok" id="statusDot"></span><span id="statusText" class="hint">Ready</span></div>
    </div>
  </header>

  <main class="wrap">
    <!-- Controls -->
    <section class="panel">
      <h2>Controls <span class="hint">Describe → Generate</span></h2>

      <div class="field">
        <label>Prompt</label>
        <textarea id="prompt" class="input" placeholder="Describe the scene…"></textarea>
      </div>

      <div class="row row2">
        <div class="field">
          <label>Mode</label>
          <div class="seg" role="radiogroup" aria-label="Mode">
            <label class="seg-radio"><input type="radio" name="mode" id="modeFast" value="fast" checked><span>Fast</span></label>
            <label class="seg-radio"><input type="radio" name="mode" id="modeQuality" value="quality"><span>Quality</span></label>
          </div>
        </div>
        <div class="field">
          <label>Duration: <span id="durVal">8s</span> <span class="hint">(Fast fixed to 8s)</span></label>
          <input id="duration" class="input" type="range" min="1" max="8" value="8">
        </div>
      </div>

      <div class="row row3">
        <div class="field">
          <label>Aspect ratio</label>
          <select id="aspect" class="input">
            <option>16:9</option><option selected>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option>
          </select>
        </div>
        <div class="field">
          <label>Resolution</label>
          <select id="res" class="input">
            <option>720p</option><option selected>1080p</option>
          </select>
        </div>
        <div class="field">
          <label>Audio</label>
          <div class="toggle">
            <label class="switch">
              <input id="audio" type="checkbox" checked><span class="knob"></span>
            </label>
            <span class="hint">include audio</span>
          </div>
        </div>
      </div>

      <div class="row row2">
        <div class="field">
          <label>Seed (optional)</label>
          <input id="seed" class="input" type="number" placeholder="e.g. 42101">
        </div>
        <div class="field">
          <label>Style preset</label>
          <select id="style" class="input">
            <option value="">None</option>
            <option value="cinematic, volumetric lighting, shallow depth of field, high dynamic range">Cinematic</option>
            <option value="anime, vibrant colors, cel shading, exaggerated motion">Anime</option>
            <option value="cartoon, bold outlines, playful, saturated palette">Cartoon</option>
            <option value="photorealistic, ultra-detailed, ray-traced reflections">Photorealistic</option>
            <option value="surreal, dreamlike, abstract patterns, ethereal glow">Surreal</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Negative prompt (optional)</label>
        <textarea id="neg" class="input" placeholder="Things to avoid…"></textarea>
      </div>

      <div class="row row2">
        <button id="btnGen" class="btn primary">Generate</button>
        <button id="btnClear" class="btn ghost">Clear</button>
      </div>
      <div class="hint" style="margin-top:8px">Tip: ⌘/Ctrl + Enter</div>

      <!-- Voiceover (ElevenLabs) -->
      <hr style="opacity:.2; border:none; border-top:1px solid var(--line); margin:14px 0 10px 0;">
      <h2>Voiceover <span class="hint">ElevenLabs</span></h2>

      <div class="row row2">
        <div class="field">
          <label>Voice</label>
          <select id="voiceSel" class="input"></select>
        </div>
        <div class="field">
          <label>Model</label>
          <select id="voiceModel" class="input">
            <option value="eleven_multilingual_v2" selected>eleven_multilingual_v2</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Narration Script</label>
        <textarea id="ttsText" class="input" placeholder="Type the exact narration…"></textarea>
      </div>

      <div class="row row2">
        <button id="btnTTS" class="btn ghost">Generate Voiceover</button>
        <button id="btnMux" class="btn ghost" disabled>Merge with Current Video</button>
      </div>

      <div class="field" id="ttsPreviewBox" style="display:none; margin-top:8px;">
        <label>Voiceover Preview</label>
        <audio id="ttsAudio" controls style="width:100%"></audio>
        <div class="hint" id="ttsMeta"></div>
      </div>
    </section>

    <!-- Preview -->
    <section class="panel">
      <h2>Preview</h2>
      <div class="preview-area">
        <div id="placeholder" class="placeholder">Your video will appear here</div>
        <video id="player" class="player" controls playsinline webkit-playsinline></video>
        <div id="overlay" class="overlay">
          <div>
            <div class="spinner" style="margin:auto"></div>
            <div class="hint" style="text-align:center;margin-top:10px">Generating…</div>
          </div>
        </div>
      </div>
      <div style="display:flex; gap:10px; margin-top:10px">
        <button id="btnDownload" class="btn ghost" disabled>Download</button>
        <button id="btnCopy" class="btn ghost" disabled>Copy URL</button>
        <span class="hint" id="resBadge" style="margin-left:auto">—</span>
      </div>

      <div class="panel" style="margin-top:12px">
        <h2>Logs <span class="hint">recent responses</span></h2>
        <pre id="logBox" class="input" style="min-height:120px; white-space:pre-wrap; background:#0a0f17; border-radius:10px; padding:12px; overflow:auto;"></pre>
      </div>
    </section>

    <!-- History -->
    <aside class="panel">
      <h2>History</h2>
      <div id="history" class="history-list"></div>
    </aside>
  </main>

  <!-- Toast -->
  <div id="toast" class="toast"></div>

  <script>
    /******** CONFIG ********/
    const el = (id)=>document.getElementById(id);
    const LS_CFG = 'veo_cfg_v1';
    const cfg = loadCfg();

    // DOM references
    const backendUrlEl = el('backendUrl');
    const providerSel = el('providerSel');
    const btnSaveCfg = el('btnSaveCfg');
    const btnHealth = el('btnHealth');
    const btnDiag = el('btnDiag');
    const btnDebug = el('btnDebug');

    const promptEl = el('prompt'), durationEl = el('duration'), durValEl = el('durVal'),
          aspectEl = el('aspect'), resEl = el('res'), audioEl = el('audio'),
          seedEl = el('seed'), styleEl = el('style'), negEl = el('neg');
    const btnGen = el('btnGen'), btnClear = el('btnClear');
    const overlay = el('overlay'), player = el('player'), placeholder = el('placeholder'), resBadge = el('resBadge');
    const btnDownload = el('btnDownload'), btnCopy = el('btnCopy');
    const historyBox = el('history'), toast = el('toast');
    const statusDot = el('statusDot'), statusText = el('statusText');
    const modeFastEl = el('modeFast'); const modeQualEl = el('modeQuality');
    const logBox = el('logBox');

    // ElevenLabs
    const voiceSel = el('voiceSel');
    const voiceModel = el('voiceModel');
    const ttsText = el('ttsText');
    const btnTTS = el('btnTTS');
    const ttsPreviewBox = el('ttsPreviewBox');
    const ttsAudio = el('ttsAudio');
    const ttsMeta = el('ttsMeta');
    const btnMux = el('btnMux');

    let mode = 'fast';
    let lastVideoURL = null;
    let lastAudioURL = null;

    function loadCfg(){
      const def = {
        backendUrl: "https://veo-backend-production.up.railway.app",
        provider: "kie"
      };
      try{ return { ...def, ...(JSON.parse(localStorage.getItem(LS_CFG)||'{}')) }; }catch{ return def; }
    }
    function saveCfg(){
      cfg.backendUrl = backendUrlEl.value.trim().replace(/\/$/,'');
      cfg.provider = providerSel.value;
      localStorage.setItem(LS_CFG, JSON.stringify(cfg));
      showToast('Saved','ok');
    }
    function api(p){
      const base = cfg.backendUrl.replace(/\/$/,'');
      const prov = cfg.provider.toLowerCase();
      // Force provider routing to avoid body/query ambiguity
      return `${base}/provider/${encodeURIComponent(prov)}${p.startsWith('/')?'': '/'}${p}`;
    }

    /******** UI helpers ********/
    function showToast(msg,type='ok'){
      toast.className = 'toast '+type; toast.textContent = msg; toast.style.display='flex';
      clearTimeout(showToast._t); showToast._t = setTimeout(()=> toast.style.display='none', 3200);
    }
    function setStatus(text, level='ok'){
      statusText.textContent = text;
      statusDot.className = 'dot ' + (level==='ok'?'ok':level==='warn'?'warn':'err');
    }
    function log(label, obj){
      const t = `[${new Date().toISOString()}] ${label}: ` + (typeof obj==='string'?obj: JSON.stringify(obj,null,2));
      logBox.textContent = (t + "\n\n" + logBox.textContent).slice(0, 20000);
      console.log(label, obj);
    }

    // Robust extractors
    function extractJobId(data){
      if(!data) return null;
      return data.taskId || data.task_id || data.id || data.job_id || data.jobId ||
        (data.data && (data.data.taskId || data.data.task_id || data.data.id)) ||
        (data.result && (data.result.taskId || data.result.task_id || data.result.id)) || null;
    }
    function firstUrlFromArrayLike(ru){
      if(!ru) return null;
      if (typeof ru === 'string'){
        try{ const arr = JSON.parse(ru); if(Array.isArray(arr)) return arr.find(u=>/^https?:\/\//.test(u))||null; }catch{}
        if(/^https?:\/\//.test(ru)) return ru;
      } else if (Array.isArray(ru)){
        return ru.find(u=>typeof u==='string' && /^https?:\/\//.test(u))||null;
      }
      return null;
    }
    function extractVideoURL(data){
      if(!data) return null;
      const tryObj = (o)=> o && (o.video_url || o.videoUrl || o.url || o.output_url || o.outputUrl);
      const a = tryObj(data) || tryObj(data.data||{}) || tryObj(data.result||{}) || tryObj(data.output||{});
      if(a && /^https?:\/\//.test(a)) return a;
      // KIE quirk: data.resultUrls / resultUrl / videoUrl can be array or JSON string
      const d = data.data || data.result || data.output || {};
      return firstUrlFromArrayLike(d.resultUrls || d.resultUrl || d.videoUrl) || null;
    }

    /******** Mode & duration ********/
    function lockDurationForFast(){
      if(mode==='fast'){ durationEl.value=8; durationEl.setAttribute('disabled','disabled'); durValEl.textContent='8s'; }
      else{ durationEl.removeAttribute('disabled'); durValEl.textContent = durationEl.value + 's'; }
    }
    modeFastEl.addEventListener('change', (e)=>{ if(e.target.checked){ mode='fast'; lockDurationForFast(); }});
    modeQualEl.addEventListener('change', (e)=>{ if(e.target.checked){ mode='quality'; lockDurationForFast(); }});
    durationEl.addEventListener('input', ()=> durValEl.textContent = durationEl.value + 's');

    /******** History (persistent) ********/
    const HISTORY_KEY = 'veo3_history_v6';
    const LAST_KEY = 'veo3_last_played';

    function loadHistory(){
      historyBox.innerHTML='';
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
      if(!arr.length){
        const h = document.createElement('div'); h.className='hint'; h.textContent='No videos yet.';
        historyBox.appendChild(h); return;
      }
      arr.forEach(addHistoryThumb);
    }
    function saveHistoryItem(item){
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
      arr.unshift(item); while(arr.length>24) arr.pop();
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    }
    function updateHistoryItem(match, patch){
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
      const i = arr.findIndex(x => (match.job_id && x.job_id===match.job_id) || (match.url && x.url===match.url));
      if(i>=0){ arr[i] = { ...arr[i], ...patch }; localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)); redrawHistory(); }
    }
    function redrawHistory(){ historyBox.innerHTML=''; loadHistory(); }

    function smBtn(text, onClick){ const b=document.createElement('button'); b.className='btn small ghost'; b.textContent=text; b.onclick=onClick; return b; }

    function addHistoryThumb(item){
      const card = document.createElement('div'); card.className='thumb';
      const v = document.createElement('video'); v.muted=true; v.preload='metadata'; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      if(item.url){ v.src=item.url; } else { v.style.background='#000'; }
      const meta = document.createElement('div'); meta.className='meta';
      const header = document.createElement('div');
      header.innerHTML = `${item.mode==='fast'?'Fast':'Quality'} • ${item.aspect||''} • ${item.res||''}<br><span style="color:#cfd6df">${(item.prompt||'').slice(0,56)}${(item.prompt||'').length>56?'…':''}</span>`;
      meta.appendChild(header);
      const row = document.createElement('div'); row.style.display='flex'; row.style.gap='6px'; row.style.marginTop='6px';

      if(item.url){
        row.appendChild(smBtn('Play', ()=> { showVideo(item.url, item.res); }));
        row.appendChild(smBtn('Copy URL', async ()=>{ await navigator.clipboard.writeText(item.url); showToast('URL copied','ok'); }));
        row.appendChild(smBtn('Download', ()=>{ const a=document.createElement('a'); a.href=item.url; a.download='veo3_video.mp4'; document.body.appendChild(a); a.click(); a.remove(); }));
      }else{
        const chip = document.createElement('span'); chip.className='chip'; 
        chip.textContent = item.job_id ? ('Pending • ' + item.job_id.slice(0,8)) : 'No job ID';
        row.appendChild(chip);
        row.appendChild(smBtn('Poll', ()=> pollOnce(item.job_id)));
      }

      meta.appendChild(row);
      card.appendChild(v); card.appendChild(meta);
      historyBox.appendChild(card);
    }

    /******** Player ********/
    function showVideo(url, resLabel){
      if(!url) return;
      lastVideoURL = url;
      localStorage.setItem(LAST_KEY, JSON.stringify({ url, res: resLabel || '' }));
      player.src = url;
      placeholder.style.display='none';
      player.style.display='block';
      btnCopy.disabled = false; btnDownload.disabled = false;
      resBadge.textContent = resLabel || '';
      btnMux.disabled = !lastAudioURL;
    }
    function restoreLast(){
      const last = JSON.parse(localStorage.getItem(LAST_KEY)||'null');
      if(last && last.url){ showVideo(last.url, last.res); }
    }
    btnCopy.onclick = ()=>{ if(!lastVideoURL) return; navigator.clipboard.writeText(lastVideoURL).then(()=> showToast('URL copied','ok')); };
    btnDownload.onclick = ()=>{ if(!lastVideoURL) return; const a=document.createElement('a'); a.href=lastVideoURL; a.download='veo3_video.mp4'; document.body.appendChild(a); a.click(); a.remove(); };

    /******** Auto-poller ********/
    let pollTimer = null;
    function startPolling(jobId, label){
      stopPolling();
      let attempts = 0;
      setStatus(`Queued: ${label}…`,'warn');
      pollTimer = setInterval(async ()=>{
        attempts++;
        const ok = await pollOnce(jobId);
        if(ok) stopPolling();
        if(attempts >= 60) { // ~5 minutes at 5s
          stopPolling(); showToast('Timed out waiting for video','warn'); setStatus('Timeout','warn');
        }
      }, 5000);
    }
    function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
    async function pollOnce(jobId){
      if(!jobId) return false;
      try{
        const r = await fetch(api(`/result/${encodeURIComponent(jobId)}`));
        const j = await r.json(); log('Poll', j);
        const url = extractVideoURL(j);
        if(url){
          updateHistoryItem({job_id:jobId}, { url });
          showVideo(url, resEl.value);
          showToast('Video ready!','ok'); setStatus('Ready','ok');
          return true;
        }
        if(j.pending || j.status==='generating'){ setStatus('Generating…','warn'); return false; }
        return false;
      }catch(e){ log('Poll error', String(e)); return false; }
    }

    /******** Generate video ********/
    btnGen.onclick = generate;
    btnClear.onclick = ()=>{ promptEl.value=''; negEl.value=''; seedEl.value=''; };
    document.addEventListener('keydown', (e)=>{ if((e.ctrlKey||e.metaKey) && e.key==='Enter'){ generate(); } });

    async function generate(){
      const prompt = (promptEl.value||'').trim();
      if(!prompt){ return showToast('Enter a prompt','err'); }
      const endpoint = mode==='fast' ? 'generate-fast' : 'generate-quality';
      const url = api(`/${endpoint}`);
      const body = {
        prompt,
        duration: mode==='fast' ? 8 : Number(durationEl.value),
        aspect_ratio: aspectEl.value,
        resolution: resEl.value,
        with_audio: !!audioEl.checked,
        ...(seedEl.value ? { seed: Number(seedEl.value) } : {}),
        ...(styleEl.value ? { style: styleEl.value } : {}),
        ...(negEl.value.trim() ? { negative_prompt: negEl.value.trim() } : {})
      };

      overlay.style.display='flex'; setStatus('Generating…','warn'); btnGen.disabled = true; stopPolling();
      try{
        const res = await fetch(url,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const text = await res.text(); log('Generate raw', text);
        let data={}; try{ data = JSON.parse(text); }catch{ throw new Error('Invalid JSON response'); }
        if(!res.ok || data.success===false){ throw new Error(data?.error || data?.message || `HTTP ${res.status}`); }

        const videoURL = extractVideoURL(data);
        const jobId = extractJobId(data);
        const histItem = {
          url: videoURL || null,
          job_id: jobId || null,
          prompt, mode,
          aspect: aspectEl.value, res: resEl.value,
          with_audio: !!audioEl.checked, duration: body.duration,
          seed: seedEl.value ? Number(seedEl.value) : undefined,
          style: styleEl.value || undefined,
          negative_prompt: negEl.value.trim() || undefined,
          timestamp: Date.now()
        };
        saveHistoryItem(histItem); redrawHistory();

        if(videoURL){
          showVideo(videoURL, resEl.value);
          setStatus('Ready','ok'); showToast('Video ready','ok');
        } else if(jobId){
          showToast(`Queued • ${jobId.slice(0,8)} • auto-polling…`,'warn');
          startPolling(jobId, jobId.slice(0,8));
        } else {
          setStatus('Unknown','warn'); showToast('No job ID returned','warn');
        }
      }catch(e){
        log('Generate error', String(e)); setStatus('Error','err'); showToast(e.message||'Failed','err');
      }finally{
        overlay.style.display='none'; btnGen.disabled = false;
      }
    }

    /******** ElevenLabs ********/
    async function loadVoices(){
      try{
        const r = await fetch(api("/eleven/voices"));
        const j = await r.json(); log('Voices', j);
        if(!r.ok) throw new Error(j?.error || "Failed to load voices");
        voiceSel.innerHTML = "";
        (j.voices || []).forEach(v=>{
          const opt = document.createElement("option");
          opt.value = v.id; opt.textContent = v.name + (v.category ? ` • ${v.category}` : "");
          voiceSel.appendChild(opt);
        });
      }catch(e){
        voiceSel.innerHTML = `<option value="">No access (check ELEVEN_LABS)</option>`;
        showToast("Voices load failed","warn");
      }
    }
    btnTTS.onclick = async ()=>{
      const voice_id = voiceSel.value;
      const text = (ttsText.value||"").trim();
      if(!voice_id) return showToast("Pick a voice","err");
      if(!text) return showToast("Enter narration","err");
      setStatus("Synthesizing…","warn"); btnTTS.disabled = true;
      try{
        const r = await fetch(api("/eleven/tts"), {
          method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ voice_id, text, model_id: voiceModel.value })
        });
        const j = await r.json(); log('TTS', j);
        if(!r.ok) throw new Error(j?.error || "TTS failed");
        lastAudioURL = j.audio_url ? (
          j.audio_url.startsWith("/") ? cfg.backendUrl.replace(/\/$/,'') + j.audio_url : j.audio_url
        ) : null;
        if(!lastAudioURL) throw new Error("No audio_url returned");
        ttsAudio.src = lastAudioURL;
        ttsPreviewBox.style.display = "block";
        ttsMeta.textContent = `Audio bytes: ${j.bytes ?? "—"}`;
        btnMux.disabled = !lastVideoURL;
        showToast("Voiceover ready","ok"); setStatus("Ready","ok");
      }catch(e){
        log('TTS error', String(e)); showToast(e.message||"TTS error","err"); setStatus("Error","err");
      }finally{ btnTTS.disabled = false; }
    };
    btnMux.onclick = async ()=>{
      if(!lastVideoURL) return showToast("No video loaded","err");
      if(!lastAudioURL) return showToast("No voiceover ready","err");
      setStatus("Merging…","warn"); btnMux.disabled = true;
      try{
        const r = await fetch(api("/mux"), {
          method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ video_url: lastVideoURL, audio_url: lastAudioURL })
        });
        const j = await r.json(); log('Mux', j);
        if(!r.ok) throw new Error(j?.error || "Mux failed");
        if(!j.merged_url) throw new Error("No merged_url");
        const merged = j.merged_url.startsWith("/") ? cfg.backendUrl.replace(/\/$/,'') + j.merged_url : j.merged_url;
        showVideo(merged, resEl.value);
        saveHistoryItem({ url: merged, prompt: "[merged narration]", mode, aspect: aspectEl.value, res: resEl.value, timestamp: Date.now() });
        redrawHistory();
        showToast("Merged video ready","ok"); setStatus("Ready","ok");
      }catch(e){
        log('Mux error', String(e)); showToast(e.message||"Mux error","err"); setStatus("Error","err");
      }finally{ btnMux.disabled = false; }
    };

    /******** Top-bar actions ********/
    btnSaveCfg.onclick = saveCfg;
    btnHealth.onclick = async ()=>{
      try{ const r = await fetch(api('/health')); const j = await r.json(); log('Health', j); setStatus('Online','ok'); showToast('Health OK','ok'); }
      catch(e){ log('Health error', String(e)); setStatus('Offline','err'); showToast('Health failed','err'); }
    };
    btnDiag.onclick = async ()=>{
      try{ const r = await fetch(api('/diag')); const j = await r.json(); log('Diag', j); showToast('Diag OK','ok'); }
      catch(e){ log('Diag error', String(e)); showToast('Diag failed','err'); }
    };
    btnDebug.onclick = async ()=>{
      try{
        const r = await fetch(api('/debug/generate'), { method:'POST' });
        const j = await r.json(); log('Debug', j);
        if(j.video_url){ showVideo(j.video_url, '720p'); showToast('Debug video ready','ok'); }
        else if(j.job_id){ startPolling(j.job_id, 'debug'); showToast('Debug queued','warn'); }
        else { showToast('Debug sent (no job/id)','warn'); }
      }catch(e){ log('Debug error', String(e)); showToast('Debug failed','err'); }
    };

    /******** Init ********/
    (function init(){
      backendUrlEl.value = cfg.backendUrl;
      providerSel.value = (cfg.provider||'kie');
      try{ fetch(api('/health')).then(r=> setStatus(r.ok?'Backend online':'Reachable', r.ok?'ok':'warn')).catch(()=> setStatus('Offline','err')); }catch{}
      lockDurationForFast();
      restoreLast();
      loadHistory();
      loadVoices();
    })();
  </script>
</body>
</html>
