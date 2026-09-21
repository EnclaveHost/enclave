// windows/node/chain.mjs -- the Windows consumer node's chain half: the registry entry that makes
// the box addressable, and the lease it holds for a deployment it runs.
//
// Deliberately NARROWER than the fleet supervisor's (the platform's /app/supervisor.js). This box
// is OWNER-ONLY: it claims a deployment only when that deployment's owner is the wallet the box
// declares as its payout wallet, and it refuses anything carrying an option it cannot honour. Two
// reasons, both hard rules rather than preferences:
//
//  1. The relay ANDs capability flags across the SERVING set (api-relay.js: waf, configOverride,
//     configEdit, shareResize, cpuFallback, gpuOptional, networkOptions, secrets are each
//     `serving.every(...)`). A box that joins that set without implementing a feature turns the
//     feature off for every customer on the platform. So this box does not advertise
//     claimEnabled, stays out of servingEnclaves(), and takes no work from the market.
//  2. A tenant's deployment may carry a WAF, an app-config override or relay-staged secrets. This
//     box enforces none of those yet. Running such a deployment anyway would silently drop the
//     protection the owner paid for, so the policy below refuses it by name instead.
//
// What it still does, in full: register (EnclaveRegistry.register), heartbeat, claim / renew /
// release (EnclaveDeployments), and resolve a deployment's catalog version to the artifact CID.
import { createPublicClient, createWalletClient, http, fallback, keccak256, toBytes, getAddress, formatEther, stringToHex, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import fs from "node:fs";
import path from "node:path";

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
];

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
async function send(address, abi, functionName, args) {
  const job = async () => {
    if (!wal) throw new Error("no operator key on this box");
    await publicClient().simulateContract({ address, abi, functionName, args, account: acct });   // fail with the revert reason, not a receipt
    const hash = await wal.writeContract({ address, abi, functionName, args });
    const rcpt = await publicClient().waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
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

export async function registerBox({ endpoint, repo, measurement, cpuPricePerSec6, proofKey = "0x0000000000000000000000000000000000000000", dryRun = false }) {
  const args = [endpoint, repo, measurement, BigInt(cpuPricePerSec6), 0n, proofKey];
  if (dryRun) return { id: enclaveIdOf(endpoint), ...(await estimate(addresses.registry, REGISTRY_ABI, "register", args)) };
  const hash = await send(addresses.registry, REGISTRY_ABI, "register", args);
  return { id: enclaveIdOf(endpoint), hash };
}
export const heartbeatBox = (id) => send(addresses.registry, REGISTRY_ABI, "heartbeat", [id]);
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
  return { appId: m[1], index: Number(m[2]), ...v };
}

/**
 * May this box run this deployment? Returns null to accept, or the reason to refuse.
 * Every branch is a thing this box does NOT implement; the alternative to refusing is running a
 * tenant's app with a protection they paid for silently missing.
 */
export function claimPolicy(d, { ownerAllow, enclaveId, appsEnabled = true }) {
  if (!appsEnabled) return "this node is not hosting apps (set APPS=1)";
  if (!d || !Number(d.createdAt)) return "no such deployment on the ledger";
  if (!d.active) return "the deployment is not active";
  const owner = String(d.owner || "").toLowerCase();
  if (!ownerAllow) return "this node hosts only its owner's deployments and no owner wallet is declared";
  if (owner !== String(ownerAllow).toLowerCase())
    return `this node hosts only deployments owned by ${ownerAllow} (this one is owned by ${d.owner})`;
  if (!d.isPublic)
    return "it is a private deployment, whose access control is a session token this node does not verify yet";
  if (Number(d.gpuMilli) > 0)
    return "the deployment asks for a share of a card; this node's card is reserved for masked inference and sells no GPU share";
  if (d.runner && String(d.runner) !== enclaveId && Number(d.leaseUntil) * 1000 > Date.now())
    return "another enclave holds a live lease on it";
  const env = String(d.configCid || "").trim();
  if (env) {
    if (!env.startsWith("{")) return "its options ride at a CID (catalog rev 7 large configs), which this node does not fetch yet";
    let o; try { o = JSON.parse(env); } catch { return "its options envelope is not readable JSON"; }
    const unsupported = Object.keys(o).filter((k) => !["config", "ports", "appPort"].includes(k));
    if (unsupported.length) return `its options envelope carries ${unsupported.join(", ")}, which this node does not enforce`;
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
