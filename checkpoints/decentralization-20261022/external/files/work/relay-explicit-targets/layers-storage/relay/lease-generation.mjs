// The writer-authority fact of a deployment's CURRENT lease on the live rev-16d EnclaveDeployments ledger (storage writer
// fencing; work/storage-front-binding-interface.txt, work/storage-fencing-implementation-interface.txt section 5):
//   {"source":"lease16","chainId","ledger","deployment","claimBlock","claimLogIndex"}
// from ONE fresh snapshot that two or more independent RPCs agree on, never from one RPC, a relay table or a host.
// No imports: the relay deploys flat. Raw JSON-RPC over fetch, every call timed out.
//
// What makes it the CURRENT lease's claim, on rev 16d (blob 3f3d2c3a; no generation field exists there):
//   - claim() is the only path that sets a runner, it needs the previous lease ended (expired or released), and it always
//     emits Claimed(id, enclaveId, operator, leaseUntil, burned). renew() emits Renewed and never moves the claim;
//     release() emits Released and zeroes the runner; imports zero it; setConfig / transferDeployment / setActive never
//     touch the lease.
//   - So the last Claimed(id) at or below the agreed block is this lease's claim, IF the logs after it replay to the row:
//     the claim names the row's runner and operator, no Released follows it, every later Renewed names the same runner,
//     and the last leaseUntil equals the row's. Logs a provider set omitted (a later claim, a release, a renewal) cannot
//     replay to the row, so they yield no fact rather than an older, lower generation.
//   - The claim must be FINALIZED by every agreeing RPC: a reorged claim could otherwise leave a fence no later holder of
//     the same lease could ever raise above (its claim landing at a lower block or log index).

export const CHAIN_BASE = 8453;
export const CLAIMED = "0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0";    // Claimed(bytes32,bytes32,address,uint64,uint256)
export const RENEWED = "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e";    // Renewed(bytes32,bytes32,uint64,uint256)
export const RELEASED = "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882";   // Released(bytes32,bytes32,uint256)
const SEL_GET = "0x8eaa6ac0", SEL_SCHEMA = "0x5d1b72b6";                                       // get(bytes32), deploymentsSchema()
const HEX = (n) => new RegExp(`^0x[0-9a-f]{${n}}$`);
const ZERO = /^0x0+$/;

/** A fact could not be established. `retry`: the chain may answer later (quorum, finality, a provider lagging). */
export class LeaseGenerationError extends Error {
  constructor(code, message, retry = false) { super(message); this.code = code; this.retry = retry; }
}
const fail = (code, message, retry = false) => { throw new LeaseGenerationError(code, message, retry); };

const qty = (s, what) => {
  if (typeof s !== "string" || !/^0x[0-9a-f]+$/i.test(s)) fail("bad_answer", `${what} is not a quantity`, true);
  const n = Number(BigInt(s));
  if (!Number.isSafeInteger(n)) fail("bad_answer", `${what} is out of range`, true);
  return n;
};
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);

/** The schema-16 Deployment tuple (17 fields, one dynamic tuple), only the fields the lease is judged on. */
export function decodeRow16(raw, id) {
  const hex = String(raw || "").toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(hex) || (hex.length - 2) % 64 !== 0 || (hex.length - 2) / 64 < 18) fail("bad_answer", "the ledger row is not a schema-16 tuple", true);
  if (BigInt("0x" + word(hex, 0)) !== 32n) fail("bad_answer", "the ledger row has an unexpected tuple offset", true);
  const w = (i) => word(hex, i + 1);
  const rowId = "0x" + w(0);
  if (rowId === "0x" + "0".repeat(64)) return null;                         // no such deployment
  if (rowId !== id) fail("bad_answer", "the ledger answered for another deployment", true);
  const flag = (i) => { const v = BigInt("0x" + w(i)); if (v > 1n) fail("bad_answer", "a ledger flag is not a bool", true); return v === 1n; };
  const operatorWord = w(15);
  if (!/^0{24}/.test(operatorWord)) fail("bad_answer", "the runner operator is not an address", true);
  const leaseUntil = BigInt("0x" + w(16));
  if (leaseUntil >= 1n << 64n) fail("bad_answer", "leaseUntil is out of range", true);
  return { id: rowId, active: flag(9), runner: "0x" + w(14), runnerOperator: "0x" + operatorWord.slice(24), leaseUntil: Number(leaseUntil) };
}

const normLog = (l) => ({ blockNumber: qty(l.blockNumber, "a log's block"), blockHash: String(l.blockHash).toLowerCase(), logIndex: qty(l.logIndex, "a log's index"),
  transactionHash: String(l.transactionHash).toLowerCase(), address: String(l.address).toLowerCase(), topics: (l.topics || []).map((t) => String(t).toLowerCase()),
  data: String(l.data).toLowerCase(), removed: l.removed === true });

// The live 16d ledger's code first appears at Base block 52,515,705 (read-only probe, logs/probe-live.json): no lease log
// of it can be older, so no scan goes below. Configurable (fromBlock) for another ledger.
export const LEDGER16D_FROM_BLOCK = 52_515_705;

// Provider answers that mean "ask a smaller range", "slow down", or "that history is not served here". None of them is
// ever read as an empty history.
const RANGE_RE = /range|block limit|blocks? (is|are) (limited|allowed)|too many (blocks|results|logs)|exceed|-32614|-32005|response size|query returned more than/i;
const RATE_RE = /rate.?limit|request limit|too many requests|HTTP 429|-32011|-32029|capacity|throttl/i;
const HISTORY_RE = /archive|pruned|missing trie|header not found|not (available|supported) on free plan|personal token|history/i;

/**
 * createLeaseGenerationReader({ rpcs, ledger, chainId, confirmations, maxBlockAgeSec, fromBlock, windowBlocks, minWindowBlocks,
 *                               maxRequests, retries, timeoutMs, store, fetch, now, sleep })
 *   rpcs: two to eight JSON-RPC URLs on DISTINCT hosts; ledger: the address, or an async thunk (the relay's own confirmed
 *   ledger binding).
 *   windowBlocks: the first eth_getLogs range (1,000 fits BlockPI's public 1,024; it halves down to minWindowBlocks on a
 *   range refusal, e.g. mainnet.base.org's 200). maxRequests: eth_getLogs calls per peer per attempt; past it the
 *   finalized progress is kept (store) and the attempt ends with `scanning` (retry), resumed by the next one.
 *   store: { get(key) -> coverage | undefined, set(key, coverage), delete(key) }: per (chain, ledger, deployment) the
 *   contiguous FINALIZED block range [lo, hi] whose lease logs two agreeing RPCs returned, with those logs. Finalized logs
 *   never change, so a later attempt reads only blocks above hi (and below lo while it is still searching).
 * -> { writerAuthority(id, { runner }) -> { fact, factJson, block, claim }, track(id) }  throws LeaseGenerationError
 */
export function createLeaseGenerationReader({ rpcs, ledger, chainId = CHAIN_BASE, confirmations = 2, maxBlockAgeSec = 120, fromBlock = LEDGER16D_FROM_BLOCK,
                                               windowBlocks = 1_000, minWindowBlocks = 8, maxRequests = 400, retries = 4, timeoutMs = 8_000, store = memoryStore(),
                                               fetch: fetchFn = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const urls = [...new Set((rpcs || []).map(String))];
  const hosts = new Set(urls.map((u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } }));
  if (urls.length < 2 || urls.length > 8 || hosts.has("") || hosts.size !== urls.length) throw new Error("lease generation needs two to eight RPCs on distinct hosts");
  if (!(windowBlocks >= minWindowBlocks && minWindowBlocks >= 1)) throw new Error("bad window");
  let floor = 0;                                          // the highest agreed block accepted so far: never read below it
  let seq = 0;
  const window = new Map();                               // per RPC: the range its own refusals shrank it to
  async function call(url, method, params) {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    if (text.length > 4 << 20) throw new Error("reply too large");
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 120)}`);
    const j = JSON.parse(text);
    if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`);
    if (!("result" in j) || j.result === null) throw new Error("no result");
    return j.result;
  }
  const settle = async (list, fn) => (await Promise.allSettled(list.map(fn))).map((r, i) => ({ url: list[i], ok: r.status === "fulfilled", value: r.value, error: r.reason }));
  const why = (rs) => rs.filter((r) => !r.ok).map((r) => `${new URL(r.url).host}: ${String(r.error?.message || r.error).slice(0, 80)}`).join("; ");

  // one peer's logs for [lo, hi], split as that peer's range limit requires; rate limits back off. -> sorted logs
  async function peerLogs(u, ledgerAddr, id, lo, hi, budget) {
    const out = [];
    for (let a = lo; a <= hi;) {
      let w = Math.min(window.get(u) || windowBlocks, hi - a + 1), tries = 0;
      for (;;) {
        if (budget.used >= budget.max) throw Object.assign(new Error("request budget spent"), { budget: true });
        budget.used++;
        try {
          const b = a + w - 1;
          const got = await call(u, "eth_getLogs", [{ address: ledgerAddr, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [[CLAIMED, RENEWED, RELEASED], id] }]);
          if (!Array.isArray(got)) throw new Error("not a log list");
          for (const l of got.map(normLog)) {
            if (l.removed || l.address !== ledgerAddr || l.topics[1] !== id || l.blockNumber < a || l.blockNumber > b) throw new Error("a log outside the query");
            out.push(l);
          }
          a = b + 1;
          break;
        } catch (e) {
          const m = String(e?.message || e);
          if (RATE_RE.test(m) && tries < retries) { await sleep(500 * 2 ** tries++); continue; }
          // only a provider's refusal teaches its window; a window clipped at the end of a short range does not
          if (RANGE_RE.test(m) && !RATE_RE.test(m) && w > minWindowBlocks) { w = Math.max(minWindowBlocks, Math.floor(w / 2)); window.set(u, w); continue; }
          if (HISTORY_RE.test(m)) throw Object.assign(new Error(`history unavailable: ${m.slice(0, 120)}`), { history: true });
          throw e;
        }
      }
    }
    return out.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  }
  // the agreed logs of [lo, hi]: every answering peer identical, at least two
  async function agreedLogs(peers, ledgerAddr, id, lo, hi, budgets) {
    const got = await settle(peers, (u) => peerLogs(u, ledgerAddr, id, lo, hi, budgets.get(u)));
    const ok = got.filter((g) => g.ok);
    if (ok.length < 2) {
      if (got.some((g) => g.error?.budget)) fail("scanning", `the lease's history is being read (blocks ${lo}-${hi} pending); retry shortly`, true);
      if (got.filter((g) => g.error?.history).length > peers.length - 2) fail("history_unavailable", `fewer than two RPCs serve the lease's logs of blocks ${lo}-${hi} (${why(got)}); log-capable RPCs are needed for a claim this old`, false);
      fail("quorum_unavailable", `fewer than two RPCs returned the lease's logs of blocks ${lo}-${hi} (${why(got)})`, true);
    }
    const key = JSON.stringify(ok[0].value);
    if (ok.some((g) => JSON.stringify(g.value) !== key)) fail("disagree", `the RPCs disagree about the lease's logs in blocks ${lo}-${hi}`, true);
    return ok[0].value;
  }

  async function writerAuthority(id, { runner } = {}) {
    id = String(id || "").toLowerCase();
    if (!HEX(64).test(id) || ZERO.test(id)) fail("bad_id", "a bytes32 deployment id is required");
    const ledgerAddr = String(typeof ledger === "function" ? await ledger() : ledger || "").toLowerCase();
    if (!HEX(40).test(ledgerAddr) || ZERO.test(ledgerAddr)) fail("no_ledger", "no ledger address", true);
    // 1. heads: the right chain, then the second-highest head less the confirmations (one peer cannot pull it up)
    const heads = await settle(urls, async (u) => {
      if (qty(await call(u, "eth_chainId", []), "the chain id") !== chainId) throw new Error("wrong chain");
      return qty(await call(u, "eth_blockNumber", []), "the head");
    });
    const up = heads.filter((h) => h.ok).sort((a, b) => b.value - a.value);
    if (up.length < 2) fail("quorum_unavailable", `fewer than two RPCs answered the chain head (${why(heads)})`, true);
    const B = up[1].value - confirmations;
    if (B < 1) fail("quorum_unavailable", "not enough confirmed blocks", true);
    if (B < floor) fail("rollback", `the agreed block ${B} is below the accepted floor ${floor}`, true);
    const tag = "0x" + B.toString(16);
    // 2. the snapshot at B on every peer with a head: block, schema, the row, and the peer's finalized block
    const snaps = await settle(up.map((h) => h.url), async (u) => {
      const b = await call(u, "eth_getBlockByNumber", [tag, false]);
      if (qty(b.number, "the block") !== B || !HEX(64).test(String(b.hash).toLowerCase())) throw new Error("wrong block");
      const schema = qty(await call(u, "eth_call", [{ to: ledgerAddr, data: SEL_SCHEMA }, tag]), "the schema");
      const raw = String(await call(u, "eth_call", [{ to: ledgerAddr, data: SEL_GET + id.slice(2) }, tag])).toLowerCase();
      const fin = await call(u, "eth_getBlockByNumber", ["finalized", false]);
      return { key: `${String(b.hash).toLowerCase()}|${qty(b.timestamp, "the time")}|${schema}|${raw}`, hash: String(b.hash).toLowerCase(),
               time: qty(b.timestamp, "the time"), schema, raw, finalized: qty(fin.number, "the finalized block") };
    });
    const groups = new Map();
    for (const s of snaps.filter((x) => x.ok)) (groups.get(s.value.key) || groups.set(s.value.key, []).get(s.value.key)).push(s);
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
    if (best.length < 2) fail(groups.size > 1 ? "disagree" : "quorum_unavailable", groups.size > 1 ? `the RPCs disagree about block ${B}` : `fewer than two RPCs read block ${B} (${why(snaps)})`, true);
    const agreed = best.map((s) => s.url), S = best[0].value, t = Math.floor(now() / 1000);
    if (S.time > t + 5 || S.time < t - maxBlockAgeSec) fail("stale_snapshot", `the agreed block ${B} is ${t - S.time} s old`, true);
    floor = Math.max(floor, B);
    if (S.schema !== 16) fail("unsupported_schema", `the ledger reports schema ${S.schema}; only the live rev 16d (schema 16) is read here`);
    const row = decodeRow16(S.raw, id);
    if (!row) fail("no_deployment", "the ledger holds no such deployment");
    if (!row.active || ZERO.test(row.runner) || ZERO.test(row.runnerOperator) || row.leaseUntil <= S.time || row.leaseUntil <= t)
      fail("lease_not_current", "the deployment has no current lease at the agreed block", true);
    if (runner !== undefined && String(runner).toLowerCase() !== row.runner) fail("runner_mismatch", "the current lease is held by another runner");
    const finalized = Math.min(B, ...best.map((s) => s.value.finalized));
    // 3. the lease's logs: everything from the last Claimed up to B. Finalized coverage from earlier attempts is reused
    //    (finalized logs never change); blocks above it are read now; below it, the search goes on only while no Claimed
    //    has been seen, never below fromBlock, at most maxRequests eth_getLogs per peer per attempt.
    const key = `${chainId}|${ledgerAddr}|${id}`;
    let cov = store.get(key);
    // stored coverage held only logs that were FINALIZED when stored: it stays valid while it is below the agreed block,
    // even if this attempt's peers report a lower finalized block (lag)
    if (cov && !(cov.lo >= fromBlock && cov.hi <= B && cov.lo <= cov.hi + 1 && Array.isArray(cov.logs))) { store.delete(key); cov = undefined; }
    const budgets = new Map(agreed.map((u) => [u, { used: 0, max: maxRequests }]));
    // [lo, hi]: the contiguous range whose logs are in hand (hi: never past what was actually read)
    let lo = cov ? cov.lo : B + 1, hi = cov ? cov.hi : B, logs = cov ? [...cov.logs] : [];
    const keep = (lo2, hi2, ls) => { const f = ls.filter((l) => l.blockNumber <= hi2); store.set(key, { lo: lo2, hi: hi2, logs: f }); };
    try {
      if (cov && cov.hi < B) {
        // upward in steps, each finalized step kept: a gap longer than one attempt's budget (a relay down for days)
        // still closes over attempts
        for (let a = cov.hi + 1; a <= B;) {
          const b = Math.min(B, a + windowBlocks - 1);   // one window per step: a step needs at most windowBlocks/minWindowBlocks requests
          logs.push(...await agreedLogs(agreed, ledgerAddr, id, a, b, budgets));
          hi = b;
          if (Math.min(hi, finalized) > cov.hi) keep(lo, Math.min(hi, finalized), logs);
          a = b + 1;
        }
      }
      else if (!cov) { const top = Math.max(fromBlock, B - windowBlocks + 1); logs.push(...await agreedLogs(agreed, ledgerAddr, id, top, B, budgets)); lo = top; }
      while (!logs.some((l) => l.topics[0] === CLAIMED)) {
        if (lo <= fromBlock) fail("no_claim", `no Claimed log for the lease since the ledger's first block ${fromBlock}`);
        const a = Math.max(fromBlock, lo - windowBlocks);   // one window per step, each kept: every attempt progresses
        const older = await agreedLogs(agreed, ledgerAddr, id, a, lo - 1, budgets);
        logs.unshift(...older); lo = a;
        if (lo <= finalized) keep(lo, Math.min(finalized, hi), logs);   // the progress survives this attempt
      }
    } finally {
      const top = Math.min(finalized, hi);
      if (lo <= top) {
        const ls = [...logs].sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
        const c = ls.map((l) => l.topics[0]).lastIndexOf(CLAIMED);
        // once the claim is known, nothing older matters: coverage starts at the claim's block. A claim not final yet (a
        // release minutes after it), or none found yet: the finalized range read so far is kept all the same, so the
        // lease is tracked from now on and its coverage never falls behind what public RPCs serve
        if (c >= 0 && ls[c].blockNumber <= top) keep(ls[c].blockNumber, top, ls.slice(c));
        else keep(lo, top, ls);
      }
    }
    // 4. replay: the last Claimed and everything after it must yield exactly the row
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    const ci = logs.map((l) => l.topics[0]).lastIndexOf(CLAIMED), C = logs[ci], after = logs.slice(ci + 1);
    const leaseOf = (l) => { const v = BigInt("0x" + word(l.data, 0)); if (v >= 1n << 64n) fail("bad_answer", "a log's leaseUntil is out of range", true); return Number(v); };
    if (C.topics.length !== 4 || C.topics[2] !== row.runner || C.topics[3] !== "0x" + "0".repeat(24) + row.runnerOperator.slice(2))
      fail("inconsistent_logs", "the last claim does not name the lease's runner and operator", true);
    let until = leaseOf(C);
    for (const l of after) {
      if (l.topics[0] === RELEASED) fail("inconsistent_logs", "the lease was released after its last claim", true);
      if (l.topics[0] === RENEWED) { if (l.topics[2] !== row.runner) fail("inconsistent_logs", "a renewal names another runner", true); until = leaseOf(l); }
    }
    if (until !== row.leaseUntil) fail("inconsistent_logs", "the claim and its renewals do not replay to the row's leaseUntil", true);
    // 5. final, and the claim's block is the same canonical block on every agreeing peer
    if (C.blockNumber > finalized && !(cov && C.blockNumber <= cov.hi)) fail("claim_not_final", `the lease's claim (block ${C.blockNumber}) is not finalized yet (finalized ${finalized}); Base finality is typically 15-30 minutes`, true);
    const at = await settle(agreed, async (u) => String((await call(u, "eth_getBlockByNumber", ["0x" + C.blockNumber.toString(16), false])).hash).toLowerCase());
    if (at.filter((a) => a.ok).length < 2 || at.some((a) => a.ok && a.value !== C.blockHash)) fail("disagree", "the claim's block is not the same canonical block on the agreeing RPCs", true);
    if (C.blockNumber < 1 || C.blockNumber >= 2 ** 32 || C.logIndex >= 2 ** 16) fail("out_of_range", "the claim's block or log index exceeds the lease16 fact's range");
    const fact = { source: "lease16", chainId, ledger: ledgerAddr, deployment: id, claimBlock: C.blockNumber, claimLogIndex: C.logIndex };
    return { fact, factJson: JSON.stringify(fact), block: { number: B, hash: S.hash, time: S.time, finalized },
             claim: { blockNumber: C.blockNumber, blockHash: C.blockHash, logIndex: C.logIndex, transactionHash: C.transactionHash, runner: row.runner } };
  }
  // keep a tracked lease's finalized coverage current, so it never ages out of what public RPCs serve. -> the fact or null
  async function track(id) { try { return (await writerAuthority(id)).fact; } catch (e) { if (e?.code === "lease_not_current" || e?.code === "no_deployment") store.delete(`${chainId}|${String(typeof ledger === "function" ? await ledger() : ledger).toLowerCase()}|${String(id).toLowerCase()}`); return null; } }
  return { writerAuthority, track, tracked: () => store.keys() };
}

/** In-memory coverage (tests; a front's single process). */
export function memoryStore() { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), keys: () => [...m.keys()] }; }
/** File-backed coverage for the relay (one JSON file, written atomically; at most `max` deployments, oldest dropped). */
export function fileStore(file, { fs, max = 2000 }) {
  let m = new Map();
  try { m = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))); } catch {}
  const save = () => { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 }); fs.renameSync(tmp, file); };
  return { get: (k) => m.get(k), keys: () => [...m.keys()],
           set: (k, v) => { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); save(); },
           delete: (k) => { if (m.delete(k)) save(); } };
}

/** Does this config (any JSON value, or its text) refer to the writer-authority name? Only then is the fact required. */
export const needsWriterAuthority = (config) => /ENCLAVE_WRITER_AUTHORITY/.test(typeof config === "string" ? config : JSON.stringify(config ?? null));
