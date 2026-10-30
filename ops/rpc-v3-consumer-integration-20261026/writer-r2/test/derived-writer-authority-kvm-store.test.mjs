// relay/derived-writer-authority.mjs over KVM's ACTUAL coverage validator + durable coverage store (network/derived-reader/
// coverage.mjs + coverage-store.mjs, imported READ-ONLY from KVM's worktree; their in-progress R2/R3, sha256 recorded by the job).
// What is real here: KVM's v3 coverage validation, its hash-linked manifest/chunk store, its query validation (exact current anchor,
// lease topics, bounded range), its runtime-verified-segment rule, gap and tamper refusals. What is NOT proven here: completeness of
// the coverage itself - the native results below are FIXTURES shaped like the pinned v3 binary's output (blocks and logs are
// invented); completeness is the native executable's property (root's r2 Rust tests) and needs a real witness to be shown.
// The bridge snapshot (row reads at the anchor) is an in-test stand-in; KVM's provider.readDerivedLogs is mirrored as
// store.read(query, currentAnchor) (its exclusive lock and freshness recheck are KVM's, integration pending).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { keccak256 } from "viem";
import { CLAIMED, RENEWED, LeaseGenerationError } from "../relay/lease-generation.mjs";
import { createDerivedWriterAuthority } from "../relay/derived-writer-authority.mjs";

const KVM = process.env.KVM_TREE;
const skip = !KVM ? "KVM_TREE unset (the job sets it)" : false;
const kvm = async (f) => import(pathToFileURL(path.join(KVM, "network/derived-reader", f)).href);

const O = 53_000_000, NOW = 1_700_000_000;
const h = (b) => "0x" + b.repeat(32);
const ID = h("11"), RUNNER = h("22"), OP = "0x" + "44".repeat(20), LEDGER = "0x" + "66".repeat(20), OTHER = "0x" + "67".repeat(20), BOOK = "0x" + "77".repeat(20);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const hx = (n, tag) => "0x" + (tag + n.toString(16)).padStart(64, "0");
const blockOf = (n, t) => {
  const b = { number: n, hash: hx(n, "b"), stateRoot: hx(n, "5"), messagePasserStorageRoot: hx(n, "9"), receiptsRoot: hx(n, "e"), transactionsRoot: hx(n, "7"), timestamp: t };
  b.outputRoot = keccak256(`0x${"0".repeat(64)}${b.stateRoot.slice(2)}${b.messagePasserStorageRoot.slice(2)}${b.hash.slice(2)}`);
  return b;
};
const anchorOf = (b) => ({ tier: "l1-finalized-derived", base: { number: b.number, hash: b.hash, stateRoot: b.stateRoot, messagePasserStorageRoot: b.messagePasserStorageRoot,
  outputRoot: b.outputRoot, timestamp: b.timestamp }, l1: { number: 26_000_000 + b.number - O, hash: hx(b.number, "1"), stateRoot: hx(b.number, "2"), timestamp: b.timestamp + 60 } });
/** A native v3 result FIXTURE for (agreed, to]: every block, plus `logs` (full native log objects). */
function segment(agreed, to, logs) {
  const blocks = []; for (let n = agreed + 1; n <= to; n++) blocks.push(blockOf(n, NOW - 260 + (n - O)));
  const byNum = new Map(blocks.map((b) => [b.number, b]));
  const full = logs.map((l) => ({ ...l, blockHash: byNum.get(l.blockNumber).hash }));
  return { result: { format: "enclave-base-derivation-result/v3", intermediateRoots: "0x" + blocks.map((b) => b.outputRoot.slice(2)).join(""),
    coverage: { format: "enclave-lease16-coverage/v1", filterId: "lease16-events/v1", fromBlock: agreed + 1, toBlock: to, blocks, logs: full } },
    input: { trusted: { intermediateBlockInterval: 1 }, bound: { agreedL2BlockNumber: agreed } }, anchor: anchorOf(blocks.at(-1)), agreedBlock: blockOf(agreed, NOW - 260 + (agreed - O)) };
}
const claimedLog = (n, i, until, address = LEDGER) => ({ address, blockNumber: n, logIndex: i, topics: [CLAIMED, ID, RUNNER, "0x" + "0".repeat(24) + OP.slice(2)],
  data: "0x" + word(until) + word(5), txHash: hx(n * 10 + i, "f") });
const renewedLog = (n, i, until) => ({ address: LEDGER, blockNumber: n, logIndex: i, topics: [RENEWED, ID, RUNNER], data: "0x" + word(until) + word(5), txHash: hx(n * 10 + i, "f") });

async function harness(segments) {
  const { validateCoverage } = await kvm("coverage.mjs");
  const { openCoverageStore } = await kvm("coverage-store.mjs");
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), "kvm-cov-")); fs.chmodSync(dir, 0o700);
  const store = await openCoverageStore(path.join(dir, "store"), { binding: "a".repeat(64), initialize: true, maximumBytes: 64 << 20 });
  let current = null;
  for (const s of segments) {
    const checked = validateCoverage(s.result, s.input, s.anchor);
    const publish = store.stage(checked, anchorOf(s.agreedBlock), s.anchor);
    publish(); current = s.anchor;
  }
  const leaseUntil = BigInt(NOW + 1200);
  const capability = {
    snapshot: async (read) => {
      const a = current, client = {
        getBlock: async () => ({ number: BigInt(a.base.number), hash: a.base.hash, timestamp: BigInt(a.base.timestamp) }),
        readContract: async ({ functionName }) => functionName === "addr" ? LEDGER : functionName === "deploymentsSchema" ? 16n
          : { id: ID, active: true, runner: RUNNER, runnerOperator: OP, leaseUntil },
      };
      return { blockNumber: BigInt(a.base.number), blockHash: a.base.hash, value: await read(client, BigInt(a.base.number), {}) };
    },
    readDerivedLogs: (q) => store.read(q, current, { signal: q.signal }),
  };
  const fresh = { getBlockNumber: async () => BigInt(current.base.number + 5), request: async () => [],
    readContract: async ({ functionName }) => functionName === "addr" ? LEDGER : { id: ID, active: true, runner: RUNNER, runnerOperator: OP, leaseUntil } };
  const authority = createDerivedWriterAuthority({ capability, fresh, addressBook: BOOK, now: () => NOW * 1000 });
  return { store, dir, authority, setAnchor: (a) => { current = a; }, current: () => current };
}
const code = async (p, c) => assert.rejects(p, (e) => { assert.ok(e instanceof LeaseGenerationError, String(e)); assert.equal(e.code, c, e.message); return true; });

test("actual KVM store: two contiguous runtime-verified segments -> the lease16 fact (claim in the first, renewal in the second)", { skip }, async () => {
  const s1 = segment(O + 100, O + 150, [claimedLog(O + 120, 2, NOW + 600), claimedLog(O + 121, 0, 1, OTHER)]);   // an innocuous other-address collision
  const s2 = segment(O + 150, O + 200, [renewedLog(O + 170, 1, NOW + 1200)]);
  const k = await harness([s1, s2]);
  const r = await k.authority.writerAuthority(ID, { runner: RUNNER });
  assert.equal(r.factJson, JSON.stringify({ source: "lease16", chainId: 8453, ledger: LEDGER, deployment: ID, claimBlock: O + 120, claimLogIndex: 2 }));
  assert.equal(r.block.number, O + 200);
  assert.equal(r.evidence.coverageFromBlock, O + 101);
  k.store.close();
});

test("actual KVM store: the claim before the store's first runtime-verified block (pre-bootstrap) stays claim_not_covered", { skip }, async () => {
  const s2 = segment(O + 150, O + 200, [renewedLog(O + 170, 1, NOW + 1200)]);         // the claim at O+120 was never covered
  const k = await harness([s2]);
  await assert.rejects(k.authority.writerAuthority(ID), (e) => e.code === "claim_not_covered" && e.retry === false);
  k.store.close();
});

test("actual KVM store: a chunk altered on disk (a dropped renewal) is refused by the store's hash link, and the store then fails closed", { skip }, async () => {
  const s1 = segment(O + 100, O + 150, [claimedLog(O + 120, 2, NOW + 600)]);
  const s2 = segment(O + 150, O + 200, [renewedLog(O + 170, 1, NOW + 1200)]);
  const k = await harness([s1, s2]);
  const sdir = path.join(k.dir, "store");
  const chunk = fs.readdirSync(sdir).map((f) => path.join(sdir, f)).find((f) => /[0-9a-f]{64}\.json$/.test(f) && fs.readFileSync(f, "utf8").includes(RENEWED.slice(2)));
  const raw = fs.readFileSync(chunk, "utf8");
  fs.writeFileSync(chunk, raw.replace(RENEWED.slice(2), CLAIMED.slice(2)));          // same size, other content
  await code(k.authority.writerAuthority(ID), "derived_unavailable");
  await code(k.authority.writerAuthority(ID), "derived_unavailable");                // failed store: every later read refuses too
  k.store.close();
});

test("actual KVM store: a query for any anchor but the store's current one is refused (no stale or foreign anchor)", { skip }, async () => {
  const s1 = segment(O + 100, O + 150, [claimedLog(O + 120, 2, NOW + 1200)]);
  const k = await harness([s1]);
  const real = k.current();
  // the snapshot is pinned to another block hash than the reader's current anchor
  k.setAnchor({ ...real, base: { ...real.base, hash: h("ee") } });
  const readCurrent = (q) => k.store.read(q, real, { signal: q.signal });
  const auth = createDerivedWriterAuthority({ capability: { snapshot: async (read) => {
      const client = { getBlock: async () => ({ number: BigInt(real.base.number), hash: h("ee"), timestamp: BigInt(real.base.timestamp) }),
        readContract: async ({ functionName }) => functionName === "addr" ? LEDGER : functionName === "deploymentsSchema" ? 16n
          : { id: ID, active: true, runner: RUNNER, runnerOperator: OP, leaseUntil: BigInt(NOW + 1200) } };
      return { blockNumber: BigInt(real.base.number), blockHash: h("ee"), value: await read(client, BigInt(real.base.number), {}) }; },
    readDerivedLogs: readCurrent }, fresh: { getBlockNumber: async () => 0n, request: async () => [], readContract: async () => null }, addressBook: BOOK, now: () => NOW * 1000 });
  await code(auth.writerAuthority(ID), "derived_unavailable");
  k.store.close();
});

test("actual KVM store: a gap between segments is refused at staging; nothing beyond the gap ever becomes readable", { skip }, async () => {
  const s1 = segment(O + 100, O + 150, [claimedLog(O + 120, 2, NOW + 1200)]);
  const s3 = segment(O + 160, O + 200, []);                                           // O+151..O+160 never derived
  const { validateCoverage } = await kvm("coverage.mjs");
  const k = await harness([s1]);
  assert.throws(() => k.store.stage(validateCoverage(s3.result, s3.input, s3.anchor), anchorOf(s3.agreedBlock), s3.anchor), /gap|predecessor/);
  k.store.close();
});
