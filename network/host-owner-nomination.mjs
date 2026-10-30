// The operator's ONE owner nomination on the ORIGINAL EnclaveHostOwnership (metal/guest/owner-nomination.mjs is the
// config). The host's operator key signs it inside its measured control; nothing here exports, returns or logs a key.
//
// Exactly one kind of transaction exists here: proposeOwner(config.hostId, config.owner) to config.ownershipContract,
// from the operator. A NEW one is signed only when ALL hold, read at one agreed, canonical block by an RPC quorum of the
// config's own providers (rpc-identity rules, client/lease-executor-authority.mjs leaseRpcSet):
//   - the contract's code hash is the reviewed one and its immutable registry() is the config's (and the host's) registry;
//   - registry.get(hostId) is active, names THIS operator key, and its endpoint is the config's (= the host's own);
//   - authority(hostId) is owner 0 AND pendingOwner 0;
//   - a simulation of exactly that call from the operator succeeds at that block.
// Already nominated (pending == owner) or already owned by that wallet: idempotent success, nothing sent. Any OTHER owner
// or pending: refused, never replaced.
//
// The journal (store; the host's state file) is the ONLY authority for what may be broadcast:
//   - a signed nomination is adopted into the record only after store.saveDurable succeeded with it; if that throws, the
//     signed bytes are dropped (never broadcast, not counted as a send) and the next pass decides again;
//   - every RE-broadcast of a recorded nomination is preceded by its own successful saveDurable (counter included);
//   - a pending nomination loaded from the journal is checked before anything is done with it: keccak256(raw) == hash,
//     raw parses with the recorded nonce and this chain, it goes to the recorded contract with value 0 and calldata
//     exactly proposeOwner(recorded host, recorded owner), and it recovers to the recorded operator. Any mismatch: the
//     record is left as it is and nothing is ever sent ("blocked-journal": manual reconciliation);
//   - a pending nomination recorded under ANOTHER config (contract, host, owner or operator) is kept verbatim as
//     `unresolved` and only OBSERVED (its receipt, or its operator's nonce passing it). It is never re-broadcast, and nothing
//     new is signed while it may still land ("blocked-unresolved"); once settled it moves to `history` and this config is
//     decided on the chain as it then is (a landed old nomination makes this one a conflict).
// A recorded nomination of THIS config that has not settled is re-broadcast (the same bytes, bounded) only when a fresh
// snapshot taken INSIDE its operator-queue slot (right before the durable write and the broadcast) still shows it
// unsettled, owner 0 / pending 0 and the bindings; a matching nomination already on chain is success and a conflict stops
// it - either way the recorded one stays recorded and observed. Sends, re-broadcasts and the receipt wait
// are bounded, and everything that sends runs inside the host's ONE serialized operator queue (supervisor.js _txChain).
// A failure is recorded as a retryable state; nothing else the host does waits on it.
import { encodeFunctionData, decodeFunctionResult, keccak256, toBytes, parseAbi, createPublicClient, http, parseTransaction, recoverTransactionAddress } from "viem";
import { leaseRpcSet } from "../client/lease-executor-authority.mjs";
import { checkOwnerNomination } from "../metal/guest/owner-nomination.mjs";

export const OWNERSHIP_ABI = parseAbi([
  "function proposeOwner(bytes32 hostId, address next)",
  "function registry() view returns (address)",
  "function authority(bytes32) view returns (address owner, address pendingOwner, uint64 revision, bytes32 policyHash)",
]);
// the registry entry as the ownership contract itself reads it (IHostOwnershipRegistry.Entry: the first seven fields)
const REGISTRY_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" }] }] }];
const ZERO = "0x" + "0".repeat(40);
const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/;
const lc = (v) => String(v || "").toLowerCase();
const TERMINAL = new Set(["done", "refused", "gave-up", "blocked-journal"]);
const plainOf = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const pending = (r) => !!(r && r.tx && r.tx.state === "pending");

/** The recorded nomination checked against its own record (contract, host, owner, operator) and chain. -> null | why */
export async function journalProblem(r, chainId) {
  if (!r || typeof r !== "object") return "the record is not an object";
  for (const k of ["ownershipContract", "operator", "owner"]) if (!ADDR.test(String(r[k]))) return `the record's ${k} is malformed`;
  if (!B32.test(String(r.hostId))) return "the record's hostId is malformed";
  const t = r.tx;
  if (!t || typeof t !== "object") return "the record names no transaction";
  if (!B32.test(String(t.hash))) return "the recorded hash is malformed";
  if (typeof t.raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(t.raw)) return "the recorded signed bytes are malformed";
  if (lc(keccak256(t.raw)) !== t.hash) return "the recorded signed bytes do not hash to the recorded hash";
  let p; try { p = parseTransaction(t.raw); } catch { return "the recorded signed bytes do not parse"; }
  if (!Number.isSafeInteger(t.nonce) || Number(p.nonce) !== t.nonce) return `the signed nonce ${p.nonce} is not the recorded ${t.nonce}`;
  if (Number(p.chainId) !== chainId) return `the signed chain ${p.chainId} is not ${chainId}`;
  if (lc(p.to) !== r.ownershipContract) return `the signed transaction goes to ${lc(p.to)}, not the recorded contract ${r.ownershipContract}`;
  if (BigInt(p.value ?? 0n) !== 0n) return "the signed transaction carries value";
  if (lc(p.data) !== lc(encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "proposeOwner", args: [r.hostId, r.owner] })))
    return "the signed calldata is not exactly proposeOwner(recorded host, recorded owner)";
  let signer; try { signer = lc(await recoverTransactionAddress({ serializedTransaction: t.raw })); } catch { return "the signed bytes carry no recoverable signature"; }
  if (signer !== r.operator) return `the signed transaction is from ${signer}, not the recorded operator ${r.operator}`;
  return null;
}

/**
 * createOwnerNominator({ nomination, local: {chainId, registry, endpoint, operator, hostId?}, queue, signer, store, log,
 *   allowLoopbackHttp, clients?, maxSends, maxRebroadcasts, receiptMs, confirmations, sleep })
 *   queue(job)   runs job() in the host's ONE serialized operator queue and returns its promise
 *   signer       { address, prepare(request) -> request, sign(request) -> raw 0x.., broadcast(raw) }  (no key access)
 *   store        { load() -> record|null, save(record) best-effort, saveDurable(record) MUST throw if it cannot persist }
 * -> { step() -> record, status() -> public view, terminal() }
 */
export function createOwnerNominator({ nomination, local, queue, signer, store, log = () => {}, allowLoopbackHttp = false, clients = null,
  maxSends = 3, maxRebroadcasts = 3, receiptMs = 90_000, confirmations = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 20_000 }) {
  const n = checkOwnerNomination(nomination, { allowLoopbackHttp });
  const cs = clients || n.rpcs.map((url) => createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 1 }) }));
  const rpc = leaseRpcSet(cs, { quorum: n.quorum, allowLoopbackHttp, timeoutMs });
  const key = { ownershipContract: n.ownershipContract, hostId: n.hostId, owner: n.owner, operator: n.operator };
  const sameKey = (r) => !!r && r.ownershipContract === key.ownershipContract && r.hostId === key.hostId && r.owner === key.owner && r.operator === key.operator;
  const loaded = store.load();
  let rec;
  if (sameKey(loaded)) {
    rec = { ...loaded };
    if (rec.status === "refused" && !pending(rec)) rec.status = "pending-check";   // a refusal is re-read once per boot (read-only)
  } else {
    // a different (or no) earlier record: THIS config starts fresh; every nomination the earlier one may still land is
    // carried VERBATIM as unresolved (observed, never re-broadcast), and its settled history is kept
    const carried = loaded && typeof loaded === "object" ? loaded : null;
    const unresolved = [...(Array.isArray(carried?.unresolved) ? carried.unresolved : []),
                        ...(pending(carried) ? [Object.fromEntries(Object.entries(carried).filter(([k]) => !["unresolved", "history"].includes(k)))] : [])];
    rec = { ...key, status: "pending-check", why: null, sends: 0, tx: null, ...(unresolved.length ? { unresolved } : {}),
            ...(Array.isArray(carried?.history) && carried.history.length ? { history: carried.history } : {}) };
  }
  rec.persistFailures = 0;
  const save = () => { rec.updatedAt = new Date().toISOString(); try { store.save(plainOf(rec)); } catch (e) { log(`[ownership] state save failed: ${e.message}`); } };
  /** saveDurable(next) succeeded -> rec becomes next and true; else rec is unchanged and false (nothing may be broadcast) */
  const durable = (next, what) => {
    const candidate = { ...next, updatedAt: new Date().toISOString() };
    try { store.saveDurable(plainOf(candidate)); }
    catch (e) { rec.persistFailures = (rec.persistFailures || 0) + 1; log(`[ownership] ${what} NOT broadcast: the journal could not be made durable (${e.message})`); return false; }
    rec = candidate; return true;
  };
  const set = (status, why, extra = {}) => {
    const changed = rec.status !== status || rec.why !== why;
    Object.assign(rec, { status, why }, extra);
    if (changed) log(`[ownership] ${status}: ${why}`);
    save();
    return rec;
  };

  // local bindings: the config must describe THIS host, THIS chain, THIS registry and THIS operator key
  function localProblem() {
    if (n.chainId !== local.chainId) return `config chain ${n.chainId} is not this host's chain ${local.chainId}`;
    if (n.registry !== lc(local.registry)) return `config registry ${n.registry} is not this host's registry ${lc(local.registry)}`;
    if (n.endpoint !== String(local.endpoint || "").replace(/\/+$/, "")) return `config endpoint ${n.endpoint} is not this host's endpoint ${local.endpoint}`;
    if (n.hostId !== lc(keccak256(toBytes(n.endpoint)))) return "config hostId is not keccak256(endpoint)";
    if (local.hostId && n.hostId !== lc(local.hostId)) return `config hostId ${n.hostId} is not this host's registered id ${lc(local.hostId)}`;
    if (n.operator !== lc(local.operator) || n.operator !== lc(signer.address)) return `config operator ${n.operator} is not this host's operator key ${lc(signer.address)}`;
    return null;
  }

  // one agreed canonical block (quorum-th highest head - confirmations), every read bound to its hash
  async function agreedBlock(depth = confirmations) {
    const heads = (await Promise.allSettled(rpc.peers.map(async (p) => {
      if (BigInt(await rpc.request(p.client, "eth_chainId", [])) !== BigInt(n.chainId)) throw new Error("wrong chain");
      return { ...p, head: BigInt(await rpc.request(p.client, "eth_blockNumber", [])) };
    }))).filter((x) => x.status === "fulfilled").map((x) => x.value);
    if (heads.length < rpc.required) throw new Error("the RPC quorum cannot read the configured chain");
    const target = heads.map((h) => h.head).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))[rpc.required - 1] - BigInt(depth);
    const agreed = await rpc.agree(heads, async (p) => {
      const b = await rpc.request(p.client, "eth_getBlockByNumber", ["0x" + target.toString(16), false]);
      if (!b || BigInt(b.number) !== target) throw new Error("invalid block");
      return { number: target.toString(), hash: lc(b.hash) };   // a string: the record lands in the host's JSON state file
    }, "the nomination block");
    return { block: agreed.value, members: agreed.members };
  }
  const call = (p, to, data, at, from) => rpc.request(p.client, "eth_call", [{ to, data, ...(from ? { from } : {}) }, at]);
  const proposeData = encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "proposeOwner", args: [n.hostId, n.owner] });

  /** The chain's word at one agreed block: code, binding, registry entry, authority and (optionally) the simulation. */
  async function snapshot({ simulate = false } = {}) {
    const { block, members } = await agreedBlock();
    const at = { blockHash: block.hash, requireCanonical: true };
    const s = await rpc.agree(members, async (p) => {
      const [code, reg, auth, entry] = await Promise.all([
        rpc.request(p.client, "eth_getCode", [n.ownershipContract, at]),
        call(p, n.ownershipContract, encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "registry" }), at),
        call(p, n.ownershipContract, encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "authority", args: [n.hostId] }), at),
        call(p, n.registry, encodeFunctionData({ abi: REGISTRY_ABI, functionName: "get", args: [n.hostId] }), at),
      ]);
      const [owner, pendingOwner, revision] = decodeFunctionResult({ abi: OWNERSHIP_ABI, functionName: "authority", data: auth });
      const e = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "get", data: entry });
      let sim = null;
      if (simulate) {
        // providers word a revert differently: the quorum agrees on the outcome only
        try { await call(p, n.ownershipContract, proposeData, at, n.operator); sim = "ok"; } catch { sim = "reverts"; }
      }
      return { codeHash: lc(keccak256(code)), registry: lc(decodeFunctionResult({ abi: OWNERSHIP_ABI, functionName: "registry", data: reg })),
               owner: lc(owner), pendingOwner: lc(pendingOwner), revision: String(revision),
               entry: { endpoint: e.endpoint, operator: lc(e.operator), active: e.active }, sim };
    }, "the ownership state");
    return { ...s.value, block };
  }
  /** -> null (owner 0 / pending 0 and every binding holds: a nomination may go out), or {status, why} the snapshot settles. */
  function decide(s) {
    if (s.codeHash !== n.ownershipCodeHash) return { status: "refused", why: `contract code hash ${s.codeHash} is not the reviewed ${n.ownershipCodeHash}` };
    if (s.registry !== n.registry) return { status: "refused", why: `the contract is bound to registry ${s.registry}, not ${n.registry}` };
    if (s.owner === n.owner && s.pendingOwner === ZERO) return { status: "done", why: `owner ${n.owner} already accepted (revision ${s.revision}); nothing to send` };
    if (s.owner === ZERO && s.pendingOwner === n.owner) return { status: "done", why: `${n.owner} is nominated; the owner wallet accepts next (acceptOwner)` };
    if (s.owner !== ZERO || s.pendingOwner !== ZERO)
      return { status: "refused", why: `the host already has owner ${s.owner} / pending ${s.pendingOwner}: never replaced from here` };
    // not (yet) registered or inactive: retry later (the host registers itself at boot); another operator: refused
    if (s.entry.operator === ZERO || !s.entry.active) return { status: "pending-check", why: "the registry entry is not registered/active yet; retry later" };
    if (s.entry.operator !== n.operator) return { status: "refused", why: `the registry names operator ${s.entry.operator}, not ${n.operator}` };
    if (s.entry.endpoint !== n.endpoint) return { status: "refused", why: `the registry entry's endpoint ${s.entry.endpoint} is not ${n.endpoint}` };
    return null;
  }

  async function quorumReceipt(hash) {
    return (await rpc.agree(rpc.peers, async (p) => {
      const r = await rpc.request(p.client, "eth_getTransactionReceipt", [hash]);
      return r ? { status: r.status, blockNumber: String(BigInt(r.blockNumber)), blockHash: lc(r.blockHash), to: lc(r.to) } : null;
    }, "the nomination receipt")).value;
  }
  async function quorumNonce(address) {
    return (await rpc.agree(rpc.peers, async (p) => Number(BigInt(await rpc.request(p.client, "eth_getTransactionCount", [address, "latest"]))), "the operator nonce")).value;
  }
  /** A recorded nomination, observed on the chain only: "mined" | "reverted" | "dropped" (its nonce went elsewhere) | null. */
  async function observe(r) {
    const receipt = await quorumReceipt(r.tx.hash);
    if (receipt) return { state: receipt.status === "0x1" || receipt.status === "success" ? "mined" : "reverted", block: receipt.blockNumber };
    if ((await quorumNonce(r.operator)) > r.tx.nonce) return { state: "dropped" };
    return null;
  }
  async function waitReceipt(hash) {
    const t0 = Date.now();
    while (Date.now() - t0 < receiptMs) { if (await quorumReceipt(hash).catch(() => null)) return; await sleep(2000); }
  }

  // inside the operator queue: fresh re-read + simulation, sign, DURABLE, then broadcast, bounded receipt wait
  async function sendJob() {
    const s = await snapshot({ simulate: true });
    const d = decide(s);
    if (d) return set(d.status, d.why, { block: s.block });
    if (s.sim !== "ok") return set("pending-check", `the simulation at block ${s.block.number} reverts; not sent`);
    const request = await signer.prepare({ to: n.ownershipContract, data: proposeData, value: 0n });
    if (Number(request.chainId) !== n.chainId) throw new Error(`the signer prepared chain ${request.chainId}, not ${n.chainId}`);
    if (lc(request.to) !== n.ownershipContract || request.data !== proposeData || BigInt(request.value || 0) !== 0n) throw new Error("the prepared request is not exactly proposeOwner");
    const raw = await signer.sign(request);
    const tx = { hash: lc(keccak256(raw)), nonce: Number(request.nonce), raw, state: "pending", broadcast: "not yet", signedAt: new Date().toISOString(), rebroadcasts: 0 };
    if (!durable({ ...rec, tx, sends: rec.sends + 1, status: "sent", why: `proposeOwner signed ${tx.hash} nonce ${tx.nonce}; broadcasting` }, `nomination ${tx.hash}`))
      return set("pending-check", "the signed nomination could not be made durable: dropped, nothing broadcast; retry later");
    try { await signer.broadcast(raw); rec.tx.broadcast = "accepted"; }
    catch (e) { rec.tx.broadcast = "unconfirmed"; rec.tx.broadcastWhy = String(e?.shortMessage || e?.message || e).slice(0, 160); }
    set("sent", `proposeOwner(${n.hostId}, ${n.owner}) signed ${rec.tx.hash} nonce ${rec.tx.nonce} (send ${rec.sends}/${maxSends}; broadcast ${rec.tx.broadcast})`);
    if (rec.tx.broadcast === "accepted") await waitReceipt(rec.tx.hash);   // inside the queue slot: the next operator tx waits (bounded)
    return rec;
  }
  /** This config's recorded, pending nomination against the chain as it is NOW: -> "settled" (receipt or nonce passed:
   *  recorded), a settled record (the snapshot decided: done / refused / pending-check, or the re-broadcast bound is
   *  reached - it stays recorded and observed), or null (owner 0 / pending 0 and every binding holds: it may go out again). */
  async function recheckPending() {
    const o = await observe(rec);
    if (o) { rec.tx.state = o.state; if (o.block) rec.tx.block = o.block; save(); return "settled"; }
    const s = await snapshot();
    const d = decide(s);
    if (d) return set(d.status, `${d.why} (recorded nomination ${rec.tx.hash} stays recorded and is observed, not re-broadcast)`, { block: s.block });
    if ((rec.tx.rebroadcasts || 0) >= maxRebroadcasts) return set("sent", `nomination ${rec.tx.hash} not settled after ${maxRebroadcasts} re-broadcasts; observed only`);
    return null;
  }
  // inside the operator queue: the SAME recorded bytes again. The queue may have waited behind other operator transactions,
  // so the chain is re-read HERE (as sendJob does): settled meanwhile, another pending/owner, a lost registry entry or the
  // bound reached -> nothing is broadcast. Then the counter is made durable, then the bytes go out.
  async function rebroadcastJob() {
    if (!pending(rec)) return rec;
    const r = await recheckPending();
    if (r) return rec;
    const tx = { ...rec.tx, rebroadcasts: (rec.tx.rebroadcasts || 0) + 1, lastRebroadcastAt: new Date().toISOString() };
    if (!durable({ ...rec, tx }, `re-broadcast of ${tx.hash}`)) return set("sent", `nomination ${tx.hash} not settled; the journal is not durable, so it is NOT re-broadcast`);
    try { await signer.broadcast(rec.tx.raw); rec.tx.broadcast = "accepted"; } catch { rec.tx.broadcast = "unconfirmed"; }
    return set("sent", `nomination ${rec.tx.hash} (nonce ${rec.tx.nonce}) re-broadcast ${rec.tx.rebroadcasts}/${maxRebroadcasts}: ${rec.tx.broadcast}`);
  }

  // every recorded nomination is checked once per process before anything is done with it
  let checked = null;
  async function checkJournal() {
    for (const [i, u] of (rec.unresolved || []).entries()) {
      const why = await journalProblem(u, n.chainId);
      if (why) return `unresolved earlier nomination #${i} (${u?.tx?.hash ?? "no hash"}): ${why}`;
    }
    if (pending(rec)) { const why = await journalProblem(rec, n.chainId); if (why) return `the recorded nomination ${rec.tx.hash ?? "(no hash)"}: ${why}`; }
    return null;
  }

  let running = null;
  async function stepOnce() {
    if (checked === null) checked = await checkJournal();
    if (checked) return set("blocked-journal", `${checked}; nothing is sent and the record is kept for manual reconciliation`);
    // 1. nominations recorded under another config: observed until settled; nothing new while any may still land
    if (rec.unresolved?.length) {
      const still = [];
      for (const u of rec.unresolved) {
        const o = await observe(u);
        if (o) rec.history = [...(rec.history || []), { ...u, tx: { ...u.tx, state: o.state, ...(o.block ? { block: o.block } : {}) }, settledAt: new Date().toISOString() }];
        else still.push(u);
      }
      if (still.length) rec.unresolved = still; else delete rec.unresolved;
      if (still.length) return set("blocked-unresolved",
        `${still.length} earlier nomination(s) under another config may still land (${still.map((u) => `${u.tx.hash} -> ${u.owner}`).join(", ")}): observed, never re-broadcast; nothing new is sent until settled`);
      save();
    }
    if (TERMINAL.has(rec.status) && !pending(rec)) return rec;
    const lp = localProblem();
    if (lp) return set("refused", lp);
    // 2. this config's own recorded nomination: settle from the chain, else re-check everything before re-broadcasting it
    if (pending(rec)) {
      const r = await recheckPending();                     // a cheap early answer; rebroadcastJob checks again in its slot
      if (r && r !== "settled") return r;
      if (!r) return queue(rebroadcastJob);
    }
    // 3. decide on the chain as it is now
    const s = await snapshot();
    const d = decide(s);
    if (d) return set(d.status, d.why, { block: s.block });
    if (rec.tx && rec.tx.state === "mined") return set("pending-check", `nomination ${rec.tx.hash} mined but the agreed block does not show it yet`);
    if (rec.sends >= maxSends) return set("gave-up", `${rec.sends} nomination(s) sent without the contract showing it; not sending again`);
    return queue(sendJob);
  }
  return {
    nomination: n,
    /** One pass (serialized: concurrent callers share it). Errors become a recorded, retryable state, never a throw. */
    step() {
      running ||= stepOnce().catch((e) => set(rec.status === "sent" || rec.status === "blocked-unresolved" ? rec.status : "pending-check", `retry later: ${String(e?.message || e).slice(0, 200)}`))
        .finally(() => { running = null; });
      return running;
    },
    status() {
      const view = (t) => (t ? { hash: t.hash, nonce: t.nonce, state: t.state, broadcast: t.broadcast, block: t.block ?? null, rebroadcasts: t.rebroadcasts ?? 0 } : null);
      const { tx, unresolved, history, ...r } = rec;
      return { ...r, tx: view(tx), ...(unresolved ? { unresolved: unresolved.map((u) => ({ ownershipContract: u.ownershipContract, hostId: u.hostId, owner: u.owner, tx: view(u.tx) })) } : {}),
               ...(history ? { history: history.map((u) => ({ owner: u.owner, tx: view(u.tx) })) } : {}) };
    },
    terminal: () => TERMINAL.has(rec.status) && !pending(rec) && !rec.unresolved?.length,
  };
}
