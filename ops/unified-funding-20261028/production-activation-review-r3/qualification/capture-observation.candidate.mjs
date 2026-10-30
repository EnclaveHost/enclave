#!/usr/bin/env node
// production-activation-qualification-r2 CAPTURE CANDIDATE (minimal patch of production-activation-prep-r1/capture-observation.mjs,
// which is unchanged). SOURCE ONLY, NOT RUN by its author. Root runs it after review (network, READ ONLY):
//   node production-activation-qualification-r2/capture-observation.candidate.mjs --pins <PINS.json> --rpc <https url> --rpc <https url> --out <new file>
//
// Changes from the original, nothing else (see CAPTURE-PATCH.md):
//   1. every eth_getBlockByNumber header is validated: number must EQUAL the requested n (the original wrote number=n without
//      looking), hash 32-byte hex, timestamp / baseFeePerGas strict unsigned QUANTITY; all four must agree across providers
//      (the original compared only the hash).
//   2. the two independent provider walks run in parallel (each on its own rpcClient: its own 2500ms pacing, request ids
//      and response identity checks, its own recording reader, the full collectBindings). Sequential walks of ~55 paced
//      reads each could exceed the preparer's 300s block lag; parallel halves it. Both walks are awaited; any refusal
//      refuses the capture and nothing is written.
//   3. before writing, the capture refuses a block already older than the preparer's MAX_BLOCK_LAG_SEC (unchanged 300s).
//   4. capture() accepts { fetchImpl, wait } for tests only; the CLI passes neither (global fetch, real timers).
// rpcClient, the provider allowlist, read-only methods, size / time bounds and SPACING_MS are byte-for-byte the original.
import fs from "node:fs";
import path from "node:path";
import { CHAIN_ID, K, callData, collectBindings, lower, normalizeCall, refuse } from "../production-activation-prep-r1/lib/bindings.mjs";
import { loadContext } from "../production-activation-prep-r1/lib/context.mjs";
import { MAX_BLOCK_LAG_SEC, OBSERVATION_SCHEMA } from "../production-activation-prep-r1/prepare-activation.mjs";

const TIMEOUT_MS = 15_000;
const MAX_RPC_BYTES = 2_000_000;
const SPACING_MS = 4000;
export const PUBLIC_RPCS = Object.freeze(["https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const READ_METHODS = new Set(["eth_blockNumber", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getStorageAt", "eth_getTransactionCount", "eth_getBalance"]);
export function rpcClient(u, { fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!PUBLIC_RPCS.includes(u)) refuse("provider", "capture requires an exact reviewed public RPC URL");
  let id = 0, nextAt = 0;
  return async (method, params) => {
    if (!READ_METHODS.has(method)) refuse("rpc_method", "capture only permits read-only methods");
    const delay = Math.max(0, nextAt - Date.now());
    nextAt = Math.max(nextAt, Date.now()) + SPACING_MS;
    if (delay) await wait(delay);
    const requestId = ++id;
    const res = await fetchImpl(u, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) });
    if (!res.ok) { await res.body?.cancel(); refuse("rpc", `${new URL(u).host} ${method}: HTTP ${res.status}`); }
    const announced = res.headers.get("content-length");
    if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > MAX_RPC_BYTES)) {
      await res.body?.cancel(); refuse("rpc_size", "RPC response exceeds the byte limit");
    }
    if (!res.body) refuse("rpc_body", "RPC response body missing");
    const reader = res.body.getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_RPC_BYTES) { await reader.cancel(); refuse("rpc_size", "RPC response exceeds the byte limit"); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    let j;
    try { j = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); } catch { refuse("rpc_json", "RPC response is not JSON"); }
    if (!j || j.jsonrpc !== "2.0" || j.id !== requestId || j.error || !Object.hasOwn(j, "result")) refuse("rpc_identity", "RPC response ID/version/result does not match the read request");
    return j.result;
  };
}

/** A strict unsigned JSON-RPC QUANTITY (lowercase hex, no leading zero); anything else refuses. */
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const quantity = (v, what) => { if (typeof v !== "string" || !QUANTITY.test(v)) refuse("rpc_header", `${what} is not a strict unsigned quantity`); return BigInt(v); };
/** The header for block n, exactly as the provider returned it: its number must be n. */
export function checkHeader(h, n, origin) {
  if (h === null || typeof h !== "object") refuse("rpc", `${origin} has no header for block ${n}`);
  if (quantity(h.number, `${origin} block number`) !== n) refuse("header_mismatch", `${origin} answered block ${h.number} for requested block ${hex(n)}`);
  if (typeof h.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(h.hash)) refuse("rpc_header", `${origin} block ${n} hash is not 32-byte lowercase hex`);
  const timestamp = quantity(h.timestamp, `${origin} block ${n} timestamp`);
  if (timestamp === 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) refuse("rpc_header", `${origin} block ${n} timestamp is not a positive safe integer`);
  return { number: n.toString(), hash: h.hash, timestamp: timestamp.toString(), baseFeePerGas: quantity(h.baseFeePerGas, `${origin} block ${n} baseFeePerGas`).toString() };
}

/** A reader for collectBindings that queries one provider at the pinned block and records every normalized value. */
function recordingReader(rpc, blockHash) {
  const at = { blockHash, requireCanonical: true };
  const reads = {};
  const rec = (k, v) => { if (k in reads && reads[k] !== v) refuse("provider_unstable", `${k} changed within one capture`); reads[k] = v; return v; };
  return {
    reads,
    code: async (a) => rec(K.code(a), lower(await rpc("eth_getCode", [a, at]))),
    call: async (a, fn, args = []) => rec(K.call(a, fn, args), normalizeCall(fn, await rpc("eth_call", [{ to: a, data: callData(fn, args) }, at]))),
    storage: async (a, slot) => rec(K.storage(a, slot), `0x${lower(await rpc("eth_getStorageAt", [a, slot, at])).slice(2).padStart(64, "0")}`),
    nonce: async (a, tag) => rec(K.nonce(a, tag), BigInt(await rpc("eth_getTransactionCount", [a, tag === "pending" ? "pending" : at])).toString()),
    balance: async (a) => rec(K.balance(a), BigInt(await rpc("eth_getBalance", [a, at])).toString()),
  };
}

export async function capture({ pinsPath, rpcs, out, fetchImpl, wait }) {
  if (typeof out !== "string" || !path.isAbsolute(out)) refuse("out_path", "--out must be an absolute file path");
  if (fs.existsSync(out)) refuse("out_exists", `${out} already exists; nothing is overwritten`);
  const urls = [...new Set(rpcs ?? [])];
  if (urls.length !== 2 || urls.some((u) => !PUBLIC_RPCS.includes(u))) refuse("providers", "two distinct exact reviewed public RPC URLs are required");
  for (const u of urls) if (new URL(u).protocol !== "https:") refuse("provider", `${u} is not https`);
  const ctx = await loadContext(pinsPath, { capture: true });
  const clients = urls.map((u) => ({ origin: new URL(u).origin, rpc: rpcClient(u, { ...(fetchImpl ? { fetchImpl } : {}), ...(wait ? { wait } : {}) }) }));
  for (const c of clients) {
    const id = Number(BigInt(await c.rpc("eth_chainId", [])));
    if (id !== CHAIN_ID) refuse("chain_mismatch", `${c.origin} serves chain ${id}`);
  }
  const tip = quantity((await clients[0].rpc("eth_getBlockByNumber", ["latest", false]))?.number, `${clients[0].origin} latest block number`);
  const n = tip - 2n;
  const headers = [];
  for (const c of clients) headers.push(checkHeader(await c.rpc("eth_getBlockByNumber", [hex(n), false]), n, c.origin));
  for (const k of ["hash", "timestamp", "baseFeePerGas"]) {
    if (headers.some((h) => h[k] !== headers[0][k])) refuse("provider_disagreement", `providers disagree on block ${n}'s ${k} (reorg or lagging provider); capture again`);
  }
  // independent walks, in parallel: each client keeps its own pacing / ids; a refusal in either writes nothing
  const walks = await Promise.allSettled(clients.map(async (c, i) => {
    const r = recordingReader(c.rpc, headers[0].hash);
    await collectBindings(r, ctx);
    return { url: c.origin, chainId: CHAIN_ID, block: headers[i], reads: r.reads };
  }));
  const failed = walks.find((w) => w.status === "rejected");
  if (failed) throw failed.reason;
  const providers = walks.map((w) => w.value);
  const capturedAt = Math.floor(Date.now() / 1000);
  if (capturedAt - Number(headers[0].timestamp) > MAX_BLOCK_LAG_SEC) {
    refuse("observation_stale", `block ${n} is ${capturedAt - Number(headers[0].timestamp)}s old at the end of the capture (max ${MAX_BLOCK_LAG_SEC}); capture again`);
  }
  const observation = { schema: OBSERVATION_SCHEMA, readOnly: true, capturedAt, providers,
    note: "Public read-only chain observation. Not an approval; the preparer re-checks every value across providers." };
  fs.writeFileSync(out, `${JSON.stringify(observation, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return { out, block: headers[0], providers: providers.map((p) => p.url), reads: Object.keys(providers[0].reads).length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const a = process.argv.slice(2), rpcs = [];
  let pinsPath, out;
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === "--rpc") rpcs.push(a[i + 1]);
    else if (a[i] === "--pins") pinsPath = a[i + 1];
    else if (a[i] === "--out") out = a[i + 1];
    else { console.error("usage: capture-observation.candidate.mjs --pins <PINS.json> --rpc <url> --rpc <url> --out <new file>"); process.exit(2); }
  }
  capture({ pinsPath, rpcs, out }).then((r) => console.log(JSON.stringify(r, null, 2)),
    (e) => { console.error(`REFUSED ${e.code ?? ""} ${e.message}`); process.exit(1); });
}
