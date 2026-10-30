#!/usr/bin/env node
// Source-weakened controls for network/wg-provider/attested-authority.mjs providerCollateral. Each mutant is the CURRENT
// patched file with ONE protection removed, run (through a symlink farm, the source tree untouched) against the focused
// test. A mutant is KILLED only if each named test fails with an ASSERTION (code ERR_ASSERTION) and the file loaded
// (no module/syntax error): a config or import error is never counted as a kill.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const STAGE = path.dirname(new URL(import.meta.url).pathname);
const R = process.argv[2];
const SRC = fs.readFileSync(path.join(R, 'network/wg-provider/attested-authority.mjs'), 'utf8');
const T = {
  staleFresh: 'stale pre-seed + fresh KDS: the provider fetches the fresh CRL, verifies, and caches only what it authenticated',
  warm: 'fresh, warm, offline and restart: a warm cache verifies with KDS down and no network, also from a NEW instance (restart)',
  restore: 'restoration without restart: KDS back, or (no network) the operator replaces the seed CRL; the same instance verifies again',
  config: 'configuration: legacy { dir } unchanged; { dir, kds: true } refused with the migration; cacheDir absolute and separate; nothing names a root',
};
const MUTANTS = {
  'm1-crl-seed-first (the original defect, cache kept)': ['crl: kds ? layeredCollateral(kds, file).crl', 'crl: kds ? layeredCollateral(file, kds).crl', [T.staleFresh, T.restore]],
  'm2-chain-from-kds-first (ASK rotation bypass)': ['    chain: (product) => file.chain(product),', '    chain: kds ? layeredCollateral(kds, file).chain : (product) => file.chain(product),', [T.staleFresh]],
  'm3-cache-bypassed (no authenticated cache)': ['  return cachedCollateral({ dir: cacheDir, upstream,', '  return upstream; cachedCollateral({ dir: cacheDir, upstream,', [T.warm]],
  'm4-kds-without-cache-allowed (legacy layered path)': ["    if (c.kds) bad('attestedVerifier.collateral.kds needs cacheDir", "    if (c.kds) return layeredCollateral(file, http());\n    if (false) bad('attestedVerifier.collateral.kds needs cacheDir", [T.config]],
  'm5-no-cacheDir-separation': ['  if (within(cacheDir, dir) || within(dir, cacheDir)) bad(', '  if (false) bad(', [T.config]],
};

function farm(dir, fileText) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'network/wg-provider'), { recursive: true });
  for (const n of fs.readdirSync(R)) if (n !== 'network') fs.symlinkSync(path.join(R, n), path.join(dir, n));
  for (const n of fs.readdirSync(path.join(R, 'network'))) if (n !== 'wg-provider') fs.symlinkSync(path.join(R, 'network', n), path.join(dir, 'network', n));
  for (const n of fs.readdirSync(path.join(R, 'network/wg-provider'))) if (n !== 'attested-authority.mjs') fs.symlinkSync(path.join(R, 'network/wg-provider', n), path.join(dir, 'network/wg-provider', n));
  fs.writeFileSync(path.join(dir, 'network/wg-provider/attested-authority.mjs'), fileText);
}
/** TAP -> { name: { ok, assertion } } plus whether the file itself failed to load. */
function results(tap) {
  const out = {}; const lines = tap.split('\n'); let cur = null;
  for (const l of lines) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(l);
    if (m) { cur = m[2]; out[cur] = { ok: m[1] === 'ok', assertion: false }; continue; }
    if (cur && /code: 'ERR_ASSERTION'/.test(l)) out[cur].assertion = true;
  }
  const loadError = Object.keys(out).length === 0;   // the file did not load (module/syntax error): no test results at all
  return { out, loadError };
}
let rc = 0;
for (const [name, [from, to, tests]] of Object.entries(MUTANTS)) {
  if (SRC.split(from).length !== 2) { console.log(`${name}: MUTATION TARGET NOT FOUND EXACTLY ONCE`); rc = 1; continue; }
  const dir = path.join(STAGE, 'tmp', 'mutant-' + name.split(' ')[0]);
  farm(dir, SRC.replace(from, to));
  const r = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--test-reporter=tap', 'test/attested-provider-collateral.test.mjs'],
    { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env } });
  const tap = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(STAGE, 'tmp', `mutant-${name.split(' ')[0]}.tap`), tap);
  const { out, loadError } = results(tap);
  const per = tests.map((t) => [t, out[t]]);
  const killed = !loadError && per.every(([, x]) => x && !x.ok && x.assertion);
  console.log(`${name}: ${killed ? 'KILLED' : 'SURVIVED'} (rc ${r.status}; ${per.map(([t, x]) => `${t.slice(0, 40)}...=${x ? (x.ok ? 'ok' : x.assertion ? 'assertion-fail' : 'non-assertion-fail') : 'absent'}`).join('; ')}${loadError ? '; LOAD ERROR' : ''})`);
  if (!killed) rc = 1;
}
process.exit(rc);
