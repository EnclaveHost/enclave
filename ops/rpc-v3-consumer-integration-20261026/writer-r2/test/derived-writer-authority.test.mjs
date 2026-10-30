// relay/derived-writer-authority.mjs: ADAPTER LOGIC ONLY. The capability below is an in-test fake whose `complete: true` proves
// nothing: these tests show what the adapter does WITH a complete coverage answer (replay, same-anchor binding, filter/range/order
// checks, refusals, deny-only freshness, no public fallback). Omission detection itself is the native v3 executable's and the
// derived reader's property: test/derived-writer-authority-kvm-store.test.mjs drives the ACTUAL (in-progress) KVM coverage store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAIMED, RENEWED, RELEASED, LeaseGenerationError } from "../relay/lease-generation.mjs";
import { createDerivedWriterAuthority, derivedWriterAuthorityFromEnv, checkDerivedLogs, LEASE_TOPIC0S, MAX_ANCHOR_AGE_SEC } from "../relay/derived-writer-authority.mjs";

const h = (b, n = 32) => "0x" + b.repeat(n);
const ID = h("11"), RUNNER = h("22"), OTHER_RUNNER = h("33"), OP = "0x" + "44".repeat(20), OP2 = "0x" + "55".repeat(20);
const LEDGER = "0x" + "66".repeat(20), LEDGER2 = "0x" + "67".repeat(20), BOOK = "0x" + "77".repeat(20);
const O = 53_000_000, B = O + 1_000, HASH = h("ab"), NOW = 1_700_000_000, T = NOW - 60;                        // anchor 60 s old: inside the 120 s ceiling
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (a) => "0x" + "0".repeat(24) + a.slice(2);
let seq = 0;
const tx = () => "0x" + (++seq).toString(16).padStart(64, "0");
const bh = (n) => "0x" + n.toString(16).padStart(64, "c");
const claimed = (n, i, until, { runner = RUNNER, op = OP, id = ID, address = LEDGER } = {}) =>
  ({ address, blockNumber: O + n, blockHash: bh(O + n), logIndex: i, topics: [CLAIMED, id, runner, pad(op)], data: "0x" + word(until) + word(5), txHash: tx() });
const renewed = (n, i, until, { runner = RUNNER, id = ID, address = LEDGER } = {}) =>
  ({ address, blockNumber: O + n, blockHash: bh(O + n), logIndex: i, topics: [RENEWED, id, runner], data: "0x" + word(until) + word(5), txHash: tx() });
const released = (n, i, { id = ID, address = LEDGER } = {}) =>
  ({ address, blockNumber: O + n, blockHash: bh(O + n), logIndex: i, topics: [RELEASED, id, RUNNER], data: "0x" + word(7), txHash: tx() });
const row = (o = {}) => ({ id: ID, owner: OP, appRef: "", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 1, appPort: 80, isPublic: false, active: true,
  createdAt: 1n, rate: 1n, balance6: 1n, spent6: 1n, runner: RUNNER, runnerOperator: OP, leaseUntil: BigInt(NOW + 1200), ...o });

/** A fake world. `logs`: the ledger's complete lease logs (any order the test wants to check); `calls` records every read. */
function world({ logs = [claimed(950, 3, NOW + 1200)], rows = { [LEDGER]: row() }, bookAt = LEDGER, schema = 16, availableFrom = O + 900, time = T,
                 later = [], headRow, headBook = bookAt, head = B + 300, mutate = (r) => r, freshFails = false } = {}) {
  const calls = [];
  const capability = {
    async snapshot(read) {
      const client = {
        getBlock: async () => ({ number: BigInt(B), hash: HASH, timestamp: BigInt(time) }),
        readContract: async ({ address, functionName, args }) => {
          calls.push(["snapshot", functionName, address]);
          if (functionName === "addr") { assert.equal(address, BOOK); return bookAt; }
          if (functionName === "deploymentsSchema") return BigInt(schema);
          if (functionName === "get") return rows[address] ?? row({ id: h("00") });
          throw new Error(functionName);
        },
      };
      const value = await read(client, BigInt(B), {});
      return { blockNumber: BigInt(B), blockHash: HASH, value };
    },
    async readDerivedLogs(q) {
      calls.push(["logs", q.fromBlock, q.toBlock, q.address]);
      if (q.anchor.number !== B || q.anchor.hash !== HASH) throw new Error("anchor is not current");
      if (q.fromBlock < availableFrom) throw new Error("requested history is outside runtime-verified coverage");
      const sel = logs.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock);
      return mutate({ format: "enclave-derived-logs/v1", logs: sel, anchor: { tier: "l1-finalized-derived", base: { number: B, hash: HASH } },
        filter: { address: q.address, topic0s: q.topic0s, topic1: q.topic1 },
        coverage: { format: "enclave-lease16-coverage/v1", filterId: "lease16-events/v1", fromBlock: q.fromBlock, toBlock: q.toBlock, complete: true,
                    availableFromBlock: availableFrom, availableToBlock: B } }, q);
    },
  };
  const fresh = {
    getBlockNumber: async () => { if (freshFails) throw new Error("verifier down"); return BigInt(head); },
    request: async ({ method, params }) => { calls.push(["fresh", method]); assert.equal(method, "eth_getLogs"); assert.equal(params[0].fromBlock, "0x" + (B + 1).toString(16)); return later; },
    readContract: async ({ functionName, address }) => functionName === "addr" ? headBook : (headRow ?? rows[address] ?? row({ id: h("00") })),
  };
  return { capability, fresh, calls };
}
const authority = (w, o = {}) => createDerivedWriterAuthority({ capability: w.capability, fresh: w.fresh, addressBook: BOOK, now: () => NOW * 1000, ...o });
const refuses = async (p, code) => {
  await assert.rejects(p, (e) => { assert.ok(e instanceof LeaseGenerationError, String(e)); assert.equal(e.code, code, e.message); return true; });
};

test("a complete-coverage answer yields exactly the legacy lease16 fact of the last claim, bound to the snapshot's anchor", async () => {
  const w = world({ logs: [claimed(950, 3, NOW + 600), renewed(980, 0, NOW + 1200)] });
  const r = await authority(w).writerAuthority(ID, { runner: RUNNER });
  assert.equal(r.factJson, JSON.stringify({ source: "lease16", chainId: 8453, ledger: LEDGER, deployment: ID, claimBlock: O + 950, claimLogIndex: 3 }));
  assert.deepEqual(r.block, { number: B, hash: HASH, time: T, finalized: B });
  assert.equal(r.evidence.tier, "l1-finalized-derived");
  // the reader was asked at the snapshot's own anchor: a probe at B, then [availableFrom, B]
  assert.deepEqual(w.calls.filter((c) => c[0] === "logs"), [["logs", B, B, LEDGER], ["logs", O + 900, B, LEDGER]]);
});

test("the coverage query starts at max(ledger floor, reader's availableFrom); the default floor is the live 16d ledger's first block", async () => {
  const w = world({ logs: [claimed(950, 3, NOW + 1200)] });
  await authority(w, { fromBlock: O + 940 }).writerAuthority(ID);
  assert.deepEqual(w.calls.filter((c) => c[0] === "logs").map((c) => c[1]), [B, O + 940]);
  const d = world();
  await authority(d).writerAuthority(ID);                                                     // default floor 52,515,705 < availableFrom
  assert.deepEqual(d.calls.filter((c) => c[0] === "logs").map((c) => c[1]), [B, O + 900]);
});

test("same-runner re-claim after expiry: the LATER claim is the fact (complete logs make the older generation unusable)", async () => {
  const w = world({ logs: [claimed(910, 0, NOW - 4000), renewed(920, 1, NOW - 3000), claimed(960, 2, NOW + 600), renewed(990, 0, NOW + 1200)] });
  const r = await authority(w).writerAuthority(ID);
  assert.equal(r.fact.claimBlock, O + 960);
  assert.equal(r.fact.claimLogIndex, 2);
});

test("replay refusals: released after the claim, renewals not replaying, another runner/operator, released row", async () => {
  await refuses(authority(world({ logs: [claimed(950, 0, NOW + 1200), released(960, 0)] })).writerAuthority(ID), "inconsistent_logs");
  await refuses(authority(world({ logs: [claimed(950, 0, NOW + 600), renewed(960, 0, NOW + 900)] })).writerAuthority(ID), "inconsistent_logs");
  await refuses(authority(world({ logs: [claimed(950, 0, NOW + 1200, { runner: OTHER_RUNNER })] })).writerAuthority(ID), "inconsistent_logs");
  await refuses(authority(world({ logs: [claimed(950, 0, NOW + 1200, { op: OP2 })] })).writerAuthority(ID), "inconsistent_logs");
  await refuses(authority(world({ logs: [claimed(950, 0, NOW + 1200), renewed(960, 0, NOW + 1200, { runner: OTHER_RUNNER })] })).writerAuthority(ID), "inconsistent_logs");
  await refuses(authority(world({ rows: { [LEDGER]: row({ runner: h("00"), runnerOperator: "0x" + "00".repeat(20) }) } })).writerAuthority(ID), "lease_not_current");
  await refuses(authority(world()).writerAuthority(ID, { runner: OTHER_RUNNER }), "runner_mismatch");
});

test("a claim older than the derived coverage (pre-bootstrap) stays REFUSED: no fact, not retried, nothing signed", async () => {
  const w = world({ logs: [claimed(850, 0, NOW - 100), renewed(950, 0, NOW + 1200)], availableFrom: O + 900 });
  await assert.rejects(authority(w).writerAuthority(ID), (e) => e.code === "claim_not_covered" && e.retry === false);
  // the coverage start is the reader's: asking below it is never attempted
  assert.ok(w.calls.filter((c) => c[0] === "logs").every((c) => c[1] >= O + 900));
});

test("anchor binding: logs of another anchor, another filter or another range are refused", async () => {
  const bad = (mutate) => authority(world({ mutate })).writerAuthority(ID);
  await refuses(bad((r) => ({ ...r, anchor: { ...r.anchor, base: { number: B, hash: h("ac") } } })), "anchor_mismatch");
  await refuses(bad((r) => ({ ...r, anchor: { ...r.anchor, base: { number: B - 1, hash: HASH } } })), "anchor_mismatch");
  await refuses(bad((r) => ({ ...r, filter: { ...r.filter, topic1: h("12") } })), "derived_logs_invalid");
  await refuses(bad((r) => ({ ...r, filter: { ...r.filter, topic0s: [CLAIMED] } })), "derived_logs_invalid");
  // KVM's store echoes the range too: accepted when it is exactly the asked range, refused otherwise or with any other key
  assert.equal((await authority(world({ mutate: (r, q) => ({ ...r, filter: { ...r.filter, fromBlock: q.fromBlock, toBlock: q.toBlock } }) })).writerAuthority(ID)).fact.claimBlock, O + 950);
  await refuses(bad((r) => ({ ...r, filter: { ...r.filter, fromBlock: 0 } })), "derived_logs_invalid");
  await refuses(bad((r) => ({ ...r, filter: { ...r.filter, complete: true } })), "derived_logs_invalid");
  await refuses(bad((r) => ({ ...r, coverage: { ...r.coverage, fromBlock: r.coverage.fromBlock + 1 } })), "coverage_incomplete");
  await refuses(bad((r) => ({ ...r, coverage: { ...r.coverage, complete: false } })), "coverage_incomplete");
  await refuses(bad((r) => ({ ...r, coverage: { ...r.coverage, availableToBlock: B - 1 } })), "coverage_incomplete");
  await refuses(bad((r) => ({ ...r, format: "enclave-derived-logs/v0" })), "derived_logs_invalid");
  // the reader itself refusing (its anchor moved on, a gap, a tampered chunk, cancellation...) is a refusal, never a fallback
  const w = world(); w.capability.readDerivedLogs = async () => { throw new Error("runtime coverage gap"); };
  await refuses(authority(w).writerAuthority(ID), "derived_unavailable");
});

test("validated only after the confirmed-ledger filter: foreign-address / other-deployment logs are ignored, this lease's malformed ones refuse", async () => {
  const foreign = [claimed(955, 0, 1, { address: LEDGER2 }), { address: LEDGER2, blockNumber: O + 956, blockHash: "junk", logIndex: -1, topics: [CLAIMED], data: "zz", txHash: "" },
                   claimed(957, 0, 1, { id: h("99") })];
  const w = world({ logs: [claimed(950, 3, NOW + 1200), ...foreign] });
  assert.equal((await authority(w).writerAuthority(ID)).fact.claimBlock, O + 950);
  const shape = (l) => authority(world({ logs: [claimed(950, 3, NOW + 1200), l] })).writerAuthority(ID);
  await refuses(shape({ ...renewed(960, 0, NOW + 1200), topics: [RENEWED, ID] }), "bad_answer");                 // ABI topic count
  await refuses(shape({ ...renewed(960, 0, NOW + 1200), data: "0x" + word(1) }), "bad_answer");                 // ABI data words
  await refuses(authority(world({ mutate: (r) => ({ ...r, logs: [...r.logs, { ...renewed(960, 0, NOW + 1200), blockNumber: B + 1, blockHash: bh(B + 1) }] }) }))
    .writerAuthority(ID), "bad_answer");                                                                          // outside the asked range
  await refuses(shape({ ...renewed(950, 3, NOW + 1200) }), "bad_answer");                                         // duplicate (block, logIndex)
  await refuses(authority(world({ logs: [renewed(990, 0, NOW + 1200), claimed(950, 3, NOW + 1200)] })).writerAuthority(ID), "bad_answer");  // order
  await refuses(shape({ ...renewed(950, 4, NOW + 1200), blockHash: bh(O + 951) }), "bad_answer");                   // two hashes, one number
});

test("admin AddressBook migration is followed AT the derived anchor; a pinned DEPLOYMENTS_ADDRESS wins; a book moved after it refuses", async () => {
  const w = world({ bookAt: LEDGER2, rows: { [LEDGER2]: row() }, logs: [claimed(950, 3, NOW + 1200, { address: LEDGER2 })] });
  const r = await authority(w).writerAuthority(ID);
  assert.equal(r.fact.ledger, LEDGER2);
  assert.ok(w.calls.filter((c) => c[0] === "logs").every((c) => c[3] === LEDGER2), "the coverage filter is the book's ledger at B");
  const p = world({ bookAt: LEDGER2 });
  assert.equal((await authority(p, { ledgerPin: LEDGER }).writerAuthority(ID)).fact.ledger, LEDGER);
  assert.ok(!p.calls.some((c) => c[1] === "addr"), "a pinned ledger never reads the book");
  await refuses(authority(world({ headBook: LEDGER2 })).writerAuthority(ID), "ledger_moved");
  await refuses(authority(world({ bookAt: "0x" + "00".repeat(20) })).writerAuthority(ID), "no_ledger");
});

test("r2 freshness = the original lease authority's: 120 s ceiling, age == 120 accepted, 121 refused, > 5 s future refused", async () => {
  assert.equal(MAX_ANCHOR_AGE_SEC, 120);
  assert.equal((await authority(world({ time: NOW - 120 })).writerAuthority(ID)).block.time, NOW - 120, "exactly 120 s: accepted (as lease-generation.mjs)");
  await refuses(authority(world({ time: NOW - 121 })).writerAuthority(ID), "stale_snapshot");
  await refuses(authority(world({ time: NOW - 600 })).writerAuthority(ID), "stale_snapshot");          // a typical L1-finalized lag: refused
  await refuses(authority(world({ time: NOW - 1800 })).writerAuthority(ID), "stale_snapshot");
  assert.ok(await authority(world({ time: NOW + 5 })).writerAuthority(ID), "5 s future skew: accepted (as lease-generation.mjs)");
  await refuses(authority(world({ time: NOW + 6 })).writerAuthority(ID), "stale_snapshot");
  // the stale refusal happens before the deny-only check is consulted: the unsafe verifier can never rescue an old anchor
  const w = world({ time: NOW - 121 });
  await refuses(authority(w).writerAuthority(ID), "stale_snapshot");
  assert.ok(!w.calls.some((c) => c[0] === "fresh"));
});

test("r2: the 120 s ceiling can be lowered, never raised (constructor, reader config, env)", async () => {
  for (const bad of [121, 600, 1800, 3600, 0, -1, 1.5, "120", null])
    assert.throws(() => authority(world(), { maxAnchorAgeSec: bad }), /maxAnchorAgeSec must be 1\.\.120/, String(bad));
  assert.ok(authority(world(), { maxAnchorAgeSec: 120 }) && authority(world(), { maxAnchorAgeSec: 30 }));
  await refuses(authority(world({ time: NOW - 31 }), { maxAnchorAgeSec: 30 }).writerAuthority(ID), "stale_snapshot");
  // the production selector: a reader config asking for 1800 s and a stray env knob change nothing - still 120 s
  const w = world({ time: NOW - 600 });
  const runtime = { openLifecycleJournal: () => ({}), startDerivedLifecycleReader: async () =>
    ({ reader: { readDerivedLogs: w.capability.readDerivedLogs }, snapshot: w.capability.snapshot, close: async () => {} }) };
  const a = await derivedWriterAuthorityFromEnv({ ENCLAVE_WRITER_AUTHORITY_SOURCE: "derived", ENCLAVE_DERIVED_READER_CONFIG: "/etc/r.json",
      ENCLAVE_DERIVED_ANCHOR_JOURNAL: "/var/j", ADDRESS_BOOK_ADDRESS: BOOK, ENCLAVE_WRITER_AUTHORITY_MAX_AGE_SEC: "1800", MAX_BLOCK_AGE_SEC: "1800" },
    { relayChain: { client: w.fresh }, loadRuntime: async () => runtime, readFile: async () => JSON.stringify({ maxAnchorAgeSec: 1800 }), now: () => NOW * 1000 });
  await refuses(a.writerAuthority(ID), "stale_snapshot");
});

test("freshness: an expired lease and an unsupported schema refuse", async () => {
  await refuses(authority(world({ time: NOW - 61 }), { maxAnchorAgeSec: 60 }).writerAuthority(ID), "stale_snapshot");
  await refuses(authority(world({ rows: { [LEDGER]: row({ leaseUntil: BigInt(NOW - 1) }) } })).writerAuthority(ID), "lease_not_current");
  await refuses(authority(world({ schema: 15 })).writerAuthority(ID), "unsupported_schema");
  await refuses(authority(world({ rows: {} })).writerAuthority(ID), "no_deployment");
});

test("the unsafe local verifier is DENY-ONLY: later claim/release, runner change or its failure refuse; it never makes a fact", async () => {
  await refuses(authority(world({ later: [{ topics: [CLAIMED, ID] }] })).writerAuthority(ID), "claim_not_final");
  await refuses(authority(world({ later: [{ topics: [RELEASED, ID] }] })).writerAuthority(ID), "lease_not_current");
  await refuses(authority(world({ headRow: row({ runner: OTHER_RUNNER }) })).writerAuthority(ID), "lease_not_current");
  await refuses(authority(world({ headRow: row({ leaseUntil: BigInt(NOW) }) })).writerAuthority(ID), "lease_not_current");
  await refuses(authority(world({ freshFails: true })).writerAuthority(ID), "fresh_check_unavailable");
  await refuses(authority(world({ head: B - 1 })).writerAuthority(ID), "fresh_head_behind");
  // a fresh head that shows the claim cannot rescue a claim the derived coverage does not have
  const w = world({ logs: [renewed(950, 0, NOW + 1200)], later: [], headRow: row() });
  await refuses(authority(w).writerAuthority(ID), "claim_not_covered");
  assert.ok(!w.calls.some((c) => c[0] === "fresh"), "the deny-only check runs only after the derived proof succeeded");
});

test("no implicit public fallback: the adapter never fetches, and cancellation refuses", async () => {
  const realFetch = globalThis.fetch; let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("no network"); };
  try {
    await authority(world()).writerAuthority(ID);
    await refuses(authority(world({ logs: [] })).writerAuthority(ID), "claim_not_covered");
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, 0);
  const ac = new AbortController(); ac.abort(new Error("deadline"));
  await refuses(authority(world()).writerAuthority(ID, { signal: ac.signal }), "aborted");
  await refuses(authority(world()).writerAuthority("0x12"), "bad_id");
});

test("concurrent releases are serialized through the one-at-a-time reader (no 'busy' refusals), each with its own result", async () => {
  const w = world({ rows: { [LEDGER]: row() } });
  let inFlight = 0, peak = 0; const snap = w.capability.snapshot;
  w.capability.snapshot = async (read) => { inFlight++; peak = Math.max(peak, inFlight); try { await new Promise((r) => setTimeout(r, 5)); return await snap(read); } finally { inFlight--; } };
  const a = authority(w);
  const rs = await Promise.all([a.writerAuthority(ID), a.writerAuthority(ID), a.writerAuthority(ID)]);
  assert.equal(peak, 1);
  assert.ok(rs.every((r) => r.fact.claimBlock === O + 950));
});

test("checkDerivedLogs filters by the confirmed ledger before validating (exported contract)", () => {
  const ask = { address: LEDGER, topic0s: [...LEASE_TOPIC0S], topic1: ID, fromBlock: O + 900, toBlock: B, anchor: { number: B, hash: HASH } };
  const res = { format: "enclave-derived-logs/v1", anchor: { base: { number: B, hash: HASH } }, filter: { address: LEDGER, topic0s: [...LEASE_TOPIC0S], topic1: ID },
    coverage: { format: "enclave-lease16-coverage/v1", filterId: "lease16-events/v1", fromBlock: O + 900, toBlock: B, complete: true, availableFromBlock: O + 900, availableToBlock: B },
    logs: [{ address: LEDGER2, topics: ["junk"] }, claimed(950, 0, 1)] };
  assert.equal(checkDerivedLogs(res, ask).length, 1);
});

test("production selector: unset keeps the existing selection; anything else is explicit, in-process and fail-closed", async () => {
  const relayChain = { client: world().fresh };
  const base = { ENCLAVE_DERIVED_READER_CONFIG: "/etc/enclave/reader.json", ENCLAVE_DERIVED_ANCHOR_JOURNAL: "/var/lib/enclave/anchor.json", ADDRESS_BOOK_ADDRESS: BOOK };
  const never = async () => { throw new Error("must not load"); };
  assert.equal(await derivedWriterAuthorityFromEnv({}, { relayChain, loadRuntime: never }), null);
  await assert.rejects(derivedWriterAuthorityFromEnv({ ...base, ENCLAVE_WRITER_AUTHORITY_SOURCE: "quorum" }, { relayChain, loadRuntime: never }), /must be "derived" or unset/);
  await assert.rejects(derivedWriterAuthorityFromEnv({ ...base, ENCLAVE_WRITER_AUTHORITY_SOURCE: "derived" }, { relayChain: null, loadRuntime: never }), /verifier authority/);
  for (const u of ["http://127.0.0.1:9000/anchor", "file:///etc/x", "relative.json"])
    await assert.rejects(derivedWriterAuthorityFromEnv({ ...base, ENCLAVE_WRITER_AUTHORITY_SOURCE: "derived", ENCLAVE_DERIVED_READER_CONFIG: u }, { relayChain, loadRuntime: never }), /absolute file path/);
  await assert.rejects(derivedWriterAuthorityFromEnv({ ...base, ENCLAVE_WRITER_AUTHORITY_SOURCE: "derived" }, { relayChain, loadRuntime: async () => ({}) }), /not composed/);
  // the composed runtime: started in-process with the operator's file config and journal, then the adapter runs on it
  const w = world(); let started;
  const runtime = { openLifecycleJournal: (p) => ({ p }), startDerivedLifecycleReader: async (config, o) => { started = { config, o };
    return { reader: { readDerivedLogs: w.capability.readDerivedLogs }, snapshot: w.capability.snapshot, close: async () => {} }; } };
  const a = await derivedWriterAuthorityFromEnv({ ...base, ENCLAVE_WRITER_AUTHORITY_SOURCE: "derived", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:8545" },
    { relayChain: { client: w.fresh }, loadRuntime: async () => runtime, readFile: async () => JSON.stringify({ maxAnchorAgeSec: 1800 }), now: () => NOW * 1000 });
  assert.deepEqual(started.o.journal, { p: "/var/lib/enclave/anchor.json" });
  assert.equal(started.o.verifier, "http://127.0.0.1:8545");
  assert.equal((await a.writerAuthority(ID)).fact.claimBlock, O + 950);
  const noR3 = { ...runtime, startDerivedLifecycleReader: async () => ({ reader: {}, snapshot: w.capability.snapshot }) };
  await assert.rejects(derivedWriterAuthorityFromEnv({ ...base, ENCLAVE_WRITER_AUTHORITY_SOURCE: "derived" }, { relayChain, loadRuntime: async () => noR3, readFile: async () => "{}" }), /readDerivedLogs/);
});
