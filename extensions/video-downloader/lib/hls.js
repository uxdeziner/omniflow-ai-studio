// Minimal, dependency-free HLS (m3u8) playlist parser.

/** Parse an attribute list such as `BANDWIDTH=1280000,CODECS="avc1,mp4a",RESOLUTION=640x360`. */
export function parseAttributes(text) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

const resolve = (uri, base) => {
  try { return new URL(uri, base).href; } catch { return null; }
};

export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

export function looksLikePlaylist(text) {
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

/** @returns {{variants: Array, audio: Array, drm: boolean}} */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const audio = [];
  let drm = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      if (a.TYPE === 'AUDIO') {
        audio.push({
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          url: a.URI ? resolve(a.URI, baseUrl) : null,
        });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      const url = j < lines.length ? resolve(lines[j], baseUrl) : null;
      if (!url) continue;
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url,
        bandwidth: Number(a.BANDWIDTH) || 0,
        width: w || 0,
        height: h || 0,
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || null,
      });
      i = j;
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttributes(line.slice(19));
      if (a.METHOD && a.METHOD !== 'NONE' && a.METHOD !== 'AES-128') drm = true;
    }
  }
  // Best first: tallest picture, then highest bitrate.
  variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
  return { variants, audio, drm };
}

/** Pick the audio rendition that goes with a variant, or null when audio is muxed in. */
export function audioFor(master, variant) {
  if (!variant?.audioGroup) return null;
  const group = master.audio.filter((a) => a.groupId === variant.audioGroup && a.url);
  if (!group.length) return null;
  return group.find((a) => a.isDefault) || group[0];
}

function parseByteRange(value, previousEnd) {
  const [len, off] = value.split('@').map(Number);
  const offset = Number.isFinite(off) ? off : previousEnd;
  return { offset, length: len };
}

/**
 * @returns {{segments: Array, duration: number, live: boolean, drm: boolean, drmMethod: string|null}}
 */
export function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments = [];
  let seq = 0;
  let key = null;
  let map = null;
  let pendingDuration = null;
  let pendingRange = null;
  let lastRangeEnd = 0;
  let ended = false;
  let drm = false;
  let drmMethod = null;
  let total = 0;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17), lastRangeEnd);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      if (!a.METHOD || a.METHOD === 'NONE') {
        key = null;
      } else if (a.METHOD === 'AES-128' && (!a.KEYFORMAT || a.KEYFORMAT === 'identity')) {
        key = { method: 'AES-128', url: resolve(a.URI, baseUrl), iv: a.IV || null };
      } else {
        // SAMPLE-AES, SAMPLE-AES-CTR, FairPlay, Widevine, PlayReady: licensed DRM.
        drm = true;
        drmMethod = a.KEYFORMAT || a.METHOD;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      map = {
        url: resolve(a.URI, baseUrl),
        range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null,
      };
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      ended = true;
    } else if (!line.startsWith('#')) {
      const url = resolve(line, baseUrl);
      if (!url) continue;
      const segment = { url, duration: pendingDuration || 0, seq, key, map, range: pendingRange };
      if (pendingRange) lastRangeEnd = pendingRange.offset + pendingRange.length;
      segments.push(segment);
      total += segment.duration;
      seq++;
      pendingDuration = null;
      pendingRange = null;
    }
  }
  return { segments, duration: total, live: !ended, drm, drmMethod };
}

/** IV for AES-128 segments: explicit hex IV, or the media sequence number (big-endian). */
export function segmentIv(segment) {
  const iv = new Uint8Array(16);
  if (segment.key?.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, segment.seq >>> 0);
  }
  return iv;
}
