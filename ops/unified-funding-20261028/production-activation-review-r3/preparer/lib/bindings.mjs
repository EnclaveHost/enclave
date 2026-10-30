// production-activation-prep-r1: the ONE list of public chain reads and binding checks behind the production
// owner-controls / intake / fee manifests. UNREVIEWED, NOT RUN by its author.
//
// Shared by capture-observation.mjs (root runs it: live, read-only, every provider at ONE pinned block hash) and
// prepare-activation.mjs (offline: replays the captured reads, requiring every provider to report the identical value).
// The binding checks mirror the relay's own readPins / readOwnerPins (activation-r1 generated funding-route.mjs) and
// the fee policy's pinned identities; nothing here signs, sends or reads a key, env value or private file.
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, parseAbi }
  from "../../activation-r1/generated/node_modules/viem/_esm/index.js";

export const CHAIN_ID = 8453;
export const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BOOK_DEPLOYMENTS = `0x${Buffer.from("deployments").toString("hex").padEnd(64, "0")}`;
export const ABI = parseAbi([
  "function implementation() view returns (address)", "function factory() view returns (address)",
  "function usdc() view returns (address)", "function book() view returns (address)", "function gasAdapter() view returns (address)",
  "function legacyFactory() view returns (address)", "function weth() view returns (address)", "function swapRouter() view returns (address)",
  "function ledger() view returns (address)", "function reserve() view returns (address)", "function maxEthOut() view returns (uint256)",
  "function poolFor(uint24 fee) view returns (address)", "function addr(bytes32 key) view returns (address)",
  "function WETH9() view returns (address)", "function aggregator() view returns (address)", "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);
export class BindingRefused extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "BindingRefused"; this.code = code; }
}
export const refuse = (code, message) => { throw new BindingRefused(code, message); };
export const lower = (a) => String(a ?? "").toLowerCase();
export const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);
export const checksum = (a) => getAddress(lower(a));
export const codehashOf = (code) => keccak256(code);

/** Canonical observation keys (also the capture file's record names). */
export const K = Object.freeze({
  code: (a) => `code|${lower(a)}`,
  call: (a, fn, args = []) => `call|${lower(a)}|${fn}|${JSON.stringify(args.map(String))}`,
  storage: (a, slot) => `storage|${lower(a)}|${lower(slot)}`,
  nonce: (a, tag) => `nonce|${lower(a)}|${tag}`,
  balance: (a) => `balance|${lower(a)}`,
});
/** eth_call data + normalized result for one getter (address lowercase, uint decimal, string as is). */
export const callData = (fn, args = []) => encodeFunctionData({ abi: ABI, functionName: fn, args: args.map((v) => (fn === "poolFor" ? Number(v) : v)) });
export function normalizeCall(fn, data) {
  const v = decodeFunctionResult({ abi: ABI, functionName: fn, data });
  if (typeof v === "bigint" || typeof v === "number") return BigInt(v).toString();
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase();
  if (typeof v === "string") return v;
  return refuse("call_result", `${fn} returned an unexpected shape`);
}

/** Walk every required read through `r` (code(a), call(a, fn, args), storage(a, slot), nonce(a, tag), balance(a): each
 *  async, returning the normalized string) and check every binding. Returns the facts the manifests are built from.
 *  ctx = { receipts, original: {usdc, book, legacyFactory, relayer}, adapterArgs: [usdc, weth, swapRouter, dexFactory,
 *  ledger, reserve, maxEthOut], decisions }. Throws BindingRefused on the first gap or mismatch. */
export async function collectBindings(r, ctx) {
  const { receipts, original, adapterArgs, decisions: D } = ctx;
  const codes = {};
  const code = async (label, a, wantHash) => {
    if (!isAddr(a)) refuse("address_missing", `${label} has no address`);
    const c = lower(await r.code(a));
    if (!/^0x([0-9a-f]{2})+$/.test(c)) refuse("missing_code", `${label} ${a} has no code at the observed block`);
    const h = codehashOf(c);
    if (wantHash && h !== lower(wantHash)) refuse("codehash_mismatch", `${label} ${a} runtime code hash ${h} is not ${wantHash}`);
    codes[lower(a)] = { codehash: h, bytes: (c.length - 2) / 2 };
    return c;
  };
  const getter = async (label, a, fn, args = []) => {
    const v = await r.call(a, fn, args);
    if (typeof v !== "string" || v.length === 0) refuse("read_missing", `${label} (${a}.${fn}) was not observed`);
    return v;
  };
  const same = (label, got, want) => { if (lower(got) !== lower(want)) refuse("identity_mismatch", `${label} is ${got}, expected ${want}`); };

  // ---- the four DEPLOYED successor contracts: confirmed receipts only (never a predicted address) -------------------
  const S = {};
  for (const name of ["FundingSessionVaultLib", "FundingGasLib", "LeaseGasDexAdapter", "FundingSessionVaultFactory"]) {
    const c = receipts.byName[name];
    await code(name, c.address, c.runtimeCodehash);
    S[name] = lower(c.address);
  }
  // ---- the implementation: READ from the deployed factory, then checked against the reviewed expectation ----------
  const impl = await getter("factory.implementation()", S.FundingSessionVaultFactory, "implementation");
  same("factory.implementation()", impl, D.expected.implementation);
  const implCode = await code("implementation", impl, D.expected.implementationCodehash);
  for (const lib of ["FundingGasLib", "FundingSessionVaultLib"]) {
    if (!implCode.includes(S[lib].slice(2))) refuse("library_unlinked", `the implementation does not link ${lib} ${S[lib]}`);
  }
  same("implementation.factory()", await getter("implementation.factory()", impl, "factory"), S.FundingSessionVaultFactory);
  same("implementation.gasAdapter()", await getter("implementation.gasAdapter()", impl, "gasAdapter"), S.LeaseGasDexAdapter);
  // the ORIGINAL USDC / address book / factory remain the ones the successor binds to
  same("implementation.usdc()", await getter("implementation.usdc()", impl, "usdc"), original.usdc);
  same("implementation.book()", await getter("implementation.book()", impl, "book"), original.book);
  same("implementation.legacyFactory()", await getter("implementation.legacyFactory()", impl, "legacyFactory"), original.legacyFactory);
  const facts = { successor: S, implementation: lower(impl), codes };

  // ---- relayer: the one production relay account, an EOA, no observed pending nonce at capture (NOT in-memory queue quiescence) -------------------------------
  same("relayer", D.relayer, original.relayer);
  const rcode = lower(await r.code(D.relayer));
  if (rcode !== "0x") refuse("relayer_not_eoa", `the relayer ${D.relayer} has code`);
  const nl = await r.nonce(D.relayer, "latest"), np = await r.nonce(D.relayer, "pending");
  if (!/^\d+$/.test(String(nl)) || String(nl) !== String(np)) refuse("pending_nonce_observed", `relayer nonce latest ${nl} != pending ${np} at capture`);
  const bal = await r.balance(D.relayer);
  if (!/^\d+$/.test(String(bal))) refuse("read_missing", "relayer balance was not observed");
  facts.relayer = { address: lower(D.relayer), nonce: String(nl), balanceWei: String(bal) };

  if (D.intake === null) return facts;

  // ---- intake: adapter immutables (equal to the reviewed constructor arguments), DEX, ledger, reserve, pools -------
  const A = S.LeaseGasDexAdapter;
  const adapter = {};
  for (const fn of ["usdc", "weth", "swapRouter", "factory", "ledger", "reserve"]) adapter[fn] = await getter(`adapter.${fn}()`, A, fn);
  adapter.maxEthOut = await getter("adapter.maxEthOut()", A, "maxEthOut");
  const want = { usdc: adapterArgs[0], weth: adapterArgs[1], swapRouter: adapterArgs[2], factory: adapterArgs[3], ledger: adapterArgs[4], reserve: adapterArgs[5] };
  for (const [k, v] of Object.entries(want)) same(`adapter.${k}() vs the reviewed constructor argument`, adapter[k], v);
  if (BigInt(adapter.maxEthOut) !== BigInt(adapterArgs[6]) || BigInt(adapter.maxEthOut) === 0n) refuse("identity_mismatch", "adapter.maxEthOut() differs from the reviewed constructor argument");
  same("adapter.usdc()", adapter.usdc, original.usdc);
  same("book.addr(\"deployments\")", await getter("book.addr(deployments)", original.book, "addr", [BOOK_DEPLOYMENTS]), adapter.ledger);
  same("reserve.ledger()", await getter("reserve.ledger()", adapter.reserve, "ledger"), adapter.ledger);
  const legacyImplementation = await getter("legacyFactory.implementation()", original.legacyFactory, "implementation");
  const quoter = D.intake.quoter;
  same("quoter.factory()", await getter("quoter.factory()", quoter, "factory"), adapter.factory);
  same("quoter.WETH9()", await getter("quoter.WETH9()", quoter, "WETH9"), adapter.weth);
  const pins = { factory: S.FundingSessionVaultFactory, implementation: lower(impl), fundingGasLib: S.FundingGasLib,
    fundingSessionVaultLib: S.FundingSessionVaultLib, adapter: A, legacyFactory: lower(original.legacyFactory), legacyImplementation,
    usdc: lower(original.usdc), weth: adapter.weth, book: lower(original.book), ledger: adapter.ledger, reserve: adapter.reserve,
    swapRouter: adapter.swapRouter, dexFactory: adapter.factory, quoter: lower(quoter) };
  for (const [k, a] of Object.entries(pins)) if (!codes[lower(a)]) await code(k, a);
  const pools = {};
  for (const tier of D.intake.feeTiers) {
    const p = await getter(`adapter.poolFor(${tier})`, A, "poolFor", [tier]);
    if (!isAddr(p)) refuse("pool_missing", `adapter.poolFor(${tier}) is the zero address`);
    await code(`pool(${tier})`, p);
    pools[tier] = lower(p);
  }
  facts.intake = { pins, pools, adapterMaxEthOut: adapter.maxEthOut };

  // ---- fee policy: GasPriceOracle proxy + EIP-1967 implementation, Chainlink feed proxy + aggregator (+ sequencer) ---
  const F = D.feePolicy;
  await code("oracle", F.oracle);
  const slot = lower(await r.storage(F.oracle, EIP1967_IMPL_SLOT));
  if (!/^0x[0-9a-f]{64}$/.test(slot)) refuse("read_missing", "the oracle implementation slot was not observed");
  const oracleImpl = `0x${slot.slice(26)}`;
  if (!isAddr(oracleImpl)) refuse("identity_mismatch", "the oracle implementation slot is empty");
  await code("oracle implementation", oracleImpl);
  await code("feed", F.feed.address);
  const aggregator = await getter("feed.aggregator()", F.feed.address, "aggregator");
  await code("feed aggregator", aggregator);
  const decimals = await getter("feed.decimals()", F.feed.address, "decimals");
  const description = await getter("feed.description()", F.feed.address, "description");
  if (String(decimals) !== String(F.feed.decimals)) refuse("feed_mismatch", `feed.decimals() is ${decimals}, the decision says ${F.feed.decimals}`);
  if (description !== F.feed.description) refuse("feed_mismatch", `feed.description() is ${JSON.stringify(description)}, the decision says ${JSON.stringify(F.feed.description)}`);
  let sequencer = null;
  if (F.sequencer !== null) {
    await code("sequencer feed", F.sequencer.address);
    const sa = await getter("sequencer.aggregator()", F.sequencer.address, "aggregator");
    await code("sequencer aggregator", sa);
    sequencer = { address: lower(F.sequencer.address), aggregator: lower(sa) };
  }
  facts.fee = { oracle: lower(F.oracle), oracleImplementation: oracleImpl, feed: lower(F.feed.address), aggregator: lower(aggregator), sequencer };
  return facts;
}
