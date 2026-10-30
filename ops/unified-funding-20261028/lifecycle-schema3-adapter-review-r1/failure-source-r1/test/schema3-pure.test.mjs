// schema3 r1 PURE checks (no chain, authority, signing or deployed-code qualification). Runs inside the composed owned tree
// (network/lifecycle-linked-artifacts.mjs + deploy/lifecycle/schema3/bundle.json present). UNRUN at authoring time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getAddress, keccak256 } from 'viem';
import { generateSchema3Candidate, R3_ADAPTER_SHA256, R6_ADAPTER_SHA256, R6_ADAPTER_PATH, BUNDLE_PATH } from
  '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/lifecycle-schema3-adapter-review-r1/src/tools/generate-lifecycle-schema3-adapter-candidate.mjs';
import { generateAdapterCandidate as generateR3 } from
  '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/lifecycle-independent-composition-review-r3/src/tools/generate-lifecycle-adapter-candidate.mjs';
import { resolveRuntime, dependencies } from '../network/lifecycle-linked-artifacts.mjs';
import { prepareSchema3, schema3Emergency, validateSchema3Bundle, SCHEMA3_ROLES } from '../network/lifecycle-schema3-profile.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const r6 = fs.readFileSync(R6_ADAPTER_PATH, 'utf8'), bundleBytes = fs.readFileSync(BUNDLE_PATH), bundleSha = sha(bundleBytes);
const bundle = validateSchema3Bundle(bundleBytes, bundleSha);

test('generator: r6 and r3 inputs give one candidate; every r3 byte retained; valid JavaScript; changed input/bundle and reapplication refused', t => {
  assert.equal(sha(r6), R6_ADAPTER_SHA256);
  const r3 = generateR3(r6).source; assert.equal(sha(r3), R3_ADAPTER_SHA256);
  const a = generateSchema3Candidate(r6, bundleBytes), b = generateSchema3Candidate(r3, bundleBytes, { expectedBundleSha256: bundleSha });
  assert.equal(a.source, b.source); assert.equal(a.bundleSha256, bundleSha); assert.ok(a.source.includes(`'${bundleSha}'`));
  let restored = '', from = 0;
  for (const m of a.manifest) { restored += a.source.slice(from, m.candidateOffset); from = m.candidateOffset + m.length; }
  assert.equal(restored + a.source.slice(from), r3);
  for (const m of a.manifest) { const text = a.source.slice(m.candidateOffset, m.candidateOffset + m.length);   // inert unless S3 (or a declaration)
    assert.ok(/S3|SCHEMA3|R6_ABIS|s3Pending|schema3/.test(text) || text === ')', `${m.name} is not guarded`); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-gen-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'adapter.mjs'), a.source);
  const c = spawnSync(process.execPath, ['--check', path.join(dir, 'adapter.mjs')], { encoding: 'utf8', timeout: 10000 }); assert.equal(c.status, 0, c.stderr);
  assert.throws(() => generateSchema3Candidate(r6 + '\n', bundleBytes), /neither/);
  assert.throws(() => generateSchema3Candidate(a.source, bundleBytes), /neither/);
  assert.throws(() => generateSchema3Candidate(r3, bundleBytes, { expectedBundleSha256: '0'.repeat(64) }), /not the expected/);
  const forged = JSON.parse(bundleBytes); forged.sourceSha256['candidate/deploy/EnclaveDeployments.sol'] = '1'.repeat(64);
  assert.throws(() => generateSchema3Candidate(r3, Buffer.from(JSON.stringify(forged))), /source hashes/);
});

// synthetic distinct addresses; code hashes computed from the reviewed templates exactly as a reviewer would pin them
function synthetic() {
  const A = n => getAddress(`0x${n.toString(16).padStart(2, '0').repeat(20)}`);
  const names = ['lifecycle', 'ledger', 'identity', 'registry', 'l1Oracle', 'usdc', 'proofOfTime', 'accountingLibrary'];
  const contracts = Object.fromEntries(names.map((k, i) => [k, { address: A(0x11 + i), codeHash: `0x${'ab'.repeat(32)}` }]));
  contracts.proofOfTime.abi = 'proofOfTime';
  const want = { ledger: ['registry', 'usdc'], lifecycle: ['l1Oracle', 'ledger'], proofOfTime: ['ledger', 'lifecycle', 'registry', 'uint64:3600'], identity: [], accountingLibrary: [] };
  const immutables = Object.fromEntries(Object.entries(want).map(([role, ts]) => {
    const ids = Object.keys(bundle.contracts[SCHEMA3_ROLES[role]].immutableReferences ?? {}).filter(x => x !== 'library_deploy_address').sort();
    assert.equal(ids.length, ts.length, `${role} immutable count`); return [role, Object.fromEntries(ids.map((id, i) => [id, ts[i]]))]; }));
  const pins = { profile: 'independent-schema3-r1', contracts, schema3: { immutables } };
  pinHashes(pins); return pins;
}
function pinHashes(pins) {
  const C = pins.contracts, word = t => t.startsWith('uint64:') ? `0x${BigInt(t.slice(7)).toString(16).padStart(64, '0')}` : `0x${'0'.repeat(24)}${C[t].address.slice(2).toLowerCase()}`;
  for (const [role, key] of Object.entries(SCHEMA3_ROLES)) {
    const art = bundle.contracts[key], libraries = Object.fromEntries(dependencies(art).map(k => [k, C.accountingLibrary.address]));
    const immutables = Object.fromEntries(Object.entries(pins.schema3.immutables[role]).map(([id, t]) => [id, word(t)]));
    C[role].codeHash = keccak256(resolveRuntime(art, { address: C[role].address, libraries, immutables }));
  }
}

test('prepareSchema3: exact link/immutable/self pins pass; every single wrong binding fails closed before any read', () => {
  const ok = synthetic(), p = prepareSchema3(ok, bundleSha, { bundle });
  assert.deepEqual(Object.keys(p.linkedProfile.bindings).sort(), Object.values(SCHEMA3_ROLES).sort());
  assert.equal(p.linkedProfile.lifecycleSchema, 3); assert.equal(p.linkedProfile.lifecycleProofSchema, 2);
  const bad = f => { const x = structuredClone(ok); f(x); return x; };
  const lid = Object.keys(ok.schema3.immutables.ledger);
  assert.throws(() => prepareSchema3(bad(x => { [x.schema3.immutables.ledger[lid[0]], x.schema3.immutables.ledger[lid[1]]] = [ok.schema3.immutables.ledger[lid[1]], ok.schema3.immutables.ledger[lid[0]]]; }), bundleSha, { bundle }), /ledger\.codeHash/);
  assert.throws(() => prepareSchema3(bad(x => { x.contracts.accountingLibrary.address = getAddress(`0x${'77'.repeat(20)}`); }), bundleSha, { bundle }), /codeHash is not the reviewed/);
  const moved = bad(x => { x.contracts.accountingLibrary.address = getAddress(`0x${'77'.repeat(20)}`); }); pinHashes(moved);
  assert.ok(prepareSchema3(moved, bundleSha, { bundle }));                                 // consistent re-pinning (new self + new links) passes
  moved.contracts.accountingLibrary.codeHash = ok.contracts.accountingLibrary.codeHash;    // old self address code at the new address
  assert.throws(() => prepareSchema3(moved, bundleSha, { bundle }), /accountingLibrary\.codeHash/);
  assert.throws(() => prepareSchema3(bad(x => { delete x.contracts.accountingLibrary; }), bundleSha, { bundle }), /accountingLibrary/);
  assert.throws(() => prepareSchema3(bad(x => { x.contracts.accountingLibrary.abi = 'proofOfTime'; }), bundleSha, { bundle }), /pure code pin/);
  assert.throws(() => prepareSchema3(bad(x => { x.schema3.extra = 1; }), bundleSha, { bundle }), /not known/);
  const pid = Object.keys(ok.schema3.immutables.proofOfTime).find(k => ok.schema3.immutables.proofOfTime[k].startsWith('uint64:'));
  assert.throws(() => prepareSchema3(bad(x => { x.schema3.immutables.proofOfTime[pid] = `uint64:${2n ** 64n}`; }), bundleSha, { bundle }), /out of range/);
  assert.throws(() => prepareSchema3(bad(x => { x.schema3.immutables.proofOfTime[pid] = 'uint64:3601'; }), bundleSha, { bundle }), /proofOfTime\.codeHash/);
  assert.throws(() => prepareSchema3(bad(x => { x.schema3.immutables.identity = { 1: 'ledger' }; }), bundleSha, { bundle }), /exactly the compiler immutable ids/);
  assert.throws(() => prepareSchema3(bad(x => { x.contracts.proofOfTime.address = x.contracts.ledger.address; }), bundleSha, { bundle }), /duplicated|codeHash/);
  assert.throws(() => validateSchema3Bundle(bundleBytes, '0'.repeat(64)), /not the pinned/);
});

test('schema3Emergency: pending must be the revoked previous generation with its stop flag; anything else is unknown state', () => {
  const op = getAddress(`0x${'42'.repeat(20)}`), host = `0x${'5'.repeat(64)}`;
  const t = (p, s = false) => [4n, 1000n, s, p, host, op];
  const e = schema3Emergency(t(true), `0x${'9'.repeat(64)}`, { state: 'queued', generation: 5 });
  assert.deepEqual([e.pending, e.runGeneration, e.cutoff, e.operator, e.scope], [true, 4, 1000, op, 'deployment']);
  assert.equal(schema3Emergency(t(true, true), null, { state: 'stopped', generation: 5 }).stopped, true);
  assert.equal(schema3Emergency(t(false), null, { state: 'running', generation: 9 }).pending, false);
  for (const a of [{ state: 'running', generation: 5 }, { state: 'queued', generation: 6 }, { state: 'stopped', generation: 5 }])
    assert.throws(() => schema3Emergency(t(true), null, a), /inconsistent/);
  assert.throws(() => schema3Emergency([4n, 1000n, false, true, host, `0x${'0'.repeat(40)}`], null, { state: 'queued', generation: 5 }), /inconsistent/);
  assert.throws(() => schema3Emergency([4n, 1000n, false, 'yes', host, op], null, { state: 'queued', generation: 5 }), /malformed/);
  assert.throws(() => schema3Emergency(null, null, { state: 'queued', generation: 5 }), /malformed/);
});
