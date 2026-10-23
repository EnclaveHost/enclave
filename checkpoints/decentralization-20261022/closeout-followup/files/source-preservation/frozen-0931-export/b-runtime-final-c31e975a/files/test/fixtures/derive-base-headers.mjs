// Derive CANONICAL Base mainnet headers, offline, from exact recorded signed payloads (no network):
//   node test/fixtures/derive-base-headers.mjs <gossip objects dir> <heads.jsonl> <call fixture dir> <out dir>
//   env WITNESS_CHECK_BIN: the witness-check helper (patched Helios fork, enclave-witness-check).
// For every real v4 gossip object (rpc-peer-audit head listener run live-20261023T013719Z, 52 blocks 52965055..52965106,
// file names = content sha256) the helper's `exportHeader` verifies the signature against the REAL Base unsafe signer,
// converts the payload with Helios's payload_to_block plus Base's envelope header fields, and REQUIRES alloy
// hash_slow() == the signed block hash. This script then cross-checks each header against the listener's own record of
// that block (heads.jsonl: hash, parent hash, state root, accepted by Base's BlockHandler::block_valid) and requires a
// consecutive parent-linked chain. The real-call fixture's block 52965249 cannot be exported strictly: its TEST-signed
// commitment (record-base-calls.mjs) omits the transactions and the parent beacon root, so the strict export REFUSES it;
// its rebuilt header is written as a labelled SYNTHETIC block identity over the real state root.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWitnessChecker } from '../../network/witness-verify.mjs';
import { BASE_MAINNET } from '../../network/op-head-relay.mjs';

const [objectsDir, headsJsonl, callDir, outDir] = process.argv.slice(2);
const bin = process.env.WITNESS_CHECK_BIN;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const recorded = new Map(fs.readFileSync(headsJsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'head').map((r) => [r.objectSha256, r]));

const real = createWitnessChecker({ bin, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
const headers = [];
try {
  for (const f of fs.readdirSync(objectsDir).sort()) {
    const bytes = fs.readFileSync(path.join(objectsDir, f));
    if (f !== sha(bytes) + '.v4.snappy') throw new Error(`${f}: name is not the content hash`);
    const r = await real.check({ op: 'exportHeader', object: '0x' + bytes.toString('hex') });
    if (!r.ok) throw new Error(`${f}: ${r.error}`);
    const rec = recorded.get(sha(bytes));
    if (!rec || rec.hash !== r.header.hash || rec.parentHash !== r.header.parentHash || rec.stateRoot !== r.header.stateRoot || rec.number !== r.head.number)
      throw new Error(`${f}: derived header disagrees with the listener record`);
    headers.push({ number: r.head.number, hash: r.header.hash, parentHash: r.header.parentHash, stateRoot: r.header.stateRoot, timestamp: r.head.timestamp,
      objectSha256: sha(bytes), header: r.header });
  }
} finally { real.close(); }
headers.sort((a, b) => a.number - b.number);
headers.forEach((h, i) => { if (i && (h.number !== headers[i - 1].number + 1 || h.parentHash !== headers[i - 1].hash)) throw new Error(`chain break at ${h.number}`); });
const out = {
  format: 'enclave-base-canonical-headers/v1', chainId: 8453, signer: BASE_MAINNET.unsafeSigner, authority: 'REAL Base unsafe-block signer (unsafe tier, no L1 finality)',
  source: 'rpc-peer-audit head listener run live-20261023T013719Z (base-consensus-gossip @ base/base 5476069f): 52 signed v4 gossip objects, names = content sha256',
  derivation: 'witness-check exportHeader: SequencerCommitment::verify(real signer) + Helios payload_to_block + Base envelope fields (parent beacon root, L2 withdrawals root, EMPTY_REQUESTS_HASH from Isthmus); alloy hash_slow() == signed block hash; cross-checked against the listener record (hash, parentHash, stateRoot) and as a consecutive parent-linked chain',
  headers,
};
fs.writeFileSync(path.join(outDir, `base-headers-${headers[0].number}-${headers.at(-1).number}.json`), JSON.stringify(out, null, 1) + '\n');

const fixture = JSON.parse(fs.readFileSync(path.join(callDir, 'fixture.json'), 'utf8'));
const test = createWitnessChecker({ bin, chainId: 8453, signer: fixture.testSequencerSigner });
let synthetic;
try {
  // The recorder signed blockFields(real block) with txs: [] and a zero parent beacon root, so this payload CANNOT
  // reproduce the real block hash (the strict export refuses it). The synthetic export returns the rebuilt header:
  // the real block's fields and state root under a SYNTHETIC block identity (its recomputed hash).
  const strict = await test.check({ op: 'exportHeader', commitment: fixture.commitment });
  if (strict.ok) throw new Error('unexpected: the call fixture commitment reproduced the real block hash');
  const r = await test.check({ op: 'exportHeader', commitment: fixture.commitment, synthetic: true });
  if (!r.ok || r.signedHashMatches || r.signedBlockHash !== fixture.block.hash || r.header.stateRoot !== fixture.block.stateRoot) throw new Error('call fixture rebuild disagrees');
  synthetic = { number: r.head.number, hash: r.header.hash, parentHash: r.header.parentHash, stateRoot: r.header.stateRoot, timestamp: r.head.timestamp, header: r.header };
  fs.writeFileSync(path.join(outDir, `base-header-${r.head.number}.synthetic.json`), JSON.stringify({
    format: 'enclave-base-canonical-headers/v1', chainId: 8453, signer: fixture.testSequencerSigner,
    authority: 'SYNTHETIC: TEST-key authority ("5e" x 32, record-base-calls.mjs) AND a synthetic block identity. The recorded commitment carries the real block\'s header fields and state root but no transactions and a zero parent beacon root, so its rebuilt header hashes to a synthetic hash, not the real block hash. The state root (and therefore the recorded proofs) is real; nothing here proves mainnet canonicality.',
    realBlockHash: fixture.block.hash, strictExportRefusal: strict.error,
    source: 'rpc-priority fixture base-calls-20261023T014412Z fixture.json commitment',
    derivation: 'witness-check exportHeader {synthetic:true} with the test signer: Helios payload_to_block + Base envelope fields, alloy hash_slow()',
    headers: [synthetic],
  }, null, 1) + '\n');
} finally { test.close(); }
console.log(JSON.stringify({ realHeaders: headers.length, first: headers[0].number, last: headers.at(-1).number, syntheticCallBlock: synthetic.number, syntheticHash: synthetic.hash }));
