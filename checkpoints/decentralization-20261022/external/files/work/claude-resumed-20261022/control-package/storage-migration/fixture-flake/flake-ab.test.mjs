// A/B root-cause test for storage-closeout act-1/act-3 (UNKNOWN "RPC state moves behind or conflicts" / "only N RPCs
// could read block B (rpc_refused)"). Hypothesis: the fixture stamps EVERY block with the current wall-clock second, so a
// quorum read that spans a second boundary sees block B change (custody/v2/quorum.mjs refuses "block changed during RPC
// read" -> rpc_refused) or a later read of B with another timestamp ("moves behind or conflicts", chain_rollback).
// Same world, same added latency, the FROZEN storage-closeout gate-preflight + host-software: only the timestamp rule differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const H = path.dirname(fileURLToPath(import.meta.url)), SC = path.resolve(H, '../../storage-closeout'), E = path.resolve(H, '../../../../enclave');
const { platformPolicyWorld } = await import(path.join(H, 'world-variant.mjs'));
const { generatePrivateKey, privateKeyToAccount } = await import(path.join(E, 'node_modules/viem/_esm/accounts/index.js'));
const { keccak256, toBytes } = await import(path.join(E, 'node_modules/viem/_esm/index.js'));
const RUNS = 8, LATENCY = 350;
const preflight = (w, endpoint, HS) => new Promise((ok) => {
  const c = spawn(process.execPath, [path.join(SC, 'activation/gate-preflight.mjs'), '--host-software', HS, '--endpoint', endpoint, '--policy', JSON.stringify(w.config),
    '--rpcs', w.rpcs.join(','), '--timeout-ms', '25000'], { env: { PATH: '/usr/bin:/bin', NODE_EXTRA_CA_CERTS: w.ca } });
  let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => { try { ok(JSON.parse(o.trim().split('\n').pop())); } catch { ok({ verdict: 'NO_OUTPUT' }); } });
});
for (const fixed of [false, true]) {
  test(`policy world timestamps ${fixed ? 'per block (fixed)' : 'wall clock (original)'}, ${LATENCY} ms RPC latency`, { timeout: 600_000 }, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-ab-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const HS = path.join(tmp, 'tree'); fs.cpSync(path.join(SC, 'host-software/tree'), HS, { recursive: true });
    const op = privateKeyToAccount(generatePrivateKey()); const endpoint = 'https://api.enclave.host/t/metal0', hostId = keccak256(toBytes(endpoint)).toLowerCase();
    const w = await platformPolicyWorld(t, { hosts: { [hostId]: { endpoint, operator: op.address.toLowerCase(), owner: op.address.toLowerCase(), active: true } }, fixedTimestamps: fixed, latencyMs: LATENCY });
    await w.publish({ deny: [] });
    const verdicts = [];
    for (let i = 0; i < RUNS; i++) { const j = await preflight(w, endpoint, HS); verdicts.push(`${j.verdict}${j.gate?.reason ? ' | ' + j.gate.reason.slice(0, 90) : ''}`); }
    const admitted = verdicts.filter((v) => v.startsWith('ADMISSIBLE')).length;
    console.log(JSON.stringify({ fixedTimestamps: fixed, latencyMs: LATENCY, runs: RUNS, admitted, verdicts }));
    if (fixed) assert.equal(admitted, RUNS, 'with per-block timestamps every preflight admits: ' + JSON.stringify(verdicts));
    else assert.ok(admitted < RUNS, 'the original fixture reproduces the flake under latency: ' + JSON.stringify(verdicts));
  });
}
