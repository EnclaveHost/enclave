// Publisher-yank enforcement (yankTeardownPlan, the pure core of yankSweep),
// driven through the YANK_SELFTEST seam — same contract as APPROVAL_SELFTEST
// and the other verdict seams.
//
// The rule (2026-07-24): a yanked catalog version terminates every deployment
// RUNNING it — running and claimed records on the exact yanked reference are
// torn down; everything else (other versions, terminal records) is untouched.
// Delisting (app.active=false) deliberately stays a gate-only refusal and
// never appears here.
//
//   run: node --test test/yank-teardown.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function plan(records, yankedRefs) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret",
           YANK_SELFTEST: JSON.stringify({ records, yankedRefs }),
           APPROVAL_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", SWEEP_SELFTEST: "",
           SWITCH_SELFTEST: "", LEDGER_MOVE_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const APP = "0x" + "ab".repeat(32);
const REF0 = `catalog://${APP}/0`;
const REF1 = `catalog://${APP}/1`;
const R = (id, status, ref) => ({ id, status, ref });

test("running and claimed records on the yanked version are torn down", async () => {
  const r = await plan(
    [R("d1", "running", REF0), R("d2", "claimed", REF0)],
    [REF0]);
  assert.deepEqual(r, ["d1", "d2"]);
});

test("records on OTHER versions of the same app keep serving", async () => {
  const r = await plan(
    [R("d1", "running", REF0), R("d2", "running", REF1)],
    [REF1]);
  assert.deepEqual(r, ["d2"]);
});

test("terminal and in-flight-terminal records are untouched (they hold no resources)", async () => {
  const r = await plan(
    [R("d1", "terminated", REF0), R("d2", "expired", REF0),
     R("d3", "failed", REF0), R("d4", "stopping", REF0)],
    [REF0]);
  assert.deepEqual(r, []);
});

test("no yanked versions -> empty plan (the everyday pass)", async () => {
  const r = await plan([R("d1", "running", REF0), R("d2", "claimed", REF1)], []);
  assert.deepEqual(r, []);
});

test("a yank reaches private deployments too (standing refusal, like the gate)", async () => {
  // visibility never enters the plan: the record shape carries none, exactly
  // because a yank holds regardless of it
  const r = await plan([R("dev", "running", REF0)], [REF0]);
  assert.deepEqual(r, ["dev"]);
});
