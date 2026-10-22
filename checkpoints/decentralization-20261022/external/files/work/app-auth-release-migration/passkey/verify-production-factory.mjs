// READ-ONLY check of the production credit-vault factory named by Enclave's address book (book key vaultFactory,
// 0xa891e4396e3eb11f364554043bc18e86da834e91 per outputs/contract-change-audit/live.json): its runtime and its
// implementation's runtime against the ORIGINAL compiled source (contracts/EnclaveCreditVault.sol, foundry artifact),
// with immutable slots masked, and the immutables decoded - above all origin0/origin1, the only origins a recovery
// signer page may be served from. Two public RPCs must agree. eth_getCode / eth_call only; nothing is sent or signed.
//   node verify-production-factory.mjs > production-factory.json
import fs from 'node:fs';

const OUT = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/foundry/out/EnclaveCreditVault.sol';
const FACTORY = process.env.VAULT_FACTORY || '0xa891e4396e3eb11f364554043bc18e86da834e91';
const RPCS = (process.env.RPCS || 'https://mainnet.base.org,https://base-rpc.publicnode.com').split(',');
const art = (n) => JSON.parse(fs.readFileSync(`${OUT}/${n}.json`, 'utf8'));
const { keccak256 } = await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem/_esm/index.js');

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
}
// both RPCs, at one block both have
const heads = await Promise.all(RPCS.map((u) => rpc(u, 'eth_blockNumber', [])));
const block = '0x' + (Math.min(...heads.map((h) => parseInt(h, 16))) - 5).toString(16);
const agreed = async (method, params) => {
  const got = await Promise.all(RPCS.map((u) => rpc(u, method, [...params, block])));
  if (new Set(got).size !== 1) throw new Error(`the RPCs disagree on ${method}`);
  return got[0];
};
function compare(liveHex, artifact) {
  const live = Buffer.from(liveHex.slice(2), 'hex'), comp = Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex');
  const refs = artifact.deployedBytecode.immutableReferences || {};
  const masked = new Set(), immut = {};
  for (const [id, list] of Object.entries(refs)) for (const { start, length } of list) {
    for (let i = start; i < start + length; i++) masked.add(i);
    immut[id] = live.subarray(start, start + length).toString('hex');
  }
  // the CBOR metadata tail (last 2 bytes = its length) is compared too: same source, same compiler -> same hash
  let diffs = 0; for (let i = 0; i < Math.max(live.length, comp.length); i++) if (!masked.has(i) && live[i] !== comp[i]) diffs++;
  return { liveBytes: live.length, compiledBytes: comp.length, liveCodeHash: keccak256(liveHex), unmaskedDifferences: diffs, immutables: immut };
}
const fArt = art('EnclaveCreditVaultFactory'), vArt = art('EnclaveCreditVault');
const fCode = await agreed('eth_getCode', [FACTORY]);
const impl = '0x' + (await agreed('eth_call', [{ to: FACTORY, data: '0x5c60da1b' }])).slice(26);   // implementation()
const vCode = await agreed('eth_getCode', [impl]);
const f = compare(fCode, fArt), v = compare(vCode, vArt);
// name the vault's immutables: solc numbers declarations in source order, and EnclaveCreditVault declares them
// usdc, book, treasury, factory, recoveryAdmin, origin0, origin0Len, origin1, origin1Len (checked against shape below)
const ORDER = ['usdc', 'book', 'treasury', 'factory', 'recoveryAdmin', 'origin0', 'origin0Len', 'origin1', 'origin1Len'];
const ids = Object.keys(v.immutables).map(Number).sort((a, b) => a - b);
if (ids.length !== ORDER.length) throw new Error(`expected ${ORDER.length} immutables, found ${ids.length}`);
const names = Object.fromEntries(ids.map((id, i) => [id, ORDER[i]]));
const word = (h) => h.slice(-40);
const vImm = Object.fromEntries(Object.entries(v.immutables).map(([id, h]) => [names[id] || id, h]));
const originOf = (w, n) => Buffer.from(w, 'hex').subarray(0, parseInt(n, 16)).toString('utf8');
const report = {
  checkedAt: new Date().toISOString(), block: parseInt(block, 16), rpcs: RPCS.map((u) => new URL(u).host), factory: FACTORY, implementation: impl,
  factoryRuntime: { ...f, immutables: undefined, implementationImmutable: Object.values(f.immutables).map(word) },
  implementationRuntime: { ...v, immutables: undefined },
  decoded: {
    usdc: '0x' + word(vImm.usdc || ''), book: '0x' + word(vImm.book || ''), treasury: '0x' + word(vImm.treasury || ''),
    factory: '0x' + word(vImm.factory || ''), recoveryAdmin: '0x' + word(vImm.recoveryAdmin || ''),
    origin0: vImm.origin0 ? originOf(vImm.origin0, vImm.origin0Len) : null, origin1: vImm.origin1 ? originOf(vImm.origin1, vImm.origin1Len) : null,
  },
  sourceSha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/EnclaveCreditVault.sol')).digest('hex'),
};
const shapeOk = [report.decoded.origin0].every((o) => typeof o === 'string' && /^https?:\/\/[a-z0-9.:-]+$/.test(o)) && /^[0-9a-f]{40}$/.test(report.decoded.book.slice(2));
report.shapeOk = shapeOk;
report.match = shapeOk && f.unmaskedDifferences === 0 && v.unmaskedDifferences === 0 && f.liveBytes === f.compiledBytes && v.liveBytes === v.compiledBytes
  && report.factoryRuntime.implementationImmutable.every((a) => '0x' + a === impl.toLowerCase()) && report.decoded.factory === FACTORY.toLowerCase();
console.log(JSON.stringify(report, null, 1));
