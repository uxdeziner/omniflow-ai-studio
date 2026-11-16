// Remuxing and validation, built on Mediabunny (no re-encoding, packets are copied).
// Used by the offscreen document (downloads) and by the content script (capture mode).
import {
  ALL_FORMATS, BlobSource, EncodedAudioPacketSource, EncodedPacketSink,
  EncodedVideoPacketSource, Input, MkvOutputFormat, Mp4OutputFormat, Output,
  StreamTarget, WebMOutputFormat,
} from '../vendor/mediabunny.min.mjs';

const MP4_FRIENDLY_VIDEO = new Set(['avc', 'hevc', 'av1']);
const MP4_FRIENDLY_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3']);

function openInput(blob) {
  return new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
}

async function describeVideo(track) {
  if (!track) return null;
  return {
    codec: await track.getCodec(),
    width: await track.getDisplayWidth(),
    height: await track.getDisplayHeight(),
  };
}

/**
 * Inspect a media blob. Never throws: returns { ok:false, reason } for anything unreadable
 * (HTML error pages, truncated files, DRM-encrypted payloads, ...).
 */
export async function probe(blob) {
  if (!blob || blob.size === 0) return { ok: false, reason: 'The file is empty.' };
  const input = openInput(blob);
  try {
    if (!(await input.canRead())) {
      return { ok: false, reason: 'The server did not return a playable media file.' };
    }
    const vTrack = await input.getPrimaryVideoTrack();
    const aTrack = await input.getPrimaryAudioTrack();
    if (!vTrack && !aTrack) return { ok: false, reason: 'No video or audio track found.' };
    const tracks = [vTrack, aTrack].filter(Boolean);
    let duration = 0;
    try { duration = await input.computeDuration(tracks); } catch { /* keep 0 */ }
    const format = await input.getFormat();
    return {
      ok: true,
      duration,
      format: format.name,
      mimeType: format.mimeType,
      video: await describeVideo(vTrack),
      audio: aTrack ? { codec: await aTrack.getCodec() } : null,
    };
  } catch (err) {
    return { ok: false, reason: `Unreadable media (${err?.message || err}).` };
  } finally {
    input.dispose();
  }
}

function pickFormat(vCodec, aCodec) {
  const fits = (fmt) => {
    const ok = new Set(fmt.getSupportedCodecs());
    return (!vCodec || ok.has(vCodec)) && (!aCodec || ok.has(aCodec));
  };
  const mp4Friendly = (!vCodec || MP4_FRIENDLY_VIDEO.has(vCodec)) && (!aCodec || MP4_FRIENDLY_AUDIO.has(aCodec));
  // fastStart:false writes sample data straight through instead of holding the whole file in RAM.
  const mp4 = () => ({ format: new Mp4OutputFormat({ fastStart: false }), ext: 'mp4', mime: 'video/mp4' });
  if (mp4Friendly) return mp4();
  const webm = new WebMOutputFormat();
  if (fits(webm)) return { format: webm, ext: 'webm', mime: 'video/webm' };
  const m = mp4();
  if (fits(m.format)) return m;
  return { format: new MkvOutputFormat(), ext: 'mkv', mime: 'video/x-matroska' };
}

/**
 * Collects positioned writes into Blob parts so large outputs live in the browser's blob
 * storage rather than the JS heap. Late, out-of-order writes (header patches) are spliced in
 * at the end.
 */
class BlobCollector {
  constructor() {
    this.parts = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.end = 0;
    this.patches = [];
    this.writable = new WritableStream({
      write: (chunk) => {
        if (chunk.position === this.end) {
          this.pending.push(chunk.data);
          this.pendingBytes += chunk.data.byteLength;
          this.end += chunk.data.byteLength;
          if (this.pendingBytes >= 8 * 1024 * 1024) this.flush();
        } else {
          this.patches.push({ position: chunk.position, data: chunk.data.slice() });
        }
      },
    });
  }
  flush() {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }
  toBlob(type) {
    this.flush();
    let blob = new Blob(this.parts, { type });
    this.patches.sort((a, b) => a.position - b.position);
    for (const p of this.patches) {
      const after = p.position + p.data.byteLength;
      if (p.position > blob.size) throw new Error('Muxer wrote past the end of the file.');
      blob = new Blob([blob.slice(0, p.position), p.data, blob.slice(after)], { type });
    }
    return blob;
  }
}

const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** SPS/PPS from an avcC box, as length-prefixed NAL units ready to prepend to a key frame. */
function avcParameterSets(description) {
  try {
    const d = ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description);
    if (d.length < 7 || d[0] !== 1) return null;
    const lengthSize = (d[4] & 3) + 1;
    const units = [];
    let o = 5;
    const spsCount = d[o++] & 0x1f;
    for (let i = 0; i < spsCount; i++) { const n = (d[o] << 8) | d[o + 1]; o += 2; units.push(d.subarray(o, o + n)); o += n; }
    const ppsCount = d[o++];
    for (let i = 0; i < ppsCount; i++) { const n = (d[o] << 8) | d[o + 1]; o += 2; units.push(d.subarray(o, o + n)); o += n; }
    const out = new Uint8Array(units.reduce((a, u) => a + lengthSize + u.length, 0));
    let w = 0;
    for (const u of units) {
      let n = u.length;
      for (let i = lengthSize - 1; i >= 0; i--) { out[w + i] = n & 0xff; n >>>= 8; }
      w += lengthSize;
      out.set(u, w);
      w += u.length;
    }
    return { lengthSize, bytes: out };
  } catch { return null; }
}

/**
 * One output track fed by one or more inputs in sequence. Several inputs occur in capture mode,
 * when the player switched quality: each switch starts a new self-contained stream. Later
 * streams win where they overlap earlier ones, exactly as they do in the player's buffer.
 */
async function buildLane(kind, blobs, inputs, shared) {
  let parts = [];
  for (const blob of blobs) {
    let input = shared.get(blob);
    if (!input) {
      input = openInput(blob);
      inputs.push(input);
      shared.set(blob, input);
      if (!(await input.canRead())) {
        if (blobs.length === 1) throw new Error(`The downloaded ${kind} data is not a readable media file.`);
        continue;
      }
    }
    let track = null;
    try { track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack(); } catch { /* unreadable part */ }
    if (!track) continue;
    const codec = await track.getCodec();
    if (!codec) continue;
    const sink = new EncodedPacketSink(track);
    const first = await sink.getFirstPacket();
    if (!first) continue;
    parts.push({ track, codec, sink, first, start: first.timestamp, end: Infinity, config: await track.getDecoderConfig() });
  }
  if (!parts.length) return null;
  const codec = parts[parts.length - 1].codec;
  parts = parts.filter((p) => p.codec === codec);
  const kept = [];
  let bound = Infinity;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].start >= bound) continue;
    parts[i].end = bound;
    bound = parts[i].start;
    kept.unshift(parts[i]);
  }
  // After a quality switch the stream has several parameter sets. Carry each part's own sets
  // in-band on its key frames so decoders follow the change.
  if (kept.length > 1 && codec === 'avc') {
    const sizes = new Set();
    for (const part of kept) {
      const params = part.config?.description ? avcParameterSets(part.config.description) : null;
      if (params) { part.prepend = params.bytes; sizes.add(params.lengthSize); }
    }
    if (sizes.size > 1) for (const part of kept) part.prepend = null; // mixed NAL length sizes: leave untouched
  }
  const main = kept[kept.length - 1];

  async function* packets() {
    for (const part of kept) {
      for await (const packet of part.sink.packets(part.first)) {
        if (packet.timestamp >= part.end) continue;
        if (part.prepend && packet.type === 'key') {
          const data = new Uint8Array(part.prepend.length + packet.data.length);
          data.set(part.prepend, 0);
          data.set(packet.data, part.prepend.length);
          yield packet.clone({ data });
        } else {
          yield packet;
        }
      }
    }
  }
  return { kind, codec, parts: kept, track: main.track, config: main.config, iter: packets(), start: kept[0].start };
}

/**
 * Copy video and audio packets into one clean file, without re-encoding. `video` and `audio`
 * are Blobs (or lists of Blobs to play in sequence). When no separate `audio` is given, the
 * audio track inside `video` is used. Timestamps are shifted so the file starts at zero with
 * A/V sync preserved.
 *
 * @param {{video?: Blob|Blob[], audio?: Blob|Blob[], audioOnly?: boolean, onProgress?: (fraction:number)=>void}} opts
 * @returns {Promise<{blob: Blob, ext: string, mime: string, duration: number, hasVideo: boolean, hasAudio: boolean, width?: number, height?: number, sections: number}>}
 */
export async function remux({ video, audio, audioOnly = false, onProgress }) {
  const inputs = [];
  const shared = new Map();
  try {
    const videoBlobs = asList(video);
    const audioBlobs = asList(audio);
    const vLane = audioOnly ? null : await buildLane('video', videoBlobs, inputs, shared);
    let aLane = null;
    try {
      aLane = await buildLane('audio', audioBlobs.length ? audioBlobs : videoBlobs, inputs, shared);
    } catch (err) {
      if (!vLane) throw err; // keep the picture rather than failing on unreadable audio
    }
    if (!vLane && !aLane) throw new Error('No video or audio track found in the downloaded data.');

    let target;
    if (!vLane) {
      target = aLane.codec === 'aac'
        ? { format: new Mp4OutputFormat({ fastStart: false }), ext: 'm4a', mime: 'audio/mp4' }
        : pickFormat(null, aLane.codec);
      if (target.ext === 'webm') target.mime = 'audio/webm';
    } else {
      target = pickFormat(vLane.codec, aLane?.codec ?? null);
    }

    const collector = new BlobCollector();
    const output = new Output({ format: target.format, target: new StreamTarget(collector.writable) });

    const lanes = [];
    if (vLane) {
      vLane.source = new EncodedVideoPacketSource(vLane.codec);
      output.addVideoTrack(vLane.source, { rotation: await vLane.track.getRotation() });
      lanes.push(vLane);
    }
    if (aLane) {
      aLane.source = new EncodedAudioPacketSource(aLane.codec);
      output.addAudioTrack(aLane.source);
      lanes.push(aLane);
    }

    let total = 0;
    for (const lane of lanes) {
      const last = lane.parts[lane.parts.length - 1];
      try { total = Math.max(total, await last.track.input.computeDuration([last.track])); } catch { /* ignore */ }
    }

    // The earliest first timestamp becomes time zero.
    const origin = Math.min(...lanes.map((l) => l.start));
    for (const lane of lanes) {
      lane.next = (await lane.iter.next()).value ?? null;
      lane.first = true;
      lane.lastTs = -Infinity;
    }

    await output.start();

    let written = 0;
    let lastEnd = 0;
    // Interleave by timestamp so the muxer never has to buffer a whole track.
    for (;;) {
      let lane = null;
      for (const l of lanes) {
        if (l.next && (!lane || l.next.timestamp < lane.next.timestamp)) lane = l;
      }
      if (!lane) break;
      const packet = lane.next;
      const shifted = packet.clone({ timestamp: Math.max(0, packet.timestamp - origin) });
      await lane.source.add(shifted, lane.first ? { decoderConfig: lane.config } : undefined);
      lane.first = false;
      lastEnd = Math.max(lastEnd, shifted.timestamp + (shifted.duration || 0));
      lane.next = (await lane.iter.next()).value ?? null;
      if (onProgress && (++written & 0xff) === 0 && total > origin) {
        onProgress(Math.max(0, Math.min(0.99, (packet.timestamp - origin) / (total - origin))));
      }
    }

    await output.finalize();
    const blob = collector.toBlob(target.mime);
    onProgress?.(1);
    const lastVideo = vLane ? vLane.parts[vLane.parts.length - 1].track : null;
    return {
      blob,
      ext: target.ext,
      mime: target.mime,
      duration: lastEnd,
      hasVideo: !!vLane,
      hasAudio: !!aLane,
      width: lastVideo ? await lastVideo.getDisplayWidth() : undefined,
      height: lastVideo ? await lastVideo.getDisplayHeight() : undefined,
      sections: vLane ? vLane.parts.length : aLane.parts.length,
    };
  } finally {
    for (const input of inputs) input.dispose();
  }
}
