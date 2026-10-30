#!/usr/bin/env node
// production-activation-prep-r1 CAPTURE. UNREVIEWED, NOT RUN by its author. Root runs it (network, READ ONLY):
//   node production-activation-prep-r1/capture-observation.mjs --pins <PINS.json> --rpc <https url> --rpc <https url> [--rpc ...] --out <new file>
//
// Pins ONE block (provider 1's latest - 2), requires every provider to return the identical header for it, then walks
// lib/bindings.mjs collectBindings against EACH provider at that block hash (EIP-1898, requireCanonical) and records
// every read. The relayer's "pending" nonce is necessarily read at the tip: a send after the pinned block shows as
// pending > latest and the preparer refuses (not quiescent). Only eth_chainId, eth_getBlockByNumber, eth_getCode,
// eth_call, eth_getStorageAt, eth_getTransactionCount and eth_getBalance are sent; nothing is signed or broadcast; no
// key or env value is read. A binding mismatch fails here already and writes nothing. Only each provider's ORIGIN is
// written (a path-embedded API key never reaches the file); use keyless public endpoints.
import fs from "node:fs";
import path from "node:path";
import { CHAIN_ID, K, callData, collectBindings, lower, normalizeCall, refuse } from "./lib/bindings.mjs";
import { loadContext } from "./lib/context.mjs";
import { OBSERVATION_SCHEMA } from "./prepare-activation.mjs";

const TIMEOUT_MS = 15_000;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

function rpcClient(u) {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!res.ok) refuse("rpc", `${new URL(u).host} ${method}: HTTP ${res.status}`);
    const j = await res.json();
    if (j.error || j.result === undefined) refuse("rpc", `${new URL(u).host} ${method}: ${JSON.stringify(j.error ?? "no result").slice(0, 200)}`);
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
  if (urls.length < 2) refuse("providers", "at least two distinct --rpc providers are required");
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
