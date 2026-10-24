// ONE administrator transaction, read-only here: prepare the exact UNSIGNED
//   EnclaveAddressBook(0xab21…).set("sessionVaultFactory", 0x1f5c…)   (from the book owner 0x0b2d…, value 0)
// and verify what the wallet later returned. Nothing here signs, broadcasts, funds or delegates anything.
// Every preparation reads, at one anchor block both providers agree on (head - 2), with byte-identical answers:
//   - chain id; the runtime hashes of the book, factory, implementation and both custody vaults (the ledger's is read, not pinned);
//   - book.owner() = administrator (the deployed book has a single-step owner and NO pendingOwner getter; its ABI is
//     selected only by its exact code hash), book.addr(sessionVaultFactory) = 0 (= factory: nothing to
//     sign), book.addr(deployments) = the reviewed ledger, factory.implementation() = the reviewed implementation;
//   - the administrator's nonce at the anchor and pending (equal);
//   - the EXHAUSTIVE impact over every id of the current ledger (custody-factory-consumer-review effectOf, verbatim):
//     each id's owner before (ledger owner) and after (isVault(owner) at this factory ? owner() : owner), and its v1 and
//     v2 policy. Anything but "unchanged" and the reviewed vault-held deployments' "no_policy_first_writer_changes"
//     refuses (no new stranding, no other changed authority) - re-review first;
// then simulates and estimates the exact call on both providers, and checks fees, the L1 fee and the balance.
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, keccak256, parseAbi, serializeTransaction, stringToHex, encodeDeployData } from "viem";
// viem's own Multicall3 and deployless-call bytecode (lockfile-pinned viem 2.53.1; the file has no imports). Their keccak
// hashes are pinned below, so a changed package refuses instead of running other code.
import { multicall3Bytecode, deploylessCallViaBytecodeBytecode } from "./node_modules/viem/_esm/constants/contracts.js";
import { pair } from "./rpc.mjs";

const ZERO = "0x" + "0".repeat(40);
const lc = (a) => String(a ?? "").toLowerCase();
const eq = (a, b, what) => { if (lc(a) !== lc(b)) throw Error(`${what} (found ${a}, expected ${b})`); };
const hex = (n) => "0x" + BigInt(n).toString(16);
const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0n);
const stable = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v));
export const keyOf = (k) => stringToHex(k, { size: 32 });

// The DEPLOYED original book's ABI (evidence/book-legacy: source at Projects/enclave 6c1135b0f, reproduced byte for byte
// to the deployed runtime keccak 0xe4f570e9…). Single-step owner; there is no pendingOwner() and no pending-owner state.
export const BOOK_ABI = parseAbi(["function owner() view returns (address)", "function addr(bytes32) view returns (address)",
  "function set(bytes32 key, address value)", "function setMany(bytes32[] keys_, address[] values)", "function all() view returns (bytes32[] keys_, address[] values)",
  "function count() view returns (uint256)", "function setOwner(address newOwner)", "event AddressSet(bytes32 indexed key, address value)", "event OwnerChanged(address owner)"]);
/** Book ABIs by EXACT runtime code hash; no other code is read through any book ABI. */
export const BOOK_ABIS = Object.freeze({
  "0xe4f570e99f2ac708b35539fe5906889d8cb99189e6c9075f5e46d3b6921ac152": Object.freeze({ abi: BOOK_ABI, ownership: "single-step (setOwner); no pendingOwner getter",
    source: "EnclaveAddressBook.sol @ Projects/enclave 6c1135b0f, solc 0.8.35 runs 200 (evidence/book-legacy)" }),
});
export function bookAbiFor(codeHash) {
  const b = BOOK_ABIS[lc(codeHash)];
  if (!b) throw Error(`no reviewed ABI for the address book's code ${codeHash}; stop and review`);
  return b;
}
export const FACTORY_ABI = parseAbi(["function implementation() view returns (address)", "function isVault(address) view returns (bool)"]);
export const SV_ABI = parseAbi(["function owner() view returns (address)"]);
export const VAULT_ABI = parseAbi(["function beneficialOwnerOf(bytes32) view returns (address)",
  "function policyOf(bytes32) view returns (address owner, uint64 policyRev, uint64 secretRev, bytes32 committeeId, bool paused, bytes rules)"]);
export const LEDGER_ABI = parseAbi(["function count() view returns (uint256)", "function idAt(uint256) view returns (bytes32)"]);
// Base GasPriceOracle predeploy (Fjord+), assumptions explicit: getL1FeeUpperBound(_unsignedTxSize) treats its argument
// as an UNSIGNED size, adds ORACLE_SIGNATURE_ALLOWANCE (68) bytes for the signature and applies the worst-case fastlz
// bound. It returns only the L1 data fee: any OP-stack operator fee (Isthmus) is NOT included and NOT bounded here.
// A chain without this function reverts the read, which refuses the preparation.
export const ORACLE_ABI = parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]);
export const ORACLE_SIGNATURE_ALLOWANCE = 68;
export const MC_ABI = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
const DEPLOYLESS = parseAbi(["constructor(bytes, bytes)"]);
export const READER_CODE = Object.freeze({ multicall3: "0x0388a0d41a63e5bbe5b1005f52975ef622c77817a483f36849c5447365555071",
  deployless: "0x22296fa8f815086ccadc3cb4a9fb337da50380b8231699362f2c541dc63d0249" });
if (keccak256(multicall3Bytecode) !== READER_CODE.multicall3 || keccak256(deploylessCallViaBytecodeBytecode) !== READER_CODE.deployless)
  throw Error("the batched-read bytecode in node_modules is not the reviewed viem 2.53.1 code; reinstall from the lockfile");

export const PURPOSE = "Set the original address book's sessionVaultFactory entry to the original SessionVault factory";

/** The only target, calldata and value this handoff can ever request. */
export function frozen(trust) {
  return { from: trust.admin, to: trust.book, chainId: hex(trust.chainId), value: "0x0",
    data: encodeFunctionData({ abi: BOOK_ABI, functionName: "set", args: [keyOf(trust.key), trust.factory] }) };
}
/** A journaled request must still name exactly the frozen sender, target, calldata, value and chain. */
export function checkFrozen(request, trust) {
  const f = frozen(trust), t = request?.transaction;
  if (!t) throw Error("no transaction in the request");
  eq(t.from, f.from, "the request's sender is not the administrator"); eq(t.to, f.to, "the request's destination changed");
  eq(t.data, f.data, "the request's calldata changed"); eq(t.chainId, f.chainId, "the request's chain changed");
  if (BigInt(t.value) !== 0n) throw Error("the request's value changed");
}

// ---- reads ----
const tagOf = (n) => hex(n);
/** One eth_call; a failure names the method, the contract and the provider (never ignored, never read as a default). */
const read = async (c, address, abi, functionName, args, tag) => {
  try { return decodeFunctionResult({ abi, functionName, data: await c.request("eth_call", [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, tag]) }); }
  catch (e) { throw Error(`${functionName}() on ${address} failed on ${c.host}: ${String(e.shortMessage || e.message).slice(0, 200)}`); }
};
const codeHash = (code) => (code && code !== "0x" ? keccak256(code) : null);

/**
 * Batched reads WITHOUT trusting any on-chain helper: viem's Multicall3 bytecode (from the lockfile-pinned package) runs
 * "deployless" inside eth_call (deploylessCallViaBytecode), so only the read contracts' own code answers.
 */
async function batchOn(c, tag, calls) {
  const inner = encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3", args: [calls.map((x) => ({ target: x.address, allowFailure: true,
    callData: encodeFunctionData({ abi: x.abi, functionName: x.functionName, args: x.args || [] }) }))] });
  const data = encodeDeployData({ abi: DEPLOYLESS, bytecode: deploylessCallViaBytecodeBytecode, args: [multicall3Bytecode, inner] });
  return c.request("eth_call", [{ data }, tag]);
}
/** The same batch on both providers; byte-identical answers, decoded per call ({ ok, value }). */
async function agreedBatch(clients, tag, calls, size) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const part = calls.slice(i, i + size);
    const raws = await Promise.all(clients.map((c) => batchOn(c, tag, part)));
    if (lc(raws[0]) !== lc(raws[1])) throw Error("the two providers disagree on a batched read; check again shortly");
    const res = decodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", data: raws[0] });
    if (res.length !== part.length) throw Error("a batched read returned the wrong number of results");
    res.forEach((r, j) => {
      if (!r.success) return out.push({ ok: false });
      try { out.push({ ok: true, value: decodeFunctionResult({ abi: part[j].abi, functionName: part[j].functionName, data: r.returnData }) }); }
      catch { out.push({ ok: false }); }
    });
  }
  return out;
}

/** The newest block both providers have, minus the confirmation depth, with the same hash on both. */
export async function anchorOf(clients, trust) {
  const heads = await Promise.all(clients.map(async (c) => BigInt(await c.request("eth_blockNumber"))));
  const number = heads.reduce((a, b) => (a < b ? a : b)) - trust.confirmations;
  const blocks = await Promise.all(clients.map((c) => c.request("eth_getBlockByNumber", [tagOf(number), false])));
  if (blocks.some((b) => !b?.hash || lc(b.hash) !== lc(blocks[0].hash))) throw Error(`the providers disagree on block ${number}; check again shortly`);
  return { number, tag: tagOf(number), hash: lc(blocks[0].hash), baseFee: BigInt(blocks[0].baseFeePerGas ?? 0) };
}
async function sameAnchor(clients, anchor) {
  for (const c of clients) eq((await c.request("eth_getBlockByNumber", [anchor.tag, false]))?.hash, anchor.hash, `block ${anchor.number} changed during the check (reorg); check again`);
}

// phase 1: chain id and every contract's code (nothing is CALLED before its code is the reviewed code)
async function readCode(c, trust, tag) {
  const [chainId, bookCode, facCode, implCode, v1Code, v2Code, ledCode] = await Promise.all([
    c.request("eth_chainId"), c.request("eth_getCode", [trust.book, tag]), c.request("eth_getCode", [trust.factory, tag]), c.request("eth_getCode", [trust.implementation, tag]),
    c.request("eth_getCode", [trust.vaults.v1, tag]), c.request("eth_getCode", [trust.vaults.v2, tag]), c.request("eth_getCode", [trust.ledger, tag])]);
  return { chainId: Number(BigInt(chainId)), codeHashes: { book: codeHash(bookCode), factory: codeHash(facCode), implementation: codeHash(implCode), v1: codeHash(v1Code), v2: codeHash(v2Code) },
    ledgerCodeHash: codeHash(ledCode) };
}
// phase 2: the state
async function readView(c, trust, tag, bookAbi) {
  const k = keyOf(trust.key);
  const [owner, current, deployments, implementation, bal, nonce, pending] = await Promise.all([
    read(c, trust.book, bookAbi, "owner", [], tag), read(c, trust.book, bookAbi, "addr", [k], tag),
    read(c, trust.book, bookAbi, "addr", [keyOf("deployments")], tag), read(c, trust.factory, FACTORY_ABI, "implementation", [], tag),
    c.request("eth_getBalance", [trust.admin, tag]), c.request("eth_getTransactionCount", [trust.admin, tag]), c.request("eth_getTransactionCount", [trust.admin, "pending"])]);
  return {
    book: { owner: lc(owner), [trust.key]: lc(current), deployments: lc(deployments) }, implementation: lc(implementation),
    admin: { balance: String(BigInt(bal)), nonce: Number(BigInt(nonce)), pending: Number(BigInt(pending)) },
  };
}

/** Both providers' identical view at one anchor, and every pinned fact as expected. */
export async function observe(clients, trust) {
  pair(clients);
  const anchor = await anchorOf(clients, trust);
  const codes = await Promise.all(clients.map((c) => readCode(c, trust, anchor.tag)));
  if (stable(codes[0]) !== stable(codes[1])) throw Error(`the two providers disagree on chain state at block ${anchor.number}; check again shortly`);
  if (codes[0].chainId !== trust.chainId) throw Error(`wrong chain ${codes[0].chainId}`);
  for (const [k, want] of Object.entries(trust.codeHashes)) if (codes[0].codeHashes[k] !== want) throw Error(`the ${k} contract's code is not the reviewed code`);
  if (!codes[0].ledgerCodeHash) throw Error("the ledger has no code");
  const book = bookAbiFor(codes[0].codeHashes.book);   // selected only by the exact (pinned) code hash
  const views = await Promise.all(clients.map((c) => readView(c, trust, anchor.tag, book.abi)));
  if (stable(views[0]) !== stable(views[1])) throw Error(`the two providers disagree on chain state at block ${anchor.number}; check again shortly`);
  const v = { ...codes[0], ...views[0], bookOwnership: book.ownership };
  eq(v.book.owner, trust.admin, "the address book's owner is not the administrator");
  eq(v.book.deployments, trust.ledger, "the book names another deployments ledger than the reviewed one");
  eq(v.implementation, trust.implementation, "the factory's implementation is not the reviewed one");
  if (v.admin.pending !== v.admin.nonce) throw Error("an administrator transaction is pending or was mined in the last two blocks; wait for it to settle and check again");
  return { anchor, ...v };
}

// ---- the exhaustive impact (verbatim from custody-factory-consumer-review-20261023 lib/review.mjs @519489c) ----
/**
 * The exact effect of the factory entry on one id in one vault (EnclaveSecretVault[V2] beneficialOwnerOf/_ownerFor/_apply/_claim):
 *   before = the ledger owner (the factory entry is zero), after = isVault(ledger owner) ? that vault's owner() : the ledger owner.
 */
export function effectOf({ before, after, policy }) {
  const b = lc(before), a = lc(after);
  if (!policy || BigInt(policy.policyRev) === 0n) return b === a ? "unchanged" : "no_policy_first_writer_changes";
  const o = lc(policy.owner);
  if (b === a) return "unchanged";
  if (o === b) return "STRANDED";                 // updates now revert NotOwner; only claimPolicy by `after`, which destroys the bundle
  if (o === a) return "restored";                 // a policy already detached from its ledger owner becomes updatable again
  return "claimant_changes";                      // already claimable; the claimant becomes `after` instead of `before`
}

/** Every id of the current ledger at the anchor; refuses any effect beyond the reviewed one. Requires the entry to be 0. */
export async function impactOf(clients, trust, anchor) {
  const B = trust.caps.batch, tag = anchor.tag;
  const [cnt] = await agreedBatch(clients, tag, [{ address: trust.ledger, abi: LEDGER_ABI, functionName: "count" }], B);
  if (!cnt.ok) throw Error("the ledger did not answer count()");
  const n = Number(cnt.value);
  if (!(n >= 0 && n <= trust.caps.maxLedgerIds)) throw Error(`the ledger holds ${n} deployments, more than this check reads (${trust.caps.maxLedgerIds}); review`);
  const idRes = await agreedBatch(clients, tag, Array.from({ length: n }, (_, i) => ({ address: trust.ledger, abi: LEDGER_ABI, functionName: "idAt", args: [BigInt(i)] })), B);
  const ids = idRes.map((r) => { if (!r.ok) throw Error("the ledger did not answer idAt()"); return lc(r.value); });
  if (new Set(ids).size !== ids.length) throw Error("the ledger enumeration repeats an id");
  const ownRes = await agreedBatch(clients, tag, ids.map((id) => ({ address: trust.vaults.v2, abi: VAULT_ABI, functionName: "beneficialOwnerOf", args: [id] })), B);
  const owners = ownRes.map((r) => { if (!r.ok) throw Error("beneficialOwnerOf failed"); return lc(r.value); });
  const distinct = [...new Set(owners)];
  const info = await agreedBatch(clients, tag, distinct.flatMap((o) => [{ address: trust.factory, abi: FACTORY_ABI, functionName: "isVault", args: [o] },
    { address: o, abi: SV_ABI, functionName: "owner" }]), B);
  const byOwner = new Map(distinct.map((o, i) => {
    if (!info[2 * i].ok) throw Error("isVault failed");
    return [o, { isVault: info[2 * i].value === true, vaultOwner: info[2 * i + 1].ok ? lc(info[2 * i + 1].value) : null }];
  }));
  const pol = await agreedBatch(clients, tag, ids.flatMap((id) => [{ address: trust.vaults.v1, abi: VAULT_ABI, functionName: "policyOf", args: [id] },
    { address: trust.vaults.v2, abi: VAULT_ABI, functionName: "policyOf", args: [id] }]), B);
  const rows = ids.map((id, i) => {
    const before = owners[i], o = byOwner.get(before);
    if (o.isVault && (!o.vaultOwner || o.vaultOwner === ZERO)) throw Error(`a vault of the factory (${before}) has no owner()`);
    const after = o.isVault ? o.vaultOwner : before;
    const p = [pol[2 * i], pol[2 * i + 1]].map((r) => { if (!r.ok) throw Error("policyOf failed"); return { owner: lc(r.value[0]), policyRev: r.value[1].toString() }; });
    return { id, before, after, v1: { ...p[0], effect: effectOf({ before, after, policy: p[0] }) }, v2: { ...p[1], effect: effectOf({ before, after, policy: p[1] }) } };
  });
  const changed = rows.filter((r) => r.v1.effect !== "unchanged" || r.v2.effect !== "unchanged");
  for (const r of changed) for (const [v, e] of [["v1", r.v1.effect], ["v2", r.v2.effect]]) {
    if (e === "STRANDED") throw Error(`REFUSED: deployment ${r.id} has a ${v} policy pinned to SessionVault ${r.before}; this activation would strand it (updates revert; only claimPolicy, which destroys its bundle). Review before any activation.`);
    if (e !== "unchanged" && e !== "no_policy_first_writer_changes") throw Error(`REFUSED: deployment ${r.id} (${v}) would change authority (${e}); review before any activation`);
  }
  const reviewed = new Set(trust.reviewedVaultHeld.map(lc));
  for (const r of changed) {
    if (!reviewed.has(r.id)) throw Error(`REFUSED: deployment ${r.id} is now held by a vault of this factory but was not in the reviewed set; review before any activation`);
    eq(r.before, trust.sessionVault, `deployment ${r.id} is held by another vault than the reviewed one`);
    eq(r.after, trust.admin, `deployment ${r.id} would resolve to another wallet than the administrator`);
  }
  if (changed.length !== reviewed.size) throw Error(`REFUSED: ${changed.length} deployments change resolution, the review covered ${reviewed.size}; review before any activation`);
  return { ledgerIds: n, distinctOwners: distinct.length,
    resolvedToAdministrator: changed.map((r) => ({ id: r.id, sessionVault: r.before, ownerAfter: r.after })),
    existingPolicies: rows.flatMap((r) => [["v1", r.v1], ["v2", r.v2]].filter(([, p]) => p.policyRev !== "0").map(([v, p]) => ({ vault: v, id: r.id, owner: p.owner, policyRev: p.policyRev, effect: p.effect }))),
    stranded: 0 };
}

// ---- fees ----
async function onBoth(clients, what, fn) {
  return Promise.all(clients.map(async (c) => { try { return await fn(c); } catch (e) { throw Error(`${what} failed on ${c.host}: ${e.message}`); } }));
}
async function feesOf(clients, trust, anchor) {
  const tip = max((await Promise.all(clients.map((c) => c.request("eth_maxPriorityFeePerGas")))).map((x) => BigInt(x)));
  const maxFeePerGas = anchor.baseFee * 2n + tip;
  if (!(maxFeePerGas > 0n && maxFeePerGas <= trust.caps.maxFeePerGas)) throw Error(`network fee ${maxFeePerGas} wei/gas is above the reviewed cap ${trust.caps.maxFeePerGas}; wait and check again`);
  return { tip, maxFeePerGas };
}
/**
 * The encoded sizes of the exact request: unsigned, and the MAXIMUM signed size (yParity 1, r = s = 2^256-1; no access
 * list, which verification refuses). Any transaction verification accepts has the same nonce, gas, target, calldata and
 * value and fee caps no higher, so it is never larger. `argument` is the size passed to getL1FeeUpperBound: the smallest
 * value whose oracle-side size (argument + 68) still covers the maximum signed size.
 */
export function txSizes(trust, { nonce, to, data, gas, fees }) {
  const tx = { type: "eip1559", chainId: trust.chainId, nonce, to, data, value: 0n, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.tip };
  const unsigned = (serializeTransaction(tx).length - 2) / 2;
  const signedMax = (serializeTransaction(tx, { r: "0x" + "ff".repeat(32), s: "0x" + "ff".repeat(32), yParity: 1 }).length - 2) / 2;
  return { unsigned, signedMax, argument: Math.max(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE) };
}
/** Refuses a size argument whose oracle-side size would undercount the signed transaction (e.g. unsigned-only accounting). */
export function assertCoversSigned({ argument, signedMax }) {
  if (!(Number.isSafeInteger(argument) && argument + ORACLE_SIGNATURE_ALLOWANCE >= signedMax))
    throw Error(`the L1 fee size ${argument} (+${ORACLE_SIGNATURE_ALLOWANCE} signature bytes) undercounts the signed transaction (${signedMax} bytes)`);
}
async function l1FeeBound(clients, trust, anchor, fields) {
  const sizes = txSizes(trust, fields);
  assertCoversSigned(sizes);
  const fee = max(await Promise.all(clients.map((c) => read(c, trust.oracle, ORACLE_ABI, "getL1FeeUpperBound", [BigInt(sizes.argument)], anchor.tag))));
  return { fee, sizes };
}

/** prepare({ trust, clients }) -> the exact unsigned request, or throws why it is not prepared. */
export async function prepare({ trust, clients }) {
  const startedAt = Date.now();
  const o = await observe(clients, trust);
  const cur = o.book[trust.key];
  if (cur === lc(trust.factory)) throw Error(`the book's ${trust.key} entry is already the original factory (block ${o.anchor.number}); there is nothing to sign`);
  if (cur !== ZERO) throw Error(`the book's ${trust.key} entry is ${cur}, not zero; stop and review`);
  const impact = await impactOf(clients, trust, o.anchor);
  const tx = frozen(trust), call = { from: tx.from, to: tx.to, data: tx.data, value: "0x0" };
  await onBoth(clients, "simulation of book.set", (c) => c.request("eth_call", [call, o.anchor.tag]));
  const used = max((await onBoth(clients, "gas estimate of book.set", (c) => c.request("eth_estimateGas", [call, o.anchor.tag]))).map((g) => BigInt(g)));
  const gas = (used * 120n + 99n) / 100n;
  if (used <= 0n || gas > trust.caps.setGas) throw Error(`book.set gas ${gas} is outside the reviewed cap ${trust.caps.setGas}`);
  const fees = await feesOf(clients, trust, o.anchor);
  const { fee: l1, sizes } = await l1FeeBound(clients, trust, o.anchor, { nonce: o.admin.nonce, to: tx.to, data: tx.data, gas, fees });
  if (BigInt(o.admin.balance) < gas * fees.maxFeePerGas + l1) throw Error("the administrator's balance does not cover the L2 fee cap plus the L1 data-fee bound");
  await sameAnchor(clients, o.anchor);
  if (Date.now() - startedAt >= trust.maxAgeMs) throw Error("the preparation took too long; check again");
  return { format: "enclave-book-session-factory-activation/v1", status: "prepared; wallet approval required; nothing sent", purpose: PURPOSE,
    preparedAt: new Date().toISOString(), expiresAt: new Date(startedAt + trust.maxAgeMs).toISOString(),
    transaction: { from: tx.from, to: tx.to, chainId: tx.chainId, type: "0x2", nonce: hex(o.admin.nonce), data: tx.data, value: "0x0", gas: hex(gas),
      maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.tip) },
    anchor: { blockNumber: String(o.anchor.number), blockHash: o.anchor.hash },
    observed: { book: o.book, implementation: o.implementation, ledgerCodeHash: o.ledgerCodeHash, administratorBalanceWei: o.admin.balance },
    impact, simulatedGasUsed: String(used),
    feeBound: { l2MaxWei: String(gas * fees.maxFeePerGas), l1DataUpperBoundWei: String(l1), totalExcludingOperatorFeeWei: String(gas * fees.maxFeePerGas + l1),
      encodedBytes: { unsigned: sizes.unsigned, signedMax: sizes.signedMax, oracleArgument: sizes.argument, oracleSignatureAllowance: ORACLE_SIGNATURE_ALLOWANCE },
      note: "L2 cap (gas x maxFeePerGas) plus GasPriceOracle.getL1FeeUpperBound for the maximum signed size. Not an all-fee cap: any OP-stack operator fee is not included; MetaMask shows the total." },
    notice: "Sets a SHARED resolution rule: both original custody vaults and every unpinned consumer of this book key resolve a deployment held by a SessionVault of this factory to the vault's owner wallet. A simple unset is NOT a safe rollback once policies exist for such deployments." };
}

/** A transaction (mined or pending) carries exactly the request's sender, target, calldata, value, nonce, gas and fee caps. */
export function checkTransaction(request, tx, trust) {
  checkFrozen(request, trust);
  const w = request.transaction;
  if (!tx) throw Error("no transaction");
  eq(tx.from, w.from, "wrong sender"); eq(tx.to, w.to, "wrong destination"); eq(tx.input, w.data, "wrong calldata");
  if (BigInt(tx.value) !== 0n) throw Error(`wrong value (${BigInt(tx.value)} wei)`);
  if (BigInt(tx.nonce) !== BigInt(w.nonce)) throw Error(`wrong nonce (${BigInt(tx.nonce)}, expected ${BigInt(w.nonce)})`);
  if (tx.chainId === undefined || BigInt(tx.chainId) !== BigInt(w.chainId)) throw Error("wrong chain");
  if (BigInt(tx.type ?? 0) !== 2n) throw Error("not an EIP-1559 transaction");
  if ((tx.accessList ?? []).length) throw Error("the wallet added an access list (the L1 fee bound assumes none)");
  if (BigInt(tx.gas) !== BigInt(w.gas)) throw Error("the gas limit was changed in the wallet");
  if (BigInt(tx.maxFeePerGas) > BigInt(w.maxFeePerGas)) throw Error("the wallet raised the fee cap");
  if (BigInt(tx.maxPriorityFeePerGas) > BigInt(w.maxPriorityFeePerGas)) throw Error("the wallet raised the priority fee");
}

/** Before a hash is recorded: at least one provider returns it with exactly the request's fields; any provider that returns it agrees. */
export function acceptHook({ trust, clients }) {
  return async (hash, request) => {
    checkFrozen(request, trust);
    const seen = await Promise.all(clients.map((c) => c.request("eth_getTransactionByHash", [hash]).catch(() => null)));
    const found = seen.filter(Boolean);
    if (!found.length) throw Error("neither provider returns this transaction yet; it is not recorded. Check again in a few seconds (MetaMask's activity tab shows its hash).");
    for (const tx of found) { eq(tx.hash, hash, "a provider returned another transaction"); checkTransaction(request, tx, trust); }
  };
}

/** verify -> exactly this transaction, two blocks deep and canonical on both providers, one AddressSet(key, factory), and the readback. */
export async function verify({ trust, request, hash, clients }) {
  checkFrozen(request, trust);                          // a tampered journal fails before any chain read
  pair(clients);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error("invalid transaction hash");
  const anchor = await anchorOf(clients, trust);
  const k = keyOf(trust.key);
  const results = await Promise.all(clients.map(async (c) => {
    if (Number(BigInt(await c.request("eth_chainId"))) !== trust.chainId) throw Error("wrong chain");
    const [tx, receipt] = await Promise.all([c.request("eth_getTransactionByHash", [hash]), c.request("eth_getTransactionReceipt", [hash])]);
    if (!tx || !receipt) throw Error(`${c.host} has no receipt for this transaction yet; it may still be pending. Check again shortly.`);
    eq(tx.hash, hash, "a provider returned another transaction"); eq(receipt.transactionHash, hash, "the receipt is for another transaction");
    const mined = BigInt(receipt.blockNumber);
    if (mined > anchor.number) throw Error("the transaction is mined but lacks two later blocks; check again shortly");
    eq((await c.request("eth_getBlockByNumber", [tagOf(mined), false]))?.hash, receipt.blockHash, "the receipt's block is not canonical");
    eq(tx.blockHash, receipt.blockHash, "the transaction and receipt name different blocks");
    checkTransaction(request, tx, trust);
    if (receipt.status !== "0x1") throw Error("the transaction reverted");
    eq(receipt.from, request.transaction.from, "the receipt's sender differs"); eq(receipt.to, request.transaction.to, "the receipt's destination differs");
    const logs = (receipt.logs || []).filter((l) => lc(l.address) === lc(trust.book)).map((l) => { try { return decodeEventLog({ abi: BOOK_ABI, data: l.data, topics: l.topics }); } catch { return null; } });
    if ((receipt.logs || []).length !== 1 || logs.length !== 1 || logs[0]?.eventName !== "AddressSet") throw Error("expected exactly one AddressSet event from the address book");
    eq(logs[0].args.key, k, "the event is for another key"); eq(logs[0].args.value, trust.factory, "the event names another value");
    const [atMined, before, now, owner, code, ...resolved] = await Promise.all([
      read(c, trust.book, BOOK_ABI, "addr", [k], tagOf(mined)), read(c, trust.book, BOOK_ABI, "addr", [k], tagOf(mined - 1n)),
      read(c, trust.book, BOOK_ABI, "addr", [k], anchor.tag), read(c, trust.book, BOOK_ABI, "owner", [], anchor.tag), c.request("eth_getCode", [trust.book, anchor.tag]),
      ...trust.reviewedVaultHeld.map((id) => read(c, trust.vaults.v2, VAULT_ABI, "beneficialOwnerOf", [id], anchor.tag))]);
    eq(before, ZERO, "the entry was not zero just before this transaction");
    eq(atMined, trust.factory, "the entry is not the factory after the transaction"); eq(now, trust.factory, "the entry is no longer the factory at the latest checked block");
    eq(owner, trust.admin, "the book's owner changed"); if (codeHash(code) !== trust.codeHashes.book) throw Error("the book's code changed");
    resolved.forEach((o, i) => eq(o, trust.admin, `deployment ${trust.reviewedVaultHeld[i]} does not resolve to the administrator`));
    return { transactionHash: lc(hash), minedBlock: String(mined), minedBlockHash: lc(receipt.blockHash), anchorBlock: String(anchor.number), anchorBlockHash: anchor.hash,
      entry: lc(now), bookOwner: lc(owner), resolvedToAdministrator: trust.reviewedVaultHeld.length };
  }));
  if (stable(results[0]) !== stable(results[1])) throw Error("the providers disagree on the confirmed transaction");
  await sameAnchor(clients, anchor);
  return { status: "activation verified: the original book's sessionVaultFactory is the original SessionVault factory", verifiedAt: new Date().toISOString(), providers: 2, ...results[0],
    scope: "Only the sessionVaultFactory key changed. secretVaultV2 and every other book entry are untouched by this transaction." };
}
