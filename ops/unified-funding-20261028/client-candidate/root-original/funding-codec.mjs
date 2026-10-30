// UNREVIEWED SOURCE (unified-funding client-r1). Pure client codec for the opt-in FundingSessionVault successor:
// EIP-712 domain "Enclave Sessions" / version "2", action 10 gas.fund (9 stays retired). Nothing here touches a
// network, stores or generates key material, signs, or submits. Every identity (chain, factory, implementation, vault,
// owner, adapter, legacy factory/vault) comes from a trusted caller configuration built by fundingConfig() - never
// from a relay quote. The vault contract is the final authority; every "state" check below re-checks numbers the
// CALLER supplied and is reported as chainAuthenticated: false.
//
// The original SDK (sdk/sessions, domain version "1") is untouched and remains the only builder for original vaults.
//
// Import path: relative to this stage directory, because client-r1 has no node_modules of its own. When this file
// moves into a package, replace the path below with the bare specifier "viem" (same named exports).
import {
  decodeAbiParameters, decodeEventLog, encodeAbiParameters, getAddress, hashTypedData, keccak256,
} from "../../source/node_modules/viem/_esm/index.js";

// =====================================================================================================================
// Errors and small utilities
// =====================================================================================================================

/** Every refusal carries a stable machine code; callers branch on `code`, never on message text. */
export class FundingCodecError extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = "FundingCodecError";
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, message, detail) => { throw new FundingCodecError(code, message, detail); };

function deepFreeze(o) {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const utf8 = new TextEncoder();
const hashString = (s) => keccak256(utf8.encode(s));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const max = (bits) => (1n << BigInt(bits)) - 1n;

// =====================================================================================================================
// Constants (frozen)
// =====================================================================================================================

export const DOMAIN_NAME = "Enclave Sessions";
export const DOMAIN_VERSION = "2";
export const BASE_CHAIN_ID = 8453n;
export const SUPPORTED_CHAIN_IDS = Object.freeze([BASE_CHAIN_ID]);
export const ACTION_GAS_FUND = 10;
export const RETIRED_ACTION = 9;                       // was order.pay; never a valid action on either version
export const INTENT_BYTES = 224;                       // abi.encode(DexGasIntent): seven static words, nothing else
export const MAX_DEADLINE_WINDOW = 900n;               // LeaseGasDexAdapter.MAX_DEADLINE_WINDOW (15 minutes)
/** Syntactically valid Uniswap V3 tiers. The adapter source accepts only 100/500/3000; a call is built only for
 *  tiers the trusted config lists in adapterFeeTiers. */
export const UNISWAP_V3_FEE_TIERS = Object.freeze([100, 500, 3000, 10000]);
export const SESSION_LIVE = 1;
export const ENV_STAGING = 1;
export const ENV_PROD = 2;
export const MAX_GRANT_APPS = 8;
export const ZERO_HASH = `0x${"0".repeat(64)}`;
export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export const UINT_MAX = Object.freeze({
  8: max(8), 24: max(24), 32: max(32), 64: max(64), 96: max(96), 128: max(128), 192: max(192), 256: max(256),
});

/** Successor action table (FundingSessionVaultLib.actionBit). No entry maps to 9. */
export const ACTIONS_V2 = Object.freeze({
  "deploy.create": 0, "deploy.fund": 1, "deploy.setAppRef": 2, "deploy.setConfig": 3, "deploy.setShares": 4,
  "deploy.setMaxRate": 5, "deploy.setActive": 6, "deploy.refund": 7, "app.publish": 8,
  "gas.fund": 10,
  "api.status": 128, "api.logs": 129, "api.restart": 130, "api.upload": 131, "api.appAccess": 132,
  "api.placement": 133, "api.account": 134,
});
export const RETIRED_ACTION_NAMES = Object.freeze(["order.pay"]);
export const ENVIRONMENTS = Object.freeze({ staging: ENV_STAGING, prod: ENV_PROD });

/** EIP-712 shapes of FundingSessionVault, byte for byte (funding-codec.test.mjs pins the type strings). */
export const TYPES_V2 = deepFreeze({
  SessionGrant: [
    { name: "label", type: "string" },
    { name: "preset", type: "string" },
    { name: "sessionKey", type: "bytes32" },
    { name: "actions", type: "string[]" },
    { name: "apps", type: "string[]" },
    { name: "environments", type: "string[]" },
    { name: "budget", type: "uint256" },
    { name: "spendPerPeriod", type: "uint256" },
    { name: "periodSeconds", type: "uint32" },
    { name: "opsPerPeriod", type: "uint32" },
    { name: "maxFeePerOp", type: "uint256" },
    { name: "maxAppFeePerHour", type: "uint256" },
    { name: "maxRatePerHour", type: "uint256" },
    { name: "maxGasUsdcPerOp", type: "uint256" },
    { name: "maxUsdcPerEth6", type: "uint256" },
    { name: "maxEthPerOp", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "measurement", type: "bytes32" },
    { name: "grantNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  SessionCall: [
    { name: "sessionId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "action", type: "uint8" },
    { name: "argsHash", type: "bytes32" },
    { name: "fee", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  SessionEnd: [
    { name: "sessionId", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
  TopUp: [
    { name: "sessionId", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Extend: [
    { name: "sessionId", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Terminate: [
    { name: "sessionId", type: "bytes32" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  RevokeAll: [
    { name: "withdraw", type: "bool" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Withdraw: [
    { name: "amount", type: "uint256" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Promote: [
    { name: "deployment", type: "bytes32" },
    { name: "app", type: "string" },
    { name: "publisher", type: "address" },
    { name: "appRef", type: "string" },
    { name: "configCid", type: "string" },
    { name: "versionLabel", type: "string" },
    { name: "isPublic", type: "bool" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Adopt: [
    { name: "deployment", type: "bytes32" },
    { name: "environment", type: "string" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  SetEnvironment: [
    { name: "deployment", type: "bytes32" },
    { name: "environment", type: "string" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
  Release: [
    { name: "deployment", type: "bytes32" },
    { name: "to", type: "address" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" },
  ],
});

/** Owner controls on the successor, all under domain version 2. Originals keep using the SDK's version 1. */
export const OWNER_OPS = Object.freeze({
  topUp: "TopUp", extend: "Extend", terminate: "Terminate", revokeAll: "RevokeAll", withdraw: "Withdraw",
  promote: "Promote", adopt: "Adopt", setEnvironment: "SetEnvironment", release: "Release",
});

export const GAS_LIMIT_FIELDS = Object.freeze(["maxGasUsdcPerOp", "maxUsdcPerEth6", "maxEthPerOp"]);
export const INTENT_FIELDS = Object.freeze(
  ["payer", "deployment", "expectedOwner", "ethOut", "maxUsdcIn6", "fee", "deadline"]);
const INTENT_PARAMS = Object.freeze([
  { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
  { type: "uint24" }, { type: "uint64" },
]);

/** The canonical EIP-712 encodeType string of one primary type (no nested structs exist in this set). */
export function encodeTypeString(primaryType) {
  const fields = TYPES_V2[primaryType];
  if (!fields) fail("unknown_type", `no EIP-712 type ${String(primaryType)}`);
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

// =====================================================================================================================
// Strict scalar parsing
// =====================================================================================================================

/** bigint, safe-integer number, or canonical decimal string -> bigint in [0, 2^bits - 1]. Hex, signs, leading
 *  zeros, whitespace, fractions and unsafe numbers are refused, never coerced. */
export function parseUint(v, bits, name) {
  let n;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) fail("uint_unsafe_number", `${name} must be a safe integer, bigint or decimal string`, { name });
    n = BigInt(v);
  } else if (typeof v === "string") {
    if (v.startsWith("-")) fail("uint_negative", `${name} is negative`, { name });
    if (/^0[xXbBoO]/.test(v)) fail("uint_hex_ambiguous", `${name}: prefixed strings are refused; use decimal or bigint`, { name });
    if (!/^(0|[1-9][0-9]*)$/.test(v)) fail("uint_format", `${name} is not a canonical decimal string`, { name });
    n = BigInt(v);
  } else fail("uint_type", `${name} is missing or not an integer`, { name });
  if (n < 0n) fail("uint_negative", `${name} is negative`, { name });
  if (n > max(bits)) fail("uint_overflow", `${name} exceeds uint${bits}`, { name, bits });
  return n;
}

/** 0x + 40 hex, all-lowercase or exact EIP-55 checksum; returns the checksum form. */
export function parseAddress(v, name, { allowZero = false } = {}) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) fail("address_format", `${name} is not a 20-byte hex address`, { name });
  const c = getAddress(v.toLowerCase());
  const body = v.slice(2);
  if (body !== body.toLowerCase() && v !== c) fail("address_checksum", `${name} has a wrong EIP-55 checksum`, { name });
  if (!allowZero && c === ZERO_ADDRESS) fail("address_zero", `${name} is the zero address`, { name });
  return c;
}

/** 0x + 64 LOWERCASE hex (the one spelling viem, the relay and the chain emit). */
export function parseHex32(v, name, { nonZero = false } = {}) {
  if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/.test(v)) fail("hex32_format", `${name} is not lowercase 0x + 64 hex`, { name });
  if (nonZero && v === ZERO_HASH) fail("hex32_zero", `${name} is zero`, { name });
  return v;
}

export function parseHexBytes(v, name) {
  if (typeof v !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(v)) fail("hex_format", `${name} is not lowercase even-length hex`, { name });
  return v;
}

function parseBool(v, name) {
  if (typeof v !== "boolean") fail("bool_type", `${name} must be a boolean`, { name });
  return v;
}

function parseString(v, name) {
  if (typeof v !== "string") fail("string_type", `${name} must be a string`, { name });
  return v;
}

function plainObject(o, name) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) fail("object_type", `${name} must be an object`, { name });
  const p = Object.getPrototypeOf(o);
  if (p !== Object.prototype && p !== null) fail("object_type", `${name} must be a plain object`, { name });
}

/** Exactly these keys: a quote or caller cannot smuggle a recipient, target or extra fee into any shape. */
function exactKeys(o, required, optional, name) {
  plainObject(o, name);
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length) fail("unknown_field", `${name} has unknown field(s) ${extra.join(", ")}`, { name, extra });
  const missing = required.filter((k) => !has(o, k) || o[k] === undefined);
  if (missing.length) fail("missing_field", `${name} is missing ${missing.join(", ")}`, { name, missing });
}

function parseField(type, v, name) {
  if (type === "bytes32") return parseHex32(v, name);
  if (type === "address") return parseAddress(v, name);
  if (type === "bool") return parseBool(v, name);
  if (type === "string") return parseString(v, name);
  if (type === "string[]") {
    if (!Array.isArray(v)) fail("array_type", `${name} must be an array of strings`, { name });
    return v.map((s, k) => parseString(s, `${name}[${k}]`));
  }
  const m = /^uint(\d+)$/.exec(type);
  if (m) return parseUint(v, Number(m[1]), name);
  return fail("internal", `unhandled type ${type}`);
}

function parseMessage(primaryType, input, name) {
  const fields = TYPES_V2[primaryType];
  exactKeys(input, fields.map((f) => f.name), [], name);
  const out = {};
  for (const f of fields) out[f.name] = parseField(f.type, input[f.name], `${name}.${f.name}`);
  return out;
}

function requireDomainVersion(input, name) {
  plainObject(input, name);
  if (!has(input, "domainVersion")) fail("domain_version_required", `${name} must state domainVersion "2" explicitly`);
  if (input.domainVersion !== DOMAIN_VERSION) {
    fail("domain_version_unsupported", `${name}.domainVersion must be the string "2" (version 1 belongs to the original SDK)`,
      { got: input.domainVersion });
  }
}

// =====================================================================================================================
// Nonces: (lane << 64) | seq
// =====================================================================================================================

/** Split a SessionCall nonce into its uint192 lane and uint64 sequence. A sequence of 2^64-1 is refused: the vault's
 *  `uint64(nonce) + 1` would overflow, so that lane can never advance past it. */
export function splitNonce(v, name = "nonce") {
  const nonce = parseUint(v, 256, name);
  const lane = nonce >> 64n;
  const seq = nonce & UINT_MAX[64];
  if (seq === UINT_MAX[64]) fail("nonce_wrap", `${name}: lane ${lane} is at its last sequence; it cannot advance`, { lane });
  return Object.freeze({ nonce, lane, seq, nextSeq: seq + 1n });
}

export function composeNonce(lane, seq) {
  const l = parseUint(lane, 192, "lane");
  const s = parseUint(seq, 64, "seq");
  if (s === UINT_MAX[64]) fail("nonce_wrap", `lane ${l} is at its last sequence; it cannot advance`, { lane: l });
  return (l << 64n) | s;
}

// =====================================================================================================================
// Trusted configuration
// =====================================================================================================================

const CLONE_PREFIX = "3d602d80600a3d3981f3363d3d373d3d3d363d73";
const CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

/** FundingSessionVaultFactory.vaultFor(owner): CREATE2(factory, salt = owner, EIP-1167 clone of implementation). */
export function predictVault(factory, implementation, owner) {
  const f = parseAddress(factory, "factory").slice(2).toLowerCase();
  const i = parseAddress(implementation, "implementation").slice(2).toLowerCase();
  const o = parseAddress(owner, "owner").slice(2).toLowerCase();
  const codeHash = keccak256(`0x${CLONE_PREFIX}${i}${CLONE_SUFFIX}`).slice(2);
  const h = keccak256(`0xff${f}${o.padStart(64, "0")}${codeHash}`);
  return getAddress(`0x${h.slice(26)}`);
}

const TRUSTED = new WeakSet();

/** The ONLY source of identities for every builder. All fields explicit; nothing defaults from an address book or a
 *  quote. The vault must be the factory's CREATE2 clone for this owner (offline derivation; that the implementation
 *  at that address pins gasAdapter/legacyFactory is a chain fact the caller must verify before trusting this). */
export function fundingConfig(c) {
  exactKeys(c, ["chainId", "factory", "implementation", "vault", "owner", "gasAdapter", "legacyFactory",
    "adapterMaxEthOut", "adapterFeeTiers"], ["legacyVault"], "config");
  const chainId = parseUint(c.chainId, 256, "config.chainId");
  if (!SUPPORTED_CHAIN_IDS.includes(chainId)) fail("chain_unsupported", `chain ${chainId} is not configured (Base 8453 only)`, { chainId });
  const cfg = {
    chainId,
    factory: parseAddress(c.factory, "config.factory"),
    implementation: parseAddress(c.implementation, "config.implementation"),
    vault: parseAddress(c.vault, "config.vault"),
    owner: parseAddress(c.owner, "config.owner"),
    gasAdapter: parseAddress(c.gasAdapter, "config.gasAdapter"),
    legacyFactory: parseAddress(c.legacyFactory, "config.legacyFactory"),
    legacyVault: c.legacyVault === undefined || c.legacyVault === null ? null : parseAddress(c.legacyVault, "config.legacyVault"),
    adapterMaxEthOut: parseUint(c.adapterMaxEthOut, 96, "config.adapterMaxEthOut"),
    adapterFeeTiers: null,
  };
  const ids = ["factory", "implementation", "vault", "owner", "gasAdapter", "legacyFactory", "legacyVault"]
    .filter((k) => cfg[k] !== null).map((k) => cfg[k]);
  if (new Set(ids).size !== ids.length) fail("config_identity_collision", "config identities must be pairwise distinct");
  const expect = predictVault(cfg.factory, cfg.implementation, cfg.owner);
  if (cfg.vault !== expect) fail("vault_mismatch", `config.vault is not factory.vaultFor(owner) (${expect})`, { expect });
  if (cfg.adapterMaxEthOut === 0n) fail("config_adapter_max_zero", "config.adapterMaxEthOut must be positive");
  if (!Array.isArray(c.adapterFeeTiers) || c.adapterFeeTiers.length === 0) fail("config_fee_tiers", "config.adapterFeeTiers must be a non-empty array");
  const tiers = c.adapterFeeTiers.map((t, k) => Number(parseUint(t, 24, `config.adapterFeeTiers[${k}]`)));
  if (tiers.some((t) => !UNISWAP_V3_FEE_TIERS.includes(t)) || new Set(tiers).size !== tiers.length) {
    fail("config_fee_tiers", "config.adapterFeeTiers must be distinct members of 100/500/3000/10000");
  }
  cfg.adapterFeeTiers = tiers;
  deepFreeze(cfg);
  TRUSTED.add(cfg);
  return cfg;
}

function trusted(cfg) {
  if (!TRUSTED.has(cfg)) fail("config_untrusted", "pass the object returned by fundingConfig(), not a copy or a quote");
}

/** Inputs MAY echo chainId / vault; a mismatch is refused, never rewritten to the configured value. */
function checkEcho(cfg, input, name) {
  if (has(input, "chainId") && parseUint(input.chainId, 256, `${name}.chainId`) !== cfg.chainId) {
    fail("chain_mismatch", `${name}.chainId differs from the configured chain ${cfg.chainId}`);
  }
  if (has(input, "vault") && parseAddress(input.vault, `${name}.vault`) !== cfg.vault) {
    fail("vault_mismatch", `${name}.vault differs from the configured vault ${cfg.vault}`);
  }
}

export function domainOf(cfg) {
  trusted(cfg);
  return Object.freeze({ name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: Number(cfg.chainId), verifyingContract: cfg.vault });
}

function typed(cfg, primaryType, message) {
  const td = deepFreeze({ domain: domainOf(cfg), types: { [primaryType]: TYPES_V2[primaryType] }, primaryType, message });
  return { typedData: td, digest: hashTypedData(td) };
}

/** sid = keccak256(abi.encode(vault, sessionKey, grantNonce)). */
export function sessionIdOf(vault, sessionKey, grantNonce) {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [parseAddress(vault, "vault"), parseHex32(sessionKey, "sessionKey"), parseHex32(grantNonce, "grantNonce")]));
}

/** keyHash = keccak256(abi.encode(x, y)) of a P-256 PUBLIC key. */
export function keyHashOf(x, y) {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }],
    [parseUint(x, 256, "x"), parseUint(y, 256, "y")]));
}

// =====================================================================================================================
// SessionGrant (domain version 2)
// =====================================================================================================================

/** Build a version-2 SessionGrant for owner review. input = { domainVersion: "2", now, grant: {20 fields} } (+ optional
 *  chainId/vault echoes). A version-1 grant (no gas limits) is refused, never upgraded; a non-gas grant must carry all
 *  three gas limits as explicit zeros. Returns typed data and digest only - signing is the wallet's job. */
export function buildGrantV2(cfg, input) {
  trusted(cfg);
  requireDomainVersion(input, "grantInput");
  exactKeys(input, ["domainVersion", "now", "grant"], ["chainId", "vault"], "grantInput");
  checkEcho(cfg, input, "grantInput");
  const now = parseUint(input.now, 64, "grantInput.now");
  plainObject(input.grant, "grant");
  const missingGas = GAS_LIMIT_FIELDS.filter((k) => !has(input.grant, k) || input.grant[k] === undefined);
  if (missingGas.length) {
    fail("grant_missing_gas_limits", `grant lacks ${missingGas.join(", ")}: a version-1 grant is never reused as version 2`,
      { missing: missingGas });
  }
  const g = parseMessage("SessionGrant", input.grant, "grant");

  if (g.sessionKey === ZERO_HASH) fail("grant_session_key_zero", "grant.sessionKey is zero");
  if (g.grantNonce === ZERO_HASH) fail("grant_nonce_zero", "grant.grantNonce is zero");
  let actions = 0n;
  const seen = new Set();
  for (const a of g.actions) {
    if (RETIRED_ACTION_NAMES.includes(a)) fail("retired_action", `${a} is retired (action 9)`);
    if (!has(ACTIONS_V2, a)) fail("unknown_action", `unknown action ${a}`);
    if (seen.has(a)) fail("duplicate_action", `duplicate action ${a}`);
    seen.add(a);
    actions |= 1n << BigInt(ACTIONS_V2[a]);
  }
  if (g.apps.length > MAX_GRANT_APPS) fail("grant_too_many_apps", `at most ${MAX_GRANT_APPS} apps`);
  if (g.apps.some((a) => a.length === 0) || new Set(g.apps).size !== g.apps.length) fail("grant_apps", "apps must be distinct non-empty strings");
  let envs = 0;
  for (const e of g.environments) {
    if (!has(ENVIRONMENTS, e)) fail("unknown_environment", `unknown environment ${e}`);
    envs |= ENVIRONMENTS[e];
  }
  if (new Set(g.environments).size !== g.environments.length) fail("duplicate_environment", "duplicate environment");
  if (g.periodSeconds === 0n) fail("grant_period_zero", "periodSeconds must be positive");
  for (const k of ["budget", "spendPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour"]) {
    if (g[k] > UINT_MAX[128]) fail("uint_overflow", `grant.${k} exceeds uint128 (the vault refuses it)`, { name: k, bits: 128 });
  }
  const gas = (actions >> BigInt(ACTION_GAS_FUND)) & 1n;
  if (gas === 1n) {
    for (const k of GAS_LIMIT_FIELDS) if (g[k] === 0n) fail("grant_gas_limit_zero", `gas.fund granted but ${k} is 0`, { name: k });
    if (g.maxGasUsdcPerOp > UINT_MAX[128]) fail("uint_overflow", "grant.maxGasUsdcPerOp exceeds uint128", { bits: 128 });
    if (g.maxUsdcPerEth6 > UINT_MAX[128]) fail("uint_overflow", "grant.maxUsdcPerEth6 exceeds uint128", { bits: 128 });
    if (g.maxEthPerOp > UINT_MAX[96]) fail("uint_overflow", "grant.maxEthPerOp exceeds uint96", { bits: 96 });
  } else if (GAS_LIMIT_FIELDS.some((k) => g[k] !== 0n)) {
    fail("grant_gas_limits_without_action", "gas limits must all be 0 unless gas.fund is granted");
  }
  if (g.expiresAt <= now) fail("grant_expired", "grant.expiresAt must be after now");
  if (g.signBefore < now) fail("grant_sign_window_passed", "grant.signBefore is before now");

  const out = typed(cfg, "SessionGrant", g);
  return deepFreeze({
    ...out,
    sessionId: sessionIdOf(cfg.vault, g.sessionKey, g.grantNonce),
    actionsMask: actions,
    envsMask: envs,
    gasFundGranted: gas === 1n,
    gasLimits: { maxGasUsdcPerOp: g.maxGasUsdcPerOp, maxUsdcPerEth6: g.maxUsdcPerEth6, maxEthPerOp: g.maxEthPerOp },
  });
}

export function grantDigestV2(cfg, input) { return buildGrantV2(cfg, input).digest; }

// =====================================================================================================================
// Owner controls and SessionEnd (domain version 2)
// =====================================================================================================================

/** input = { domainVersion: "2", now, op: keyof OWNER_OPS, message: {...fields incl. opNonce, signBefore} }. */
export function buildOwnerOpV2(cfg, input) {
  trusted(cfg);
  requireDomainVersion(input, "ownerOp");
  exactKeys(input, ["domainVersion", "now", "op", "message"], ["chainId", "vault"], "ownerOp");
  checkEcho(cfg, input, "ownerOp");
  const now = parseUint(input.now, 64, "ownerOp.now");
  if (typeof input.op !== "string" || !has(OWNER_OPS, input.op)) fail("unknown_owner_op", `unknown owner op ${String(input.op)}`);
  const primaryType = OWNER_OPS[input.op];
  const m = parseMessage(primaryType, input.message, primaryType);
  if (m.opNonce === ZERO_HASH) fail("op_nonce_zero", "opNonce is zero");
  if (m.signBefore < now) fail("owner_sign_window_passed", "signBefore is before now");
  if (has(m, "sessionId") && m.sessionId === ZERO_HASH) fail("hex32_zero", "sessionId is zero");
  if (has(m, "deployment") && m.deployment === ZERO_HASH) fail("hex32_zero", "deployment is zero");
  if (primaryType === "Extend" && m.expiresAt <= now) fail("extend_in_past", "expiresAt must be after now");
  if ((primaryType === "Adopt" || primaryType === "SetEnvironment") && !has(ENVIRONMENTS, m.environment)) {
    fail("unknown_environment", `unknown environment ${m.environment}`);
  }
  // the vault also accepts the book's CURRENT factory vault, which only a chain read can name: refused offline
  if (primaryType === "Release" && m.to !== cfg.owner) fail("release_target_unverified", "offline release goes to the configured owner only");
  return deepFreeze({ ...typed(cfg, primaryType, m), op: input.op });
}

/** The session key's sign-out on the successor. input = { domainVersion: "2", now, sessionId, deadline }. */
export function buildSessionEndV2(cfg, input) {
  trusted(cfg);
  requireDomainVersion(input, "sessionEnd");
  exactKeys(input, ["domainVersion", "now", "sessionId", "deadline"], ["chainId", "vault"], "sessionEnd");
  checkEcho(cfg, input, "sessionEnd");
  const now = parseUint(input.now, 64, "sessionEnd.now");
  const m = { sessionId: parseHex32(input.sessionId, "sessionEnd.sessionId", { nonZero: true }),
    deadline: parseUint(input.deadline, 64, "sessionEnd.deadline") };
  if (m.deadline < now) fail("call_deadline_passed", "deadline is before now");
  return deepFreeze(typed(cfg, "SessionEnd", m));
}

// =====================================================================================================================
// DexGasIntent: exactly 224 bytes
// =====================================================================================================================

function parseIntent(i, name) {
  exactKeys(i, INTENT_FIELDS, [], name);
  const fee = Number(parseUint(i.fee, 24, `${name}.fee`));
  if (!UNISWAP_V3_FEE_TIERS.includes(fee)) fail("fee_tier", `${name}.fee ${fee} is not a Uniswap V3 tier`);
  const out = {
    payer: parseAddress(i.payer, `${name}.payer`),
    deployment: parseHex32(i.deployment, `${name}.deployment`, { nonZero: true }),
    expectedOwner: parseAddress(i.expectedOwner, `${name}.expectedOwner`),
    ethOut: parseUint(i.ethOut, 256, `${name}.ethOut`),
    maxUsdcIn6: parseUint(i.maxUsdcIn6, 256, `${name}.maxUsdcIn6`),
    fee,
    deadline: parseUint(i.deadline, 64, `${name}.deadline`),
  };
  if (out.ethOut === 0n) fail("eth_out_zero", "ethOut (exact output) must be positive");
  if (out.maxUsdcIn6 === 0n) fail("max_usdc_zero", "maxUsdcIn6 must be positive");
  return deepFreeze(out);
}

export function encodeDexGasIntent(intent) {
  const i = parseIntent(intent, "intent");
  return encodeAbiParameters(INTENT_PARAMS,
    [i.payer, i.deployment, i.expectedOwner, i.ethOut, i.maxUsdcIn6, BigInt(i.fee), i.deadline]);
}

/** Strict decode: exactly 224 bytes, every word canonical (dirty high bits refused via re-encoding), values valid. */
export function decodeDexGasIntent(data) {
  const hex = parseHexBytes(data, "intent data");
  const bytes = (hex.length - 2) / 2;
  if (bytes !== INTENT_BYTES) fail("intent_length", `intent is ${bytes} bytes, must be exactly ${INTENT_BYTES}`, { bytes });
  const [payer, deployment, expectedOwner, ethOut, maxUsdcIn6, fee, deadline] = decodeAbiParameters(INTENT_PARAMS, hex);
  const i = parseIntent({ payer, deployment, expectedOwner, ethOut, maxUsdcIn6, fee: Number(fee), deadline: BigInt(deadline) },
    "intent");
  if (encodeDexGasIntent(i) !== hex) fail("intent_noncanonical", "intent words carry non-canonical (dirty) bits");
  return i;
}

// =====================================================================================================================
// SessionCall for gas.fund
// =====================================================================================================================

const CALL_KEYS = ["domainVersion", "now", "sessionId", "nonce", "action", "intent", "fee", "deadline"];

function checkDeadlines(now, callDeadline, intentDeadline) {
  if (callDeadline < now) fail("call_deadline_passed", "call deadline is before now");
  if (intentDeadline < now) fail("intent_deadline_passed", "intent deadline is before now");
  if (intentDeadline > now + MAX_DEADLINE_WINDOW) fail("intent_deadline_too_far", `intent deadline is more than ${MAX_DEADLINE_WINDOW}s ahead`);
  if (callDeadline > intentDeadline) fail("call_outlives_intent", "call deadline is after the intent deadline");
}

/** Build the gas.fund SessionCall digest + args. input = { domainVersion: "2", now, sessionId, nonce, action: 10,
 *  intent: DexGasIntent, fee, deadline }. The fee is the ONLY relayer payment and is paid by the vault to the
 *  submitting msg.sender; there is no recipient, target or calldata field to fill. */
export function buildGasFundCall(cfg, input) {
  trusted(cfg);
  requireDomainVersion(input, "call");
  exactKeys(input, CALL_KEYS, ["chainId", "vault"], "call");
  checkEcho(cfg, input, "call");
  const now = parseUint(input.now, 64, "call.now");
  const action = Number(parseUint(input.action, 8, "call.action"));
  if (action === RETIRED_ACTION) fail("retired_action", "action 9 is retired");
  if (action !== ACTION_GAS_FUND) fail("action_not_gas", `this codec builds action 10 only (got ${action})`);
  const sessionId = parseHex32(input.sessionId, "call.sessionId", { nonZero: true });
  const n = splitNonce(input.nonce, "call.nonce");
  const fee = parseUint(input.fee, 256, "call.fee");
  if (fee > UINT_MAX[128]) fail("uint_overflow", "call.fee exceeds any uint128 maxFeePerOp", { bits: 128 });
  const deadline = parseUint(input.deadline, 64, "call.deadline");
  const intent = parseIntent(input.intent, "intent");
  if (intent.payer !== cfg.vault) fail("payer_not_vault", "intent.payer must be exactly the configured vault");
  const holders = [cfg.vault, cfg.owner, cfg.legacyVault].filter(Boolean);
  if (!holders.includes(intent.expectedOwner)) fail("holder_not_allowed", "intent.expectedOwner is not the vault, owner or configured legacy vault");
  if (!cfg.adapterFeeTiers.includes(intent.fee)) fail("fee_tier_not_configured", `pool tier ${intent.fee} is not in config.adapterFeeTiers`);
  if (intent.ethOut > cfg.adapterMaxEthOut) fail("adapter_eth_cap", "ethOut exceeds the adapter's maxEthOut");
  if (intent.maxUsdcIn6 > UINT_MAX[128]) fail("uint_overflow", "maxUsdcIn6 exceeds any uint128 session limit", { bits: 128 });
  checkDeadlines(now, deadline, intent.deadline);

  const args = encodeDexGasIntent(intent);
  const argsHash = keccak256(args);
  const message = { sessionId, nonce: n.nonce, action: BigInt(ACTION_GAS_FUND), argsHash, fee, deadline };
  return deepFreeze({
    ...typed(cfg, "SessionCall", message),
    args, argsHash, intent,
    nonce: { value: n.nonce, lane: n.lane, seq: n.seq, nextSeq: n.nextSeq },
    // what vault.execute takes besides the P-256 (x, y, r, s) the session signer adds
    execute: { sessionId, nonce: n.nonce, action: ACTION_GAS_FUND, args, fee, deadline },
    maximum: { maxUsdcIn6: intent.maxUsdcIn6, fee6: fee, totalMaximum6: intent.maxUsdcIn6 + fee },
  });
}

// =====================================================================================================================
// Policy preflight over CALLER-SUPPLIED state
// =====================================================================================================================

const SESSION_FIELDS = {
  state: 8, epoch: 64, expiresAt: 64, actions: 256, maxFee6: 128, balance6: 128, perPeriod6: 128, periodSpent6: 128,
  periodStart: 64, period: 32, opsPerPeriod: 32, periodOps: 32, envs: 8,
};

function parseSuppliedState(st) {
  exactKeys(st, ["session", "vaultEpoch", "laneSeq", "gasPolicy", "sessionPublicKey", "attestation", "record"],
    ["source"], "suppliedState");
  const ss = st.session;
  exactKeys(ss, [...Object.keys(SESSION_FIELDS), "keyHash", "measurement", "anyApp", "apps"], [], "suppliedState.session");
  const session = {};
  for (const [k, bits] of Object.entries(SESSION_FIELDS)) session[k] = parseUint(ss[k], bits, `session.${k}`);
  session.keyHash = parseHex32(ss.keyHash, "session.keyHash");
  session.measurement = parseHex32(ss.measurement, "session.measurement");
  session.anyApp = parseBool(ss.anyApp, "session.anyApp");
  if (!Array.isArray(ss.apps)) fail("array_type", "session.apps must be an array");
  session.apps = ss.apps.map((a, k) => parseHex32(a, `session.apps[${k}]`));
  exactKeys(st.gasPolicy, ["maxGasUsdc6", "maxUsdcPerEth6", "maxEthWei"], [], "suppliedState.gasPolicy");
  const gasPolicy = {
    maxGasUsdc6: parseUint(st.gasPolicy.maxGasUsdc6, 128, "gasPolicy.maxGasUsdc6"),
    maxUsdcPerEth6: parseUint(st.gasPolicy.maxUsdcPerEth6, 128, "gasPolicy.maxUsdcPerEth6"),
    maxEthWei: parseUint(st.gasPolicy.maxEthWei, 96, "gasPolicy.maxEthWei"),
  };
  exactKeys(st.sessionPublicKey, ["x", "y"], [], "suppliedState.sessionPublicKey");
  let attestation = null;
  if (st.attestation !== null) {
    exactKeys(st.attestation, ["measurement", "revoked"], [], "suppliedState.attestation");
    attestation = { measurement: parseHex32(st.attestation.measurement, "attestation.measurement"),
      revoked: parseBool(st.attestation.revoked, "attestation.revoked") };
  }
  exactKeys(st.record, ["holder", "heldEnv", "appId"], [], "suppliedState.record");
  return {
    session, gasPolicy, attestation,
    vaultEpoch: parseUint(st.vaultEpoch, 64, "vaultEpoch"),
    laneSeq: parseUint(st.laneSeq, 64, "laneSeq"),
    keyHash: keyHashOf(st.sessionPublicKey.x, st.sessionPublicKey.y),
    record: {
      holder: parseAddress(st.record.holder, "record.holder"),
      heldEnv: Number(parseUint(st.record.heldEnv, 8, "record.heldEnv")),
      appId: parseHex32(st.record.appId, "record.appId"),
    },
    source: st.source === undefined ? null : parseString(st.source, "suppliedState.source"),
  };
}

/** Re-check, with exact integer arithmetic, everything execute + FundingGasLib would check for this call against the
 *  state the caller read. Reserves maxUsdcIn6 + fee (the worst case); equality at every bound passes. Throws a coded
 *  FundingCodecError on the first refusal. Not chain-authenticated: the contract decides. */
export function preflightGasFund(cfg, input) {
  trusted(cfg);
  plainObject(input, "preflight");
  const { suppliedState, ...callInput } = input;
  if (suppliedState === undefined) fail("missing_field", "preflight is missing suppliedState");
  const call = buildGasFundCall(cfg, callInput);
  const now = parseUint(callInput.now, 64, "call.now");
  const st = parseSuppliedState(suppliedState);
  const s = st.session;
  const i = call.intent;
  const fee = call.execute.fee;

  // execute: live (state, epoch, expiry), nonce lane, key, action bit, fee cap, attestation
  if (s.state !== BigInt(SESSION_LIVE)) fail("session_ended", "session is not live");
  if (s.epoch !== st.vaultEpoch) fail("session_revoked", "session epoch is stale (revokeAll)");
  if (now > s.expiresAt) fail("session_expired", "session has expired");
  if (st.laneSeq === UINT_MAX[64]) fail("nonce_lane_exhausted", "this lane can never advance");
  if (call.nonce.seq !== st.laneSeq) fail("nonce_mismatch", `lane ${call.nonce.lane} expects seq ${st.laneSeq}`, { expected: st.laneSeq });
  if (st.keyHash !== s.keyHash) fail("key_mismatch", "the supplied public key is not this session's key");
  if (((s.actions >> BigInt(ACTION_GAS_FUND)) & 1n) === 0n) fail("action_not_granted", "gas.fund is not granted to this session");
  if (fee > s.maxFee6) fail("fee_too_high", `fee ${fee} exceeds maxFeePerOp ${s.maxFee6}`);
  if (s.measurement !== ZERO_HASH) {
    if (st.attestation === null) fail("attestation_unknown", "a measurement-bound session needs the key's attestation");
    if (st.attestation.measurement !== s.measurement || st.attestation.revoked) fail("attestation_invalid", "key attestation does not match");
  }

  // _spend(maxUsdcIn6 + fee): period reset first, then op count, then total and period budgets
  const need = i.maxUsdcIn6 + fee;
  const reset = now >= s.periodStart + s.period;
  const periodSpent = reset ? 0n : s.periodSpent6;
  const periodOps = reset ? 0n : s.periodOps;
  if (s.opsPerPeriod !== 0n && periodOps >= s.opsPerPeriod) {
    fail("op_limit", `${periodOps} of ${s.opsPerPeriod} ops used this period`, { periodReset: reset });
  }
  if (need > s.balance6) fail("budget_exceeded", `needs ${need}, session holds ${s.balance6}`, { need, have: s.balance6 });
  const left = s.perPeriod6 > periodSpent ? s.perPeriod6 - periodSpent : 0n;
  if (need > left) fail("period_limit", `needs ${need}, ${left} left this period`, { need, left, periodReset: reset });

  // FundingGasLib._checkLimits on the reserved maximum
  const p = st.gasPolicy;
  if (p.maxGasUsdc6 === 0n || p.maxUsdcPerEth6 === 0n || p.maxEthWei === 0n) fail("gas_policy_absent", "session has no gas.fund policy");
  if (i.maxUsdcIn6 > p.maxGasUsdc6) fail("gas_cap", `maxUsdcIn6 ${i.maxUsdcIn6} exceeds ${p.maxGasUsdc6}`);
  if (i.ethOut > p.maxEthWei) fail("eth_cap", `ethOut ${i.ethOut} exceeds ${p.maxEthWei}`);
  if (i.maxUsdcIn6 * 10n ** 18n > p.maxUsdcPerEth6 * i.ethOut) {
    fail("price_cap", "maxUsdcIn6 * 1e18 exceeds maxUsdcPerEth6 * ethOut", { maxUsdcIn6: i.maxUsdcIn6, ethOut: i.ethOut });
  }

  // FundingGasLib._checkScope, on the supplied record (fee/app genuineness of a wallet record is contract-only)
  const r = st.record;
  if (r.holder !== i.expectedOwner) fail("owner_mismatch", "record holder differs from intent.expectedOwner");
  let holderKind;
  let env;
  if (r.holder === cfg.vault) { holderKind = "vault"; env = r.heldEnv; }
  else if (r.holder === cfg.owner) { holderKind = "wallet"; env = ENV_PROD; }   // wallet-held records are production
  else if (cfg.legacyVault !== null && r.holder === cfg.legacyVault) { holderKind = "legacyVault"; env = r.heldEnv; }
  else fail("holder_not_allowed", "record holder is not the vault, owner or configured legacy vault");
  if (env !== ENV_STAGING && env !== ENV_PROD) fail("not_held", "record is not adopted (held env 0 or unknown)");
  if ((Number(s.envs) & env) === 0) fail("env_not_allowed", `environment ${env} is not granted`);
  if (!s.anyApp && !s.apps.includes(r.appId)) fail("app_not_allowed", "record's app is not listed in the grant");

  return deepFreeze({
    ok: true,
    chainAuthenticated: false,
    authority: "contract",
    source: st.source,
    call,
    reservation: { maxUsdcIn6: i.maxUsdcIn6, fee6: fee, totalMaximum6: need },
    session: { balanceBefore6: s.balance6, balanceAfterReservation6: s.balance6 - need },
    period: {
      reset, perPeriod6: s.perPeriod6, spentBefore6: periodSpent, spentAfterReservation6: periodSpent + need,
      opsBefore: periodOps, opsAfter: periodOps + 1n, opsPerPeriod: s.opsPerPeriod,
    },
    nonce: call.nonce,
    scope: { holder: r.holder, holderKind, env, walletPaidAppCheck: holderKind === "wallet" ? "contract-only" : "n/a" },
  });
}

// =====================================================================================================================
// Settlement: signed maximum vs. actual debit
// =====================================================================================================================

export const GAS_FUNDED_EVENT = deepFreeze({
  type: "event", name: "GasFunded", inputs: [
    { name: "sid", type: "bytes32", indexed: true }, { name: "deployment", type: "bytes32", indexed: true },
    { name: "holder", type: "address", indexed: true }, { name: "ethOut", type: "uint256", indexed: false },
    { name: "usdcSpent6", type: "uint256", indexed: false }, { name: "maxUsdcIn6", type: "uint256", indexed: false },
    { name: "relayer", type: "address", indexed: false }, { name: "fee6", type: "uint256", indexed: false },
  ],
});
export const SESSION_OP_EVENT = deepFreeze({
  type: "event", name: "SessionOp", inputs: [
    { name: "sid", type: "bytes32", indexed: true }, { name: "nonce", type: "uint256", indexed: false },
    { name: "action", type: "uint8", indexed: true }, { name: "argsHash", type: "bytes32", indexed: false },
    { name: "amount6", type: "uint256", indexed: false }, { name: "fee6", type: "uint256", indexed: false },
    { name: "result", type: "bytes", indexed: false },
  ],
});
const SETTLEMENT_ABI = Object.freeze([GAS_FUNDED_EVENT, SESSION_OP_EVENT]);
const GAS_FUNDED_DATA = Object.freeze(GAS_FUNDED_EVENT.inputs.filter((p) => !p.indexed).map((p) => ({ type: p.type })));
const SESSION_OP_DATA = Object.freeze(SESSION_OP_EVENT.inputs.filter((p) => !p.indexed).map((p) => ({ type: p.type })));
export const GAS_FUNDED_TOPIC = hashString("GasFunded(bytes32,bytes32,address,uint256,uint256,uint256,address,uint256)");
export const SESSION_OP_TOPIC = hashString("SessionOp(bytes32,uint256,uint8,bytes32,uint256,uint256,bytes)");

const topicWord = (hexBody) => `0x${hexBody.toLowerCase().padStart(64, "0")}`;

/** viem decodes leniently (trailing data, dirty address/small-int bits): re-encode and require byte equality. */
function canonicalLog(ev, topics, data, k) {
  const a = ev.args;
  let enc;
  let indexedOk;
  if (ev.eventName === "GasFunded") {
    enc = encodeAbiParameters(GAS_FUNDED_DATA, [a.ethOut, a.usdcSpent6, a.maxUsdcIn6, a.relayer, a.fee6]);
    indexedOk = topics[3] === topicWord(a.holder.slice(2));
  } else {
    enc = encodeAbiParameters(SESSION_OP_DATA, [a.nonce, a.argsHash, a.amount6, a.fee6, a.result]);
    indexedOk = topics[2] === topicWord(BigInt(a.action).toString(16));
  }
  if (enc !== data || !indexedOk) fail("log_noncanonical", `logs[${k}] is not the canonical encoding of ${ev.eventName}`);
}

/** Reconcile one gas.fund execution from caller-supplied receipt logs. input = { call: { sessionId, nonce, args, fee },
 *  logs, sessionOpAmountSemantics: "actual" (root's anticipated fix: SessionOp.amount6 = adapter debit) | "maximum"
 *  (current session-r1 source: SessionOp.amount6 = reserved maximum), submitter?, balances? }. Returns the signed
 *  maximum and the actual settlement SEPARATELY; the fee is counted once. Receipt inclusion is not verified here. */
export function parseGasSettlement(cfg, input) {
  trusted(cfg);
  exactKeys(input, ["call", "logs", "sessionOpAmountSemantics"], ["submitter", "balances"], "settlement");
  const sem = input.sessionOpAmountSemantics;
  if (sem !== "actual" && sem !== "maximum") fail("amount_semantics_required", 'sessionOpAmountSemantics must be "actual" or "maximum"');
  exactKeys(input.call, ["sessionId", "nonce", "args", "fee"], [], "settlement.call");
  const sid = parseHex32(input.call.sessionId, "call.sessionId", { nonZero: true });
  const nonce = parseUint(input.call.nonce, 256, "call.nonce");
  const args = parseHexBytes(input.call.args, "call.args");
  const intent = decodeDexGasIntent(args);
  const fee = parseUint(input.call.fee, 256, "call.fee");
  if (!Array.isArray(input.logs)) fail("logs_type", "logs must be an array");

  const ops = [];
  const funded = [];
  input.logs.forEach((log, k) => {
    if (log === null || typeof log !== "object") fail("log_format", `logs[${k}] is not an object`);
    if (parseAddress(log.address, `logs[${k}].address`, { allowZero: true }) !== cfg.vault) return;
    if (!Array.isArray(log.topics) || log.topics.length === 0) return;
    const topics = log.topics.map((t, j) => parseHex32(t, `logs[${k}].topics[${j}]`));
    if (topics[0] !== GAS_FUNDED_TOPIC && topics[0] !== SESSION_OP_TOPIC) return;
    const data = parseHexBytes(log.data, `logs[${k}].data`);
    let ev;
    try { ev = decodeEventLog({ abi: SETTLEMENT_ABI, topics, data, strict: true }); }
    catch (e) { fail("log_decode", `logs[${k}] does not decode: ${e.shortMessage ?? e.message}`); }
    canonicalLog(ev, topics, data, k);
    if (ev.args.sid !== sid) return;
    if (ev.eventName === "GasFunded") funded.push(ev.args);
    else if (ev.args.nonce === nonce) ops.push(ev.args);
  });
  if (ops.length !== 1) fail("session_op_count", `expected one SessionOp for this sid/nonce, found ${ops.length}`);
  if (funded.length !== 1) fail("gas_funded_count", `expected one GasFunded for this sid, found ${funded.length}`);
  const op = ops[0];
  const gf = funded[0];

  if (Number(op.action) !== ACTION_GAS_FUND) fail("settlement_action", "SessionOp is not action 10");
  if (op.argsHash !== keccak256(args)) fail("settlement_args", "SessionOp.argsHash differs from the signed args");
  if (op.fee6 !== fee || gf.fee6 !== fee) fail("fee_mismatch", "signed fee, SessionOp.fee6 and GasFunded.fee6 must be equal");
  if (gf.deployment !== intent.deployment || gf.holder !== intent.expectedOwner) fail("settlement_scope", "GasFunded deployment/holder differ from the intent");
  if (gf.ethOut !== intent.ethOut) fail("settlement_eth", "GasFunded.ethOut differs from the exact signed output");
  if (gf.maxUsdcIn6 !== intent.maxUsdcIn6) fail("settlement_max", "GasFunded.maxUsdcIn6 differs from the signed maximum");
  const used = gf.usdcSpent6;
  if (used === 0n) fail("actual_zero", "the adapter reported zero USDC spent");
  if (used > intent.maxUsdcIn6) fail("actual_exceeds_max", `actual ${used} exceeds signed maximum ${intent.maxUsdcIn6}`);
  if (typeof op.result !== "string" || op.result.length !== 2 + 128) fail("settlement_result", "SessionOp.result must be abi.encode(used, refund)");
  const [resUsed, refund] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], op.result);
  if (resUsed !== used) fail("settlement_result", "SessionOp.result used differs from GasFunded.usdcSpent6");
  if (used + refund !== intent.maxUsdcIn6) fail("refund_mismatch", "actual + refund must equal the signed maximum");
  const expectAmount = sem === "actual" ? used : intent.maxUsdcIn6;
  if (op.amount6 !== expectAmount) {
    fail("amount_semantics_mismatch", `SessionOp.amount6 ${op.amount6} does not match "${sem}" semantics (${expectAmount})`);
  }
  let relayerMatchesSubmitter = null;
  if (has(input, "submitter")) {
    if (gf.relayer !== parseAddress(input.submitter, "submitter")) fail("relayer_mismatch", "GasFunded.relayer is not the submitter");
    relayerMatchesSubmitter = true;
  }
  const totalDebit6 = used + fee;
  if (has(input, "balances")) {
    const b = input.balances;
    exactKeys(b, ["balance6Before", "balance6After"], [], "settlement.balances");
    const before = parseUint(b.balance6Before, 128, "balance6Before");
    const after = parseUint(b.balance6After, 128, "balance6After");
    if (after > before || before - after !== totalDebit6) fail("session_balance_mismatch", "session balance change is not actual + fee");
  }
  return deepFreeze({
    chainAuthenticated: false,
    sessionId: sid,
    nonce,
    deployment: intent.deployment,
    holder: gf.holder,
    ethOut: gf.ethOut,
    relayer: gf.relayer,
    relayerMatchesSubmitter,
    maximum: { maxUsdcIn6: intent.maxUsdcIn6, fee6: fee, totalMaximum6: intent.maxUsdcIn6 + fee },
    actual: { usdcSpent6: used, fee6: fee, totalDebit6 },
    refund6: refund,
    sessionOpAmount6: op.amount6,
    sessionOpAmountSemantics: sem,
  });
}
