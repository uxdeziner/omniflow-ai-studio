// End-to-end test: loads the unpacked extension into Chromium, opens pages that deliver video
// the way real sites do, downloads through the extension and verifies every saved file with ffprobe.
//   node test/e2e.mjs            (needs: playwright, ffmpeg/ffprobe; media from test/make-media.sh)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

// require() also finds a globally installed Playwright (NODE_PATH), which ESM imports do not.
const { chromium } = createRequire(import.meta.url)('playwright');

const EXT = process.env.EXT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ofvs-e2e-'));
const downloads = path.join(work, 'downloads');
fs.mkdirSync(downloads);

const server = await startServer(0);
const PORT = server.address().port;
const HOSTS = ['testsite.test', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com', 'reddit.com', 'youtube.com'];

const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  downloadsPath: downloads,
  viewport: { width: 1000, height: 700 },
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server',
    `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const saved = [];
context.on('page', (p) => p.on('download', async (d) => saved.push({ name: d.suggestedFilename(), path: await d.path() })));

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const control = await context.newPage(); // an extension page we use to talk to the service worker
await control.goto(`chrome-extension://${extId}/popup/popup.html`);
control.on('download', async (d) => saved.push({ name: d.suggestedFilename(), path: await d.path() }));

const ask = (msg) => control.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const tabIdOf = (url) => control.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffprobe(file) {
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,nb_frames,width,height', '-of', 'json', file]).toString());
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']); // throws on a corrupt file
  const v = out.streams.find((s) => s.codec_type === 'video');
  const a = out.streams.find((s) => s.codec_type === 'audio');
  return { duration: Number(out.format.duration), video: v ? `${v.codec_name} ${v.width}x${v.height} ${v.nb_frames}f` : null, frames: v ? Number(v.nb_frames) : 0, audio: a ? a.codec_name : null };
}

async function waitFor(fn, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function waitJob(jobId, tabId) {
  return waitFor(async () => {
    const s = await ask({ type: 'state', tabId });
    const j = s.jobs.find((x) => x.id === jobId);
    return j && ['done', 'error', 'cancelled'].includes(j.state) ? j : null;
  }, `job ${jobId}`, 60000);
}

async function savedFile(job) {
  const info = await control.evaluate(async (id) => (await chrome.downloads.search({ id }))[0], job.downloadId);
  if (info?.filename && fs.existsSync(info.filename)) return info.filename;
  const hit = await waitFor(() => saved.find((s) => s.name === path.basename(job.filename) && s.path), `file ${job.filename}`, 10000);
  return hit.path;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Open a page, wait until the extension lists `count` item(s), download the first, verify. */
async function scenario(name, host, pagePath, { expectItems = 1, audioOnly = false, variantIndex = 0, pick = 0, loaded = false, after = null, expect = {} } = {}) {
  const url = `http://${host}:${PORT}${pagePath}`;
  const page = await context.newPage();
  try {
    await page.goto(url);
    const tabId = await waitFor(() => tabIdOf(url), 'tab');
    if (loaded) await page.waitForFunction(() => window.__loaded === true);
    const state = await waitFor(async () => {
      const s = await ask({ type: 'state', tabId });
      return s.items.length >= expectItems && s.items.every((i) => !i.pending) ? s : null;
    }, `${name}: items`, 15000).catch(async () => ask({ type: 'state', tabId }));
    check(`${name}: detected exactly ${expectItems} video(s)`, state.items.length === expectItems, state.items.map((i) => `${i.kind}/${i.source} ${i.variants.map((v) => v.label).join(',')} ${i.duration ? i.duration.toFixed(1) + 's' : ''}`).join(' | ') || 'none');
    if (!state.items.length) return;
    if (expect.variants) check(`${name}: qualities`, state.items[0].variants.map((v) => v.label).join(',') === expect.variants, state.items[0].variants.map((v) => v.label).join(','));
    const res = await ask({ type: 'download', tabId, itemId: state.items[pick].id, audioOnly, variantIndex });
    const job = await waitJob(res.jobId, tabId);
    if (job.state !== 'done') { check(`${name}: download`, false, job.error); return; }
    const file = await savedFile(job);
    const p = ffprobe(file);
    const okVideo = audioOnly ? !p.video : (p.frames >= 355 && (!expect.size || p.video.includes(expect.size)));
    if (after) await after(tabId, check);
    check(`${name}: complete file`, okVideo && p.audio === 'aac' && Math.abs(p.duration - 12) < 0.3, `${job.filename} ${fs.statSync(file).size}B ${p.duration.toFixed(2)}s video=${p.video} audio=${p.audio}${job.warnings?.length ? ' warn=' + job.warnings.join(';') : ''}`);
  } catch (err) {
    check(`${name}`, false, err.message);
  } finally {
    await page.close();
  }
}

const T = 'testsite.test';
await scenario('direct mp4 (<video src>)', T, '/page/progressive');
await scenario('hotlink-protected mp4 (needs Referer)', T, '/page/protected');
await scenario('HLS, MPEG-TS segments', T, '/page/hls-ts', { expect: { variants: '360p,180p' } });
await scenario('HLS, fMP4 with separate audio', T, '/page/hls-fmp4');
await scenario('HLS, AES-128 encrypted + protected', T, '/page/hls-aes');
await scenario('DASH, segment template', T, '/page/dash');
await scenario('DASH, single-file tracks', T, '/page/dash-single');
await scenario('split video/audio files (range-in-query)', T, '/page/split', {
  expectItems: 2, pick: 1, loaded: true,
  after: async (tabId, check) => {
    const s = await ask({ type: 'state', tabId });
    check('split: the sound-track entry is folded into the video', s.items.length === 1, `${s.items.length} item(s) listed afterwards`);
  },
});
await scenario('audio only from HLS', T, '/page/hls-ts', { audioOnly: true });
await scenario('site data: X', 'x.com', '/page/x', { expect: { variants: '360p,180p' } });
await scenario('site data: Instagram (inline JSON)', 'instagram.com', '/page/instagram', { expect: { variants: '360p,180p' } });
await scenario('site data: Facebook (prefixed multi-JSON)', 'facebook.com', '/page/facebook', { expect: { variants: 'HD,SD' } });
await scenario('site data: TikTok (XHR, protected CDN)', 'tiktok.com', '/page/tiktok');
await scenario('site data: Reddit (DASH)', 'reddit.com', '/page/reddit');

// --- the Download button drawn over the video
{
  const url = `http://${T}:${PORT}/page/progressive`;
  const page = await context.newPage();
  try {
    await page.goto(url);
    const tabId = await waitFor(() => tabIdOf(url), 'tab');
    await page.waitForFunction(() => document.getElementById('v').readyState >= 1);
    const box = await page.locator('#v').boundingBox();
    await page.mouse.move(box.x + 300, box.y + 200);
    await sleep(300);
    await page.mouse.move(box.x + 310, box.y + 205);
    await sleep(400);
    await page.screenshot({ path: path.join(work, 'overlay.png') });
    await page.mouse.click(box.x + 50, box.y + 26);
    const job = await waitFor(async () => (await ask({ type: 'state', tabId })).jobs.find((j) => j.tabId === tabId && j.state === 'done'), 'overlay job', 30000);
    const p = ffprobe(await savedFile(job));
    check('on-video Download button', p.frames >= 355 && p.audio === 'aac', `${job.filename} ${p.duration.toFixed(2)}s`);
    await sleep(500);
    await page.screenshot({ path: path.join(work, 'toast.png') });
  } catch (err) { check('on-video Download button', false, err.message); } finally { await page.close(); }
}

// --- record mode on a stream that has no manifest
{
  const url = `http://${T}:${PORT}/page/mse-only`;
  const page = await context.newPage();
  try {
    await page.goto(url);
    const tabId = await waitFor(() => tabIdOf(url), 'tab');
    await page.waitForFunction(() => window.__loaded === true);
    const before = await ask({ type: 'state', tabId });
    check('record mode: stream segments are not listed as videos', before.items.length === 0, `${before.items.length} items`);
    const download = page.waitForEvent('download', { timeout: 60000 });
    await ask({ type: 'capture:arm', tabId });
    const d = await download;
    const file = path.join(work, 'recorded-' + d.suggestedFilename());
    await d.saveAs(file);
    const p = ffprobe(file);
    check('record mode: complete file', p.frames >= 355 && p.audio === 'aac' && Math.abs(p.duration - 12) < 0.3, `${d.suggestedFilename()} ${p.duration.toFixed(2)}s video=${p.video} audio=${p.audio}`);
    await page.screenshot({ path: path.join(work, 'record.png') });
  } catch (err) { check('record mode', false, err.message); } finally { await page.close(); }
}

// --- record mode across a quality switch (player starts low, then switches up)
{
  const url = `http://${T}:${PORT}/page/mse-switch`;
  const page = await context.newPage();
  try {
    await page.goto(url);
    const tabId = await waitFor(() => tabIdOf(url), 'tab');
    await page.waitForFunction(() => window.__loaded === true);
    const download = page.waitForEvent('download', { timeout: 60000 });
    await ask({ type: 'capture:arm', tabId });
    const d = await download;
    const file = path.join(work, 'switch-' + d.suggestedFilename());
    await d.saveAs(file);
    const p = ffprobe(file);
    // ffprobe reports the first frame's size; count the frames at each size instead.
    const widths = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=width', '-of', 'csv=p=0', file]).toString().split('\n').map((l) => parseInt(l, 10)).filter(Boolean);
    const full = widths.filter((w) => w === 640).length;
    check('record mode: survives a quality switch', widths.length >= 355 && full >= 295 && widths[widths.length - 1] === 640 && p.audio === 'aac' && Math.abs(p.duration - 12) < 0.3, `${d.suggestedFilename()} ${p.duration.toFixed(2)}s, ${widths.length} frames (${full} at full quality), audio=${p.audio}`);
  } catch (err) { check('record mode: quality switch', false, err.message); } finally { await page.close(); }
}

// --- popup rendering
{
  const url = `http://${T}:${PORT}/page/hls-ts`;
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await waitFor(() => tabIdOf(url), 'tab');
  await waitFor(async () => (await ask({ type: 'state', tabId })).items.some((i) => !i.pending), 'items');
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 520 });
  await popup.addInitScript((id) => { const q = chrome.tabs.query; chrome.tabs.query = async (o) => (o.active ? [{ id }] : q.call(chrome.tabs, o)); }, tabId);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('.card');
  check('popup lists the video', (await popup.locator('.card').count()) === 1, await popup.locator('.card .title').first().textContent());
  const firstCard = await popup.locator('.card').first().boundingBox();
  check('popup shows this tab\'s video first', firstCard.y < 120, `card starts ${Math.round(firstCard.y)}px from the top`);
  await popup.locator('.card .primary').first().click();
  await popup.waitForSelector('.job.done', { timeout: 30000 });
  check('popup Download button saves the file', (await popup.locator('.job.done').count()) === 1, await popup.locator('.job.done .state').first().textContent());
  await popup.screenshot({ path: path.join(work, 'popup.png') });
  await popup.close();
  await page.close();
}

// --- Web Store edition: YouTube is switched off entirely
if (process.env.EXPECT_YOUTUBE_BLOCKED) {
  const url = `http://youtube.com:${PORT}/page/progressive`;
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await waitFor(() => tabIdOf(url), 'tab');
  await page.waitForFunction(() => document.getElementById('v').readyState >= 2);
  await sleep(800);
  const s = await ask({ type: 'state', tabId });
  check('store edition: nothing is offered on YouTube', s.blocked === true && s.items.length === 0, `blocked=${s.blocked} items=${s.items.length}`);
  await page.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots and files: ${work}`);
await context.close();
server.close();
process.exit(failed.length ? 1 : 0);
