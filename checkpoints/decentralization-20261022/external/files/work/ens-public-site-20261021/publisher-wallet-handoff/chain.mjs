// Read-only chain side of the IPNS Publisher release: steps 2 (publishVersion), 3 (setAppRef) and 4 (setConfig). It never
// signs or broadcasts. The rules of the reviewed site activation (site-host-live-publish/handoff/site-chain.mjs, whose
// opIdOf/norm/releaseSiteCheck are reused unchanged) applied to these three steps. Before each wallet request it re-reads,
// at one anchor (head - confirmations) whose hash both providers agree on:
//   - chain id; the owner's code (must be empty: no EIP-7702), nonce at the anchor = pending nonce, balance;
//   - catalog and ledger runtime code hashes against the pins; the address book's owner and its two entries;
//   - the catalog owner (= the publisher, so the publish is owner-approved), schemas, the app record (publisher, slug,
//     name, description, active) and the frozen version 1.0.5;
//   - the step's own PRE-state (version count, version 6, the deployment's owner/appRef/config envelope);
// then simulates the exact transaction plus its POST-state reads in one eth_simulateV1 bundle on both providers.
// Verification re-checks the landed transaction against the exact request and its exact events, two blocks deep, on
// both providers, and that nothing else of the deployment (owner, shares, ports, visibility, active) moved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, parseAbi, serializeTransaction, toHex, keccak256 } from "../../enclave/node_modules/viem/_esm/index.js";
import { pair } from "../../lease-gas-wallet-signing/stages.mjs";
import { opIdOf, norm, releaseSiteCheck } from "../../site-host-live-publish/handoff/site-chain.mjs";
import { CATALOG_ABI, LEDGER_ABI } from "./trust.mjs";

export { opIdOf };
const lc = (a) => String(a ?? "").toLowerCase();
const eq = (a, b, label) => assert.equal(lc(a), lc(b), label);
const hex = (n) => "0x" + BigInt(n).toString(16);
const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0n);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const codeHash = (code) => (code && code !== "0x" ? keccak256(code) : null);
const BOOK_ABI = parseAbi(["function owner() view returns (address)", "function all() view returns (bytes32[], address[])"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const bookKey = (kh) => { let k = ""; for (let b = 2; b < kh.length; b += 2) { const c = parseInt(kh.slice(b, b + 2), 16); if (!c) break; k += String.fromCharCode(c); } return k; };
export const TX_STEPS = ["publish", "upgrade", "config"];
// the deployment fields no step may change (balance, lease and rate move with renewals; they are compared in simulation only)
const STABLE = ["id", "owner", "ports", "gpuMilli", "cpuMilli", "appPort", "isPublic", "active", "createdAt"];

async function anchorOf(clients, t) {
  const heads = await Promise.all(clients.map((c) => c.getBlockNumber({ cacheTime: 0 })));
  const blockNumber = heads.reduce((a, b) => (a < b ? a : b)) - t.confirmations;
  const blocks = await Promise.all(clients.map((c) => c.getBlock({ blockNumber })));
  eq(blocks[0].hash, blocks[1].hash, "providers disagree on the anchor block");
  return { blockNumber, blockHash: blocks[0].hash, baseFee: BigInt(blocks[0].baseFeePerGas ?? 0n) };
}
const call = (c, from, to, abi, functionName, args, blockNumber) => c.readContract({ address: to, abi, functionName, args, blockNumber, account: from });

/** One provider's view of the pins and the owner at the anchor. Throws on any difference from the pins. */
async function pinsAt(c, t, plan, blockNumber) {
  const [chainId, adminCode, nonce, pending, balance, catalogCode, ledgerCode] = await Promise.all([
    c.getChainId(), c.getCode({ address: t.admin, blockNumber }), c.getTransactionCount({ address: t.admin, blockNumber }), c.getTransactionCount({ address: t.admin, blockTag: "pending" }),
    c.getBalance({ address: t.admin, blockNumber }), c.getCode({ address: t.catalog, blockNumber }), c.getCode({ address: t.ledger, blockNumber })]);
  assert.equal(Number(chainId), t.chainId, "wrong chain");
  assert.equal(codeHash(adminCode), null, "the owner account has code (EIP-7702 delegation or a contract); refused");
  assert.equal(codeHash(catalogCode), t.codeHashes.catalog, "the catalog's runtime code is not the pinned one");
  assert.equal(codeHash(ledgerCode), t.codeHashes.ledger, "the ledger's runtime code is not the pinned one");
  const [bookOwner, [keys, values], catalogOwner, catalogSchema, ledgerSchema, appId, app] = await Promise.all([
    call(c, t.admin, t.book, BOOK_ABI, "owner", [], blockNumber), call(c, t.admin, t.book, BOOK_ABI, "all", [], blockNumber),
    call(c, t.admin, t.catalog, CATALOG_ABI, "owner", [], blockNumber), call(c, t.admin, t.catalog, CATALOG_ABI, "catalogSchema", [], blockNumber),
    call(c, t.admin, t.ledger, LEDGER_ABI, "deploymentsSchema", [], blockNumber), call(c, t.admin, t.catalog, CATALOG_ABI, "appIdOf", [t.admin, t.app.slug], blockNumber),
    call(c, t.admin, t.catalog, CATALOG_ABI, "getApp", [plan.appId], blockNumber)]);
  const book = Object.fromEntries(keys.map((k, i) => [bookKey(k), lc(values[i])]));
  eq(bookOwner, t.admin, "the address book's owner is no longer the admin");
  eq(book.appCatalog, t.catalog, "the address book names another catalog"); eq(book.deployments, t.ledger, "the address book names another ledger");
  eq(catalogOwner, t.admin, "the catalog owner is not the publisher: the publish would land Pending, not owner-approved; refused");
  assert.equal(BigInt(catalogSchema), t.catalogSchema, "catalog schema changed"); assert.equal(BigInt(ledgerSchema), t.ledgerSchema, "ledger schema changed");
  eq(appId, plan.appId, "the catalog's appId for ipns-publisher differs from the plan");
  checkApp(t, plan, app);
  return { nonce: Number(nonce), pending: Number(pending), balance: BigInt(balance) };
}

function checkApp(t, plan, a) {
  eq(a.appId, plan.appId, "app id"); eq(a.publisher, t.admin, "the app's publisher is not the owner"); assert.equal(a.slug, t.app.slug, "app slug");
  assert.equal(a.name, t.app.name, "the app's name changed (a publish would overwrite it)"); assert.equal(a.description, t.app.description, "the app's description changed (a publish would overwrite it)");
  assert.equal(a.active, true, "the app is not active");
}
/** The frozen previous version (index 5) the deployment runs today, whose resources/ports/config are re-listed verbatim. */
function checkPrev(t, v) {
  assert.equal(v.version, t.prev.version, "version 5's label changed"); assert.equal(v.cid, t.prev.cid, "version 5's CID changed");
  assert.equal(sha256(v.config), t.prev.configSha256, "version 5's config is not the frozen one");
  assert.equal(v.config, t.publish.config, "the publish config is not version 5's verbatim");
  assert.deepEqual([v.vramMb, v.gpuGflops, v.memMb, v.cpuGflops].map(Number), [...t.publish.res], "the publish resources are not version 5's"); assert.equal(v.ports, t.publish.ports, "the publish ports are not version 5's");
  assert.equal(Number(v.approval), 1, "version 5 is not Approved"); assert.equal(v.yanked, false, "version 5 is yanked");
}
/** The published version 6: exactly the plan's, owner-approved, live. */
export function checkVersion(t, v) {
  const p = t.publish;
  assert.equal(v.cid, t.expectedCid, "the published version's CID differs"); assert.equal(v.version, p.version, "version label");
  assert.deepEqual([v.vramMb, v.gpuGflops, v.memMb, v.cpuGflops].map(Number), [...p.res], "version resources");
  assert.equal(v.ports, p.ports, "version ports"); assert.equal(v.config, p.config, "version config (version 1.0.5's, verbatim)");
  assert.equal(Number(v.approval), 1, "the version is not Approved"); assert.equal(v.yanked, false, "the version is yanked");
}
const depView = (d) => Object.fromEntries(STABLE.map((k) => [k, typeof d[k] === "bigint" ? String(d[k]) : typeof d[k] === "string" ? lc(d[k]) : d[k]]));
function checkDeployment(t, plan, d, { appRef, envelope }) {
  eq(d.id, t.deployment.id, "deployment id"); eq(d.owner, t.admin, "the deployment's owner is not the admin");
  assert.equal(d.appRef, appRef, `the deployment's version reference is not ${appRef}`);
  assert.equal(d.configCid, envelope, "the deployment's public config envelope is not the expected one");
}
const STATE = { publish: { n: 6, appRef: "prev", envelope: "envelopeCurrent" }, upgrade: { n: 7, appRef: "prev", envelope: "envelopeCurrent" },
  config: { n: 7, appRef: "next", envelope: "envelopeCurrent" }, done: { n: 7, appRef: "next", envelope: "envelopeNew" } };
const expectOf = (t, plan, k) => ({ n: BigInt(STATE[k].n), appRef: STATE[k].appRef === "prev" ? plan.appRefPrev : plan.appRefNext, envelope: t.deployment[STATE[k].envelope] });
const AFTER = { publish: "upgrade", upgrade: "config", config: "done" };

/** The step's PRE-state (nothing of it done; everything before it done), one provider. Throws (refuse) on any drift. */
async function preOf(c, t, plan, step, blockNumber) {
  const w = expectOf(t, plan, step);
  const n = BigInt(await call(c, t.admin, t.catalog, CATALOG_ABI, "numVersions", [plan.appId], blockNumber));
  assert.equal(n, w.n, step === "publish" ? `the catalog lists ${n} versions of ipns-publisher, not ${w.n}: 1.0.6 would not be index ${t.publish.index}; refused, replan`
    : `the catalog lists ${n} versions, not the ${w.n} expected after the publish; refused`);
  checkPrev(t, await call(c, t.admin, t.catalog, CATALOG_ABI, "getVersion", [plan.appId, BigInt(t.prev.index)], blockNumber));
  if (step !== "publish") checkVersion(t, await call(c, t.admin, t.catalog, CATALOG_ABI, "getVersion", [plan.appId, BigInt(t.publish.index)], blockNumber));
  const d = await call(c, t.admin, t.ledger, LEDGER_ABI, "get", [t.deployment.id], blockNumber);
  checkDeployment(t, plan, d, w);
  return { numVersions: n, deployment: d };
}

/** The step's POST-state reads for the simulation bundle and for verification. */
const postReads = (t, plan, step) => step === "publish"
  ? [["numVersions", t.catalog, CATALOG_ABI, "numVersions", [plan.appId]], ["version", t.catalog, CATALOG_ABI, "getVersion", [plan.appId, BigInt(t.publish.index)]],
     ["app", t.catalog, CATALOG_ABI, "getApp", [plan.appId]], ["deployment", t.ledger, LEDGER_ABI, "get", [t.deployment.id]]]
  : [["deployment", t.ledger, LEDGER_ABI, "get", [t.deployment.id]], ["numVersions", t.catalog, CATALOG_ABI, "numVersions", [plan.appId]]];
function checkPost(t, plan, step, v, before, { simulated }) {
  const w = expectOf(t, plan, AFTER[step]);
  assert.equal(BigInt(v.numVersions), w.n, `expected ${w.n} versions after ${step}`);
  if (step === "publish") { checkVersion(t, v.version); checkApp(t, plan, v.app); }
  checkDeployment(t, plan, v.deployment, w);
  // nothing else of the deployment moved: in a simulation (same block) the whole record; on chain, the stable fields
  if (simulated) assert.deepEqual(norm({ ...v.deployment, appRef: 0, configCid: 0 }), norm({ ...before.deployment, appRef: 0, configCid: 0 }), `${step} changed another field of the deployment`);
  else assert.deepEqual(depView(v.deployment), depView(before.deployment), `${step} changed another field of the deployment`);
}

async function simulate(c, blockNumber, calls) {
  const got = (await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false }, toHex(blockNumber)] }))?.[0]?.calls;
  assert.ok(Array.isArray(got) && got.length === calls.length, "simulation returned an unexpected result");
  got.forEach((x, i) => assert.equal(x.status, "0x1", `simulated call ${i} failed`));
  return got;
}
const readCalls = (t, reads) => reads.map(([, to, abi, fn, args]) => ({ from: t.admin, to, data: encodeFunctionData({ abi, functionName: fn, args }), gas: "0x1e8480", value: "0x0" }));
const decodeReads = (reads, got, offset) => Object.fromEntries(reads.map(([label, , abi, fn], i) => [label, decodeFunctionResult({ abi, functionName: fn, data: got[offset + i].returnData })]));

/** prepareTx({ t, plan, step, clients, reservedNonce, now }) -> the exact unsigned request, or throws (refusal). */
export async function prepareTx({ t, plan, step, clients, reservedNonce = null, now = Date.now() }) {
  pair(clients);
  const s = plan.steps.find((x) => x.step === step && x.kind === "transaction");
  assert.ok(s, "unknown step");
  const anchor = await anchorOf(clients, t);
  const tx = { from: t.admin, to: s.to, data: s.data, value: s.value, gas: hex(s.gasCap) };
  const reads = postReads(t, plan, step);
  const views = await Promise.all(clients.map(async (c) => {
    const pins = await pinsAt(c, t, plan, anchor.blockNumber);
    const pre = await preOf(c, t, plan, step, anchor.blockNumber);
    const got = await simulate(c, anchor.blockNumber, [tx, ...readCalls(t, reads)]);
    const post = decodeReads(reads, got, 1);
    checkPost(t, plan, step, post, pre, { simulated: true });
    return { ...pins, pre: norm(pre), post: norm(post), gasUsed: BigInt(got[0].gasUsed) };
  }));
  assert.deepEqual(norm({ ...views[0], pending: 0 }), norm({ ...views[1], pending: 0 }), "providers disagree on the owner, the pins or the step's state");
  for (const v of views) assert.equal(v.pending, v.nonce, "a transaction from the owner is pending or was mined after the anchor; wait and prepare again");
  const nonce = views[0].nonce;
  if (reservedNonce !== null) assert.equal(nonce, reservedNonce, `nonce ${reservedNonce} was handed to the wallet for this step and the account nonce is now ${nonce}: verify that transaction's hash; nothing is re-prepared`);
  const gas = (views[0].gasUsed * 125n + 99n) / 100n;
  assert.ok(gas > 0n && gas <= s.gasCap, "gas exceeds the reviewed cap");
  const tip = max((await Promise.all(clients.map((c) => c.estimateMaxPriorityFeePerGas()))).map(BigInt)), maxFeePerGas = anchor.baseFee * 2n + tip;
  assert.ok(maxFeePerGas > 0n && maxFeePerGas <= t.maxFeePerGas && tip <= maxFeePerGas, "fee exceeds the reviewed cap");
  const raw = serializeTransaction({ type: "eip1559", chainId: t.chainId, nonce, to: s.to, data: s.data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: tip });
  const l1 = max((await Promise.all(clients.map((c) => c.readContract({ address: t.oracle, abi: ORACLE_ABI, functionName: "getL1Fee", args: [raw], blockNumber: anchor.blockNumber })))).map(BigInt));
  const feeLimit = gas * maxFeePerGas + l1;
  assert.ok(views[0].balance >= feeLimit, "the owner's ETH balance does not cover this step's maximum fee");
  for (const c of clients) eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "preparation anchor changed");
  assert.ok(Date.now() - now < t.maxAgeMs, "preparation expired; prepare again");
  return { format: "ipns-publisher-release-operation/v1", status: "prepared; wallet approval required; nothing sent", step, n: s.n, opId: opIdOf(s), title: s.title, destination: s.destination,
    amountWei: "0", preparedAt: new Date(now).toISOString(), expiresAt: new Date(now + t.maxAgeMs).toISOString(),
    transaction: { from: lc(t.admin), to: lc(s.to), chainId: hex(t.chainId), type: "0x2", nonce: hex(nonce), data: s.data, value: "0x0", gas: hex(gas), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(tip) },
    anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, simulatedGasUsed: String(views[0].gasUsed), estimatedFeeLimitWei: String(feeLimit) };
}

const WANT_EVENTS = { publish: ["VersionPublished", "VersionApprovalSet"], upgrade: ["AppRefSet"], config: ["ConfigSet"] };
/** The landed transaction is exactly the request, with exactly the step's events. -> { outcome: "success" | "reverted" } (throws otherwise). */
export function checkLanding(t, plan, step, request, { transaction: tx, receipt }) {
  const w = request.transaction, s = plan.steps.find((x) => x.step === step);
  assert.equal(request.step, step, "the request is for another step"); assert.equal(request.opId, opIdOf(s), "the request is not this step's operation");
  eq(tx.from, w.from, "wrong sender"); eq(tx.to, w.to, "wrong recipient"); assert.equal(Number(tx.chainId), Number(BigInt(w.chainId)), "wrong chain");
  assert.equal(tx.type, "eip1559", "not an EIP-1559 transaction"); assert.equal(Number(tx.nonce), Number(BigInt(w.nonce)), "wrong nonce");
  eq(tx.input, w.data, "wrong calldata"); assert.equal(BigInt(tx.value), 0n, "the transaction carries ETH"); assert.equal(BigInt(tx.gas), BigInt(w.gas), "gas changed");
  assert.ok(BigInt(tx.maxFeePerGas) <= BigInt(w.maxFeePerGas), "wallet increased fee cap");
  assert.ok(BigInt(tx.maxPriorityFeePerGas) <= BigInt(w.maxPriorityFeePerGas), "wallet increased priority cap");
  assert.ok((tx.authorizationList ?? []).length === 0, "the transaction carries an authorization list");
  eq(receipt.transactionHash, tx.hash, "receipt hash differs"); eq(receipt.from, w.from, "receipt sender differs"); eq(receipt.to, w.to, "receipt recipient differs");
  if (receipt.status === "reverted") return { outcome: "reverted" };
  assert.equal(receipt.status, "success", "unknown receipt status");
  const logs = receipt.logs || [], want = WANT_EVENTS[step];
  assert.equal(logs.length, want.length, `expected exactly ${want.length} event(s)`);
  const abi = step === "publish" ? CATALOG_ABI : LEDGER_ABI, from = step === "publish" ? t.catalog : t.ledger;
  const ev = logs.map((l) => { eq(l.address, from, "an event is not from the step's contract"); return decodeEventLog({ abi, data: l.data, topics: l.topics }); });
  assert.deepEqual(ev.map((e) => e.eventName), want, "unexpected events");
  if (step === "publish") {
    eq(ev[0].args.appId, plan.appId, "VersionPublished appId"); assert.equal(BigInt(ev[0].args.index), BigInt(t.publish.index), "published index");
    assert.equal(ev[0].args.version, t.publish.version, "published label"); assert.equal(ev[0].args.cid, t.expectedCid, "published CID");
    eq(ev[1].args.appId, plan.appId); assert.equal(BigInt(ev[1].args.index), BigInt(t.publish.index)); assert.equal(Number(ev[1].args.status), 1, "not owner-approved");
  } else {
    eq(ev[0].args.id, t.deployment.id, `${want[0]} is for another deployment`);
    if (step === "upgrade") assert.equal(ev[0].args.appRef, plan.appRefNext, "AppRefSet reference");
    else assert.equal(ev[0].args.configCid, t.deployment.envelopeNew, "ConfigSet envelope");
  }
  return { outcome: "success" };
}

/** verifyTx({ t, plan, step, attempts, hash, clients }) -> { outcome: "confirmed" | "reverted", ... } or throws. */
export async function verifyTx({ t, plan, step, attempts, hash, clients }) {
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
    let landed; const errors = [];
    for (const request of attempts) { try { landed = checkLanding(t, plan, step, request, { transaction: tx, receipt }); break; } catch (e) { errors.push(e.message); } }
    if (!landed) {
      // the request's sender, nonce, recipient, calldata and value, but another gas limit or fee cap: the wallet altered it.
      // It landed; it is still refused, and the flow halts for review instead of waiting on it.
      const altered = attempts.some(({ transaction: w }) => lc(tx.from) === lc(w.from) && lc(tx.to) === lc(w.to) && Number(tx.nonce) === Number(BigInt(w.nonce))
        && lc(tx.input) === lc(w.data) && BigInt(tx.value) === BigInt(w.value) && Number(tx.chainId) === Number(BigInt(w.chainId)));
      throw Object.assign(new Error((altered ? "the wallet changed the gas limit or fee caps of this step's request; it landed but is not the reviewed transaction: halted for review, do not resend: "
        : "the transaction is not this step's request: ") + errors.join("; ")), { halt: altered });
    }
    let state = null;
    if (landed.outcome === "success") {
      const at = BigInt(receipt.blockNumber), reads = postReads(t, plan, step);
      const v = Object.fromEntries(await Promise.all(reads.map(async ([label, to, abi, fn, args]) => [label, await c.readContract({ address: to, abi, functionName: fn, args, blockNumber: at })])));
      const before = { deployment: await c.readContract({ address: t.ledger, abi: LEDGER_ABI, functionName: "get", args: [t.deployment.id], blockNumber: at - 1n }) };
      checkPost(t, plan, step, v, before, { simulated: false }); state = norm(v);
    }
    eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "the anchor block changed during verification");
    return { outcome: landed.outcome === "success" ? "confirmed" : "reverted", transactionHash: lc(hash), nonce: Number(tx.nonce),
      minedBlock: String(receipt.blockNumber), minedBlockHash: lc(receipt.blockHash), gasUsed: String(receipt.gasUsed), state, blockNumber: String(anchor.blockNumber), blockHash: lc(anchor.blockHash) };
  }));
  assert.deepEqual(results[0], results[1], "providers disagree on the landed transaction");
  return { ...results[0], step, verifiedAt: new Date().toISOString(), providers: 2 };
}

/** The explicit start: every pin and the publish pre-state on both providers (nothing is prepared). */
export async function startCheck({ t, plan, clients }) {
  pair(clients);
  const anchor = await anchorOf(clients, t);
  const views = await Promise.all(clients.map(async (c) => ({ ...(await pinsAt(c, t, plan, anchor.blockNumber)), pre: norm(await preOf(c, t, plan, "publish", anchor.blockNumber)) })));
  assert.deepEqual(norm({ ...views[0], pending: 0 }), norm({ ...views[1], pending: 0 }), "providers disagree on the owner or the pins");
  for (const v of views) assert.equal(v.pending, v.nonce, "a transaction from the owner is pending; wait for it before starting");
  return { checkedAt: new Date().toISOString(), anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, ownerNonce: views[0].nonce, ownerBalanceWei: String(views[0].balance),
    numVersions: String(views[0].pre.numVersions), deploymentAppRef: views[0].pre.deployment.appRef };
}

/**
 * The whole sequence, read-only: publish -> upgrade -> config simulated as ONE eth_simulateV1 bundle at the anchor on both
 * providers, each followed by its post reads and checks (the preflight evidence that steps 3 and 4 will hold after 2).
 */
export async function simulateSequence({ t, plan, clients }) {
  pair(clients);
  const anchor = await anchorOf(clients, t);
  const views = await Promise.all(clients.map(async (c) => {
    const pins = await pinsAt(c, t, plan, anchor.blockNumber);
    const pre = await preOf(c, t, plan, "publish", anchor.blockNumber);
    const calls = [], spans = [];
    for (const k of TX_STEPS) { const s = plan.steps.find((x) => x.step === k), reads = postReads(t, plan, k);
      spans.push([k, calls.length, reads]); calls.push({ from: t.admin, to: s.to, data: s.data, value: "0x0", gas: hex(s.gasCap) }, ...readCalls(t, reads)); }
    const got = await simulate(c, anchor.blockNumber, calls);
    let before = pre; const gas = {};
    for (const [k, at, reads] of spans) { const post = decodeReads(reads, got, at + 1); checkPost(t, plan, k, post, before, { simulated: true }); before = post; gas[k] = String(BigInt(got[at].gasUsed)); }
    return { nonce: pins.nonce, pending: pins.pending, balance: String(pins.balance), gas, final: norm({ appRef: before.deployment.appRef, configSha256: sha256(before.deployment.configCid) }) };
  }));
  assert.deepEqual({ ...views[0], pending: 0 }, { ...views[1], pending: 0 }, "providers disagree on the simulated sequence");
  return { anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, ...views[0] };
}

/** A lost wallet reply is released only when nothing used its nonce (the reviewed enrollment rule, reused unchanged). */
export const releaseCheck = ({ t, clients, nonce }) => releaseSiteCheck({ t, clients, nonce });
