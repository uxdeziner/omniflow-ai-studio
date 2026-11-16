// MPEG-DASH manifest (MPD) parser. Needs DOMParser, so it runs in documents, not the service worker.

function isoDuration(text) {
  if (!text) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text.trim());
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

function resolveBase(el, base) {
  const b = kid(el, 'BaseURL');
  if (!b || !b.textContent.trim()) return base;
  try { return new URL(b.textContent.trim(), base).href; } catch { return base; }
}

function fill(template, vars) {
  return template.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (all, name, pad) => {
    if (name === '') return '$';
    if (!(name in vars)) return all;
    const v = String(vars[name]);
    return pad ? v.padStart(Number(pad), '0') : v;
  });
}

function parseRange(text) {
  if (!text) return null;
  const [a, b] = text.split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { offset: a, length: b - a + 1 };
}

function fromTemplate(tpl, inherited, rep, base, periodDuration) {
  const attr = (n) => tpl.getAttribute(n) ?? inherited?.getAttribute(n) ?? null;
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const timescale = Number(attr('timescale')) || 1;
  const startNumber = attr('startNumber') !== null ? Number(attr('startNumber')) : 1;
  const media = attr('media');
  const initialization = attr('initialization');
  if (!media) return null;
  const abs = (t, extra) => new URL(fill(t, { ...vars, ...extra }), base).href;
  const init = initialization ? { url: abs(initialization, {}), range: null } : null;
  const segments = [];
  const timeline = kid(tpl, 'SegmentTimeline') || kid(inherited, 'SegmentTimeline');
  if (timeline) {
    let time = 0;
    let number = startNumber;
    for (const s of kids(timeline, 'S')) {
      if (s.hasAttribute('t')) time = Number(s.getAttribute('t'));
      const d = Number(s.getAttribute('d'));
      let repeat = Number(s.getAttribute('r')) || 0;
      if (repeat < 0) repeat = Math.max(0, Math.ceil((periodDuration * timescale - time) / d) - 1);
      for (let i = 0; i <= repeat; i++) {
        segments.push({ url: abs(media, { Number: number, Time: time }), range: null });
        time += d;
        number++;
      }
    }
  } else {
    const d = Number(attr('duration'));
    if (!d || !periodDuration) return null;
    const count = Math.ceil((periodDuration * timescale) / d - 1e-6);
    for (let i = 0; i < count; i++) {
      segments.push({ url: abs(media, { Number: startNumber + i, Time: i * d }), range: null });
    }
  }
  return { init, segments, single: null };
}

function fromList(list, base) {
  const initEl = kid(list, 'Initialization');
  const init = initEl
    ? { url: new URL(initEl.getAttribute('sourceURL') || '', base).href, range: parseRange(initEl.getAttribute('range')) }
    : null;
  const segments = kids(list, 'SegmentURL').map((s) => ({
    url: new URL(s.getAttribute('media') || '', base).href,
    range: parseRange(s.getAttribute('mediaRange')),
  }));
  return segments.length ? { init, segments, single: null } : null;
}

/**
 * @param {string} xml  MPD document text
 * @param {string} baseUrl  URL the manifest was loaded from (or the page URL for inline manifests)
 * @returns {{duration:number, drm:boolean, live:boolean, video:Array, audio:Array}}
 */
export function parseMpd(xml, baseUrl) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Not a DASH manifest.');
  const live = mpd.getAttribute('type') === 'dynamic';
  const mpdBase = resolveBase(mpd, baseUrl);
  const period = kid(mpd, 'Period');
  if (!period) throw new Error('DASH manifest has no Period.');
  const duration = isoDuration(period.getAttribute('duration')) || isoDuration(mpd.getAttribute('mediaPresentationDuration'));
  const periodBase = resolveBase(period, mpdBase);
  const result = { duration, drm: false, live, video: [], audio: [], periods: kids(mpd, 'Period').length };

  for (const set of kids(period, 'AdaptationSet')) {
    const setBase = resolveBase(set, periodBase);
    const setProtected = kids(set, 'ContentProtection').length > 0;
    for (const repEl of kids(set, 'Representation')) {
      const mime = repEl.getAttribute('mimeType') || set.getAttribute('mimeType') || '';
      const contentType = set.getAttribute('contentType') || kid(set, 'ContentComponent')?.getAttribute('contentType') || '';
      const codecs = repEl.getAttribute('codecs') || set.getAttribute('codecs') || '';
      const width = Number(repEl.getAttribute('width') || set.getAttribute('width')) || 0;
      const height = Number(repEl.getAttribute('height') || set.getAttribute('height')) || 0;
      let type = contentType || mime.split('/')[0];
      if (type !== 'video' && type !== 'audio') {
        type = width || /^(avc|hev|hvc|vp0?9|av01)/.test(codecs) ? 'video' : /^(mp4a|opus|ac-3|ec-3|vorbis)/.test(codecs) ? 'audio' : '';
      }
      if (type !== 'video' && type !== 'audio') continue; // subtitles, thumbnails, ...
      const rep = {
        id: repEl.getAttribute('id') || '',
        bandwidth: Number(repEl.getAttribute('bandwidth')) || 0,
        width, height, codecs, mime,
        language: set.getAttribute('lang') || '',
      };
      if (setProtected || kids(repEl, 'ContentProtection').length) result.drm = true;
      const repBase = resolveBase(repEl, setBase);
      const tpl = kid(repEl, 'SegmentTemplate') || kid(set, 'SegmentTemplate') || kid(period, 'SegmentTemplate');
      const inherited = tpl && tpl.parentElement === repEl ? (kid(set, 'SegmentTemplate') || kid(period, 'SegmentTemplate')) : null;
      const list = kid(repEl, 'SegmentList') || kid(set, 'SegmentList');
      let plan = null;
      try {
        if (tpl) plan = fromTemplate(tpl, inherited, rep, repBase, duration);
        else if (list) plan = fromList(list, repBase);
      } catch { plan = null; }
      // No segment addressing: the BaseURL is the whole track in a single file.
      if (!plan && repBase !== setBase) plan = { init: null, segments: [], single: repBase };
      if (!plan) continue;
      result[type].push({ ...rep, ...plan });
    }
  }
  result.video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  result.audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return result;
}

/** Best audio representation for a chosen video one (prefers AAC next to H.264 for MP4 output). */
export function audioForRepresentation(mpd, video) {
  if (!mpd.audio.length) return null;
  const wantAac = !video || /^(avc|hev|hvc)/.test(video.codecs);
  const preferred = mpd.audio.filter((a) => (wantAac ? /^mp4a/.test(a.codecs) : /^(opus|vorbis)/.test(a.codecs)));
  return (preferred.length ? preferred : mpd.audio)[0];
}
