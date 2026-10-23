// READ-ONLY: tx type histogram over N recent Base blocks from two public RPCs (agreeing hashes only).
import fs from 'node:fs';
const [out, n = '30'] = process.argv.slice(2);
const RPCS = ['https://mainnet.base.org'];   // single provider: publicnode rate-limited this site's shared egress (2026-10-23)
const rpc = async (url, method, params) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; };
const head = Number(await rpc(RPCS[0], 'eth_blockNumber', []));
const hist = {}, blocks = [];
for (let i = 0; i < Number(n); i++) {
  const num = '0x' + (head - 5 - i * 97).toString(16);
  const a = await rpc(RPCS[0], 'eth_getBlockByNumber', [num, true]); await new Promise((r) => setTimeout(r, 700));
  const agree = null;
  for (const tx of a.transactions) hist[tx.type] = (hist[tx.type] || 0) + 1;
  blocks.push({ number: Number(a.number), hash: a.hash, timestamp: Number(a.timestamp), txs: a.transactions.length, agree, headerKeys: Object.keys(a).sort().join(',') });
}
const ev = { capturedAt: new Date().toISOString(), rpcs: RPCS, head, sampled: blocks.length, txTypeHistogram: hist, singleProviderUnverified: true,
  newestTimestamp: blocks[0].timestamp, azul: 1779991200, cobalt: 1790791200, denim: 1793901600, headerKeys: blocks[0].headerKeys, blocks };
fs.writeFileSync(out, JSON.stringify(ev, null, 1) + '\n');
console.log(JSON.stringify({ ...ev, blocks: undefined }, null, 1));
