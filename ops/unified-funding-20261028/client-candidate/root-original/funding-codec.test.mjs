// node --test funding-codec.test.mjs   (from client-r1/; no build step, no network)
// Every digest and calldata expectation below is built by hand from EIP-712 type strings and 32-byte ABI words
// copied from session-r1/src/FundingSessionVault.sol, then compared to what the codec (viem) produces. Only
// keccak256 and EIP-55 checksumming are borrowed from viem. All fixtures are deterministic public numbers: the
// "session key" is the public point (1, 2), not a key anyone holds.
import test from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256 } from "../../source/node_modules/viem/_esm/index.js";
import * as C from "./funding-codec.mjs";

// ---------------------------------------------------------------------------------------------------------------------
// independent encoders
// ---------------------------------------------------------------------------------------------------------------------

const te = new TextEncoder();
const kh = (s) => keccak256(te.encode(s));
const w = (n) => {
  const v = BigInt(n);
  assert.ok(v >= 0n && v < 1n << 256n);
  return v.toString(16).padStart(64, "0");
};
const wa = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const wh = (h) => { assert.equal(h.length, 66); return h.slice(2); };
const wb = (b) => (b ? w(1) : w(0));
const k = (...words) => keccak256(`0x${words.join("")}`);
const hashStrings = (a) => k(...a.map((s) => wh(kh(s))));

const DOMAIN_T = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const SOL = {
  SessionGrant: "SessionGrant(string label,string preset,bytes32 sessionKey,string[] actions,string[] apps,"
    + "string[] environments,uint256 budget,uint256 spendPerPeriod,uint32 periodSeconds,uint32 opsPerPeriod,"
    + "uint256 maxFeePerOp,uint256 maxAppFeePerHour,uint256 maxRatePerHour,uint256 maxGasUsdcPerOp,"
    + "uint256 maxUsdcPerEth6,uint256 maxEthPerOp,uint64 expiresAt,bytes32 measurement,"
    + "bytes32 grantNonce,uint64 signBefore)",
  SessionCall: "SessionCall(bytes32 sessionId,uint256 nonce,uint8 action,bytes32 argsHash,uint256 fee,uint64 deadline)",
  SessionEnd: "SessionEnd(bytes32 sessionId,uint64 deadline)",
  TopUp: "TopUp(bytes32 sessionId,uint256 amount,bytes32 opNonce,uint64 signBefore)",
  Extend: "Extend(bytes32 sessionId,uint64 expiresAt,bytes32 opNonce,uint64 signBefore)",
  Terminate: "Terminate(bytes32 sessionId,bytes32 opNonce,uint64 signBefore)",
  RevokeAll: "RevokeAll(bool withdraw,bytes32 opNonce,uint64 signBefore)",
  Withdraw: "Withdraw(uint256 amount,bytes32 opNonce,uint64 signBefore)",
  Promote: "Promote(bytes32 deployment,string app,address publisher,string appRef,string configCid,string versionLabel,"
    + "bool isPublic,bytes32 opNonce,uint64 signBefore)",
  Adopt: "Adopt(bytes32 deployment,string environment,bytes32 opNonce,uint64 signBefore)",
  SetEnvironment: "SetEnvironment(bytes32 deployment,string environment,bytes32 opNonce,uint64 signBefore)",
  Release: "Release(bytes32 deployment,address to,bytes32 opNonce,uint64 signBefore)",
};
// the ORIGINAL SessionVault grant (sdk/sessions/src/typed.ts, domain version "1")
const V1_GRANT_T = SOL.SessionGrant.replace("uint256 maxGasUsdcPerOp,uint256 maxUsdcPerEth6,uint256 maxEthPerOp,", "");

const manualDomain = (chainId, vault, version = "2") =>
  k(wh(kh(DOMAIN_T)), wh(kh("Enclave Sessions")), wh(kh(version)), w(chainId), wa(vault));
const manualDigest = (ds, sh) => keccak256(`0x1901${wh(ds)}${wh(sh)}`);

function manualGrantStruct(g, { v1 = false } = {}) {
  return k(
    wh(kh(v1 ? V1_GRANT_T : SOL.SessionGrant)), wh(kh(g.label)), wh(kh(g.preset)), wh(g.sessionKey),
    wh(hashStrings(g.actions)), wh(hashStrings(g.apps)), wh(hashStrings(g.environments)),
    w(g.budget), w(g.spendPerPeriod), w(g.periodSeconds), w(g.opsPerPeriod), w(g.maxFeePerOp),
    w(g.maxAppFeePerHour), w(g.maxRatePerHour),
    ...(v1 ? [] : [w(g.maxGasUsdcPerOp), w(g.maxUsdcPerEth6), w(g.maxEthPerOp)]),
    w(g.expiresAt), wh(g.measurement), wh(g.grantNonce), w(g.signBefore));
}

const manualIntent = (i) =>
  `0x${wa(i.payer)}${wh(i.deployment)}${wa(i.expectedOwner)}${w(i.ethOut)}${w(i.maxUsdcIn6)}${w(i.fee)}${w(i.deadline)}`;

const manualCallStruct = (c, argsHash) =>
  k(wh(kh(SOL.SessionCall)), wh(c.sessionId), w(c.nonce), w(10), wh(argsHash), w(c.fee), w(c.deadline));

const manualVault = (f, i, o) => {
  const code = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${i.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  return `0x${k(`ff${f.slice(2).toLowerCase()}`, wa(o), wh(keccak256(code))).slice(26)}`;
};

const err = (code) => (e) => {
  assert.ok(e instanceof C.FundingCodecError, `expected FundingCodecError(${code}), got ${e}`);
  assert.equal(e.code, code, e.message);
  return true;
};

// ---------------------------------------------------------------------------------------------------------------------
// deterministic public fixtures (no deployed addresses)
// ---------------------------------------------------------------------------------------------------------------------

const A = (b) => `0x${b.repeat(20)}`;
const FACTORY = A("f1");
const IMPL = A("e1");
const OWNER = A("a1");
const OTHER_OWNER = A("a2");
const ADAPTER = A("ad");
const LEGACY_FACTORY = A("1f");
const LEGACY_VAULT = A("1e");
const RELAYER = A("be");
const FOREIGN = A("cc");
const ZERO = C.ZERO_HASH;
const APP_ID = `0x${"ab".repeat(32)}`;
const OTHER_APP = `0x${"ac".repeat(32)}`;
const DEPLOYMENT = `0x${"d1".repeat(32)}`;
const GRANT_NONCE = `0x${"00".repeat(31)}07`;
const OP_NONCE = `0x${"00".repeat(31)}42`;
const KEYHASH = k(w(1), w(2));
const NOW = 1_800_000_000n;
const NONCE = (5n << 64n) | 3n;

const VAULT = C.predictVault(FACTORY, IMPL, OWNER);
const SID = k(wa(VAULT), wh(KEYHASH), wh(GRANT_NONCE));

const cfgInput = (o = {}) => ({
  chainId: 8453, factory: FACTORY, implementation: IMPL, vault: VAULT, owner: OWNER, gasAdapter: ADAPTER,
  legacyFactory: LEGACY_FACTORY, legacyVault: LEGACY_VAULT, adapterMaxEthOut: 10n ** 17n, adapterFeeTiers: [100, 500, 3000],
  ...o,
});
const CFG = C.fundingConfig(cfgInput());

const grantFields = (o = {}) => ({
  label: "gas agent", preset: "gas", sessionKey: KEYHASH, actions: ["gas.fund", "api.status"], apps: [APP_ID],
  environments: ["prod"], budget: 20_000_000n, spendPerPeriod: 10_000_000n, periodSeconds: 86400, opsPerPeriod: 5,
  maxFeePerOp: 50_000n, maxAppFeePerHour: 0n, maxRatePerHour: 0n, maxGasUsdcPerOp: 5_000_000n,
  maxUsdcPerEth6: 3_000_000_000n, maxEthPerOp: 10n ** 16n, expiresAt: NOW + 86400n, measurement: ZERO,
  grantNonce: GRANT_NONCE, signBefore: NOW + 600n, ...o,
});
const grantInput = (o = {}, top = {}) => ({ domainVersion: "2", now: NOW, grant: grantFields(o), ...top });

const intentFields = (o = {}) => ({
  payer: VAULT, deployment: DEPLOYMENT, expectedOwner: OWNER, ethOut: 10n ** 15n, maxUsdcIn6: 3_000_000n, fee: 500,
  deadline: NOW + 600n, ...o,
});
const callInput = (o = {}, io = {}) => ({
  domainVersion: "2", now: NOW, sessionId: SID, nonce: NONCE, action: 10, fee: 10_000n, deadline: NOW + 300n,
  ...o, intent: intentFields(io),
});
const stateFields = (so = {}, o = {}) => ({
  session: {
    state: 1, epoch: 0n, expiresAt: NOW + 86400n, actions: (1n << 10n) | (1n << 128n), keyHash: KEYHASH,
    measurement: ZERO, maxFee6: 50_000n, balance6: 20_000_000n, perPeriod6: 10_000_000n, periodSpent6: 0n,
    periodStart: NOW - 100n, period: 86400, opsPerPeriod: 5, periodOps: 0, envs: 2, anyApp: false, apps: [APP_ID],
    ...so,
  },
  vaultEpoch: 0n, laneSeq: 3n,
  gasPolicy: { maxGasUsdc6: 5_000_000n, maxUsdcPerEth6: 3_000_000_000n, maxEthWei: 10n ** 16n },
  sessionPublicKey: { x: 1n, y: 2n }, attestation: null,
  record: { holder: OWNER, heldEnv: 0, appId: APP_ID }, source: "test fixture",
  ...o,
});
const pre = (co = {}, io = {}, so = {}, o = {}) =>
  C.preflightGasFund(CFG, { ...callInput(co, io), suppliedState: stateFields(so, o) });

// ---------------------------------------------------------------------------------------------------------------------
// type strings, constants, identities
// ---------------------------------------------------------------------------------------------------------------------

test("EIP-712 type strings equal FundingSessionVault.sol byte for byte; tables are frozen", () => {
  assert.deepEqual(Object.keys(C.TYPES_V2).sort(), Object.keys(SOL).sort());
  for (const [name, s] of Object.entries(SOL)) assert.equal(C.encodeTypeString(name), s, name);
  assert.equal(C.DOMAIN_NAME, "Enclave Sessions");
  assert.equal(C.DOMAIN_VERSION, "2");
  assert.equal(C.ACTIONS_V2["gas.fund"], 10);
  assert.ok(!Object.values(C.ACTIONS_V2).includes(9));
  assert.ok(!("order.pay" in C.ACTIONS_V2));
  assert.equal(C.INTENT_BYTES, 224);
  assert.equal(C.MAX_DEADLINE_WINDOW, 900n);
  assert.throws(() => { C.TYPES_V2.SessionGrant.push({ name: "x", type: "uint256" }); }, TypeError);
  assert.throws(() => { C.TYPES_V2.SessionCall[2].type = "uint256"; }, TypeError);
  assert.throws(() => { C.ACTIONS_V2["order.pay"] = 9; }, TypeError);
  assert.throws(() => { CFG.vault = OWNER; }, TypeError);
});

test("no signing, key, network or submission surface is exported", () => {
  for (const name of Object.keys(C)) assert.doesNotMatch(name, /sign|submit|send|fetch|private|secret|rpc|wallet|relay/i, name);
});

test("vault identity is the factory's CREATE2 clone for the owner; config is explicit and strict", () => {
  assert.equal(VAULT.toLowerCase(), manualVault(FACTORY, IMPL, OWNER));
  assert.equal(C.keyHashOf(1n, 2n), KEYHASH);
  assert.equal(C.sessionIdOf(VAULT, KEYHASH, GRANT_NONCE), SID);
  assert.equal(CFG.chainId, 8453n);
  assert.throws(() => C.fundingConfig(cfgInput({ chainId: 84532 })), err("chain_unsupported"));
  assert.throws(() => C.fundingConfig(cfgInput({ chainId: "0x2105" })), err("uint_hex_ambiguous"));
  assert.throws(() => C.fundingConfig(cfgInput({ vault: C.predictVault(FACTORY, IMPL, OTHER_OWNER) })), err("vault_mismatch"));
  assert.throws(() => C.fundingConfig(cfgInput({ implementation: A("e2") })), err("vault_mismatch"));
  assert.throws(() => C.fundingConfig(cfgInput({ gasAdapter: LEGACY_FACTORY })), err("config_identity_collision"));
  assert.throws(() => C.fundingConfig(cfgInput({ legacyVault: OWNER })), err("config_identity_collision"));
  assert.throws(() => C.fundingConfig(cfgInput({ gasAdapter: C.ZERO_ADDRESS })), err("address_zero"));
  const { legacyFactory, ...noLegacy } = cfgInput();
  assert.ok(legacyFactory);
  assert.throws(() => C.fundingConfig(noLegacy), err("missing_field"));
  assert.throws(() => C.fundingConfig(cfgInput({ adapterFeeTiers: [200] })), err("config_fee_tiers"));
  assert.throws(() => C.fundingConfig(cfgInput({ adapterFeeTiers: [500, 500] })), err("config_fee_tiers"));
  assert.throws(() => C.fundingConfig(cfgInput({ adapterFeeTiers: [] })), err("config_fee_tiers"));
  assert.throws(() => C.fundingConfig(cfgInput({ adapterMaxEthOut: 0n })), err("config_adapter_max_zero"));
  assert.throws(() => C.fundingConfig(cfgInput({ quoteRelayer: RELAYER })), err("unknown_field"));
  // a copy, or a relay quote shaped like a config, is not trusted
  assert.throws(() => C.buildGasFundCall({ ...CFG }, callInput()), err("config_untrusted"));
  assert.throws(() => C.buildGrantV2(JSON.parse(JSON.stringify(cfgInput())), grantInput()), err("config_untrusted"));
});

// ---------------------------------------------------------------------------------------------------------------------
// SessionGrant
// ---------------------------------------------------------------------------------------------------------------------

test("grant digest equals an independent EIP-712 encoding; sid is derivable", () => {
  const b = C.buildGrantV2(CFG, grantInput());
  const g = grantFields();
  assert.equal(b.digest, manualDigest(manualDomain(8453, VAULT), manualGrantStruct(g)));
  assert.equal(b.sessionId, SID);
  assert.deepEqual({ ...b.typedData.domain },
    { name: "Enclave Sessions", version: "2", chainId: 8453, verifyingContract: VAULT });
  assert.equal(b.typedData.primaryType, "SessionGrant");
  assert.equal(b.actionsMask, (1n << 10n) | (1n << 128n));
  assert.equal(b.gasFundGranted, true);
  assert.equal(C.grantDigestV2(CFG, grantInput()), b.digest);
});

test("grant digest changes with chain, vault, domain version and every gas limit; old v1 digest differs", () => {
  const g = grantFields();
  const base = C.buildGrantV2(CFG, grantInput()).digest;
  assert.notEqual(manualDigest(manualDomain(84532, VAULT), manualGrantStruct(g)), base);
  const vault2 = C.predictVault(FACTORY, IMPL, OTHER_OWNER);
  const cfg2 = C.fundingConfig(cfgInput({ owner: OTHER_OWNER, vault: vault2 }));
  const d2 = C.buildGrantV2(cfg2, grantInput()).digest;
  assert.notEqual(d2, base);
  assert.equal(d2, manualDigest(manualDomain(8453, vault2), manualGrantStruct(g)));
  // the original SessionVault's grant digest (domain "1", 17-field type) and every mixed form differ
  const v1 = manualDigest(manualDomain(8453, VAULT, "1"), manualGrantStruct(g, { v1: true }));
  assert.notEqual(v1, base);
  assert.notEqual(manualDigest(manualDomain(8453, VAULT, "1"), manualGrantStruct(g)), base);
  assert.notEqual(manualDigest(manualDomain(8453, VAULT, "2"), manualGrantStruct(g, { v1: true })), base);
  for (const [f, v] of [["maxGasUsdcPerOp", 5_000_001n], ["maxUsdcPerEth6", 3_000_000_001n], ["maxEthPerOp", 10n ** 16n + 1n],
    ["budget", 20_000_001n], ["maxFeePerOp", 50_001n]]) {
    assert.notEqual(C.buildGrantV2(CFG, grantInput({ [f]: v })).digest, base, f);
  }
});

test("grant refusals: v1 shape, missing/implicit version, gas-limit rules, retired action, widening fields", () => {
  const v1 = grantFields();
  for (const f of C.GAS_LIMIT_FIELDS) delete v1[f];
  assert.throws(() => C.buildGrantV2(CFG, { domainVersion: "2", now: NOW, grant: v1 }), err("grant_missing_gas_limits"));
  const { domainVersion, ...noVersion } = grantInput();
  assert.equal(domainVersion, "2");
  assert.throws(() => C.buildGrantV2(CFG, noVersion), err("domain_version_required"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({}, { domainVersion: "1" })), err("domain_version_unsupported"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({}, { domainVersion: 2 })), err("domain_version_unsupported"));
  for (const f of C.GAS_LIMIT_FIELDS) {
    assert.throws(() => C.buildGrantV2(CFG, grantInput({ [f]: 0n })), err("grant_gas_limit_zero"), f);
    assert.throws(() => C.buildGrantV2(CFG, grantInput({ actions: ["deploy.fund"], maxGasUsdcPerOp: 0n, maxUsdcPerEth6: 0n,
      maxEthPerOp: 0n, [f]: 1n })), err("grant_gas_limits_without_action"), f);
  }
  const nonGas = C.buildGrantV2(CFG, grantInput({ actions: ["deploy.fund"], maxGasUsdcPerOp: 0n, maxUsdcPerEth6: 0n, maxEthPerOp: 0n }));
  assert.equal(nonGas.gasFundGranted, false);
  assert.equal(nonGas.typedData.domain.version, "2");
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ actions: ["gas.fund", "order.pay"] })), err("retired_action"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ actions: ["gas.fund", "gas.fund"] })), err("duplicate_action"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ actions: ["gas.*"] })), err("unknown_action"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ recipient: RELAYER })), err("unknown_field"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({}, { chainId: 84532 })), err("chain_mismatch"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({}, { vault: FOREIGN })), err("vault_mismatch"));
  assert.ok(C.buildGrantV2(CFG, grantInput({}, { chainId: "8453", vault: VAULT.toLowerCase() })));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ budget: 1n << 128n })), err("uint_overflow"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ maxUsdcPerEth6: 1n << 128n })), err("uint_overflow"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ maxEthPerOp: 1n << 96n })), err("uint_overflow"));
  assert.ok(C.buildGrantV2(CFG, grantInput({ maxEthPerOp: (1n << 96n) - 1n })));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ periodSeconds: 1n << 32n })), err("uint_overflow"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ periodSeconds: 0 })), err("grant_period_zero"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ expiresAt: NOW })), err("grant_expired"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ signBefore: NOW - 1n })), err("grant_sign_window_passed"));
  assert.ok(C.buildGrantV2(CFG, grantInput({ signBefore: NOW })));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ sessionKey: ZERO })), err("grant_session_key_zero"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ environments: ["prod", "dev"] })), err("unknown_environment"));
  assert.throws(() => C.buildGrantV2(CFG, grantInput({ apps: Array.from({ length: 9 }, (_, i) => `app${i}`) })),
    err("grant_too_many_apps"));
});

// ---------------------------------------------------------------------------------------------------------------------
// DexGasIntent calldata
// ---------------------------------------------------------------------------------------------------------------------

test("intent encodes to exactly 224 bytes of seven static words and round-trips", () => {
  const i = intentFields();
  const hex = C.encodeDexGasIntent(i);
  assert.equal(hex, manualIntent(i));
  assert.equal((hex.length - 2) / 2, 224);
  const d = C.decodeDexGasIntent(hex);
  assert.deepEqual({ ...d }, { ...i, payer: VAULT, expectedOwner: getAddress(OWNER) });
  assert.equal(C.encodeDexGasIntent(d), hex);
  // word 4 is what execute's _amountOf reserves
  assert.equal(BigInt(`0x${hex.slice(2 + 4 * 64, 2 + 5 * 64)}`), 3_000_000n);
});

test("intent decode refuses trailing, short, dirty and non-canonical bytes", () => {
  const hex = C.encodeDexGasIntent(intentFields());
  assert.throws(() => C.decodeDexGasIntent(`${hex}00`), err("intent_length"));
  assert.throws(() => C.decodeDexGasIntent(`${hex}${w(0)}`), err("intent_length"));
  assert.throws(() => C.decodeDexGasIntent(hex.slice(0, -2)), err("intent_length"));
  assert.throws(() => C.decodeDexGasIntent(hex.slice(0, -1)), err("hex_format"));
  assert.throws(() => C.decodeDexGasIntent(hex.toUpperCase().replace("0X", "0x")), err("hex_format"));
  const words = hex.slice(2).match(/.{64}/g);
  const withWord = (n, v) => `0x${words.map((x, j) => (j === n ? v : x)).join("")}`;
  assert.throws(() => C.decodeDexGasIntent(withWord(0, `${"ff".repeat(12)}${VAULT.slice(2).toLowerCase()}`)), err("intent_noncanonical"));
  assert.throws(() => C.decodeDexGasIntent(withWord(5, w((1n << 24n) + 500n))), err("uint_overflow"));
  assert.throws(() => C.decodeDexGasIntent(withWord(6, w((1n << 64n) + NOW))), err("uint_overflow"));
  assert.throws(() => C.decodeDexGasIntent(withWord(5, w(200))), err("fee_tier"));
  assert.throws(() => C.decodeDexGasIntent(withWord(3, w(0))), err("eth_out_zero"));
  assert.throws(() => C.decodeDexGasIntent(withWord(4, w(0))), err("max_usdc_zero"));
  assert.throws(() => C.decodeDexGasIntent(withWord(1, w(0))), err("hex32_zero"));
  assert.throws(() => C.decodeDexGasIntent(withWord(0, w(0))), err("address_zero"));
});

test("intent field validation: tiers, positive exact output, no extra fields", () => {
  assert.ok(C.encodeDexGasIntent(intentFields({ fee: 10000 })));
  for (const fee of [0, 200, 499, 3001, 1 << 24]) assert.throws(() => C.encodeDexGasIntent(intentFields({ fee })), (e) => e instanceof C.FundingCodecError);
  assert.throws(() => C.encodeDexGasIntent(intentFields({ ethOut: 0n })), err("eth_out_zero"));
  assert.throws(() => C.encodeDexGasIntent(intentFields({ maxUsdcIn6: 0n })), err("max_usdc_zero"));
  assert.throws(() => C.encodeDexGasIntent({ ...intentFields(), recipient: RELAYER }), err("unknown_field"));
  const { deadline, ...noDeadline } = intentFields();
  assert.ok(deadline);
  assert.throws(() => C.encodeDexGasIntent(noDeadline), err("missing_field"));
});

// ---------------------------------------------------------------------------------------------------------------------
// scalar parsing
// ---------------------------------------------------------------------------------------------------------------------

test("uint parsing: decimal strings only, no negatives, no hex ambiguity, no unsafe numbers, exact bounds", () => {
  const p = (v, bits = 256) => C.parseUint(v, bits, "v");
  assert.equal(p("0"), 0n);
  assert.equal(p("115792089237316195423570985008687907853269984665640564039457584007913129639935"), (1n << 256n) - 1n);
  assert.equal(p(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(p((1n << 64n) - 1n, 64), (1n << 64n) - 1n);
  assert.throws(() => p("-1"), err("uint_negative"));
  assert.throws(() => p(-1), err("uint_negative"));
  assert.throws(() => p(-1n), err("uint_negative"));
  assert.throws(() => p("0x10"), err("uint_hex_ambiguous"));
  assert.throws(() => p("0X10"), err("uint_hex_ambiguous"));
  assert.throws(() => p("0b1"), err("uint_hex_ambiguous"));
  for (const s of ["010", "1.5", " 1", "1 ", "1e3", "+1", "", "1_000"]) assert.throws(() => p(s), err("uint_format"), JSON.stringify(s));
  for (const n of [1.5, 2 ** 53, Number.NaN, Infinity, 0.1 + 0.2]) assert.throws(() => p(n), err("uint_unsafe_number"), String(n));
  for (const v of [null, undefined, true, {}, []]) assert.throws(() => p(v), err("uint_type"));
  assert.throws(() => p(1n << 256n), err("uint_overflow"));
  assert.throws(() => p(1n << 64n, 64), err("uint_overflow"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ fee: "-1" })), err("uint_negative"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ deadline: 1n << 64n })), err("uint_overflow"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({}, { maxUsdcIn6: 3.5 })), err("uint_unsafe_number"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({}, { maxUsdcIn6: 1n << 128n })), err("uint_overflow"));
});

test("addresses must be lowercase or exact EIP-55; hex32 must be lowercase", () => {
  const cs = getAddress(ADAPTER);
  assert.equal(C.parseAddress(ADAPTER, "a"), cs);
  assert.equal(C.parseAddress(cs, "a"), cs);
  const at = [...cs].findIndex((ch, j) => j > 1 && /[a-f]/.test(ch));
  assert.ok(at > 1);
  const bad = cs.slice(0, at) + cs[at].toUpperCase() + cs.slice(at + 1);
  assert.throws(() => C.parseAddress(bad, "a"), err("address_checksum"));
  const upper = `0x${ADAPTER.slice(2).toUpperCase()}`;
  assert.notEqual(upper, cs);
  assert.throws(() => C.parseAddress(upper, "a"), err("address_checksum"));
  assert.throws(() => C.parseAddress(`${ADAPTER}00`, "a"), err("address_format"));
  assert.throws(() => C.parseAddress(C.ZERO_ADDRESS, "a"), err("address_zero"));
  assert.throws(() => C.parseHex32(APP_ID.toUpperCase().replace("0X", "0x"), "h"), err("hex32_format"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ sessionId: ZERO })), err("hex32_zero"));
});

// ---------------------------------------------------------------------------------------------------------------------
// SessionCall
// ---------------------------------------------------------------------------------------------------------------------

test("call digest equals an independent encoding and changes with chain/vault/fee/args/nonce/deadline", () => {
  const b = C.buildGasFundCall(CFG, callInput());
  const c = { sessionId: SID, nonce: NONCE, fee: 10_000n, deadline: NOW + 300n };
  const args = manualIntent(intentFields());
  assert.equal(b.args, args);
  assert.equal(b.argsHash, keccak256(args));
  assert.equal(b.digest, manualDigest(manualDomain(8453, VAULT), manualCallStruct(c, keccak256(args))));
  assert.notEqual(manualDigest(manualDomain(84532, VAULT), manualCallStruct(c, keccak256(args))), b.digest);
  assert.notEqual(manualDigest(manualDomain(8453, VAULT, "1"), manualCallStruct(c, keccak256(args))), b.digest);
  assert.deepEqual({ ...b.execute }, { sessionId: SID, nonce: NONCE, action: 10, args, fee: 10_000n, deadline: NOW + 300n });
  assert.deepEqual({ ...b.maximum }, { maxUsdcIn6: 3_000_000n, fee6: 10_000n, totalMaximum6: 3_010_000n });
  const variants = [
    C.buildGasFundCall(CFG, callInput({ fee: 10_001n })),
    C.buildGasFundCall(CFG, callInput({ nonce: NONCE + 1n })),
    C.buildGasFundCall(CFG, callInput({ deadline: NOW + 299n })),
    C.buildGasFundCall(CFG, callInput({}, { maxUsdcIn6: 2_999_999n })),
    C.buildGasFundCall(CFG, callInput({}, { ethOut: 10n ** 15n + 1n })),
    C.buildGasFundCall(CFG, callInput({}, { fee: 3000 })),
    C.buildGasFundCall(CFG, callInput({}, { expectedOwner: VAULT })),
    C.buildGasFundCall(CFG, callInput({ sessionId: `0x${"5e".repeat(32)}` })),
  ];
  for (const v of variants) assert.notEqual(v.digest, b.digest);
  const vault2 = C.predictVault(FACTORY, IMPL, OTHER_OWNER);
  const cfg2 = C.fundingConfig(cfgInput({ owner: OTHER_OWNER, vault: vault2 }));
  assert.throws(() => C.buildGasFundCall(cfg2, callInput()), err("payer_not_vault"));
  assert.notEqual(C.buildGasFundCall(cfg2, callInput({}, { payer: vault2, expectedOwner: OTHER_OWNER })).digest, b.digest);
});

test("call refusals: action 9 retired, only action 10, explicit version, no quote-supplied fields", () => {
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ action: 9 })), err("retired_action"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ action: 1 })), err("action_not_gas"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ action: 266 })), err("uint_overflow"));
  const { action, ...noAction } = callInput();
  assert.equal(action, 10);
  assert.throws(() => C.buildGasFundCall(CFG, noAction), err("missing_field"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ domainVersion: "1" })), err("domain_version_unsupported"));
  for (const extra of ["recipient", "target", "calldata", "feeRecipient", "extraFee"]) {
    assert.throws(() => C.buildGasFundCall(CFG, { ...callInput(), [extra]: RELAYER }), err("unknown_field"), extra);
  }
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ chainId: 1 })), err("chain_mismatch"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ vault: FOREIGN })), err("vault_mismatch"));
});

test("scoped payer and holder: payer is exactly the vault; expectedOwner one of vault/owner/legacy vault", () => {
  for (const payer of [OWNER, ADAPTER, RELAYER, LEGACY_VAULT]) {
    assert.throws(() => C.buildGasFundCall(CFG, callInput({}, { payer })), err("payer_not_vault"));
  }
  assert.ok(C.buildGasFundCall(CFG, callInput({}, { payer: VAULT.toLowerCase() })));
  for (const expectedOwner of [VAULT, OWNER, LEGACY_VAULT]) assert.ok(C.buildGasFundCall(CFG, callInput({}, { expectedOwner })));
  for (const expectedOwner of [RELAYER, ADAPTER, LEGACY_FACTORY]) {
    assert.throws(() => C.buildGasFundCall(CFG, callInput({}, { expectedOwner })), err("holder_not_allowed"));
  }
  const noLegacy = C.fundingConfig(cfgInput({ legacyVault: null }));
  assert.throws(() => C.buildGasFundCall(noLegacy, callInput({}, { expectedOwner: LEGACY_VAULT })), err("holder_not_allowed"));
  // tier 10000 is a Uniswap tier but not in this config (the adapter source refuses it)
  assert.throws(() => C.buildGasFundCall(CFG, callInput({}, { fee: 10000 })), err("fee_tier_not_configured"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({}, { ethOut: 10n ** 17n + 1n })), err("adapter_eth_cap"));
  assert.ok(C.buildGasFundCall(CFG, callInput({}, { ethOut: 10n ** 17n })));
});

test("deadlines: call and intent both checked against the supplied now; intent at most 900 s ahead", () => {
  assert.ok(C.buildGasFundCall(CFG, callInput({ deadline: NOW })));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ deadline: NOW - 1n })), err("call_deadline_passed"));
  assert.ok(C.buildGasFundCall(CFG, callInput({}, { deadline: NOW + 900n })));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({}, { deadline: NOW + 901n })), err("intent_deadline_too_far"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ deadline: NOW }, { deadline: NOW - 1n })), err("intent_deadline_passed"));
  assert.ok(C.buildGasFundCall(CFG, callInput({ deadline: NOW + 600n }, { deadline: NOW + 600n })));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ deadline: NOW + 601n }, { deadline: NOW + 600n })), err("call_outlives_intent"));
  // a later now moves the window: the same intent deadline is now too close to pass, never silently widened
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ now: NOW + 601n, deadline: NOW + 601n })), err("intent_deadline_passed"));
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ now: undefined })), err("missing_field"));
});

test("nonces keep the upper 192-bit lane and lower 64-bit sequence; wrap is refused", () => {
  const top = (1n << 192n) - 1n;
  const n = C.composeNonce(top, 5n);
  assert.equal(n, (top << 64n) | 5n);
  const s = C.splitNonce(n);
  assert.equal(s.lane, top);
  assert.equal(s.seq, 5n);
  assert.equal(s.nextSeq, 6n);
  assert.throws(() => C.composeNonce(1n << 192n, 0n), err("uint_overflow"));
  assert.throws(() => C.composeNonce(0n, (1n << 64n) - 1n), err("nonce_wrap"));
  assert.throws(() => C.splitNonce((7n << 64n) | ((1n << 64n) - 1n)), err("nonce_wrap"));
  assert.throws(() => C.splitNonce(1n << 256n), err("uint_overflow"));
  const b = C.buildGasFundCall(CFG, callInput({ nonce: n }));
  assert.equal(b.typedData.message.nonce, n);
  assert.equal(b.nonce.lane, top);
  assert.throws(() => C.buildGasFundCall(CFG, callInput({ nonce: (5n << 64n) | ((1n << 64n) - 1n) })), err("nonce_wrap"));
  assert.ok(pre());
  assert.throws(() => pre({}, {}, {}, { laneSeq: 4n }), err("nonce_mismatch"));
  assert.throws(() => pre({}, {}, {}, { laneSeq: 2n }), err("nonce_mismatch"));
  assert.throws(() => pre({}, {}, {}, { laneSeq: (1n << 64n) - 1n }), err("nonce_lane_exhausted"));
  assert.ok(pre({ nonce: 3n }));              // lane 0, seq 3: lanes are independent counters
});

// ---------------------------------------------------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------------------------------------------------

test("preflight reserves maxUsdcIn6 + fee and reports it apart from any actual spend", () => {
  const r = pre();
  assert.equal(r.ok, true);
  assert.equal(r.chainAuthenticated, false);
  assert.equal(r.authority, "contract");
  assert.deepEqual({ ...r.reservation }, { maxUsdcIn6: 3_000_000n, fee6: 10_000n, totalMaximum6: 3_010_000n });
  assert.equal(r.session.balanceAfterReservation6, 20_000_000n - 3_010_000n);
  assert.equal(r.period.spentAfterReservation6, 3_010_000n);
  assert.equal(r.period.opsAfter, 1n);
  assert.equal(r.scope.holderKind, "wallet");
  assert.equal(r.scope.walletPaidAppCheck, "contract-only");
  assert.ok(Object.isFrozen(r.reservation));
  assert.ok(!("actual" in r));
  assert.throws(() => C.preflightGasFund(CFG, callInput()), err("missing_field"));
});

test("price, ETH and per-op USDC caps: exact boundary accepted, one unit over refused (integer math)", () => {
  // 3000 USDC per ETH, 0.001 ETH: the most that may be offered is exactly 3.000000 USDC
  assert.ok(pre({}, { ethOut: 10n ** 15n, maxUsdcIn6: 3_000_000n }));
  assert.throws(() => pre({}, { ethOut: 10n ** 15n, maxUsdcIn6: 3_000_001n }), err("price_cap"));
  assert.throws(() => pre({}, { ethOut: 10n ** 15n - 1n, maxUsdcIn6: 3_000_000n }), err("price_cap"));
  assert.ok(pre({}, { ethOut: 10n ** 16n, maxUsdcIn6: 3_000_000n }));
  assert.throws(() => pre({}, { ethOut: 10n ** 16n + 1n, maxUsdcIn6: 3_000_000n }), err("eth_cap"));
  assert.ok(pre({}, { ethOut: 2n * 10n ** 15n, maxUsdcIn6: 5_000_000n }));
  assert.throws(() => pre({}, { ethOut: 2n * 10n ** 15n, maxUsdcIn6: 5_000_001n }), err("gas_cap"));
  // a 1-wei purchase at a uint128 price ceiling: the cross-multiplication stays exact far past 2^53
  const big = { gasPolicy: { maxGasUsdc6: 5_000_000n, maxUsdcPerEth6: (1n << 128n) - 1n, maxEthWei: 10n ** 16n } };
  assert.ok(pre({}, { ethOut: 1n, maxUsdcIn6: 340_282_366_920_938_463n }, {}, big));
  assert.throws(() => pre({}, { ethOut: 1n, maxUsdcIn6: 340_282_366_920_938_464n }, {}, big), err("gas_cap"));
  assert.throws(() => pre({}, {}, {}, { gasPolicy: { maxGasUsdc6: 0n, maxUsdcPerEth6: 0n, maxEthWei: 0n } }), err("gas_policy_absent"));
});

test("budget and per-period limits on maximum + fee; equality accepted; zero fee allowed; fee cap", () => {
  assert.ok(pre({}, {}, { balance6: 3_010_000n }));
  assert.throws(() => pre({}, {}, { balance6: 3_009_999n }), err("budget_exceeded"));
  assert.ok(pre({}, {}, { periodSpent6: 6_990_000n }));
  assert.throws(() => pre({}, {}, { periodSpent6: 6_990_001n }), err("period_limit"));
  assert.throws(() => pre({}, {}, { perPeriod6: 3_009_999n }), err("period_limit"));
  const z = pre({ fee: 0n }, {}, { balance6: 3_000_000n });
  assert.equal(z.reservation.totalMaximum6, 3_000_000n);
  assert.ok(pre({ fee: 50_000n }));
  assert.throws(() => pre({ fee: 50_001n }), err("fee_too_high"));
  assert.throws(() => pre({ fee: 1n }, {}, { maxFee6: 0n }), err("fee_too_high"));
});

test("period reset is distinguished from an exhausted op limit", () => {
  const full = { periodSpent6: 10_000_000n, periodOps: 5 };
  assert.throws(() => pre({}, {}, { ...full, periodStart: NOW - 86399n }), (e) => err("op_limit")(e) && e.detail.periodReset === false);
  assert.throws(() => pre({}, {}, { periodSpent6: 10_000_000n, periodStart: NOW - 86399n }),
    (e) => err("period_limit")(e) && e.detail.periodReset === false);
  const r = pre({}, {}, { ...full, periodStart: NOW - 86400n });
  assert.equal(r.period.reset, true);
  assert.equal(r.period.spentBefore6, 0n);
  assert.equal(r.period.opsBefore, 0n);
  assert.equal(pre().period.reset, false);
  assert.ok(pre({}, {}, { opsPerPeriod: 0, periodOps: 4_000_000_000 }));   // 0 = unlimited
  assert.ok(pre({}, {}, { periodOps: 4 }));
});

test("session liveness, key, action bit and attestation come from explicit supplied state", () => {
  assert.throws(() => pre({}, {}, { state: 2 }), err("session_ended"));
  assert.throws(() => pre({}, {}, {}, { vaultEpoch: 1n }), err("session_revoked"));
  assert.ok(pre({}, {}, { expiresAt: NOW }));
  assert.throws(() => pre({}, {}, { expiresAt: NOW - 1n }), err("session_expired"));
  assert.throws(() => pre({}, {}, { actions: 1n << 9n }), err("action_not_granted"));
  assert.throws(() => pre({}, {}, { actions: 1n << 1n }), err("action_not_granted"));
  assert.throws(() => pre({}, {}, {}, { sessionPublicKey: { x: 2n, y: 1n } }), err("key_mismatch"));
  const m = `0x${"3a".repeat(32)}`;
  assert.throws(() => pre({}, {}, { measurement: m }), err("attestation_unknown"));
  assert.throws(() => pre({}, {}, { measurement: m }, { attestation: { measurement: m, revoked: true } }), err("attestation_invalid"));
  assert.throws(() => pre({}, {}, { measurement: m }, { attestation: { measurement: ZERO, revoked: false } }), err("attestation_invalid"));
  assert.ok(pre({}, {}, { measurement: m }, { attestation: { measurement: m, revoked: false } }));
  assert.throws(() => pre({}, {}, {}, { chainAuthenticated: true }), err("unknown_field"));
});

test("record scope: expected owner, held env, wallet-is-prod, legacy vault, env and app grants", () => {
  assert.throws(() => pre({}, {}, {}, { record: { holder: VAULT, heldEnv: 2, appId: APP_ID } }), err("owner_mismatch"));
  const vaultRec = (heldEnv) => ({ record: { holder: VAULT, heldEnv, appId: APP_ID } });
  assert.throws(() => pre({}, { expectedOwner: VAULT }, {}, vaultRec(0)), err("not_held"));
  assert.throws(() => pre({}, { expectedOwner: VAULT }, {}, vaultRec(1)), err("env_not_allowed"));
  assert.equal(pre({}, { expectedOwner: VAULT }, {}, vaultRec(2)).scope.holderKind, "vault");
  assert.equal(pre({}, { expectedOwner: VAULT }, { envs: 1 }, vaultRec(1)).scope.env, 1);
  // stale staging metadata on a wallet-held record does not make it staging
  assert.equal(pre({}, {}, {}, { record: { holder: OWNER, heldEnv: 1, appId: APP_ID } }).scope.env, 2);
  assert.throws(() => pre({}, {}, { envs: 1 }), err("env_not_allowed"));
  const legacy = (heldEnv) => ({ record: { holder: LEGACY_VAULT, heldEnv, appId: APP_ID } });
  assert.equal(pre({}, { expectedOwner: LEGACY_VAULT }, {}, legacy(2)).scope.holderKind, "legacyVault");
  assert.throws(() => pre({}, { expectedOwner: LEGACY_VAULT }, {}, legacy(0)), err("not_held"));
  assert.throws(() => pre({}, {}, {}, { record: { holder: OWNER, heldEnv: 0, appId: OTHER_APP } }), err("app_not_allowed"));
  assert.ok(pre({}, {}, { anyApp: true, apps: [] }, { record: { holder: OWNER, heldEnv: 0, appId: OTHER_APP } }));
});

// ---------------------------------------------------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------------------------------------------------

const GF_TOPIC = kh("GasFunded(bytes32,bytes32,address,uint256,uint256,uint256,address,uint256)");
const OP_TOPIC = kh("SessionOp(bytes32,uint256,uint8,bytes32,uint256,uint256,bytes)");
const BUILT = C.buildGasFundCall(CFG, callInput());

function gasFundedLog(o = {}) {
  const v = { address: VAULT, sid: SID, deployment: DEPLOYMENT, holder: OWNER, ethOut: 10n ** 15n, used: 2_400_000n,
    max: 3_000_000n, relayer: RELAYER, fee: 10_000n, ...o };
  return { address: v.address.toLowerCase(), topics: [GF_TOPIC, v.sid, v.deployment, `0x${wa(v.holder)}`],
    data: `0x${w(v.ethOut)}${w(v.used)}${w(v.max)}${wa(v.relayer)}${w(v.fee)}` };
}
function sessionOpLog(o = {}) {
  const v = { address: VAULT, sid: SID, nonce: NONCE, action: 10, argsHash: BUILT.argsHash, amount: 2_400_000n,
    fee: 10_000n, used: 2_400_000n, back: 600_000n, ...o };
  return { address: v.address.toLowerCase(), topics: [OP_TOPIC, v.sid, `0x${w(v.action)}`],
    data: `0x${w(v.nonce)}${wh(v.argsHash)}${w(v.amount)}${w(v.fee)}${w(160)}${w(64)}${w(v.used)}${w(v.back)}` };
}
const settle = (logs, o = {}) => C.parseGasSettlement(CFG, {
  call: { sessionId: SID, nonce: NONCE, args: BUILT.args, fee: 10_000n },
  logs, sessionOpAmountSemantics: "actual", ...o,
});

test("event topics match the Solidity signatures", () => {
  assert.equal(C.GAS_FUNDED_TOPIC, GF_TOPIC);
  assert.equal(C.SESSION_OP_TOPIC, OP_TOPIC);
});

test("settlement separates signed maximum from actual debit; refund + actual == maximum; fee once", () => {
  const usdcTransfer = { address: FOREIGN, topics: [kh("Transfer(address,address,uint256)")], data: `0x${w(1)}` };
  const r = settle([usdcTransfer, gasFundedLog({ address: FOREIGN }), sessionOpLog(), gasFundedLog()], {
    submitter: RELAYER, balances: { balance6Before: 20_000_000n, balance6After: 17_590_000n },
  });
  assert.deepEqual({ ...r.maximum }, { maxUsdcIn6: 3_000_000n, fee6: 10_000n, totalMaximum6: 3_010_000n });
  assert.deepEqual({ ...r.actual }, { usdcSpent6: 2_400_000n, fee6: 10_000n, totalDebit6: 2_410_000n });
  assert.equal(r.refund6, 600_000n);
  assert.equal(r.actual.usdcSpent6 + r.refund6, r.maximum.maxUsdcIn6);
  assert.equal(r.maximum.totalMaximum6 - r.actual.totalDebit6, r.refund6);       // the fee is in both, once each
  assert.equal(r.ethOut, 10n ** 15n);
  assert.equal(r.relayerMatchesSubmitter, true);
  assert.equal(r.chainAuthenticated, false);
  // full use of the maximum: zero refund
  const full = settle([gasFundedLog({ used: 3_000_000n }), sessionOpLog({ amount: 3_000_000n, used: 3_000_000n, back: 0n })]);
  assert.equal(full.refund6, 0n);
  // zero fee
  const zf = C.parseGasSettlement(CFG, { call: { sessionId: SID, nonce: NONCE, args: BUILT.args, fee: 0n },
    logs: [gasFundedLog({ fee: 0n }), sessionOpLog({ fee: 0n })], sessionOpAmountSemantics: "actual" });
  assert.equal(zf.actual.totalDebit6, 2_400_000n);
});

test("settlement refusals: actual over max, refund mismatch, fee counted twice or differently, scope, counts", () => {
  assert.throws(() => settle([gasFundedLog({ used: 3_000_001n }), sessionOpLog({ amount: 3_000_001n, used: 3_000_001n, back: 0n })]),
    err("actual_exceeds_max"));
  assert.throws(() => settle([gasFundedLog({ used: 0n }), sessionOpLog({ amount: 0n, used: 0n, back: 3_000_000n })]), err("actual_zero"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog({ back: 599_999n })]), err("refund_mismatch"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog({ used: 2_400_001n })]), err("settlement_result"));
  assert.throws(() => settle([gasFundedLog({ fee: 20_000n }), sessionOpLog()]), err("fee_mismatch"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog({ fee: 0n })]), err("fee_mismatch"));
  assert.throws(() => settle([gasFundedLog({ ethOut: 10n ** 15n - 1n }), sessionOpLog()]), err("settlement_eth"));
  assert.throws(() => settle([gasFundedLog({ max: 3_000_001n }), sessionOpLog()]), err("settlement_max"));
  assert.throws(() => settle([gasFundedLog({ holder: VAULT }), sessionOpLog()]), err("settlement_scope"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog({ argsHash: kh("other") })]), err("settlement_args"));
  assert.throws(() => settle([gasFundedLog(), gasFundedLog(), sessionOpLog()]), err("gas_funded_count"));
  assert.throws(() => settle([gasFundedLog()]), err("session_op_count"));
  assert.throws(() => settle([sessionOpLog()]), err("gas_funded_count"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog({ nonce: NONCE + 1n })]), err("session_op_count"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog()], { submitter: OWNER }), err("relayer_mismatch"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog()], { balances: { balance6Before: 20_000_000n, balance6After: 17_589_999n } }),
    err("session_balance_mismatch"));
  // reserved-maximum accounting (no refund) is NOT what a debit of actual + fee looks like
  assert.throws(() => settle([gasFundedLog(), sessionOpLog()], { balances: { balance6Before: 20_000_000n, balance6After: 16_990_000n } }),
    err("session_balance_mismatch"));
  const bad = gasFundedLog();
  bad.data = `${bad.data}00`;
  assert.throws(() => settle([bad, sessionOpLog()]), err("hex_format"));
  bad.data = `${gasFundedLog().data}${w(0)}`;
  assert.throws(() => settle([bad, sessionOpLog()]), err("log_decode"));
});

test("SessionOp.amount6 semantics must be named: actual (anticipated root fix) vs maximum (current source)", () => {
  const maxLogs = [gasFundedLog(), sessionOpLog({ amount: 3_000_000n })];
  const m = settle(maxLogs, { sessionOpAmountSemantics: "maximum" });
  assert.equal(m.sessionOpAmount6, 3_000_000n);
  assert.equal(m.actual.usdcSpent6, 2_400_000n);              // actual still comes from GasFunded, never amount6
  assert.throws(() => settle(maxLogs), err("amount_semantics_mismatch"));
  assert.throws(() => settle([gasFundedLog(), sessionOpLog()], { sessionOpAmountSemantics: "maximum" }), err("amount_semantics_mismatch"));
  assert.throws(() => settle(maxLogs, { sessionOpAmountSemantics: "either" }), err("amount_semantics_required"));
  assert.throws(() => settle(maxLogs, { sessionOpAmountSemantics: undefined }), err("missing_field"));
});

// ---------------------------------------------------------------------------------------------------------------------
// owner controls (domain version 2) and SessionEnd
// ---------------------------------------------------------------------------------------------------------------------

const ownerOp = (op, message, o = {}) => C.buildOwnerOpV2(CFG, { domainVersion: "2", now: NOW, op, message, ...o });

test("owner ops hash under domain version 2 and equal independent encodings; v1 differs", () => {
  const ds = manualDomain(8453, VAULT);
  const t = ownerOp("topUp", { sessionId: SID, amount: 1_000_000n, opNonce: OP_NONCE, signBefore: NOW + 600n });
  const topUpStruct = k(wh(kh(SOL.TopUp)), wh(SID), w(1_000_000n), wh(OP_NONCE), w(NOW + 600n));
  assert.equal(t.digest, manualDigest(ds, topUpStruct));
  assert.notEqual(manualDigest(manualDomain(8453, VAULT, "1"), topUpStruct), t.digest);
  assert.equal(t.typedData.domain.version, "2");

  const pm = { deployment: DEPLOYMENT, app: "site", publisher: OWNER, appRef: `catalog://${APP_ID}/3`, configCid: "bafy-test",
    versionLabel: "1.0.0", isPublic: true, opNonce: OP_NONCE, signBefore: NOW + 600n };
  const p = ownerOp("promote", pm);
  assert.equal(p.digest, manualDigest(ds, k(wh(kh(SOL.Promote)), wh(DEPLOYMENT), wh(kh(pm.app)), wa(OWNER), wh(kh(pm.appRef)),
    wh(kh(pm.configCid)), wh(kh(pm.versionLabel)), wb(true), wh(OP_NONCE), w(NOW + 600n))));

  const rv = ownerOp("revokeAll", { withdraw: true, opNonce: OP_NONCE, signBefore: NOW + 600n });
  assert.equal(rv.digest, manualDigest(ds, k(wh(kh(SOL.RevokeAll)), wb(true), wh(OP_NONCE), w(NOW + 600n))));
  const rl = ownerOp("release", { deployment: DEPLOYMENT, to: OWNER, opNonce: OP_NONCE, signBefore: NOW + 600n });
  assert.equal(rl.digest, manualDigest(ds, k(wh(kh(SOL.Release)), wh(DEPLOYMENT), wa(OWNER), wh(OP_NONCE), w(NOW + 600n))));

  const end = C.buildSessionEndV2(CFG, { domainVersion: "2", now: NOW, sessionId: SID, deadline: NOW + 600n });
  assert.equal(end.digest, manualDigest(ds, k(wh(kh(SOL.SessionEnd)), wh(SID), w(NOW + 600n))));
  for (const op of Object.keys(C.OWNER_OPS)) assert.ok(C.OWNER_OPS[op] in SOL, op);
});

test("owner op refusals: explicit version, nonce, windows, release target, strict types", () => {
  const m = { sessionId: SID, opNonce: OP_NONCE, signBefore: NOW + 600n };
  assert.ok(ownerOp("terminate", m));
  assert.throws(() => C.buildOwnerOpV2(CFG, { now: NOW, op: "terminate", message: m }), err("domain_version_required"));
  assert.throws(() => ownerOp("terminate", m, { domainVersion: "1" }), err("domain_version_unsupported"));
  assert.throws(() => ownerOp("terminate", { ...m, opNonce: ZERO }), err("op_nonce_zero"));
  assert.throws(() => ownerOp("terminate", { ...m, signBefore: NOW - 1n }), err("owner_sign_window_passed"));
  assert.throws(() => ownerOp("terminate", { ...m, sessionId: ZERO }), err("hex32_zero"));
  assert.throws(() => ownerOp("terminate", { ...m, recipient: RELAYER }), err("unknown_field"));
  assert.throws(() => ownerOp("ownerCall", m), err("unknown_owner_op"));
  assert.throws(() => ownerOp("revokeAll", { withdraw: "true", opNonce: OP_NONCE, signBefore: NOW + 600n }), err("bool_type"));
  assert.throws(() => ownerOp("extend", { sessionId: SID, expiresAt: NOW, opNonce: OP_NONCE, signBefore: NOW + 600n }), err("extend_in_past"));
  assert.throws(() => ownerOp("adopt", { deployment: DEPLOYMENT, environment: "dev", opNonce: OP_NONCE, signBefore: NOW + 600n }),
    err("unknown_environment"));
  assert.throws(() => ownerOp("release", { deployment: DEPLOYMENT, to: RELAYER, opNonce: OP_NONCE, signBefore: NOW + 600n }),
    err("release_target_unverified"));
  assert.throws(() => ownerOp("withdraw", { amount: "0x01", opNonce: OP_NONCE, signBefore: NOW + 600n }), err("uint_hex_ambiguous"));
  assert.throws(() => ownerOp("terminate", m, { chainId: 84532 }), err("chain_mismatch"));
  assert.throws(() => C.buildSessionEndV2(CFG, { domainVersion: "2", now: NOW, sessionId: SID, deadline: NOW - 1n }),
    err("call_deadline_passed"));
});
