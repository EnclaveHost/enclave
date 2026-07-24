// The approval gate's deployability verdict (approvalVerdict, the pure core
// of gateAppReference), driven through the APPROVAL_SELFTEST seam — same
// contract as SWITCH_SELFTEST/LEDGER_MOVE_SELFTEST.
//
// The matrix under test is the dev-mode rule (2026-07-23): a PRIVATE
// deployment (forPrivate) may run a version still AWAITING approval — and
// nothing else changes. Rejected, yanked, and delisted refuse regardless of
// visibility; public deploys of pending versions refuse exactly as before.
//
//   run: node --test test/approval-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function verdicts(cases) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", APPROVAL_SELFTEST: JSON.stringify({ cases }),
           REACH_SELFTEST: "", ACME_SELFTEST: "", SWEEP_SELFTEST: "", SWITCH_SELFTEST: "",
           LEDGER_MOVE_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "",
           CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const V = (over = {}) => ({ active: true, yanked: false, approval: 1, slug: "app", version: "1.0.0", ...over });

test("approved versions deploy at every visibility (the unchanged happy path)", async () => {
  const r = await verdicts([V({ forPrivate: false }), V({ forPrivate: true }), V()]);
  assert.deepEqual(r, [null, null, null]);
});

test("pending: refused public, admitted private (the dev-mode rule)", async () => {
  const r = await verdicts([
    V({ approval: 0 }),                       // no visibility known -> strict (fail closed)
    V({ approval: 0, forPrivate: false }),    // public -> refused
    V({ approval: 0, forPrivate: true }),     // private -> dev mode
  ]);
  assert.match(r[0], /awaiting catalog-owner approval/);
  assert.match(r[0], /PRIVATE/);              // the refusal teaches the dev-mode path
  assert.match(r[1], /awaiting catalog-owner approval/);
  assert.equal(r[2], null);
});

test("forPrivate must be exactly true — truthy strings don't unlock dev mode", async () => {
  const r = await verdicts([V({ approval: 0, forPrivate: "yes" }), V({ approval: 0, forPrivate: 1 })]);
  assert.match(r[0], /awaiting catalog-owner approval/);
  assert.match(r[1], /awaiting catalog-owner approval/);
});

test("the standing refusals hold regardless of visibility", async () => {
  const r = await verdicts([
    V({ approval: 2, forPrivate: true }),                 // rejected: a standing "no"
    V({ yanked: true, forPrivate: true }),                // yanked by its publisher
    V({ yanked: true, approval: 0, forPrivate: true }),   // yanked outranks pending
    V({ active: false, forPrivate: true }),               // app delisted
    V({ active: false, approval: 1, forPrivate: true }),  // delisted outranks approved
  ]);
  assert.match(r[0], /rejected/);
  assert.match(r[1], /yanked/);
  assert.match(r[2], /yanked/);
  assert.match(r[3], /delisted/);
  assert.match(r[4], /delisted/);
});

test("approval statuses beyond the enum fail closed", async () => {
  const r = await verdicts([V({ approval: 3 }), V({ approval: 3, forPrivate: true })]);
  assert.match(r[0], /awaiting catalog-owner approval/);
  // an unknown status is NOT rejected (a standing no), so private dev-mode
  // treats it like pending — the runner-side chain decode can't produce >2
  // from the contract's enum anyway; this pins the pure function's behavior
  assert.equal(r[1], null);
});
