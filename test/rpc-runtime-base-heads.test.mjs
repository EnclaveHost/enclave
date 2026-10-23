// The runtime's head path on REAL Base mainnet data (no synthetic authority anywhere in this file): a recorded native
// listener run (52 signed v4 gossip objects, blocks 52965055..52965106, the real unsafe signer; rpc-peer-audit run
// live-20261023T013719Z) replayed with GAPS through the REAL pinned listener's `commitment` mode and op-head-relay
// verifyCommitment (network/gossip-head-source.mjs), then the runtime's own fan-out (createHeadFanout: roots.offer
// with the REAL witness-check helper, then the relay). Blocks the source never delivered are bound by authenticated
// ancestry from real canonical headers (test/fixtures/base-headers-52965055-52965106.json) via the gateway, past a
// source that forges state roots.
// Scope: HEADER/ROOT binding and head serving only; these blocks have no recorded state proofs (Helios execution on
// recorded Base state is helios-base-replay.e2e / helios-witness-failover.e2e). The clock is pinned to the recording
// (the heads are old), so this proves verification, not live availability.
//   env: WITNESS_CHECK_BIN, REAL_LISTENER, BASE_HEADS_DIR, TEST_TMP. Offline (`unshare -r -n`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pad } from 'viem';
import { createGossipHeadSource } from '../network/gossip-head-source.mjs';
import { createHeadRelay, BASE_MAINNET } from '../network/op-head-relay.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { createHeadFanout } from '../network/rpc-runtime.mjs';

const { WITNESS_CHECK_BIN, REAL_LISTENER, BASE_HEADS_DIR } = process.env;
const skip = (!WITNESS_CHECK_BIN || !REAL_LISTENER || !BASE_HEADS_DIR) && 'needs WITNESS_CHECK_BIN, REAL_LISTENER, BASE_HEADS_DIR';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPLAY = path.join(HERE, 'fixtures', 'replay-listener.mjs');
const FIX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'base-headers-52965055-52965106.json'), 'utf8'));
const BY_NUM = new Map(FIX.headers.map((h) => [h.number, h])), BY_HASH = new Map(FIX.headers.map((h) => [h.hash, h]));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'rpc-runtime-base-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
function headerSource(lookup) {
  const st = { asked: 0 };
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
    const j = JSON.parse(b); st.asked++;
    if (j.method !== 'eth_getBlockByHash') return res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'x' } }));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: lookup(j.params[0]) ?? null }));
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ st, url: `http://127.0.0.1:${s.address().port}/` })));
}
test.after(() => { for (const s of servers) s.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('real Base heads with gaps: native commitment -> roots first -> relay; missed blocks bound by authenticated ancestry from real headers', { skip, timeout: 120000 }, async () => {
  assert.equal(FIX.signer, BASE_MAINNET.unsafeSigner.toLowerCase());
  const last = BY_NUM.get(52965106);
  const clock = { t: last.timestamp * 1000 + 1000 };       // pinned to the recording: these heads are history today
  const now = () => clock.t;
  const checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  const roots = createRootStore({ checker });
  const relay = createHeadRelay({ sources: [], chainId: 8453, signer: BASE_MAINNET.unsafeSigner, maxAgeMs: 60000, now });
  const fanout = createHeadFanout({ roots, relay });
  const delivered = [];
  const source = createGossipHeadSource({ listenerPath: REPLAY, listenerSha256: createHash('sha256').update(fs.readFileSync(REPLAY)).digest('hex'),
    chainId: 8453, signer: BASE_MAINNET.unsafeSigner, workDir: path.join(TMP, 'gossip'), now, sessionSecs: 60, discovery: 'off',
    onCommitment: async (c, meta) => { await fanout.onCommitment(c, meta); delivered.push(meta.number); },
    extraEnv: { REAL_LISTENER, REPLAY_DIR: BASE_HEADS_DIR, REPLAY_FROM: '52965082', REPLAY_EVERY: '4' } });
  try {
    await source.start();
    const want = [];
    for (let n = 52965082; n <= 52965106; n++) if (n % 4 === 0) want.push(n);
    const end = Date.now() + 60000;
    while (delivered.length < want.length && Date.now() < end) await sleep(100);
    assert.deepEqual(delivered, want, `every announced real head passed the native and the JavaScript verifier, in order (${JSON.stringify({ c: source.status().counters, x: source.status().lastExit })})`);
    assert.equal(fanout.counters.rootsBound, want.length, 'each was bound in the root store');
    assert.equal(fanout.counters.relayAccepted, want.length, 'and only then offered to the relay');
    const top = BY_NUM.get(want.at(-1));
    assert.equal(relay.status().head.hash, top.hash, 'the relay serves the newest verified head');
    const pushed = await roots.rootFor(top.hash);
    assert.equal(pushed.via, 'signed-head');
    assert.equal(pushed.stateRoot, top.stateRoot);

    // blocks never delivered (a gap inside the run and one older than the first delivered head)
    const forger = await headerSource((h) => { const r = BY_HASH.get(h); return r && { ...r.header, stateRoot: pad('0x66', { size: 32 }) }; });
    const honest = await headerSource((h) => BY_HASH.get(h)?.header);
    const gateway = createWitnessGateway({ upstreams: [forger.url, honest.url], proofs: { checker, roots } });
    for (const n of [52965101, 52965070]) {
      const target = BY_NUM.get(n);
      const got = await gateway.root(target.hash);
      assert.ok(got, `block ${n} recovered`);
      assert.equal(got.via, 'ancestor', 'by authenticated ancestry, not as a signed head');
      assert.equal(got.stateRoot, target.stateRoot, 'the REAL state root, not the forger\'s');
      assert.equal(got.number, n);
    }
    assert.ok(gateway.stats().upstream[Object.keys(gateway.stats().upstream)[0]].headerInvalid > 0, 'the forger was caught by hash recomputation');
    assert.equal(await gateway.root(pad('0x1234', { size: 32 })), null, 'an unknown hash is refused');
    const st = roots.stats();
    assert.equal(st.verified, want.length, 'signed-head roots: exactly the delivered heads');
    assert.ok(st.ancestors >= 2, 'ancestor roots are counted separately');
    // freshness belongs to the head, never to a root: once the clock passes the newest head, the relay serves nothing,
    // while the (historical) root bindings remain
    clock.t = top.timestamp * 1000 + 61000;
    assert.equal(relay.latest(), null, 'a stale head is not served');
    assert.equal((await roots.rootFor(top.hash)).stateRoot, top.stateRoot, 'its root stays history for that block');
  } finally { await source.stop(); checker.close(); }
});
