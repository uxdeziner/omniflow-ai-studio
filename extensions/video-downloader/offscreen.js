// Offscreen document: does the heavy lifting (fetching, decrypting, merging) so downloads keep
// running when the popup closes and the service worker sleeps.
import { audioFor, isMasterPlaylist, looksLikePlaylist, parseMaster, parseMedia, segmentIv } from './lib/hls.js';
import { audioForRepresentation, parseMpd } from './lib/dash.js';
import { downloadFile, fetchBytes, fetchText, pool } from './lib/net.js';
import { probe, remux } from './lib/mux.js';
import { ALL_FORMATS, Input, UrlSource } from './vendor/mediabunny.min.mjs';

const SEGMENT_CONCURRENCY = 6;
const jobs = new Map(); // id -> { controller, blobUrl }

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// Keep the service worker awake while work is in flight.
setInterval(() => { if (jobs.size) send({ type: 'offscreen:keepalive' }); }, 20000);

/** Make sure the Referer rule for this host is in place before we talk to it. */
function headerPreparer(scope, pageUrl) {
  const ready = new Map();
  return (url) => {
    let host;
    try { host = new URL(url).hostname; } catch { return Promise.resolve(); }
    if (!ready.has(host)) {
      ready.set(host, chrome.runtime.sendMessage({ type: 'net:headers', scope, host, pageUrl }).catch(() => {}));
    }
    return ready.get(host);
  };
}

function qualityLabel(height, bandwidth) {
  if (height) return `${height}p`;
  if (bandwidth) return `${Math.round(bandwidth / 1000)} kbps`;
  return 'Default';
}

// ---------------------------------------------------------------- inspect

async function inspect({ kind, url, xml, pageUrl, scope }) {
  const prepare = headerPreparer(scope, pageUrl);
  if (kind === 'hls') {
    const text = await fetchText(url, { prepare, retries: 1 });
    if (!looksLikePlaylist(text)) throw new Error('Not an HLS playlist.');
    if (isMasterPlaylist(text)) {
      const master = parseMaster(text, url);
      let duration = 0;
      let drm = master.drm;
      let live = false;
      if (master.variants[0]) {
        try {
          const media = parseMedia(await fetchText(master.variants[0].url, { prepare, retries: 1 }), master.variants[0].url);
          duration = media.duration;
          drm = drm || media.drm;
          live = media.live;
        } catch { /* duration stays unknown */ }
      }
      return {
        master: true,
        duration, drm, live,
        variants: master.variants.map((v) => ({ label: qualityLabel(v.height, v.bandwidth), height: v.height, width: v.width, bandwidth: v.bandwidth })),
        children: [...master.variants.map((v) => v.url), ...master.audio.map((a) => a.url).filter(Boolean)],
      };
    }
    const media = parseMedia(text, url);
    return { master: false, duration: media.duration, drm: media.drm, live: media.live, variants: [], children: [], segments: media.segments.length };
  }
  if (kind === 'dash') {
    const text = xml || await fetchText(url, { prepare, retries: 1 });
    const mpd = parseMpd(text, url);
    const children = [];
    for (const rep of [...mpd.video, ...mpd.audio]) if (rep.single) children.push(rep.single);
    return {
      duration: mpd.duration, drm: mpd.drm, live: mpd.live, children,
      variants: mpd.video.map((v) => ({ label: qualityLabel(v.height, v.bandwidth), height: v.height, width: v.width, bandwidth: v.bandwidth })),
    };
  }
  throw new Error('Nothing to inspect.');
}

// ---------------------------------------------------------------- segment tracks

/** Byte-weighted progress shared by the parallel tracks of one job. */
function progressMeter(report) {
  const tracks = [];
  return (weight) => {
    const t = { weight, fraction: 0 };
    tracks.push(t);
    return (fraction) => {
      t.fraction = fraction;
      const sum = tracks.reduce((a, x) => a + x.weight, 0);
      report(tracks.reduce((a, x) => a + x.fraction * x.weight, 0) / sum);
    };
  };
}

async function downloadHlsTrack(url, text, ctx, onFraction) {
  const media = parseMedia(text ?? await fetchText(url, ctx), url);
  if (media.drm) throw new Error(`This stream is DRM-protected (${media.drmMethod}) and cannot be saved.`);
  if (!media.segments.length) throw new Error('The playlist lists no video segments.');

  const keys = new Map();
  const getKey = (keyUrl) => {
    if (!keys.has(keyUrl)) {
      keys.set(keyUrl, fetchBytes(keyUrl, ctx).then((raw) => {
        if (raw.byteLength !== 16) throw new Error('The stream\'s decryption key was refused by the server.');
        return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      }));
    }
    return keys.get(keyUrl);
  };
  const inits = new Map();
  const getInit = (map) => {
    const id = `${map.url}|${map.range ? `${map.range.offset}+${map.range.length}` : ''}`;
    if (!inits.has(id)) inits.set(id, fetchBytes(map.url, { ...ctx, range: map.range }));
    return inits.get(id);
  };

  let done = 0;
  const pieces = await pool(media.segments, SEGMENT_CONCURRENCY, async (segment) => {
    let data = await fetchBytes(segment.url, { ...ctx, range: segment.range });
    if (segment.key) {
      const key = await getKey(segment.key.url);
      data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segmentIv(segment) }, key, data);
    }
    if (data.byteLength === 0) throw new Error('The server sent an empty video segment.');
    onFraction(++done / media.segments.length);
    return new Blob([data]);
  }, ctx.signal);

  // Each distinct init section starts a new self-contained stream (rare: mid-playlist changes).
  const streams = [];
  let currentInit = null;
  for (let i = 0; i < media.segments.length; i++) {
    const map = media.segments[i].map;
    const id = map ? `${map.url}|${map.range?.offset ?? ''}` : '';
    if (!streams.length || id !== currentInit) {
      streams.push(map ? [new Blob([await getInit(map)])] : []);
      currentInit = id;
    }
    streams[streams.length - 1].push(pieces[i]);
  }
  return { blobs: streams.map((s) => new Blob(s)), duration: media.duration, live: media.live };
}

async function downloadDashTrack(rep, ctx, onFraction) {
  if (rep.single) {
    const { blob } = await downloadFile(rep.single, { ...ctx, onProgress: (got, total) => total && onFraction(got / total) });
    return blob;
  }
  if (!rep.segments.length) throw new Error('The manifest lists no media segments.');
  const init = rep.init ? await fetchBytes(rep.init.url, { ...ctx, range: rep.init.range }) : null;
  let done = 0;
  const pieces = await pool(rep.segments, SEGMENT_CONCURRENCY, async (segment) => {
    const data = await fetchBytes(segment.url, { ...ctx, range: segment.range });
    if (data.byteLength === 0) throw new Error('The server sent an empty video segment.');
    onFraction(++done / rep.segments.length);
    return new Blob([data]);
  }, ctx.signal);
  return new Blob(init ? [init, ...pieces] : pieces);
}

// ---------------------------------------------------------------- job kinds

async function runHls(job, ctx, stage) {
  const text = await fetchText(job.url, ctx);
  if (!looksLikePlaylist(text)) throw new Error('The stream playlist is no longer available (reload the page and try again).');
  const track = progressMeter((f) => stage('Downloading', f));
  let video;
  let audio = null;
  let expected = 0;
  let live = false;

  if (isMasterPlaylist(text)) {
    const master = parseMaster(text, job.url);
    if (master.drm) throw new Error('This stream is DRM-protected and cannot be saved.');
    if (!master.variants.length) throw new Error('The stream offers no playable quality.');
    const variant = master.variants[Math.min(job.variantIndex ?? 0, master.variants.length - 1)];
    const rendition = audioFor(master, variant);
    if (job.audioOnly && rendition) {
      const a = await downloadHlsTrack(rendition.url, null, ctx, track(1));
      return { video: a.blobs, audioOnly: true, expected: a.duration, live: a.live };
    }
    const tasks = [downloadHlsTrack(variant.url, null, ctx, track(rendition ? 8 : 1))];
    if (rendition) tasks.push(downloadHlsTrack(rendition.url, null, ctx, track(1)));
    const [v, a] = await Promise.all(tasks);
    video = v.blobs;
    audio = a ? a.blobs : null;
    expected = v.duration;
    live = v.live;
  } else {
    const v = await downloadHlsTrack(job.url, text, ctx, track(1));
    video = v.blobs;
    expected = v.duration;
    live = v.live;
  }
  return { video, audio, audioOnly: !!job.audioOnly, expected, live };
}

async function runDash(job, ctx, stage) {
  const xml = job.xml || await fetchText(job.url, ctx);
  const mpd = parseMpd(xml, job.url);
  if (mpd.drm) throw new Error('This stream is DRM-protected and cannot be saved.');
  if (!mpd.video.length && !mpd.audio.length) throw new Error('The manifest offers no playable track.');
  const rep = mpd.video[Math.min(job.variantIndex ?? 0, Math.max(0, mpd.video.length - 1))] || null;
  const audioRep = audioForRepresentation(mpd, rep);
  const track = progressMeter((f) => stage('Downloading', f));
  if (job.audioOnly && audioRep) {
    return { video: await downloadDashTrack(audioRep, ctx, track(1)), audioOnly: true, expected: mpd.duration };
  }
  const tasks = [rep ? downloadDashTrack(rep, ctx, track(audioRep ? 8 : 1)) : null, audioRep ? downloadDashTrack(audioRep, ctx, track(1)) : null];
  const [video, audio] = await Promise.all(tasks);
  if (!video) return { video: audio, audioOnly: true, expected: mpd.duration };
  return { video, audio, audioOnly: !!job.audioOnly, expected: mpd.duration, live: mpd.live };
}

/** Find the separate audio file that belongs to a video-only file, by matching durations. */
async function findCompanionAudio(candidates, duration, ctx) {
  for (const url of candidates.slice(0, 8)) {
    if (ctx.signal.aborted) return null;
    let input;
    try {
      await ctx.prepare(url);
      input = new Input({
        source: new UrlSource(url, { requestInit: { credentials: 'include' }, getRetryDelay: () => null, handleUnhandledError: () => {} }),
        formats: ALL_FORMATS,
      });
      if (!(await input.canRead())) continue;
      if (await input.getPrimaryVideoTrack()) continue;
      const track = await input.getPrimaryAudioTrack();
      if (!track) continue;
      const d = await input.computeDuration([track]);
      if (Math.abs(d - duration) <= Math.max(1.5, duration * 0.03)) return url;
    } catch { /* not a match */ } finally {
      input?.dispose();
    }
  }
  return null;
}

async function runDirect(job, ctx, stage, warnings) {
  const track = progressMeter((f) => stage('Downloading', f));
  const videoProgress = track(8);
  const { blob } = await downloadFile(job.url, { ...ctx, onProgress: (got, total) => total && videoProgress(got / total) });
  stage('Checking', 1);
  const info = await probe(blob);
  if (!info.ok) throw new Error(info.reason);

  if (job.audioOnly) {
    if (!info.audio && !job.audioUrl) throw new Error('This video has no audio track.');
    if (info.audio) return { video: blob, audioOnly: true, expected: info.duration };
  }
  if (info.video && info.audio) {
    // Complete as served: keep the original bytes untouched.
    return { passthrough: blob, info, expected: info.duration };
  }
  if (!info.video && info.audio) {
    send({ type: 'item:audio', jobId: job.id, url: job.url });
    throw new Error('This entry is only the sound track of a video. It has been removed from the list; download the video entry instead.');
  }

  // Video without sound: the site delivers audio separately.
  let audioUrl = job.audioUrl || null;
  if (!audioUrl && job.companions?.length) {
    stage('Finding audio', 1);
    audioUrl = await findCompanionAudio(job.companions.filter((u) => u !== job.url), info.duration, ctx);
  }
  if (!audioUrl) {
    warnings.push('This source has no sound track, so the saved video is silent.');
    return { passthrough: blob, info, expected: info.duration };
  }
  send({ type: 'item:audio', jobId: job.id, url: audioUrl });
  const audioProgress = track(1);
  const audio = await downloadFile(audioUrl, { ...ctx, onProgress: (got, total) => total && audioProgress(got / total) });
  if (job.audioOnly) return { video: audio.blob, audioOnly: true, expected: info.duration };
  return { video: blob, audio: audio.blob, expected: info.duration };
}

const EXT_BY_FORMAT = { MP4: 'mp4', QuickTime: 'mov', WebM: 'webm', Matroska: 'mkv', 'MPEG-TS': 'ts', MP3: 'mp3', WAVE: 'wav', Ogg: 'ogg', FLAC: 'flac', ADTS: 'aac' };

async function runJob(job) {
  const controller = new AbortController();
  jobs.set(job.id, { controller, blobUrl: null });
  const warnings = [];
  let lastSent = 0;
  const stage = (name, fraction) => {
    const now = Date.now();
    if (fraction < 1 && now - lastSent < 200) return;
    lastSent = now;
    send({ type: 'job:progress', id: job.id, stage: name, fraction });
  };
  const ctx = { signal: controller.signal, prepare: headerPreparer(`job-${job.id}`, job.pageUrl) };

  try {
    stage('Starting', 0);
    let result;
    if (job.kind === 'hls') result = await runHls(job, ctx, stage);
    else if (job.kind === 'dash') result = await runDash(job, ctx, stage);
    else result = await runDirect(job, ctx, stage, warnings);

    let out;
    if (result.passthrough) {
      const info = result.info;
      out = {
        blob: result.passthrough,
        ext: EXT_BY_FORMAT[info.format] || 'mp4',
        duration: info.duration, hasVideo: !!info.video, hasAudio: !!info.audio,
        height: info.video?.height,
      };
    } else {
      stage('Merging', 0);
      out = await remux({
        video: result.video, audio: result.audio || undefined, audioOnly: result.audioOnly,
        onProgress: (f) => stage('Merging', f),
      });
      if (!result.audioOnly && !out.hasAudio) warnings.push('This source has no sound track, so the saved video is silent.');
    }

    // Final safety net: never hand over an empty or truncated file.
    if (!out.blob.size || !(out.duration > 0)) throw new Error('The result contained no playable video. Nothing was saved.');
    if (!result.audioOnly && !out.hasVideo) throw new Error('Only audio was found for this video. Nothing was saved.');
    if (result.expected > 0 && out.duration < result.expected * 0.9 - 1) {
      throw new Error(`Only ${Math.round(out.duration)}s of ${Math.round(result.expected)}s could be assembled. Nothing was saved; reload the page and try again.`);
    }
    if (result.live) warnings.push('This is a live stream: only the part available right now was saved.');

    const blobUrl = URL.createObjectURL(out.blob);
    jobs.get(job.id).blobUrl = blobUrl;
    send({
      type: 'job:done', id: job.id, blobUrl, ext: out.ext, size: out.blob.size,
      duration: out.duration, height: out.height || null, warnings,
    });
  } catch (err) {
    jobs.delete(job.id);
    const cancelled = err?.name === 'AbortError';
    send({ type: 'job:error', id: job.id, cancelled, message: cancelled ? 'Cancelled' : (err?.message || String(err)) });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;
  if (msg.type === 'job:start') {
    runJob(msg.job);
    sendResponse({ ok: true });
  } else if (msg.type === 'job:cancel') {
    jobs.get(msg.id)?.controller.abort();
    sendResponse({ ok: true });
  } else if (msg.type === 'job:release') {
    const job = jobs.get(msg.id);
    if (job?.blobUrl) URL.revokeObjectURL(job.blobUrl);
    jobs.delete(msg.id);
    sendResponse({ ok: true });
  } else if (msg.type === 'inspect') {
    inspect(msg).then((info) => sendResponse({ ok: true, info }), (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  return undefined;
});
