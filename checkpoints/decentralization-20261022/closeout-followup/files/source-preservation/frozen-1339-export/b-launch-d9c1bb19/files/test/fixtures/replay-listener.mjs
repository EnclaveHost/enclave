#!/usr/bin/node
// TEST-ONLY stand-in for enclave-base-head-listener `listen`: replays a REAL recorded listener run (heads.jsonl + the
// content-addressed objects it wrote; Base mainnet, real unsafe signer) on the listener's stdout contract, announcing
// only records numbered >= REPLAY_FROM whose number % REPLAY_EVERY == 0 (the rest are heads the source never saw).
// Every other subcommand (`commitment`) runs the REAL pinned listener (REAL_LISTENER) unchanged.
//   env: REAL_LISTENER, REPLAY_DIR (heads.jsonl, objects/), REPLAY_FROM, REPLAY_EVERY
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] !== 'listen') {
  const r = spawnSync(process.env.REAL_LISTENER, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.exitCode = r.status ?? 1;
  process.stdout.write(r.stdout);
} else {
  const out = argv[argv.indexOf('--out-dir') + 1], dir = process.env.REPLAY_DIR;
  const from = Number(process.env.REPLAY_FROM || 0), every = Number(process.env.REPLAY_EVERY || 1);
  mkdirSync(path.join(out, 'objects'), { recursive: true });
  const print = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  for (const line of readFileSync(path.join(dir, 'heads.jsonl'), 'utf8').trim().split('\n')) {
    const r = JSON.parse(line);
    if (r.type === 'start') print({ ...r, startedUnixMs: Date.now() });
    if (r.type !== 'head' || r.number < from || r.number % every !== 0) continue;
    copyFileSync(path.join(dir, 'objects', `${r.objectSha256}.v4.snappy`), path.join(out, 'objects', `${r.objectSha256}.v4.snappy`));
    print({ ...r, receivedUnixMs: Date.now() });
  }
  setInterval(() => {}, 1000);
}
