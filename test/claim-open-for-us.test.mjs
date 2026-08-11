// The last gate before a claim tx must be asked at OUR price (supervisor.js).
//
// Why this is pinned in source rather than exercised through a seam: the bug it
// guards is an ABSENCE. tryClaim asked the ledger `claimable(id)` — `_open(id)
// && balance6 >= rate`, priced off the record's STORED rate — and returned
// silently when it came back false. For a deployment this box hosts for free
// (_hostRate returns 0 when our payoutWallet is the deployment's owner) the
// balance cannot matter and the stored rate is just whatever the last host or
// an import left behind, so `0 >= 481` sent us away from work we would have
// been given for nothing. No record, no backoff, no log: the claim-hint kept
// answering "claiming" and three free self-hosted apps sat dark (2026-08-11,
// after a ledger migration seeded hostless records' rate from their cap).
//
// Both halves are load-bearing and both are one edit away from coming back, so
// both are pinned: ask claimableBy(id, enclaveId), and SAY SO when it refuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js"), "utf8");

const between = (from, to) => {
  const i = SRC.indexOf(from);
  assert.ok(i > 0, `could not find ${from} in supervisor.js`);
  const j = SRC.indexOf(to, i);
  assert.ok(j > i, `could not find ${to} after ${from}`);
  return SRC.slice(i, j);
};

test("the ledger ABI carries claimableBy(id, enclaveId)", () => {
  const abi = between("const depsAbiFor =", "// Which struct shape the ledger");
  assert.match(abi, /name:\s*"claimableBy"/,
    "claimableBy must stay in the claim ABI - without it openForUs can only ever fall back");
  const entry = abi.slice(abi.indexOf('name: "claimableBy"'));
  const inputs = entry.slice(entry.indexOf("inputs:"), entry.indexOf("outputs:"));
  assert.equal((inputs.match(/bytes32/g) || []).length, 2,
    "claimableBy takes the deployment id AND the enclave id - one bytes32 means the wrong overload");
});

test("openForUs prices the record at OUR rate, and degrades to claimable()", () => {
  const fn = between("async function openForUs(", "\n// Jitter de-syncs");
  assert.match(fn, /functionName:\s*"claimableBy"/,
    "openForUs must ask claimableBy - claimable() prices the record at whatever rate it happens to store");
  assert.match(fn, /args:\s*\[id,\s*_enclaveId\]/,
    "claimableBy must be asked about THIS enclave, or it answers for a stranger");
  assert.match(fn, /catch[\s\S]*functionName:\s*"claimable"/,
    "a pre-rev-8 ledger has no claimableBy and no per-enclave pricing either: fall back, never block the claim");
});

test("tryClaim goes through openForUs and never calls claimable() itself", () => {
  const fn = between("async function tryClaim(", "\n// On-chain record -> local rec");
  assert.match(fn, /await openForUs\(d\.id\)/,
    "tryClaim must route its last pre-gas check through openForUs");
  assert.doesNotMatch(fn, /functionName:\s*"claimable"/,
    "a direct claimable() in tryClaim is the exact regression this file exists to catch");
});

test("a refusal at that gate is logged, not silent", () => {
  const fn = between("async function tryClaim(", "\n// On-chain record -> local rec");
  const gate = fn.slice(fn.indexOf("await openForUs(d.id)"));
  const line = gate.slice(0, gate.indexOf("\n", gate.indexOf("if (!open)")) + 1);
  assert.match(line, /console\.(log|warn)/,
    "every other claim gate returns a reason the why-probe can show; this one must at least reach the log");
});
