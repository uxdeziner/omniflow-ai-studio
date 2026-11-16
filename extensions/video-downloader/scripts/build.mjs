// Packages the extension into two zip files:
//   dist/omniflow-video-saver-store.zip     Web Store edition (YouTube switched off)
//   dist/omniflow-video-saver-personal.zip  personal edition (load unpacked / developer mode)
// Usage: node scripts/build.mjs      (needs the `zip` command)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const SHIP = ['manifest.json', 'config.js', 'background.js', 'offscreen.html', 'offscreen.js', 'lib', 'vendor', 'content', 'popup', 'icons'];

fs.rmSync(dist, { recursive: true, force: true });
for (const [edition, youtube] of [['store', false], ['personal', true]]) {
  const out = path.join(dist, edition);
  fs.mkdirSync(out, { recursive: true });
  for (const entry of SHIP) fs.cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
  // Edit the setting itself (a line that starts with it), not the mention in the comment above.
  const source = fs.readFileSync(path.join(out, 'config.js'), 'utf8');
  const config = source.replace(/^(\s*)youtube:\s*(true|false)/m, `$1youtube: ${youtube}`);
  fs.writeFileSync(path.join(out, 'config.js'), config);
  // Verify by evaluating the file, exactly as the browser will.
  const scope = {};
  new Function('globalThis', config)(scope);
  if (scope.OFVS_CONFIG?.youtube !== youtube) throw new Error(`config.js: could not set youtube to ${youtube} for the ${edition} edition`);
  const zip = path.join(dist, `omniflow-video-saver-${edition}.zip`);
  execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
  console.log(`${edition}: ${path.relative(root, zip)} (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
}
