// UNREVIEWED SOURCE (unified-funding relay-r1). Additive, opt-in relay routes for the FundingSessionVault successor
// (EIP-712 "Enclave Sessions" version "2", action 10 gas.fund) under the EXISTING sessions service:
//
//   GET  /funding/config    the activation manifest's identities, re-proven on chain at one pinned block
//   POST /funding/quote     a gas.fund intent priced by the pinned Uniswap V3 QuoterV2 (exact output, pinned tier)
//   POST /funding/execute   vault.execute(action 10) - simulated by the real vault, then the host's simulateAndSend
//   POST /funding/open      factory.openFor / openWithDepositFor - REFUSED unless the HOST passes ownerManagement: true
//
// What this module does NOT have: a wallet client, a private key, a TxQueue, a nonce manager, a signer. Every write
// goes through the ONE callback the host hands it (sessions.mjs simulateAndSend: simulate, existing journaled queue,
// receipt). The original routes, the original factory, the address book's "sessionVaultFactory", the original vaults
// and their sessions are never read for migration, never widened, never released or terminated here.
//
// Disabled unless ALL of these hold (else every /funding/* route answers 503 funding_disabled, saying why):
//   - an activation manifest (parseFundingManifest) naming chain 8453, every identity and its exact runtime code hash;
//   - a host quote policy { fee(ctx) -> fee6, accept(ctx) -> true } (this module never invents a price or a margin);
//   - the host's simulateAndSend callback, public client and relayer address.
// Nothing in a request body can enable anything.
//
// Import path: relative to this stage directory (relay-r1 has no node_modules). prepare.py rewrites it to the bare
// specifier "viem" in the patched drop-in copy.
import { readFileSync } from "node:fs";
import { decodeAbiParameters, decodeErrorResult, decodeEventLog, encodeAbiParameters, getAddress, isAddress, keccak256 }
  from "viem";
import { fundingSessionVaultAbi, fundingSessionVaultFactoryAbi, leaseGasDexAdapterAbi, fundingLedgerAbi }
  from "./generated/funding-abi.mjs";

// =====================================================================================================================
// Constants and ABIs
// =====================================================================================================================

export const FUNDING_CHAIN_ID = 8453;
export const MANIFEST_SCHEMA = "enclave-funding-activation-r1";
export const ACTION_GAS_FUND = 10;
const RETIRED_ACTION = 9;
const INTENT_BYTES = 224;
const MAX_DEADLINE_WINDOW = 900n;                  // LeaseGasDexAdapter.MAX_DEADLINE_WINDOW
/** Syntactically pinnable Uniswap V3 tiers. The adapter SOURCE serves 100/500/3000 only: a manifest naming 10000
 *  passes parsing and then fails closed at the adapter.poolFor(10000) pin read. */
export const FEE_TIERS = Object.freeze([100, 500, 3000, 10000]);
export const MAX_SLIPPAGE_BPS = 500;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const EMPTY_CODEHASH = keccak256("0x");
const BOOK_DEPLOYMENTS = `0x${Buffer.from("deployments").toString("hex").padEnd(64, "0")}`;
const CLONE_INIT_PREFIX = "3d602d80600a3d3981f3363d3d373d3d3d363d73";
const CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

/** Every identity the manifest pins by address AND exact runtime keccak256. */
export const PIN_KEYS = Object.freeze(["factory", "implementation", "fundingGasLib", "fundingSessionVaultLib", "adapter",
  "legacyFactory", "legacyImplementation", "usdc", "weth", "book", "ledger", "reserve", "swapRouter", "dexFactory", "quoter"]);
const LINKED_LIBS = Object.freeze(["fundingGasLib", "fundingSessionVaultLib"]);

const vaultAbi = fundingSessionVaultAbi;
const factoryAbi = fundingSessionVaultFactoryAbi;
const adapterAbi = leaseGasDexAdapterAbi;
const ledgerAbi = fundingLedgerAbi;

// Hand-written, minimal: interfaces with no artifact in this build. Each is the published/original signature.
const addrOut = [{ name: "", type: "address" }];
const view = (name, inputs, outputs) => ({ type: "function", name, stateMutability: "view", inputs, outputs });
export const bookAbi = Object.freeze([view("addr", [{ name: "key", type: "bytes32" }], addrOut)]);
export const reserveAbi = Object.freeze([view("ledger", [], addrOut)]);
export const legacyFactoryAbi = Object.freeze([view("implementation", [], addrOut),
  view("isVault", [{ name: "", type: "address" }], [{ name: "", type: "bool" }]),
  view("vaultFor", [{ name: "owner", type: "address" }], addrOut)]);
export const legacyVaultAbi = Object.freeze([view("owner", [], addrOut)]);
/** Uniswap V3 periphery QuoterV2 (IQuoterV2). quoteExactOutputSingle is non-view on chain; it is only ever eth_call'd. */
export const quoterV2Abi = Object.freeze([view("factory", [], addrOut), view("WETH9", [], addrOut),
  { type: "function", name: "quoteExactOutputSingle", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amount", type: "uint256" },
      { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountIn", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }] }]);

// The successor Grant tuple, straight from the compiled artifact (generated/funding-abi.mjs).
const OPEN_FOR = factoryAbi.find((x) => x.type === "function" && x.name === "openFor");
if (!OPEN_FOR || OPEN_FOR.inputs[1]?.type !== "tuple") throw new Error("funding-abi: FundingSessionVaultFactory.openFor(owner, Grant, sig) not found");
export const GRANT_COMPONENTS = Object.freeze(OPEN_FOR.inputs[1].components.map((c) => Object.freeze({ name: c.name, type: c.type })));
const GAS_LIMIT_FIELDS = Object.freeze(["maxGasUsdcPerOp", "maxUsdcPerEth6", "maxEthPerOp"]);
for (const k of GAS_LIMIT_FIELDS) if (!GRANT_COMPONENTS.some((c) => c.name === k)) throw new Error(`funding-abi: Grant lacks ${k}`);

const INTENT_PARAMS = Object.freeze([{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" },
  { type: "uint256" }, { type: "uint24" }, { type: "uint64" }]);

// =====================================================================================================================
// Errors and strict parsing
// =====================================================================================================================

/** Shaped like sessions.mjs httpError: the host's handle() reads status, code and extra. */
export class FundingRouteError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = "FundingRouteError";
    this.status = status; this.code = code; this.extra = extra;
  }
}
const httpError = (status, code, message, extra) => new FundingRouteError(status, code, message, extra);
const msg = (e) => String(e?.shortMessage || e?.message || e).slice(0, 300);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function uint(v, bits, name) {
  let n;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)) n = BigInt(v);
  else throw httpError(400, "bad_request", `${name} must be a non-negative integer (bigint, safe number or decimal string)`);
  if (n < 0n || n >= 1n << BigInt(bits)) throw httpError(400, "bad_request", `${name} is out of range for uint${bits}`);
  return n;
}
function address(v, name) {
  if (typeof v !== "string" || !isAddress(v, { strict: false }) || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw httpError(400, "bad_request", `${name} must be an address`);
  const a = getAddress(v.toLowerCase());
  if (v !== v.toLowerCase() && v !== a) throw httpError(400, "bad_request", `${name} has a wrong EIP-55 checksum`);
  return a;
}
function hex32(v, name) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw httpError(400, "bad_request", `${name} must be 32-byte hex`);
  return v.toLowerCase();
}
function hexBytes(v, name, maxBytes) {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v) || v.length > 2 + 2 * maxBytes) {
    throw httpError(400, "bad_request", `${name} must be even-length hex, at most ${maxBytes} bytes`);
  }
  return v.toLowerCase();
}
function plain(o, name) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw httpError(400, "bad_request", `${name} must be an object`);
}
function exactKeys(o, keys, name, optional = []) {
  plain(o, name);
  const allowed = new Set([...keys, ...optional]);
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length) throw httpError(400, "bad_request", `${name} has unknown field(s) ${extra.join(", ")}`);
  const missing = keys.filter((k) => !has(o, k) || o[k] === undefined);
  if (missing.length) throw httpError(400, "bad_request", `${name} is missing ${missing.join(", ")}`);
}

/** Pull revert data out of a viem error, duck-typed down the cause chain (as sessions.mjs revertData). */
export function revertData(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    if (typeof x.raw === "string" && /^0x[0-9a-fA-F]{8}/.test(x.raw)) return x.raw;
    if (typeof x.data === "string" && /^0x[0-9a-fA-F]{8}/.test(x.data)) return x.data;
  }
  return undefined;
}

// =====================================================================================================================
// Pure helpers (cross-checked against client-r1/funding-codec.mjs in the tests)
// =====================================================================================================================

/** FundingSessionVaultFactory.vaultFor(owner): CREATE2(factory, salt = owner, EIP-1167 clone of implementation). */
export function predictVault(factory, implementation, owner) {
  const f = getAddress(factory).slice(2).toLowerCase();
  const i = getAddress(implementation).slice(2).toLowerCase();
  const o = getAddress(owner).slice(2).toLowerCase();
  const codeHash = keccak256(`0x${CLONE_INIT_PREFIX}${i}${CLONE_SUFFIX}`).slice(2);
  return getAddress(`0x${keccak256(`0xff${f}${o.padStart(64, "0")}${codeHash}`).slice(26)}`);
}

/** The EIP-1167 RUNTIME code a genuine clone of `implementation` carries. */
export function cloneRuntime(implementation) {
  return `0x363d3d373d3d3d363d73${getAddress(implementation).slice(2).toLowerCase()}${CLONE_SUFFIX}`;
}

export function sessionIdOf(vault, sessionKey, grantNonce) {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [getAddress(vault), sessionKey, grantNonce]));
}

export function encodeIntent(i) {
  return encodeAbiParameters(INTENT_PARAMS, [i.payer, i.deployment, i.expectedOwner, i.ethOut, i.maxUsdcIn6, BigInt(i.fee), i.deadline]);
}

/** Strict: exactly 224 bytes, canonical words (re-encoding must reproduce the bytes), a pinnable tier, positive amounts. */
export function decodeIntent(data) {
  const hex = hexBytes(data, "args", INTENT_BYTES);
  if ((hex.length - 2) / 2 !== INTENT_BYTES) throw httpError(400, "bad_args", `gas.fund args must be exactly ${INTENT_BYTES} bytes`);
  let w;
  try { w = decodeAbiParameters(INTENT_PARAMS, hex); } catch (e) { throw httpError(400, "bad_args", `args do not decode: ${msg(e)}`); }
  const i = { payer: getAddress(w[0]), deployment: w[1].toLowerCase(), expectedOwner: getAddress(w[2]), ethOut: w[3],
    maxUsdcIn6: w[4], fee: Number(w[5]), deadline: BigInt(w[6]) };
  if (encodeIntent(i).toLowerCase() !== hex) throw httpError(400, "bad_args", "args carry non-canonical (dirty) bits");
  if (i.deployment === ZERO_HASH) throw httpError(400, "bad_args", "intent.deployment is zero");
  if (i.ethOut === 0n || i.maxUsdcIn6 === 0n) throw httpError(400, "bad_args", "intent.ethOut and intent.maxUsdcIn6 must be positive");
  if (!FEE_TIERS.includes(i.fee)) throw httpError(400, "bad_args", `intent.fee ${i.fee} is not a Uniswap V3 tier`);
  return Object.freeze(i);
}

// =====================================================================================================================
// Activation manifest
// =====================================================================================================================

const MANIFEST_KEYS = ["schema", "chainId", "notAfter", "maxBlockAgeSec", "addresses", "codehashes", "pools", "feeTiers",
  "maxSlippageBps", "deadlineSec"];

function codehash(v, name) {
  if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/.test(v)) throw httpError(400, "bad_manifest", `${name} must be lowercase 0x + 64 hex`);
  if (v === ZERO_HASH || v === EMPTY_CODEHASH) throw httpError(400, "bad_manifest", `${name} is the zero or empty-code hash`);
  return v;
}

/** { manifest } or { why }. Every identity explicit; nothing defaults from an address book, a quote or a body. */
export function parseFundingManifest(m) {
  if (m === null || m === undefined) return { why: "funding is not configured on this relay (no activation manifest)" };
  if (m && typeof m === "object" && Object.keys(m).length === 1 && typeof m.invalid === "string") return { why: m.invalid };
  try {
    exactKeys(m, MANIFEST_KEYS, "manifest");
    if (m.schema !== MANIFEST_SCHEMA) throw httpError(400, "bad_manifest", `manifest.schema must be "${MANIFEST_SCHEMA}"`);
    if (uint(m.chainId, 64, "manifest.chainId") !== BigInt(FUNDING_CHAIN_ID)) {
      throw httpError(400, "bad_manifest", `manifest.chainId must be ${FUNDING_CHAIN_ID} (Base)`);
    }
    const notAfter = uint(m.notAfter, 64, "manifest.notAfter");
    const maxBlockAgeSec = uint(m.maxBlockAgeSec, 32, "manifest.maxBlockAgeSec");
    if (maxBlockAgeSec < 1n || maxBlockAgeSec > 600n) throw httpError(400, "bad_manifest", "manifest.maxBlockAgeSec must be 1..600");
    exactKeys(m.addresses, PIN_KEYS, "manifest.addresses");
    exactKeys(m.codehashes, PIN_KEYS, "manifest.codehashes");
    const addresses = {}, codehashes = {};
    for (const k of PIN_KEYS) {
      addresses[k] = address(m.addresses[k], `manifest.addresses.${k}`);
      codehashes[k] = codehash(m.codehashes[k], `manifest.codehashes.${k}`);
    }
    if (!Array.isArray(m.feeTiers) || m.feeTiers.length === 0) throw httpError(400, "bad_manifest", "manifest.feeTiers must be a non-empty array");
    const feeTiers = m.feeTiers.map((t, k) => Number(uint(t, 24, `manifest.feeTiers[${k}]`)));
    if (feeTiers.some((t) => !FEE_TIERS.includes(t)) || new Set(feeTiers).size !== feeTiers.length) {
      throw httpError(400, "bad_manifest", "manifest.feeTiers must be distinct members of 100/500/3000/10000");
    }
    exactKeys(m.pools, feeTiers.map(String), "manifest.pools");
    const pools = {};
    for (const t of feeTiers) {
      exactKeys(m.pools[t], ["address", "codehash"], `manifest.pools.${t}`);
      pools[t] = Object.freeze({ address: address(m.pools[t].address, `manifest.pools.${t}.address`),
        codehash: codehash(m.pools[t].codehash, `manifest.pools.${t}.codehash`) });
    }
    const ids = [...Object.values(addresses), ...Object.values(pools).map((p) => p.address)];
    if (new Set(ids).size !== ids.length) throw httpError(400, "bad_manifest", "manifest identities must be pairwise distinct");
    const maxSlippageBps = Number(uint(m.maxSlippageBps, 16, "manifest.maxSlippageBps"));
    if (maxSlippageBps > MAX_SLIPPAGE_BPS) throw httpError(400, "bad_manifest", `manifest.maxSlippageBps must be <= ${MAX_SLIPPAGE_BPS}`);
    const deadlineSec = uint(m.deadlineSec, 32, "manifest.deadlineSec");
    if (deadlineSec < 30n || deadlineSec > MAX_DEADLINE_WINDOW) throw httpError(400, "bad_manifest", "manifest.deadlineSec must be 30..900");
    return { manifest: Object.freeze({ chainId: FUNDING_CHAIN_ID, notAfter, maxBlockAgeSec, addresses: Object.freeze(addresses),
      codehashes: Object.freeze(codehashes), pools: Object.freeze(pools), feeTiers: Object.freeze(feeTiers), maxSlippageBps,
      deadlineSec }) };
  } catch (e) {
    return { why: `the funding activation manifest is refused: ${e.message}` };
  }
}

/** SESSIONS_FUNDING_MANIFEST = path of a reviewed activation manifest (JSON). Unset: null (disabled). */
export function fundingManifestFromEnv(env) {
  const p = String(env?.SESSIONS_FUNDING_MANIFEST ?? "").trim();
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { return { invalid: `SESSIONS_FUNDING_MANIFEST could not be read: ${msg(e)}` }; }
}

// =====================================================================================================================
// The route
// =====================================================================================================================

/** Build the /funding/* handler. `ownerManagement` is a HOST-CODE flag: only reviewed host code that also serves the
 *  successor's owner controls (topUp/extend/terminate/revokeAll/withdraw/promote/adopt/setEnvironment/release under
 *  domain version 2) may set it true. Until then /funding/open is refused so no session is opened through this relay
 *  without a relayed way to manage it (the owner can always call the successor vault directly). */
export function createFundingRoute({ manifest = null, quotePolicy = null, ownerManagement = false, pc = null, relayer = null,
  store = null, log = () => {}, now = () => Math.floor(Date.now() / 1000), simulateAndSend = null } = {}) {
  const setup = parseFundingManifest(manifest);
  let why = setup.why ?? null;
  if (!why && (!quotePolicy || typeof quotePolicy.fee !== "function" || typeof quotePolicy.accept !== "function")) {
    why = "funding needs a reviewed host quote policy ({ fee, accept }); none is wired, so no price is offered";
  }
  if (!why && typeof simulateAndSend !== "function") why = "funding needs the host's simulateAndSend callback";
  if (!why && (!pc || typeof pc.readContract !== "function" || typeof pc.simulateContract !== "function")) why = "funding needs the host's public client";
  if (!why && (typeof relayer !== "string" || !isAddress(relayer))) why = "funding needs the relayer address";
  if (!why && !store?.data) why = "funding needs the host's store";
  const M = why ? null : setup.manifest;
  const A = M?.addresses;
  const R = M ? getAddress(relayer) : null;
  const openAllowed = ownerManagement === true;
  const openWhy = openAllowed ? null
    : "opening successor sessions through this relay is disabled: the host has no reviewed successor owner-management route";
  if (M) {
    store.data.fundingOps ??= {};     // sid -> [{ nonce, action, amount6 (ACTUAL), fee6, maxUsdcIn6, ... }]
    store.data.fundingVaults ??= {};  // successor vault -> owner (kept apart from the original factory's index)
  }
  log(M ? `funding: on (successor factory ${A.factory}, open ${openAllowed ? "on" : "off"})` : `funding: off (${why})`);

  const rd = (address_, abi, functionName, args, blockNumber) => pc.readContract({ address: address_, abi, functionName, args, blockNumber });
  async function step(fn, code = "chain_unreadable") {
    try { return await fn(); } catch (e) {
      if (e instanceof FundingRouteError) throw e;
      throw httpError(503, code, `a chain read failed: ${msg(e)}`);
    }
  }

  // ---- pins: one latest block, every identity, before any simulation or submission ----------------------------------
  async function readPins() {
    const blk = await step(() => pc.getBlock({ blockTag: "latest" }), "pin_unreadable");
    const chain = await step(() => pc.getChainId(), "pin_unreadable");
    if (Number(chain) !== FUNDING_CHAIN_ID) throw httpError(503, "chain_mismatch", `the RPC serves chain ${chain}, not ${FUNDING_CHAIN_ID}`);
    if (blk?.number == null || blk?.timestamp == null) throw httpError(503, "pin_unreadable", "the latest block has no number/timestamp");
    const B = BigInt(blk.number);
    const ts = BigInt(blk.timestamp);
    const t = BigInt(now());
    if (t > M.notAfter) throw httpError(503, "manifest_stale", `the activation manifest expired at ${M.notAfter}`);
    if (t > ts + M.maxBlockAgeSec) throw httpError(503, "block_stale", `the latest block (${B}) is ${t - ts}s old`);
    const pin = (code, message) => { throw httpError(503, code, message, { block: B.toString() }); };
    const codes = {};
    const checkCode = async (label, a, want) => {
      const code = await step(() => pc.getCode({ address: a, blockNumber: B }), "pin_unreadable");
      if (!code || code === "0x") pin("missing_code", `${label} ${a} has no code at block ${B}`);
      if (keccak256(code) !== want) pin("codehash_mismatch", `${label} ${a} runtime code hash differs from the manifest at block ${B}`);
      return code.toLowerCase();
    };
    for (const k of PIN_KEYS) codes[k] = await checkCode(k, A[k], M.codehashes[k]);
    for (const tier of M.feeTiers) await checkCode(`pool(${tier})`, M.pools[tier].address, M.pools[tier].codehash);
    for (const k of LINKED_LIBS) {
      if (!codes.implementation.includes(A[k].slice(2).toLowerCase())) pin("library_unlinked", `the implementation does not link ${k} ${A[k]}`);
    }
    const eq = async (label, a, abi, fn, args, want) => {
      const got = await step(() => rd(a, abi, fn, args, B), "pin_unreadable");
      if (typeof got !== "string" || !isAddress(got) || getAddress(got) !== want) pin("identity_mismatch", `${label} is ${got}, the manifest says ${want}`);
    };
    await eq("factory.implementation()", A.factory, factoryAbi, "implementation", [], A.implementation);
    for (const [fn, want] of [["factory", A.factory], ["usdc", A.usdc], ["book", A.book], ["gasAdapter", A.adapter],
      ["legacyFactory", A.legacyFactory]]) await eq(`implementation.${fn}()`, A.implementation, vaultAbi, fn, [], want);
    await eq("book.addr(\"deployments\")", A.book, bookAbi, "addr", [BOOK_DEPLOYMENTS], A.ledger);
    for (const [fn, want] of [["usdc", A.usdc], ["weth", A.weth], ["swapRouter", A.swapRouter], ["factory", A.dexFactory],
      ["ledger", A.ledger], ["reserve", A.reserve]]) await eq(`adapter.${fn}()`, A.adapter, adapterAbi, fn, [], want);
    await eq("reserve.ledger()", A.reserve, reserveAbi, "ledger", [], A.ledger);
    await eq("legacyFactory.implementation()", A.legacyFactory, legacyFactoryAbi, "implementation", [], A.legacyImplementation);
    for (const tier of M.feeTiers) await eq(`adapter.poolFor(${tier})`, A.adapter, adapterAbi, "poolFor", [tier], M.pools[tier].address);
    await eq("quoter.factory()", A.quoter, quoterV2Abi, "factory", [], A.dexFactory);
    await eq("quoter.WETH9()", A.quoter, quoterV2Abi, "WETH9", [], A.weth);
    const adapterMaxEthOut = BigInt(await step(() => rd(A.adapter, adapterAbi, "maxEthOut", [], B), "pin_unreadable"));
    if (adapterMaxEthOut === 0n) pin("identity_mismatch", "adapter.maxEthOut() is 0");
    return Object.freeze({ block: B, timestamp: ts, adapterMaxEthOut });
  }

  /** A successor vault proven through the pinned factory (isVault, vaultFor(owner), CREATE2 prediction, clone code),
   *  never by its own owner() alone. */
  async function fundingVault(v, P) {
    const vault = address(v, "vault");
    const B = P.block;
    if (!(await step(() => rd(A.factory, factoryAbi, "isVault", [vault], B)))) {
      throw httpError(404, "not_a_funding_vault", `${vault} is not a vault of the successor factory ${A.factory}`);
    }
    const owner = getAddress(await step(() => rd(vault, vaultAbi, "owner", [], B)));
    if (predictVault(A.factory, A.implementation, owner) !== vault) throw httpError(409, "vault_identity", "the vault is not the CREATE2 clone for its owner");
    const onchain = await step(() => rd(A.factory, factoryAbi, "vaultFor", [owner], B));
    if (getAddress(onchain) !== vault) throw httpError(409, "vault_identity", "factory.vaultFor(owner) is not this vault");
    const code = await step(() => pc.getCode({ address: vault, blockNumber: B }));
    if (String(code ?? "").toLowerCase() !== cloneRuntime(A.implementation)) throw httpError(409, "vault_identity", "the vault's code is not a clone of the pinned implementation");
    return { vault, owner };
  }

  async function sessionAt(vault, sid, B) {
    const [s, live] = await step(() => rd(vault, vaultAbi, "sessionOf", [sid], B));
    const [maxGasUsdc6, maxUsdcPerEth6, maxEthWei] = await step(() => rd(vault, vaultAbi, "gasPolicyOf", [sid], B));
    return { s, live: Boolean(live), policy: { maxGasUsdc6: BigInt(maxGasUsdc6), maxUsdcPerEth6: BigInt(maxUsdcPerEth6), maxEthWei: BigInt(maxEthWei) } };
  }

  /** Whose record is it: the vault, the owner's wallet, or the owner's OLD vault proven through the pinned legacy factory.
   *  Records stay where they are; nothing is migrated. */
  async function holderOf(deployment, vault, owner, B) {
    const d = await step(() => rd(A.ledger, ledgerAbi, "get", [deployment], B));
    if (String(d?.id ?? "").toLowerCase() !== deployment) throw httpError(404, "unknown_deployment", `deployment ${deployment} does not exist`);
    const holder = getAddress(d.owner);
    if (holder === vault) return { holder, kind: "vault" };
    if (holder === owner) return { holder, kind: "wallet" };
    const lf = A.legacyFactory;
    const isOld = await step(() => rd(lf, legacyFactoryAbi, "isVault", [holder], B));
    const oldFor = isOld ? getAddress(await step(() => rd(lf, legacyFactoryAbi, "vaultFor", [owner], B))) : null;
    const oldOwner = oldFor === holder ? getAddress(await step(() => rd(holder, legacyVaultAbi, "owner", [], B))) : null;
    if (!isOld || oldFor !== holder || oldOwner !== owner) throw httpError(403, "not_mine", "the record is not held by this vault, its owner, or the owner's original vault");
    return { holder, kind: "legacyVault" };
  }

  async function quoteIn(ethOut, tier, B) {
    let r;
    try {
      r = await rd(A.quoter, quoterV2Abi, "quoteExactOutputSingle",
        [{ tokenIn: A.usdc, tokenOut: A.weth, amount: ethOut, fee: tier, sqrtPriceLimitX96: 0n }], B);
    } catch (e) {
      throw httpError(502, "quote_unavailable", `QuoterV2 gave no exact-output quote at tier ${tier}: ${msg(e)}; no price is offered`);
    }
    const amountIn = BigInt(Array.isArray(r) ? r[0] : r);
    if (amountIn === 0n) throw httpError(502, "quote_unavailable", "QuoterV2 quoted 0; no price is offered");
    return amountIn;
  }

  async function policyCall(name, ctx) {
    try { return await quotePolicy[name](Object.freeze(ctx)); }
    catch (e) { throw httpError(503, "quote_policy_failed", `the host quote policy (${name}) failed: ${msg(e)}`); }
  }

  async function presimulate(to, abi, functionName, args, B) {
    try {
      await pc.simulateContract({ address: to, abi, functionName, args, account: R, blockNumber: B });
    } catch (e) {
      const data = revertData(e);
      let errorName = null;
      if (data) for (const x of [abi, vaultAbi]) { try { errorName = decodeErrorResult({ abi: x, data }).errorName; break; } catch { /* next */ } }
      throw httpError(409, "revert", `the contract refused ${functionName} in simulation at block ${B}${errorName ? ` (${errorName})` : ""}`,
        { revert: data ?? null, errorName });
    }
  }

  const revoked = (sid) => Boolean(store.data.revoked?.[sid]);

  // ---- GET /funding/config ------------------------------------------------------------------------------------------
  async function config() {
    const P = await readPins();
    return { enabled: true, chainId: FUNDING_CHAIN_ID, pinnedBlock: P.block, factory: A.factory, implementation: A.implementation,
      adapter: A.adapter, legacyFactory: A.legacyFactory, quoter: A.quoter, feeTiers: [...M.feeTiers], maxSlippageBps: M.maxSlippageBps,
      adapterMaxEthOut: P.adapterMaxEthOut, relayer: R, notAfter: M.notAfter, action: ACTION_GAS_FUND,
      open: { enabled: openAllowed, why: openWhy },
      note: "additive successor; it does not replace the address book's sessionVaultFactory or any original vault" };
  }

  // ---- POST /funding/quote ------------------------------------------------------------------------------------------
  async function quote(body) {
    exactKeys(body, ["vault", "sid", "deployment", "ethOut", "feeTier"], "quote", ["lane"]);
    const sid = hex32(body.sid, "sid");
    const deployment = hex32(body.deployment, "deployment");
    const ethOut = uint(body.ethOut, 96, "ethOut");
    const tier = Number(uint(body.feeTier, 24, "feeTier"));
    const lane = body.lane === undefined ? 0n : uint(body.lane, 192, "lane");
    if (ethOut === 0n) throw httpError(400, "bad_request", "ethOut must be positive");
    if (!M.feeTiers.includes(tier)) throw httpError(400, "fee_tier_not_pinned", `tier ${tier} is not pinned by the activation manifest`);
    if (revoked(sid)) throw httpError(409, "not_live", "this session has been signed out");
    const P = await readPins();
    const B = P.block;
    const { vault, owner } = await fundingVault(body.vault, P);
    const { s, live, policy } = await sessionAt(vault, sid, B);
    if (!live) throw httpError(409, "not_live", "this session is not live");
    if (((BigInt(s.actions) >> BigInt(ACTION_GAS_FUND)) & 1n) === 0n) throw httpError(403, "not_allowed", "gas.fund is not granted to this session");
    if (policy.maxGasUsdc6 === 0n || policy.maxUsdcPerEth6 === 0n || policy.maxEthWei === 0n) throw httpError(403, "not_allowed", "this session has no gas.fund policy");
    if (ethOut > policy.maxEthWei) throw httpError(409, "quote_exceeds_grant", `ethOut exceeds the grant's maxEthPerOp ${policy.maxEthWei}`);
    if (ethOut > P.adapterMaxEthOut) throw httpError(409, "quote_exceeds_adapter", `ethOut exceeds the adapter's maxEthOut ${P.adapterMaxEthOut}`);
    const { holder, kind } = await holderOf(deployment, vault, owner, B);
    const amountIn6 = await quoteIn(ethOut, tier, B);
    const maxFee6 = BigInt(s.maxFee6);
    const feeRaw = await policyCall("fee", { phase: "quote", chainId: FUNDING_CHAIN_ID, block: B, vault, sid, deployment, ethOut,
      feeTier: tier, amountIn6, maxFee6 });
    let fee6;
    try { fee6 = uint(feeRaw, 128, "quotePolicy.fee"); } catch { throw httpError(503, "quote_policy_failed", "the host quote policy returned no integer fee"); }
    if (fee6 > maxFee6) throw httpError(409, "fee_exceeds_grant", `the relay fee ${fee6} exceeds the grant's maxFeePerOp ${maxFee6}`);
    // bounded slippage over the real quote, then never above the grant's per-op and price caps
    const slipped = (amountIn6 * BigInt(10_000 + M.maxSlippageBps) + 9_999n) / 10_000n;
    const priceCap = (policy.maxUsdcPerEth6 * ethOut) / 10n ** 18n;
    let maxUsdcIn6 = slipped;
    if (maxUsdcIn6 > policy.maxGasUsdc6) maxUsdcIn6 = policy.maxGasUsdc6;
    if (maxUsdcIn6 > priceCap) maxUsdcIn6 = priceCap;
    if (maxUsdcIn6 < amountIn6) throw httpError(409, "quote_exceeds_grant", `the pool needs ${amountIn6}, the grant allows at most ${maxUsdcIn6}`);
    const total = maxUsdcIn6 + fee6;
    if (total > BigInt(s.balance6)) throw httpError(409, "quote_exceeds_balance", `needs ${total}, the session holds ${s.balance6}`);
    const reset = P.timestamp >= BigInt(s.periodStart) + BigInt(s.period);
    const spent = reset ? 0n : BigInt(s.periodSpent6);
    const left = BigInt(s.perPeriod6) > spent ? BigInt(s.perPeriod6) - spent : 0n;
    if (total > left) throw httpError(409, "quote_exceeds_period", `needs ${total}, ${left} left this period`);
    const seq = BigInt(await step(() => rd(vault, vaultAbi, "seqOf", [sid, lane], B)));
    const deadline = P.timestamp + M.deadlineSec;
    const intent = { payer: vault, deployment, expectedOwner: holder, ethOut, maxUsdcIn6, fee: tier, deadline };
    const args = encodeIntent(intent);
    return { chainId: FUNDING_CHAIN_ID, pinnedBlock: B, vault, sid, action: ACTION_GAS_FUND, nonce: (lane << 64n) | seq, args,
      argsHash: keccak256(args), fee: fee6, deadline, intent, holderKind: kind,
      maximum: { maxUsdcIn6, fee6, totalMaximum6: total },
      quote: { quoter: A.quoter, feeTier: tier, amountIn6, block: B, slippageBps: M.maxSlippageBps } };
  }

  // ---- POST /funding/execute ----------------------------------------------------------------------------------------
  async function execute(body) {
    exactKeys(body, ["vault", "sid", "nonce", "action", "args", "fee", "deadline", "x", "y", "r", "s"], "execute");
    const action = Number(uint(body.action, 8, "action"));
    if (action === RETIRED_ACTION) throw httpError(400, "bad_action", "action 9 is retired");
    if (action !== ACTION_GAS_FUND) throw httpError(400, "bad_action", `this route executes action ${ACTION_GAS_FUND} (gas.fund) only`);
    const sid = hex32(body.sid, "sid");
    const vaultIn = address(body.vault, "vault");
    const nonce = uint(body.nonce, 256, "nonce");
    const fee = uint(body.fee, 256, "fee");
    const deadline = uint(body.deadline, 64, "deadline");
    const x = uint(body.x, 256, "x"), y = uint(body.y, 256, "y");
    const r = hex32(body.r, "r"), sv = hex32(body.s, "s");
    const args = hexBytes(body.args, "args", INTENT_BYTES);
    const intent = decodeIntent(args);
    if (intent.payer !== vaultIn) throw httpError(400, "wrong_payer", "intent.payer must be exactly the executing vault");
    if (!M.feeTiers.includes(intent.fee)) throw httpError(400, "fee_tier_not_pinned", `tier ${intent.fee} is not pinned by the activation manifest`);
    if (deadline > intent.deadline) throw httpError(400, "bad_deadline", "the call deadline is after the intent deadline");
    // the host's shared off-chain revocation (sign-out, terminate, revokeAll) is honoured before anything is read or sent
    if (revoked(sid)) throw httpError(409, "not_live", "this session has been signed out");

    const P = await readPins();
    const B = P.block;
    const { vault } = await fundingVault(vaultIn, P);
    if (intent.ethOut > P.adapterMaxEthOut) throw httpError(409, "quote_exceeds_adapter", "intent.ethOut exceeds the adapter's maxEthOut");
    if (deadline < P.timestamp) throw httpError(409, "expired", "the call deadline has passed");
    if (intent.deadline > P.timestamp + MAX_DEADLINE_WINDOW) throw httpError(400, "bad_deadline", "the intent deadline is more than 900s ahead");
    const amountIn6 = await quoteIn(intent.ethOut, intent.fee, B);
    if (amountIn6 > intent.maxUsdcIn6) throw httpError(409, "quote_moved", `the pool now needs ${amountIn6}, above the signed maximum ${intent.maxUsdcIn6}; re-quote`);
    const ok = await policyCall("accept", { phase: "execute", chainId: FUNDING_CHAIN_ID, block: B, vault, sid, intent, fee6: fee, amountIn6 });
    if (ok !== true) throw httpError(402, "policy_refused", "the host quote policy refused this fee/maximum; re-quote");

    const execArgs = [sid, nonce, ACTION_GAS_FUND, args, fee, deadline, x, y, r, sv];
    // the REAL vault decides: live, epoch, expiry, nonce lane, P-256 signature, action bit, fee cap, limits, scope, swap
    await presimulate(vault, vaultAbi, "execute", execArgs, B);
    if (revoked(sid)) throw httpError(409, "not_live", "this session was signed out while it was being checked");
    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: "execute", args: execArgs,
      label: `funding gas.fund ${sid.slice(0, 10)}` });
    const settlement = settle(rc, { vault, sid, nonce, args, fee, intent });
    const list = (store.data.fundingOps[sid] ??= []);
    if (!list.some((o) => o.tx === rc.transactionHash && o.nonce === nonce.toString())) {
      list.push({ nonce: nonce.toString(), action: ACTION_GAS_FUND, amount6: settlement.actual.usdcSpent6.toString(),
        fee6: fee.toString(), maxUsdcIn6: intent.maxUsdcIn6.toString(), refund6: settlement.refund6.toString(),
        ethOut: intent.ethOut.toString(), deployment: intent.deployment, holder: intent.expectedOwner,
        tx: rc.transactionHash, block: Number(rc.blockNumber), vault });
      if (list.length > 200) list.splice(0, list.length - 200);
    }
    store.saveSoon?.();
    return { txHash: rc.transactionHash, block: Number(rc.blockNumber), vault, sid, settlement };
  }

  /** The receipt must have SUCCEEDED and carry exactly one SessionOp (this sid/nonce, action 10) and one GasFunded from
   *  the vault, and one adapter GasFunded, all agreeing. SessionOp.amount6 is the ACTUAL debit (root correction). */
  function settle(rc, { vault, sid, nonce, args, fee, intent }) {
    if (!rc || rc.status !== "success") throw httpError(409, "reverted", `gas.fund did not succeed on chain (${rc?.transactionHash ?? "no receipt"})`);
    const ops = [], funded = [], adapted = [];
    for (const l of Array.isArray(rc.logs) ? rc.logs : []) {
      let a;
      try { a = getAddress(l.address); } catch { continue; }
      if (a !== vault && a !== A.adapter) continue;
      let ev;
      try { ev = decodeEventLog({ abi: a === vault ? vaultAbi : adapterAbi, data: l.data, topics: l.topics, strict: true }); } catch { continue; }
      if (a === vault && ev.eventName === "SessionOp" && ev.args.sid.toLowerCase() === sid && ev.args.nonce === nonce) ops.push(ev.args);
      else if (a === vault && ev.eventName === "GasFunded" && ev.args.sid.toLowerCase() === sid) funded.push(ev.args);
      else if (a === A.adapter && ev.eventName === "GasFunded" && ev.args.deployment.toLowerCase() === intent.deployment) adapted.push(ev.args);
    }
    const bad = (code, m) => { throw httpError(502, code, `${m} (tx ${rc.transactionHash}); the funding index was not updated`); };
    if (ops.length !== 1) bad("settlement_session_op", `expected one SessionOp for this sid/nonce, found ${ops.length}`);
    if (funded.length !== 1) bad("settlement_gas_funded", `expected one vault GasFunded for this sid, found ${funded.length}`);
    if (adapted.length !== 1) bad("settlement_adapter", `expected one adapter GasFunded for this deployment, found ${adapted.length}`);
    const op = ops[0], gf = funded[0], ad = adapted[0];
    if (Number(op.action) !== ACTION_GAS_FUND) bad("settlement_action", "SessionOp is not action 10");
    if (op.argsHash.toLowerCase() !== keccak256(args)) bad("settlement_args", "SessionOp.argsHash differs from the signed args");
    if (op.fee6 !== fee || gf.fee6 !== fee) bad("settlement_fee", "the signed fee, SessionOp.fee6 and GasFunded.fee6 differ");
    if (getAddress(gf.relayer) !== R) bad("settlement_relayer", "GasFunded.relayer is not this relayer");
    if (gf.deployment.toLowerCase() !== intent.deployment || getAddress(gf.holder) !== intent.expectedOwner) bad("settlement_scope", "GasFunded deployment/holder differ from the intent");
    if (gf.ethOut !== intent.ethOut || gf.maxUsdcIn6 !== intent.maxUsdcIn6) bad("settlement_intent", "GasFunded ethOut/maxUsdcIn6 differ from the intent");
    const used = gf.usdcSpent6;
    if (used === 0n || used > intent.maxUsdcIn6) bad("settlement_actual", `actual ${used} is outside 1..${intent.maxUsdcIn6}`);
    if (op.amount6 !== used) bad("settlement_amount", `SessionOp.amount6 ${op.amount6} is not the actual debit ${used}`);
    let resUsed, refund;
    try { [resUsed, refund] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], op.result); } catch { bad("settlement_result", "SessionOp.result is not abi.encode(used, refund)"); }
    if (resUsed !== used || used + refund !== intent.maxUsdcIn6) bad("settlement_result", "SessionOp.result does not reconcile actual + refund = maximum");
    if (getAddress(ad.payer) !== vault || getAddress(ad.owner) !== intent.expectedOwner || Number(ad.fee) !== intent.fee
      || ad.ethOut !== intent.ethOut || ad.usdcSpent6 !== used || ad.maxUsdcIn6 !== intent.maxUsdcIn6) {
      bad("settlement_adapter", "the adapter's GasFunded does not match the vault's");
    }
    return Object.freeze({
      maximum: Object.freeze({ maxUsdcIn6: intent.maxUsdcIn6, fee6: fee, totalMaximum6: intent.maxUsdcIn6 + fee }),
      actual: Object.freeze({ usdcSpent6: used, fee6: fee, totalDebit6: used + fee }),
      refund6: refund, ethOut: intent.ethOut, relayer: R, deployment: intent.deployment, holder: intent.expectedOwner,
    });
  }

  // ---- POST /funding/open (host-gated) ------------------------------------------------------------------------------
  function parseGrant(g) {
    plain(g, "grant");
    const missingGas = GAS_LIMIT_FIELDS.filter((k) => !has(g, k) || g[k] === undefined);
    if (missingGas.length) {
      throw httpError(400, "grant_missing_gas_limits", `grant lacks ${missingGas.join(", ")}: an original grant is never reused or widened`);
    }
    exactKeys(g, GRANT_COMPONENTS.map((c) => c.name), "grant");
    const out = {};
    for (const { name, type } of GRANT_COMPONENTS) {
      const v = g[name];
      if (type === "string") {
        if (typeof v !== "string" || v.length > 200) throw httpError(400, "bad_request", `grant.${name} must be a short string`);
        out[name] = v;
      } else if (type === "string[]") {
        if (!Array.isArray(v) || v.length > 32 || v.some((s) => typeof s !== "string" || s.length > 200)) throw httpError(400, "bad_request", `grant.${name} must be a string list`);
        out[name] = [...v];
      } else if (type === "bytes32") out[name] = hex32(v, `grant.${name}`);
      else if (/^uint\d+$/.test(type)) out[name] = uint(v, Number(type.slice(4)), `grant.${name}`);
      else throw httpError(500, "relay", `unhandled Grant field type ${type}`);
    }
    return out;
  }

  async function open(body, ctx) {
    if (!openAllowed) throw httpError(503, "funding_open_disabled", openWhy);
    exactKeys(body, ["owner", "grant", "ownerSig"], "open", ["deposit"]);
    const owner = address(body.owner, "owner");
    if (ctx?.screenAddress?.(owner)?.result === "hit") throw httpError(451, "refused", "this address cannot be served");
    const g = parseGrant(body.grant);
    const sig = hexBytes(body.ownerSig, "ownerSig", 2048);
    const P = await readPins();
    const B = P.block;
    const vault = predictVault(A.factory, A.implementation, owner);
    if (getAddress(await step(() => rd(A.factory, factoryAbi, "vaultFor", [owner], B))) !== vault) throw httpError(409, "vault_identity", "factory.vaultFor(owner) differs from the CREATE2 prediction");
    const code = await step(() => pc.getCode({ address: vault, blockNumber: B }));
    if (code && code !== "0x") {
      if (String(code).toLowerCase() !== cloneRuntime(A.implementation)) throw httpError(409, "vault_identity", "the predicted vault holds foreign code");
      if (!(await step(() => rd(A.factory, factoryAbi, "isVault", [vault], B)))) throw httpError(409, "vault_identity", "the predicted vault is not registered by the factory");
      if (getAddress(await step(() => rd(vault, vaultAbi, "owner", [], B))) !== owner) throw httpError(409, "vault_identity", "the predicted vault has another owner");
    }
    let fn, args;
    if (g.budget > 0n) {
      const d = body.deposit;
      exactKeys(d, ["validAfter", "validBefore", "sig"], "deposit");
      fn = "openWithDepositFor";
      args = [owner, g, sig, uint(d.validAfter, 256, "deposit.validAfter"), uint(d.validBefore, 256, "deposit.validBefore"), hexBytes(d.sig, "deposit.sig", 2048)];
    } else {
      if (body.deposit !== undefined) throw httpError(400, "bad_request", "a zero-budget grant takes no deposit");
      fn = "openFor";
      args = [owner, g, sig];
    }
    // the real factory + vault + USDC check the owner signature and the EIP-3009 authorization
    await presimulate(A.factory, factoryAbi, fn, args, B);
    const rc = await simulateAndSend({ to: A.factory, abi: factoryAbi, functionName: fn, args, label: `funding ${fn} ${owner.slice(0, 8)}` });
    if (!rc || rc.status !== "success") throw httpError(409, "reverted", `${fn} did not succeed on chain (${rc?.transactionHash ?? "no receipt"})`);
    const sid = sessionIdOf(vault, g.sessionKey, g.grantNonce);
    const opened = (rc.logs ?? []).filter((l) => {
      try { return getAddress(l.address) === vault && (() => { const ev = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics, strict: true });
        return ev.eventName === "SessionOpened" && ev.args.sid.toLowerCase() === sid; })(); } catch { return false; }
    });
    if (opened.length !== 1) throw httpError(502, "settlement_open", `expected one SessionOpened for ${sid} (tx ${rc.transactionHash})`);
    store.data.fundingVaults[vault] = owner;
    store.saveSoon?.();
    return { txHash: rc.transactionHash, block: Number(rc.blockNumber), vault, sid };
  }

  async function route(method, path, body, ctx) {
    if (!M) throw httpError(503, "funding_disabled", why);
    if (method === "GET" && path === "/funding/config") return config();
    if (method === "POST" && path === "/funding/quote") return quote(body);
    if (method === "POST" && path === "/funding/execute") return execute(body);
    if (method === "POST" && path === "/funding/open") return open(body, ctx);
    throw httpError(404, "not_found", "no such funding endpoint");
  }

  return Object.freeze({ route, enabled: Boolean(M), why, openEnabled: Boolean(M) && openAllowed });
}
