#!/usr/bin/env node
// production-activation-prep-r1 CAPTURE. UNREVIEWED, NOT RUN by its author. Root runs it (network, READ ONLY):
//   node production-activation-prep-r1/capture-observation.mjs --pins <PINS.json> --rpc <https url> --rpc <https url> [--rpc ...] --out <new file>
//
// Pins ONE block (provider 1's latest - 2), requires every provider to return the identical header for it, then walks
// lib/bindings.mjs collectBindings against EACH provider at that block hash (EIP-1898, requireCanonical) and records
// every read. The relayer's "pending" nonce is necessarily read at the tip: a send after the pinned block shows as
// pending > latest and the preparer refuses. Equal nonces do NOT prove the live in-memory queue is idle. Only eth_chainId, eth_getBlockByNumber, eth_getCode,
// eth_call, eth_getStorageAt, eth_getTransactionCount and eth_getBalance are sent; nothing is signed or broadcast; no
// key or env value is read. A binding mismatch fails here already and writes nothing. Only each provider's ORIGIN is
// written (a path-embedded API key never reaches the file); use keyless public endpoints.
import fs from "node:fs";
import path from "node:path";
import { CHAIN_ID, K, callData, collectBindings, lower, normalizeCall, refuse } from "./lib/bindings.mjs";
import { loadContext } from "./lib/context.mjs";
import { OBSERVATION_SCHEMA } from "./prepare-activation.mjs";

const TIMEOUT_MS = 15_000;
const MAX_RPC_BYTES = 2_000_000;
const SPACING_MS = 2500;
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

export async function capture({ pinsPath, rpcs, out }) {
  if (typeof out !== "string" || !path.isAbsolute(out)) refuse("out_path", "--out must be an absolute file path");
  if (fs.existsSync(out)) refuse("out_exists", `${out} already exists; nothing is overwritten`);
  const urls = [...new Set(rpcs ?? [])];
  if (urls.length !== 2 || urls.some((u) => !PUBLIC_RPCS.includes(u))) refuse("providers", "two distinct exact reviewed public RPC URLs are required");
  for (const u of urls) if (new URL(u).protocol !== "https:") refuse("provider", `${u} is not https`);
  const ctx = await loadContext(pinsPath, { capture: true });
  const clients = urls.map((u) => ({ origin: new URL(u).origin, rpc: rpcClient(u) }));
  for (const c of clients) {
    const id = Number(BigInt(await c.rpc("eth_chainId", [])));
    if (id !== CHAIN_ID) refuse("chain_mismatch", `${c.origin} serves chain ${id}`);
  }
  const tip = BigInt((await clients[0].rpc("eth_getBlockByNumber", ["latest", false])).number);
  const n = tip - 2n;
  const headers = [];
  for (const c of clients) {
    const h = await c.rpc("eth_getBlockByNumber", [hex(n), false]);
    if (!h?.hash || h.baseFeePerGas === undefined) refuse("rpc", `${c.origin} has no header for block ${n}`);
    headers.push({ number: n.toString(), hash: lower(h.hash), timestamp: BigInt(h.timestamp).toString(), baseFeePerGas: BigInt(h.baseFeePerGas).toString() });
  }
  if (headers.some((h) => h.hash !== headers[0].hash)) refuse("provider_disagreement", `providers disagree on block ${n}'s hash (reorg or lagging provider); capture again`);
  const providers = [];
  for (const [i, c] of clients.entries()) {
    const r = recordingReader(c.rpc, headers[0].hash);
    await collectBindings(r, ctx);      // refuses here on the first mismatch: nothing is written
    providers.push({ url: c.origin, chainId: CHAIN_ID, block: headers[i], reads: r.reads });
  }
  const observation = { schema: OBSERVATION_SCHEMA, readOnly: true, capturedAt: Math.floor(Date.now() / 1000), providers,
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
    else { console.error("usage: capture-observation.mjs --pins <PINS.json> --rpc <url> --rpc <url> --out <new file>"); process.exit(2); }
  }
  capture({ pinsPath, rpcs, out }).then((r) => console.log(JSON.stringify(r, null, 2)),
    (e) => { console.error(`REFUSED ${e.code ?? ""} ${e.message}`); process.exit(1); });
}
