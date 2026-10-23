// Preload (node --import) that RUNS the real metal/guest/gsup.mjs on a test host and records the environment it hands the
// supervisor (test/metal-gsup-custody-env.test.mjs). Nothing is mocked inside gsup itself; only its view of the machine:
//   - node:child_process (gsup's import only) is a recorder: the 'supervisor' child's argv + env are written to
//     GSUP_HARNESS.out and the process exits at that moment, so no real process is ever started;
//   - fs reads of guest-only paths (/proc/cmdline, the fw_cfg file, /opt/metal/*.json, /run, /sys, /dev, /mnt, /etc, /vm)
//     come from GSUP_HARNESS.files (absent = ENOENT), and writes there are recorded, never performed.
// Everything else (os, crypto, gsup's own imports and their bundles) is the real thing.
import fs from 'node:fs';
import { registerHooks } from 'node:module';

const H = JSON.parse(process.env.GSUP_HARNESS || '{}');
const files = H.files || {};
const GUEST = /^\/(proc|sys|opt|run|dev|mnt|etc|vm|tmp\/enclave|var\/lib\/enclave)(\/|$)/;
const guest = (p) => typeof p === 'string' && GUEST.test(p);
const enoent = (p) => Object.assign(new Error(`ENOENT (harness): ${p}`), { code: 'ENOENT' });
const writes = [];
const orig = {};
for (const k of ['readFileSync', 'existsSync', 'writeFileSync', 'mkdirSync', 'chmodSync', 'readdirSync', 'statSync', 'openSync',
                 'readlinkSync', 'statfsSync', 'accessSync', 'unlinkSync', 'rmSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'lstatSync']) {
  orig[k] = fs[k];
  fs[k] = function (p, ...rest) {
    if (!guest(p)) return orig[k].call(fs, p, ...rest);
    switch (k) {
      case 'readFileSync': {
        if (!(p in files)) throw enoent(p);
        const enc = typeof rest[0] === 'string' ? rest[0] : rest[0]?.encoding;
        return enc ? files[p] : Buffer.from(files[p]);
      }
      case 'existsSync': return p in files;
      case 'readdirSync': return Object.keys(files).filter((f) => f.startsWith(p.replace(/\/$/, '') + '/')).map((f) => f.slice(p.replace(/\/$/, '').length + 1).split('/')[0]);
      case 'statSync': case 'lstatSync': case 'statfsSync': case 'accessSync': case 'readlinkSync': case 'openSync':
        if (p in files && k !== 'openSync') return { isFile: () => true, isDirectory: () => false, size: Buffer.byteLength(files[p]) };
        throw enoent(p);
      default: writes.push({ op: k, path: p }); return undefined;
    }
  };
}
// gsup's `import { spawn, execFileSync } from 'node:child_process'` resolves to the recorder below; nothing else is redirected
const recorder = `
const H = JSON.parse(process.env.GSUP_HARNESS || '{}');
import fs from 'node:fs';
const calls = [];
function fake() { return { pid: 4242, exitCode: null, stdout: null, stderr: null, on() { return this; }, once() { return this; },
  kill() {}, unref() {}, ref() {} }; }
export function spawn(cmd, args = [], opts = {}) {
  calls.push({ cmd, args });
  if ((args || []).includes('/app/supervisor.js')) {
    fs.writeFileSync(H.out, JSON.stringify({ argv: [cmd, ...args], cwd: opts.cwd || null, env: opts.env || null, before: calls }));
    process.exit(0);
  }
  return fake();
}
export function execFileSync(cmd, args = []) { calls.push({ cmd, args, sync: true }); return Buffer.alloc(0); }
export function spawnSync(cmd, args = []) { calls.push({ cmd, args, sync: true }); return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
export function execSync(cmd) { calls.push({ cmd, sync: true }); return Buffer.alloc(0); }
export default { spawn, execFileSync, spawnSync, execSync };
`;
const RECORDER_URL = 'data:text/javascript,' + encodeURIComponent(recorder);
registerHooks({
  resolve(specifier, context, next) {
    if ((specifier === 'node:child_process' || specifier === 'child_process') && /\/metal\/guest\//.test(context.parentURL || ''))
      return { url: RECORDER_URL, shortCircuit: true };
    return next(specifier, context);
  },
});
process.on('exit', () => { try { if (H.writesOut) orig.writeFileSync.call(fs, H.writesOut, JSON.stringify(writes)); } catch {} });
