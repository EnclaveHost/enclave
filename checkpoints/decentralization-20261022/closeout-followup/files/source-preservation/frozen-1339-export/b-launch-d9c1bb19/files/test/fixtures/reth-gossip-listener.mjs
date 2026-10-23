#!/usr/bin/node
// TEST-ONLY stand-in for enclave-base-head-listener `listen` over a LOCAL reth --dev chain (chain id 8453): every new
// block becomes a v4 gossip envelope signed by the public TEST sequencer key (65-byte signature || parentBeaconRoot ||
// SSZ payload, test/fixtures/op-commitment.mjs), framed as a literal-only Snappy block, written to <out-dir>/objects and
// announced on the listener's stdout record contract. SYNTHETIC HEAD AUTHORITY: this proves composition, never Base.
// The literal-only framing is test input only: the REAL pinned listener's `commitment` mode (maintained base/base
// decode + `snap` decompression + signer + block-hash verification) judges every object; no subcommand but `listen`
// is emulated, everything else is delegated to REAL_LISTENER unchanged.
//   env: REAL_LISTENER, FIXTURES_DIR (this directory: the runtime executes a staged COPY of this file elsewhere),
//        RIG_RPC (the chain), FEED_CONTROL (a JSON file the test rewrites):
//        { "frozen": bool, "deliverEvery": n (announce only blocks whose number % n == 0), "exit": "exit3" }
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] !== 'listen') {
  const r = spawnSync(process.env.REAL_LISTENER, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.exitCode = r.status ?? 1;     // not process.exit(): a large pipe write completes asynchronously
  process.stdout.write(r.stdout);
} else {
  const { makeCommitment, blockFields } = await import(path.join(process.env.FIXTURES_DIR, 'op-commitment.mjs'));
  const TEST_SEQUENCER = '0x' + '5e'.repeat(32);       // the public test key of the verifier E2E (synthetic authority)
  const arg = (name) => argv[argv.indexOf(name) + 1];
  const out = arg('--out-dir'), signer = arg('--signer');
  mkdirSync(path.join(out, 'objects'), { recursive: true });
  const print = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const control = () => { try { return JSON.parse(readFileSync(process.env.FEED_CONTROL, 'utf8')); } catch { return {}; } };
  const rpc = async (method, params = []) => {
    const r = await fetch(process.env.RIG_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
  };
  const snappyLiteral = (buf) => {
    const head = []; let n = buf.length; while (n >= 0x80) { head.push((n & 0x7f) | 0x80); n >>>= 7; } head.push(n);
    const parts = [Buffer.from(head)];
    for (let i = 0; i < buf.length; i += 65536) {
      const c = buf.subarray(i, i + 65536), l = c.length - 1;
      parts.push(l < 60 ? Buffer.from([l << 2]) : l < 256 ? Buffer.from([60 << 2, l]) : Buffer.from([61 << 2, l & 0xff, l >> 8]), c);
    }
    return Buffer.concat(parts);
  };
  const start = JSON.parse(readFileSync(path.join(process.env.FIXTURES_DIR, 'listener-start-record.json'), 'utf8'));
  print({ ...start, signer, signerMatchesChainDefault: false, startedUnixMs: Date.now() });
  let served = null;
  for (;;) {
    const c = control();
    if (c.exit === 'exit3') process.exit(3);
    try {
      const latest = BigInt(await rpc('eth_blockNumber'));
      if (served === null) served = latest > 1n ? latest - 1n : 0n;
      while (!c.frozen && served < latest) {
        const n = served + 1n;
        const b = await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
        served = n;
        if (c.deliverEvery && n % BigInt(c.deliverEvery) !== 0n) continue;   // a head the source never saw (gap)
        const txs = await Promise.all(b.transactions.map((h) => rpc('eth_getRawTransactionByHash', [h])));
        const cm = await makeCommitment(blockFields(b), { chainId: 8453, privateKey: TEST_SEQUENCER, txs, parentBeaconRoot: b.parentBeaconBlockRoot });
        const sig = Buffer.concat([Buffer.from(cm.signature.r.slice(2).padStart(64, '0'), 'hex'), Buffer.from(cm.signature.s.slice(2).padStart(64, '0'), 'hex'),
          Buffer.from([Number(cm.signature.yParity)])]);
        const bytes = snappyLiteral(Buffer.concat([sig, Buffer.from(cm.data.slice(2), 'hex')]));
        const sha = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(path.join(out, 'objects', `${sha}.v4.snappy`), bytes);
        print({ schema: start.schema, type: 'head', tier: 'unsafe', finality: 'none', chainId: 8453, signer, payloadVersion: 'v4', objectEncoding: start.objectEncoding,
          objectSha256: sha, objectBytes: bytes.length, number: Number(n), hash: b.hash, stateRoot: b.stateRoot, parentHash: b.parentHash,
          receiptsRoot: b.receiptsRoot, timestamp: Number(BigInt(b.timestamp)), txCount: b.transactions.length, receivedUnixMs: Date.now() });
      }
    } catch {}
    await sleep(300);
  }
}
