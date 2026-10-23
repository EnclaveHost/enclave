#!/usr/bin/env node
// Bounded, read-only sizing of Base logsBloom saturation and Enclave-log density (ONE public endpoint).
//   node bloom-density.mjs OUT.json [N_BLOCKS<=29]
// Per sampled block: popcount of the 2048-bit logsBloom and whether it admits each Enclave contract address (a
// complete scan can only skip blocks whose bloom does NOT admit the address: blooms have no false negatives).
// One eth_getLogs over the same range gives the true positives; every true-positive block must be bloom-positive,
// which checks the bloom code. Bounds: <= 32 requests, 20 s each, 8 MiB per response, chainId 8453.
// The data is single-provider and unverified: a sizing measurement only.
import { writeFileSync } from 'node:fs'
const VIEM = process.env.VIEM_DIR
const { keccak256, hexToBytes } = await import(`${VIEM}/_esm/index.js`)

const URL = process.env.RPC_URL || 'https://mainnet.base.org'
const ADDRS = { // live Enclave contracts (outputs/contract-change-audit/live.json book entries)
  deployments: '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b', registry: '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',
  appCatalog: '0x18419ca2b502d423a8de6269aeee171a378626e3', connectivity: '0x5f8b636e0768e84bd47b736652030b65db615111',
  proofOfTime: '0x6f462d77727f10f05a3e660650e7dcc9cc60e6b2', addressBook: '0xab214342d5a490150a4a977063a2f88e21f80907',
}
let calls = 0
async function rpc(method, params) {
  if (++calls > 32) throw new Error('request bound')
  await new Promise(r => setTimeout(r, Number(process.env.PACE_MS || 2000)))  // paced: shared egress with production
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'enclave-bloom-sizing/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }), signal: AbortSignal.timeout(20000) })
  const text = await r.text()
  if (text.length > 8 << 20) throw new Error('response bound')
  const out = JSON.parse(text)
  if (out.error) throw new Error(JSON.stringify(out.error))
  return out.result
}
// Yellow paper M3:2048 — three 11-bit indices from the first three byte pairs of keccak256(item); as a big-endian
// 2048-bit integer, bit `idx` is set (geth core/types/bloom9.go bloomValues).
const bits = (itemHex) => { const h = hexToBytes(keccak256(itemHex)); return [0, 2, 4].map(i => ((h[i] << 8) | h[i + 1]) & 2047) }
const admits = (bloom, itemHex) => bits(itemHex).every(b => (bloom >> BigInt(b)) & 1n)
const popcount = (x) => { let n = 0; while (x) { n += Number(x & 1n); x >>= 1n } return n }

const [out, nArg] = process.argv.slice(2)
const n = Math.min(Number(nArg || 29), 29)
if (Number(await rpc('eth_chainId', [])) !== 8453) throw new Error('not Base mainnet')
const head = Number(await rpc('eth_blockNumber', [])) - 5
const rows = []
for (let k = 0; k < n; k++) {
  let b
  try { b = await rpc('eth_getBlockByNumber', ['0x' + (head - k).toString(16), false]) }
  catch (e) { writeFileSync(out, JSON.stringify({ stopped: String(e.message), rows }, null, 1) + '\n'); console.log('STOPPED', e.message, rows.length); process.exit(3) }
  const bloom = BigInt(b.logsBloom)
  rows.push({ number: Number(b.number), txs: b.transactions.length, bloomBitsSet: popcount(bloom),
    admits: Object.fromEntries(Object.entries(ADDRS).map(([k2, a]) => [k2, admits(bloom, a)])) })
}
const lo = head - n + 1
const logs = await rpc('eth_getLogs', [{ fromBlock: '0x' + lo.toString(16), toBlock: '0x' + head.toString(16), address: Object.values(ADDRS) }])
const trueBlocks = {}
for (const lg of logs) (trueBlocks[lg.address.toLowerCase()] ??= new Set()).add(Number(lg.blockNumber))
for (const [k2, a] of Object.entries(ADDRS)) for (const bn of trueBlocks[a] ?? []) {
  const row = rows.find(r => r.number === bn)
  if (row && !row.admits[k2]) throw new Error(`bloom code wrong: block ${bn} has a ${k2} log but the bloom does not admit it`)
}
const set = rows.map(r => r.bloomBitsSet)
const summary = {
  endpoint: URL, generatedAt: new Date().toISOString(), blocks: [lo, head], requests: calls,
  bloomBitsSet: { min: Math.min(...set), max: Math.max(...set), mean: set.reduce((a, b) => a + b, 0) / set.length },
  txsPerBlockMean: rows.reduce((a, r) => a + r.txs, 0) / rows.length,
  bloomPositiveBlocks: Object.fromEntries(Object.keys(ADDRS).map(k2 => [k2, rows.filter(r => r.admits[k2]).length])),
  truePositiveBlocks: Object.fromEntries(Object.entries(ADDRS).map(([k2, a]) => [k2, trueBlocks[a]?.size ?? 0])),
  logsReturned: logs.length, sampled: rows.length,
}
writeFileSync(out, JSON.stringify({ summary, rows }, null, 1) + '\n')
console.log(JSON.stringify(summary))
