// relay/route-grace.mjs: an app keeps its route through a short detach of its host's tunnel, and loses it at once when the
// host is present but no longer eligible.
import test from "node:test";
import assert from "node:assert/strict";
import { withDetachGrace } from "../relay/route-grace.mjs";

test("a detached host's apps keep their route for the grace, never past their eligibility", () => {
  let t = 1_000_000, row = { id: "host" }, verdict = t + 600_000;
  const eligible = withDetachGrace({ rowOf: () => row, rowEligibility: () => verdict, graceMs: 180_000, now: () => t });
  const d = { id: "0xAA", runner: "host" };
  assert.equal(eligible(d), t + 600_000);
  row = null; t += 1_000;                                   // the tunnel blips
  assert.equal(eligible(d), 1_000_000 + 180_000, "kept for the grace after it was last eligible");
  t = 1_000_000 + 180_001;
  assert.equal(eligible(d), false, "and not past it");
  row = { id: "host" }; verdict = t + 30_000; eligible(d);  // back, eligible for only 30 s more
  row = null;
  assert.equal(eligible(d), t + 30_000, "never past what it was eligible until");
});

test("a present host that is no longer eligible loses the route at once; a never-eligible app has none", () => {
  let t = 5_000, row = { id: "h" }, verdict = true;
  const eligible = withDetachGrace({ rowOf: () => row, rowEligibility: () => verdict, now: () => t });
  const d = { id: "0xbb", runner: "h" };
  assert.equal(eligible(d), true);
  verdict = false;
  assert.equal(eligible(d), false);
  row = null;
  assert.equal(eligible(d), false, "a revoked app gets no grace when its host then detaches");
  assert.equal(eligible({ id: "0xcc", runner: "h" }), false);
});

test("an app whose re-attached host has no verdict on it yet keeps the grace; a verdict ends it", () => {
  let t = 10_000, row = { id: "h" }, verdict = true, waiting = false;
  const eligible = withDetachGrace({ rowOf: () => row, rowEligibility: () => verdict, pending: () => waiting, graceMs: 180_000, now: () => t });
  const d = { id: "0xdd", runner: "h" };
  assert.equal(eligible(d), true);
  t += 5_000; row = { id: "h", reattached: true }; verdict = false; waiting = true;   // back, its verifier not yet run
  assert.equal(eligible(d), 10_000 + 180_000, "kept while the host's verifier has not judged it");
  waiting = false;                                                                      // judged: refused
  assert.equal(eligible(d), false, "a verdict ends it at once");
  waiting = true;
  assert.equal(eligible(d), false, "and it does not come back while pending again");
  assert.equal(eligible({ id: "0xee", runner: "h" }), false, "pending gives nothing to an app that never had a route");
});

test("the grace survives a relay restart through its store, bounded as before", () => {
  let t = 1_000_000, saved = null;
  const store = { load: () => saved || [], save: (e) => { saved = JSON.parse(JSON.stringify(e)); } };
  const id = "0x" + "ab".repeat(32);
  const first = withDetachGrace({ rowOf: () => ({ id: "h" }), rowEligibility: () => true, now: () => t, store, saveEveryMs: 3_600_000 });
  assert.equal(first({ id, runner: "h" }), true);
  first.save();
  assert.deepEqual(saved, [[id, { at: 1_000_000, until: null, fp: "" }]], "Infinity is stored as null");
  t += 8_000;                                                   // the relay restarts: no rows yet
  const second = withDetachGrace({ rowOf: () => null, rowEligibility: () => true, now: () => t, store, saveEveryMs: 3_600_000 });
  assert.equal(second({ id, runner: "h" }), 1_000_000 + 180_000, "routed through the restart");
  t = 1_000_000 + 180_001;
  assert.equal(second({ id, runner: "h" }), false, "never past the grace from when it was last eligible");
  saved = [["not-an-id", { at: t, until: null, fp: "" }], [id, { at: "x", until: null, fp: "" }]];
  const third = withDetachGrace({ rowOf: () => null, rowEligibility: () => true, now: () => t, store, saveEveryMs: 3_600_000 });
  assert.equal(third({ id, runner: "h" }), false, "malformed saved entries are ignored");
});

test("a ledger change ends the grace at once: a transfer during a detach or while a verdict is pending", () => {
  let t = 50_000, row = { id: "h" }, verdict = true, waiting = false;
  const fingerprint = d => JSON.stringify([d.id, d.owner]);
  const eligible = withDetachGrace({ rowOf: () => row, rowEligibility: () => verdict, pending: () => waiting, fingerprint, now: () => t });
  assert.equal(eligible({ id: "0xff", runner: "h", owner: "alice" }), true);
  row = null; t += 1_000;
  assert.equal(eligible({ id: "0xff", runner: "h", owner: "alice" }), 50_000 + 180_000, "same facts: the grace holds");
  assert.equal(eligible({ id: "0xff", runner: "h", owner: "mallory" }), false, "transferred while detached: withdrawn");
  assert.equal(eligible({ id: "0xff", runner: "h", owner: "alice" }), false, "and not restored by the old facts");
  row = { id: "h" }; verdict = true; eligible({ id: "0x11", runner: "h", owner: "alice" });
  verdict = false; waiting = true;
  assert.equal(eligible({ id: "0x11", runner: "h", owner: "mallory" }), false, "transferred while pending: withdrawn");
});
