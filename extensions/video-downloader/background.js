// Service worker: watches where each tab's video actually comes from, keeps the per-tab list,
// and coordinates downloads (run in the offscreen document) and saving.
import './config.js';

const CONFIG = globalThis.OFVS_CONFIG || {};
const MAX_ITEMS_PER_TAB = 80;
const MAX_INLINE_MANIFEST = 400 * 1024;
const TAB_NONE = chrome.tabs.TAB_ID_NONE;

// ---------------------------------------------------------------- state

/** tabId -> { items: {id: item}, children: {urlKey: 1}, siblings: {sig: number[]} } */
const tabs = new Map();
/** jobId -> job */
const jobs = new Map();
let headerRules = {}; // scope -> [ruleId]
let nextRuleId = 1;
let nextJobId = 1;

const ready = (async () => {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('tab:')) tabs.set(Number(key.slice(4)), value);
  }
  for (const job of all.jobs || []) jobs.set(job.id, job);
  headerRules = all.headerRules || {};
  nextRuleId = all.nextRuleId || 1;
  nextJobId = all.nextJobId || 1;
})();

const dirtyTabs = new Set();
let saveTimer = null;
function persist(tabId) {
  if (tabId !== undefined) dirtyTabs.add(tabId);
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const set = { jobs: [...jobs.values()], headerRules, nextRuleId, nextJobId };
    const remove = [];
    for (const id of dirtyTabs) {
      if (tabs.has(id)) set[`tab:${id}`] = tabs.get(id); else remove.push(`tab:${id}`);
    }
    dirtyTabs.clear();
    try {
      await chrome.storage.session.set(set);
      if (remove.length) await chrome.storage.session.remove(remove);
    } catch { /* quota: the in-memory copy still works */ }
  }, 400);
}

function tabState(tabId) {
  let t = tabs.get(tabId);
  if (!t) { t = { items: {}, children: {}, siblings: {} }; tabs.set(tabId, t); }
  return t;
}

function resetTab(tabId) {
  if (!tabs.has(tabId)) return;
  tabs.delete(tabId);
  persist(tabId);
  updateBadge(tabId);
  clearHeaders(`inspect-${tabId}`);
}

// ---------------------------------------------------------------- helpers

export function isBlockedSite(url) {
  if (CONFIG.youtube) return false;
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com)$/.test(host);
  } catch { return false; }
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const RANGE_PARAMS = ['bytestart', 'byteend', 'range', 'bytes'];

/** Drop byte-range query parameters so we address the whole file instead of one slice. */
function wholeFileUrl(url) {
  try {
    const u = new URL(url);
    let ranged = false;
    for (const p of RANGE_PARAMS) if (u.searchParams.has(p)) { u.searchParams.delete(p); ranged = true; }
    return { url: ranged ? u.href : url, ranged };
  } catch { return { url, ranged: false }; }
}

/** Identity of a media file: host + path (plus the query when the path has no file name). */
function urlKey(url) {
  try {
    const u = new URL(url);
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(u.pathname);
    return u.hostname + u.pathname + (hasExt ? '' : u.search);
  } catch { return url; }
}

function cleanTitle(title) {
  return (title || '')
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s*[|\-–—•·/]\s*(X|Twitter|Facebook|Instagram.*|YouTube|TikTok.*|Reddit.*|LinkedIn|Vimeo|Threads)\s*$/i, '')
    .trim();
}

function fileBase(title) {
  const base = cleanTitle(title)
    .replace(/[\u0000-\u001f<>:"/\\|?*~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return base || 'video';
}

async function updateBadge(tabId) {
  const count = visibleItems(tabId).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' });
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
  } catch { /* tab closed */ }
}

function visibleItems(tabId) {
  const t = tabs.get(tabId);
  if (!t) return [];
  return Object.values(t.items)
    .filter((i) => !i.hidden && i.role !== 'audio')
    .sort((a, b) => b.ts - a.ts);
}

// ---------------------------------------------------------------- detection

function addItem(tabId, item) {
  const t = tabState(tabId);
  const existing = t.items[item.id];
  if (existing) {
    // Same file seen again: keep the freshest (signed) URL and anything new we learned.
    existing.url = item.url;
    if (item.size && (!existing.size || item.size > existing.size)) existing.size = item.size;
    if (item.variants?.length && !existing.variants?.length) existing.variants = item.variants;
    if (item.duration && !existing.duration) existing.duration = item.duration;
    persist(tabId);
    return existing;
  }
  if (t.children[urlKey(item.url)]) item.hidden = 'child';
  t.items[item.id] = item;
  const all = Object.values(t.items);
  if (all.length > MAX_ITEMS_PER_TAB) {
    all.sort((a, b) => a.ts - b.ts);
    for (const old of all.slice(0, all.length - MAX_ITEMS_PER_TAB)) delete t.items[old.id];
  }
  persist(tabId);
  updateBadge(tabId);
  return item;
}

/**
 * Stream segments arrive as many sibling files that differ only by a counter
 * (seg-1.m4s, seg-2.m4s, ...). Returns true once a URL is recognisably one of those.
 */
function isSegmentSibling(t, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const m = /^(.*?)(\d+)(\D*)$/.exec(u.pathname);
  if (!m) return false;
  const sig = `${u.hostname}${m[1]}#${m[3]}`;
  const n = Number(m[2]);
  const seen = t.siblings[sig] || (t.siblings[sig] = []);
  if (!seen.includes(n)) { seen.push(n); if (seen.length > 12) seen.shift(); }
  if (seen.length < 3) return false;
  const span = Math.max(...seen) - Math.min(...seen);
  return span <= seen.length * 4;
}

const DIRECT_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'm4a', 'mp3']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'aac', 'vtt', 'key']);

function classify(details) {
  const headers = {};
  for (const h of details.responseHeaders || []) headers[h.name.toLowerCase()] = h.value || '';
  const type = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let path = '';
  let host = '';
  try { const u = new URL(details.url); path = u.pathname.toLowerCase(); host = u.hostname; } catch { return null; }
  const ext = (/\.([a-z0-9]{2,5})$/.exec(path) || [])[1] || '';

  if (/mpegurl/.test(type) || ext === 'm3u8') return { kind: 'hls', type };
  if (type === 'application/dash+xml' || ext === 'mpd') return { kind: 'dash', type };

  // Adaptive players on these hosts cannot be addressed by URL; they are handled by capture mode.
  if (/(^|\.)googlevideo\.com$/.test(host)) return null;
  if (SEGMENT_EXT.has(ext) || type === 'video/mp2t' || type === 'video/iso.segment') return null;

  const mediaType = type.startsWith('video/') || type.startsWith('audio/');
  const opaque = type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream';
  if (!mediaType && !(opaque && DIRECT_EXT.has(ext))) return null;

  const range = /\/(\d+)\s*$/.exec(headers['content-range'] || '');
  const length = Number(headers['content-length']) || 0;
  const size = range ? Number(range[1]) : (details.statusCode === 200 ? length : 0);
  return { kind: 'direct', type, size, audio: type.startsWith('audio/') || ext === 'm4a' || ext === 'mp3' };
}

async function onResponse(details) {
  if (details.tabId === TAB_NONE || details.tabId < 0) return; // our own downloads
  if (details.type === 'main_frame') {
    await ready;
    resetTab(details.tabId);
    return;
  }
  if (details.statusCode !== 200 && details.statusCode !== 206) return;
  const c = classify(details);
  if (!c) return;
  await ready;

  let pageUrl = '';
  let title = '';
  try {
    const tab = await chrome.tabs.get(details.tabId);
    pageUrl = tab.url || '';
    title = tab.title || '';
  } catch { return; }
  if (isBlockedSite(pageUrl) || isBlockedSite(details.url)) return;

  const t = tabState(details.tabId);
  if (c.kind === 'direct') {
    const whole = wholeFileUrl(details.url);
    const viaScript = details.type !== 'media';
    if (!whole.ranged) {
      if (viaScript && isSegmentSibling(t, details.url)) {
        // Hide the siblings we already let through.
        const m = /^(.*?)(\d+)(\D*)$/.exec(new URL(details.url).pathname);
        for (const item of Object.values(t.items)) {
          if (item.kind !== 'direct' || item.source !== 'network') continue;
          try {
            const p = /^(.*?)(\d+)(\D*)$/.exec(new URL(item.url).pathname);
            if (p && p[1] === m[1] && p[3] === m[3]) item.hidden = 'segment';
          } catch { /* ignore */ }
        }
        updateBadge(details.tabId);
        return;
      }
      const floor = viaScript ? 512 * 1024 : 100 * 1024;
      if (c.size && c.size < floor) return; // previews, sound effects, placeholders
    }
    addItem(details.tabId, {
      id: hash(`direct|${urlKey(whole.url)}`),
      kind: 'direct', source: 'network', url: whole.url, mime: c.type,
      size: whole.ranged ? 0 : c.size, role: c.audio ? 'audio' : 'video',
      title, pageUrl, ts: Date.now(), frameId: details.frameId,
    });
    return;
  }

  const item = addItem(details.tabId, {
    id: hash(`${c.kind}|${urlKey(details.url)}`),
    kind: c.kind, source: 'network', url: details.url, mime: c.type,
    title, pageUrl, ts: Date.now(), frameId: details.frameId,
  });
  if (!item.inspected && !item.inspecting) queueInspect(details.tabId, item);
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => { onResponse(details).catch(() => {}); },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'media', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener(async (tabId) => { await ready; resetTab(tabId); });

/** Items found by the in-page script (site JSON), which carry ready-made progressive URLs. */
function addPageItems(tabId, tab, frameId, list) {
  if (isBlockedSite(tab?.url || '')) return;
  for (const raw of list.slice(0, 40)) {
    if (!raw || typeof raw.url !== 'string') continue;
    if (!/^https?:/i.test(raw.url) && !(raw.kind === 'dash' && raw.xml)) continue;
    const kind = ['direct', 'hls', 'dash'].includes(raw.kind) ? raw.kind : 'direct';
    const variants = Array.isArray(raw.variants)
      ? raw.variants.filter((v) => v && /^https?:/i.test(v.url)).slice(0, 12).map((v) => ({
        url: v.url, label: String(v.label || (v.height ? `${v.height}p` : 'Default')).slice(0, 24),
        height: Number(v.height) || 0, width: Number(v.width) || 0, bandwidth: Number(v.bandwidth) || 0,
      }))
      : [];
    const xml = typeof raw.xml === 'string' && raw.xml.length <= MAX_INLINE_MANIFEST ? raw.xml : undefined;
    if (kind === 'dash' && raw.xml && !xml) continue;
    const item = addItem(tabId, {
      id: hash(`page|${kind}|${xml ? hash(xml) : urlKey(variants[0]?.url || raw.url)}`),
      kind, source: 'page', url: raw.url, variants, xml,
      audioUrl: typeof raw.audioUrl === 'string' ? raw.audioUrl : undefined,
      duration: Number(raw.duration) || 0,
      title: String(raw.title || '').slice(0, 200) || tab?.title || '',
      thumb: typeof raw.thumb === 'string' && /^https:/i.test(raw.thumb) ? raw.thumb : undefined,
      pageUrl: tab?.url || '', ts: Date.now(), frameId,
    });
    // The same file also shows up on the network: fold those sightings into this item.
    const t = tabState(tabId);
    for (const v of [raw.url, ...variants.map((x) => x.url)]) t.children[urlKey(v)] = 1;
    for (const other of Object.values(t.items)) {
      if (other.source === 'network' && t.children[urlKey(other.url)]) other.hidden = 'child';
    }
    if (kind !== 'direct' && !item.inspected && !item.inspecting) queueInspect(tabId, item);
  }
  persist(tabId);
  updateBadge(tabId);
}

// ---------------------------------------------------------------- inspect (qualities, duration, DRM)

const inspectQueue = [];
let inspecting = 0;

function queueInspect(tabId, item) {
  item.inspecting = true;
  inspectQueue.push({ tabId, id: item.id });
  pumpInspect();
}

async function pumpInspect() {
  while (inspecting < 2 && inspectQueue.length) {
    const { tabId, id } = inspectQueue.shift();
    inspecting++;
    inspectOne(tabId, id).catch(() => {}).finally(() => { inspecting--; pumpInspect(); });
  }
}

async function inspectOne(tabId, id) {
  const item = tabs.get(tabId)?.items[id];
  if (!item) return;
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', type: 'inspect', kind: item.kind, url: item.url, xml: item.xml,
    pageUrl: item.pageUrl, scope: `inspect-${tabId}`,
  }).catch((err) => ({ ok: false, error: String(err) }));
  const t = tabs.get(tabId);
  const current = t?.items[id];
  if (!current) return;
  current.inspecting = false;
  current.inspected = true;
  if (!res?.ok) {
    current.hidden = 'unreadable';
  } else {
    const info = res.info;
    current.duration = info.duration || current.duration || 0;
    current.variants = info.variants || [];
    current.drm = !!info.drm;
    current.live = !!info.live;
    for (const child of info.children || []) t.children[urlKey(child)] = 1;
    for (const other of Object.values(t.items)) {
      if (other.id !== id && other.source === 'network' && t.children[urlKey(other.url)]) other.hidden = 'child';
    }
  }
  persist(tabId);
  updateBadge(tabId);
}

// ---------------------------------------------------------------- offscreen document + request headers

let offscreenPromise = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenPromise) {
    offscreenPromise = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS', 'DOM_PARSER'],
      justification: 'Download video streams, parse stream manifests and merge audio with video into one file.',
    }).catch((err) => {
      if (!/single offscreen/i.test(String(err))) throw err;
    }).finally(() => { offscreenPromise = null; });
  }
  await offscreenPromise;
}

/**
 * Media servers expect requests to come from the page that embeds the video. Requests made by
 * this extension (tab id "none") to the given host get that page as Referer/Origin.
 */
async function setHeaders(scope, host, pageUrl) {
  let origin;
  let referer;
  try {
    const page = new URL(pageUrl);
    if (!/^https?:$/.test(page.protocol)) return;
    origin = page.origin;
    referer = page.hostname === host ? page.href.split('#')[0] : `${page.origin}/`;
  } catch { return; }
  const id = nextRuleId++;
  (headerRules[scope] = headerRules[scope] || []).push(id);
  persist();
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id, priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: referer },
          { header: 'Origin', operation: 'set', value: origin },
        ],
      },
      condition: { requestDomains: [host], tabIds: [TAB_NONE], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
    }],
  });
}

async function clearHeaders(scope) {
  const ids = headerRules[scope];
  if (!ids?.length) return;
  delete headerRules[scope];
  persist();
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- jobs

function publicJob(job) {
  const { blobUrl, ...rest } = job;
  return rest;
}

function notifyJob(job) {
  persist();
  const msg = { type: 'job:update', job: publicJob(job) };
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (job.tabId >= 0) chrome.tabs.sendMessage(job.tabId, msg).catch(() => {});
}

async function startDownload(tabId, itemId, { variantIndex = 0, audioOnly = false } = {}) {
  const t = tabs.get(tabId);
  const item = t?.items[itemId];
  if (!item) return { ok: false, error: 'That video is no longer in the list. Play it again and retry.' };
  if (item.drm) return { ok: false, error: 'This video is DRM-protected and cannot be saved.' };

  const running = [...jobs.values()].find((j) => j.tabId === tabId && j.itemId === itemId && j.audioOnly === audioOnly && ['queued', 'running', 'saving'].includes(j.state));
  if (running) return { ok: true, jobId: running.id };

  const variant = item.variants?.[variantIndex] || item.variants?.[0] || null;
  const job = {
    id: nextJobId++, tabId, itemId, audioOnly,
    title: fileBase(item.title),
    quality: variant?.label || '',
    state: 'running', stage: 'Starting', fraction: 0, started: Date.now(),
  };
  jobs.set(job.id, job);

  const spec = { id: job.id, kind: item.kind, pageUrl: item.pageUrl, audioOnly, variantIndex };
  if (item.kind === 'direct') {
    spec.url = variant?.url || item.url;
    spec.audioUrl = item.audioUrl;
    const others = Object.values(t.items).filter((o) => o.kind === 'direct' && o.source === 'network' && o.id !== item.id && o.hidden !== 'segment');
    others.sort((a, b) => (a.role === 'audio' ? 0 : 1) - (b.role === 'audio' ? 0 : 1) || b.ts - a.ts);
    spec.companions = item.source === 'network' ? others.map((o) => o.url) : [];
  } else {
    spec.url = item.url;
    spec.xml = item.xml;
  }

  notifyJob(job);
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'job:start', job: spec });
  } catch (err) {
    job.state = 'error';
    job.error = `Could not start the download (${err?.message || err}).`;
    notifyJob(job);
  }
  return { ok: true, jobId: job.id };
}

async function finishJob(job, msg) {
  job.state = 'saving';
  job.stage = 'Saving';
  job.fraction = 1;
  job.size = msg.size;
  job.duration = msg.duration;
  job.warnings = msg.warnings || [];
  const quality = msg.height && !job.audioOnly ? ` ${msg.height}p` : '';
  job.filename = `${job.title}${quality}.${msg.ext}`;
  notifyJob(job);
  try {
    job.downloadId = await chrome.downloads.download({ url: msg.blobUrl, filename: job.filename, conflictAction: 'uniquify', saveAs: false });
    persist();
  } catch (err) {
    job.state = 'error';
    job.error = `Chrome refused to save the file (${err?.message || err}).`;
    notifyJob(job);
    releaseJob(job);
  }
}

function releaseJob(job) {
  clearHeaders(`job-${job.id}`);
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'job:release', id: job.id }).catch(() => {});
  // Forget finished jobs after a while so the list stays short.
  setTimeout(() => { jobs.delete(job.id); persist(); }, 10 * 60 * 1000);
}

chrome.downloads.onChanged.addListener(async (delta) => {
  await ready;
  const job = [...jobs.values()].find((j) => j.downloadId === delta.id);
  if (!job || !delta.state) return;
  if (delta.state.current === 'complete') {
    job.state = 'done';
    job.stage = 'Saved';
    notifyJob(job);
    releaseJob(job);
  } else if (delta.state.current === 'interrupted') {
    job.state = 'error';
    job.error = 'Chrome could not write the file to your Downloads folder.';
    notifyJob(job);
    releaseJob(job);
  }
});

// ---------------------------------------------------------------- overlay matching

/** Which detected item is the <video> the user pointed at? */
function pickFor(tabId, tab, frameId, { duration, src }) {
  let items = visibleItems(tabId).filter((i) => !i.drm);
  if (src && /^https?:/i.test(src) && !isBlockedSite(tab?.url || '')) {
    const key = urlKey(wholeFileUrl(src).url);
    let exact = items.find((i) => i.kind === 'direct' && (urlKey(i.url) === key || i.variants?.some((v) => urlKey(v.url) === key)));
    if (!exact) {
      // A plain <video src>: usable as-is even if we never saw the request (cached, preloaded).
      exact = addItem(tabId, {
        id: hash(`direct|${key}`), kind: 'direct', source: 'network', url: src, role: 'video',
        title: tab?.title || '', pageUrl: tab?.url || '', ts: Date.now(), frameId,
      });
    }
    if (!exact.hidden) return { match: [exact], others: [] };
    items = visibleItems(tabId).filter((i) => !i.drm);
  }
  const close = (i) => duration > 0 && i.duration > 0 && Math.abs(i.duration - duration) <= Math.max(1, duration * 0.02);
  const match = items.filter(close).sort((a, b) => (a.source === 'page' ? 0 : 1) - (b.source === 'page' ? 0 : 1));
  return { match: match.slice(0, 1), others: items.filter((i) => !match.includes(i)).slice(0, 5) };
}

function summary(item) {
  return {
    id: item.id, kind: item.kind, source: item.source, title: cleanTitle(item.title), duration: item.duration || 0,
    size: item.size || 0, drm: !!item.drm, live: !!item.live, thumb: item.thumb,
    variants: (item.variants || []).map((v) => ({ label: v.label, height: v.height })),
    pending: !!item.inspecting,
    host: (() => { try { return new URL(item.url).hostname; } catch { return ''; } })(),
  };
}

// ---------------------------------------------------------------- messages

async function handle(msg, sender) {
  await ready;
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    // from the offscreen document
    case 'offscreen:keepalive': return { ok: true };
    case 'net:headers': await setHeaders(msg.scope, msg.host, msg.pageUrl); return { ok: true };
    case 'job:progress': {
      const job = jobs.get(msg.id);
      if (job && job.state === 'running') { job.stage = msg.stage; job.fraction = msg.fraction; notifyJob(job); }
      return { ok: true };
    }
    case 'item:audio': {
      const job = jobs.get(msg.jobId);
      const t = job && tabs.get(job.tabId);
      if (t) {
        const key = urlKey(msg.url);
        for (const item of Object.values(t.items)) if (item.kind === 'direct' && urlKey(item.url) === key) item.role = 'audio';
        persist(job.tabId);
        updateBadge(job.tabId);
      }
      return { ok: true };
    }
    case 'job:done': {
      const job = jobs.get(msg.id);
      if (job) await finishJob(job, msg);
      return { ok: true };
    }
    case 'job:error': {
      const job = jobs.get(msg.id);
      if (job) {
        job.state = msg.cancelled ? 'cancelled' : 'error';
        job.error = msg.message;
        notifyJob(job);
        releaseJob(job);
      }
      return { ok: true };
    }

    // from content scripts
    case 'page:items': addPageItems(tabId, sender.tab, sender.frameId, msg.items || []); return { ok: true };
    case 'overlay:pick': {
      if (isBlockedSite(sender.tab?.url || '')) return { blocked: true, match: [], others: [] };
      const { match, others } = pickFor(tabId, sender.tab, sender.frameId, msg);
      return { match: match.map(summary), others: others.map(summary) };
    }

    // from the popup and the overlay
    case 'state': {
      let tab = null;
      try { tab = await chrome.tabs.get(tabId); } catch { /* closed */ }
      return {
        blocked: isBlockedSite(tab?.url || ''),
        capturable: /^https?:/i.test(tab?.url || ''),
        items: visibleItems(tabId).map(summary),
        jobs: [...jobs.values()].sort((a, b) => b.id - a.id).slice(0, 12).map(publicJob),
      };
    }
    case 'download': return startDownload(tabId, msg.itemId, msg);
    case 'job:cancel': {
      const job = jobs.get(msg.id);
      if (job?.state === 'running') await chrome.runtime.sendMessage({ target: 'offscreen', type: 'job:cancel', id: msg.id }).catch(() => {});
      return { ok: true };
    }
    case 'job:dismiss': jobs.delete(msg.id); persist(); return { ok: true };
    case 'capture:arm': {
      await chrome.tabs.sendMessage(tabId, { type: 'capture:arm' }).catch(() => {});
      return { ok: true };
    }
    default: return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen' || sender.id !== chrome.runtime.id) return undefined;
  if (msg.type === 'job:update') return undefined; // our own broadcast
  handle(msg, sender).then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});
