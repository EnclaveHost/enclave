// Provisioner crash recovery (relay/provisioner.js planRecovery): the pure
// decision table that guarantees never-two-creates and never-resend-over-
// pending. Receipts are {status} (mined) | "pending" | null (chain never saw
// the hash).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planRecovery } from "../relay/provisioner.js";

const ok = { status: "success" }, reverted = { status: "reverted" };

test("planRecovery: fresh and creating-step decisions", () => {
  assert.equal(planRecovery(null, {}), "send_create");
  assert.equal(planRecovery({ step: null }, {}), "send_create");
  assert.equal(planRecovery({ step: "creating", txCreate: null }, { create: null }), "send_create");
  // hash recorded, tx in the mempool: HOLD - resending would race it into a double-create
  assert.equal(planRecovery({ step: "creating", txCreate: "0xa" }, { create: "pending" }), "hold");
  // hash recorded, chain never saw it: ambiguous (never landed vs RPC amnesia)
  // -> the Created-log adoption scan disambiguates before any resend
  assert.equal(planRecovery({ step: "creating", txCreate: "0xa" }, { create: null }), "adopt_or_resend_create");
  assert.equal(planRecovery({ step: "creating", txCreate: "0xa" }, { create: ok }), "fund");
  assert.equal(planRecovery({ step: "creating", txCreate: "0xa" }, { create: reverted }), "send_create");
});

test("planRecovery: funding-step decisions", () => {
  const base = { step: "funding", txCreate: "0xa", deploymentId: "0x" + "11".repeat(32) };
  assert.equal(planRecovery({ ...base, deploymentId: null }, {}), "adopt_or_resend_create");   // torn record
  assert.equal(planRecovery({ ...base, txFund: null }, { fund: null }), "send_fund");
  assert.equal(planRecovery({ ...base, txFund: "0xb" }, { fund: "pending" }), "hold");
  assert.equal(planRecovery({ ...base, txFund: "0xb" }, { fund: null }), "send_fund");         // chain never saw it
  assert.equal(planRecovery({ ...base, txFund: "0xb" }, { fund: ok }), "complete");
  assert.equal(planRecovery({ ...base, txFund: "0xb" }, { fund: reverted }), "send_fund");
});

test("planRecovery: done step is terminal", () => {
  assert.equal(planRecovery({ step: "done", txCreate: "0xa", txFund: "0xb" }, {}), "complete");
});
