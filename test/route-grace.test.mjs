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
