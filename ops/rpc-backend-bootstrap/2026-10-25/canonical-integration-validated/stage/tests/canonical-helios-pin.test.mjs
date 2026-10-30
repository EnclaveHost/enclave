// Candidate-only regression for the reviewed Helios pin replacement cc962e2b -> 8250f08a (canonical-integration-actual).
// Run from the CANDIDATE tree's test/ dir; env CANON_BASE_TREE (git archive 77d6cc859), CANON_NEW_INPUTS, CANON_OLD_INPUTS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as cand from '../network/rpc-runtime.mjs';
const { CANON_BASE_TREE: BASE, CANON_NEW_INPUTS: NEWV, CANON_OLD_INPUTS: OLDV } = process.env;
for (const [k, v] of Object.entries({ CANON_BASE_TREE: BASE, CANON_NEW_INPUTS: NEWV, CANON_OLD_INPUTS: OLDV })) if (!v) throw new Error(`${k} is required (never skipped)`);
const base = await import(pathToFileURL(path.join(BASE, 'network/rpc-runtime.mjs')).href);
const CAND = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NEW = '8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378', OLD = 'cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SIGNER = '0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a';
const cfg = (m, helios) => ({ format: m.CONFIG_FORMAT, chain: { chainId: 8453, unsafeSigner: SIGNER },
  binaries: { listener: { path: '/opt/rpc-runtime/enclave-base-head-listener', sha256: Object.keys(m.PINNED_BUILDS.listener)[0] },
    helios: { path: '/opt/rpc-runtime/helios', sha256: helios }, witnessCheck: { path: '/opt/rpc-runtime/witness-check', sha256: Object.keys(m.PINNED_BUILDS.witnessCheck)[0] } },
  proofSources: { untrusted: ['https://base-a.example/'] }, verifier: { port: 8545 }, stateDir: '/var/lib/enclave/rpc-runtime' });
const read = (root, f) => fs.readFileSync(path.join(root, f));

test('the OLD Helios cc962e2b is refused and the NEW 8250f08a accepted; the 77d6cc859 control does the opposite', () => {
  assert.throws(() => cand.validateRuntimeConfig(cfg(cand, OLD)), /not a tested build/);
  const c = cand.validateRuntimeConfig(cfg(cand, NEW));
  assert.equal(c.binaries.helios.sha256, NEW);
  assert.match(c.binaries.helios.build, /eeffcc9 \+ canonical-block\.patch 41667ec9/);
  assert.match(c.binaries.helios.build, /debug profile/);
  assert.equal(base.validateRuntimeConfig(cfg(base, OLD)).binaries.helios.sha256, OLD);    // control: the test discriminates
  assert.throws(() => base.validateRuntimeConfig(cfg(base, NEW)), /not a tested build/);
});

test('only the Helios table changed: one accepted Helios, listener/helper tables, labels and formats identical', () => {
  assert.deepEqual(Object.keys(cand.PINNED_BUILDS.helios), [NEW]);
  assert.deepEqual(Object.keys(base.PINNED_BUILDS.helios), [OLD]);
  assert.deepEqual(Object.keys(cand.PINNED_BUILDS).sort(), Object.keys(base.PINNED_BUILDS).sort());
  for (const r of ['listener', 'witnessCheck']) assert.deepEqual({ ...cand.PINNED_BUILDS[r] }, { ...base.PINNED_BUILDS[r] }, r);
  assert.deepEqual({ ...cand.LABELS }, { ...base.LABELS });
  for (const k of ['CONFIG_FORMAT', 'STATUS_FORMAT', 'CHAIN_ID']) assert.equal(cand[k], base[k], k);
  assert.deepEqual(Object.keys(cand).sort(), Object.keys(base).sort());
});

test('no safe/finalized (or any other) behaviour upgrade: rpc-runtime.mjs differs by exactly the one pin line; all other network/ code is byte-identical', () => {
  const a = read(BASE, 'network/rpc-runtime.mjs').toString().split('\n'), b = read(CAND, 'network/rpc-runtime.mjs').toString().split('\n');
  assert.equal(a.length, b.length);
  const d = a.map((l, i) => i).filter((i) => a[i] !== b[i]);
  assert.equal(d.length, 1); assert.ok(a[d[0]].startsWith(`    ${OLD}: '`)); assert.ok(b[d[0]].startsWith(`    '${NEW}': '`));
  assert.match(cand.LABELS.head, /no L1 safety, no finality/);
  const walk = (dir) => fs.readdirSync(path.join(BASE, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const files = walk('network').filter((f) => f !== 'network/rpc-runtime.mjs');
  assert.ok(files.includes('network/chain-authority.mjs') && files.includes('network/verified-chain.mjs') && files.includes('network/lease-reader.mjs'));
  for (const f of files) assert.equal(sha(read(CAND, f)), sha(read(BASE, f)), f);
  assert.match(read(CAND, 'network/chain-authority.mjs').toString(), /no safe or finalized tier/);
});

test('image record: only binaries.helios.sha256 and provenance.helios changed; the pin equals the runtime table', () => {
  const a = JSON.parse(read(BASE, 'metal/chain-verifier-image.json')), b = JSON.parse(read(CAND, 'metal/chain-verifier-image.json'));
  assert.equal(a.binaries.helios.sha256, OLD); assert.equal(b.binaries.helios.sha256, NEW);
  assert.deepEqual(Object.keys(cand.PINNED_BUILDS.helios), [b.binaries.helios.sha256]);
  assert.match(b.provenance.helios, /canonical-block\.patch 41667ec9, DEBUG profile/);
  for (const x of [a, b]) { delete x.binaries.helios.sha256; delete x.provenance.helios; }
  assert.deepEqual(b, a);
});

test('closure.json: exactly the four reviewed Helios fields changed', () => {
  const a = JSON.parse(read(BASE, 'scripts/rpc-runtime/closure.json')), b = JSON.parse(read(CAND, 'scripts/rpc-runtime/closure.json'));
  const diff = [], go = (x, y, p) => { if (x && y && typeof x === 'object' && typeof y === 'object') { const ks = new Set([...Object.keys(x), ...Object.keys(y)]); for (const k of ks) go(x[k], y[k], [...p, k]); } else if (JSON.stringify(x) !== JSON.stringify(y)) diff.push(p.join('.')); };
  go(a, b, []);
  assert.equal(diff.length, 4, diff.join(' '));
  assert.ok(diff.includes('tested.helios') && diff.includes('tested.heliosNote'), diff.join(' '));
  assert.deepEqual(diff.map((p) => p.split('.').pop()).sort(), ['blocked', 'helios', 'heliosNote', 'note']);
  assert.equal(b.tested.helios, NEW);
});

test('chain-verifier inputs: new helios + the six audited files byte-identical to the frozen old dir and to the image pins', () => {
  const img = JSON.parse(read(CAND, 'metal/chain-verifier-image.json'));
  assert.deepEqual(fs.readdirSync(NEWV).sort(), fs.readdirSync(OLDV).sort());
  assert.equal(sha(read(NEWV, 'helios')), NEW); assert.equal(sha(read(OLDV, 'helios')), OLD);
  const six = { 'enclave-base-head-listener': img.binaries.listener.sha256, 'witness-check': img.binaries.witnessCheck.sha256, ...img.glibcRuntime.files };
  assert.equal(Object.keys(six).length, 6);
  for (const [f, d] of Object.entries(six)) { assert.ok(read(NEWV, f).equals(read(OLDV, f)), f); assert.equal(sha(read(NEWV, f)), d, f); }
  const pins = (d) => read(d, 'PINS.sha256').toString().trim().split('\n');
  const [pa, pb] = [pins(OLDV), pins(NEWV)];
  assert.deepEqual(pb.filter((l) => !l.endsWith('  helios')), pa.filter((l) => !l.endsWith('  helios')));
  assert.ok(pb.includes(`${NEW}  helios`));
  for (const f of fs.readdirSync(NEWV)) assert.equal(fs.statSync(path.join(NEWV, f)).mode & 0o022, 0, `${f} is group/other writable`);
});
