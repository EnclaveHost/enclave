// Read-only chain side of the site activation, steps 2 (publishVersion) and 3 (create). It never signs or broadcasts.
// The same rules as the reviewed enrollment queue (work/lease-enrollment-signing/chain.mjs), whose releaseCheck is reused
// as is, applied to the catalog and ledger steps that module does not model. Before each send it re-reads, at one
// anchor (head - 2) whose hash both providers agree on:
//   - chain id;
//   - the admin's code (must be empty: no EIP-7702), nonce at the anchor = pending nonce, balance;
//   - catalog/ledger/registry/reserve/executor runtime code hashes against the pins;
//   - the address book's owner and its appCatalog/deployments entries;
//   - the catalog owner and schema, the ledger schema;
//   - the step's own PRE-state;
// then simulates the exact transaction plus its POST-state reads in one eth_simulateV1 bundle on both providers.
// Verification re-checks the landed transaction against the exact request and its exact events, two blocks deep on
// both providers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, parseAbi, serializeTransaction, toHex, keccak256 } from "../../enclave/node_modules/viem/_esm/index.js";
import { pair } from "../../lease-gas-wallet-signing/stages.mjs";
import { releaseCheck as enrollmentReleaseCheck } from "../../lease-enrollment-signing/chain.mjs";
import { CATALOG_ABI, LEDGER_ABI } from "./site-trust.mjs";

const lc = (a) => String(a ?? "").toLowerCase();
const eq = (a, b, label) => assert.equal(lc(a), lc(b), label);
const hex = (n) => "0x" + BigInt(n).toString(16);
const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0n);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const codeHash = (code) => (code && code !== "0x" ? keccak256(code) : null);
export const norm = (o) => JSON.parse(JSON.stringify(o, (_k, v) => typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v));
const BOOK_ABI = parseAbi(["function owner() view returns (address)", "function all() view returns (bytes32[], address[])"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
// the deployed registry entry shape (EnclaveLeaseGasReserve's IRegistryR, read from the live registry in probe3b)
const REGISTRY_ABI = parseAbi(["function get(bytes32 id) view returns ((string endpoint, string repo, bytes32 measurement, address operator, uint64 registeredAt, uint64 lastSeen, bool active, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey, address payoutWallet))"]);
const bookKey = (kh) => { let k = ""; for (let b = 2; b < kh.length; b += 2) { const c = parseInt(kh.slice(b, b + 2), 16); if (!c) break; k += String.fromCharCode(c); } return k; };

/** The step's request id: fixed by the plan, never by the chain. */
export const opIdOf = (s) => sha256(JSON.stringify([s.step, lc(s.from), lc(s.to), s.value, lc(s.data)]));

async function anchorOf(clients, t) {
  const heads = await Promise.all(clients.map((c) => c.getBlockNumber({ cacheTime: 0 })));
  const blockNumber = heads.reduce((a, b) => (a < b ? a : b)) - t.confirmations;
  const blocks = await Promise.all(clients.map((c) => c.getBlock({ blockNumber })));
  eq(blocks[0].hash, blocks[1].hash, "providers disagree on the anchor block");
  return { blockNumber, blockHash: blocks[0].hash, baseFee: BigInt(blocks[0].baseFeePerGas ?? 0n) };
}

const call = (c, from, to, abi, functionName, args, blockNumber) => c.readContract({ address: to, abi, functionName, args, blockNumber, account: from });

/** One provider's view of the pins and the admin at the anchor. Throws on any difference from the pins. */
async function pinsAt(c, t, plan, blockNumber) {
  const [chainId, adminCode, nonce, pending, balance, ...codes] = await Promise.all([
    c.getChainId(), c.getCode({ address: t.admin, blockNumber }), c.getTransactionCount({ address: t.admin, blockNumber }), c.getTransactionCount({ address: t.admin, blockTag: "pending" }),
    c.getBalance({ address: t.admin, blockNumber }), ...["catalog", "ledger", "registry", "reserve", "executor"].map((k) => c.getCode({ address: t[k], blockNumber }))]);
  assert.equal(Number(chainId), t.chainId, "wrong chain");
  assert.equal(codeHash(adminCode), null, "the admin account has code (EIP-7702 delegation or a contract); refused");
  ["catalog", "ledger", "registry", "reserve", "executor"].forEach((k, i) => assert.equal(codeHash(codes[i]), t.codeHashes[k], `the ${k}'s runtime code is not the pinned one`));
  const [bookOwner, [keys, values], catalogOwner, catalogSchema, ledgerSchema, appId] = await Promise.all([
    call(c, t.admin, t.book, BOOK_ABI, "owner", [], blockNumber), call(c, t.admin, t.book, BOOK_ABI, "all", [], blockNumber),
    call(c, t.admin, t.catalog, CATALOG_ABI, "owner", [], blockNumber), call(c, t.admin, t.catalog, CATALOG_ABI, "catalogSchema", [], blockNumber),
    call(c, t.admin, t.ledger, LEDGER_ABI, "deploymentsSchema", [], blockNumber), call(c, t.admin, t.catalog, CATALOG_ABI, "appIdOf", [t.admin, t.publish.slug], blockNumber)]);
  const book = Object.fromEntries(keys.map((k, i) => [bookKey(k), lc(values[i])]));
  eq(bookOwner, t.admin, "the address book's owner is no longer the admin");
  eq(book.appCatalog, t.catalog, "the address book names another catalog"); eq(book.deployments, t.ledger, "the address book names another ledger");
  eq(catalogOwner, t.admin, "the catalog owner is not the admin (an owner publish would not be approved)");
  assert.equal(BigInt(catalogSchema), t.catalogSchema, "catalog schema changed"); assert.equal(BigInt(ledgerSchema), t.ledgerSchema, "ledger schema changed");
  eq(appId, plan.appId, "the catalog's appId for enclave-site differs from the plan");
  return { nonce: Number(nonce), pending: Number(pending), balance: BigInt(balance) };
}

/** The step's PRE-state (nothing of it done; everything before it done), one provider. */
async function preOf(c, t, plan, step, blockNumber) {
  const n = BigInt(await call(c, t.admin, t.catalog, CATALOG_ABI, "numVersions", [plan.appId], blockNumber));
  if (step === "publish") { assert.equal(n, 0n, "the catalog already holds a version of enclave-site: refused; replan (a lost earlier attempt must be verified by its hash)"); return { numVersions: n }; }
  assert.equal(n, 1n, "the catalog does not hold exactly the one published version: refused; replan");
  const v = await call(c, t.admin, t.catalog, CATALOG_ABI, "getVersion", [plan.appId, 0n], blockNumber);
  checkVersion(t, v);
  const predicted = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "create", data: (await c.call({ account: t.admin, to: t.ledger, data: plan.createData, blockNumber })).data });
  eq(predicted, t.predictedId, `the owner's deployment counter moved (create would mint ${predicted}, not the reviewed ${t.predictedId}): refused; replan stage B`);
  const e = await call(c, t.admin, t.registry, REGISTRY_ABI, "get", [t.minipc.hostId], blockNumber);
  eq(e.operator, t.minipc.operator, "minipc's registry operator changed"); assert.equal(e.active, true, "minipc is not active");
  eq(e.payoutWallet, t.admin, "minipc's payout wallet is not the admin: the zero-rate, self-hosted premise of this plan no longer holds; refused");
  return { numVersions: n, predicted: lc(predicted) };
}

export function checkVersion(t, v) {
  const p = t.publish;
  assert.equal(v.cid, t.expectedCid, "the published version's CID differs"); assert.equal(v.version, p.version, "version label");
  assert.deepEqual([v.vramMb, v.gpuGflops, v.memMb, v.cpuGflops].map(Number), [...p.res], "version resources");
  assert.equal(v.ports, p.ports, "version ports"); assert.equal(v.config, p.config, "version config (the release pin)");
  assert.equal(Number(v.approval), 1, "the version is not Approved"); assert.equal(v.yanked, false, "the version is yanked");
}
export function checkRecord(t, plan, d) {
  const c = t.create;
  eq(d.id, t.predictedId, "deployment id"); eq(d.owner, t.admin, "deployment owner"); assert.equal(d.appRef, plan.appRef, "appRef");
  assert.equal(Number(d.gpuMilli), c.gpuMilli); assert.equal(Number(d.cpuMilli), c.cpuMilli); assert.equal(Number(d.appPort), c.appPort);
  assert.equal(d.isPublic, c.isPublic, "visibility"); assert.equal(d.active, true, "active"); assert.equal(d.configCid, c.envelope, "options envelope");
  assert.equal(BigInt(d.rate), c.maxRate6, "pre-claim rate = cap"); assert.equal(BigInt(d.balance6), 0n, "no funding");
}

/** The step's POST-state reads for the simulation bundle and for verification. */
const postReads = (t, plan, step) => step === "publish"
  ? [["numVersions", t.catalog, CATALOG_ABI, "numVersions", [plan.appId]], ["version", t.catalog, CATALOG_ABI, "getVersion", [plan.appId, 0n]]]
  : [["record", t.ledger, LEDGER_ABI, "get", [t.predictedId]]];
function checkPost(t, plan, step, v) {
  if (step === "publish") { assert.equal(BigInt(v.numVersions), 1n, "exactly one version after publish"); checkVersion(t, v.version); }
  else checkRecord(t, plan, v.record);
}

async function simulate(c, blockNumber, calls) {
  const got = (await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false }, toHex(blockNumber)] }))?.[0]?.calls;
  assert.ok(Array.isArray(got) && got.length === calls.length, "simulation returned an unexpected result");
  got.forEach((x, i) => assert.equal(x.status, "0x1", `simulated call ${i} failed`));
  return got;
}

/**
 * prepareSiteTx({ t, plan, step, clients, reservedNonce, laterValueWei, now, stageBPrecheck })
 *   -> the exact unsigned request, or throws. stageBPrecheck (create only, optional): async (c, blockNumber) => labelled
 *   evidence that create + the reviewed stage-B operations would leave the reserve Ready for minipc (simulation only).
 */
export async function prepareSiteTx({ t, plan, step, clients, reservedNonce = null, laterValueWei = 0n, now = Date.now(), stageBPrecheck = null }) {
  pair(clients);
  const s = plan.steps.find((x) => x.step === step && x.kind === "transaction");
  assert.ok(s, "unknown step");
  const anchor = await anchorOf(clients, t);
  const tx = { from: t.admin, to: s.to, data: s.data, value: s.value, gas: hex(s.gasCap) };
  const reads = postReads(t, plan, step);
  const calls = [tx, ...reads.map(([, to, abi, fn, args]) => ({ from: t.admin, to, data: encodeFunctionData({ abi, functionName: fn, args }), gas: "0x1e8480", value: "0x0" }))];
  const views = await Promise.all(clients.map(async (c) => {
    const pins = await pinsAt(c, t, plan, anchor.blockNumber);
    const pre = await preOf(c, t, plan, step, anchor.blockNumber);
    const got = await simulate(c, anchor.blockNumber, calls);
    const post = Object.fromEntries(reads.map(([label, , abi, fn], i) => [label, decodeFunctionResult({ abi, functionName: fn, data: got[i + 1].returnData })]));
    checkPost(t, plan, step, post);
    const precheck = step === "create" && stageBPrecheck ? await stageBPrecheck(c, anchor.blockNumber) : null;
    return { ...pins, pre: norm(pre), post: norm(post), gasUsed: BigInt(got[0].gasUsed), precheck: precheck && norm(precheck) };
  }));
  assert.deepEqual(norm({ ...views[0], pending: 0 }), norm({ ...views[1], pending: 0 }), "providers disagree on the admin, the pins or the step's state");
  for (const v of views) assert.equal(v.pending, v.nonce, "a transaction from the admin is pending or was mined after the anchor; wait and prepare again");
  const nonce = views[0].nonce;
  if (reservedNonce !== null) assert.equal(nonce, reservedNonce, `nonce ${reservedNonce} was handed to the wallet for this step and the account nonce is now ${nonce}: verify that transaction's hash; nothing is re-prepared`);
  const gas = (views[0].gasUsed * 125n + 99n) / 100n;
  assert.ok(gas > 0n && gas <= s.gasCap, "gas exceeds the reviewed cap");
  const tip = max((await Promise.all(clients.map((c) => c.estimateMaxPriorityFeePerGas()))).map(BigInt)), maxFeePerGas = anchor.baseFee * 2n + tip;
  assert.ok(maxFeePerGas > 0n && maxFeePerGas <= t.maxFeePerGas && tip <= maxFeePerGas, "fee exceeds the reviewed cap");
  const raw = serializeTransaction({ type: "eip1559", chainId: t.chainId, nonce, to: s.to, data: s.data, value: BigInt(s.value), gas, maxFeePerGas, maxPriorityFeePerGas: tip });
  const l1 = max((await Promise.all(clients.map((c) => c.readContract({ address: t.oracle, abi: ORACLE_ABI, functionName: "getL1Fee", args: [raw], blockNumber: anchor.blockNumber })))).map(BigInt));
  const feeLimit = gas * maxFeePerGas + l1;
  assert.ok(views[0].balance >= BigInt(s.value) + laterValueWei + feeLimit, "the admin's balance does not cover this step, its fee and the approved later value");
  for (const c of clients) eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "preparation anchor changed");
  assert.ok(Date.now() - now < t.maxAgeMs, "preparation expired; prepare again");
  return { format: "site-activation-operation/v1", status: "prepared; wallet approval required; nothing sent", step, n: s.n, opId: opIdOf(s), title: s.title, destination: s.destination,
    amountWei: s.amountWei, preparedAt: new Date(now).toISOString(), expiresAt: new Date(now + t.maxAgeMs).toISOString(),
    transaction: { from: lc(t.admin), to: lc(s.to), chainId: hex(t.chainId), type: "0x2", nonce: hex(nonce), data: s.data, value: s.value, gas: hex(gas), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(tip) },
    anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, simulatedGasUsed: String(views[0].gasUsed), estimatedFeeLimitWei: String(feeLimit),
    ...(views[0].precheck ? { stageBPrecheck: views[0].precheck } : {}) };
}

/** The landed transaction is exactly the request, with exactly the step's events. -> "success" | "reverted" (throws otherwise). */
export function checkSiteLanding(t, plan, step, request, { transaction: tx, receipt }) {
  const w = request.transaction, s = plan.steps.find((x) => x.step === step);
  assert.equal(request.step, step, "the request is for another step"); assert.equal(request.opId, opIdOf(s), "the request is not this step's operation");
  eq(tx.from, w.from, "wrong sender"); eq(tx.to, w.to, "wrong recipient"); assert.equal(Number(tx.chainId), Number(BigInt(w.chainId)), "wrong chain");
  assert.equal(tx.type, "eip1559", "not an EIP-1559 transaction"); assert.equal(Number(tx.nonce), Number(BigInt(w.nonce)), "wrong nonce");
  eq(tx.input, w.data, "wrong calldata"); assert.equal(BigInt(tx.value), BigInt(w.value), "wrong value"); assert.equal(BigInt(tx.gas), BigInt(w.gas), "gas changed");
  assert.ok(BigInt(tx.maxFeePerGas) <= BigInt(w.maxFeePerGas), "wallet increased fee cap");
  assert.ok(BigInt(tx.maxPriorityFeePerGas) <= BigInt(w.maxPriorityFeePerGas), "wallet increased priority cap");
  assert.ok((tx.authorizationList ?? []).length === 0, "the transaction carries an authorization list");
  eq(receipt.transactionHash, tx.hash, "receipt hash differs"); eq(receipt.from, w.from, "receipt sender differs"); eq(receipt.to, w.to, "receipt recipient differs");
  if (receipt.status === "reverted") return { outcome: "reverted" };
  assert.equal(receipt.status, "success", "unknown receipt status");
  const logs = receipt.logs || [], want = step === "publish" ? ["AppCreated", "VersionPublished", "VersionApprovalSet"] : ["MaxRateSet", "Created", "RunnerRateSet"];
  assert.equal(logs.length, want.length, `expected exactly ${want.length} events`);
  const abi = step === "publish" ? CATALOG_ABI : LEDGER_ABI, from = step === "publish" ? t.catalog : t.ledger;
  const ev = logs.map((l) => { eq(l.address, from, "an event is not from the step's contract"); return decodeEventLog({ abi, data: l.data, topics: l.topics }); });
  assert.deepEqual(ev.map((e) => e.eventName), want, "unexpected events");
  if (step === "publish") {
    eq(ev[0].args.appId, plan.appId, "AppCreated appId"); eq(ev[0].args.publisher, t.admin, "publisher"); assert.equal(ev[0].args.slug, t.publish.slug);
    eq(ev[1].args.appId, plan.appId, "VersionPublished appId"); assert.equal(BigInt(ev[1].args.index), 0n); assert.equal(ev[1].args.version, t.publish.version); assert.equal(ev[1].args.cid, t.expectedCid, "published CID");
    eq(ev[2].args.appId, plan.appId); assert.equal(BigInt(ev[2].args.index), 0n); assert.equal(Number(ev[2].args.status), 1, "not auto-approved");
    return { outcome: "success" };
  }
  for (const e of ev) eq(e.args.id, t.predictedId, `${e.eventName} is for another deployment (the counter moved?)`);
  assert.equal(BigInt(ev[0].args.maxRate6), t.create.maxRate6, "rate cap");
  eq(ev[1].args.owner, t.admin, "Created owner"); assert.equal(ev[1].args.appRef, plan.appRef); assert.equal(Number(ev[1].args.gpuMilli), t.create.gpuMilli); assert.equal(Number(ev[1].args.cpuMilli), t.create.cpuMilli);
  return { outcome: "success", deploymentId: lc(ev[1].args.id) };
}

/** verifySiteTx({ t, plan, step, attempts, hash, clients }) -> { outcome: "confirmed" | "reverted", ... } or throws. */
export async function verifySiteTx({ t, plan, step, attempts, hash, clients }) {
  pair(clients);
  assert.match(hash, /^0x[0-9a-fA-F]{64}$/, "invalid transaction hash");
  assert.ok(attempts.length > 0, "no wallet request was recorded for this step");
  const anchor = await anchorOf(clients, t);
  const results = await Promise.all(clients.map(async (c) => {
    assert.equal(Number(await c.getChainId()), t.chainId, "wrong chain");
    const [tx, receipt] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);
    eq(tx.hash, hash, "provider returned another transaction");
    assert.ok(BigInt(receipt.blockNumber) <= anchor.blockNumber, "the transaction lacks two later blocks");
    eq((await c.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, "the receipt is not canonical");
    let landed, errors = [];
    for (const request of attempts) { try { landed = checkSiteLanding(t, plan, step, request, { transaction: tx, receipt }); break; } catch (e) { errors.push(e.message); } }
    if (!landed) {
      // the request's sender, nonce, recipient, calldata and value, but another gas limit or fee cap: the wallet altered it
      // (an edited gas setting, saved custom gas defaults, a smart-transaction relay). It landed; it is still refused, and
      // the flow halts for review instead of waiting on it.
      const altered = attempts.some(({ transaction: w }) => lc(tx.from) === lc(w.from) && lc(tx.to) === lc(w.to) && Number(tx.nonce) === Number(BigInt(w.nonce))
        && lc(tx.input) === lc(w.data) && BigInt(tx.value) === BigInt(w.value) && Number(tx.chainId) === Number(BigInt(w.chainId)));
      throw Object.assign(new Error((altered ? "the wallet changed the gas limit or fee caps of this step's request; it landed but is not the reviewed transaction: halted for review, do not resend: "
        : "the transaction is not this step's request: ") + errors.join("; ")), { halt: altered });
    }
    let state = null;
    if (landed.outcome === "success") {
      const v = Object.fromEntries(await Promise.all(postReads(t, plan, step).map(async ([label, to, abi, fn, args]) => [label, await c.readContract({ address: to, abi, functionName: fn, args, blockNumber: receipt.blockNumber })])));
      checkPost(t, plan, step, v); state = norm(v);
    }
    eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "the anchor block changed during verification");
    return { outcome: landed.outcome === "success" ? "confirmed" : "reverted", deploymentId: landed.deploymentId ?? null, transactionHash: lc(hash), nonce: Number(tx.nonce),
      minedBlock: String(receipt.blockNumber), minedBlockHash: lc(receipt.blockHash), gasUsed: String(receipt.gasUsed), state, blockNumber: String(anchor.blockNumber), blockHash: lc(anchor.blockHash) };
  }));
  assert.deepEqual(results[0], results[1], "providers disagree on the landed transaction");
  return { ...results[0], step, verifiedAt: new Date().toISOString(), providers: 2 };
}

/** The explicit start: every pin and the first step's pre-state on both providers (nothing is prepared). */
export async function startSiteCheck({ t, plan, clients }) {
  pair(clients);
  const anchor = await anchorOf(clients, t);
  const views = await Promise.all(clients.map(async (c) => ({ ...(await pinsAt(c, t, plan, anchor.blockNumber)),
    numVersions: String(await call(c, t.admin, t.catalog, CATALOG_ABI, "numVersions", [plan.appId], anchor.blockNumber)) })));
  assert.deepEqual(norm({ ...views[0], pending: 0 }), norm({ ...views[1], pending: 0 }), "providers disagree on the admin or the pins");
  for (const v of views) assert.equal(v.pending, v.nonce, "a transaction from the admin is pending; wait for it before starting");
  return { checkedAt: new Date().toISOString(), anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, adminNonce: views[0].nonce,
    adminBalanceWei: String(views[0].balance), numVersions: views[0].numVersions };
}

/**
 * makeStageBPrecheck({ t, plan, operations, reserveAbi }) -> async (client, blockNumber) => labelled evidence.
 * A PRE-check only (not a send simulation): create + the approved stage-B operations, simulated as one bundle at the
 * anchor, must leave the reserve Ready (statusOf 0) and the ledger claimable for minipc. Each stage-B send is simulated
 * again, fresh, by the reviewed queue after create is mined.
 */
export function makeStageBPrecheck({ t, plan, operations, reserveAbi }) {
  return async (c, blockNumber) => {
    const calls = [{ from: t.admin, to: t.ledger, data: plan.createData, value: "0x0", gas: "0xc3500" },
      ...operations.map((o) => ({ from: t.admin, to: o.to, data: o.data, value: o.value, gas: o.gas })),
      { from: t.admin, to: t.reserve, data: encodeFunctionData({ abi: reserveAbi, functionName: "statusOf", args: [t.predictedId, 1, t.minipc.hostId, t.minipc.operator] }), value: "0x0", gas: "0x1e8480" },
      { from: t.admin, to: t.ledger, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: "claimableBy", args: [t.predictedId, t.minipc.hostId] }), value: "0x0", gas: "0x1e8480" }];
    const got = await simulate(c, blockNumber, calls);
    const n = 1 + operations.length;
    const [status, availableWei] = decodeFunctionResult({ abi: reserveAbi, functionName: "statusOf", data: got[n].returnData });
    const claimable = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "claimableBy", data: got[n + 1].returnData });
    assert.equal(Number(status), 0, "bundle pre-check: the reserve would not be Ready for minipc");
    assert.equal(claimable, true, "bundle pre-check: minipc could not claim the deployment");
    return { label: "bundle pre-check (simulation only; each stage-B send is simulated fresh later)", statusOfClaimOnMinipc: Number(status), reserveAvailableWei: String(availableWei), claimableByMinipc: claimable };
  };
}

/** A lost wallet reply is released only when nothing used its nonce (the reviewed enrollment rule, reused unchanged). */
export const releaseSiteCheck = ({ t, clients, nonce }) => enrollmentReleaseCheck({ trust: { admin: t.admin }, clients, nonce });
