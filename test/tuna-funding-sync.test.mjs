// network/tuna-funding-sync.mjs plan(): the relay's queue -> top-up lines, re-checked on the paying machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../network/tuna-funding-sync.mjs";
const A = (s, n) => Array.from({ length: n }, (_, i) => "NKN" + (s + String.fromCharCode(66 + i)).padEnd(33, "x"));
const ctl = (k, s = "C") => [`ctl-${k.repeat(16)}`, { purpose: "control", nkn: "0.05", addresses: A(s, 2) }];
const app = (k, s = "P") => [`sh-${k.repeat(12)}`, { purpose: "app", nkn: "0.25", addresses: A(s, 6) }];
const q = (...e) => ({ version: 1, targets: Object.fromEntries(e) });
const OLD = "0x7ae476a3 0.25 NKNCvAewDJHpr6w8yNbjCWUyWvVTHAAPeBYH";

test("well-formed entries become lines; existing lines (ours or not) are kept; a changed label is replaced in place", () => {
  const p = plan(q(ctl("a"), app("b")), [OLD], 20);
  assert.deepEqual(p.changed, ["ctl-" + "a".repeat(16), "sh-" + "b".repeat(12)]); assert.equal(p.lines[0], OLD); assert.equal(p.lines.length, 3);
  assert.deepEqual(plan(q(ctl("a"), app("b")), p.lines, 20).changed, [], "idempotent");
  const moved = plan(q(ctl("a"), app("b", "Q")), p.lines, 20);
  assert.deepEqual(moved.changed, ["sh-" + "b".repeat(12)]); assert.equal(moved.lines.length, 3); assert.match(moved.lines[2], /NKNQB/);
});
test("the paying machine refuses what the relay should never have queued", () => {
  for (const [label, e] of [["ctl-xyz", ctl("a")[1]], [ctl("a")[0], { ...ctl("a")[1], nkn: "5" }], [app("b")[0], { ...app("b")[1], addresses: A("P", 7) }],
                            [app("b")[0], { ...app("b")[1], purpose: "control" }], [app("b")[0], { ...app("b")[1], purpose: "toString" }],
                            [app("b")[0], { ...app("b")[1], addresses: [...A("P", 5), "0xdead"] }], ["0x7ae476a3", app("b")[1]]])
    assert.deepEqual(plan(q([label, e]), [OLD], 20), { lines: [OLD], changed: [], refused: [label] }, label);
});
test("at most --max-new labels a run; wallets already funded under another label are not paid twice", () => {
  assert.equal(plan(q(app("a", "P"), app("b", "Q"), app("c", "R")), [], 2).changed.length, 2);
  const dup = plan(q(app("a", "P"), app("b", "P")), [], 20);
  assert.deepEqual(dup.changed, ["sh-" + "a".repeat(12)]); assert.deepEqual(dup.refused, ["sh-" + "b".repeat(12)]);
});
