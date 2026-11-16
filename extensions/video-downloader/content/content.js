// Isolated-world content script: relays what the page hook finds, draws the download button
// over videos, and drives record mode.
(() => {
  if (window.__ofvsContent) return;
  window.__ofvsContent = true;

  const CONFIG = globalThis.OFVS_CONFIG || {};
  const isTop = window === window.top;
  if (!CONFIG.youtube && /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(location.hostname)) return;

  const CAPTURE_KEY = '__ofvs_capture';
  let armed = false;
  try {
    armed = sessionStorage.getItem(CAPTURE_KEY) === '1';
    sessionStorage.removeItem(CAPTURE_KEY); // one page load only; the hook has already read it
  } catch { /* storage blocked */ }

  const bg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const toHook = (type, data) => window.postMessage({ __ofvs: 'content', type, ...data }, '*');
  const hookWaiters = new Map();
  const fromHook = (type, timeout = 4000) => new Promise((resolve) => {
    const timer = setTimeout(() => { hookWaiters.delete(type); resolve(null); }, timeout);
    hookWaiters.set(type, (data) => { clearTimeout(timer); resolve(data); });
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__ofvs !== 'hook') return;
    const msg = event.data;
    if (msg.type === 'items') {
      if (Array.isArray(msg.items)) bg({ type: 'page:items', items: msg.items });
      return;
    }
    const waiter = hookWaiters.get(msg.type);
    if (waiter) { hookWaiters.delete(msg.type); waiter(msg); }
  });

  let drm = false;
  document.addEventListener('encrypted', () => { drm = true; }, true);

  // ------------------------------------------------------------ UI (closed shadow root)

  let ui = null;
  function ensureUi() {
    if (ui) return ui;
    const hostEl = document.createElement('div');
    hostEl.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = hostEl.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .btn { position: fixed; display: none; align-items: center; gap: 6px; height: 32px; padding: 0 12px 0 10px;
          border: 0; border-radius: 16px; background: rgba(17,17,27,.86); color: #fff; font-size: 13px; font-weight: 600;
          cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.35); backdrop-filter: blur(6px); }
        .btn:hover { background: #4f46e5; }
        .btn svg { width: 15px; height: 15px; flex: none; }
        .menu { position: fixed; display: none; min-width: 230px; max-width: 320px; padding: 6px; border-radius: 12px;
          background: #16161f; color: #f3f4f6; box-shadow: 0 8px 28px rgba(0,0,0,.45); font-size: 13px; }
        .menu .head { padding: 6px 8px 8px; color: #a1a1aa; font-size: 12px; line-height: 1.35; }
        .menu button { display: block; width: 100%; padding: 8px; border: 0; border-radius: 8px; background: none;
          color: inherit; font-size: 13px; text-align: left; cursor: pointer; }
        .menu button:hover { background: #2a2a3a; }
        .menu small { display: block; color: #a1a1aa; font-size: 11px; margin-top: 2px; }
        .toast { position: fixed; right: 16px; bottom: 16px; display: none; width: 300px; max-width: calc(100vw - 32px);
          padding: 12px 14px; border-radius: 12px; background: #16161f; color: #f3f4f6; font-size: 13px; line-height: 1.4;
          box-shadow: 0 8px 28px rgba(0,0,0,.45); }
        .toast .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .toast .msg { overflow-wrap: anywhere; }
        .toast .x { flex: none; border: 0; background: none; color: #a1a1aa; font-size: 12px; cursor: pointer; padding: 0; }
        .toast .x:hover { color: #fff; }
        .bar { height: 4px; margin-top: 10px; border-radius: 2px; background: #2a2a3a; overflow: hidden; }
        .bar i { display: block; height: 100%; width: 0; background: #818cf8; transition: width .2s; }
        .toast.ok .bar i { background: #34d399; } .toast.err .bar { display: none; } .toast.err { border-left: 3px solid #f87171; }
      </style>
      <button class="btn" part="btn" aria-label="Download this video">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>
        <span>Download</span>
      </button>
      <div class="menu" role="menu"></div>
      <div class="toast" role="status"><div class="row"><div class="msg"></div><button class="x"></button></div><div class="bar"><i></i></div></div>`;
    (document.documentElement || document).appendChild(hostEl);
    ui = {
      hostEl, root,
      btn: root.querySelector('.btn'),
      menu: root.querySelector('.menu'),
      toast: root.querySelector('.toast'),
      toastMsg: root.querySelector('.toast .msg'),
      toastX: root.querySelector('.toast .x'),
      bar: root.querySelector('.bar i'),
    };
    ui.btn.addEventListener('click', onButtonClick);
    ui.btn.addEventListener('mouseenter', () => { overButton = true; });
    ui.btn.addEventListener('mouseleave', () => { overButton = false; });
    return ui;
  }

  let toastTimer = null;
  function toast(message, { fraction = null, kind = '', action = null, sticky = false } = {}) {
    const u = ensureUi();
    clearTimeout(toastTimer);
    u.toast.className = `toast ${kind}`;
    u.toast.style.display = 'block';
    u.toastMsg.textContent = message;
    u.bar.parentElement.style.display = fraction === null ? 'none' : '';
    if (fraction !== null) u.bar.style.width = `${Math.round(fraction * 100)}%`;
    u.toastX.textContent = action ? action.label : 'Close';
    u.toastX.onclick = () => { if (action) action.run(); else u.toast.style.display = 'none'; };
    if (!sticky) toastTimer = setTimeout(() => { u.toast.style.display = 'none'; }, kind === 'err' ? 12000 : 6000);
  }

  const fmtTime = (s) => {
    if (!(s > 0)) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const fmtSize = (b) => (b > 0 ? (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 104857600 ? 0 : 1)} MB` : `${Math.round(b / 1024)} KB`) : '');

  // ------------------------------------------------------------ download button over videos

  let currentVideo = null;
  let overButton = false;
  let hideTimer = null;
  let lastMove = 0;
  const myJobs = new Set();

  function videoAt(x, y) {
    let els;
    try { els = document.elementsFromPoint(x, y); } catch { return null; }
    for (const el of els) {
      if (el instanceof HTMLVideoElement) {
        const r = el.getBoundingClientRect();
        if (r.width >= 180 && r.height >= 110) return el;
      }
      // Players inside open shadow roots.
      const inner = el.shadowRoot?.querySelector?.('video');
      if (inner) {
        const r = inner.getBoundingClientRect();
        if (r.width >= 180 && r.height >= 110 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return inner;
      }
    }
    return null;
  }

  function placeButton() {
    if (!currentVideo || !currentVideo.isConnected) { hideButton(true); return; }
    const u = ensureUi();
    const r = currentVideo.getBoundingClientRect();
    if (r.bottom < 40 || r.top > innerHeight - 40 || r.width < 180) { hideButton(true); return; }
    u.btn.style.display = 'flex';
    u.btn.style.left = `${Math.max(8, Math.min(innerWidth - 130, r.left + 10))}px`;
    u.btn.style.top = `${Math.max(8, r.top + 10)}px`;
  }

  function hideButton(now) {
    clearTimeout(hideTimer);
    const run = () => { if (ui && !overButton) { ui.btn.style.display = 'none'; } };
    if (now) run(); else hideTimer = setTimeout(run, 700);
  }

  function closeMenu() { if (ui) ui.menu.style.display = 'none'; }

  document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMove < 120) return;
    lastMove = now;
    if (overButton) return;
    const v = videoAt(e.clientX, e.clientY);
    if (v) {
      clearTimeout(hideTimer);
      currentVideo = v;
      placeButton();
    } else if (ui && ui.btn.style.display !== 'none') {
      hideButton(false);
    }
  }, { passive: true, capture: true });
  document.addEventListener('scroll', () => { if (ui && ui.btn.style.display !== 'none') placeButton(); closeMenu(); }, { passive: true, capture: true });
  document.addEventListener('click', (e) => { if (ui && e.target !== ui.hostEl) closeMenu(); }, true);

  async function startDownload(itemId, variantIndex = 0) {
    const res = await bg({ type: 'download', itemId, variantIndex });
    if (!res?.ok) { toast(res?.error || 'Could not start the download.', { kind: 'err' }); return; }
    myJobs.add(res.jobId);
    toast('Starting download…', { fraction: 0, sticky: true });
  }

  function showMenu(items, canRecord, note) {
    const u = ensureUi();
    u.menu.textContent = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = note;
    u.menu.appendChild(head);
    for (const item of items) {
      const b = document.createElement('button');
      const meta = [item.variants[0]?.label, fmtTime(item.duration), fmtSize(item.size), item.kind === 'direct' ? '' : 'stream'].filter(Boolean).join(' · ');
      b.textContent = item.title || item.host || 'Video';
      const s = document.createElement('small');
      s.textContent = meta || item.host;
      b.appendChild(s);
      b.onclick = () => { closeMenu(); startDownload(item.id); };
      u.menu.appendChild(b);
    }
    if (canRecord) {
      const b = document.createElement('button');
      b.textContent = 'Record this video instead';
      const s = document.createElement('small');
      s.textContent = 'Reloads the page and saves the stream as it plays';
      b.appendChild(s);
      b.onclick = () => { closeMenu(); armCapture(); };
      u.menu.appendChild(b);
    }
    const r = u.btn.getBoundingClientRect();
    u.menu.style.display = 'block';
    u.menu.style.left = `${Math.max(8, Math.min(innerWidth - 330, r.left))}px`;
    u.menu.style.top = `${Math.min(innerHeight - 60, r.bottom + 6)}px`;
  }

  async function onButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const v = currentVideo;
    if (!v) return;
    if (drm || v.mediaKeys) { toast('This video is DRM-protected and cannot be saved.', { kind: 'err' }); return; }
    const src = v.currentSrc || v.src || '';
    const res = await bg({ type: 'overlay:pick', duration: isFinite(v.duration) ? v.duration : 0, src });
    if (!res) { toast('The extension was updated. Reload this page and try again.', { kind: 'err' }); return; }
    if (res.blocked) { toast('This edition does not save videos from this site.', { kind: 'err' }); return; }
    const streaming = src.startsWith('blob:') || !src;
    if (res.match.length === 1) { startDownload(res.match[0].id); return; }
    if (res.others.length) { showMenu(res.others, streaming, 'Several videos were found on this page. Which one?'); return; }
    if (streaming) { showMenu([], true, 'The source of this video is hidden from the network. It can still be recorded while it plays.'); return; }
    toast('No downloadable source found yet. Press play, wait a second, then try again.', { kind: 'err' });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'capture:arm') { armCapture(); return; }
    if (msg?.type !== 'job:update' || !myJobs.has(msg.job.id)) return;
    const job = msg.job;
    const cancel = { label: 'Cancel', run: () => bg({ type: 'job:cancel', id: job.id }) };
    if (job.state === 'running') {
      toast(`${job.stage}… ${Math.round((job.fraction || 0) * 100)}%`, { fraction: job.fraction || 0, sticky: true, action: cancel });
    } else if (job.state === 'saving') {
      toast('Saving to your Downloads folder…', { fraction: 1, sticky: true });
    } else if (job.state === 'done') {
      myJobs.delete(job.id);
      const extra = job.warnings?.length ? ` ${job.warnings[0]}` : '';
      toast(`Saved “${job.filename}” (${fmtSize(job.size)}).${extra}`, { fraction: 1, kind: 'ok' });
    } else if (job.state === 'cancelled') {
      myJobs.delete(job.id);
      toast('Download cancelled.', {});
    } else if (job.state === 'error') {
      myJobs.delete(job.id);
      toast(job.error || 'The download failed.', { kind: 'err' });
    }
  });

  // ------------------------------------------------------------ record mode

  function armCapture() {
    try { sessionStorage.setItem(CAPTURE_KEY, '1'); } catch { /* storage blocked: this frame is skipped */ }
    if (isTop) location.reload();
  }

  const RATE = 4;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function streamingVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!(v.currentSrc || '').startsWith('blob:')) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area >= bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  const adShowing = () => !!document.querySelector('.ad-showing, .ad-interrupting');

  function fullyBuffered(v) {
    const b = v.buffered;
    return b.length === 1 && b.start(0) <= 0.5 && b.end(0) >= v.duration - 0.5;
  }

  async function runCapture() {
    let cancelled = false;
    const stop = { label: 'Stop', run: () => { cancelled = true; } };
    const say = (m, o = {}) => toast(m, { sticky: true, action: stop, ...o });

    // Wait for a streaming player in this frame.
    let video = null;
    const deadline = Date.now() + 30000;
    while (!cancelled && Date.now() < deadline) {
      video = streamingVideo();
      if (video && video.readyState >= 1) break;
      video = null;
      if (isTop) say('Record mode: waiting for the video to start…');
      await sleep(500);
    }
    if (cancelled) { toast('Recording stopped.', {}); return; }
    if (!video) {
      if (isTop && !document.querySelector('iframe')) toast('Record mode found no streaming video on this page.', { kind: 'err' });
      else if (isTop && ui) ui.toast.style.display = 'none';
      return;
    }

    toHook('capture:status', { src: video.currentSrc });
    const status = await fromHook('capture:status');
    if (!status?.armed) { toast('Record mode could not attach to this page. Reload and try again.', { kind: 'err' }); return; }

    const original = { muted: video.muted, rate: video.playbackRate };
    let src = video.currentSrc;
    let last = 0;
    let finished = false;
    let stuckSince = Date.now();

    while (!cancelled && !finished) {
      if (drm || video.mediaKeys) {
        toast('This video is DRM-protected and cannot be recorded.', { kind: 'err' });
        video.muted = original.muted; video.playbackRate = original.rate;
        return;
      }
      if (!video.isConnected || !(video.currentSrc || '').startsWith('blob:')) {
        const next = streamingVideo();
        if (next) video = next;
      }
      if (video.currentSrc !== src) { src = video.currentSrc; last = 0; stuckSince = Date.now(); }

      const duration = video.duration;
      if (adShowing()) {
        say('Record mode: waiting for the ad to finish…');
        last = 0;
      } else if (!isFinite(duration) || duration <= 0) {
        say(duration === Infinity ? 'Record mode: live streams are recorded until you press Stop.' : 'Record mode: waiting for the video…');
      } else {
        video.muted = true;
        if (video.playbackRate !== RATE) { try { video.playbackRate = RATE; } catch { /* rate not allowed */ } }
        if (video.paused && !video.ended) video.play().catch(() => {});
        const t = video.currentTime;
        if (t !== last) stuckSince = Date.now();
        const wrapped = t < last - 1 && last > duration * 0.9; // looping players never fire "ended"
        if (video.ended || t >= duration - 0.4 || wrapped || fullyBuffered(video)) finished = true;
        last = Math.max(last, t);
        say(`Recording… ${Math.min(99, Math.round((last / duration) * 100))}%. Keep this tab open.`, { fraction: Math.min(1, last / duration) });
        if (Date.now() - stuckSince > 45000) {
          toast('Recording stalled because the video stopped playing. Reload and try again.', { kind: 'err' });
          video.muted = original.muted; video.playbackRate = original.rate;
          return;
        }
      }
      if (!finished) await sleep(400);
    }

    try { video.pause(); } catch { /* ignore */ }
    video.playbackRate = original.rate;
    video.muted = original.muted;

    toHook('capture:collect', { src });
    const data = await fromHook('capture:data', 15000);
    const tracks = data?.tracks || [];
    if (!tracks.some((t) => t.sections.length)) { toast('Nothing was recorded.', { kind: 'err' }); return; }

    toast('Building your video…', { fraction: 0, sticky: true });
    try {
      const { remux } = await import(chrome.runtime.getURL('lib/mux.js'));
      const sectionsOf = (re) => tracks.filter((t) => re.test(t.mime)).flatMap((t) => t.sections);
      let videoParts = sectionsOf(/^video\//i);
      const audioParts = sectionsOf(/^audio\//i);
      if (!videoParts.length) videoParts = tracks.flatMap((t) => t.sections);
      const out = await remux({
        video: videoParts,
        audio: audioParts.length && videoParts !== audioParts ? audioParts : undefined,
        onProgress: (f) => toast('Building your video…', { fraction: f, sticky: true }),
      });
      if (!out.blob.size || !(out.duration > 0) || !out.hasVideo) throw new Error('The recording contained no playable video.');
      const name = (document.title || 'video').replace(/^\(\d+\+?\)\s*/, '').replace(/[\u0000-\u001f<>:"/\\|?*~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
      const a = document.createElement('a');
      const url = URL.createObjectURL(out.blob);
      a.href = url;
      a.download = `${name}${out.height ? ` ${out.height}p` : ''}.${out.ext}`;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      const partial = cancelled ? ' Recording was stopped early, so the file ends where you stopped.' : '';
      const silent = out.hasAudio ? '' : ' No sound track was found.';
      toast(`Saved “${a.download}” (${fmtSize(out.blob.size)}, ${fmtTime(out.duration)}).${partial}${silent}`, { kind: 'ok', fraction: 1 });
    } catch (err) {
      toast(`Could not build the recording: ${err?.message || err}`, { kind: 'err' });
    }
  }

  if (armed) {
    const begin = () => runCapture().catch((err) => toast(`Record mode failed: ${err?.message || err}`, { kind: 'err' }));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
    else begin();
  }
})();
