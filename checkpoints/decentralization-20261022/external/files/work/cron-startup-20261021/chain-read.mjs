// READ-ONLY (Base 8453, two RPCs at one agreed block): the cron deployment record and its catalog app/versions.
// Public on-chain fields only. node chain-read.mjs > chain.json
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { CATALOG_ABI, LEDGER_ABI } from '../site-host-live-publish/handoff/site-trust.mjs';
const require = createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');
const { createPublicClient, http } = require('viem');
const DEP = '0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c';
const CATALOG = '0x18419CA2b502D423A8de6269AEeE171a378626e3', LEDGER = '0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const norm = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const cs = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'].map((u) => createPublicClient({ transport: http(u, { timeout: 20000, retryCount: 1 }) }));
const heads = await Promise.all(cs.map((c) => c.getBlockNumber())); const B = (heads[0] < heads[1] ? heads[0] : heads[1]) - 3n;
const hs = await Promise.all(cs.map((c) => c.getBlock({ blockNumber: B }).then((b) => b.hash)));
if (hs[0] !== hs[1]) throw Error('RPCs disagree');
const read = async (to, abi, fn, args) => { const r = await Promise.all(cs.map((c) => c.readContract({ address: to, abi, functionName: fn, args, blockNumber: B })));
  if (JSON.stringify(norm(r[0])) !== JSON.stringify(norm(r[1]))) throw Error('disagree ' + fn); return norm(r[0]); };
const d = await read(LEDGER, LEDGER_ABI, 'get', [DEP]);
const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(d.appRef || '');
const out = { block: Number(B), blockHash: hs[0], deployment: { ...d, envelopeSha256: sha(d.configCid || '') } };
if (m) {
  const appId = m[1], idx = Number(m[2]);
  out.app = await read(CATALOG, CATALOG_ABI, 'getApp', [appId]);
  const n = Number(await read(CATALOG, CATALOG_ABI, 'numVersions', [appId]));
  out.versions = [];
  for (let i = 0; i < n; i++) { const v = await read(CATALOG, CATALOG_ABI, 'getVersion', [appId, BigInt(i)]); out.versions.push({ index: i, ...v, configSha256: sha(v.config || '') }); }
  out.runningIndex = idx;
}
console.log(JSON.stringify(out, null, 1));
