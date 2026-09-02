// mm31 "speculate alone, batch when shared": the wire contract between the
// ggml backend and a speculative guest, pinned as a string the way every
// cross-language seam in this repo has to be.
//
// The mechanism: a speculative round takes the decode turn ALONE (the verify
// is one sequence's all-positions pass), so two speculating chats serialise
// AND lose llama's graph reuse to the alternating sequence id — measured on a
// 27b hybrid, a round costs 26 ms alone and 99 ms with two chats. Merged plain
// decode has the opposite shape: a two-sequence step costs what a one-sequence
// step costs. So the host refuses the round while shared and the guest finishes
// the turn on the batched path.
//
// Two properties matter enough to fail a build over:
//
//   1. The refusal is OPT-IN. An app built before mm31 treats a speculative
//      verb error as fatal (eyesoff-ai 1.0.36: `Err(e) => return Err(e)`), so
//      refusing it would turn a slow answer into a failed one. The host may
//      only refuse a caller that sent `shared_ok`.
//   2. The marker the guest matches on is the marker the host sends. It is
//      matched with a substring test on the receive side, which is exactly the
//      forgiving-parser shape that hid the arbiter's grant-frame near-miss
//      (see wasmtime-nn-arbiter.patch), so the literal is pinned here instead.
//
//   run: node --test test/mtp-shared-downgrade.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const patch = fs.readFileSync(path.join(ROOT, "wasm/wasmtime-nn-ggml.patch"), "utf8");

// the patch is a diff: only ADDED lines are the shipped source
const added = patch
  .split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
  .map((l) => l.slice(1))
  .join("\n");

test("the refusal marker is the exact literal a guest substring-matches", () => {
  assert.match(added, /const SHARED_ERR: &str =\s*\n?\s*"\[mtp_shared\]/,
    "SHARED_ERR must start with the [mtp_shared] tag - the guest matches on it");
});

test("both speculative verbs gate the refusal on the caller's opt-in", () => {
  const gates = added.match(/if self\.mark_and_share\([a-z_]+\) && shared_ok \{/g) || [];
  assert.equal(gates.length, 2,
    "mtp_round and mtp_draft must BOTH refuse only when the caller sent shared_ok; " +
    `found ${gates.length} opt-in-gated refusals`);
  assert.ok(!/if self\.mark_and_share\([a-z_]+\) \{\s*\n\s*return Err\(SHARED_ERR/.test(added),
    "an ungated refusal would break every app built before mm31");
});

test("the opt-in defaults to false, so silence means the old behaviour", () => {
  const fn = added.match(/fn shared_ok\(inputs: &\[NamedTensor\]\) -> bool \{[\s\S]*?\n\}/);
  assert.ok(fn, "shared_ok() must exist to read the opt-in input");
  assert.match(fn[0], /\.unwrap_or\(false\)/,
    "a caller that sends no shared_ok input must be served exactly as before");
  assert.match(fn[0], /nt\.name == "shared_ok"/, "the input is named shared_ok on the wire");
});

test("a speculative round marks its sequence as generating", () => {
  // "shared" has to mean GENERATING, not merely holding a session: a chat
  // parked in a tool call must age out of the TTL and stop suppressing its
  // neighbour's drafting. mark_and_share does both halves in one lock.
  assert.match(added, /fn mark_and_share\(&self, seq_id: i32\) -> bool \{[\s\S]*?q\.stepping\.insert\(seq_id, now\);/,
    "mark_and_share must record the sequence before answering whether it is shared");
});

test("caps[12] is the shared bit; a guest length-checks and reads it by INDEX", () => {
  // The guest contract is positional: `caps.len() > 12 && caps[12] != 0`. So
  // the pin is the index, not "last" - mm32 (park_slots) and mm33 (video)
  // appended after it, which is allowed; inserting BEFORE it would shift every
  // guest's read onto the wrong bit, which is what this test exists to catch.
  const m = added.match(/let vals = \[\n([\s\S]*?)\n\s*\];/);
  assert.ok(m, "the caps vector is built as `let vals = [ ... ];`");
  const elems = m[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .split(/,\n/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  assert.equal(elems[10], "1", "caps[10] is the mtp_round flag the handoff documents - the index base is right");
  assert.equal(elems[12], "self.server.shared_with(self.seq_id) as i32",
    "caps[12] is the shared bit - guests read it by index after a length check");
});
