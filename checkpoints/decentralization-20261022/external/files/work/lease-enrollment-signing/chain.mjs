// Read-only chain side of the enrollment queue: prepares ONE exact unsigned operation and verifies what the wallet
// returned. It never signs or broadcasts. Every preparation re-reads, at one anchor (head - 2) agreed by two providers:
// chain id; the admin's code (must be empty: no EIP-7702 delegation), nonce at the anchor and PENDING nonce (all equal);
// its balance; the address book owner; ledger/registry/reserve/executor runtime hashes and the reserve's binding,
// authority and pause state; the app's owner of record on the ledger; the DNS vault's factory, owner and isVault; the
// relay recipient's code and balance; and the operation's own PRE-state (nothing of it done yet). It then simulates
// pre-reads + the exact transaction + post-reads in one eth_simulateV1 bundle on both providers and checks the result.
import assert from "node:assert/strict";
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, keccak256, parseAbi, serializeTransaction, toHex } from "../enclave/node_modules/viem/_esm/index.js";
import { pair, EXECUTOR_ABI } from "../lease-gas-wallet-signing/stages.mjs";
import { VAULT_ABI, budgetKey } from "./plan.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const BOOK_ABI = parseAbi(["function owner() view returns (address)"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const FACTORY_ABI = parseAbi(["function isVault(address) view returns (bool)"]);
const LEDGER_ABI = parseAbi(["function get(bytes32) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil))"]);
const POLICY_KEYS = ["enabled", "claimPolicy", "sponsorRelease", "maxClaimsPerEpoch", "maxPerOpWei", "epochCapWei", "epochSec", "renewWindow", "minExtension", "claimCooldown", "maxGasPrice"];
const lc = (a) => String(a ?? "").toLowerCase();
const eq = (a, b, label) => assert.equal(lc(a), lc(b), label);
const hex = (n) => "0x" + BigInt(n).toString(16);
const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0n);
export const norm = (o) => JSON.parse(JSON.stringify(o, (_k, v) => typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v));
const codeHash = (code) => (code && code !== "0x" ? keccak256(code) : null);
const policyOf = (r) => Object.fromEntries(POLICY_KEYS.map((k) => [k, String(r[k])]));

async function anchorOf(clients, trust) {
  const heads = await Promise.all(clients.map((c) => c.getBlockNumber({ cacheTime: 0 })));
  const blockNumber = heads.reduce((a, b) => (a < b ? a : b)) - trust.confirmations;
  const blocks = await Promise.all(clients.map((c) => c.getBlock({ blockNumber })));
  eq(blocks[0].hash, blocks[1].hash, "providers disagree on the anchor block");
  return { blockNumber, blockHash: blocks[0].hash, baseFee: BigInt(blocks[0].baseFeePerGas ?? 0n) };
}

/** The contract reads one operation depends on (deployment binding/authority + the op's own state), as labelled calls. */
function readsFor(trust, abi, op) {
  const r = (label, to, a, functionName, args = []) => ({ label, to, abi: a, functionName, args });
  const out = [r("bookOwner", trust.book, BOOK_ABI, "owner"), ...["owner", "pendingOwner", "ledger", "registry", "l1Oracle", "executor", "delegationCodeHash", "paused"]
    .map((f) => r("reserve." + f, trust.reserve, abi, f)), r("executor.reserve", trust.executor, EXECUTOR_ABI, "reserve")];
  if (op.app) out.push(r("ledger.get", trust.ledger, LEDGER_ABI, "get", [op.app]), r("blocked", trust.reserve, abi, "blockedDeployment", [op.app]),
    r("reserveOf", trust.reserve, abi, "reserveOf", [op.app, op.ownerOfRecord]));
  if (op.ownerOfRecord === trust.dnsVault) out.push(r("claimant", trust.reserve, abi, "claimantAllowed", [budgetKey(op.app, trust.dnsVault), trust.dnsOperator]),
    r("factory.isVault", trust.vaultFactory, FACTORY_ABI, "isVault", [trust.dnsVault]), r("vault.owner", trust.dnsVault, VAULT_ABI, "owner"), r("vault.factory", trust.dnsVault, VAULT_ABI, "factory"));
  return out;
}
const postReadsFor = (trust, abi, op) => readsFor(trust, abi, op).filter((x) => x.label === "reserveOf" || x.label === "claimant");
const asCall = (trust, x) => ({ from: trust.admin, to: x.to, data: encodeFunctionData({ abi: x.abi, functionName: x.functionName, args: x.args }), gas: "0x1e8480", value: "0x0" });
const decode = (reads, got) => Object.fromEntries(reads.map((x, i) => [x.label, decodeFunctionResult({ abi: x.abi, functionName: x.functionName, data: got[i].returnData })]));

async function simulate(c, blockNumber, calls) {
  const got = (await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false }, toHex(blockNumber)] }))?.[0]?.calls;
  assert.ok(Array.isArray(got) && got.length === calls.length, "simulation returned an unexpected result");
  got.forEach((x, i) => assert.equal(x.status, "0x1", `simulated call ${i} failed`));
  return got;
}

/** The deployment's binding and authority, and the app/vault authority the op relies on. Throws on any difference. */
function checkAuthority(trust, op, v) {
  eq(v.bookOwner, trust.admin, "the address book's owner is no longer the admin");
  eq(v["reserve.owner"], trust.admin, "the reserve's owner is not the admin"); eq(v["reserve.pendingOwner"], ZERO, "a reserve ownership transfer is pending");
  eq(v["reserve.ledger"], trust.ledger, "the reserve's ledger changed"); eq(v["reserve.registry"], trust.registry, "the reserve's registry changed");
  eq(v["reserve.l1Oracle"], trust.oracle, "the reserve's oracle changed"); eq(v["reserve.executor"], trust.executor, "the reserve is not bound to the verified executor");
  eq(v["reserve.delegationCodeHash"], trust.delegationCodeHash, "the reserve's delegation code hash changed"); assert.equal(v["reserve.paused"], false, "the reserve is paused");
  eq(v["executor.reserve"], trust.reserve, "the executor is not for this reserve");
  if (!op.app) return;
  eq(v["ledger.get"].id, op.app, "the deployment is not on the ledger"); eq(v["ledger.get"].owner, op.ownerOfRecord, "the deployment's owner of record changed");
  assert.equal(v.blocked, false, "the deployment is blocked on the reserve");
  if (op.ownerOfRecord !== trust.dnsVault) return;
  assert.equal(v["factory.isVault"], true, "the DNS owner is not a vault of the original SessionVault factory");
  eq(v["vault.factory"], trust.vaultFactory, "the DNS vault's factory changed"); eq(v["vault.owner"], trust.admin, "the DNS vault's owner is not the admin");
}
/** Nothing of this op is done yet (also the duplicate guard after a restart). */
function checkPre(trust, op, v, extra) {
  if (op.kind === "deposit") assert.equal(BigInt(v.reserveOf.balanceWei), 0n, `${op.appLabel} already has a lease-gas balance; this deposit may already be done`);
  if (op.kind === "configure") assert.ok(!v.reserveOf.enabled && Number(v.reserveOf.epochSec) === 0 && BigInt(v.reserveOf.maxGasPrice) === 0n, `${op.appLabel} is already configured`);
  if (op.kind === "setClaimant") assert.equal(v.claimant, false, `${op.appLabel} already allows the DNS operator`);
  if (op.kind === "transfer") { assert.equal(extra.recipientCode, null, "the relay recipient has code"); assert.equal(extra.recipientBalance, "0", "the relay already holds ETH; this transfer may already be done"); }
}
/** Exactly this op's effect. */
function checkPost(trust, op, v, extra) {
  if (op.kind === "deposit") assert.equal(BigInt(v.reserveOf.balanceWei), BigInt(op.value), "the deposit is not credited to the owner of record's reserve");
  if (op.kind === "configure") assert.deepEqual(policyOf(v.reserveOf), policyOf(op.policy), "the configured policy differs");
  if (op.kind === "setClaimant") assert.equal(v.claimant, true, "the DNS operator is not allowed");
  if (op.kind === "transfer") assert.equal(extra.recipientBalance, String(BigInt(op.value)), "the relay balance is not exactly the transfer");
}

/** One provider's view at the anchor: code hashes, admin account, deployment authority and the op's pre-state. */
async function readOne(c, trust, abi, op, blockNumber) {
  const recipient = op.kind === "transfer" ? op.to : null;
  const [chainId, adminCode, nonce, pending, balance, ledgerCode, registryCode, reserveCode, executorCode, factoryCode, recipientCode, recipientBalance] = await Promise.all([
    c.getChainId(), c.getCode({ address: trust.admin, blockNumber }), c.getTransactionCount({ address: trust.admin, blockNumber }), c.getTransactionCount({ address: trust.admin, blockTag: "pending" }),
    c.getBalance({ address: trust.admin, blockNumber }), c.getCode({ address: trust.ledger, blockNumber }), c.getCode({ address: trust.registry, blockNumber }),
    c.getCode({ address: trust.reserve, blockNumber }), c.getCode({ address: trust.executor, blockNumber }),
    op.ownerOfRecord === trust.dnsVault ? c.getCode({ address: trust.vaultFactory, blockNumber }) : null,
    recipient ? c.getCode({ address: recipient, blockNumber }) : null, recipient ? c.getBalance({ address: recipient, blockNumber }) : null]);
  assert.equal(Number(chainId), trust.chainId, "wrong chain");
  assert.equal(codeHash(adminCode), null, "the admin account has code (EIP-7702 delegation or a contract); refused");
  assert.equal(codeHash(ledgerCode), trust.codeHashes.ledger, "the original ledger code changed");
  assert.equal(codeHash(registryCode), trust.codeHashes.registry, "the original registry code changed");
  assert.equal(codeHash(reserveCode), trust.reserveRuntimeHash, "the reserve's runtime changed");
  assert.equal(codeHash(executorCode), trust.executorRuntimeHash, "the executor's runtime changed");
  if (op.ownerOfRecord === trust.dnsVault) assert.equal(codeHash(factoryCode), trust.vaultFactoryCodeHash, "the SessionVault factory's code changed");
  return { nonce: Number(nonce), pending: Number(pending), balance: BigInt(balance), extra: { recipientCode: codeHash(recipientCode), recipientBalance: recipientBalance == null ? null : String(recipientBalance) } };
}

/**
 * prepareOperation({ trust, abi, op, planSha256, reservedNonce, laterValueWei, clients, now }) -> exact unsigned request.
 * reservedNonce: set when an earlier attempt of THIS op reached the wallet; the retry must use the same nonce so a stale
 * wallet prompt and the retry can never both land. laterValueWei: value of the ops after this one (balance must cover).
 */
export async function prepareOperation({ trust, abi, op, planSha256, reservedNonce = null, laterValueWei = 0n, clients, now = Date.now() }) {
  pair(clients);
  const anchor = await anchorOf(clients, trust);
  const pre = readsFor(trust, abi, op), post = postReadsFor(trust, abi, op);
  const tx = { from: trust.admin, to: op.to, data: op.data, value: op.value, gas: op.gas };
  const calls = [...pre.map((x) => asCall(trust, x)), tx, ...post.map((x) => asCall(trust, x))];
  const views = await Promise.all(clients.map(async (c) => {
    const s = await readOne(c, trust, abi, op, anchor.blockNumber);
    const got = await simulate(c, anchor.blockNumber, calls);
    const before = decode(pre, got.slice(0, pre.length)), after = decode(post, got.slice(pre.length + 1));
    checkAuthority(trust, op, before); checkPre(trust, op, before, s.extra);
    if (op.kind !== "transfer") checkPost(trust, op, after, s.extra); else assert.equal(BigInt(got[pre.length].gasUsed), 21000n, "the relay transfer would run code");
    return { ...s, before: norm(before), after: norm(after), gasUsed: BigInt(got[pre.length].gasUsed) };
  }));
  assert.deepEqual(norm({ ...views[0], pending: 0 }), norm({ ...views[1], pending: 0 }), "providers disagree on the admin, deployment or operation state");
  for (const v of views) assert.equal(v.pending, v.nonce, "a transaction from the admin is pending or was mined after the anchor; wait and prepare again");
  const nonce = views[0].nonce;
  if (reservedNonce !== null) assert.equal(nonce, reservedNonce, `nonce ${reservedNonce} was handed to the wallet for this operation and the account nonce is now ${nonce}: verify that transaction's hash; nothing is re-prepared`);
  const gas = (views[0].gasUsed * 125n + 99n) / 100n;
  assert.ok(gas > 0n && gas <= BigInt(op.gas), "gas exceeds the reviewed cap");
  const tip = max((await Promise.all(clients.map((c) => c.estimateMaxPriorityFeePerGas()))).map(BigInt)), maxFeePerGas = anchor.baseFee * 2n + tip;
  assert.ok(maxFeePerGas > 0n && maxFeePerGas <= trust.maxFeePerGas && tip <= maxFeePerGas, "fee exceeds the reviewed cap");
  const raw = serializeTransaction({ type: "eip1559", chainId: trust.chainId, nonce, to: op.to, data: op.data, value: BigInt(op.value), gas, maxFeePerGas, maxPriorityFeePerGas: tip });
  const l1 = max((await Promise.all(clients.map((c) => c.readContract({ address: trust.oracle, abi: ORACLE_ABI, functionName: "getL1Fee", args: [raw], blockNumber: anchor.blockNumber })))).map(BigInt));
  const feeLimit = gas * maxFeePerGas + l1;
  assert.ok(views[0].balance >= BigInt(op.value) + laterValueWei + feeLimit, "the admin's balance does not cover this operation, its fee and the remaining approved operations");
  for (const c of clients) eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "preparation anchor changed");
  assert.ok(Date.now() - now < trust.maxAgeMs, "preparation expired; prepare again");
  return { format: "enclave-lease-enrollment-operation/v1", status: "prepared; wallet approval required; nothing sent", planSha256, index: op.index, opId: op.opId,
    title: op.title, appLabel: op.appLabel, app: op.app, action: op.action, kind: op.kind, amountWei: String(BigInt(op.value)),
    preparedAt: new Date(now).toISOString(), expiresAt: new Date(now + trust.maxAgeMs).toISOString(),
    transaction: { from: trust.admin, to: op.to, chainId: hex(trust.chainId), type: "0x2", nonce: hex(nonce), data: op.data, value: op.value, gas: hex(gas), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(tip) },
    anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, simulatedGasUsed: String(views[0].gasUsed), estimatedFeeLimitWei: String(feeLimit) };
}

/** The returned transaction and receipt are exactly the request's: sender, recipient, chain, nonce, calldata, value, gas,
 *  fee caps; and exactly the op's events from the reserve (none for a relay transfer). -> "success" | "reverted". */
export function checkLanding(trust, abi, op, request, { transaction: tx, receipt }) {
  const w = request.transaction;
  assert.equal(request.opId, op.opId, "the request is for another operation");
  eq(tx.from, w.from, "wrong sender"); eq(tx.to, w.to, "wrong recipient"); assert.equal(Number(tx.chainId), Number(BigInt(w.chainId)), "wrong chain");
  assert.equal(tx.type, "eip1559", "not an EIP-1559 transaction"); assert.equal(Number(tx.nonce), Number(BigInt(w.nonce)), "wrong nonce");
  eq(tx.input, w.data, "wrong calldata"); assert.equal(BigInt(tx.value), BigInt(w.value), "wrong value"); assert.equal(BigInt(tx.gas), BigInt(w.gas), "gas changed");
  assert.ok(BigInt(tx.maxFeePerGas) <= BigInt(w.maxFeePerGas), "wallet increased fee cap");
  assert.ok(BigInt(tx.maxPriorityFeePerGas) <= BigInt(w.maxPriorityFeePerGas), "wallet increased priority cap");
  assert.ok((tx.authorizationList ?? []).length === 0, "the transaction carries an authorization list");
  eq(receipt.transactionHash, tx.hash, "receipt hash differs"); eq(receipt.from, w.from, "receipt sender differs"); eq(receipt.to, w.to, "receipt recipient differs");
  if (receipt.status === "reverted") return "reverted";
  assert.equal(receipt.status, "success", "unknown receipt status");
  const logs = receipt.logs || [];
  if (op.kind === "transfer") { assert.equal(logs.length, 0, "a relay transfer emitted events"); assert.equal(BigInt(receipt.gasUsed), 21000n, "the relay transfer ran code"); return "success"; }
  assert.equal(logs.length, 1, "expected exactly one event");
  eq(logs[0].address, trust.reserve, "the event is not from the reserve");
  const e = decodeEventLog({ abi, data: logs[0].data, topics: logs[0].topics });
  const want = { deposit: "Deposited", configure: "Configured", setClaimant: "ClaimantSet" }[op.kind];
  assert.equal(e.eventName, want, `expected ${want}`); eq(e.args.id, op.app, "the event is for another deployment"); eq(e.args.owner, op.ownerOfRecord, "the event's owner differs");
  if (op.kind === "deposit") { eq(e.args.from, trust.admin, "deposit payer"); assert.equal(BigInt(e.args.amountWei), BigInt(op.value), "deposit amount"); }
  if (op.kind === "configure") assert.deepEqual(policyOf(e.args.policy), policyOf(op.policy), "configured policy");
  if (op.kind === "setClaimant") { eq(e.args.operator, trust.dnsOperator, "claimant"); assert.equal(e.args.allowed, true, "claimant not allowed"); }
  return "success";
}

/**
 * verifyOperation({ trust, abi, op, attempts, hash, clients }) -> { outcome: "confirmed" | "reverted", ... } or throws.
 * attempts: every request of this op that reached the wallet (same nonce, maybe different fees); the landed transaction
 * must be exactly one of them. Receipt two blocks deep and canonical on both providers, which must agree.
 */
export async function verifyOperation({ trust, abi, op, attempts, hash, clients }) {
  pair(clients);
  assert.match(hash, /^0x[0-9a-fA-F]{64}$/, "invalid transaction hash");
  assert.ok(attempts.length > 0, "no wallet request was recorded for this operation");
  const anchor = await anchorOf(clients, trust);
  const results = await Promise.all(clients.map(async (c) => {
    assert.equal(Number(await c.getChainId()), trust.chainId, "wrong chain");
    const [tx, receipt] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);
    eq(tx.hash, hash, "provider returned another transaction");
    assert.ok(BigInt(receipt.blockNumber) <= anchor.blockNumber, "the transaction lacks two later blocks");
    eq((await c.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, "the receipt is not canonical");
    let outcome, errors = [];
    for (const request of attempts) { try { outcome = checkLanding(trust, abi, op, request, { transaction: tx, receipt }); break; } catch (e) { errors.push(e.message); } }
    if (!outcome) throw new Error("the transaction is not this operation's request: " + errors.join("; "));
    let state = null;
    if (outcome === "success") {
      const reads = postReadsFor(trust, abi, op), at = receipt.blockNumber;
      const v = Object.fromEntries(await Promise.all(reads.map(async (x) => [x.label, await c.readContract({ address: x.to, abi: x.abi, functionName: x.functionName, args: x.args, blockNumber: at })])));
      const extra = op.kind === "transfer" ? { recipientBalance: String(await c.getBalance({ address: op.to, blockNumber: at })) } : {};
      checkPost(trust, op, v, extra); state = norm({ ...v, ...extra });
      const [rc, bound] = await Promise.all([c.getCode({ address: trust.reserve, blockNumber: anchor.blockNumber }), c.readContract({ address: trust.reserve, abi, functionName: "executor", blockNumber: anchor.blockNumber })]);
      assert.equal(codeHash(rc), trust.reserveRuntimeHash, "the reserve's runtime changed"); eq(bound, trust.executor, "the reserve's executor changed");
    }
    eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "the anchor block changed during verification");
    return { outcome: outcome === "success" ? "confirmed" : "reverted", transactionHash: lc(hash), nonce: Number(tx.nonce), minedBlock: String(receipt.blockNumber), minedBlockHash: lc(receipt.blockHash),
      gasUsed: String(receipt.gasUsed), state, blockNumber: String(anchor.blockNumber), blockHash: lc(anchor.blockHash) };
  }));
  assert.deepEqual(results[0], results[1], "providers disagree on the landed transaction");
  return { ...results[0], index: op.index, opId: op.opId, title: op.title, verifiedAt: new Date().toISOString(), providers: 2 };
}

/** The explicit start: binding/authority and the PRE-state of every unfinished op, at one anchor on both providers. */
export async function startCheck({ trust, abi, ops, clients }) {
  pair(clients);
  const anchor = await anchorOf(clients, trust);
  const appOps = ops.filter((o) => o.app), relays = ops.filter((o) => o.kind === "transfer");
  const reads = appOps.map((o) => readsFor(trust, abi, o));
  const calls = reads.flat().map((x) => asCall(trust, x));
  const views = await Promise.all(clients.map(async (c) => {
    const s = await readOne(c, trust, abi, { ownerOfRecord: trust.dnsVault }, anchor.blockNumber);
    const got = calls.length ? await simulate(c, anchor.blockNumber, calls) : [];
    let at = 0;
    appOps.forEach((o, i) => { const v = decode(reads[i], got.slice(at, at + reads[i].length)); at += reads[i].length; checkAuthority(trust, o, v); checkPre(trust, o, v, {}); });
    for (const o of relays) {
      const [code, bal] = await Promise.all([c.getCode({ address: o.to, blockNumber: anchor.blockNumber }), c.getBalance({ address: o.to, blockNumber: anchor.blockNumber })]);
      checkPre(trust, o, {}, { recipientCode: codeHash(code), recipientBalance: String(bal) });
    }
    return { nonce: s.nonce, pending: s.pending, balance: s.balance };
  }));
  assert.deepEqual(norm({ ...views[0], pending: 0 }), norm({ ...views[1], pending: 0 }), "providers disagree on the admin state");
  for (const v of views) assert.equal(v.pending, v.nonce, "a transaction from the admin is pending; wait for it before starting");
  const remainingWei = ops.reduce((s, o) => s + BigInt(o.value), 0n);
  assert.ok(views[0].balance >= remainingWei, "the admin's balance does not cover the approved operations' value");
  for (const c of clients) eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "start anchor changed");
  return { checkedAt: new Date().toISOString(), anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, adminNonce: views[0].nonce,
    adminBalanceWei: String(views[0].balance), remainingWei: String(remainingWei), operationsChecked: ops.length };
}

/** A wallet request whose reply was lost may be released only if NOTHING used its nonce: latest = pending = nonce on both. */
export async function releaseCheck({ trust, clients, nonce }) {
  pair(clients);
  const seen = await Promise.all(clients.map(async (c) => [Number(await c.getTransactionCount({ address: trust.admin, blockTag: "latest" })), Number(await c.getTransactionCount({ address: trust.admin, blockTag: "pending" }))]));
  for (const [latest, pending] of seen) {
    assert.equal(pending, latest, "a transaction from the admin is pending: it may be this operation; wait for it and enter its hash");
    assert.equal(latest, nonce, latest > nonce ? `nonce ${nonce} was used: enter that transaction's hash from MetaMask's activity to verify it` : "unexpected account nonce");
  }
  return { releasedAt: new Date().toISOString(), nonce };
}
