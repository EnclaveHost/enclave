// The plan: pins validation, fail-closed blocking, hash stability, the protected policy, budgets, and the steps that
// must stay blocked in this plan (track N, shared outage).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan, validatePins, PROTECTED_POLICY_4E62, COMMITTEE_4774, ORIGINAL_VAULT_V2 } from "../driver/plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "pins.example.json"), "utf8"));
const full = () => ({ ...structuredClone(example), image: { ...example.imageCandidateFromChain, source: undefined },
  owner: { ...example.owner, reuseScope: { statedBy: "root", at: "2026-10-23T20:30:00Z", onlyPlanCreatedDeployments: true } } });
const fixImage = (p) => { delete p.image.source; return p; };
const allObs = Object.fromEntries(["read.vault", "read.committee", "read.protected4e62", "read.owner", "custodian.info", "recipient.runner",
  "recipient.billing", "relay.v2aware", "hw.oneGuest", "deploy.C1", "deploy.C2"].map((k) => [k, { ok: true, stepId: "x" }]));
const C1 = "0x" + "c1".repeat(32), C2 = "0x" + "c2".repeat(32);
const st = (plan, id) => plan.steps.find((s) => s.id === id);

test("the example pins validate but leave everything blocked (unstated reuse scope, no image)", () => {
  assert.deepEqual(validatePins(example), []);
  const plan = buildPlan(example);
  assert.ok(plan.steps.every((s) => s.status === "blocked"), "nothing may run before root states the reuse scope");
  assert.match(st(plan, "S0.chain").blockedBy.join(), /owner.scope/);
  assert.match(st(plan, "C1.create").blockedBy.join(), /image.recipient/);
});

test("validatePins refuses another vault, committee, pinned deployment ids, fee ceilings and bad shapes", () => {
  const bad = [
    [(p) => { p.vaultV2 = "0x56b81b39" + "0".repeat(32); }, /original 0xE486/],
    [(p) => { p.committee.id = "0x" + "11".repeat(32); }, /0x4774 only/],
    [(p) => { p.deployments = { C1: { id: C1 } }; }, /learned from the journal/],
    [(p) => { p.fees.maxFeePerGasWei = "200000000"; }, /maxFeePerGasWei/],
    [(p) => { p.owner.keyEnv = "0xabc"; }, /env var NAME/],
    [(p) => { p.sendRpc = "https://other.example"; }, /sendRpc/],
    [(p) => { p.recipient.endpoint = "https://api.enclave.host/t/custody-metal0"; }, /recipient.endpoint/],
    [(p) => { p.chainId = 1; }, /8453/],
    [(p) => { p.gas.create = "99999999"; }, /gas.create/],
  ];
  for (const [mut, re] of bad) { const p = structuredClone(example); mut(p); assert.match(validatePins(p).join("; "), re); assert.throws(() => buildPlan(p), re); }
});

test("prerequisites resolve only from pins, declared observations and learned ids; the order is fail-closed", () => {
  const p = fixImage(full());
  let plan = buildPlan(p);
  assert.equal(st(plan, "S0.chain").status, "ready");
  assert.equal(st(plan, "S0.custodian").status, "ready");
  assert.equal(st(plan, "D1.create").status, "blocked");
  plan = buildPlan(p, { ...allObs, "deploy.C1": undefined, "deploy.C2": undefined });
  assert.equal(st(plan, "D1.create").status, "ready");
  assert.equal(st(plan, "C1.create").status, "blocked");
  assert.match(st(plan, "C1.create").blockedBy.join(), /deploy.C1|not created/);
  plan = buildPlan(p, allObs, { C1 });
  assert.equal(st(plan, "C1.create").status, "ready");
  assert.deepEqual(st(plan, "C1.create").mutation.ids, [C1]);
  assert.equal(st(plan, "M.migrate").status, "blocked");                   // C2 not learned yet
  plan = buildPlan(p, allObs, { C1, C2 });
  assert.equal(st(plan, "M.migrate").status, "ready");
  // unknown observation keys and approvals for track N do not resolve anything
  plan = buildPlan({ ...p, approvals: { "trackN.memory": { by: "x", at: "y" } } }, { ...allObs, "trackN.committee": { ok: true, stepId: "z" } }, { C1, C2 });
  for (const id of ["O.stopped", "O.timeout", "O.restart", "O.rollback", "O.shared"]) assert.equal(st(plan, id).status, "blocked", id);
  assert.equal(st(plan, "O.rollback").limitation, "rollback");
});

test("step hashes: stable across run-time status, bound to the learned ids and the pins", () => {
  const p = fixImage(full());
  const a = buildPlan(p, {}, { C1 }), b = buildPlan(p, allObs, { C1 });
  assert.notEqual(st(a, "C1.create").status, st(b, "C1.create").status);
  assert.equal(st(a, "C1.create").stepHash, st(b, "C1.create").stepHash);
  assert.notEqual(st(buildPlan(p, allObs, { C1: C2 }), "C1.create").stepHash, st(b, "C1.create").stepHash);
  assert.equal(st(buildPlan(p, allObs, { C1, C2 }), "S0.chain").stepHash, st(b, "S0.chain").stepHash);
  assert.notEqual(buildPlan({ ...p, gas: { ...p.gas, rules: "400000" } }).pinsHash, b.pinsHash);
});

test("the protected policy 0x4e62 can never be a target; C1 and C2 must differ", () => {
  const p = fixImage(full());
  const literal = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";   // literal: a changed constant must not hide it
  assert.equal(PROTECTED_POLICY_4E62, literal);
  assert.throws(() => buildPlan(p, allObs, { C1: literal }), /protected policy/);
  assert.throws(() => buildPlan(p, allObs, { C1, C2: literal }), /protected policy/);
  assert.throws(() => buildPlan(p, allObs, { C1, C2: C1 }), /different/);
  assert.throws(() => buildPlan(p, allObs, { C1: "0xABC" }), /bytes32/);
});

test("mutations: only update on the original vault, from the owner, one canary id, bounded gas x fee; budget reported", () => {
  const p = fixImage(full());
  const plan = buildPlan(p, allObs, { C1, C2 });
  const muts = plan.steps.filter((s) => s.mutation);
  assert.equal(muts.length, 9);
  for (const s of muts) {
    assert.equal(s.mutation.target, ORIGINAL_VAULT_V2); assert.equal(s.mutation.fn, "update"); assert.equal(s.mutation.ids.length, 1);
    assert.equal(s.mutation.from, p.owner.address);
    assert.equal(BigInt(s.mutation.maxCostWei), BigInt(s.mutation.gasCap) * 20_000_000n);
  }
  assert.equal(plan.budget.largestStepWei, String(1_200_000n * 20_000_000n));
  assert.equal(plan.budget.worstCaseWei, String((2n * 1_200_000n + 2n * 600_000n + 5n * 500_000n) * 20_000_000n));
  // the expected policy revisions follow the case order exactly
  assert.deepEqual(muts.filter((s) => s.mutation.ids[0] === C1).map((s) => s.mutation.expectPolicyRev), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(muts.filter((s) => s.mutation.ids[0] === C2).map((s) => s.mutation.expectPolicyRev), [0, 1]);
  assert.ok(plan.steps.every((s) => !s.mutation || s.mutation.ids[0] !== PROTECTED_POLICY_4E62));
  assert.match(plan.statement, /not trustless/);
  assert.match(plan.statement, /not the corrected r2 candidate/);
});

test("case matrix coverage: every requested case has steps", () => {
  const plan = buildPlan(fixImage(full()), allObs, { C1, C2 });
  const cases = new Set(plan.steps.map((s) => s.case));
  for (const c of ["create", "release", "rotate", "wrong-owner", "stale-policy", "nonce-replay", "wrong-image", "wrong-runtime", "wrong-app", "paused",
    "relay-refusals", "migration", "outage", "timeout", "restart", "rollback", "outage-shared"]) assert.ok(cases.has(c), c);
  // one recipient guest at a time: C1 is stopped before C2 is created
  const order = plan.steps.map((s) => s.id);
  assert.ok(order.indexOf("D1.stop") < order.indexOf("D2.create"));
  assert.deepEqual(st(plan, "D2.create").after, ["D1.stop"]);
  assert.ok(plan.steps.filter((s) => s.kind === "hardware" && !s.id.startsWith("O.")).every((s) => s.requires.includes("hw.oneGuest")));
  assert.equal(st(plan, "C1.create").mutation.policy.paused, false);
  assert.equal(COMMITTEE_4774.length, 66);
});
