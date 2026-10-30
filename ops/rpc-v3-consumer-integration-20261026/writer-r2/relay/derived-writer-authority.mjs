// The writer-authority fact (lease16, the format relay/lease-generation.mjs produces and isolation/m2/front parses) from the
// relay's OWN L1-finalized derived Base reader instead of agreeing public RPCs:
//   {"source":"lease16","chainId","ledger","deployment","claimBlock","claimLogIndex"}
// ONE snapshot of the derived reader's bridge at its current L1-finalized anchor B (proof-executed state at B's exact hash):
//   the ledger (DEPLOYMENTS_ADDRESS pinned at startup, else the admin AddressBook's `deployments` entry AT B: a book migration is
//   followed at the finalized block), its schema (16) and the deployment's row, and - inside the same callback - the derived
//   reader's complete lease-log coverage for [max(availableFrom, ledger floor), B] requested with anchor {number: B, hash}. The
//   reader refuses unless that is still its current anchor, so the row and the logs are of the SAME block.
// What makes it the CURRENT lease's claim is unchanged (lease-generation.mjs header): the last Claimed replays to the row. The
// reader's coverage is complete from availableFrom (an assertion of the pinned native v3 executable and the reader's runtime-
// verified segments, NOT of any JSON label here), so the last Claimed in it is the current claim; none in it means the current
// claim predates the coverage: claim_not_covered, never a fact, never re-claimed or signed.
// Freshness (r2): the SAME ceiling as the original lease authority (lease-generation.mjs maxBlockAgeSec 120): the derived anchor's
// own block time must be within 120 s of now (and at most 5 s in the future). The ceiling can be LOWERED, never raised; no reader
// config, env or caller can widen it. An L1-FINALIZED derived anchor is normally far older than 120 s (Ethereum finality alone is
// ~13 min), so with today's finalized-only reader this source REFUSES (stale_snapshot) and stays blocked for activation; see
// logs/claude-finalized-writer-adapter-r2.md for the measured-path question.
// Additional deny-only check (NOT a freshness authority): the relay's local verifier (unsafe tier) is asked about blocks after B
// and may only REFUSE (a Claimed or Released after B, another runner/operator, a lease no longer current, a moved book entry, or any
// failure of that check). Its silence proves nothing: it never establishes absence of a release, re-claim or admin change.
// The capability is the in-process derived reader built by derivedWriterAuthorityFromEnv from the reviewed network runtime
// module; nothing is taken from configuration as a capability, and no HTTP/JSON endpoint is ever one.
import { CHAIN_BASE, CLAIMED, RENEWED, RELEASED, LEDGER16D_FROM_BLOCK, LeaseGenerationError } from "./lease-generation.mjs";

export const DERIVED_LOGS_FORMAT = "enclave-derived-logs/v1";
export const COVERAGE_FORMAT = "enclave-lease16-coverage/v1";
export const FILTER_ID = "lease16-events/v1";
export const LEASE_TOPIC0S = Object.freeze([CLAIMED, RENEWED, RELEASED]);
/** The original lease authority's freshness ceiling (relay/lease-generation.mjs maxBlockAgeSec default, the relay's setting). */
export const MAX_ANCHOR_AGE_SEC = 120;
export const SOURCE_ENV = "ENCLAVE_WRITER_AUTHORITY_SOURCE", CONFIG_ENV = "ENCLAVE_DERIVED_READER_CONFIG",
  JOURNAL_ENV = "ENCLAVE_DERIVED_ANCHOR_JOURNAL", API_PORT_ENV = "ENCLAVE_DERIVED_READER_API_PORT";
const BOOK_KEY_DEPLOYMENTS = "0x6465706c6f796d656e7473" + "0".repeat(42);   // "deployments", as relay/api-relay.js
const DEPLOYMENT16 = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
  { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
  { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
export const LEDGER_ABI = Object.freeze([
  { type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "", type: "tuple", components: DEPLOYMENT16 }] },
]);
export const BOOK_ABI = Object.freeze([{ type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "key", type: "bytes32" }], outputs: [{ name: "", type: "address" }] }]);
// per ABI: indexed topics and non-indexed data words (Claimed: id, enclaveId, operator | leaseUntil, burned6; Renewed: id, enclaveId |
// leaseUntil, burned6; Released: id, enclaveId | refunded6)
const SHAPE = { [CLAIMED]: { topics: 4, words: 2 }, [RENEWED]: { topics: 3, words: 2 }, [RELEASED]: { topics: 3, words: 1 } };

const HEX = (n) => new RegExp(`^0x[0-9a-f]{${n}}$`);
const H32 = HEX(64), ADDR = HEX(40), DATA = /^0x(?:[0-9a-f]{2})*$/, ZERO = /^0x0+$/;
const uint = (n) => Number.isSafeInteger(n) && n >= 0;
const fail = (code, message, retry = false) => { throw new LeaseGenerationError(code, message, retry); };
const lc = (s) => String(s ?? "").toLowerCase();
const aborted = (signal) => new LeaseGenerationError("aborted", `the read was cancelled (${String(signal?.reason?.message || signal?.reason || "aborted").slice(0, 80)})`, true);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The deployment's row as the derived snapshot's pinned client decoded it; null = no such deployment. */
export function normalizeRow(d, id) {
  if (!d || typeof d !== "object") fail("bad_answer", "the ledger row is not a tuple", true);
  const rowId = lc(d.id);
  if (!H32.test(rowId)) fail("bad_answer", "the ledger row has no bytes32 id", true);
  if (ZERO.test(rowId)) return null;
  if (rowId !== id) fail("bad_answer", "the ledger answered for another deployment", true);
  const leaseUntil = typeof d.leaseUntil === "bigint" ? d.leaseUntil : BigInt(d.leaseUntil ?? -1);
  if (leaseUntil < 0n || leaseUntil >= 1n << 64n) fail("bad_answer", "leaseUntil is out of range", true);
  if (typeof d.active !== "boolean" || !H32.test(lc(d.runner)) || !ADDR.test(lc(d.runnerOperator))) fail("bad_answer", "the ledger row is malformed", true);
  return { id: rowId, active: d.active, runner: lc(d.runner), runnerOperator: lc(d.runnerOperator), leaseUntil: Number(leaseUntil) };
}

/** Strict check of one readDerivedLogs answer against EXACTLY what was asked. -> the deployment's lease logs, ordered. Only logs of
 *  the confirmed ledger and this deployment are validated (the native capture records same-topic0 logs of ANY address; those are
 *  ignored here, never a reason to refuse). */
export function checkDerivedLogs(res, ask) {
  if (!res || res.format !== DERIVED_LOGS_FORMAT) fail("derived_logs_invalid", "the derived reader's answer is not enclave-derived-logs/v1", true);
  const b = res.anchor?.base;
  if (!b || b.number !== ask.anchor.number || lc(b.hash) !== ask.anchor.hash)
    fail("anchor_mismatch", "the derived logs are of another anchor than the snapshot's", true);
  // the filter echo: address/topic0s/topic1 exactly; KVM's store also echoes the range (fromBlock/toBlock), accepted only if equal
  const f = res.filter && typeof res.filter === "object" ? res.filter : {};
  if (Object.keys(f).some((k) => !["address", "topic0s", "topic1", "fromBlock", "toBlock"].includes(k)) || lc(f.address) !== ask.address ||
      !same(f.topic0s, ask.topic0s) || lc(f.topic1) !== ask.topic1 || ("fromBlock" in f && f.fromBlock !== ask.fromBlock) || ("toBlock" in f && f.toBlock !== ask.toBlock))
    fail("derived_logs_invalid", "the derived reader answered another filter", true);
  const c = res.coverage;
  if (!c || c.format !== COVERAGE_FORMAT || c.filterId !== FILTER_ID || c.fromBlock !== ask.fromBlock || c.toBlock !== ask.toBlock || c.complete !== true ||
      !uint(c.availableFromBlock) || !uint(c.availableToBlock) || c.availableFromBlock > c.fromBlock || c.availableToBlock < c.toBlock)
    fail("coverage_incomplete", "the derived reader did not answer with complete coverage of exactly the asked range", true);
  if (!Array.isArray(res.logs)) fail("derived_logs_invalid", "no log list", true);
  const out = [];
  let prev = null;
  for (const l of res.logs) {
    const topics = Array.isArray(l?.topics) ? l.topics.map(lc) : [];
    if (lc(l?.address) !== ask.address || topics[1] !== ask.topic1 || !LEASE_TOPIC0S.includes(topics[0])) continue;   // not this lease's
    const shape = SHAPE[topics[0]], data = lc(l.data);
    if (topics.length !== shape.topics || !topics.every((t) => H32.test(t)) || !DATA.test(data) || data.length !== 2 + 64 * shape.words ||
        !uint(l.blockNumber) || l.blockNumber < ask.fromBlock || l.blockNumber > ask.toBlock || !uint(l.logIndex) ||
        !H32.test(lc(l.blockHash)) || !H32.test(lc(l.txHash)))
      fail("bad_answer", "a lease log of the derived coverage is malformed or outside the asked range", true);
    if (prev && (l.blockNumber < prev.blockNumber || l.blockNumber === prev.blockNumber && l.logIndex <= prev.logIndex))
      fail("bad_answer", "the derived lease logs are not in strict (block, logIndex) order", true);
    if (prev && l.blockNumber === prev.blockNumber && lc(l.blockHash) !== prev.blockHash)
      fail("bad_answer", "two blocks of one number in the derived lease logs", true);
    if (l.blockNumber === ask.anchor.number && lc(l.blockHash) !== ask.anchor.hash)
      fail("anchor_mismatch", "a lease log of the anchor block names another block hash", true);
    prev = { blockNumber: l.blockNumber, logIndex: l.logIndex, blockHash: lc(l.blockHash), transactionHash: lc(l.txHash), topics, data };
    out.push(prev);
  }
  return out;
}

/** The existing replay (lease-generation.mjs step 4/5) over COMPLETE logs: the last Claimed and everything after it must yield the
 *  row. -> the claim log. */
export function replayToRow(logs, row) {
  const ci = logs.map((l) => l.topics[0]).lastIndexOf(CLAIMED);
  if (ci < 0) fail("claim_not_covered", "the lease's current claim is older than the derived reader's complete coverage; it stays unproven (no re-claim, no signature)");
  const C = logs[ci];
  const leaseOf = (l) => { const v = BigInt("0x" + l.data.slice(2, 66)); if (v >= 1n << 64n) fail("bad_answer", "a log's leaseUntil is out of range", true); return Number(v); };
  if (C.topics[2] !== row.runner || C.topics[3] !== "0x" + "0".repeat(24) + row.runnerOperator.slice(2))
    fail("inconsistent_logs", "the last claim does not name the lease's runner and operator", true);
  let until = leaseOf(C);
  for (const l of logs.slice(ci + 1)) {
    if (l.topics[0] === RELEASED) fail("inconsistent_logs", "the lease was released after its last claim", true);
    if (l.topics[2] !== row.runner) fail("inconsistent_logs", "a renewal names another runner", true);
    until = leaseOf(l);
  }
  if (until !== row.leaseUntil) fail("inconsistent_logs", "the claim and its renewals do not replay to the row's leaseUntil", true);
  if (C.blockNumber < 1 || C.blockNumber >= 2 ** 32 || C.logIndex >= 2 ** 16) fail("out_of_range", "the claim's block or log index exceeds the lease16 fact's range");
  return C;
}

/**
 * createDerivedWriterAuthority({ capability, fresh, ledgerPin, addressBook, chainId, fromBlock, maxAnchorAgeSec, now })
 *   capability: { snapshot(read) (the derived reader's lifecycle bridge), readDerivedLogs(query) } - in-process only.
 *   fresh: the relay's local verifier client (RELAY_CHAIN.client; viem-shaped getBlockNumber/request/readContract): an additional
 *     DENY-ONLY check; never a source of freshness.
 *   maxAnchorAgeSec: <= MAX_ANCHOR_AGE_SEC (120, the original lease authority's ceiling); a larger value throws.
 *   ledgerPin: DEPLOYMENTS_ADDRESS as configured at startup ('' = follow the book); addressBook: ADDRESS_BOOK_ADDRESS.
 * -> { writerAuthority(id, { runner, signal }) -> { fact, factJson, block, claim, evidence } } throws LeaseGenerationError
 */
export function createDerivedWriterAuthority({ capability, fresh, ledgerPin = "", addressBook = "", chainId = CHAIN_BASE, fromBlock = LEDGER16D_FROM_BLOCK,
                                                maxAnchorAgeSec = MAX_ANCHOR_AGE_SEC, now = () => Date.now() } = {}) {
  if (typeof capability?.snapshot !== "function" || typeof capability?.readDerivedLogs !== "function")
    throw new Error("derived writer authority needs the in-process derived reader capability (snapshot + readDerivedLogs)");
  if (!fresh || typeof fresh.getBlockNumber !== "function" || typeof fresh.request !== "function" || typeof fresh.readContract !== "function")
    throw new Error("derived writer authority needs the relay's local verifier for its additional deny-only check");
  const pin = lc(ledgerPin), book = lc(addressBook);
  if (pin && (!ADDR.test(pin) || ZERO.test(pin))) throw new Error("DEPLOYMENTS_ADDRESS is not an address");
  if (!pin && (!ADDR.test(book) || ZERO.test(book))) throw new Error("derived writer authority needs DEPLOYMENTS_ADDRESS or ADDRESS_BOOK_ADDRESS");
  if (!Number.isInteger(maxAnchorAgeSec) || maxAnchorAgeSec < 1 || maxAnchorAgeSec > MAX_ANCHOR_AGE_SEC)
    throw new Error(`maxAnchorAgeSec must be 1..${MAX_ANCHOR_AGE_SEC} s: the lease authority's freshness ceiling is never raised`);
  // the bridge and the reader take one operation at a time: callers queue (each still bounded by its own signal)
  let queue = Promise.resolve();
  const serial = (fn, signal) => {
    const run = queue.then(() => { if (signal?.aborted) throw aborted(signal); return fn(); });
    queue = run.catch(() => {});
    return signal ? Promise.race([run, new Promise((_, no) => signal.addEventListener("abort", () => no(aborted(signal)), { once: true }))]) : run;
  };

  async function derivedRead(id, signal) {
    let snap;
    try {
      snap = await capability.snapshot(async (client, number) => {
        const blk = await client.getBlock();
        const B = Number(number), hash = lc(blk.hash), time = Number(blk.timestamp);
        if (!uint(B) || !H32.test(hash) || !uint(time) || Number(blk.number) !== B) fail("bad_answer", "the derived snapshot's block is malformed", true);
        const ledger = pin || lc(await client.readContract({ address: book, abi: BOOK_ABI, functionName: "addr", args: [BOOK_KEY_DEPLOYMENTS] }));
        if (!ADDR.test(ledger) || ZERO.test(ledger)) fail("no_ledger", "the address book names no deployments ledger at the derived block", true);
        const schema = Number(await client.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "deploymentsSchema" }));
        const row = normalizeRow(await client.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "get", args: [id] }), id);
        if (schema !== 16 || !row) return { B, hash, time, ledger, schema, row, logs: null };
        const anchor = { number: B, hash };
        const base = { address: ledger, topic0s: [...LEASE_TOPIC0S], topic1: id, anchor, signal };
        // the reader's complete coverage starts at availableFrom: learn it at the anchor block itself, then read everything since
        const probeAsk = { ...base, fromBlock: B, toBlock: B }, probe = await capability.readDerivedLogs(probeAsk);
        checkDerivedLogs(probe, probeAsk);
        const from = Math.max(fromBlock, probe.coverage.availableFromBlock);
        if (from > B) fail("claim_not_covered", "the derived reader's coverage starts after the anchor");
        const ask = { ...base, fromBlock: from, toBlock: B };
        return { B, hash, time, ledger, schema, row, logs: checkDerivedLogs(await capability.readDerivedLogs(ask), ask), from };
      });
    } catch (e) {
      if (signal?.aborted) throw aborted(signal);
      if (e instanceof LeaseGenerationError) throw e;
      fail("derived_unavailable", `the derived reader could not answer (${String(e?.message || e).slice(0, 120)})`, true);
    }
    const v = snap?.value;
    if (!v || snap.blockNumber === undefined || Number(snap.blockNumber) !== v.B || lc(snap.blockHash) !== v.hash)
      fail("anchor_mismatch", "the snapshot's result is not of the block its reads were pinned to", true);
    return v;
  }

  async function denyIfStale(id, v, row, signal) {
    let head, later, headRow, headLedger;
    try {
      head = Number(await fresh.getBlockNumber());
      if (!uint(head) || head < v.B) fail("fresh_head_behind", `the local verifier's head ${head} is below the derived anchor ${v.B}`, true);
      later = head > v.B ? await fresh.request({ method: "eth_getLogs", params: [{ address: v.ledger, topics: [[CLAIMED, RELEASED], id],
        fromBlock: "0x" + (v.B + 1).toString(16), toBlock: "0x" + head.toString(16) }] }) : [];
      headRow = normalizeRow(await fresh.readContract({ address: v.ledger, abi: LEDGER_ABI, functionName: "get", args: [id], blockNumber: BigInt(head) }), id);
      headLedger = pin || lc(await fresh.readContract({ address: book, abi: BOOK_ABI, functionName: "addr", args: [BOOK_KEY_DEPLOYMENTS], blockNumber: BigInt(head) }));
    } catch (e) {
      if (signal?.aborted) throw aborted(signal);
      if (e instanceof LeaseGenerationError) throw e;
      fail("fresh_check_unavailable", `the additional deny-only check could not run (${String(e?.message || e).slice(0, 120)})`, true);
    }
    if (!Array.isArray(later)) fail("fresh_check_unavailable", "the local verifier returned no log list", true);
    if (later.some((l) => lc(l?.topics?.[0]) === CLAIMED)) fail("claim_not_final", "the lease was claimed again after the derived (finalized) anchor; retry once that is final", true);
    if (later.some((l) => lc(l?.topics?.[0]) === RELEASED)) fail("lease_not_current", "the lease was released after the derived anchor", true);
    if (headLedger !== v.ledger) fail("ledger_moved", "the address book's deployments ledger changed after the derived anchor", true);
    const t = Math.floor(now() / 1000);
    if (!headRow || !headRow.active || headRow.runner !== row.runner || headRow.runnerOperator !== row.runnerOperator || headRow.leaseUntil <= t)
      fail("lease_not_current", "at the local verifier's head the lease is no longer this runner's current lease", true);
  }

  async function writerAuthority(id, { runner, signal } = {}) {
    if (signal?.aborted) throw aborted(signal);
    id = lc(id);
    if (!H32.test(id) || ZERO.test(id)) fail("bad_id", "a bytes32 deployment id is required");
    return serial(async () => {
      const v = await derivedRead(id, signal);
      const t = Math.floor(now() / 1000);
      // exactly lease-generation.mjs: refused if more than 5 s in the future or older than the ceiling (age == ceiling is accepted)
      if (v.time > t + 5 || v.time < t - maxAnchorAgeSec)
        fail("stale_snapshot", `the derived anchor ${v.B} is ${t - v.time} s old (ceiling ${maxAnchorAgeSec} s)`, true);
      if (v.schema !== 16) fail("unsupported_schema", `the ledger reports schema ${v.schema}; only the live rev 16d (schema 16) is read here`);
      const row = v.row;
      if (!row) fail("no_deployment", "the ledger holds no such deployment");
      if (!row.active || ZERO.test(row.runner) || ZERO.test(row.runnerOperator) || row.leaseUntil <= v.time || row.leaseUntil <= t)
        fail("lease_not_current", "the deployment has no current lease at the derived anchor", true);
      if (runner !== undefined && lc(runner) !== row.runner) fail("runner_mismatch", "the current lease is held by another runner");
      const C = replayToRow(v.logs, row);
      await denyIfStale(id, v, row, signal);
      if (signal?.aborted) throw aborted(signal);
      const fact = { source: "lease16", chainId, ledger: v.ledger, deployment: id, claimBlock: C.blockNumber, claimLogIndex: C.logIndex };
      return { fact, factJson: JSON.stringify(fact), block: { number: v.B, hash: v.hash, time: v.time, finalized: v.B },
               claim: { blockNumber: C.blockNumber, blockHash: C.blockHash, logIndex: C.logIndex, transactionHash: C.transactionHash, runner: row.runner },
               evidence: { authority: "consumer-domain-derivation", tier: "l1-finalized-derived", coverageFromBlock: v.from } };
    }, signal);
  }
  return { writerAuthority };
}

/**
 * The production selector. ENCLAVE_WRITER_AUTHORITY_SOURCE unset: null (the relay keeps its existing selection: the legacy quorum
 * reader, or under the verifier authority the explicit writer_authority_unproven refusal). "derived": the relay's verifier
 * authority is required (relayChain); the reader is started IN THIS PROCESS from the reviewed network runtime module with the
 * operator's private reader config (ENCLAVE_DERIVED_READER_CONFIG, absolute path of a JSON file) and anchor journal
 * (ENCLAVE_DERIVED_ANCHOR_JOURNAL); ENCLAVE_DERIVED_READER_API_PORT optionally serves KVM's loopback witness API for the untrusted
 * witness producer (orchestration only, never a capability). Anything else throws: the relay stops at startup.
 */
export async function derivedWriterAuthorityFromEnv(env, { relayChain, loadRuntime, readFile, ledgerPin = env.DEPLOYMENTS_ADDRESS || "",
                                                         addressBook = env.ADDRESS_BOOK_ADDRESS || "", now } = {}) {
  const sel = String(env[SOURCE_ENV] ?? "").trim();
  if (!sel) return null;
  if (sel !== "derived") throw new Error(`${SOURCE_ENV} must be "derived" or unset (got "${sel.slice(0, 40)}")`);
  if (!relayChain?.client) throw new Error(`${SOURCE_ENV}=derived needs the relay's verifier authority (ENCLAVE_CHAIN_AUTHORITY=verifier): the quorum reader stays the legacy path`);
  const cfgPath = String(env[CONFIG_ENV] ?? ""), journalPath = String(env[JOURNAL_ENV] ?? "");
  for (const [k, p] of [[CONFIG_ENV, cfgPath], [JOURNAL_ENV, journalPath]])
    if (!p.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(p)) throw new Error(`${k} must be an absolute file path (a URL or HTTP endpoint is never a reader capability)`);
  const verifier = String(env.ENCLAVE_CHAIN_VERIFIER ?? "");
  const runtime = await loadRuntime();
  if (typeof runtime?.startDerivedLifecycleReader !== "function" || typeof runtime?.openLifecycleJournal !== "function")
    throw new Error("this build's network runtime has no derived reader (KVM R2/R3 not composed): the writer authority cannot be derived");
  const config = JSON.parse(await readFile(cfgPath, "utf8"));
  const service = await runtime.startDerivedLifecycleReader(config, { verifier, journal: runtime.openLifecycleJournal(journalPath) });
  if (typeof service?.reader?.readDerivedLogs !== "function" || typeof service?.snapshot !== "function")
    throw new Error("the derived reader has no readDerivedLogs (R3) capability");
  let api = null;
  if (env[API_PORT_ENV]) {
    const port = Number(env[API_PORT_ENV]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof runtime.serveDerivedReader !== "function") throw new Error(`${API_PORT_ENV} is invalid or unsupported`);
    api = await runtime.serveDerivedReader(service.reader, { port });
  }
  const capability = { snapshot: service.snapshot, readDerivedLogs: (q) => service.reader.readDerivedLogs(q) };
  // the reader config's own maxAnchorAgeSec bounds KVM's reader only; the writer authority keeps its fixed 120 s ceiling
  const authority = createDerivedWriterAuthority({ capability, fresh: relayChain.client, ledgerPin, addressBook, ...(now ? { now } : {}) });
  return { ...authority, describe: () => ({ source: "derived", tier: "l1-finalized-derived", witnessApi: api ? `127.0.0.1:${api.port}` : null }),
           close: async () => { await api?.close(); await service.close(); } };
}
