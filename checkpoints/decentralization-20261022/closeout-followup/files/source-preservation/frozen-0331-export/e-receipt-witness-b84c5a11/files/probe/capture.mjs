#!/usr/bin/env node
// Capture UNTRUSTED raw inputs for the offline receipt-witness verifier (one public endpoint, paced, bounded).
//   RPC_URL=… node capture.mjs OUT.json
// 1. eth_getLogs over the last 1000 blocks for the deployment ledger's lease events; pick the newest one: its
//    deployment id X and block E.
// 2. Every header E..A (A = head - 2) as returned by eth_getBlockByNumber(n, false).
// 3. Full receipts (eth_getBlockReceipts) for E and for every block whose logsBloom admits BOTH the ledger address
//    and the topic X (a block whose bloom does not admit both cannot hold a ledger log carrying X).
// Nothing here is trusted: the verifier recomputes every hash and root. Bounds: window <= 120 blocks, <= 190 requests,
// PACE_MS between requests (default 2500), 20 s per request, 16 MiB per response, chainId 8453.
import { writeFileSync } from 'node:fs'
const { keccak256, hexToBytes, toEventSelector } = await import(`${process.env.VIEM_DIR}/_esm/index.js`)
const URL = process.env.RPC_URL
const LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b'
const SIG = {
  Claimed: 'Claimed(bytes32,bytes32,address,uint64,uint256)', Renewed: 'Renewed(bytes32,bytes32,uint64,uint256)',
  Released: 'Released(bytes32,bytes32,uint256)',
}
const TOPIC = Object.fromEntries(Object.entries(SIG).map(([k, s]) => [k, toEventSelector(s)]))
let calls = 0
async function rpc(method, params) {
  if (++calls > 190) throw new Error('request bound')
  await new Promise(r => setTimeout(r, Number(process.env.PACE_MS || 2500)))
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'enclave-witness-capture/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }), signal: AbortSignal.timeout(20000) })
  const text = await r.text()
  if (text.length > 16 << 20) throw new Error('response bound')
  const out = JSON.parse(text)
  if (out.error) throw new Error(`${method}: ${JSON.stringify(out.error)}`)
  return out.result
}
const bits = (itemHex) => { const h = hexToBytes(keccak256(itemHex)); return [0, 2, 4].map(i => ((h[i] << 8) | h[i + 1]) & 2047) }
const admits = (bloomHex, itemHex) => { const b = BigInt(bloomHex); return bits(itemHex).every(i => (b >> BigInt(i)) & 1n) }
const hex = (n) => '0x' + n.toString(16)

const out = process.argv[2]
if (Number(await rpc('eth_chainId', [])) !== 8453) throw new Error('not Base mainnet')
const head = Number(await rpc('eth_blockNumber', [])) - 2
const logs = await rpc('eth_getLogs', [{ fromBlock: hex(head - 999), toBlock: hex(head), address: LEDGER,
  topics: [[TOPIC.Claimed, TOPIC.Renewed, TOPIC.Released]] }])
if (!logs.length) throw new Error('no lease event in the last 1000 blocks')
const last = logs.reduce((a, l) => (Number(l.blockNumber) > Number(a.blockNumber) ||
  (l.blockNumber === a.blockNumber && Number(l.logIndex) > Number(a.logIndex)) ? l : a))
const X = last.topics[1], E = Number(last.blockNumber)
if (head - E > 120) throw new Error(`window ${head - E} > 120 blocks`)
const headers = []
for (let n = E; n <= head; n++) headers.push(await rpc('eth_getBlockByNumber', [hex(n), false]))
const receipts = {}
for (const h of headers) {
  const n = Number(h.number)
  if (n === E || (admits(h.logsBloom, LEDGER) && admits(h.logsBloom, X))) receipts[n] = await rpc('eth_getBlockReceipts', [hex(n)])
}
writeFileSync(out, JSON.stringify({ format: 'enclave-receipt-witness-fixture/v1', endpoint: URL, capturedAt: new Date().toISOString(),
  untrusted: true, ledger: LEDGER, deploymentId: X, eventBlock: E, anchorBlock: head, requests: calls,
  lastEvent: { blockNumber: last.blockNumber, transactionHash: last.transactionHash, logIndex: last.logIndex, topic0: last.topics[0] },
  headers, receipts }) + '\n')
console.log(JSON.stringify({ deploymentId: X, eventBlock: E, anchorBlock: head, window: head - E + 1,
  receiptBlocks: Object.keys(receipts).length, requests: calls, bytes: JSON.stringify(receipts).length }))
