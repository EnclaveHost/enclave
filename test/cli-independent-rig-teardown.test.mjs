// The independent rig's three JSON-RPC origins at teardown (the hosted-policy-cold-start "before hook generated
// asynchronous activity after the test ended ... TypeError: fetch failed" failure). stop() closes the origins and then
// kills anvil; a forward that was already in flight then cannot reach the chain. Deterministic here: the forward is held
// (a wrapped fetch for the anvil URL only) until stop() has finished, then released.
//   - in flight across stop(): answered/closed, recorded as { stopping: true }, and NO unhandled rejection;
//   - failing while the rig is NOT stopping (anvil killed under a running rig): recorded as { stopping: false } AND still the
//     loud unhandled rejection (run in a child so this file can observe it).
// RIG_MODULE (relative to the repo) selects another copy of the helper: the control run points it at the unfixed helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIG = pathToFileURL(path.resolve(REPO, process.env.RIG_MODULE || 'test/helpers/cli-independent-rig.mjs')).href;
const { startRig, haveTools } = await import(RIG);
const skip = haveTools() || false;
const post = (f, url) => f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });

test('a forward in flight when rig.stop() kills the chain is recorded as teardown, never an unhandled rejection', { skip, timeout: 240000 }, async () => {
  const rig = await startRig();
  const realFetch = globalThis.fetch;
  let release, held = 0;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async (u, o) => { if (String(u).startsWith(rig.rpc)) { held++; await gate; } return realFetch(u, o); };
  try {
    const answer = post(realFetch, rig.rpcs[0]).then((r) => r.status, () => 'closed');
    for (let t = 0; held === 0; t++) { assert.ok(t < 200, 'the origin never forwarded'); await new Promise((r) => setTimeout(r, 25)); }
    await rig.stop();
    await assert.rejects(post(realFetch, rig.rpc), 'anvil is gone after stop()');
    release();
    for (let t = 0; !(rig.rpcFailures?.length) && t < 80; t++) await new Promise((r) => setTimeout(r, 25));
    assert.ok([502, 'closed'].includes(await answer), 'the client got a 502 or a closed socket, never a hang');
    assert.deepEqual(rig.rpcFailures?.map(({ i, stopping }) => ({ i, stopping })), [{ i: 0, stopping: true }]);
    assert.match(rig.rpcFailures[0].error, /ECONNREFUSED|fetch failed/);
  } finally { globalThis.fetch = realFetch; release(); }
});

test('a forward that fails while the rig is running stays loud: recorded and rethrown as an unhandled rejection', { skip, timeout: 240000 }, async () => {
  const script = `
    const { startRig } = await import(${JSON.stringify(RIG)});
    const seen = []; process.on('unhandledRejection', (e) => seen.push(String(e?.message || e)));
    const rig = await startRig();
    rig.stops[0]();                                   // anvil only (the first cleanup registered): the rig is NOT stopping
    const status = await fetch(rig.rpcs[1], { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }).then((r) => r.status, () => 'closed');
    await new Promise((r) => setTimeout(r, 300));
    console.log('RESULT ' + JSON.stringify({ status, seen, failures: rig.rpcFailures ?? null }));
    await rig.stop(); process.exit(0);`;
  const out = await new Promise((ok, no) => execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, timeout: 200000, maxBuffer: 1 << 20 },
    (e, so, se) => (e ? no(new Error(`child failed: ${e.message}\n${se}`)) : ok(so))));
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, out);
  const r = JSON.parse(line.slice(7));
  assert.equal(r.status, 502);
  assert.deepEqual(r.seen, ['fetch failed'], 'the real failure is still an unhandled rejection');
  assert.deepEqual(r.failures?.map(({ i, stopping }) => ({ i, stopping })), [{ i: 1, stopping: false }]);
});
