// node ops/rpc-snp-prod-r7/base-verify.mjs MEASUREMENT: query Base through the attested front (verified SNP report and
// TLS key) and compare block hashes with public Base. Wrote BASE-VERIFY-r10.json.
import { createAttestedFetch } from '../../rpc/snp/attested-fetch.mjs';
const origin = 'https://127.0.0.1:18443', P = 'https://mainnet.base.org';
const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [process.argv[2]] } } });
let id = 0;
async function rpc(url, method, params, fx = fetch) {
  const r = await fx(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  return r.json();
}
const A = (m, p) => rpc(origin + '/base', m, p, f), Pub = (m, p) => rpc(P, m, p);
const out = { at: new Date().toISOString(), measurement: process.argv[2] };
out.chainId = (await A('eth_chainId', [])).result; out.syncing = (await A('eth_syncing', [])).result;
const a = parseInt((await A('eth_blockNumber', [])).result), p = parseInt((await Pub('eth_blockNumber', [])).result);
Object.assign(out, { head: a, publicHead: p, lag: p - a });
const fin = (await A('eth_getBlockByNumber', ['finalized', false])).result; out.finalized = parseInt(fin.number);
out.blocks = [];
for (const n of [48000000, 48100000, 50000000, 52600000, a - 5]) {
  const x = (await A('eth_getBlockByNumber', ['0x' + n.toString(16), false])).result, y = (await Pub('eth_getBlockByNumber', ['0x' + n.toString(16), false])).result;
  const tx = x.transactions[Math.min(1, x.transactions.length - 1)];
  const rc = (await A('eth_getTransactionReceipt', [tx])).result, t2 = (await A('eth_getTransactionByHash', [tx])).result;
  out.blocks.push({ n, hashMatchesPublic: x.hash === y.hash, txs: x.transactions.length, tx, receiptStatus: rc?.status, logs: rc?.logs.length, txLookup: t2?.blockNumber === x.number });
}
out.contracts = {};
for (const [name, c] of Object.entries({ Catalog: '0x18419ca2b502d423a8de6269aeee171a378626e3', Ledger: '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b', Registry: '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac' }))
  out.contracts[name] = ((await A('eth_getCode', [c, 'latest'])).result.length - 2) / 2;
const lg = await A('eth_getLogs', [{ fromBlock: '0x' + (48000000).toString(16), toBlock: '0x' + (48001999).toString(16), address: '0x4200000000000000000000000000000000000016' }]);
out.getLogs48M = lg.error ? lg.error : lg.result.length;
const lg2 = await A('eth_getLogs', [{ fromBlock: '0x' + (a - 1000).toString(16), toBlock: '0x' + a.toString(16), address: '0x18419ca2b502d423a8de6269aeee171a378626e3' }]);
out.getLogsRecentCatalog = lg2.error ? lg2.error : lg2.result.length;
const bal = await A('eth_getBalance', ['0x0b2d009c0c9Af05b12100D77F3c815fea822eE61', '0x' + (52600000).toString(16)]); out.historicStateAt52_6M = bal.error ? bal.error : bal.result;
console.log(JSON.stringify(out, null, 1));
