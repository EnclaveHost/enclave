// The operator's ONE owner nomination on the ORIGINAL EnclaveHostOwnership (metal/guest/owner-nomination.mjs is the
// config). The host's operator key signs it inside its measured control; nothing here exports, returns or logs a key.
//
// Exactly one kind of transaction exists here: proposeOwner(config.hostId, config.owner) to config.ownershipContract,
// from the operator. It is sent only when ALL hold, read at one agreed, canonical block by an RPC quorum of the
// config's own providers (rpc-identity rules, client/lease-executor-authority.mjs leaseRpcSet):
//   - the contract's code hash is the reviewed one and its immutable registry() is the config's (and the host's) registry;
//   - registry.get(hostId) is active, names THIS operator key, and its endpoint is the config's (= the host's own);
//   - authority(hostId) is owner 0 AND pendingOwner 0;
//   - a simulation of exactly that call from the operator succeeds at that block.
// Already nominated (pending == owner) or already owned by that wallet: idempotent success, nothing sent. Any OTHER owner
// or pending: refused, never replaced. The send runs inside the host's one serialized operator queue (supervisor.js
// _txChain), re-reads and re-simulates at a FRESH agreed block first, signs locally, makes {hash, nonce, raw} durable
// (store.save throws -> nothing is broadcast), then broadcasts and waits (bounded) for the receipt. An ambiguous
// broadcast is resolved from the chain: a receipt decides; an account nonce past it means it can never land; otherwise
// the SAME bytes are re-broadcast, a bounded number of times. Sends are bounded too. Failures are logged and recorded;
// they never stop anything else the host does.
import { encodeFunctionData, decodeFunctionResult, keccak256, toBytes, parseAbi, createPublicClient, http } from "viem";
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
const lc = (v) => String(v || "").toLowerCase();
const TERMINAL = new Set(["done", "refused", "gave-up"]);

/**
 * createOwnerNominator({ nomination, local: {chainId, registry, endpoint, operator, hostId?}, queue, signer, store, log,
 *   allowLoopbackHttp, clients?, maxSends, maxRebroadcasts, receiptMs, confirmations, sleep })
 *   queue(job)   runs job() in the host's ONE serialized operator queue and returns its promise
 *   signer       { address, prepare(request) -> request, sign(request) -> raw 0x.., broadcast(raw) }  (no key access)
 *   store        { load() -> record|null, save(record) best-effort, saveDurable(record) MUST throw if it cannot persist }
 * -> { step() -> record, status() -> public view }
 */
export function createOwnerNominator({ nomination, local, queue, signer, store, log = () => {}, allowLoopbackHttp = false, clients = null,
  maxSends = 3, maxRebroadcasts = 3, receiptMs = 90_000, confirmations = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 20_000 }) {
  const n = checkOwnerNomination(nomination, { allowLoopbackHttp });
  const cs = clients || n.rpcs.map((url) => createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 1 }) }));
  const rpc = leaseRpcSet(cs, { quorum: n.quorum, allowLoopbackHttp, timeoutMs });
  const key = { ownershipContract: n.ownershipContract, hostId: n.hostId, owner: n.owner, operator: n.operator };
  let rec = store.load();
  if (!rec || rec.ownershipContract !== key.ownershipContract || rec.hostId !== key.hostId || rec.owner !== key.owner || rec.operator !== key.operator) {
    // a different (or no) earlier nomination: start a record for THIS config; an unresolved earlier tx is still resolved
    // below before anything is sent (its nonce is this operator's)
    rec = { ...key, status: "pending-check", sends: 0, tx: rec?.tx && rec.tx.state === "pending" && lc(rec.operator) === key.operator ? rec.tx : null, why: null };
  } else if (rec.status === "refused") rec = { ...rec, status: "pending-check" };   // a refusal is re-read once per boot (read-only)
  // the store gets a PLAIN JSON copy: the record lives in the host's state file, which one unserializable value would break
  const plain = () => JSON.parse(JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const save = () => { rec.updatedAt = new Date().toISOString(); try { store.save(plain()); } catch (e) { log(`[ownership] state save failed: ${e.message}`); } };
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
  /** -> null (send allowed), or {status, why} the snapshot settles. */
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
  async function quorumNonce() {
    return (await rpc.agree(rpc.peers, async (p) => Number(BigInt(await rpc.request(p.client, "eth_getTransactionCount", [n.operator, "latest"]))), "the operator nonce")).value;
  }
  /** Settle a signed nomination from the chain. -> true when it is settled (mined, reverted or dropped). */
  async function resolveTx() {
    const tx = rec.tx;
    const r = await quorumReceipt(tx.hash);
    if (r) { tx.state = r.status === "0x1" || r.status === "success" ? "mined" : "reverted"; tx.block = r.blockNumber; save(); return true; }
    if ((await quorumNonce()) > tx.nonce) { tx.state = "dropped"; save(); return true; }   // its nonce went to another tx
    if ((tx.rebroadcasts || 0) >= maxRebroadcasts) return false;
    tx.rebroadcasts = (tx.rebroadcasts || 0) + 1; save();
    try { await signer.broadcast(tx.raw); tx.broadcast = "accepted"; } catch { tx.broadcast = "unconfirmed"; }
    save();
    log(`[ownership] nomination ${tx.hash} (nonce ${tx.nonce}) re-broadcast ${tx.rebroadcasts}/${maxRebroadcasts}: ${tx.broadcast}`);
    return false;
  }
  async function waitReceipt() {
    const t0 = Date.now();
    while (Date.now() - t0 < receiptMs) { if (await quorumReceipt(rec.tx.hash).catch(() => null)) return; await sleep(2000); }
  }

  // inside the operator queue: fresh re-read + simulation, sign, durable, broadcast, bounded receipt wait
  async function sendJob() {
    const s = await snapshot({ simulate: true });
    const d = decide(s);
    if (d) return set(d.status, d.why, { block: s.block });
    if (s.sim !== "ok") return set("pending-check", `the simulation at block ${s.block.number} reverts; not sent`);
    const request = await signer.prepare({ to: n.ownershipContract, data: proposeData, value: 0n });
    if (Number(request.chainId) !== n.chainId) throw new Error(`the signer prepared chain ${request.chainId}, not ${n.chainId}`);
    if (lc(request.to) !== n.ownershipContract || request.data !== proposeData || BigInt(request.value || 0) !== 0n) throw new Error("the prepared request is not exactly proposeOwner");
    const raw = await signer.sign(request);
    rec.tx = { hash: lc(keccak256(raw)), nonce: Number(request.nonce), raw, state: "pending", broadcast: "not yet", signedAt: new Date().toISOString(), rebroadcasts: 0 };
    rec.sends++;
    rec.updatedAt = new Date().toISOString();
    store.saveDurable(plain());                               // durable BEFORE the transaction exists anywhere else (throws: not sent)
    try { await signer.broadcast(raw); rec.tx.broadcast = "accepted"; }
    catch (e) { rec.tx.broadcast = "unconfirmed"; rec.tx.broadcastWhy = String(e?.shortMessage || e?.message || e).slice(0, 160); }
    save();
    set("sent", `proposeOwner(${n.hostId}, ${n.owner}) signed ${rec.tx.hash} nonce ${rec.tx.nonce} (send ${rec.sends}/${maxSends}; broadcast ${rec.tx.broadcast})`);
    if (rec.tx.broadcast === "accepted") await waitReceipt();   // inside the queue slot: the next operator tx waits for it
    return rec;
  }

  let running = null;
  async function stepOnce() {
    if (TERMINAL.has(rec.status) && !(rec.tx && rec.tx.state === "pending")) return rec;
    const lp = localProblem();
    if (lp) return set("refused", lp);
    if (rec.tx && rec.tx.state === "pending") {
      if (!(await resolveTx())) return set("sent", `nomination ${rec.tx.hash} (nonce ${rec.tx.nonce}) not settled yet`);
    }
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
      running ||= stepOnce().catch((e) => set(rec.status === "sent" ? "sent" : "pending-check", `retry later: ${String(e?.message || e).slice(0, 200)}`))
        .finally(() => { running = null; });
      return running;
    },
    status() {
      const { tx, ...r } = rec;
      return { ...r, tx: tx ? { hash: tx.hash, nonce: tx.nonce, state: tx.state, broadcast: tx.broadcast, block: tx.block ?? null } : null };
    },
    terminal: () => TERMINAL.has(rec.status) && !(rec.tx && rec.tx.state === "pending"),
  };
}
