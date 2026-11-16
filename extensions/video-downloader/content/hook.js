// Runs in the page's own JavaScript world.
//  1. On supported social sites, reads the video addresses out of the data the site itself
//     loads (the same JSON the site's player uses).
//  2. In record mode, keeps a copy of the media the page feeds to its player (Media Source
//     Extensions), for sites whose streams cannot be addressed by URL.
(() => {
  if (window.__ofvsHook) return;
  window.__ofvsHook = true;

  const CONFIG = globalThis.OFVS_CONFIG || {};
  const host = location.hostname;
  if (!CONFIG.youtube && /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(host)) return;

  const post = (type, data, transfer) => window.postMessage({ __ofvs: 'hook', type, ...data }, '*', transfer);

  // ------------------------------------------------------------ site data extractors

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
  const http = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
  const decode = (v) => (typeof v === 'string' ? v.replace(/&amp;/g, '&') : v);

  const twitter = {
    keys: ['video_info'],
    visit(o) {
      const info = o.video_info;
      if (!info || !Array.isArray(info.variants)) return null;
      const mp4 = info.variants.filter((v) => v && v.content_type === 'video/mp4' && http(v.url));
      const duration = num(info.duration_millis) / 1000;
      const thumb = http(o.media_url_https) ? o.media_url_https : undefined;
      if (mp4.length) {
        const variants = mp4.map((v) => {
          const size = /\/(\d{2,5})x(\d{2,5})\//.exec(v.url);
          return { url: v.url, bandwidth: num(v.bitrate), width: size ? +size[1] : 0, height: size ? Math.min(+size[1], +size[2]) : 0 };
        }).sort((a, b) => b.bandwidth - a.bandwidth);
        return { kind: 'direct', url: variants[0].url, variants, duration, thumb };
      }
      const hls = info.variants.find((v) => v && /mpegurl/i.test(v.content_type || '') && http(v.url));
      return hls ? { kind: 'hls', url: hls.url, duration, thumb } : null;
    },
  };

  const instagram = {
    keys: ['video_versions', 'video_url', 'video_dash_manifest'],
    visit(o) {
      const thumb = o.image_versions2?.candidates?.[0]?.url || o.display_url || o.thumbnail_src;
      const title = typeof o.caption?.text === 'string' ? o.caption.text : undefined;
      const duration = num(o.video_duration);
      if (Array.isArray(o.video_versions) && o.video_versions.length) {
        const seen = new Set();
        const variants = o.video_versions
          .filter((v) => v && http(v.url) && !seen.has(v.url) && seen.add(v.url))
          .map((v) => ({ url: v.url, width: num(v.width), height: Math.min(num(v.width) || Infinity, num(v.height) || Infinity) || 0 }))
          .map((v) => ({ ...v, height: isFinite(v.height) ? v.height : 0 }))
          .sort((a, b) => b.width - a.width);
        if (variants.length) return { kind: 'direct', url: variants[0].url, variants, duration, thumb, title };
      }
      if (http(o.video_url) && (o.is_video || /Video/.test(o.__typename || ''))) {
        return { kind: 'direct', url: o.video_url, duration, thumb, title };
      }
      if (typeof o.video_dash_manifest === 'string' && o.video_dash_manifest.includes('<MPD') && !o.video_versions) {
        return { kind: 'dash', url: location.href, xml: o.video_dash_manifest, duration, thumb, title };
      }
      return null;
    },
  };

  const facebook = {
    keys: ['browser_native_hd_url', 'browser_native_sd_url', 'playable_url', 'playable_url_quality_hd', 'progressive_urls', 'dash_manifest', 'dash_manifest_xml_string', 'manifest_xml'],
    visit(o) {
      const variants = [];
      const add = (url, label, height) => { if (http(url) && !variants.some((v) => v.url === url)) variants.push({ url, label, height }); };
      add(o.browser_native_hd_url, 'HD', 720);
      add(o.playable_url_quality_hd, 'HD', 720);
      if (Array.isArray(o.progressive_urls)) {
        for (const p of o.progressive_urls) {
          const hd = /hd/i.test(p?.metadata?.quality || '');
          add(p?.progressive_url, hd ? 'HD' : 'SD', hd ? 720 : 360);
        }
      }
      add(o.browser_native_sd_url, 'SD', 360);
      add(o.playable_url, 'SD', 360);
      const duration = num(o.playable_duration_in_ms) / 1000 || num(o.length_in_second);
      const thumb = o.preferred_thumbnail?.image?.uri || o.thumbnailImage?.uri;
      if (variants.length) {
        variants.sort((a, b) => b.height - a.height);
        return { kind: 'direct', url: variants[0].url, variants, duration, thumb };
      }
      const xml = [o.dash_manifest, o.dash_manifest_xml_string, o.manifest_xml].find((x) => typeof x === 'string' && x.includes('<MPD'));
      // Only when nothing simpler exists on this object (progressive files already carry sound).
      if (xml && !o.progressive_urls) return { kind: 'dash', url: location.href, xml, duration, thumb };
      return null;
    },
  };

  const tiktok = {
    keys: ['playAddr', 'PlayAddr'],
    visit(o) {
      if (!http(o.playAddr)) return null;
      const variants = [];
      if (Array.isArray(o.bitrateInfo)) {
        for (const b of o.bitrateInfo) {
          const url = b?.PlayAddr?.UrlList?.find(http);
          if (url) variants.push({ url, bandwidth: num(b.Bitrate), height: Math.min(num(b.PlayAddr.Width) || 0, num(b.PlayAddr.Height) || 0), label: b.GearName ? String(b.GearName).replace(/_/g, ' ').slice(0, 20) : undefined });
        }
        variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
      }
      if (!variants.length) variants.push({ url: o.playAddr, height: Math.min(num(o.width), num(o.height)) });
      return { kind: 'direct', url: variants[0].url, variants, duration: num(o.duration), thumb: http(o.cover) ? o.cover : undefined };
    },
  };

  const reddit = {
    keys: ['dash_url', 'hls_url'],
    visit(o) {
      const duration = num(o.duration);
      if (http(o.dash_url)) return { kind: 'dash', url: decode(o.dash_url), duration };
      if (http(o.hls_url)) return { kind: 'hls', url: decode(o.hls_url), duration };
      return null;
    },
  };

  const SITES = [
    [/(^|\.)(x\.com|twitter\.com)$/, twitter],
    [/(^|\.)(instagram\.com|threads\.net|threads\.com)$/, instagram],
    [/(^|\.)(facebook\.com|fb\.com|fb\.watch|messenger\.com)$/, facebook],
    [/(^|\.)tiktok\.com$/, tiktok],
    [/(^|\.)reddit\.com$/, reddit],
  ];
  const site = (SITES.find(([re]) => re.test(host)) || [])[1] || null;

  const sent = new Set();
  let outbox = [];
  let flushTimer = null;
  function emit(item) {
    const id = item.xml ? `xml:${item.xml.length}:${item.xml.slice(0, 200)}` : item.url;
    if (sent.has(id)) return;
    if (sent.size > 3000) sent.clear();
    sent.add(id);
    outbox.push(item);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const items = outbox;
        outbox = [];
        post('items', { items });
      }, 150);
    }
  }

  function walk(root) {
    const stack = [root];
    let budget = 250000;
    while (stack.length && budget-- > 0) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) {
        for (let i = o.length - 1; i >= 0; i--) if (o[i] && typeof o[i] === 'object') stack.push(o[i]);
        continue;
      }
      try {
        const item = site.visit(o);
        if (item) emit(item);
      } catch { /* malformed node */ }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }

  function scanText(text) {
    if (typeof text !== 'string' || text.length < 20 || text.length > 12 * 1024 * 1024) return;
    if (!site.keys.some((k) => text.includes(`"${k}"`))) return;
    const body = text.replace(/^for \(;;\);/, '');
    try { walk(JSON.parse(body)); return; } catch { /* maybe several JSON documents, one per line */ }
    for (const line of body.split('\n')) {
      if (line.length < 20 || !site.keys.some((k) => line.includes(`"${k}"`))) continue;
      try { walk(JSON.parse(line)); } catch { /* not JSON */ }
    }
  }
  const later = (fn) => setTimeout(fn, 0);

  if (site) {
    const textual = (type) => /json|javascript|text\/plain|text\/html/i.test(type || '');

    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        p.then((res) => {
          try {
            if (!res || !res.ok || !textual(res.headers.get('content-type'))) return;
            res.clone().text().then((t) => later(() => scanText(t)), () => {});
          } catch { /* opaque response */ }
        }, () => {});
        return p;
      };
    }

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const t = this.responseText;
            later(() => scanText(t));
          } else if (this.responseType === 'json' && this.response) {
            const r = this.response;
            later(() => walk(r));
          }
        } catch { /* ignore */ }
      });
      return origSend.apply(this, args);
    };

    // Data embedded in the page itself.
    const scanScripts = (rootNode) => {
      const list = rootNode.querySelectorAll ? rootNode.querySelectorAll('script[type="application/json"]') : [];
      for (const s of list) {
        if (s.__ofvsSeen) continue;
        s.__ofvsSeen = true;
        const t = s.textContent;
        later(() => scanText(t));
      }
    };
    const start = () => {
      scanScripts(document);
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'SCRIPT') {
              if (n.type === 'application/json' && !n.__ofvsSeen) { n.__ofvsSeen = true; const t = n.textContent; later(() => scanText(t)); }
            } else if (n.firstElementChild) {
              scanScripts(n);
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  // ------------------------------------------------------------ record mode (MSE capture)

  let armed = false;
  try { armed = sessionStorage.getItem('__ofvs_capture') === '1'; } catch { /* storage blocked */ }

  const sources = new Map(); // MediaSource -> { buffers: [], bytes }
  const urls = new Map(); // blob: URL -> MediaSource
  const MAX_CAPTURE_BYTES = 3.5 * 1024 * 1024 * 1024;

  if (armed && typeof MediaSource === 'function' && typeof SourceBuffer === 'function') {
    const startsNewStream = (u8) => {
      if (u8.length < 8) return false;
      if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return true; // WebM/EBML header
      const type = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
      return type === 'ftyp' || type === 'moov';
    };

    const origAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.apply(this, arguments);
      try {
        let rec = sources.get(this);
        if (!rec) { rec = { buffers: [], bytes: 0 }; sources.set(this, rec); }
        const buf = { mime: String(mime), sections: [], hasMedia: false };
        rec.buffers.push(buf);
        sb.__ofvs = { rec, buf };
      } catch { /* never break the page */ }
      return sb;
    };

    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        const meta = this.__ofvs;
        if (meta && meta.rec.bytes < MAX_CAPTURE_BYTES) {
          const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const { buf, rec } = meta;
          if (startsNewStream(view)) {
            // New initialisation data: the player (re)starts a stream, e.g. after a quality switch.
            const last = buf.sections[buf.sections.length - 1];
            if (!last || buf.hasMedia) buf.sections.push([]);
            else last.length = 0; // previous section held only an init segment: replace it
            buf.hasMedia = false;
          } else {
            if (!buf.sections.length) buf.sections.push([]);
            buf.hasMedia = true;
          }
          buf.sections[buf.sections.length - 1].push(new Blob([view]));
          rec.bytes += view.byteLength;
        }
      } catch { /* never break the page */ }
      return origAppend.apply(this, arguments);
    };

    const origChange = SourceBuffer.prototype.changeType;
    if (origChange) {
      SourceBuffer.prototype.changeType = function (mime) {
        try { if (this.__ofvs) this.__ofvs.buf.mime = String(mime); } catch { /* ignore */ }
        return origChange.apply(this, arguments);
      };
    }

    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = origCreate.apply(this, arguments);
      try { if (obj instanceof MediaSource) urls.set(url, obj); } catch { /* ignore */ }
      return url;
    };
  }

  function findSource(src) {
    if (src && urls.has(src)) return urls.get(src);
    let best = null;
    for (const [ms, rec] of sources) if (!best || rec.bytes > sources.get(best).bytes) best = ms;
    return best;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__ofvs !== 'content') return;
    const msg = event.data;
    if (msg.type === 'capture:status') {
      const ms = findSource(msg.src);
      const rec = ms ? sources.get(ms) : null;
      post('capture:status', { armed, known: !!(msg.src && urls.has(msg.src)), bytes: rec ? rec.bytes : 0, tracks: rec ? rec.buffers.length : 0 });
    } else if (msg.type === 'capture:collect') {
      const ms = findSource(msg.src);
      const rec = ms ? sources.get(ms) : null;
      const tracks = rec
        ? rec.buffers.map((b) => ({ mime: b.mime, sections: b.sections.filter((s) => s.length > 1 || (s.length === 1 && b.sections.length === 1)).map((s) => new Blob(s)) }))
        : [];
      post('capture:data', { tracks, bytes: rec ? rec.bytes : 0 });
    }
  });
})();
