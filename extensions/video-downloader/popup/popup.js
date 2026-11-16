// Toolbar popup: lists the videos found in the active tab and the downloads in progress.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

const fmtTime = (s) => {
  if (!(s > 0)) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtSize = (b) => (b > 0 ? (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 104857600 ? 0 : 1)} MB` : `${Math.round(b / 1024)} KB`) : '');
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let tabId = null;
const chosen = new Map(); // item id -> selected quality index
let lastItemsKey = '';

function renderItems(items) {
  const key = JSON.stringify(items);
  if (key === lastItemsKey) return; // keep open <select> menus stable between refreshes
  lastItemsKey = key;
  const box = $('items');
  box.textContent = '';
  for (const item of items) {
    const card = el('div', 'card');
    const thumb = el('div', 'thumb', item.kind === 'direct' ? 'VIDEO' : 'STREAM');
    if (item.thumb) {
      const img = el('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => { thumb.textContent = ''; thumb.appendChild(img); };
      img.src = item.thumb;
    }
    card.appendChild(thumb);

    const body = el('div', 'body');
    body.appendChild(el('div', 'title', item.title || item.host || 'Video'));
    const meta = [fmtTime(item.duration), fmtSize(item.size), item.live ? 'live' : '', item.host].filter(Boolean).join(' · ');
    body.appendChild(el('div', 'meta', item.drm ? 'DRM-protected, cannot be saved' : (item.pending ? 'Reading stream details…' : meta)));

    const actions = el('div', 'actions');
    let select = null;
    if (item.variants.length > 1) {
      select = el('select');
      select.setAttribute('aria-label', 'Quality');
      item.variants.forEach((v, i) => {
        const o = el('option', '', v.label);
        o.value = String(i);
        select.appendChild(o);
      });
      select.value = String(chosen.get(item.id) ?? 0);
      select.onchange = () => chosen.set(item.id, Number(select.value));
      actions.appendChild(select);
    } else if (item.variants.length === 1) {
      actions.appendChild(el('span', 'meta', item.variants[0].label));
    }
    actions.appendChild(el('span', 'spacer'));
    const audio = el('button', 'ghost', 'Audio only');
    const video = el('button', 'primary', 'Download');
    audio.disabled = video.disabled = item.drm;
    const go = (audioOnly) => async () => {
      video.disabled = audio.disabled = true;
      const res = await send({ type: 'download', tabId, itemId: item.id, variantIndex: select ? Number(select.value) : 0, audioOnly });
      video.disabled = audio.disabled = false;
      if (res && !res.ok) showNotice(res.error);
      refresh();
    };
    audio.onclick = go(true);
    video.onclick = go(false);
    actions.append(audio, video);
    body.appendChild(actions);
    card.appendChild(body);
    box.appendChild(card);
  }
}

function renderJobs(all) {
  // Downloads in progress anywhere, plus this tab's recent results. Other tabs' history stays out of the way.
  const active = (j) => j.state === 'running' || j.state === 'saving';
  const jobs = all.filter((j) => active(j) || j.tabId === tabId)
    .sort((a, b) => (active(b) - active(a)) || (b.id - a.id))
    .slice(0, 5);
  const box = $('jobs');
  box.hidden = !jobs.length;
  box.textContent = '';
  for (const job of jobs) {
    const row = el('div', `job ${job.state}`);
    const top = el('div', 'top');
    top.appendChild(el('div', 'name', job.filename || `${job.title}${job.audioOnly ? ' (audio)' : ''}`));
    const active = job.state === 'running';
    const link = el('button', 'link', active ? 'Cancel' : 'Clear');
    link.onclick = async () => { await send({ type: active ? 'job:cancel' : 'job:dismiss', id: job.id }); refresh(); };
    if (job.state !== 'saving') top.appendChild(link);
    row.appendChild(top);

    let state = '';
    if (job.state === 'running') state = `${job.stage}… ${Math.round((job.fraction || 0) * 100)}%`;
    else if (job.state === 'saving') state = 'Saving to Downloads…';
    else if (job.state === 'done') state = [`Saved to Downloads`, fmtSize(job.size), fmtTime(job.duration)].filter(Boolean).join(' · ');
    else if (job.state === 'cancelled') state = 'Cancelled';
    else state = job.error || 'Failed';
    row.appendChild(el('div', 'state', state));
    for (const w of job.warnings || []) row.appendChild(el('div', 'state', w));

    if (job.state === 'running' || job.state === 'saving') {
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = `${Math.round((job.fraction || 0) * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    box.appendChild(row);
  }
}

function showNotice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

async function refresh() {
  const state = await send({ type: 'state', tabId });
  if (!state) return;
  $('record').disabled = !state.capturable || state.blocked;
  if (state.blocked) {
    showNotice('This edition of the extension does not save videos from this site, in line with Chrome Web Store rules.');
    $('items').textContent = '';
    $('empty').hidden = true;
    renderJobs(state.jobs);
    return;
  }
  renderItems(state.items);
  renderJobs(state.jobs);
  $('empty').hidden = state.items.length > 0 || !$('jobs').hidden;
}

$('record').onclick = async () => {
  await send({ type: 'capture:arm', tabId });
  window.close();
};

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id ?? null;
await refresh();
setInterval(refresh, 700);
