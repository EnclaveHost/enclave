// windows/node/chain.mjs -- the Windows consumer node's chain half: the registry entry that makes
// the box addressable, and the lease it holds for a deployment it runs.
//
// Deliberately NARROWER than the fleet supervisor's (the platform's /app/supervisor.js). This box
// sells a SUBSET of the platform, and the two halves of that sentence are both load-bearing:
//
//  1. It SELLS. It advertises claimEnabled, so it is in the relay's serving set, and in the
//     default "market" scope it claims any wallet's public deployment it can honour. Being listed
//     with capacity and a price is what makes it an enclave rather than a box on a shelf.
//  2. A SUBSET. The relay ANDs capability flags across the serving set (waf, configOverride,
//     configEdit, shareResize, cpuFallback, gpuOptional, networkOptions, secrets are each an
//     `every(...)`), and it takes the fleet's sizing floors and default price the same way. A box
//     that joined that fold without implementing a feature would turn the feature off for every
//     customer on the platform. So this box publishes `fullService: false`, which the relay reads
//     to compute those fleet-wide numbers over the full-service boxes only (fullServiceEnclaves()
//     in relay/api-relay.js, test/fleet-partial-capability.test.mjs), and then says plainly in
//     host.mjs features() which of the platform's options it does and does not implement.
//
// A tenant's deployment may carry a WAF, relay-staged secrets or a CID-borne config. This box
// enforces none of those. Running such a deployment anyway would silently drop the protection the
// owner paid for, so claimPolicy below refuses it BY NAME, and the same parser that refused it is
// the one that later feeds the guest its config.
//
// What it still does, in full: register (EnclaveRegistry.register), heartbeat, claim / renew /
// release (EnclaveDeployments), and resolve a deployment's catalog version to the artifact CID.
import { createPublicClient, createWalletClient, http, fallback, keccak256, toBytes, getAddress, formatEther, stringToHex, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import fs from "node:fs";
import path from "node:path";
import { parseWaf } from "./waf.mjs";

const RPCS = (process.env.BASE_RPCS || "https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org")
  .split(",").map((s) => s.trim()).filter(Boolean);
const BOOK = (process.env.ADDRESS_BOOK_ADDRESS || "0xab214342d5A490150A4A977063A2f88E21F80907").trim();

// The keys the address book publishes (same names the platform's addressbook.js reads).
const BOOK_ABI = [{ type: "function", name: "all", stateMutability: "view", inputs: [],
                    outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }];
const REGISTRY_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" },
             { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" }, { name: "proofKey", type: "address" }],
    outputs: [{ type: "bytes32" }] },
  { type: "function", name: "heartbeat", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setPrices", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" }], outputs: [] },
  // The LIVE registry is the 11-field schema: `caps` and `region` exist in contracts/ (schema 5)
  // but not in the deployed one, and decoding with them reads the endpoint's length as `caps` and
  // fails. Verified against the raw eth_call words for this box's own entry.
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" },
      { name: "operator", type: "address" }, { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" },
      { name: "active", type: "bool" }, { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" },
      { name: "proofKey", type: "address" }, { name: "payoutWallet", type: "address" }] }] },
];
const DEP_ABI = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "renew", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "claimableBy", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view", inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
      { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" }, { name: "active", type: "bool" },
      { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
      { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" },
      { name: "leaseUntil", type: "uint64" }] }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
      { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
      { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" }, { name: "active", type: "bool" },
      { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
      { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" },
      { name: "leaseUntil", type: "uint64" }] }] },
];
const CATALOG_ABI = [
  { type: "function", name: "getVersion", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "cid", type: "string" }, { name: "version", type: "string" }, { name: "vramMb", type: "uint32" }, { name: "gpuGflops", type: "uint32" },
      { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" }, { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" },
      { name: "yanked", type: "bool" }, { name: "ports", type: "string" }, { name: "approval", type: "uint8" }, { name: "config", type: "string" }] }] },
  // The rev-7 surface, a SIDE mapping so the tuple above still decodes on every earlier rev. An
  // app config larger than the version record can hold lives at a CID: the inline `config` is then
  // only the routing manifest (volumes, mem64, set...) and the FETCHED bytes are what the guest
  // gets. Only CALLED when the catalog says it speaks rev 7 or later.
  { type: "function", name: "versionConfigCid", stateMutability: "view",
    inputs: [{ name: "appId", type: "bytes32" }, { name: "index", type: "uint256" }],
    outputs: [{ type: "string" }] },
  { type: "function", name: "catalogSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

/**
 * Which feature surface the catalog speaks.
 *
 * Cached per address, and a transient RPC failure must never cache an OLD rev - only a definitive
 * revert proves a contract that predates `catalogSchema`. `null` means "unknown this round", and
 * the caller fails closed and retries, because guessing low here would hand a guest the routing
 * manifest as its configuration.
 */
let _catRev = { addr: null, rev: null };
export async function catalogSchemaRev() {
  if (!addresses.appCatalog) return null;
  if (_catRev.addr === addresses.appCatalog && _catRev.rev != null) return _catRev.rev;
  try {
    const rev = Number(await publicClient().readContract({ address: addresses.appCatalog, abi: CATALOG_ABI, functionName: "catalogSchema" }));
    _catRev = { addr: addresses.appCatalog, rev };
    return rev;
  } catch (e) {
    // A contract without the function reverts; anything else is the network having a bad moment.
    const definitive = /revert|not a function|returned no data|execution reverted/i.test(e.shortMessage || e.message || "");
    if (definitive) { _catRev = { addr: addresses.appCatalog, rev: 0 }; return 0; }
    return null;
  }
}

export const addresses = { registry: "", deployments: "", appCatalog: "", proofOfTime: "" };
let pub = null, acct = null, wal = null;
// The book keys a value by its NAME right-padded to 32 bytes, not by a hash of it
// (scripts/deploy-address-book.mjs: stringToHex(key, { size: 32 })).
const keyOf = (name) => pad(stringToHex(name), { dir: "right", size: 32 });

export function publicClient() {
  if (!pub) pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { retryCount: 2, retryDelay: 600 }))) });
  return pub;
}
/** The operator key: generated on THIS box, never leaves it, and controls nothing but this row. */
export function loadOperator(keyFile) {
  if (acct) return acct;
  let hex = (process.env.NODE_OPERATOR_KEY || "").trim();
  if (!hex && keyFile && fs.existsSync(keyFile)) hex = fs.readFileSync(keyFile, "utf8").trim();
  if (!hex) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("operator key must be 0x + 64 hex chars");
  acct = privateKeyToAccount(hex);
  wal = createWalletClient({ account: acct, chain: base, transport: fallback(RPCS.map((u) => http(u, { retryCount: 2, retryDelay: 600 }))) });
  return acct;
}
export function newOperatorKey(keyFile) {
  const bytes = new Uint8Array(32); (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);
  const hex = "0x" + Buffer.from(bytes).toString("hex");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, hex + "\n", { mode: 0o600 });
  return privateKeyToAccount(hex).address;
}
export const operatorAddress = () => (acct ? acct.address : null);
export const walletClient = () => wal;
export async function operatorBalance() { return acct ? publicClient().getBalance({ address: acct.address }) : 0n; }

/** Resolve the live contract addresses from the on-chain address book (never hardcoded). */
export async function resolveAddresses() {
  const [keys, vals] = await publicClient().readContract({ address: getAddress(BOOK), abi: BOOK_ABI, functionName: "all" });
  const want = { registry: keyOf("registry"), deployments: keyOf("deployments"), appCatalog: keyOf("appCatalog"), proofOfTime: keyOf("proofOfTime") };
  for (const [name, k] of Object.entries(want)) {
    const i = keys.findIndex((x) => String(x).toLowerCase() === k.toLowerCase());
    if (i >= 0 && vals[i] && /^0x[0-9a-fA-F]{40}$/.test(vals[i]) && BigInt(vals[i]) !== 0n) addresses[name] = getAddress(vals[i]);
  }
  if (!addresses.registry || !addresses.deployments) throw new Error("address book does not publish registry/deployments yet");
  return { ...addresses };
}

export const enclaveIdOf = (endpoint) => keccak256(toBytes(endpoint));
export const readEnclave = (id) => publicClient().readContract({ address: addresses.registry, abi: REGISTRY_ABI, functionName: "get", args: [id] });
export const readDeployment = (id) => publicClient().readContract({ address: addresses.deployments, abi: DEP_ABI, functionName: "get", args: [id] });
/** Every row on the ledger, in pages. The fleet supervisor reads it the same way: eth_calls, never
 *  log scans, because public RPCs cap those. A consumer node is outside the relay's serving set, so
 *  no claim hint ever reaches it and this scan is the ONLY way it finds its owner's work. */
export async function allDeployments({ pageSize = 100 } = {}) {
  const n = Number(await publicClient().readContract({ address: addresses.deployments, abi: DEP_ABI, functionName: "count" }));
  const out = [];
  for (let start = 0; start < n; start += pageSize) {
    const page = await publicClient().readContract({ address: addresses.deployments, abi: DEP_ABI, functionName: "getPage", args: [BigInt(start), BigInt(Math.min(pageSize, n - start))] });
    out.push(...page);
  }
  return out;
}
export const claimableBy = (id, enclaveId) => publicClient().readContract({ address: addresses.deployments, abi: DEP_ABI, functionName: "claimableBy", args: [id, enclaveId] });

// One transaction at a time from this key: public RPCs cap an account at one in flight, and the
// supervisor serializes for the same reason (sendOperatorTx).
let chainTx = Promise.resolve();
// THE NEXT NONCE, as this process knows it. The transport is a fallback over three public RPCs, and
// they do not agree on an account's pending count moment to moment: a read that lands on one a
// block behind hands back the nonce the PREVIOUS transaction already used, and the send fails with
// "Nonce provided for the transaction is lower than the current nonce". On nucbox-k11 that took out
// checkpoints and renewals in turn, and a renewal that fails once is a lease that lapses - which
// for risc-box means a cold boot from scratch. So: never go below the last nonce WE sent.
let nextNonce = null;
async function nonceFor() {
  const seen = await publicClient().getTransactionCount({ address: acct.address, blockTag: "pending" });
  if (nextNonce === null || seen > nextNonce) nextNonce = seen;
  return nextNonce;
}
// Answers a public RPC gives for reasons of its own rather than the transaction's. Worth one retry
// with a fresh nonce read; a real revert comes back from simulateContract and is never retried.
const TRANSIENT = /nonce.*(lower|too low)|replacement transaction underpriced|already known|missing or invalid parameters/i;
async function send(address, abi, functionName, args) {
  const job = async () => {
    if (!wal) throw new Error("no operator key on this box");
    for (let attempt = 0; ; attempt++) {
      try {
        await publicClient().simulateContract({ address, abi, functionName, args, account: acct });   // fail with the revert reason, not a receipt
        const nonce = await nonceFor();
        const hash = await wal.writeContract({ address, abi, functionName, args, nonce });
        nextNonce = nonce + 1;                         // sent: that nonce is spent whatever the receipt says
        const rcpt = await publicClient().waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
        return hash;
      } catch (e) {
        const msg = e.shortMessage || e.message || "";
        if (attempt >= 1 || !TRANSIENT.test(msg)) throw e;
        nextNonce = null;                              // re-read rather than trust what we had
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  return (chainTx = chainTx.then(job, job));
}
/** What a transaction would cost, without sending it: the dry run for an unfunded key. */
export async function estimate(address, abi, functionName, args) {
  const gas = await publicClient().estimateContractGas({ address, abi, functionName, args, account: acct });
  const fees = await publicClient().estimateFeesPerGas();
  const wei = gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
  return { gas, wei, eth: formatEther(wei) };
}

export async function registerBox({ endpoint, repo, measurement, cpuPricePerSec6, gpuPricePerSec6 = 0, proofKey = "0x0000000000000000000000000000000000000000", dryRun = false }) {
  const args = [endpoint, repo, measurement, BigInt(cpuPricePerSec6), BigInt(gpuPricePerSec6), proofKey];
  if (dryRun) return { id: enclaveIdOf(endpoint), ...(await estimate(addresses.registry, REGISTRY_ABI, "register", args)) };
  const hash = await send(addresses.registry, REGISTRY_ABI, "register", args);
  return { id: enclaveIdOf(endpoint), hash };
}
export const heartbeatBox = (id) => send(addresses.registry, REGISTRY_ABI, "heartbeat", [id]);
/** Re-post this box's asks. The registry entry is what the ledger CHARGES, so a price that only
 *  lives in a config file is not a price: it is a hope. */
export const setPrices = (id, cpuPricePerSec6, gpuPricePerSec6) =>
  send(addresses.registry, REGISTRY_ABI, "setPrices", [id, BigInt(cpuPricePerSec6), BigInt(gpuPricePerSec6)]);
export const claimDeployment = (id, enclaveId) => send(addresses.deployments, DEP_ABI, "claim", [id, enclaveId]);
export const renewDeployment = (id) => send(addresses.deployments, DEP_ABI, "renew", [id]);
export const releaseDeployment = (id) => send(addresses.deployments, DEP_ABI, "release", [id]);
export const claimCost = (id, enclaveId) => estimate(addresses.deployments, DEP_ABI, "claim", [id, enclaveId]);

/** catalog://<appId>/<versionIndex> -> the version record (artifact CID, sizing, config, approval). */
export async function resolveAppRef(appRef) {
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(String(appRef || "").trim());
  if (!m) throw new Error(`appRef is not catalog://<appId>/<versionIndex>: ${appRef}`);
  if (!addresses.appCatalog) throw new Error("the address book publishes no appCatalog");
  const v = await publicClient().readContract({ address: addresses.appCatalog, abi: CATALOG_ABI, functionName: "getVersion", args: [m[1], BigInt(m[2])] });
  // ...and, on a rev-7 catalog, where the real config lives. Absent or empty means the inline
  // field IS the config, exactly as on every earlier rev.
  let configCid = "";
  const rev = await catalogSchemaRev();
  if (rev != null && rev >= 7) {
    try {
      configCid = String(await publicClient().readContract({ address: addresses.appCatalog, abi: CATALOG_ABI,
        functionName: "versionConfigCid", args: [m[1], BigInt(m[2])] }) || "");
    } catch { configCid = ""; }
  }
  return { appId: m[1], index: Number(m[2]), ...v, configCid };
}

// ---- what a version's config declares -------------------------------------------------------
// Mirrored from the platform runner (supervisor.js gpuOptionalOfConfig / cpuFallbackOfConfig),
// bounds included, because a box that reads these keys DIFFERENTLY from the rest of the fleet is
// worse than one that does not read them at all: the same app would clear a floor here and fail
// there with nothing having said no.
const CATALOG_MAX_MB = 1048576;          // 1 TB, EnclaveAppCatalog's own MAX_MB
const CATALOG_MAX_GFLOPS = 10000000;     // 10,000 TFLOPS, its MAX_GFLOPS
/**
 * The ROUTING keys a version declares (site/js/core/chain.js ROUTING_KEYS): what a runner must be
 * able to do before it claims. They are the platform's own words for it, and reading them here is
 * what turns "claimed, then failed to compile" into "not taken, because this box has no X".
 *
 * Returns the list of things this version needs that `features` does not offer.
 */
export function unmetNeeds(version, features = {}) {
  let cfg = {};
  try { cfg = JSON.parse(String((version && version.config) || "{}") || "{}"); } catch { return []; }
  const want = [];
  if (cfg.set === true && features.set !== true) want.push("shared-everything threads (the version declares set:true)");
  if (cfg.threads === true && features.coopThreads !== true) want.push("cooperative threads (threads:true)");
  if (cfg.mem64 === true && features.mem64 !== true) want.push("a 64-bit memory (mem64:true)");
  if (String(cfg.wasi || "0.2") === "0.3" && features.p3 !== true) want.push("wasi 0.3 (wasi:\"0.3\")");
  if (Array.isArray(cfg.volumes) && cfg.volumes.length && !(Array.isArray(features.volumes) && cfg.volumes.every((n) => features.volumes.includes(n))))
    want.push(`the attested model volume${cfg.volumes.length > 1 ? "s" : ""} ${cfg.volumes.join(", ")}`);
  return want;
}

/** The publisher saying this version's card specs are what it WOULD use, not what it needs. */
export function gpuOptionalOfConfig(cfg) {
  try { return JSON.parse(String(cfg || "{}") || "{}").gpuOptional === true; } catch { return false; }
}
/** The publisher's CPU-fallback sizing: what the app needs from a NODE with no card under it. */
export function cpuFallbackOfConfig(cfg) {
  let f;
  try { f = JSON.parse(String(cfg || "{}") || "{}").cpuFallback; } catch { return null; }
  if (!f || Array.isArray(f) || typeof f !== "object") return null;
  const num = (x, max) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
  const memMb = num(f.memMb, CATALOG_MAX_MB), cpuGflops = num(f.cpuGflops, CATALOG_MAX_GFLOPS);
  return (memMb || cpuGflops) ? { memMb, cpuGflops } : null;
}
/**
 * The node floor a CORELESS placement of this version demands: the on-chain axes, RAISED by the
 * publisher's cpuFallback when they declared one. One-directional, like the runner's: a fallback
 * smaller than the card case describes something no app does, and taking the smaller figure would
 * under-size the exact placement the key exists for. This box has no card to sell, so every
 * placement it takes is the coreless case.
 */
export function nodeFloorOf(v) {
  const fb = cpuFallbackOfConfig(v && v.config);
  return {
    memMb: Math.max(Number(v && v.memMb) || 0, (fb && fb.memMb) || 0) || 512,
    cpuGflops: Math.max(Number(v && v.cpuGflops) || 0, (fb && fb.cpuGflops) || 0),
    fromFallback: !!(fb && (fb.memMb > (Number(v && v.memMb) || 0) || fb.cpuGflops > (Number(v && v.cpuGflops) || 0))),
  };
}

/**
 * The deployment-options envelope, as much of it as this box implements. Returns the parsed
 * options, or throws with the reason. FAIL-CLOSED, like the platform runner's: an option is never
 * silently dropped, because every one of them is something a tenant paid for or relied on.
 *
 * Known here: `config` (the inline app-config override), `gpu` ({"optional":true}) and `network`
 * ({"relay":"<name>"}, consumed at the DNS layer, nothing for a runner to do but not refuse it).
 * ...and `waf` (per-IP rate limit, concurrency and body caps, method/path/agent filters), which
 * this box now ENFORCES at both its doors - the relay's /x/<id> path and the app's own hostname.
 * NOT known here: nothing. Any other namespace is still refused by name, because the envelope is
 * fail-closed and silently ignoring an option an owner paid for is the one unacceptable answer.
 */
export function parseEnvelope(raw, gpuMilli) {
  const s = String(raw || "").trim();
  if (!s) return {};
  if (!s.startsWith("{")) throw new Error("its options field is a bare CID, not a JSON options envelope");
  let o; try { o = JSON.parse(s); } catch (e) { return void 0, (() => { throw new Error("its options envelope is not readable JSON: " + e.message); })(); }
  if (!o || Array.isArray(o) || typeof o !== "object") throw new Error("its options envelope is not a JSON object");
  const known = ["config", "gpu", "network", "configCid", "waf", "isolation"];
  const unknown = Object.keys(o).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`its options envelope carries ${unknown.join(", ")}, which this node does not enforce (it knows: ${known.join(", ")})`);
  const opts = {};
  if ("gpu" in o) {
    const g = o.gpu;
    if (!g || Array.isArray(g) || typeof g !== "object") throw new Error('gpu must be a JSON object like {"optional":true}');
    const bad = Object.keys(g).filter((k) => k !== "optional");
    if (bad.length) throw new Error(`unknown gpu option ${JSON.stringify(bad[0])} (this node knows: optional)`);
    if ("optional" in g) {
      if (typeof g.optional !== "boolean") throw new Error("gpu.optional must be true or false");
      if (g.optional && gpuMilli != null && Number(gpuMilli) <= 0)
        throw new Error("gpu.optional applies only to a deployment that bought GPU share (this one is 0% GPU, so it already runs anywhere)");
      opts.gpuOptional = g.optional;
    }
  }
  if ("isolation" in o) {
    // THE TENANT'S OWN REQUIREMENT that this deployment runs in its own isolated domain rather
    // than in the shared enclave. Same form as the Linux tier's: {"require": "<backend name>"}.
    //
    // Before this, `isolation` was simply unknown here, so parseEnvelope THREW and claimPolicy
    // refused the deployment outright: a tenant who asked for isolation could not even be claimed,
    // and one who did not ask was logged "not isolating". The net effect was that no deployment
    // could ever be isolated on this node (enclave-99, reading the activation path end to end).
    const iso = o.isolation;
    if (!iso || Array.isArray(iso) || typeof iso !== "object") throw new Error('isolation must be a JSON object like {"require":"hyperv-partition-per-app"}');
    const bad = Object.keys(iso).filter((k) => k !== "require");
    if (bad.length) throw new Error(`unknown isolation option ${JSON.stringify(bad[0])} (this node knows: require)`);
    if ("require" in iso) {
      if (typeof iso.require !== "string" || !/^[a-z0-9-]{3,64}$/.test(iso.require))
        throw new Error("isolation.require must be a backend name like \"hyperv-partition-per-app\"");
      opts.isolationRequire = iso.require;
    }
  }
  if ("waf" in o) {
    // Validated by the same module that enforces it, so "accepted" and "applied" cannot drift.
    opts.waf = parseWaf(o.waf);
  }
  if ("network" in o) {
    const n = o.network;
    if (!n || Array.isArray(n) || typeof n !== "object") throw new Error('network must be a JSON object like {"relay":"us-west"}');
    const bad = Object.keys(n).filter((k) => k !== "relay");
    if (bad.length) throw new Error(`unknown network option ${JSON.stringify(bad[0])} (this node knows: relay)`);
    if ("relay" in n) {
      const r = n.relay;
      if (r === null || r === "") opts.relay = "";
      else if (typeof r !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(r))
        throw new Error('network.relay must be a relay name: lowercase letters, digits and dashes (or "" for the fleet default)');
      else opts.relay = r;
    }
  }
  if ("configCid" in o) {
    // The rev-7 split: the deployment's app-config lives at a pinned CID because the envelope
    // shares one ledger field with everything else and a big config does not fit. The node fetches
    // it through the same CID-verified path as an artifact, so the bytes it applies are the bytes
    // the CID names - that is what makes a config at a CID safe to honour at all.
    const cid = o.configCid;
    if (typeof cid !== "string" || !/^[A-Za-z0-9]{10,100}$/.test(cid))
      throw new Error("configCid must be a bare IPFS CID naming this deployment's config");
    opts.configCid = cid;
  }
  if ("config" in o) {
    const c = o.config;
    if (!c || Array.isArray(c) || typeof c !== "object") throw new Error("config must be a JSON object: the app-config this deployment overrides the version's with");
    opts.config = c;
  }
  return opts;
}

/**
 * May this box run this deployment? Returns null to accept, or the reason to refuse.
 * Every branch is a thing this box does NOT implement or cannot fit; the alternative to refusing
 * is running a tenant's app with a protection they paid for silently missing, or taking a lease
 * this box then cannot honour.
 *
 * SCOPE. "market" (the default once this box advertises claimEnabled) takes any wallet's public
 * deployment it can honour, which is what being listed as a serving enclave means. "owner-only"
 * is the bring-up scope and still reachable (CLAIM_SCOPE=owner-only), for an operator who wants
 * the box on the ledger without selling to strangers.
 *
 * CONSENT, and this is the one rule here with no counterpart on a platform box. An app DOES run
 * inside this box's enclave (windows/enclave-rt), but it is a VBS enclave on a consumer PC and
 * that is a different guarantee from the fleet's confidential VMs: it protects against the
 * machine's software, including its administrator and its kernel, and not against whoever
 * physically holds the box, and on the dev tier the enclave build is test-signed. All of that is
 * published (/availability teeCpu, tier, apps) and on the fleet row, so a buyer who picks this box
 * has been told. Somebody who deployed BEFORE this box was listed was not: every enclave in the
 * fleet was a CVM then. So a stranger's older deployment is refused unless they point at this box
 * themselves - the deploy console's target pick, which arrives here as a claim hint naming this
 * enclave (`invited`). Their own owner's deployments are always in scope, and anything created
 * while this box has been listed was deployed in sight of the row.
 *
 * `legacy` waives that last rule: an operator who has the standing to consent for the owners in
 * question (on this fleet, the platform's own governance wallet and the box owner's) can say so,
 * and then older deployments are taken like any other. It is a switch rather than a default
 * because nobody else's box should be able to decide that for them.
 */
export function claimPolicy(d, { ownerAllow, enclaveId, appsEnabled = true, scope = "market",
                                 version = null, capacity = null, listedAt = 0, invited = false,
                                 legacy = false, fetchesConfigCid = false, features = null,
                                 privateOk = false, isolationBackend = null } = {}) {
  if (!appsEnabled) return "this node is not hosting apps (set APPS=1)";
  if (!d || !Number(d.createdAt)) return "no such deployment on the ledger";
  if (!d.active) return "the deployment is not active";
  // ownerAllow: the SET of owners this box serves (host.mjs ownerSet: its operator and its delegated owners), or one
  // address. Membership, never one equality: the claim, the scan, the restart gate and the sweep ask the same set.
  const allow = new Set([...(ownerAllow instanceof Set ? ownerAllow : Array.isArray(ownerAllow) ? ownerAllow : ownerAllow ? [ownerAllow] : [])]
                          .map((a) => String(a).toLowerCase()));
  const owners = allow.has(String(d.owner || "").toLowerCase());
  if (scope === "owner-only") {
    if (!allow.size) return "this node is in owner-only scope and serves nobody: no operator key and no valid delegation";
    if (!owners) return `this node is in owner-only scope and hosts only its operator's and its delegated owners' deployments (${[...allow].join(", ")}; this one is owned by ${d.owner})`;
  } else if (!owners && !invited && !legacy && Number(listedAt) > 0 && Number(d.createdAt) < Number(listedAt)) {
    return "it was created before this box was listed, and this box is a VBS enclave on a consumer PC:"
         + " an app runs inside the enclave, but the enclave protects it against this machine's software,"
         + " not against whoever physically holds the machine. Pick this enclave in the deploy console,"
         + " or redeploy, and it will run here";
  }
  // A PRIVATE deployment is served to its owner alone. This box verifies the session token that
  // proves that (windows/node/session.mjs), so it may take one - but only when it HAS a key to
  // verify with: a box that took a private deployment and then let anybody reach it would be
  // worse than one that refused it.
  if (!d.isPublic && !privateOk)
    return "it is a private deployment, and this box has no session key to verify its owner with";

  if (d.runner && !/^0x0+$/.test(String(d.runner)) && String(d.runner).toLowerCase() !== String(enclaveId).toLowerCase()
      && Number(d.leaseUntil) * 1000 > Date.now())
    return "another enclave holds a live lease on it";
  // The card. This box HAS one and now sells shares of it, and what a share buys is stated
  // exactly: the model inside the enclave, whose linear algebra is done on the card by masked
  // offload. So a GPU-dialled deployment is welcome here - if the box has the share free and the
  // app is built for the world that can actually reach the model (checked at load, where the
  // artifact's own bytes say which world it is). A box with NO card left, or none at all, still
  // takes such a deployment when somebody with the standing to say so has said the card is soft:
  // the OWNER through the envelope's {"gpu":{"optional":true}}, or the PUBLISHER through the
  // version's gpuOptional.
  let opts;
  try { opts = parseEnvelope(d.configCid, d.gpuMilli); } catch (e) { return e.message; }
  // A DEPLOYMENT THAT REQUIRES ISOLATION may only be claimed by a box that actually runs that
  // backend. Taking it and running it in the shared enclave would give the tenant the opposite of
  // what they asked for while looking like success; refusing here leaves it free for a box that can.
  //
  // THIS MUST STAY BELOW THE PARSE. I put it above, where `opts` is still in its temporal dead
  // zone, so `opts.isolationRequire` threw "Cannot access 'opts' before initialization" for EVERY
  // deployment that reached the line - opted in or not - and host.mjs calls claimPolicy outside any
  // try, so consider() rejected and the deployment was recorded neither refused nor queued. That is
  // a claim path broken for every tenant, from a check meant to affect a few (enclave-99).
  if (opts.isolationRequire) {
    if (!isolationBackend)
      return `it requires isolation backend ${opts.isolationRequire}, and this box runs no isolation backend`;
    if (opts.isolationRequire !== isolationBackend)
      return `it requires isolation backend ${opts.isolationRequire}, and this box runs ${isolationBackend}`;
  }
  if (opts.configCid && !fetchesConfigCid)
    return "its config rides at a CID and this box is not configured to fetch one";
  // What the VERSION says it needs, checked before the gas rather than after the compile. Without
  // this the box claims a lease, fetches three megabytes, and discovers at the compiler that the
  // app wants shared memories - which is a worse answer to give a tenant than "not here".
  if (version && features) {
    const unmet = unmetNeeds(version, features);
    if (unmet.length) return `it needs ${unmet.join(" and ")}, which this box does not offer`;
  }
  const wantsCard = Number(d.gpuMilli) > 0;
  const cardSoft = opts.gpuOptional === true || gpuOptionalOfConfig(version && version.config);
  if (wantsCard && !cardSoft) {
    if (!capacity || !(capacity.cardGb > 0))
      return "it bought a share of a card and this box has none to sell; redeploy with {\"gpu\":{\"optional\":true}} to let it run on cores instead of queueing";
    const wantCard = Number(d.gpuMilli) / 1000;
    if (wantCard > (capacity.gpuShareFree ?? 0) + 1e-9)
      return `it asks for ${Math.round(wantCard * 100)}% of this box's card and ${Math.round((capacity.gpuShareFree ?? 0) * 100)}% of it is left to sell`;
  }
  // APPROVAL, mirrored from the platform runner's approvalVerdict (supervisor.js): rejected and
  // yanked are refused always, and a version still awaiting the catalog owner's approval is
  // refused on a PUBLIC deployment. The fleet's relaxation for this case is dev mode on a private
  // deployment; this box refuses private deployments outright (it verifies no session token), so
  // the one place it can honestly relax is its OWN owner testing their own app on their own
  // machine, where the only person exposed is the person who published it.
  if (version) {
    if (version.yanked) return "the catalog version was yanked by its publisher";
    if (Number(version.approval) === 2) return "the catalog version was rejected by the catalog owner";
    if (Number(version.approval) !== 1 && !owners && !(privateOk && !d.isPublic))
      return "the catalog version is awaiting the catalog owner's approval, and this box runs a pending version only"
           + " for its own owner or on a PRIVATE deployment (the publisher testing their own app)";
  }
  // Capacity, in the numbers the refusal can be checked against. A lease this box cannot fit is
  // worse than one it declines: the tenant's funding is tied up against an app that thrashes.
  if (capacity) {
    const want = Number(d.cpuMilli) / 1000;
    if (capacity.slotsFree != null && capacity.slotsFree <= 0)
      return `this box is running its ${capacity.slots} app slots already`;
    if (want > (capacity.cpuShareFree ?? 0) + 1e-9)
      return `it asks for ${Math.round(want * 100)}% of a node and this box has ${Math.round((capacity.cpuShareFree ?? 0) * 100)}% left to sell`;
    if (version && capacity.ramMbFree != null) {
      const floor = nodeFloorOf(version);
      if (floor.memMb > capacity.ramMbFree)
        return `the version needs ${floor.memMb} MB of node RAM${floor.fromFallback ? " on cores (the publisher's cpuFallback)" : ""} and this box has ${capacity.ramMbFree} MB left`;
      if (capacity.cpuGflops != null && floor.cpuGflops > capacity.cpuGflops * want + 1e-9)
        return `the version needs ${floor.cpuGflops} GFLOPS${floor.fromFallback ? " on cores (the publisher's cpuFallback)" : ""} and ${Math.round(want * 100)}% of this box is ${Math.round(capacity.cpuGflops * want)}`;
    }
  }
  return null;
}
// ---- proof of time --------------------------------------------------------------------------
// The live ledger has proofRequired() = true: claim() refuses an entry with no proofKey, and a
// lease's seconds are credited only up to the last checkpoint this box signed. On the platform's
// own boxes the proof key is minted INSIDE the CVM, so the operator cannot forge "it was running".
// Here it is generated beside the operator key on the Windows host, which the owner controls, so
// on this node a checkpoint is worth exactly what the owner's word is worth. It is published and
// reported honestly (/v1/attestation says where the key lives) rather than dressed up: the model
// and its pads are what VTL1 protects, and a free self-hosted lease has no earnings to forge.
const PROOF_ABI = [
  { type: "function", name: "checkpoint", stateMutability: "nonpayable", inputs: [
    { name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }, { name: "upto", type: "uint64" },
    { name: "anchorBlock", type: "uint64" }, { name: "anchorHash", type: "bytes32" }, { name: "sig", type: "bytes" }], outputs: [] },
  { type: "function", name: "proofWindowSec", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "unprovenSec", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint64" }] },
];
const PROOF_TYPES = { ProofOfTime: [
  { name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "upto", type: "uint64" }, { name: "anchorBlock", type: "uint64" }, { name: "anchorHash", type: "bytes32" }] };
const SET_PROOF_KEY_ABI = [{ type: "function", name: "setProofKey", stateMutability: "nonpayable",
  inputs: [{ name: "id", type: "bytes32" }, { name: "proofKey", type: "address" }], outputs: [] }];

let proofAcct = null;
export function loadProofKey(keyFile) {
  if (proofAcct) return proofAcct;
  let hex = (process.env.NODE_PROOF_KEY || "").trim();
  if (!hex && keyFile && fs.existsSync(keyFile)) hex = fs.readFileSync(keyFile, "utf8").trim();
  if (!hex) return null;
  proofAcct = privateKeyToAccount(hex);
  return proofAcct;
}
export function newProofKey(keyFile) {
  const bytes = new Uint8Array(32); (globalThis.crypto).getRandomValues(bytes);
  const hex = "0x" + Buffer.from(bytes).toString("hex");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, hex + "\n", { mode: 0o600 });
  proofAcct = privateKeyToAccount(hex);
  return proofAcct.address;
}
export const proofAddress = () => (proofAcct ? proofAcct.address : null);
export const setProofKey = (id, addr) => send(addresses.registry, SET_PROOF_KEY_ABI, "setProofKey", [id, addr]);
export const unprovenSec = (id) => publicClient().readContract({ address: addresses.proofOfTime, abi: PROOF_ABI, functionName: "unprovenSec", args: [id] });

/** One checkpoint: "deployment <id> was serving on this box up to <upto>", anchored to a block. */
export async function checkpoint({ id, enclaveId, upto }) {
  if (!proofAcct) throw new Error("no proof key on this box");
  if (!addresses.proofOfTime) throw new Error("the address book publishes no proofOfTime");
  const head = await publicClient().getBlock({ blockTag: "latest" });
  const anchorBlock = Number(head.number) - 1;                       // the parent is always in range
  const parent = await publicClient().getBlock({ blockNumber: BigInt(anchorBlock) });
  const message = { id, enclaveId, operator: acct.address, upto: BigInt(upto), anchorBlock: BigInt(anchorBlock), anchorHash: parent.hash };
  const sig = await proofAcct.signTypedData({
    domain: { name: "EnclaveProofOfTime", version: "1", chainId: base.id, verifyingContract: getAddress(addresses.proofOfTime) },
    types: PROOF_TYPES, primaryType: "ProofOfTime", message });
  return send(addresses.proofOfTime, PROOF_ABI, "checkpoint", [id, enclaveId, BigInt(upto), BigInt(anchorBlock), parent.hash, sig]);
}

export { REGISTRY_ABI, DEP_ABI, CATALOG_ABI, PROOF_ABI };
