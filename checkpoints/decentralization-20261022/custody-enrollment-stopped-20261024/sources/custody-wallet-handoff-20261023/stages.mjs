// The two administrator stages of metal0's one-time host-owner enrollment, read-only: they prepare exact UNSIGNED
// requests and verify what the wallet later returned. They never sign, broadcast or fund anything themselves.
//   fund   (optional): administrator -> existing metal0 operator, exactly 0.000005 ETH, so that the operator can pay for its
//          single proposeOwner(metal0, administrator). Refused once a proposal or owner exists, once the operator holds
//          the amount (never funded twice, even with a lost journal), when the operator could already pay, or while any
//          administrator or operator transaction is pending.
//   accept: administrator -> EnclaveHostOwnership.acceptOwner(metal0), zero ETH. Refused unless the operator's proposal
//          naming exactly this administrator is already two blocks deep; root sends that proposal separately.
// Neither stage touches the custody vault, its committee, shares or policies, or the address book.
// Every preparation reads, at one anchor block agreed by both providers (head - 2): chain id, both contracts' code hashes,
// ownership.registry(), authority(metal0), the registry entry (active, operator, payout, endpoint), the administrator's
// and operator's nonce at the anchor AND pending (all equal), balances and the operator's code; then simulates and
// estimates the exact call on both providers, and refreshes fees and the L1 fee.
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, keccak256, parseAbi, serializeTransaction } from "../enclave/node_modules/viem/_esm/index.js";
import { pair } from "./rpc.mjs";

const ZERO = "0x" + "0".repeat(40), ZERO32 = "0x" + "0".repeat(64);
const lc = (a) => String(a ?? "").toLowerCase();
const eq = (a, b, what) => { if (lc(a) !== lc(b)) throw Error(`${what} (found ${a}, expected ${b})`); };
const hex = (n) => "0x" + BigInt(n).toString(16);
const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0n);
const stable = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v));
const eth = (wei) => { const w = BigInt(wei), s = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, ""); return `${w / 10n ** 18n}${s ? "." + s : ""} ETH`; };

export const OWNERSHIP_ABI = parseAbi([
  "function authority(bytes32) view returns (address owner, address pendingOwner, uint64 revision, bytes32 policyHash)",
  "function registry() view returns (address)",
  "function proposeOwner(bytes32 hostId, address next)",
  "function acceptOwner(bytes32 hostId)",
  "event OwnerProposed(bytes32 indexed hostId, address indexed owner)",
  "event OwnerAccepted(bytes32 indexed hostId, address indexed owner, uint64 revision)",
  "event PolicySet(bytes32 indexed hostId, uint64 revision, bytes32 policyHash)",
]);
export const REGISTRY_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" },
  { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" }, { name: "proofKey", type: "address" }, { name: "payoutWallet", type: "address" }] }] }];
export const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);

export const STAGES = Object.freeze({
  fund: "Optional: send exactly 0.000005 ETH to the existing metal0 operator for its one proposal transaction",
  accept: "Accept ownership of host metal0 as the Enclave administrator; zero ETH",
});

/** The only target, calldata and value each stage can ever request. */
export function frozen(trust, stage) {
  if (stage === "fund") return { from: trust.admin, to: trust.operator, chainId: hex(trust.chainId), value: hex(trust.fundingWei), data: "0x" };
  if (stage === "accept") return { from: trust.admin, to: trust.ownership, chainId: hex(trust.chainId), value: "0x0",
    data: encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "acceptOwner", args: [trust.hostId] }) };
  throw Error("stage must be fund or accept");
}
export const proposalCall = (trust) => ({ from: trust.operator, to: trust.ownership, value: "0x0",
  data: encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "proposeOwner", args: [trust.hostId, trust.admin] }) });

/** A journaled request must still name exactly the frozen sender, target, calldata, value and chain. */
export function checkFrozen(request, trust) {
  const f = frozen(trust, request?.stage), t = request.transaction;
  eq(t.from, f.from, "the request's sender is not the administrator"); eq(t.to, f.to, "the request's destination changed");
  eq(t.data, f.data, "the request's calldata changed"); eq(t.chainId, f.chainId, "the request's chain changed");
  if (BigInt(t.value) !== BigInt(f.value)) throw Error("the request's value changed");
}

const tagOf = (n) => hex(n);
const callRaw = (c, tx, tag) => c.request("eth_call", [tx, tag]);
const read = async (c, address, abi, functionName, args, tag) =>
  decodeFunctionResult({ abi, functionName, data: await callRaw(c, { to: address, data: encodeFunctionData({ abi, functionName, args }) }, tag) });
const codeHash = (code) => (code && code !== "0x" ? keccak256(code) : null);

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

async function readView(c, trust, tag) {
  const [chainId, ownCode, regCode, ownRegistry, auth, entry, aBal, aNonce, aPending, oBal, oNonce, oPending, oCode] = await Promise.all([
    c.request("eth_chainId"), c.request("eth_getCode", [trust.ownership, tag]), c.request("eth_getCode", [trust.registry, tag]),
    read(c, trust.ownership, OWNERSHIP_ABI, "registry", [], tag), read(c, trust.ownership, OWNERSHIP_ABI, "authority", [trust.hostId], tag),
    read(c, trust.registry, REGISTRY_ABI, "get", [trust.hostId], tag),
    c.request("eth_getBalance", [trust.admin, tag]), c.request("eth_getTransactionCount", [trust.admin, tag]), c.request("eth_getTransactionCount", [trust.admin, "pending"]),
    c.request("eth_getBalance", [trust.operator, tag]), c.request("eth_getTransactionCount", [trust.operator, tag]), c.request("eth_getTransactionCount", [trust.operator, "pending"]),
    c.request("eth_getCode", [trust.operator, tag])]);
  return {
    chainId: Number(BigInt(chainId)), ownershipCodeHash: codeHash(ownCode), registryCodeHash: codeHash(regCode), ownershipRegistry: lc(ownRegistry),
    authority: { owner: lc(auth[0]), pendingOwner: lc(auth[1]), revision: String(auth[2]), policyHash: lc(auth[3]) },
    host: { endpoint: entry.endpoint, operator: lc(entry.operator), active: entry.active, payoutWallet: lc(entry.payoutWallet) },
    admin: { balance: String(BigInt(aBal)), nonce: Number(BigInt(aNonce)), pending: Number(BigInt(aPending)) },
    operator: { balance: String(BigInt(oBal)), nonce: Number(BigInt(oNonce)), pending: Number(BigInt(oPending)), code: lc(oCode || "0x") },
  };
}

/** Both providers' view at one anchor, identical, and the registry/ownership facts exactly as expected. */
export async function observe(clients, trust) {
  pair(clients);
  const anchor = await anchorOf(clients, trust);
  const views = await Promise.all(clients.map((c) => readView(c, trust, anchor.tag)));
  if (stable(views[0]) !== stable(views[1])) throw Error(`the two providers disagree on chain state at block ${anchor.number}; check again shortly`);
  const v = views[0];
  if (v.chainId !== trust.chainId) throw Error(`wrong chain ${v.chainId}`);
  if (v.ownershipCodeHash !== trust.codeHashes.ownership) throw Error("the host ownership contract's code is not the reviewed code");
  if (v.registryCodeHash !== trust.codeHashes.registry) throw Error("the registry's code is not the reviewed code");
  eq(v.ownershipRegistry, trust.registry, "the ownership contract reads another registry");
  if (v.host.active !== true) throw Error("metal0 is not active in the registry");
  eq(v.host.operator, trust.operator, "metal0's registry operator changed");
  eq(v.host.payoutWallet, trust.admin, "metal0's payout wallet is not the administrator");
  if (v.host.endpoint !== trust.hostEndpoint) throw Error(`metal0's endpoint changed (${v.host.endpoint})`);
  if (v.admin.pending !== v.admin.nonce) throw Error("an administrator transaction is pending or was mined in the last two blocks; wait for it to settle and check again");
  return { anchor, ...v };
}

async function onBoth(clients, what, fn) {
  return Promise.all(clients.map(async (c) => { try { return await fn(c); } catch (e) { throw Error(`${what} failed on ${c.host}: ${e.message}`); } }));
}
const simulate = (clients, tx, tag, what) => onBoth(clients, `simulation of ${what}`, (c) => callRaw(c, tx, tag));
const estimate = async (clients, tx, tag, what) => (await onBoth(clients, `gas estimate of ${what}`, (c) => c.request("eth_estimateGas", [tx, tag]))).map((g) => BigInt(g));

async function feesOf(clients, trust, anchor) {
  const tip = max((await Promise.all(clients.map((c) => c.request("eth_maxPriorityFeePerGas")))).map((x) => BigInt(x)));
  const maxFeePerGas = anchor.baseFee * 2n + tip;
  if (!(maxFeePerGas > 0n && maxFeePerGas <= trust.caps.maxFeePerGas)) throw Error(`network fee ${maxFeePerGas} wei/gas is above the reviewed cap ${trust.caps.maxFeePerGas}; wait and check again`);
  return { tip, maxFeePerGas };
}
async function l1Fee(clients, trust, anchor, { nonce, to, data, value, gas, fees }) {
  const raw = serializeTransaction({ type: "eip1559", chainId: trust.chainId, nonce, to, data, value: BigInt(value), gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.tip });
  return max(await Promise.all(clients.map((c) => read(c, trust.oracle, ORACLE_ABI, "getL1Fee", [raw], anchor.tag))));
}
function requestOf(stage, trust, o, { nonce, gas, fees, l1, startedAt, extra = {} }) {
  const f = frozen(trust, stage);
  return { format: "enclave-metal0-owner-enrollment/v1", stage, status: "prepared; wallet approval required; nothing sent", purpose: STAGES[stage],
    preparedAt: new Date().toISOString(), expiresAt: new Date(startedAt + trust.maxAgeMs).toISOString(),
    transaction: { from: f.from, to: f.to, chainId: f.chainId, type: "0x2", nonce: hex(nonce), data: f.data, value: f.value, gas: hex(gas),
      maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.tip) },
    anchor: { blockNumber: String(o.anchor.number), blockHash: o.anchor.hash },
    observed: { authority: o.authority, host: o.host, administratorBalanceWei: o.admin.balance, operatorBalanceWei: o.operator.balance },
    estimatedFeeLimitWei: String(gas * fees.maxFeePerGas + l1), ...extra };
}
const fresh = (trust, startedAt) => { if (Date.now() - startedAt >= trust.maxAgeMs) throw Error("the preparation took too long; check again"); };

/** prepareFund({ trust, clients, journals }) -> the exact unsigned transfer request, or throws why it is not prepared. */
export async function prepareFund({ trust, clients, journals }) {
  const startedAt = Date.now();
  if (journals.accept.read().status !== "ready") throw Error("the acceptance stage has already started; the operator is not funded from here");
  const o = await observe(clients, trust);
  const a = o.authority;
  if (a.owner === lc(trust.admin)) throw Error("the administrator already owns metal0; funding is not needed");
  if (a.owner !== ZERO) throw Error(`metal0 already has another owner (${a.owner}); stop and review`);
  if (a.pendingOwner !== ZERO) throw Error(`a proposal already exists (pending owner ${a.pendingOwner}); the operator needs no funding for it`);
  if (o.operator.code !== "0x") throw Error("the operator address has code (for example an EIP-7702 delegation); a plain transfer is not prepared");
  if (o.operator.pending !== o.operator.nonce) throw Error("an operator transaction is pending or was mined in the last two blocks; wait and check again");
  const held = BigInt(o.operator.balance);
  if (held >= trust.fundingWei) throw Error(`the operator already holds ${eth(held)} (at least ${eth(trust.fundingWei)}); it is not funded twice`);
  // the operator's one proposal, simulated and estimated exactly as root will send it
  const proposal = proposalCall(trust);
  await simulate(clients, proposal, o.anchor.tag, "the operator's proposeOwner(metal0, administrator)");
  const proposalUsed = max(await estimate(clients, proposal, o.anchor.tag, "the operator's proposal"));
  if (proposalUsed <= 0n || proposalUsed > trust.caps.proposalGas) throw Error(`the operator's proposal estimate ${proposalUsed} gas is outside the reviewed cap`);
  const transfer = { from: trust.admin, to: trust.operator, value: hex(trust.fundingWei), data: "0x" };
  await simulate(clients, transfer, o.anchor.tag, "the transfer");
  for (const g of await estimate(clients, transfer, o.anchor.tag, "the transfer")) if (g !== trust.caps.transferGas) throw Error(`the transfer is not a plain ${trust.caps.transferGas}-gas transfer (estimate ${g})`);
  const fees = await feesOf(clients, trust, o.anchor), gas = trust.caps.transferGas;
  const l1 = await l1Fee(clients, trust, o.anchor, { nonce: o.admin.nonce, to: trust.operator, data: "0x", value: trust.fundingWei, gas, fees });
  const proposalGas = (proposalUsed * 125n + 99n) / 100n;
  const proposalL1 = await l1Fee(clients, trust, o.anchor, { nonce: o.operator.nonce, to: trust.ownership, data: proposal.data, value: 0n, gas: proposalGas, fees });
  const need = proposalGas * fees.maxFeePerGas + proposalL1;
  if (held >= need) throw Error(`the operator can already pay for its proposal at current fees (needs ${need} wei, holds ${held}); funding is not needed`);
  if (held + trust.fundingWei < need) throw Error(`${eth(trust.fundingWei)} would not cover the operator's proposal at current fees (needs ${need} wei); review the amount`);
  const cost = trust.fundingWei + gas * fees.maxFeePerGas + l1;
  if (BigInt(o.admin.balance) < cost) throw Error(`the administrator's balance ${o.admin.balance} wei does not cover ${cost} wei`);
  await sameAnchor(clients, o.anchor); fresh(trust, startedAt);
  return requestOf("fund", trust, o, { nonce: o.admin.nonce, gas, fees, l1, startedAt,
    extra: { amountWei: String(trust.fundingWei), operatorProposal: { simulated: "success on both providers", gasEstimate: String(proposalUsed), costAtCurrentFeesWei: String(need),
      operatorBalanceAfterWei: String(held + trust.fundingWei) } } });
}

/** prepareAccept({ trust, clients, journals }) -> the exact unsigned acceptOwner request, only after the proposal is two blocks deep. */
export async function prepareAccept({ trust, clients, journals }) {
  const startedAt = Date.now();
  const funding = journals.fund.read().status;
  if (!["ready", "confirmed"].includes(funding)) throw Error(`the funding attempt is unresolved (${funding}); finish or resolve it before accepting`);
  const o = await observe(clients, trust);
  const a = o.authority;
  if (a.owner === lc(trust.admin)) throw Error(`the administrator already owns metal0 (revision ${a.revision}); there is nothing to sign`);
  if (a.owner !== ZERO) throw Error(`metal0 already has another owner (${a.owner}); stop and review`);
  if (a.pendingOwner === ZERO) throw Error(`NOT READY: the metal0 operator has not proposed the administrator yet (no pending owner at block ${o.anchor.number}). Root sends that proposal separately; nothing is requested from MetaMask until it is two blocks deep.`);
  eq(a.pendingOwner, trust.admin, "the pending proposal names another wallet; do not accept it");
  const tx = frozen(trust, "accept"), call = { from: tx.from, to: tx.to, data: tx.data, value: "0x0" };
  await simulate(clients, call, o.anchor.tag, "acceptOwner(metal0)");
  const used = max(await estimate(clients, call, o.anchor.tag, "acceptOwner(metal0)"));
  const gas = (used * 120n + 99n) / 100n;
  if (used <= 0n || gas > trust.caps.acceptGas) throw Error(`acceptOwner gas ${gas} is outside the reviewed cap ${trust.caps.acceptGas}`);
  const fees = await feesOf(clients, trust, o.anchor);
  const l1 = await l1Fee(clients, trust, o.anchor, { nonce: o.admin.nonce, to: tx.to, data: tx.data, value: 0n, gas, fees });
  if (BigInt(o.admin.balance) < gas * fees.maxFeePerGas + l1) throw Error("the administrator's balance does not cover the network fee");
  await sameAnchor(clients, o.anchor); fresh(trust, startedAt);
  return requestOf("accept", trust, o, { nonce: o.admin.nonce, gas, fees, l1, startedAt, extra: { simulatedGasUsed: String(used) } });
}

/** A transaction (mined or pending) carries exactly the request's sender, target, calldata, value, nonce, gas and fee caps. */
export function checkTransaction(request, tx, trust) {
  checkFrozen(request, trust);
  const w = request.transaction;
  if (!tx) throw Error("no transaction");
  eq(tx.from, w.from, "wrong sender"); eq(tx.to, w.to, "wrong destination"); eq(tx.input, w.data, "wrong calldata");
  if (BigInt(tx.value) !== BigInt(w.value)) throw Error(`wrong value (${BigInt(tx.value)} wei)`);
  if (BigInt(tx.nonce) !== BigInt(w.nonce)) throw Error(`wrong nonce (${BigInt(tx.nonce)}, expected ${BigInt(w.nonce)})`);
  if (tx.chainId === undefined || BigInt(tx.chainId) !== BigInt(w.chainId)) throw Error("wrong chain");
  if (BigInt(tx.type ?? 0) !== 2n) throw Error("not an EIP-1559 transaction");
  if (BigInt(tx.gas) !== BigInt(w.gas)) throw Error("the gas limit was changed in the wallet");
  if (BigInt(tx.maxFeePerGas) > BigInt(w.maxFeePerGas)) throw Error("the wallet raised the fee cap");
  if (BigInt(tx.maxPriorityFeePerGas) > BigInt(w.maxPriorityFeePerGas)) throw Error("the wallet raised the priority fee");
}

/**
 * Before a hash is recorded (the transport's accept hook): not the other stage's hash, and at least one provider already
 * returns it with exactly the request's fields; a provider that returns it must agree. Nothing is recorded otherwise.
 */
export function acceptHook({ trust, clients, otherJournal }) {
  return async (hash, request) => {
    if (lc(otherJournal.read().hash) === lc(hash)) throw Error("that transaction belongs to the other stage; it is not recorded here");
    checkFrozen(request, trust);
    const seen = await Promise.all(clients.map((c) => c.request("eth_getTransactionByHash", [hash]).catch(() => null)));
    const found = seen.filter(Boolean);
    if (!found.length) throw Error("neither provider returns this transaction yet; it is not recorded. Check again in a few seconds (MetaMask's activity tab shows its hash).");
    for (const tx of found) { eq(tx.hash, hash, "a provider returned another transaction"); checkTransaction(request, tx, trust); }
  };
}

/** A receipt two blocks deep and canonical on both providers, checked by `check`, with identical results. */
async function landed(clients, trust, hash, check) {
  pair(clients);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error("invalid transaction hash");
  const anchor = await anchorOf(clients, trust);
  const results = await Promise.all(clients.map(async (c) => {
    if (Number(BigInt(await c.request("eth_chainId"))) !== trust.chainId) throw Error("wrong chain");
    const [tx, receipt] = await Promise.all([c.request("eth_getTransactionByHash", [hash]), c.request("eth_getTransactionReceipt", [hash])]);
    if (!tx || !receipt) throw Error(`${c.host} has no receipt for this transaction yet; it may still be pending. Check again shortly.`);
    eq(tx.hash, hash, "a provider returned another transaction"); eq(receipt.transactionHash, hash, "the receipt is for another transaction");
    const mined = BigInt(receipt.blockNumber);
    if (mined > anchor.number) throw Error("the transaction is mined but lacks two later blocks; check again shortly");
    eq((await c.request("eth_getBlockByNumber", [tagOf(mined), false]))?.hash, receipt.blockHash, "the receipt's block is not canonical");
    eq(tx.blockHash, receipt.blockHash, "the transaction and receipt name different blocks");
    const out = await check(c, tx, receipt, mined, anchor);
    return { ...out, transactionHash: lc(hash), minedBlock: String(mined), minedBlockHash: lc(receipt.blockHash), anchorBlock: String(anchor.number), anchorBlockHash: anchor.hash };
  }));
  if (stable(results[0]) !== stable(results[1])) throw Error("the providers disagree on the confirmed transaction");
  await sameAnchor(clients, anchor);
  return results[0];
}
function checkLanding(request, tx, receipt, trust) {
  checkTransaction(request, tx, trust);
  if (receipt.status !== "0x1") throw Error("the transaction reverted");
  eq(receipt.from, request.transaction.from, "the receipt's sender differs"); eq(receipt.to, request.transaction.to, "the receipt's destination differs");
}

/** verifyFund -> the operator received exactly the fixed amount from this exact transaction, or throws. */
export async function verifyFund({ trust, request, hash, clients }) {
  if (request.stage !== "fund") throw Error("not a funding request");
  const r = await landed(clients, trust, hash, async (c, tx, receipt, mined, anchor) => {
    checkLanding(request, tx, receipt, trust);
    if ((receipt.logs || []).length) throw Error("a plain transfer emits no logs");
    const before = tagOf(mined - 1n), at = tagOf(mined);
    const [code, balBefore, balAt, nBefore, nAt, balNow] = await Promise.all([c.request("eth_getCode", [trust.operator, at]),
      c.request("eth_getBalance", [trust.operator, before]), c.request("eth_getBalance", [trust.operator, at]),
      c.request("eth_getTransactionCount", [trust.operator, before]), c.request("eth_getTransactionCount", [trust.operator, at]),
      c.request("eth_getBalance", [trust.operator, anchor.tag])]);
    if (lc(code || "0x") !== "0x") throw Error("the operator address has code");
    if (BigInt(nBefore) !== BigInt(nAt)) throw Error("the operator also sent a transaction in the funding block; verify its balance by hand");
    if (BigInt(balAt) - BigInt(balBefore) !== trust.fundingWei) throw Error("the operator's balance did not rise by exactly the fixed amount in that block; verify by hand");
    return { operator: lc(trust.operator), amountWei: String(trust.fundingWei), operatorBalanceAfterWei: String(BigInt(balAt)), operatorBalanceNowWei: String(BigInt(balNow)) };
  });
  return { status: "funding verified: the operator received exactly 0.000005 ETH from the administrator", verifiedAt: new Date().toISOString(), providers: 2, ...r,
    next: "Root sends the operator's proposeOwner(metal0, administrator) separately. The acceptance stage prepares only after that proposal is two blocks deep." };
}

/** verifyAccept -> exactly one OwnerAccepted(metal0, administrator, 1) and the authority state it implies, or throws. */
export async function verifyAccept({ trust, request, hash, clients }) {
  if (request.stage !== "accept") throw Error("not an acceptance request");
  const r = await landed(clients, trust, hash, async (c, tx, receipt, mined, anchor) => {
    checkLanding(request, tx, receipt, trust);
    const events = (receipt.logs || []).filter((l) => lc(l.address) === lc(trust.ownership))
      .map((l) => { try { return decodeEventLog({ abi: OWNERSHIP_ABI, data: l.data, topics: l.topics }); } catch { return null; } });
    const accepted = events.filter((e) => e?.eventName === "OwnerAccepted");
    if (accepted.length !== 1 || events.length !== 1) throw Error("expected exactly one OwnerAccepted event from the ownership contract");
    eq(accepted[0].args.hostId, trust.hostId, "the event is for another host"); eq(accepted[0].args.owner, trust.admin, "the event names another owner");
    const [after, nowAuth, code] = await Promise.all([read(c, trust.ownership, OWNERSHIP_ABI, "authority", [trust.hostId], tagOf(mined)),
      read(c, trust.ownership, OWNERSHIP_ABI, "authority", [trust.hostId], anchor.tag), c.request("eth_getCode", [trust.ownership, anchor.tag])]);
    if (codeHash(code) !== trust.codeHashes.ownership) throw Error("the host ownership contract's code changed");
    eq(after[0], trust.admin, "the administrator is not metal0's owner after the transaction"); eq(after[1], ZERO, "a proposal is still pending after acceptance");
    if (after[2] !== 1n || accepted[0].args.revision !== 1n) throw Error(`unexpected revision ${after[2]} (expected 1)`);
    eq(after[3], ZERO32, "a host policy is set after acceptance");
    eq(nowAuth[0], trust.admin, "the administrator no longer owns metal0 at the latest checked block");
    return { hostId: lc(trust.hostId), owner: lc(after[0]), revision: String(after[2]), policyHash: lc(after[3]), ownerNow: lc(nowAuth[0]) };
  });
  return { status: "acceptance verified: the Enclave administrator owns host metal0 (revision 1, no host policy)", verifiedAt: new Date().toISOString(), providers: 2, ...r,
    scope: "One-time host-owner enrollment of the single Enclave-operated custody seat. The vault, its committee, shares and policies, and the address book are unchanged." };
}
