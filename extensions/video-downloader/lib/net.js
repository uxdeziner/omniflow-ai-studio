// Network helpers: retrying fetches, resumable whole-file downloads, ordered parallel pools.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url) {
    super(`Server answered ${status} for ${shortUrl(url)}`);
    this.status = status;
  }
}

export function shortUrl(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || u.hostname;
    return `${u.hostname}/…/${file.slice(0, 40)}`;
  } catch { return String(url).slice(0, 60); }
}

const permanent = (err) => err?.name === 'AbortError' || (err instanceof HttpError && [400, 401, 403, 404, 410].includes(err.status));

/**
 * fetch() with retries and backoff. `prepare(url)` lets the caller register request headers
 * (Referer) for the host before the request goes out.
 */
export async function fetchRetry(url, { headers, signal, retries = 4, prepare } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      if (prepare) await prepare(url);
      const res = await fetch(url, { headers, signal, credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new HttpError(res.status, url);
      return res;
    } catch (err) {
      lastError = err;
      if (permanent(err)) throw err;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function fetchText(url, opts) {
  return (await fetchRetry(url, opts)).text();
}

/** Fetch a (possibly ranged) resource fully into memory. Used for segments and keys. */
export async function fetchBytes(url, { range, ...opts } = {}) {
  const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchRetry(url, { ...opts, headers });
      let buf = await res.arrayBuffer();
      // A server that ignores Range sends the whole file with 200; cut the part we asked for.
      if (range && res.status === 200 && buf.byteLength > range.length) {
        buf = buf.slice(range.offset, range.offset + range.length);
      }
      const expected = Number(res.headers.get('content-length'));
      if (!res.headers.get('content-encoding') && expected && res.status !== 200 && buf.byteLength < expected) {
        throw new Error('Connection closed early.');
      }
      return buf;
    } catch (err) {
      lastError = err;
      if (permanent(err)) throw err;
    }
  }
  throw lastError;
}

/**
 * Download one whole file as a Blob, streaming to blob storage in 8 MB parts. If the connection
 * drops mid-way the download resumes from the last received byte. Throws unless every byte the
 * server announced has arrived.
 */
export async function downloadFile(url, { signal, onProgress, prepare } = {}) {
  const parts = [];
  let received = 0;
  let total = 0;
  let contentType = '';
  let stalls = 0;

  for (;;) {
    const headers = received > 0 ? { Range: `bytes=${received}-` } : undefined;
    const res = await fetchRetry(url, { headers, signal, prepare });
    if (received > 0 && res.status !== 206) {
      // Server cannot resume: start over.
      parts.length = 0;
      received = 0;
    }
    if (!contentType) contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (/^(text\/html|application\/json|text\/plain)/.test(contentType)) {
      throw new Error('The server returned a web page instead of the video (the link may have expired; reload the page and try again).');
    }
    if (!total) {
      const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      const length = Number(res.headers.get('content-length')) || 0;
      total = range ? Number(range[1]) : (res.status === 200 && !res.headers.get('content-encoding') ? length : 0);
    }

    const before = received;
    let pending = [];
    let pendingBytes = 0;
    const flush = () => {
      if (pending.length) parts.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    };
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending.push(value);
        pendingBytes += value.byteLength;
        received += value.byteLength;
        if (pendingBytes >= 8 * 1024 * 1024) flush();
        onProgress?.(received, total);
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // fall through: resume below
    }
    flush();

    if (!total || received >= total) break;
    stalls = received > before ? 0 : stalls + 1;
    if (stalls > 4) throw new Error(`Download stopped at ${Math.round((received / total) * 100)}% and the server would not resume.`);
    await sleep(600 * (stalls + 1));
  }

  if (received === 0) throw new Error('The server sent an empty file.');
  return { blob: new Blob(parts, { type: contentType || 'application/octet-stream' }), total, contentType };
}

/** Run `worker` over `items` with limited concurrency, keeping results in input order. */
export async function pool(items, concurrency, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  async function lane() {
    while (next < items.length && !failure) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const i = next++;
      try { results[i] = await worker(items[i], i); } catch (err) { failure = failure || err; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  if (failure) throw failure;
  return results;
}
