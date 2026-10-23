// READ-ONLY live fixture capture (rpc-priority worker). One GET of a public Helios-consensus-API server's /latest and
// /chain_id (used ONLY as a fixture source for a real sequencer-signed Base commitment, never as a dependency), then
// public JSON-RPC reads of that block and of EnclaveAddressBook proofs at its hash. No transaction, no write.
// usage: node capture-live.mjs <repo> <outdir>
import fs from 'node:fs';
import path from 'node:path';
const [repo, out] = process.argv.slice(2);
const { keccak256, encodeAbiParameters, stringToHex } = await import(path.resolve(repo, 'node_modules/viem/_esm/index.js'));
const relay = await import(path.resolve(repo, 'network/op-head-relay.mjs'));
fs.mkdirSync(out, { recursive: true });
const save = (name, v) => fs.writeFileSync(path.join(out, name), JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n');
const SOURCE = 'https://base.operationsolarstorm.org/';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const t0 = Date.now();
const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(10000), redirect: 'error' }); return { status: r.status, text: await r.text() }; };
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`); return j.result;
};
const evidence = { capturedAt: new Date(t0).toISOString(), source: SOURCE, rpcs: RPCS };
const chainId = await get(SOURCE + 'chain_id'); evidence.sourceChainId = chainId;
const latest = await get(SOURCE + 'latest');
fs.writeFileSync(path.join(out, 'commitment.json'), latest.text);
evidence.latestStatus = latest.status;
const raw = JSON.parse(latest.text);
const v = await relay.verifyCommitment(raw, { chainId: 8453, signer: relay.BASE_MAINNET.unsafeSigner });
evidence.head = { ...v.head, number: String(v.head.number), timestamp: Number(v.head.timestamp), ageSecAtCapture: Math.round(t0 / 1000 - Number(v.head.timestamp)) };
evidence.signerVerified = relay.BASE_MAINNET.unsafeSigner;
const txs = relay.payloadTransactions(v.commitment.data);
const types = {}; for (const tx of txs) { const k = tx[0] >= 0xc0 ? 'legacy' : '0x' + tx[0].toString(16).padStart(2, '0'); types[k] = (types[k] || 0) + 1; }
evidence.payloadTxCount = txs.length; evidence.payloadTxTypes = types; evidence.unsupportedTxType = relay.unsupportedTxType(v.commitment.data);
const num = '0x' + v.head.number.toString(16);
evidence.providers = {};
for (const u of RPCS) {
  try {
    const b = await rpc(u, 'eth_getBlockByNumber', [num, false]);
    evidence.providers[u] = { hash: b.hash, stateRoot: b.stateRoot, parentHash: b.parentHash, timestamp: Number(b.timestamp), txCount: b.transactions.length,
      matchesSignedHead: b.hash === v.head.hash && b.stateRoot === v.head.stateRoot && b.parentHash === v.head.parentHash && Number(b.timestamp) === Number(v.head.timestamp) };
  } catch (e) { evidence.providers[u] = { error: String(e.message).slice(0, 200) }; }
}
// AddressBook proofs at the signed block's hash: addr mapping at slot 2 (deployed 6e33baf3e layout) and slot 3 (current source)
const key = stringToHex('registry', { size: 32 });
const slot = (n) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [key, n]));
evidence.bookSlots = { slot2: slot(2n), slot3: slot(3n) };
try {
  const proof = await rpc(RPCS[1], 'eth_getProof', [BOOK, [slot(2n), slot(3n), '0x0'], { blockHash: v.head.hash }]);
  save('book-proof.json', proof);
  evidence.bookProof = { codeHash: proof.codeHash, storageHash: proof.storageHash, values: proof.storageProof.map((s) => [s.key, s.value]) };
  const code = await rpc(RPCS[1], 'eth_getCode', [BOOK, { blockHash: v.head.hash }]);
  evidence.bookCodeKeccak = keccak256(code); evidence.bookCodeBytes = (code.length - 2) / 2;
  const call = await rpc(RPCS[1], 'eth_call', [{ to: BOOK, data: '0x' + keccak256(stringToHex('addr(bytes32)')).slice(2, 10) + key.slice(2) }, { blockHash: v.head.hash }]);
  evidence.bookAddrRegistryViaCall = call;
} catch (e) { evidence.bookProofError = String(e.message).slice(0, 300); }
evidence.elapsedMs = Date.now() - t0;
save('evidence.json', evidence);
console.log(JSON.stringify(evidence, null, 1));
