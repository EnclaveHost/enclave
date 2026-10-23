#!/usr/bin/node
// Test double for enclave-base-head-listener `listen`: replays REAL captured records and objects (or tampered copies)
// on the listener's stdout contract and simulates process behaviour (exit, signal, hang, grandchild, line flood).
// Every other subcommand (`commitment`, `verify-object`) is delegated to the REAL pinned listener binary (REAL_LISTENER),
// so the native verification gate in gossip-head-source.mjs is never faked. plan.forge deliberately corrupts one byte of
// the REAL native result to prove the JavaScript relay verifier catches it independently.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const plan = JSON.parse(process.env.FAKE_PLAN || '{}');
if (argv[0] !== 'listen') {
  const r = spawnSync(process.env.REAL_LISTENER, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let out = r.stdout;
  if (plan.forge && argv[0] === 'commitment' && r.status === 0) {
    const v = JSON.parse(out);
    const d = v.commitment.data, at = 2 + 2 * 40;   // a byte inside parentBeaconRoot/payload, not the head fields
    v.commitment.data = d.slice(0, at) + (d[at] === '0' ? '1' : '0') + d.slice(at + 1);
    out = JSON.stringify(v) + '\n';
  }
  // exitCode, not process.exit(): a >64 KiB write to a pipe completes asynchronously and exit() would truncate it
  process.exitCode = r.status ?? 1;
  process.stdout.write(out);
} else {
const arg = (name) => argv[argv.indexOf(name) + 1];
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname));
const out = arg('--out-dir');
mkdirSync(path.join(out, 'objects'), { recursive: true });
const print = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v)) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const start = JSON.parse(readFileSync(path.join(fixtures, 'listener-start-record.json'), 'utf8'));
if (!plan.noStart) print({ ...start, signer: arg('--signer'), startedUnixMs: Date.now(), ...(plan.start || {}) });

for (const h of plan.heads || []) {
  await sleep(h.delayMs || 0);
  const record = JSON.parse(readFileSync(path.join(fixtures, `base-mainnet-${h.fixture}.head.json`), 'utf8'));
  let bytes = Buffer.from(readFileSync(path.join(fixtures, `base-mainnet-${h.fixture}.v4.snappy.hex`), 'utf8').trim(), 'hex');
  if (h.mutate === 'flip') { bytes = Buffer.from(bytes); bytes[h.flipAt ?? Math.floor(bytes.length / 2)] ^= 0x01; }
  if (h.mutate === 'truncate') bytes = bytes.subarray(0, Math.floor(bytes.length * 0.7));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (h.mutate !== 'missing') writeFileSync(path.join(out, 'objects', `${sha}.v4.snappy`), bytes);
  print({ ...record, objectSha256: sha, objectBytes: bytes.length, receivedUnixMs: Date.now(), ...(h.record || {}) });
}

switch (plan.after) {
  case 'exit0': process.exit(0); break;
  case 'exit3': process.exit(3); break;
  case 'kill9': process.kill(process.pid, 'SIGKILL'); break;
  case 'longline': print('x'.repeat(20000)); setInterval(() => {}, 1000); break;
  case 'grandchild': {
    const g = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });   // same process group as this leader
    writeFileSync(path.join(out, '..', 'grandchild.pid'), String(g.pid));
    setInterval(() => {}, 1000);
    break;
  }
  default: setInterval(() => {}, 1000);   // stay alive, silent (a stale stream)
}
}
