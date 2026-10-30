// DERIVED by production-grant-terms-r1/generator/generate_sdk.py from source/sdk/funding/funding-client.mjs (sha256-pinned). The ONLY
// change: the gas-grant candidate literals are the NEW candidate gas-recovery-6usdc-r1 (lines marked "production-grant-terms-r1"). Root-
// proposed, NOT human-approved; every grant built from it still needs the owner's wallet signature over its digest.
// UNREVIEWED SOURCE (unified-funding client-repair-r4; r3 + central relay wire normalisation). Browser client for
// SUCCESSOR gas sessions (domain "2", action 10 only) over the relay's actual /v1/sessions/funding/* routes. Every
// builder is the reviewed client-r1 codec.
//
// Signing rules enforced here (not just documented):
//   - nothing signs on import, connect or page load: every signing function is called from an explicit click handler
//     and the owner-wallet grant signing refuses unless given an approval bound to the exact digest being signed;
//   - the wallet signs EIP-712 only; each signature is recovered and must be the connected owner over that exact digest;
//   - the session key signs only codec-built domain-2 SessionCall (action 10) / SessionEnd digests;
//   - no runtime -> refuse. FUNDING_RUNTIME (site config) defaults to null; no provisional address is a default here.
//   - owner controls (terminate / withdraw / end) need only the parsed pins or the stored record: no intake, no catalog,
//     no recovery scope, no relay config read.
//   - gas grants are finite app scopes of at most 8 ids; a larger recovery scope must be PARTITIONED explicitly into
//     several grants (each its own key and budget part), never widened to "*" and never given a duplicated budget.
// Wire format: the relay serialises every bigint as a decimal string with an "n" suffix (relay sessions.mjs `ser`).
// relayClient normalises EVERY JSON response body (success, 202 pending and error) with util.normalizeWire, so callers
// (and the site page, which uses the default fetch) always see plain decimal strings. Request bodies are sent as plain
// decimals (canon), which both relays accept.
import {
  decodeFunctionResult, encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi, recoverTypedDataAddress,
} from "viem";
import {
  ACTION_GAS_FUND, DOMAIN_NAME, DOMAIN_VERSION, TYPES_V2, ZERO_HASH, buildGasFundCall, buildGrantV2, fundingConfig,
  parseAddress, parseGasSettlement, parseHex32, parseUint, predictVault,
} from "./funding-codec.mjs";
import { canon, fail, jsonable, lower, normalizeWire, randomHex32, sameAddr } from "./util.mjs";
import { newGasKey, newGasRecord, signerFor } from "./v2-store.mjs";
import { canonicalReceipt, proveOpened } from "./chain-proof.mjs";

export { canonicalReceipt, receiptFinality } from "./chain-proof.mjs";

export const CHAIN_ID = 8453;
export const SIGN_WINDOW = 900n;           // grant / EIP-3009 signBefore (matches the SDK's signWithin: 900)
export const OWNER_OP_WINDOW = 600n;       // owner op signBefore (matches sdk ownerOperation's default)
export const MAX_OBSERVATION_AGE = 120n;   // a pinned block older than this (vs the local clock) is stale

// =====================================================================================================================
// Relay HTTP and JSON-RPC
// =====================================================================================================================

export class RelayError extends Error {
  constructor(code, message, status, detail) {
    super(`${code}: ${message}`);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const RELAY_PATH = /^\/(?:funding\/[A-Za-z0-9/]+|owner(?:\/0x[0-9a-fA-F]{40})?|open|config)$/;

/** request(method, path, body) against `${base}/v1/sessions${path}` (the original routes and the mounted /funding/*).
 *  202 (pending_reconciliation) is returned as { pending: true, ... }, never treated as failure or success. A transport
 *  error is "unknown": the request may have been received. Every JSON response is wire-normalised ("123n" -> "123"). */
export function relayClient(base, fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof base !== "string" || !/^https?:\/\/[^/]+/.test(base)) fail("relay_base", "relay base must be an http(s) origin");
  if (typeof fetchImpl !== "function") fail("fetch_missing", "fetch is unavailable");
  const root = `${base.replace(/\/+$/, "")}/v1/sessions`;
  return async function request(method, path, body) {
    if (method !== "GET" && method !== "POST") fail("relay_method", `method ${method} is not used`);
    if (!RELAY_PATH.test(path)) fail("relay_path", `path ${path} is not an allowed relay route`);
    let res;
    try {
      res = await fetchImpl(root + path, {
        method, headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : canon(body),
      });
    } catch (e) {
      throw new RelayError("relay_unreachable", `relay unreachable: ${e?.message ?? e}`, 0, { sent: "unknown" });
    }
    const text = await res.text();
    let json = {};
    try { json = text ? normalizeWire(JSON.parse(text)) : {}; } catch { json = {}; }
    if (res.status === 202) return { ...json, pending: true, status: 202 };
    if (!res.ok) {
      throw new RelayError(typeof json.code === "string" ? json.code : "relay",
        String(json.error ?? json.message ?? `relay HTTP ${res.status}`), res.status, json);
    }
    return json;
  };
}

export function jsonRpc(url, fetchImpl = globalThis.fetch?.bind(globalThis)) {
  let id = 0;
  return async function rpc(method, params = []) {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await res.json();
    if (j.error) fail("rpc_error", `${method}: ${j.error.message ?? "error"}`, j.error);
    return j.result;
  };
}

export const READ_ABI = parseAbi([
  "function implementation() view returns (address)",
  "function gasAdapter() view returns (address)",
  "function legacyFactory() view returns (address)",
  "function usdc() view returns (address)",
  "function maxEthOut() view returns (uint256)",
  "function vaultFor(address owner) view returns (address)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function free() view returns (uint256)",
  "function addr(bytes32 key) view returns (address)",
  "function held(bytes32 id) view returns (uint8 env, bytes32 promoted)",
]);

export async function ethCall(rpc, to, functionName, args = [], block = "latest", abi = READ_ABI) {
  const data = encodeFunctionData({ abi, functionName, args });
  const out = await rpc("eth_call", [{ to, data }, block]);
  return decodeFunctionResult({ abi, functionName, data: out });
}

/** Pin the latest block, refuse a stale one, and return a recheck() that proves the pin is still canonical. The pinned
 *  CHAIN timestamp is what window checks (void / re-arm) compare against, never the local clock alone. */
export async function pinBlock(rpc, now = BigInt(Math.floor(Date.now() / 1000))) {
  const blk = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (!blk?.number || !blk?.hash || blk.timestamp === undefined) fail("block_unreadable", "latest block unreadable");
  if (!/^0x[0-9a-f]{64}$/.test(lower(blk.hash)) || lower(blk.hash) === ZERO_HASH) fail("block_unreadable", "latest block hash is malformed");
  const ts = BigInt(blk.timestamp);
  if (BigInt(now) > ts + MAX_OBSERVATION_AGE) fail("block_stale", `latest block is ${BigInt(now) - ts}s old`);
  const pin = Object.freeze({ number: BigInt(blk.number), tag: blk.number, hash: lower(blk.hash), timestamp: ts });
  return Object.freeze({ ...pin, async recheck() {
    const again = await rpc("eth_getBlockByNumber", [pin.tag, false]);
    if (!again || lower(again.hash) !== pin.hash || BigInt(again.number) !== pin.number) {
      fail("block_reorged", `block ${pin.number} was replaced while it was read`);
    }
    return pin;
  } });
}

// =====================================================================================================================
// Runtime: operator-supplied pins of the DEPLOYED successor, verified against the chain and the relay
// =====================================================================================================================

export const RUNTIME_SCHEMA = "enclave-funding-browser-runtime-r1";
const RUNTIME_KEYS = ["schema", "chainId", "factory", "implementation", "gasAdapter", "legacyFactory", "usdc", "feeTiers",
  "codehashes", "source"];

function exact(o, keys, name) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) fail("object_type", `${name} must be an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => o[k] === undefined);
  if (extra.length || missing.length) fail("runtime_shape", `${name}: extra [${extra}] missing [${missing}]`);
}

export function parseRuntimePins(p) {
  if (p === null || p === undefined) {
    fail("funding_runtime_unconfigured", "no DEPLOYED successor runtime is configured for this site (FUNDING_RUNTIME is null); nothing is offered");
  }
  exact(p, RUNTIME_KEYS, "runtime");
  if (p.schema !== RUNTIME_SCHEMA) fail("runtime_schema", `runtime.schema must be ${RUNTIME_SCHEMA}`);
  if (Number(p.chainId) !== CHAIN_ID) fail("chain_unsupported", "runtime pins are for Base 8453 only");
  exact(p.codehashes, ["factory", "implementation", "gasAdapter"], "runtime.codehashes");
  exact(p.source, ["kind", "deployTxs", "reviewedBy"], "runtime.source");
  if (p.source.kind !== "deployed-receipts") fail("runtime_provisional", "runtime pins must come from deployment receipts, not a proposal");
  if (!Array.isArray(p.source.deployTxs) || p.source.deployTxs.length === 0) fail("runtime_provenance", "runtime.source.deployTxs is empty");
  p.source.deployTxs.forEach((h, k) => parseHex32(h, `runtime.source.deployTxs[${k}]`, { nonZero: true }));
  if (!Array.isArray(p.feeTiers) || p.feeTiers.length === 0) fail("runtime_fee_tiers", "runtime.feeTiers is empty");
  const feeTiers = p.feeTiers.map((t) => Number(parseUint(t, 24, "feeTier")));
  if (feeTiers.some((t) => ![100, 500, 3000].includes(t))) fail("runtime_fee_tiers", "the adapter accepts 100/500/3000 only");
  return Object.freeze({
    factory: parseAddress(p.factory, "runtime.factory"), implementation: parseAddress(p.implementation, "runtime.implementation"),
    gasAdapter: parseAddress(p.gasAdapter, "runtime.gasAdapter"), legacyFactory: parseAddress(p.legacyFactory, "runtime.legacyFactory"),
    usdc: parseAddress(p.usdc, "runtime.usdc"), feeTiers: Object.freeze(feeTiers),
    codehashes: Object.freeze({ factory: parseHex32(p.codehashes.factory, "codehashes.factory", { nonZero: true }),
      implementation: parseHex32(p.codehashes.implementation, "codehashes.implementation", { nonZero: true }),
      gasAdapter: parseHex32(p.codehashes.gasAdapter, "codehashes.gasAdapter", { nonZero: true }) }),
  });
}

/** Chain first (one pinned, fresh block, rechecked at the end), then the relay. Intake off is reported, never papered
 *  over; a relay that cannot be reached is reported the same way (owner controls do not depend on this function). */
export async function verifyRuntime({ pins, rpc, relay, owner, now }) {
  const P = parseRuntimePins(pins);
  const o = parseAddress(owner, "owner");
  if (BigInt(await rpc("eth_chainId", [])) !== BigInt(CHAIN_ID)) fail("chain_mismatch", "the RPC is not Base 8453");
  const pin = await pinBlock(rpc, now);
  const tag = pin.tag;
  for (const k of ["factory", "implementation", "gasAdapter"]) {
    const code = await rpc("eth_getCode", [P[k], tag]);
    if (!code || code === "0x") fail("missing_code", `${k} ${P[k]} has no code at block ${pin.number}`);
    if (keccak256(code) !== P.codehashes[k]) fail("codehash_mismatch", `${k} ${P[k]} runtime differs from its pin`);
  }
  const eq = async (label, to, fn, args, want) => {
    const got = await ethCall(rpc, to, fn, args, tag);
    if (!sameAddr(got, want)) fail("identity_mismatch", `${label} is ${got}, pinned ${want}`);
  };
  await eq("factory.implementation()", P.factory, "implementation", [], P.implementation);
  await eq("implementation.gasAdapter()", P.implementation, "gasAdapter", [], P.gasAdapter);
  await eq("implementation.legacyFactory()", P.implementation, "legacyFactory", [], P.legacyFactory);
  await eq("implementation.usdc()", P.implementation, "usdc", [], P.usdc);
  const vault = predictVault(P.factory, P.implementation, o);
  await eq("factory.vaultFor(owner)", P.factory, "vaultFor", [o], vault);
  const adapterMaxEthOut = BigInt(await ethCall(rpc, P.gasAdapter, "maxEthOut", [], tag));
  const legacyVault = getAddress(await ethCall(rpc, P.legacyFactory, "vaultFor", [o], tag));
  await pin.recheck();

  let intake = null;
  let intakeWhy = null;
  try {
    const c = await relay("GET", "/funding/config");
    if (c.enabled !== true || Number(c.chainId) !== CHAIN_ID || Number(c.action) !== ACTION_GAS_FUND) fail("relay_config", "relay funding config is not enabled for Base action 10");
    for (const [k, want] of [["factory", P.factory], ["implementation", P.implementation], ["adapter", P.gasAdapter], ["legacyFactory", P.legacyFactory]]) {
      if (!sameAddr(c[k], want)) fail("relay_identity", `relay ${k} ${c[k]} differs from the verified pin ${want}`);
    }
    if (BigInt(c.adapterMaxEthOut) !== adapterMaxEthOut) fail("relay_identity", "relay adapterMaxEthOut differs from the chain");
    const tiers = (c.feeTiers ?? []).map(Number);
    if (tiers.length === 0 || tiers.some((t) => !P.feeTiers.includes(t))) fail("relay_identity", "relay fee tiers are not a subset of the pins");
    intake = Object.freeze({ feeTiers: Object.freeze(tiers), relayer: parseAddress(c.relayer, "relayer"),
      openEnabled: c.open?.enabled === true, ownerEnabled: c.owner?.enabled === true, notAfter: String(c.notAfter) });
  } catch (e) {
    if (e?.code !== "funding_disabled" && e?.code !== "relay_unreachable") throw e;
    intakeWhy = e.message;
  }
  const cfg = fundingConfig({ chainId: CHAIN_ID, factory: P.factory, implementation: P.implementation, vault, owner: o,
    gasAdapter: P.gasAdapter, legacyFactory: P.legacyFactory, legacyVault, adapterMaxEthOut,
    adapterFeeTiers: intake ? [...intake.feeTiers] : [...P.feeTiers] });
  return Object.freeze({ cfg, pins: P, intake, intakeWhy, relayer: intake?.relayer ?? null,
    block: Object.freeze({ number: pin.number, hash: pin.hash, timestamp: pin.timestamp }) });
}

// =====================================================================================================================
// Recovery scope: fresh chain reads of the provisional deployment list (custody env from the vault's own held())
// =====================================================================================================================

const LEDGER_ROW = [["id", "bytes32"], ["owner", "address"], ["appRef", "string"], ["ports", "string"], ["configCid", "string"],
  ["gpuMilli", "uint16"], ["cpuMilli", "uint16"], ["appPort", "uint32"], ["isPublic", "bool"], ["active", "bool"],
  ["createdAt", "uint64"], ["rate", "uint256"], ["balance6", "uint256"], ["spent6", "uint256"], ["runner", "bytes32"],
  ["runnerOperator", "address"], ["leaseUntil", "uint64"]].map(([name, type]) => ({ name, type }));
const LEDGER_GET = Object.freeze([{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }],
  outputs: [{ type: "tuple", components: LEDGER_ROW }] }]);
const bookKey = (s) => `0x${Array.from(new TextEncoder().encode(s), (x) => x.toString(16).padStart(2, "0")).join("").padEnd(64, "0")}`;
export const MAX_GRANT_APPS = 8;              // contract + codec limit per grant; NOT changed here

/** deploymentIds come from recovery-plan.json and are PROVISIONAL: each is re-read here at one pinned block. A record
 *  in the legacy vault takes its env from legacyVault.held(id) (the custody record itself, not the relay's index).
 *  More than 8 distinct apps is reported as `partitionRequired` with the per-app breakdown: the plan must then name an
 *  explicit partition (each part <= 8 apps); nothing is ever widened to "*". */
export async function freshRecoveryScope({ rpc, book, owner, legacyVault, deploymentIds, now }) {
  const o = parseAddress(owner, "owner");
  const lv = parseAddress(legacyVault, "legacyVault");
  if (!Array.isArray(deploymentIds) || deploymentIds.length === 0) fail("scope_empty", "no recovery deployments are configured");
  const pin = await pinBlock(rpc, now);
  const ledger = await ethCall(rpc, parseAddress(book, "book"), "addr", [bookKey("deployments")], pin.tag);
  const deployments = new Map();
  for (const raw of deploymentIds) {
    const id = parseHex32(lower(raw), "deployment", { nonZero: true });
    if (deployments.has(id)) fail("scope_duplicate", `deployment ${id} listed twice`);
    const row = await ethCall(rpc, ledger, "get", [id], pin.tag, LEDGER_GET);
    if (lower(row.id) !== id) fail("scope_missing", `deployment ${id} is not in the ledger`);
    const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(0|[1-9]\d*)$/.exec(row.appRef);
    if (!m) fail("scope_app_unresolvable", `deployment ${id} runs no catalog app; a gas grant cannot name it`);
    let holder, env;
    if (sameAddr(row.owner, o)) { holder = o; env = 2; }
    else if (sameAddr(row.owner, lv)) {
      holder = lv;
      const [heldEnv] = await ethCall(rpc, lv, "held", [id], pin.tag);
      env = Number(heldEnv);
      if (env !== 1 && env !== 2) fail("scope_not_adopted", `deployment ${id} is in the legacy vault but not adopted (held env ${env})`);
    } else fail("scope_holder_foreign", `deployment ${id} is held by ${row.owner}, not the owner or the legacy vault`);
    deployments.set(id, Object.freeze({ holder, env, appId: lower(m[1]), active: row.active }));
  }
  await pin.recheck();
  const byApp = {};
  for (const [id, d] of deployments) (byApp[d.appId] ??= []).push(id);
  const appIds = Object.keys(byApp).sort();
  const partitionRequired = appIds.length > MAX_GRANT_APPS;
  return Object.freeze({ deployments, appIds: Object.freeze(appIds), byApp: Object.freeze(byApp), partitionRequired,
    constraint: partitionRequired ? `${appIds.length} distinct apps > ${MAX_GRANT_APPS} per grant: name an explicit partition `
      + `(at least ${Math.ceil(appIds.length / MAX_GRANT_APPS)} gas grants, disjoint, covering every app)` : null,
    block: pin.number, blockHash: pin.hash, timestamp: pin.timestamp });
}

// =====================================================================================================================
// Gas-only grants (candidate terms; reviewable, not approved). A partition part narrows these candidate terms (its own
// budget <= 6 USDC, spendPerPeriod = its budget, opsPerPeriod <= 20); it never widens any cap.
// production-grant-terms-r1: NEW candidate gas-recovery-6usdc-r1 replaces the 1 USDC / 0.05 fee / 0.10 gas / 2e13 wei literals. maxUsdcPerEth6,
// the period, the 20 ops, staging+prod, action 10, the finite <= 8 app scope and the expiry rule are unchanged.
// =====================================================================================================================

export const GAS_GRANT_CANDIDATE = Object.freeze({
  id: "gas-recovery-6usdc-r1",                                                       // production-grant-terms-r1: NEW candidate
  preset: "gas-recovery", actions: Object.freeze(["gas.fund"]), environments: Object.freeze(["staging", "prod"]),
  budget: 6_000_000n, spendPerPeriod: 6_000_000n, periodSeconds: 86_400n, opsPerPeriod: 20n,      // production-grant-terms-r1
  maxFeePerOp: 80_000n, maxAppFeePerHour: 0n, maxRatePerHour: 0n,                                  // production-grant-terms-r1
  maxGasUsdcPerOp: 600_000n, maxUsdcPerEth6: 2_500_000_000n, maxEthPerOp: 200_000_000_000_000n, measurement: ZERO_HASH,   // production-grant-terms-r1
});

export function buildGasGrant(cfg, { now, sessionKey, appIds, expiresAt, legacyExpiresAt, grantNonce, signBefore, label, budget, part }) {
  const T = GAS_GRANT_CANDIDATE;
  let b, spend, ops;
  if (part === undefined) {
    b = budget === undefined ? T.budget : parseUint(budget, 128, "budget");
    if (b !== T.budget) fail("gas_budget_not_candidate", `gas budget ${b} differs from the reviewed candidate ${T.budget}; a different split needs a new review`);
    spend = T.spendPerPeriod;
    ops = T.opsPerPeriod;
  } else {
    b = parseUint(part.budget6, 128, "part.budget6");
    if (b === 0n || b > T.budget) fail("gas_part_budget", `a gas part budget must be 1..${T.budget}`);
    if (budget !== undefined && parseUint(budget, 128, "budget") !== b) fail("gas_budget_not_candidate", "budget differs from the part");
    ops = parseUint(part.opsPerPeriod, 32, "part.opsPerPeriod");
    if (ops === 0n || ops > T.opsPerPeriod) fail("gas_part_ops", `a gas part may allow 1..${T.opsPerPeriod} ops per period`);
    spend = b;
  }
  if (!Array.isArray(appIds) || appIds.length === 0 || appIds.length > MAX_GRANT_APPS) fail("gas_scope_apps", `1..${MAX_GRANT_APPS} app ids required`);
  const apps = appIds.map((a, k) => parseHex32(lower(a), `appIds[${k}]`, { nonZero: true }));
  if (new Set(apps).size !== apps.length) fail("gas_scope_apps", "app ids must be distinct");
  const exp = parseUint(expiresAt, 64, "expiresAt");
  if (exp > parseUint(legacyExpiresAt, 64, "legacyExpiresAt")) fail("gas_expiry_after_legacy", "the gas grant may not outlive the old grant");
  const grant = {
    label: String(label), preset: T.preset, sessionKey, actions: [...T.actions], apps, environments: [...T.environments],
    budget: b, spendPerPeriod: spend, periodSeconds: T.periodSeconds, opsPerPeriod: ops,
    maxFeePerOp: T.maxFeePerOp, maxAppFeePerHour: T.maxAppFeePerHour, maxRatePerHour: T.maxRatePerHour,
    maxGasUsdcPerOp: T.maxGasUsdcPerOp, maxUsdcPerEth6: T.maxUsdcPerEth6, maxEthPerOp: T.maxEthPerOp,
    expiresAt: exp, measurement: T.measurement, grantNonce, signBefore,
  };
  const built = buildGrantV2(cfg, { domainVersion: "2", now, grant });
  if (built.actionsMask !== 1n << BigInt(ACTION_GAS_FUND) || built.envsMask !== 3 || !built.gasFundGranted) {
    fail("gas_grant_shape", "the gas grant must be exactly action 10 over staging+prod");
  }
  return built;
}

/** Plain JSON form of a codec-built grant for the relay body (decimal strings). */
export const grantBody = (built) => jsonable(built.typedData.message);

/** Rebuild the codec review of a STORED (journaled) gas grant and require the same digest. */
export function rebuildGasReview(cfg, grantJson, digest, now) {
  const built = buildGrantV2(cfg, { domainVersion: "2", now, grant: { ...grantJson } });
  if (lower(built.digest) !== lower(digest)) fail("review_digest_mismatch", "stored gas grant does not hash to its stored digest");
  if (built.actionsMask !== 1n << BigInt(ACTION_GAS_FUND) || built.envsMask !== 3) fail("gas_grant_shape", "stored gas grant is not action 10 over staging+prod");
  return built;
}

/** The ONE open gas record whose finite app scope names the deployment's app. No "first open grant" fallback: a missing
 *  or not-yet-open matching grant refuses, and two matching open grants refuse as ambiguous. */
export function selectGasRecord(records, scope, deployment) {
  const d = parseHex32(lower(deployment), "deployment", { nonZero: true });
  const entry = scope.deployments.get(d);
  if (!entry) fail("deployment_out_of_scope", `deployment ${d} is not in the freshly checked recovery scope`);
  const covers = (r) => Array.isArray(r.grant?.apps) && r.grant.apps.map(lower).includes(entry.appId);
  const matching = records.filter(covers);
  const open = matching.filter((r) => r.status === "open");
  if (open.length === 0) {
    fail("matching_grant_not_open", `no OPEN gas grant names app ${entry.appId}`, { matching: matching.map((r) => ({ id: r.id, status: r.status })) });
  }
  if (open.length > 1) fail("matching_grant_ambiguous", `${open.length} open gas grants name app ${entry.appId}`);
  return open[0];
}

// =====================================================================================================================
// Wallet (EIP-1193) EIP-712, recovered against the exact digest
// =====================================================================================================================

const DOMAIN_FIELDS = Object.freeze([{ name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }]);

export async function walletSignTyped(provider, address, td) {
  if (!provider || typeof provider.request !== "function") fail("wallet_missing", "connect a wallet first");
  const payload = JSON.stringify({ types: { EIP712Domain: DOMAIN_FIELDS, ...td.types }, domain: td.domain,
    primaryType: td.primaryType, message: td.message }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const sig = await provider.request({ method: "eth_signTypedData_v4", params: [address, payload] });
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    fail("wallet_signature_format", "the wallet returned no 65-byte ECDSA signature (contract wallets are not supported here)");
  }
  const who = await recoverTypedDataAddress({ domain: td.domain, types: td.types, primaryType: td.primaryType,
    message: td.message, signature: sig });
  if (!sameAddr(who, address)) fail("wallet_signed_other", "the signature does not recover to the owner for this exact digest");
  return sig;
}

export const RECEIVE_TYPES = Object.freeze({ ReceiveWithAuthorization: Object.freeze([
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }]) });

export async function usdcDomain(rpc, usdc) {
  const [name, version] = [await ethCall(rpc, usdc, "name"), await ethCall(rpc, usdc, "version")];
  return Object.freeze({ name, version, chainId: CHAIN_ID, verifyingContract: getAddress(usdc) });
}

/** EIP-3009 deposit whose nonce IS the grant digest (as the SDK's signDeposit), so it funds that grant and nothing else. */
export function depositTypedData(usdc, { from, to, value, nonce, validBefore }) {
  return { domain: usdc, types: RECEIVE_TYPES, primaryType: "ReceiveWithAuthorization",
    message: { from: getAddress(from), to: getAddress(to), value: BigInt(value), validAfter: 0n, validBefore: BigInt(validBefore),
      nonce: parseHex32(nonce, "deposit nonce", { nonZero: true }) } };
}

/** Owner-wallet grant signing needs an approval naming the exact digest; checked BEFORE the provider is touched. */
export function requireApproval(approval, digest, what) {
  if (!approval || approval.rootReviewed !== true || lower(approval.digest) !== lower(digest)) {
    fail("approval_required", `${what}: no reviewed approval for digest ${digest}; nothing was signed`);
  }
}

// =====================================================================================================================
// Opening a gas session: review (no wallet) -> sign (wallet, after approval) -> submit -> chain proof
// =====================================================================================================================

async function journal(store, entry) { await store.putJournal({ ...entry, at: Number(entry.at ?? Math.floor(Date.now() / 1000)) }); }

/** A fresh non-extractable key per call: every gas grant (and every partition part) gets its own key. */
export async function prepareGasOpen({ runtime, store, relayBase, appIds, legacyExpiresAt, expiresAt, label = "Gas recovery",
  now, subtle, rng, signBefore, part }) {
  const cfg = runtime.cfg;
  const key = await newGasKey(subtle);
  const rec = newGasRecord({ key, chainId: CHAIN_ID, relay: relayBase, owner: cfg.owner, vault: cfg.vault, factory: cfg.factory,
    implementation: cfg.implementation, label, now });
  const built = buildGasGrant(cfg, { now, sessionKey: key.keyHash, appIds, expiresAt, legacyExpiresAt, grantNonce: randomHex32(rng),
    signBefore: signBefore ?? BigInt(now) + SIGN_WINDOW, label, part });
  Object.assign(rec, { grant: grantBody(built), grantDigest: built.digest, sid: built.sessionId, status: "reviewed" });
  await store.saveKey(rec);
  return { record: rec, review: built };
}

/** Two wallet prompts: the v2 grant, then the USDC authorization. Returns the relay body (memory only, never stored). */
export async function signGasOpen({ runtime, provider, rpc, review, approval, now }) {
  requireApproval(approval, review.digest, "gas grant");
  const cfg = runtime.cfg;
  const g = review.typedData.message;
  if (BigInt(now) > g.signBefore) fail("sign_window_passed", "the grant's signBefore passed; prepare a fresh one");
  const ownerSig = await walletSignTyped(provider, cfg.owner, review.typedData);
  const usdc = await usdcDomain(rpc, runtime.pins.usdc);
  const dep = depositTypedData(usdc, { from: cfg.owner, to: cfg.vault, value: g.budget, nonce: review.digest, validBefore: g.signBefore });
  const depSig = await walletSignTyped(provider, cfg.owner, dep);
  return { owner: cfg.owner, grant: grantBody(review), ownerSig, deposit: { validAfter: "0", validBefore: g.signBefore.toString(), sig: depSig } };
}

/** The successor open is proven on chain (canonical receipt + SessionOpened/AuthorizationUsed/Transfer), never from the
 *  relay's word. null = not canonical yet. */
export async function proveGasOpen({ runtime, rpc, review, txHash }) {
  const rc = await canonicalReceipt(rpc, txHash);
  if (!rc) return null;
  const g = review.typedData.message;
  return { receipt: rc, proof: proveOpened(rc, { vault: runtime.cfg.vault, usdc: runtime.pins.usdc, owner: runtime.cfg.owner,
    sid: review.sessionId, keyHash: g.sessionKey, digest: review.digest, amount6: g.budget, expiresAt: g.expiresAt,
    actions: review.actionsMask, envs: review.envsMask }) };
}

export async function submitGasOpen({ runtime, store, relay, rpc, record, review, body, now }) {
  if (!runtime.intake?.openEnabled) fail("intake_off", `successor intake/open is off: ${runtime.intakeWhy ?? "open disabled"}`);
  const id = `gas-open:${review.sessionId}`;
  const base = { id, kind: "gas-open", sid: review.sessionId, grantDigest: review.digest, at: now };
  await journal(store, { ...base, status: "submitting" });
  let out;
  try { out = await relay("POST", "/funding/open", body); }
  catch (e) {
    await journal(store, { ...base, status: e.code === "relay_unreachable" ? "unknown" : "refused", code: e.code });
    throw e;
  }
  if (out.sid !== undefined && lower(out.sid) !== review.sessionId) fail("relay_sid_mismatch", `relay reported ${out.sid}, expected ${review.sessionId}`);
  const txHash = out.txHash ? lower(out.txHash) : null;
  if (!txHash) { await journal(store, { ...base, status: "pending" }); return { pending: true, txHash: null, sid: review.sessionId }; }
  const proven = await proveGasOpen({ runtime, rpc, review, txHash });
  const rec = await store.loadKey(record.id);
  Object.assign(rec, { status: proven ? "open" : "submitted",
    open: { txHash, block: proven ? Number(BigInt(proven.receipt.blockNumber)) : null } });
  await store.saveKey(rec);
  await journal(store, { ...base, status: proven ? "done" : "pending", txHashes: [txHash] });
  return { pending: !proven, txHash, sid: review.sessionId };
}

// =====================================================================================================================
// gas.fund: quote (relay) -> exact review (codec) -> session-key signature (explicit click) -> execute -> settlement
// =====================================================================================================================

function grantOf(record) {
  const g = record.grant;
  return { maxFeePerOp: BigInt(g.maxFeePerOp), maxGasUsdcPerOp: BigInt(g.maxGasUsdcPerOp), maxUsdcPerEth6: BigInt(g.maxUsdcPerEth6),
    maxEthPerOp: BigInt(g.maxEthPerOp), apps: g.apps.map(lower), environments: g.environments };
}

export async function quoteGasFund({ runtime, record, relay, scope, deployment, ethOut, feeTier, now, journalEntries = [] }) {
  const cfg = runtime.cfg;
  if (!runtime.intake) fail("intake_off", `gas.fund intake is off: ${runtime.intakeWhy ?? "unknown"}`);
  if (record.status !== "open" || !record.sid) fail("session_not_open", "the gas session is not open");
  if (scope.timestamp !== undefined && BigInt(now) > BigInt(scope.timestamp) + MAX_OBSERVATION_AGE) {
    fail("scope_stale", "the recovery scope was read too long ago; re-read it before quoting");
  }
  const unresolved = journalEntries.filter((e) => e.kind === "gas-execute" && e.sid === record.sid && !["settled", "refused"].includes(e.status));
  if (unresolved.length) fail("unreconciled_execute", "an earlier gas.fund is not reconciled; reconcile it first (never resent)", { ids: unresolved.map((e) => e.id) });
  const d = parseHex32(lower(deployment), "deployment", { nonZero: true });
  const entry = scope.deployments.get(d);
  if (!entry) fail("deployment_out_of_scope", `deployment ${d} is not in the freshly checked recovery scope`);
  const g = grantOf(record);
  if (!g.apps.includes(entry.appId)) fail("app_not_granted", "the deployment's app is not named by the gas grant");
  if (!g.environments.includes(entry.env === 1 ? "staging" : "prod")) fail("env_not_granted", "environment not granted");
  const eo = parseUint(ethOut, 96, "ethOut");
  if (eo === 0n || eo > g.maxEthPerOp) fail("eth_cap", `ethOut must be 1..${g.maxEthPerOp}`);
  const tier = Number(parseUint(feeTier, 24, "feeTier"));
  const view = await relay("GET", `/funding/session/${cfg.vault}/${record.sid}`);
  if (view?.state?.live !== true) fail("session_not_live", "the relay reports this session is not live");
  if (lower(view.state.keyHash) !== record.keyHash) fail("key_mismatch", "the session's key hash is not this browser's key");
  const balance6 = BigInt(view.state.balance6);

  const q = await relay("POST", "/funding/quote", { vault: cfg.vault, sid: record.sid, deployment: d, ethOut: eo, feeTier: tier });
  if (!sameAddr(q.vault, cfg.vault) || lower(q.sid) !== record.sid || Number(q.action) !== ACTION_GAS_FUND || Number(q.chainId) !== CHAIN_ID) {
    fail("quote_identity", "the quote names another vault, session, action or chain");
  }
  const i = q.intent ?? {};
  if (lower(i.deployment) !== d || BigInt(i.ethOut) !== eo || Number(i.fee) !== tier) fail("quote_changed_request", "the quote changed the requested deployment, amount or tier");
  if (!sameAddr(i.expectedOwner, entry.holder)) fail("holder_mismatch", "the quote's holder differs from the freshly checked holder");
  const call = buildGasFundCall(cfg, { domainVersion: "2", now, sessionId: record.sid, nonce: q.nonce, action: ACTION_GAS_FUND,
    intent: { payer: i.payer, deployment: d, expectedOwner: i.expectedOwner, ethOut: i.ethOut, maxUsdcIn6: i.maxUsdcIn6, fee: Number(i.fee), deadline: i.deadline },
    fee: q.fee, deadline: q.deadline });
  if (call.args !== lower(q.args) || call.argsHash !== lower(q.argsHash)) fail("quote_args_mismatch", "relay args are not the codec encoding of its intent");
  const fee = call.execute.fee;
  const max = call.intent.maxUsdcIn6;
  if (fee > g.maxFeePerOp) fail("fee_exceeds_grant", `fee ${fee} > maxFeePerOp ${g.maxFeePerOp}`);
  if (max > g.maxGasUsdcPerOp) fail("gas_cap", `maxUsdcIn6 ${max} > maxGasUsdcPerOp ${g.maxGasUsdcPerOp}`);
  if (max * 10n ** 18n > g.maxUsdcPerEth6 * eo) fail("price_cap", "the quote's price exceeds maxUsdcPerEth6; the cap is never raised");
  const total = max + fee;
  if (q.maximum && BigInt(q.maximum.totalMaximum6) !== total) fail("quote_total_mismatch", "relay maximum differs from intent + fee");
  if (total > balance6) fail("quote_exceeds_budget", `needs ${total}, the session holds ${balance6}; the budget is not raised and nothing is signed`);
  return Object.freeze({ call, sid: record.sid, deployment: d, holder: entry.holder, env: entry.env,
    totals: Object.freeze({ maxUsdcIn6: max, fee6: fee, totalMaximum6: total, balance6 }), quote: q });
}

export async function confirmGasFund({ runtime, store, record, review, relay, rpc, now, subtle }) {
  const cfg = runtime.cfg;
  const e = review.call.execute;
  if (BigInt(now) > e.deadline) fail("call_deadline_passed", "the quote expired; quote again");
  const signer = signerFor(record.privateKey, BigInt(record.x), BigInt(record.y), subtle);
  if (signer.keyHash !== record.keyHash) fail("key_mismatch", "record key hash mismatch");
  const id = `gas-exec:${record.sid}:${e.nonce}`;
  const base = { id, kind: "gas-execute", sid: record.sid, nonce: e.nonce, argsHash: review.call.argsHash, digest: review.call.digest,
    deployment: review.deployment, maximum: review.totals, at: now };
  const { r, s } = await signer.signDigest(review.call.digest);
  await journal(store, { ...base, status: "submitting" });
  let out;
  try {
    out = await relay("POST", "/funding/execute", { vault: cfg.vault, sid: record.sid, nonce: e.nonce, action: ACTION_GAS_FUND,
      args: e.args, fee: e.fee, deadline: e.deadline, x: signer.x, y: signer.y, r, s });
  } catch (err) {
    await journal(store, { ...base, status: err.code === "relay_unreachable" ? "unknown" : "refused", code: err.code });
    throw err;
  }
  const txHash = lower(out.txHash);
  if (out.pending) { await journal(store, { ...base, status: "pending", txHashes: (out.txHashes ?? [txHash]).map(lower) }); return { pending: true, txHash }; }
  const settlement = await verifySettlement({ runtime, rpc, txHash, call: review.call });
  if (!settlement) { await journal(store, { ...base, status: "pending", txHashes: [txHash] }); return { pending: true, txHash }; }
  if (out.settlement && BigInt(out.settlement.actual?.totalDebit6 ?? -1) !== settlement.actual.totalDebit6) {
    fail("relay_settlement_mismatch", "the relay's settlement differs from the canonical receipt");
  }
  await journal(store, { ...base, status: "settled", txHashes: [txHash], actual: settlement.actual });
  return { pending: false, txHash, settlement };
}

/** Independent of the relay: canonical receipt from the RPC, then the codec's strict log reconciliation. */
export async function verifySettlement({ runtime, rpc, txHash, call }) {
  const rc = await canonicalReceipt(rpc, txHash);
  if (!rc) return null;
  if (!sameAddr(rc.to, runtime.cfg.vault)) fail("settlement_target", "the transaction did not call the configured vault");
  const logs = rc.logs.map((l) => ({ address: lower(l.address), topics: l.topics.map(lower), data: lower(l.data) }));
  return parseGasSettlement(runtime.cfg, { call: { sessionId: call.execute.sessionId, nonce: call.execute.nonce, args: call.args,
    fee: call.execute.fee }, logs, sessionOpAmountSemantics: "actual", ...(runtime.relayer ? { submitter: runtime.relayer } : {}) });
}

// =====================================================================================================================
// Owner controls and the session key's sign-out. Independent of intake, catalog, recovery scope and relay config:
// the domain is derived offline from the parsed pins (or the stored record) exactly as the codec derives it.
// =====================================================================================================================

/** { vault, domain } of the owner's successor vault from parsed pins only (no network). */
export function controlsTarget(pins, owner) {
  const o = parseAddress(owner, "owner");
  const vault = predictVault(pins.factory, pins.implementation, o);
  return Object.freeze({ owner: o, vault,
    domain: Object.freeze({ name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: vault }) });
}

const typedV2 = (domain, primaryType, message) => {
  const td = { domain, types: { [primaryType]: TYPES_V2[primaryType] }, primaryType, message };
  return { typedData: td, digest: hashTypedData(td) };
};

export async function ownerControl({ target, provider, relay, store, op, sessionId, amount, now, rng }) {
  if (op !== "terminate" && op !== "withdraw") fail("owner_op_unsupported", "this page offers terminate and withdraw only");
  const opNonce = randomHex32(rng);
  const signBefore = BigInt(now) + OWNER_OP_WINDOW;
  const message = op === "terminate"
    ? { sessionId: parseHex32(lower(sessionId), "sessionId", { nonZero: true }), opNonce, signBefore }
    : { amount: parseUint(amount, 128, "amount"), opNonce, signBefore };
  if (op === "withdraw" && message.amount === 0n) fail("withdraw_zero", "amount must be positive");
  const built = typedV2(target.domain, op === "terminate" ? "Terminate" : "Withdraw", message);
  const sig = await walletSignTyped(provider, target.owner, built.typedData);   // the click IS the approval for the user's own control
  const base = { id: `gas-owner:${opNonce}`, kind: "gas-owner", op, digest: built.digest, at: now,
    ...(op === "terminate" ? { sessionId: message.sessionId } : { amount: message.amount }) };
  await journal(store, { ...base, status: "submitting" });
  try {
    const out = await relay("POST", "/funding/owner", { owner: target.owner, vault: target.vault, op, args: jsonable(message), sig });
    await journal(store, { ...base, status: out.pending ? "pending" : "submitted", txHashes: out.txHash ? [lower(out.txHash)] : [] });
    return out;
  } catch (e) {
    await journal(store, { ...base, status: e.code === "relay_unreachable" ? "unknown" : "refused", code: e.code });
    throw e;
  }
}

/** The session key's own sign-out from the stored record alone (vault re-derived from its factory/implementation). */
export async function endGasSession({ record, relay, store, now, subtle }) {
  const vault = predictVault(record.factory, record.implementation, record.owner);
  if (!sameAddr(vault, record.vault)) fail("record_vault", "the record's vault is not its factory's CREATE2 vault for its owner");
  const deadline = BigInt(now) + OWNER_OP_WINDOW;
  const built = typedV2(Object.freeze({ name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: vault }),
    "SessionEnd", { sessionId: parseHex32(lower(record.sid), "sid", { nonZero: true }), deadline });
  const signer = signerFor(record.privateKey, BigInt(record.x), BigInt(record.y), subtle);
  const { r, s } = await signer.signDigest(built.digest);
  const base = { id: `gas-end:${record.sid}`, kind: "gas-end", sid: record.sid, digest: built.digest, at: now };
  await journal(store, { ...base, status: "submitting" });
  let out;
  try { out = await relay("POST", "/funding/end", { vault, sid: record.sid, deadline, x: signer.x, y: signer.y, r, s }); }
  catch (e) { await journal(store, { ...base, status: e.code === "relay_unreachable" ? "unknown" : "refused", code: e.code }); throw e; }
  // the record is kept and marked ended only after the chain shows it (reconcile); never deleted
  await journal(store, { ...base, status: out.pending ? "pending" : "submitted", txHashes: out.txHash ? [lower(out.txHash)] : [] });
  return out;
}

/** Read-only: the relay answers from its journal; nothing is resubmitted. */
export const reconcileFundingTx = (relay, txHash) => relay("GET", `/funding/tx/${parseHex32(lower(txHash), "txHash")}`);
