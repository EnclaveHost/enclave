// derivation-lease-coverage-stage: the v3 filter's event signatures are the EnclaveDeployments ABI's own, and their topic0 hashes are
// the ones every existing lease16 consumer already uses (relay/lease-generation.mjs, isolation/m2/bootstrap). Read-only inputs:
// candidate tree 64156dcd (source + its compiled forge ABI) and this stage's Rust harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-final-candidate-20261026/tree';
const { keccak256, toHex } = await import(pathToFileURL(path.join(TREE, 'node_modules/viem/_esm/index.js')).href);
const lg = await import(pathToFileURL(path.join(TREE, 'relay/lease-generation.mjs')).href);
const rust = fs.readFileSync(path.join(HERE, '../src/zk-utils/examples/derivation_harness_lease_v3.rs'), 'utf8');

const rustSignatures = () => {
  const m = /LEASE16_EVENT_SIGNATURES: \[&str; 3\] =\s*\[([^\]]+)\]/.exec(rust);
  assert.ok(m, 'LEASE16_EVENT_SIGNATURES in the harness');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};
const abiSignature = (e) => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;

test('the three filter signatures are exactly the compiled EnclaveDeployments ABI events', () => {
  const abi = JSON.parse(fs.readFileSync(path.join(TREE, 'contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json'), 'utf8')).abi;
  const events = Object.fromEntries(abi.filter((x) => x.type === 'event').map((e) => [e.name, e]));
  assert.deepEqual(rustSignatures(), ['Claimed', 'Renewed', 'Released'].map((n) => abiSignature(events[n])));
  // indexed layout the consumer replays (id, enclaveId[, operator]) - the filter itself is topic0 only, every address
  assert.deepEqual(events.Claimed.inputs.map((i) => i.indexed), [true, true, true, false, false]);
  assert.deepEqual(events.Renewed.inputs.map((i) => i.indexed), [true, true, false, false]);
  assert.deepEqual(events.Released.inputs.map((i) => i.indexed), [true, true, false]);
  // the source declares the same events (the compiled ABI is not stale)
  const src = fs.readFileSync(path.join(TREE, 'contracts/EnclaveDeployments.sol'), 'utf8');
  for (const n of ['Claimed', 'Renewed', 'Released']) assert.match(src, new RegExp(`event ${n}\\(`));
});

test('topic0 = keccak256(signature) equals relay/lease-generation.mjs, the guest pins and the Rust test constants', () => {
  const topics = rustSignatures().map((s) => keccak256(toHex(s)));
  assert.deepEqual(topics, [lg.CLAIMED, lg.RENEWED, lg.RELEASED]);
  const go = fs.readdirSync(path.join(TREE, 'isolation/m2/bootstrap')).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
    .map((f) => fs.readFileSync(path.join(TREE, 'isolation/m2/bootstrap', f), 'utf8')).join('\n');
  for (const t of topics) {
    assert.ok(go.includes(t.slice(2)), `guest bootstrap uses ${t}`);
    assert.ok(rust.includes(`"${t}"`), `Rust test pins ${t}`);
  }
});

test('the v3 format names and caps in the harness are the agreed ones', () => {
  for (const s of ['"enclave-base-derivation-result/v3"', '"enclave-lease16-coverage/v1"', '"lease16-events/v1"',
                   'MAX_RANGE_BLOCKS: u64 = 1800', 'MAX_COVERAGE_BYTES: usize = 16 << 20', 'MAX_RESULT_BYTES: usize = 16 << 20'])
    assert.ok(rust.includes(s), s);
  // the frozen v2 contract is included unchanged, never edited
  assert.match(rust, /#\[path = "derivation_harness_combined\.rs"\]\s*mod combined;/);
});
