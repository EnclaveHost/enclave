/* ============================================================
   Agreeing chain reads for independent mode.

   Decisions that move money or authority (which deployments a wallet
   owns, a record's owner and lease before an owner action, registry
   prices that become a deployment's spend ceiling, a session vault's
   address) are read from ONE block that at least `quorum` of the
   profile's RPC origins name by the same hash, and every eth_call must
   return the same bytes from `quorum` of them at that block hash
   (EIP-1898). A single RPC can then delay a decision but not decide it.

   This is RPC agreement, not a light client: origins that collude, or
   that all front the same provider, can still agree on a lie. The
   contracts themselves remain authoritative for every write.
   ============================================================ */

export class QuorumError extends Error {
  constructor(message, detail){ super(message); this.name = "QuorumError"; this.detail = detail || null; }
}

const HEX = /^0x[0-9a-f]*$/i;
const asNumber = (h, what) => {
  if (typeof h !== "string" || !/^0x[0-9a-f]+$/i.test(h)) throw new Error("bad " + what);
  const n = Number(BigInt(h));
  if (!Number.isSafeInteger(n)) throw new Error("bad " + what);
  return n;
};

/* rpc(url, method, params) -> result; throws on transport/JSON-RPC errors.
   A revert carries `revert: true` so agreement on a revert is reportable. */
export function jsonRpc(fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 8000){
  let id = 0;
  return async (url, method, params) => {
    const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit",
      redirect: "error", cache: "no-store", body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j && j.error){
      const e = new Error(String(j.error.message || "rpc error").slice(0, 300));
      e.revert = /revert/i.test(e.message) || j.error.code === 3;
      e.data = j.error.data;
      throw e;
    }
    return j ? j.result : undefined;
  };
}

export function createQuorumReader({ rpcs, quorum, confirmations = 2, maxBlockAgeSeconds = 600, chainId,
  rpc = jsonRpc(), now = () => Math.floor(Date.now() / 1000) }){
  if (!Array.isArray(rpcs) || rpcs.length < 2) throw new QuorumError("independent reads need at least two RPC origins");
  if (!Number.isInteger(quorum) || quorum < 2 || quorum > rpcs.length) throw new QuorumError("invalid RPC quorum");
  const chainOk = new Map();      // url -> true once eth_chainId matched (a mismatch is never cached as ok)
  let floor = 0;                  // highest agreed block so far: a later snapshot never goes backwards

  async function checkChain(url){
    if (chainOk.get(url)) return;
    const id = asNumber(await rpc(url, "eth_chainId", []), "chain id");
    if (id !== chainId) throw new Error("serves chain " + id + ", not " + chainId);
    chainOk.set(url, true);
  }

  /* One block that `quorum` origins agree on: its number, hash and timestamp,
     plus which origins agreed (calls go only to those). */
  async function snapshot(){
    const heads = await Promise.allSettled(rpcs.map(async (url) => {
      await checkChain(url);
      return { url, height: asNumber(await rpc(url, "eth_blockNumber", []), "block number") };
    }));
    const ok = heads.filter((h) => h.status === "fulfilled").map((h) => h.value);
    const failed = heads.filter((h) => h.status === "rejected").map((h, i) => String(h.reason && h.reason.message || h.reason).slice(0, 120));
    if (ok.length < quorum)
      throw new QuorumError(`only ${ok.length} of ${rpcs.length} chain endpoints answered (need ${quorum})`, { failed });
    // the quorum-th highest height: at least `quorum` origins have reached it
    const heights = ok.map((h) => h.height).sort((a, b) => b - a);
    const target = heights[quorum - 1] - confirmations;
    if (target < 0) throw new QuorumError("the chain is too short for the configured confirmations");
    if (target < floor) throw new QuorumError("the agreeing endpoints are behind a block this page already used");
    const blocks = await Promise.allSettled(ok.filter((h) => h.height >= target).map(async ({ url }) => {
      const b = await rpc(url, "eth_getBlockByNumber", ["0x" + target.toString(16), false]);
      if (!b || typeof b.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(b.hash)) throw new Error("no block");
      if (asNumber(b.number, "block number") !== target) throw new Error("wrong block");
      return { url, hash: b.hash.toLowerCase(), timestamp: asNumber(b.timestamp, "timestamp"),
        baseFeePerGas: typeof b.baseFeePerGas === "string" && /^0x[0-9a-f]+$/i.test(b.baseFeePerGas) ? BigInt(b.baseFeePerGas) : null };
    }));
    const byHash = new Map();
    for (const b of blocks) if (b.status === "fulfilled"){
      const g = byHash.get(b.value.hash + ":" + b.value.timestamp) || [];
      g.push(b.value); byHash.set(b.value.hash + ":" + b.value.timestamp, g);
    }
    const best = [...byHash.values()].sort((a, b) => b.length - a.length)[0] || [];
    if (best.length < quorum)
      throw new QuorumError(`chain endpoints disagree on block ${target} (${best.length} agree, need ${quorum})`);
    const { hash, timestamp, baseFeePerGas } = best[0];        // the hash fixes the header, so its base fee too
    const t = now();
    if (timestamp > t + 60) throw new QuorumError("the agreed block is from the future; check this computer's clock");
    if (t - timestamp > maxBlockAgeSeconds) throw new QuorumError(`the agreed block is ${t - timestamp}s old (limit ${maxBlockAgeSeconds}s)`);
    floor = Math.max(floor, target);
    return { number: target, hash, timestamp, baseFeePerGas, rpcs: best.map((b) => b.url) };
  }

  /* eth_call `data` on `to` at the snapshot's block hash; `quorum` identical
     answers required. An agreed revert throws with revert: true. */
  async function call(snap, to, data, { from = null, value = 0n } = {}){
    if (!snap || !snap.hash) throw new QuorumError("call needs a snapshot");
    // `from`/`value`: simulate exactly what an account will send (a call FROM a Safe, with its own ETH)
    const tx = { to, data, ...(from ? { from } : {}), ...(value ? { value: "0x" + BigInt(value).toString(16) } : {}) };
    const answers = await Promise.allSettled(snap.rpcs.map(async (url) => {
      try { return { url, result: String(await rpc(url, "eth_call", [tx, { blockHash: snap.hash }])).toLowerCase() }; }
      catch (e){ if (e && e.revert) return { url, revert: String(e.message) }; throw e; }
    }));
    const tally = new Map();
    for (const a of answers) if (a.status === "fulfilled"){
      const k = a.value.revert != null ? "revert" : a.value.result;
      if (k !== "revert" && !HEX.test(k)) continue;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    const [key, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    if (count < quorum) throw new QuorumError(`chain endpoints disagree on a contract read (${count} agree, need ${quorum})`);
    if (key === "revert"){ const e = new QuorumError("the contract call reverted"); e.revert = true; throw e; }
    return key;
  }

  async function code(snap, address){
    const answers = await Promise.allSettled(snap.rpcs.map((url) => rpc(url, "eth_getCode", [address, { blockHash: snap.hash }])));
    const tally = new Map();
    for (const a of answers) if (a.status === "fulfilled" && typeof a.value === "string") tally.set(a.value.toLowerCase(), (tally.get(a.value.toLowerCase()) || 0) + 1);
    const [key, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    if (count < quorum) throw new QuorumError(`chain endpoints disagree on contract code (${count} agree, need ${quorum})`);
    return key;
  }

  /* Event logs of one contract in [fromBlock, toBlock] (toBlock at most the snapshot's block), with `quorum` origins
     returning the identical, complete set. Each log must name that contract, lie inside the range and not be removed.
     Used for owner changes the ledger announces (DeploymentTransferred); RPC agreement, not a light client. */
  async function logs(snap, { address, topics = [], fromBlock, toBlock }){
    if (!snap || !snap.hash) throw new QuorumError("logs need a snapshot");
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock || toBlock > snap.number)
      throw new QuorumError("invalid log range");
    const want = String(address).toLowerCase();
    const answers = await Promise.allSettled(snap.rpcs.map(async (url) => {
      const out = await rpc(url, "eth_getLogs", [{ address, topics, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16) }]);
      if (!Array.isArray(out)) throw new Error("bad logs");
      return out.map((l) => {
        const n = asNumber(l.blockNumber, "log block");
        if (String(l.address).toLowerCase() !== want || l.removed === true || n < fromBlock || n > toBlock) throw new Error("log outside the request");
        return [n, String(l.blockHash).toLowerCase(), asNumber(l.logIndex, "log index"), (l.topics || []).map((t) => String(t).toLowerCase()), String(l.data || "0x").toLowerCase(),
          String(l.transactionHash || "").toLowerCase()];
      }).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    }));
    const tally = new Map();
    for (const a of answers) if (a.status === "fulfilled"){
      const k = JSON.stringify(a.value); const t = tally.get(k) || { n: 0, v: a.value }; t.n++; tally.set(k, t);
    }
    const best = [...tally.values()].sort((a, b) => b.n - a.n)[0];
    if (!best || best.n < quorum) throw new QuorumError(`chain endpoints disagree on event logs (${best ? best.n : 0} agree, need ${quorum})`);
    return best.v.map(([blockNumber, blockHash, logIndex, topics, data, transactionHash]) => ({ blockNumber, blockHash, logIndex, topics, data, transactionHash }));
  }

  /* An address's ETH balance at the snapshot's block hash; `quorum` identical answers required. */
  async function balance(snap, address){
    if (!snap || !snap.hash) throw new QuorumError("balance needs a snapshot");
    const answers = await Promise.allSettled(snap.rpcs.map((url) => rpc(url, "eth_getBalance", [address, { blockHash: snap.hash }])));
    const tally = new Map();
    for (const a of answers) if (a.status === "fulfilled" && typeof a.value === "string" && /^0x[0-9a-f]+$/i.test(a.value)){ const k = BigInt(a.value).toString(); tally.set(k, (tally.get(k) || 0) + 1); }
    const [key, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    if (count < quorum) throw new QuorumError(`chain endpoints disagree on a balance (${count} agree, need ${quorum})`);
    return BigInt(key);
  }

  /* Gas a call needs at the snapshot's block, as at least `quorum` origins estimate it; the HIGHEST answer is returned. An
     estimate is a floor for a limit this page sets (never a decision of trust), so the conservative answer wins. */
  async function estimateGas(snap, { from, to, data, value = 0n }){
    if (!snap || !snap.hash) throw new QuorumError("estimateGas needs a snapshot");
    const tx = { from, to, data, ...(value ? { value: "0x" + BigInt(value).toString(16) } : {}) };
    const answers = await Promise.allSettled(snap.rpcs.map((url) => rpc(url, "eth_estimateGas", [tx, "0x" + snap.number.toString(16)])));
    const ok = answers.filter((a) => a.status === "fulfilled" && typeof a.value === "string" && /^0x[0-9a-f]+$/i.test(a.value)).map((a) => BigInt(a.value));
    if (ok.length < quorum){
      const why = answers.find((a) => a.status === "rejected");
      const e = new QuorumError("the chain endpoints could not estimate this call (" + String(why && why.reason && why.reason.message || "no answer").slice(0, 160) + ")");
      if (why && why.reason && why.reason.revert) e.revert = true;
      throw e;
    }
    return ok.reduce((a, b) => (a > b ? a : b));
  }

  /* Session delegation uses a storage slot on the selected ledger. Require a
     complete agreed word at the same block hash, never a first-answer fallback. */
  async function storageAt(snap, address, slot){
    if (!snap || !snap.hash) throw new QuorumError("storage read needs a snapshot");
    const answers = await Promise.allSettled(snap.rpcs.map(url =>
      rpc(url, "eth_getStorageAt", [address, slot, { blockHash: snap.hash }])));
    const tally = new Map();
    for (const a of answers) if (a.status === "fulfilled" && /^0x[0-9a-f]{64}$/i.test(a.value)){
      const value = a.value.toLowerCase(); tally.set(value, (tally.get(value) || 0) + 1);
    }
    const [value, count] = [...tally.entries()].sort((a,b) => b[1] - a[1])[0] || [null, 0];
    if (count < quorum) throw new QuorumError(`chain endpoints disagree on storage (${count} agree, need ${quorum})`);
    return value;
  }

  return { snapshot, call, code, logs, balance, estimateGas, storageAt, rpcs, quorum, confirmations };
}
