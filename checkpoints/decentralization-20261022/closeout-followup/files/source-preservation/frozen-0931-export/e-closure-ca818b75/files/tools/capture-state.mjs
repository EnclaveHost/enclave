// BOUNDED READ-ONLY RESEARCH CAPTURE (not verification): the code and storage one call touches on a public chain, at
// one pinned block, from two public RPC providers, so the call can be EXECUTED offline on anvil against the real
// deployed bytecode. Every value is a provider's claim (provenance), cross-checked between the two providers; nothing
// here is cryptographically verified and nothing is sent (eth_call / eth_createAccessList / eth_getCode /
// eth_getStorageAt / eth_getBlockByNumber only).
//   node capture-state.mjs <spec.json> <out.json>
//   spec: {name, rpcs:[a,b], blockTag:'finalized', from, to, data, sweepSlots:[n], extraCalls:[{to,data}], maxRequests}
import fs from 'node:fs';
import { keccak256 } from 'viem';

const [specFile, outFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
let requests = 0;
async function post(rpc, body) {
  if (++requests > (spec.maxRequests ?? 24)) throw new Error('request budget exhausted');
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${rpc}: HTTP ${r.status}`);
  return r.json();
}
async function batch(rpc, calls) {
  const out = [];
  const B = spec.batchSize ?? 40;
  for (let i = 0; i < calls.length; i += B) {
    if (i) await new Promise((r) => setTimeout(r, spec.batchDelayMs ?? 0));
    const res = await post(rpc, calls.slice(i, i + B).map(([method, params], j) => ({ jsonrpc: '2.0', id: i + j, method, params })));
    const by = new Map((Array.isArray(res) ? res : [res]).map((x) => [x.id, x]));
    for (let j = 0; j < Math.min(B, calls.length - i); j++) out.push(by.get(i + j) ?? { error: { message: 'missing' } });
  }
  return out;
}
const one = async (rpc, method, params) => { const j = await post(rpc, { jsonrpc: '2.0', id: 1, method, params }); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result; };

async function captureFrom(rpc, block) {
  const tag = block.number;
  const al = await one(rpc, 'eth_createAccessList', [{ from: spec.from, to: spec.to, data: spec.data, gas: '0x' + (3_000_000).toString(16), value: '0x0' }, tag]);
  const slots = new Map();
  const add = (a, s) => { a = a.toLowerCase(); if (!slots.has(a)) slots.set(a, new Set()); if (s) slots.get(a).add(s.toLowerCase()); };
  add(spec.to);
  for (const n of spec.sweepSlots ?? []) for (let i = 0; i < n; i++) add(spec.to, '0x' + i.toString(16).padStart(64, '0'));
  add(spec.to, IMPL); add(spec.to, ADMIN);
  for (const e of al.accessList) { add(e.address); for (const k of e.storageKeys) add(e.address, k); }
  for (const a of [...slots.keys()]) { add(a, IMPL); add(a, ADMIN); }
  const calls = [];
  for (const [a, ks] of slots) { calls.push(['eth_getCode', [a, tag]]); for (const k of ks) calls.push(['eth_getStorageAt', [a, k, tag]]); }
  for (const c of spec.extraCalls ?? []) calls.push(['eth_call', [{ to: c.to, data: c.data }, tag]]);
  const res = await batch(rpc, calls);
  const accounts = {}; const extra = []; const readErrors = [];
  let i = 0;
  for (const [a, ks] of slots) {
    const cr = res[i++]; if (cr.error || cr.result === undefined) readErrors.push(`${a} code: ${cr.error?.message ?? 'no result'}`);
    const code = cr.result ?? null; const storage = {};
    for (const k of ks) { const v = res[i++]; if (v.error || v.result === undefined) { readErrors.push(`${a}[${k}]: ${v.error?.message ?? 'no result'}`); continue; } if (BigInt(v.result) !== 0n) storage[k] = v.result; }
    accounts[a] = { code, codeHash: code ? keccak256(code) : null, storage };
  }
  // a read that failed is NOT a zero: an incomplete capture is refused outright
  if (readErrors.length) throw new Error(`${readErrors.length} reads failed (first: ${readErrors[0]})`);
  for (const c of spec.extraCalls ?? []) { const v = res[i++]; extra.push({ ...c, result: v.result ?? null, error: v.error?.message ?? null }); }
  return { rpc, accessList: al, accounts, extra };
}

// a cross-check run pins the SAME block as the first capture (spec.block = its number)
const blk = await one(spec.rpcs[0], 'eth_getBlockByNumber', [spec.block ?? spec.blockTag ?? 'finalized', false]);
const block = { number: blk.number, hash: blk.hash, timestamp: blk.timestamp, baseFeePerGas: blk.baseFeePerGas, stateRoot: blk.stateRoot };
const caps = [];
for (const rpc of spec.rpcs) { try { caps.push(await captureFrom(rpc, block)); } catch (e) { caps.push({ rpc, error: String(e.message || e) }); } }
// cross-check every captured code hash and slot value between the providers that answered
const ok = caps.filter((c) => !c.error);
const mismatches = [];
if (ok.length >= 2) {
  const [a, b] = ok;
  for (const [addr, acc] of Object.entries(a.accounts)) {
    const o = b.accounts[addr];
    if (!o) { mismatches.push(`${addr}: absent at ${b.rpc}`); continue; }
    if (acc.codeHash !== o.codeHash) mismatches.push(`${addr}: code ${acc.codeHash} vs ${o.codeHash}`);
    for (const k of new Set([...Object.keys(acc.storage), ...Object.keys(o.storage)])) if ((acc.storage[k] ?? '0x0') !== (o.storage[k] ?? '0x0')) mismatches.push(`${addr}[${k}]`);
  }
}
const out = { format: 'enclave-state-capture/v1', label: 'RESEARCH PROVENANCE from public RPC providers; NOT cryptographically verified', name: spec.name,
  capturedAt: new Date().toISOString(), block, spec: { ...spec, rpcs: spec.rpcs }, requests, agreeingProviders: ok.map((c) => c.rpc), crossCheck: ok.length >= 2 ? { mismatches } : 'single provider',
  errors: caps.filter((c) => c.error).map((c) => ({ rpc: c.rpc, error: c.error })), accessList: ok[0]?.accessList ?? null, accounts: ok[0]?.accounts ?? {}, extra: ok.map((c) => ({ rpc: c.rpc, extra: c.extra })) };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ name: spec.name, block: block.number, requests, providers: out.agreeingProviders, mismatches: mismatches.length, errors: out.errors,
  accounts: Object.fromEntries(Object.entries(out.accounts).map(([a, v]) => [a, { codeBytes: v.code ? (v.code.length - 2) / 2 : 0, codeHash: v.codeHash, slots: Object.keys(v.storage).length }])),
  extra: out.extra.map((e) => e.extra.map((x) => x.result ?? x.error)) }, null, 1));
