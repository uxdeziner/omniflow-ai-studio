// Local test server: serves the generated media the way real sites do (range requests,
// Referer-protected CDN paths, byte ranges in the query string) plus pages that mimic players.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'media');
const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.bin': 'application/octet-stream',
};

const player = (body) => `<!doctype html><meta charset="utf-8"><title>Test clip | TestSite</title>
<body style="margin:0;background:#111;color:#eee;font-family:sans-serif"><h3 style="margin:8px">test page</h3>${body}</body>`;

// A small MSE player: appends init + segments for a video and an audio track.
const msePlayer = (tracks, opts = '') => `<video id="v" width="640" height="360" muted ${opts}></video><script>
(async () => {
  const tracks = ${JSON.stringify(tracks)};
  const ms = new MediaSource();
  const v = document.getElementById('v');
  v.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  await Promise.all(tracks.map(async (t) => {
    const sb = ms.addSourceBuffer(t.mime);
    for (const url of t.urls) {
      const buf = await (await fetch(url)).arrayBuffer();
      sb.appendBuffer(buf);
      await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    }
  }));
  ms.endOfStream();
  window.__loaded = true;
  v.play().catch(() => {});
})();
</script>`;

const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
const dashTracks = (base) => [
  { mime: 'video/mp4; codecs="avc1.64001e"', urls: [`${base}/init-stream0.m4s`, ...seq(6, (i) => `${base}/chunk-stream0-0000${i}.m4s`)] },
  { mime: 'audio/mp4; codecs="mp4a.40.2"', urls: [`${base}/init-stream1.m4s`, ...seq(7, (i) => `${base}/chunk-stream1-0000${i}.m4s`)] },
];

const PAGES = {
  '/page/progressive': player('<video id="v" src="/media/progressive.mp4" width="640" height="360" muted autoplay loop></video>'),
  '/page/protected': player('<video id="v" src="/protected/progressive.mp4" width="640" height="360" muted autoplay></video>'),
  '/page/hls-ts': player(`<script>fetch('/media/hls-ts/master.m3u8').then(() => fetch('/media/hls-ts/media.m3u8')).then(() => fetch('/media/hls-ts/seg000.ts'));</script>`),
  '/page/hls-fmp4': player(`<script>fetch('/media/hls-fmp4/master.m3u8').then(() => fetch('/media/hls-fmp4/video.m3u8')).then(() => fetch('/media/hls-fmp4/audio.m3u8'));</script>`),
  '/page/hls-aes': player(`<script>fetch('/protected/hls-aes/media.m3u8');</script>`),
  '/page/dash': player(`<script>fetch('/media/dash/manifest.mpd');</script>` + msePlayer(dashTracks('/media/dash'))),
  '/page/dash-single': player(`<script>fetch('/media/dash-single/DASHPlaylist.mpd').then(() => fetch('/media/dash-single/DASH_360.mp4', { headers: { Range: 'bytes=0-999' } }));</script>`),
  // Like Facebook/Instagram web: separate video-only and audio-only files, fetched in slices via the query string.
  '/page/split': player(`<script>
    (async () => { for (const f of ['video', 'audio']) for (let i = 0; i < 3; i++) await fetch('/media/split/' + f + '.mp4?token=abc&bytestart=' + i * 1000 + '&byteend=' + (i * 1000 + 999)); window.__loaded = true; })();
  </script>`),
  // Streams with no manifest at all: only record mode can save these.
  '/page/mse-only': player(msePlayer(dashTracks('/media/dash'))),
  // A player that starts in low quality and switches up after two segments.
  '/page/mse-switch': player(msePlayer([
    { mime: 'video/mp4; codecs="avc1.64001e"', urls: ['/media/dash-low/init-stream0.m4s', '/media/dash-low/chunk-stream0-00001.m4s', '/media/dash-low/chunk-stream0-00002.m4s', '/media/dash/init-stream0.m4s', ...seq(5, (i) => `/media/dash/chunk-stream0-0000${i + 1}.m4s`)] },
    dashTracks('/media/dash')[1],
  ])),
  // Site-data pages (served on mapped hostnames in the tests).
  '/page/x': player(`<script>fetch('/api/x.json');</script>`),
  '/page/instagram': player(`<script type="application/json">${JSON.stringify({ data: { items: [{ video_duration: 12, caption: { text: 'Insta clip' }, video_versions: [{ url: 'http://instagram.com:PORT/media/progressive.mp4?q=low', width: 320, height: 180 }, { url: 'http://instagram.com:PORT/media/progressive.mp4', width: 640, height: 360 }] }] } })}</script>`),
  '/page/facebook': player(`<script>fetch('/api/fb.txt');</script>`),
  '/page/tiktok': player(`<script>const x = new XMLHttpRequest(); x.open('GET', '/api/tiktok.json'); x.send();</script>`),
  '/page/reddit': player(`<script>fetch('/api/reddit.json');</script>`),
};

const api = (port) => ({
  '/api/x.json': JSON.stringify({ data: { tweet: { legacy: { extended_entities: { media: [{ media_url_https: 'https://pbs.twimg.com/x.jpg', video_info: { duration_millis: 12000, variants: [
    { content_type: 'application/x-mpegURL', url: `http://x.com:${port}/media/hls-ts/master.m3u8` },
    { bitrate: 256000, content_type: 'video/mp4', url: `http://x.com:${port}/media/progressive.mp4?tag=low/vid/avc1/320x180/a.mp4` },
    { bitrate: 832000, content_type: 'video/mp4', url: `http://x.com:${port}/media/progressive.mp4?tag=hi/vid/avc1/640x360/a.mp4` },
  ] } }] } } } } }),
  // Facebook answers with several JSON documents, one per line, behind an anti-hijacking prefix.
  '/api/fb.txt': 'for (;;);' + JSON.stringify({ data: { video: { playable_duration_in_ms: 12000, browser_native_sd_url: `http://facebook.com:${port}/media/progressive.mp4?q=sd`, browser_native_hd_url: `http://facebook.com:${port}/media/progressive.mp4?q=hd` } } }) + '\n' + JSON.stringify({ label: 'x', data: {} }),
  '/api/tiktok.json': JSON.stringify({ itemList: [{ video: { duration: 12, width: 640, height: 360, cover: 'https://example.com/c.jpg', playAddr: `http://tiktok.com:${port}/protected/progressive.mp4` } }] }),
  '/api/reddit.json': JSON.stringify({ media: { reddit_video: { duration: 12, dash_url: `http://reddit.com:${port}/media/dash-single/DASHPlaylist.mpd?a=1&amp;b=2`, hls_url: `http://reddit.com:${port}/media/hls-ts/master.m3u8` } } }),
});

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const realPort = server.address().port;
    if (PAGES[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES[url.pathname].replaceAll('PORT', String(realPort)));
      return;
    }
    const apis = api(realPort);
    if (apis[url.pathname]) {
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.txt') ? 'text/html; charset=utf-8' : 'application/json' });
      res.end(apis[url.pathname]);
      return;
    }
    let rel = null;
    if (url.pathname.startsWith('/media/')) rel = url.pathname.slice(7);
    if (url.pathname.startsWith('/protected/')) {
      // CDN-style hotlink protection: only requests that come "from the page" are served.
      const referer = req.headers.referer || '';
      if (!/^http:\/\/[a-z.]+:\d+\//.test(referer) || !req.headers.origin && !referer.includes('/page/')) {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<html><body>403 Forbidden</body></html>');
        return;
      }
      rel = url.pathname.slice(11);
    }
    const file = rel && path.join(MEDIA, path.normalize(rel));
    if (!file || !file.startsWith(MEDIA) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('not found');
      return;
    }
    const size = fs.statSync(file).size;
    // The split files are both labelled video/mp4, as on real CDNs.
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (url.searchParams.has('bytestart')) {
      start = Number(url.searchParams.get('bytestart'));
      end = Math.min(size - 1, Number(url.searchParams.get('byteend')));
    } else if (req.headers.range) {
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      start = m[1] ? Number(m[1]) : 0;
      end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.env.PORT) || 8765);
  console.log(`http://127.0.0.1:${server.address().port}/page/progressive`);
}
