// The writer-authority fact of a deployment's CURRENT lease (relay/lease-generation.mjs; work/storage-front-binding-interface.txt)
// on the LIVE rev-16d ledger bytecode (test/fixtures/ledger-rev16d: its runtime, linked and filled with the live
// immutables, hashes to the live code hash), on anvil behind three JSON-RPC providers that behave like real public ones:
//   - the fact is the CURRENT lease's finalized Claimed log: a renewal keeps it, a reclaim (same runner after a release,
//     another runner after expiry) moves it up, another runner or deployment gets none;
//   - finality: not final yet is a retryable "claim_not_final" (Base: ~20 min, observed logs/probe-live.json);
//   - providers: a 200-block range limit and 429s are absorbed; an unserved (archive) history is "history_unavailable",
//     never an empty one; a dropped log, a lying block hash on two of three, an outage of two are refusals;
//   - a long-running lease: once proven, its FINALIZED coverage is kept (store) and a later proof reads only newer blocks,
//     so it survives every provider refusing the old range; a search spread over attempts resumes (budget);
//   - collusion hiding the newest claim yields NO fact (the replay against the row fails), never the older generation;
//   - a reorg replacing the claim yields the canonical claim's fact.
// Only anvil's published dev keys.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startLease16dRig, liveRuntimeHash } from "./helpers/lease16d-rig.mjs";
import { createLeaseGenerationReader, memoryStore, needsWriterAuthority, decodeRow16 } from "../relay/lease-generation.mjs";

const LIVE_CODE_HASH = "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682";
const skip = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return false; } catch { return "needs anvil"; } })();
let rig, clock = 0;
const now = () => Date.now() + clock;
before(async () => { if (!skip) rig = await startLease16dRig(); });
after(async () => { if (rig) await rig.stop(); });
const reader = (o = {}) => createLeaseGenerationReader({ rpcs: rig.peers.map((p) => p.url), ledger: rig.ledger, fromBlock: 0, now,
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), ...o });
const err = async (p) => { try { await p; } catch (e) { return e; } assert.fail("expected a refusal"); };
const factOf = (id, c) => ({ source: "lease16", chainId: 8453, ledger: rig.ledger.toLowerCase(), deployment: id, claimBlock: c.block, claimLogIndex: c.logIndex });
const warp = async (sec) => { await rig.warp(sec); clock += sec * 1000; };

test("the fixture IS the live rev-16d runtime (linked to the live library, live immutables)", { skip }, () => {
  assert.equal(liveRuntimeHash(), LIVE_CODE_HASH);
});

test("the CURRENT lease's finalized claim: renewals keep it, reclaims move it up, finality is waited for", { skip, timeout: 120000 }, async () => {
  rig.honest(40);                                          // "finalized" = head - 40 on every provider
  const id = await rig.create({ config: JSON.stringify({ config: { writerAuthority: "$ENCLAVE_WRITER_AUTHORITY" } }) });
  const R = reader(), A = rig.hosts.a, B = rig.hosts.b;
  await rig.mine(3);                                       // the reader reads 2 blocks behind the head
  assert.equal((await err(R.writerAuthority(id))).code, "lease_not_current", "never claimed");
  const c1 = await rig.claim(id, A); await rig.mine(5);
  let e = await err(R.writerAuthority(id));
  assert.deepEqual([e.code, e.retry], ["claim_not_final", true]);
  await rig.mine(45);
  const f1 = (await R.writerAuthority(id, { runner: A.id })).fact;
  assert.deepEqual(f1, factOf(id, c1));
  await rig.renew(id, A); await rig.mine(45);
  assert.deepEqual((await R.writerAuthority(id)).fact, f1, "a renewal is the same lease: the same fact");
  assert.equal((await err(R.writerAuthority(id, { runner: B.id }))).code, "runner_mismatch");
  // the same runner releases and claims again: a NEW lease, a higher generation
  await rig.release(id, A); const c2 = await rig.claim(id, A); await rig.mine(45);
  const f2 = (await R.writerAuthority(id)).fact;
  assert.deepEqual(f2, factOf(id, c2));
  assert.ok(f2.claimBlock > f1.claimBlock);
  // the lease expires; another runner claims: higher again, and now A is the mismatch
  await warp(1900); const c3 = await rig.claim(id, B); await rig.mine(45);
  const f3 = (await R.writerAuthority(id, { runner: B.id })).fact;
  assert.deepEqual(f3, factOf(id, c3)); assert.ok(f3.claimBlock > f2.claimBlock);
  assert.equal((await err(R.writerAuthority(id, { runner: A.id }))).code, "runner_mismatch");
  assert.equal((await err(R.writerAuthority("0x" + "7".repeat(64)))).code, "no_deployment");
  // and the sia-s3 generation order holds: gen = 16<<48 | block<<16 | index
  const gen = (f) => (16n << 48n) | (BigInt(f.claimBlock) << 16n) | BigInt(f.claimLogIndex);
  assert.ok(gen(f1) < gen(f2) && gen(f2) < gen(f3));
  assert.equal(needsWriterAuthority({ writerAuthority: "$ENCLAVE_WRITER_AUTHORITY" }), true);
  assert.equal(needsWriterAuthority({ indexer: "https://x" }), false);
});

test("public-provider behaviour: range limits and 429s absorbed; history refusals, dropped logs, lies and outages refuse", { skip, timeout: 120000 }, async () => {
  rig.honest(10);
  const id = await rig.create(), A = rig.hosts.a;
  await rig.mine(300);                                     // the claim lies well inside older history
  const c = await rig.claim(id, A); await rig.mine(20);
  // mainnet.base.org: 200-block ranges, and 429s
  for (const p of rig.peers) p.mode.rangeLimit = 200;
  rig.peers[0].mode.rateLimit = 2;
  let R = reader({ windowBlocks: 1000 });
  assert.deepEqual((await R.writerAuthority(id)).fact, factOf(id, c));
  // the 429ing RPC sits out its cooldown after one retry; the others split the range to 200 blocks
  assert.ok(rig.peers[1].mode.calls.filter((m) => m === "eth_getLogs").length > 1, "the range was split");
  // an unserved history on every provider: an error, not an empty history
  rig.honest(10); for (const p of rig.peers) p.mode.historyBelow = c.block + 1;
  const e = await err(reader({ windowBlocks: 8 }).writerAuthority(id));
  assert.deepEqual([e.code, e.retry], ["history_unavailable", false]);
  // one provider drops a log: disagreement
  rig.honest(10); rig.peers[1].mode.dropLastLog = true;
  assert.equal((await err(reader().writerAuthority(id))).code, "disagree");
  // one provider lies about block hashes: the other two still agree
  rig.honest(10); rig.peers[2].mode.lieHash = true;
  assert.deepEqual((await reader().writerAuthority(id)).fact, factOf(id, c));
  // two lie: no agreed snapshot
  rig.peers[1].mode.lieHash = true;
  assert.ok(["disagree", "quorum_unavailable"].includes((await err(reader().writerAuthority(id))).code));
  // two are down: no quorum; one down: fine
  rig.honest(10); rig.peers[0].mode.down = true;
  assert.deepEqual((await reader().writerAuthority(id)).fact, factOf(id, c));
  rig.peers[1].mode.down = true;
  assert.equal((await err(reader().writerAuthority(id))).code, "quorum_unavailable");
  // a stale snapshot (the reader's clock an hour ahead of the agreed block)
  rig.honest(10);
  assert.equal((await err(reader({ now: () => now() + 3_600_000 }).writerAuthority(id))).code, "stale_snapshot");
});

test("a long-running lease: proven once, its finalized coverage carries it past every provider's history limit; a long search resumes", { skip, timeout: 180000 }, async () => {
  rig.honest(10);
  const id = await rig.create(), A = rig.hosts.a;
  const c = await rig.claim(id, A);
  for (let i = 0; i < 4; i++) { await rig.mine(150); await rig.renew(id, A); }   // renewed again and again
  await rig.mine(20);
  // a search over ~600 blocks in 50-block ranges, at most 3 eth_getLogs per provider per attempt: it takes attempts
  const store = memoryStore();
  const R = reader({ windowBlocks: 50, maxRequests: 3, store });
  let fact = null, attempts = 0;
  while (!fact && attempts < 40) {
    attempts++;
    try { fact = (await R.writerAuthority(id)).fact; }
    catch (e) { assert.deepEqual([e.code, e.retry], ["scanning", true], e.message); }
  }
  assert.deepEqual(fact, factOf(id, c)); assert.ok(attempts > 1, "the search was spread over attempts and resumed");
  // later: every provider refuses everything older than the last 100 blocks (a public RPC's horizon). The stored
  // coverage still proves the lease; a reader without it cannot.
  const prove = async () => { for (let k = 0; k < 40; k++) { try { return (await R.writerAuthority(id)).fact; } catch (e) { if (e.code !== "scanning") throw e; } } };
  for (let i = 0; i < 2; i++) {                             // the relay's tracker re-proves the lease between renewals
    await rig.mine(150); await rig.renew(id, A); await rig.mine(20);
    assert.deepEqual(await prove(), factOf(id, c));
  }
  await rig.mine(20);
  const head = Number(await rig.pc.getBlockNumber());
  for (const p of rig.peers) p.mode.historyBelow = head - 60;
  assert.deepEqual((await R.writerAuthority(id)).fact, factOf(id, c), "proven from the stored finalized coverage plus recent blocks only");
  assert.equal((await err(reader({ windowBlocks: 50 }).writerAuthority(id))).code, "history_unavailable", "without the coverage: refused, not guessed");
});

test("a coverage gap longer than one attempt (a relay down for days) closes over attempts, and a reclaim inside it is never missed", { skip, timeout: 180000 }, async () => {
  rig.honest(10);
  const id = await rig.create(), A = rig.hosts.a;
  const c1 = await rig.claim(id, A); await rig.mine(20);
  const store = memoryStore(), R = reader({ windowBlocks: 50, maxRequests: 3, store });
  const prove = async () => { let n = 0; for (;;) { n++; try { return [(await R.writerAuthority(id)).fact, n]; } catch (e) { assert.equal(e.code, "scanning", e.message); assert.ok(n < 40); } } };
  assert.deepEqual((await prove())[0], factOf(id, c1));
  // the relay is away: 600 blocks pass, the SAME runner releases and claims again in the middle of them
  await rig.mine(300); await rig.release(id, A); const c2 = await rig.claim(id, A); await rig.mine(300);
  const [f, attempts] = await prove();
  assert.deepEqual(f, factOf(id, c2), "the new lease, never the old one");
  assert.ok(attempts > 1, "the gap took several attempts, each keeping its finalized progress");
});

test("the production lifecycle: asked minutes after the claim (not final), the lease is tracked; days later it is still proven past every provider's horizon", { skip, timeout: 180000 }, async () => {
  rig.honest(60);                                          // finality well behind the head, as on Base
  const id = await rig.create(), A = rig.hosts.a;
  const c = await rig.claim(id, A); await rig.mine(5);
  const store = memoryStore(), R = reader({ windowBlocks: 100, store });
  const e = await err(R.writerAuthority(id, { runner: A.id }));   // the release: no fact yet, the guest reads it itself
  assert.deepEqual([e.code, e.retry], ["claim_not_final", true]);
  assert.equal([...R.tracked()].length, 1, "the lease is tracked from the first ask");
  // the tracker runs while the lease is renewed (relay/api-relay.js: every 15 min)
  for (let i = 0; i < 3; i++) { await rig.mine(80); await rig.renew(id, A); await rig.mine(5); await R.track(id); }
  // later every provider refuses anything older than its recent horizon; the claim is far below it
  const head = Number(await rig.pc.getBlockNumber());
  for (const p of rig.peers) p.mode.historyBelow = head - 120;
  assert.ok(c.block < head - 120);
  assert.deepEqual((await R.writerAuthority(id, { runner: A.id })).fact, factOf(id, c), "a guest restart days later still gets its fact");
});

test("collusion hiding the newest claim yields no fact (never the older generation); a reorg yields the canonical claim's", { skip, timeout: 120000 }, async () => {
  rig.honest(10);
  const id = await rig.create(), A = rig.hosts.a, C = rig.hosts.c;
  const c1 = await rig.claim(id, A); await rig.mine(20);
  await rig.release(id, A); const c2 = await rig.claim(id, A); await rig.mine(20);
  for (const p of rig.peers) p.mode.hideClaimsAfter = c1.block;   // EVERY provider hides the newer claim
  const e = await err(reader().writerAuthority(id));
  assert.deepEqual([e.code, e.retry], ["inconsistent_logs", true], e.message);
  rig.honest(10);
  assert.deepEqual((await reader().writerAuthority(id)).fact, factOf(id, c2));
  // a reorg: the expired lease is claimed by A, that block is dropped, C claims instead
  await warp(1900);
  const snap = await rig.raw("evm_snapshot");
  await rig.claim(id, A); await rig.mine(3);
  await rig.raw("evm_revert", [snap]);
  await rig.mine(2);                                        // the replacement chain differs in height and content
  const cC = await rig.claim(id, C); await rig.mine(20);
  const f = (await reader().writerAuthority(id, { runner: C.id })).fact;
  assert.deepEqual(f, factOf(id, cC));
});

test("the row decoder refuses a malformed or foreign answer", () => {
  const id = "0x" + "11".repeat(32);
  assert.throws(() => decodeRow16("0x1234", id), /schema-16/);
  const word = (h) => h.padStart(64, "0");
  const raw = "0x" + word("20") + "22".repeat(32) + word("0").repeat(17);
  assert.throws(() => decodeRow16(raw, id), /another deployment/);
  assert.equal(decodeRow16("0x" + word("20") + word("0").repeat(18), id), null, "a zero id is no deployment");
});
