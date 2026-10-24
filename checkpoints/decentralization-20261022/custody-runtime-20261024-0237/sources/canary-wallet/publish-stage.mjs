// The publish stage: EnclaveAppCatalog.publishVersion for the canary, prepared FRESH on every /prepare by the vendored,
// reviewed read-only preparer (vendor/publish.mjs: two RPCs at one agreed block; book/ledger/catalog code hashes; owner
// = administrator and no pending handoff; new slug, unlisted CID; settled nonce; exact simulation; L2 + L1 bound +
// Isthmus operator fee within the caps; paced, budgeted, freshness-bounded reads). Nothing here signs or sends.
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, parseAbi } from "viem";
import { createPreparer, request as publishRequest, PRODUCTION as PUB, httpRpc } from "./vendor/publish.mjs";
import { pair } from "./rpc.mjs";

const lc = (x) => String(x ?? "").toLowerCase();
const hex = (n) => "0x" + BigInt(n).toString(16);
const eq = (a, b, what) => { if (lc(a) !== lc(b)) throw Error(`${what} (found ${a}, expected ${b})`); };
const stable = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v));

// the deployed catalog's (f2e9a71d0) read and event ABI, exactly as in its source
export const CATALOG_ABI = parseAbi([
  "struct Version { string cid; string version; uint32 vramMb; uint32 gpuGflops; uint32 memMb; uint32 cpuGflops; uint64 createdAt; bool verified; bool yanked; string ports; uint8 approval; string config; }",
  "struct App { bytes32 appId; address publisher; string slug; string name; string description; uint32 versionCount; uint64 createdAt; uint64 updatedAt; bool active; }",
  "function getApp(bytes32 appId) view returns (App)",
  "function getVersion(bytes32 appId, uint256 index) view returns (Version)",
  "function numVersions(bytes32 appId) view returns (uint256)",
  "function versionFee(bytes32 appId, uint256 index) view returns (uint256)",
  "event AppCreated(bytes32 indexed appId, address indexed publisher, string slug, string name)",
  "event VersionPublished(bytes32 indexed appId, uint256 indexed index, string version, string cid)",
  "event VersionApprovalSet(bytes32 indexed appId, uint256 indexed index, uint8 status)",
]);

export const PURPOSE = "Publish the custody-canary-proof component as a new, free, dedicated catalog listing (approved on publish)";

/** The only sender, target, calldata, value and chain this handoff can ever request. */
export function frozen(trust) {
  return { from: PUB.publisher, to: PUB.catalog, chainId: hex(trust.chainId), value: "0x0", data: publishRequest().data };
}
export function checkFrozen(request, trust) {
  const f = frozen(trust), t = request?.transaction;
  if (!t) throw Error("no transaction in the request");
  eq(t.from, f.from, "the request's sender is not the administrator"); eq(t.to, f.to, "the request's destination changed");
  eq(t.data, f.data, "the request's calldata changed"); eq(t.chainId, f.chainId, "the request's chain changed");
  if (BigInt(t.value) !== 0n) throw Error("the request's value changed");
}

/** A FRESH preparation (every check and cap of the reviewed preparer) -> the exact unsigned request. */
export async function prepare({ trust, preparer }) {
  const out = await preparer.prepare();
  const u = out.plan.unsignedTx;
  const transaction = { from: lc(u.from), to: lc(u.to), chainId: hex(u.chainId), type: "0x2", nonce: hex(u.nonce), data: u.data, value: "0x0",
    gas: hex(u.gas), maxFeePerGas: hex(u.maxFeePerGas), maxPriorityFeePerGas: hex(u.maxPriorityFeePerGas) };
  const request = { format: "enclave-canary-catalog-publish/v1", status: "prepared; wallet approval required; nothing sent", purpose: PURPOSE,
    preparedAt: out.plan.preparedAt, planHash: out.planHash, transaction, expected: out.plan.expected,
    anchor: { blockNumber: out.plan.observed.block, blockHash: out.plan.observed.blockHash }, fees: out.plan.observed.fees, caps: out.plan.caps,
    transport: out.plan.transport, balanceSufficient: out.plan.observed.balanceSufficient };
  checkFrozen(request, trust);
  if (!request.balanceSufficient) throw Error("the administrator's balance does not cover the bounded total fee; nothing was handed to MetaMask");
  return request;
}

/** A transaction (mined or pending) carries exactly the request's fields; the wallet may lower, never raise, the fee caps. */
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

/** Before a hash is recorded: some provider returns it with exactly the request's fields; any provider that returns it agrees. */
export function acceptHook({ trust, clients }) {
  return async (hash, request) => {
    checkFrozen(request, trust);
    const seen = await Promise.all(clients.map((c) => c.request("eth_getTransactionByHash", [hash]).catch(() => null)));
    const found = seen.filter(Boolean);
    if (!found.length) throw Error("neither provider returns this transaction yet; it is not recorded. Check again in a few seconds (MetaMask's activity tab shows its hash).");
    for (const tx of found) { eq(tx.hash, hash, "a provider returned another transaction"); checkTransaction(request, tx, trust); }
  };
}

const read = async (c, fn, args, tag) => decodeFunctionResult({ abi: CATALOG_ABI, functionName: fn,
  data: await c.request("eth_call", [{ to: PUB.catalog, data: encodeFunctionData({ abi: CATALOG_ABI, functionName: fn, args }) }, tag]) });
async function anchorOf(clients, trust) {
  const heads = await Promise.all(clients.map(async (c) => BigInt(await c.request("eth_blockNumber"))));
  const number = heads.reduce((a, b) => (a < b ? a : b)) - trust.confirmations;
  const blocks = await Promise.all(clients.map((c) => c.request("eth_getBlockByNumber", [hex(number), false])));
  if (blocks.some((b) => !b?.hash || lc(b.hash) !== lc(blocks[0].hash))) throw Error(`the providers disagree on block ${number}; check again shortly`);
  return { number, tag: hex(number), hash: lc(blocks[0].hash) };
}

/** verify -> exactly this transaction, two blocks deep and canonical on both providers, the exact events, and the readback. */
export async function verify({ trust, request, hash, clients }) {
  checkFrozen(request, trust);
  pair(clients);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error("invalid transaction hash");
  const anchor = await anchorOf(clients, trust);
  const want = publishRequest(), appId = lc(want.appId), r = PUB.request;
  const results = await Promise.all(clients.map(async (c) => {
    if (Number(BigInt(await c.request("eth_chainId"))) !== trust.chainId) throw Error("wrong chain");
    const [tx, receipt] = await Promise.all([c.request("eth_getTransactionByHash", [hash]), c.request("eth_getTransactionReceipt", [hash])]);
    if (!tx || !receipt) throw Error(`${c.host} has no receipt for this transaction yet; it may still be pending. Check again shortly.`);
    eq(tx.hash, hash, "a provider returned another transaction"); eq(receipt.transactionHash, hash, "the receipt is for another transaction");
    const mined = BigInt(receipt.blockNumber);
    if (mined > anchor.number) throw Error("the transaction is mined but lacks two later blocks; check again shortly");
    eq((await c.request("eth_getBlockByNumber", [hex(mined), false]))?.hash, receipt.blockHash, "the receipt's block is not canonical");
    eq(tx.blockHash, receipt.blockHash, "the transaction and receipt name different blocks");
    checkTransaction(request, tx, trust);
    if (receipt.status !== "0x1") throw Error("the transaction reverted");
    // exactly the catalog's events of a NEW app's first owner-published version (observed on the deployed runtime):
    // AppCreated, VersionPublished, VersionApprovalSet(…, 1). No fee event: the version is free.
    const logs = receipt.logs || [];
    if (logs.some((l) => lc(l.address) !== lc(PUB.catalog))) throw Error("a log from another contract");
    const ev = logs.map((l) => { try { return decodeEventLog({ abi: CATALOG_ABI, data: l.data, topics: l.topics }); } catch { return null; } });
    const names = ev.map((e) => e?.eventName ?? "unknown").join(",");
    if (names !== "AppCreated,VersionPublished,VersionApprovalSet") throw Error(`unexpected catalog events: ${names}`);
    const [created, published, approved] = ev;
    eq(created.args.appId, appId, "AppCreated names another app"); eq(created.args.publisher, PUB.publisher, "AppCreated names another publisher");
    if (created.args.slug !== r.slug || created.args.name !== r.name) throw Error("AppCreated names another slug or name");
    eq(published.args.appId, appId, "VersionPublished names another app");
    if (published.args.index !== 0n || published.args.version !== r.version || published.args.cid !== r.cid) throw Error("VersionPublished names another index, version or CID");
    eq(approved.args.appId, appId, "the approval names another app");
    if (approved.args.index !== 0n || Number(approved.args.status) !== 1) throw Error("the version was not approved on publish");
    const [app, v, count, fee] = await Promise.all([read(c, "getApp", [appId], anchor.tag), read(c, "getVersion", [appId, 0n], anchor.tag),
      read(c, "numVersions", [appId], anchor.tag), read(c, "versionFee", [appId, 0n], anchor.tag)]);
    eq(app.appId, appId, "getApp names another app"); eq(app.publisher, PUB.publisher, "the app's publisher is not the administrator");
    if (app.slug !== r.slug || app.name !== r.name || app.description !== r.description || !app.active || Number(app.versionCount) !== 1) throw Error("the stored app record differs from the request");
    if (v.cid !== r.cid || v.version !== r.version || v.config !== r.config || v.ports !== r.ports || Number(v.approval) !== 1 || v.yanked
        || [v.vramMb, v.gpuGflops, v.memMb, v.cpuGflops].map(Number).join() !== r.res.join()) throw Error("the stored version differs from the request");
    if (count !== 1n) throw Error(`the app has ${count} versions, not 1`);
    if (fee !== 0n) throw Error("the version carries a fee");
    return { transactionHash: lc(hash), minedBlock: String(mined), minedBlockHash: lc(receipt.blockHash), anchorBlock: String(anchor.number), anchorBlockHash: anchor.hash,
      appId, index: "0", approval: "approved", cid: v.cid, memMb: Number(v.memMb), cpuGflops: Number(v.cpuGflops), config: v.config };
  }));
  if (stable(results[0]) !== stable(results[1])) throw Error("the providers disagree on the confirmed transaction");
  return { status: "publication verified: the canary is listed, approved, free", verifiedAt: new Date().toISOString(), providers: 2, ...results[0],
    catalogRef: `catalog://${appId}/0` };
}

/**
 * An attempt handed to MetaMask with no known hash: decide from the chain whether its nonce can still be used.
 *   nonce consumed + listing present -> NOT reset: the canary was published; supply the hash (MetaMask activity) to verify
 *   nonce consumed + no listing      -> reset: another transaction used the nonce, so the prepared one can never be mined
 *   nonce unused on both, none pending, and the attempt older than reconcileMinAgeMs -> reset: nothing was sent
 *   anything else (pending, too early, disagreement) -> NOT reset
 * After any reset the next /prepare re-reads everything; a listing that appears later makes it refuse.
 */
export function reconcileHook({ trust, clients, now = () => Date.now() }) {
  return async (request) => {
    checkFrozen(request, trust);
    pair(clients);
    const nonce = BigInt(request.transaction.nonce), from = request.transaction.from, appId = publishRequest().appId;
    const reads = await Promise.all(clients.map(async (c) => ({ latest: BigInt(await c.request("eth_getTransactionCount", [from, "latest"])),
      pending: BigInt(await c.request("eth_getTransactionCount", [from, "pending"])), versions: await read(c, "numVersions", [appId], "latest") })));
    if (stable(reads[0]) !== stable(reads[1])) return { reset: false, reason: "the two providers disagree; check again shortly" };
    const { latest, pending, versions } = reads[0];
    if (latest > nonce && versions > 0n) return { reset: false, published: true, reason: "the prepared nonce was used and the canary is listed: enter the transaction hash from MetaMask's activity tab to verify it" };
    if (latest > nonce) return { reset: true, reason: `nonce ${nonce} was used by another transaction and nothing was listed; the prepared transaction can never be mined` };
    if (pending !== latest) return { reset: false, reason: "an administrator transaction is pending; wait for it and check again" };
    const age = now() - Date.parse(request.preparedAt);
    if (!(age >= trust.reconcileMinAgeMs)) return { reset: false, reason: `prepared ${Math.round(age / 1000)} s ago: first reject any open request in MetaMask, then reconcile after ${trust.reconcileMinAgeMs / 1000} s` };
    return { reset: true, reason: `nonce ${nonce} is unused on both providers and nothing is pending: nothing was sent` };
  };
}

/** The reviewed preparer bound to this handoff's trust (tests pass loopback RPCs, a clock and the ledger-only seam). */
export function makePreparer(trust, { rpc = httpRpc(15_000), clock, ledgerCodeHashOf } = {}) {
  const cfg = trust.rpcs === PUB.rpcs ? PUB : { ...PUB, rpcs: trust.rpcs };
  return createPreparer({ cfg, rpc, ...(clock ? { clock } : {}), ...(ledgerCodeHashOf ? { ledgerCodeHashOf } : {}) });
}
