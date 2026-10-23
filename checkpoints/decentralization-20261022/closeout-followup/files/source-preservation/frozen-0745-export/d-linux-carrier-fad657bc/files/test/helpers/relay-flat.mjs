// The flat relay directory relay/deploy.sh ships (every relay module + vendor/ + fixtures/ + node_modules) with the
// runtime bundle built from THIS source (relay/build-network.mjs), so a test process runs the code under test and never a
// stale or absent bundle. -> the directory (inside `parent`).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function flatRelay(parent) {
  const dir = path.join(parent, 'relay-flat'); fs.mkdirSync(dir);
  for (const f of fs.readdirSync(path.join(ROOT, 'relay'))) if (/\.(m?js|json)$/.test(f) && !f.includes('.bundle.')) fs.copyFileSync(path.join(ROOT, 'relay', f), path.join(dir, f));
  for (const d of ['vendor', 'fixtures']) fs.cpSync(path.join(ROOT, 'relay', d), path.join(dir, d), { recursive: true });
  const nm = fs.existsSync(path.join(ROOT, 'relay/node_modules')) ? path.join(ROOT, 'relay/node_modules') : path.join(ROOT, 'node_modules');
  fs.symlinkSync(fs.realpathSync(nm), path.join(dir, 'node_modules'));
  execFileSync(process.execPath, [path.join(ROOT, 'relay/build-network.mjs'), path.join(dir, 'network-runtime.bundle.mjs')], { cwd: ROOT, timeout: 120000, stdio: 'pipe' });
  return dir;
}
