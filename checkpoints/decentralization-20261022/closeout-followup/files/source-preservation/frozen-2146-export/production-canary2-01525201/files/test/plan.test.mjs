// The plan: pins validation, fail-closed blocking, hash stability, the protected policy, optional cases, the AGGREGATE
// budget, and the steps that must stay blocked in this plan (track N, shared outage).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPlan, validatePins, PROTECTED_POLICY_4E62, COMMITTEE_4774, ORIGINAL_VAULT_V2, KNOWN_LACKING_CONTROL_MANIFESTS } from "../driver/plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.CANARY_CLIENT_REPO || "/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2";
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "pins.example.json"), "utf8"));
const full = (mut = (p) => p) => { const { source, ...image } = example.imageCandidateFromChain;
  const p = { ...structuredClone(example), image, owner: { ...example.owner, reuseScope: { statedBy: "root", at: "2026-10-23T20:30:00Z", onlyPlanCreatedDeployments: true } } };
  mut(p); return p; };
const everything = (p) => { p.cases = { disabled: [] }; p.budget.totalWei = "1000000000000000"; };
const allObs = Object.fromEntries(["read.vault", "read.committee", "read.protected4e62", "read.owner", "fees.bounded", "custodian.info", "recipient.runner",
  "recipient.billing", "relay.v2aware", "hw.oneGuest", "cli.pins", "deploy.C1", "deploy.C2"].map((k) => [k, { ok: true, stepId: "x" }]));
const C1 = "0x" + "c1".repeat(32), C2 = "0x" + "c2".repeat(32);
const st = (plan, id) => plan.steps.find((s) => s.id === id);

test("the example pins validate but leave everything blocked (unstated reuse scope, no image)", () => {
  assert.deepEqual(validatePins(example), []);
  const plan = buildPlan(example);
  assert.ok(plan.steps.every((s) => s.status === "blocked"), "nothing may run before root states the reuse scope");
  assert.match(st(plan, "S0.chain").blockedBy.join(), /owner.scope/);
  assert.match(st(plan, "C1.create").blockedBy.join(), /image.recipient/);
});

test("every pinned client file hash in the example is the public file's real sha256 (the gitleaks-ignored line included)", () => {
  for (const [rel, want] of Object.entries(example.repo.files)) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(REPO, rel))).digest("hex"), want, rel);
  const lines = fs.readFileSync(path.join(ROOT, "pins.example.json"), "utf8").split("\n");
  assert.match(lines[44], /^ +"relay\/secrets\.js": "[0-9a-f]{64}",$/, "the .gitleaksignore fingerprint names exactly this line (45)");
  assert.match(fs.readFileSync(path.join(ROOT, ".gitleaksignore"), "utf8"), /^pins\.example\.json:generic-api-key:45$/m);
});

test("validatePins refuses another vault, committee, pinned ids, fee/budget gaps, unknown optional cases and bad shapes", () => {
  const bad = [
    [(p) => { p.vaultV2 = "0x56b81b39" + "0".repeat(32); }, /original 0xE486/],
    [(p) => { p.committee.id = "0x" + "11".repeat(32); }, /0x4774 only/],
    [(p) => { p.deployments = { C1: { id: C1 } }; }, /learned from the journal/],
    [(p) => { p.fees.maxFeePerGasWei = "200000000"; }, /maxFeePerGasWei/],
    [(p) => { delete p.fees.l1FeeWei; }, /l1FeeWei/],
    [(p) => { delete p.fees.operatorFeeWei; }, /operatorFeeWei/],
    [(p) => { delete p.budget.cliWei.stop; }, /cliWei.stop/],
    [(p) => { delete p.budget.totalWei; }, /budget: totalWei/],
    [(p) => { p.cases.disabled = ["create"]; }, /cases.disabled/],
    [(p) => { p.owner.keyEnv = "0xabc"; }, /env var NAME/],
    [(p) => { p.sendRpcs = [p.rpcs[0]]; }, /sendRpcs/],
    [(p) => { p.sendRpcs = [p.rpcs[0], "https://other.example"]; }, /sendRpcs/],
    [(p) => { p.recipient.endpoint = "https://api.enclave.host/t/custody-metal0"; }, /recipient.endpoint/],
    [(p) => { p.chainId = 1; }, /8453/],
    [(p) => { p.gas.create = "99999999"; }, /gas.create/],
  ];
  for (const [mut, re] of bad) { const p = structuredClone(example); mut(p); assert.match(validatePins(p).join("; "), re); assert.throws(() => buildPlan(p), re); }
});

test("prerequisites resolve only from pins, declared observations and learned ids; the order is fail-closed", () => {
  const p = full(everything);
  let plan = buildPlan(p);
  assert.equal(st(plan, "S0.chain").status, "ready");
  assert.equal(st(plan, "D1.create").status, "blocked");
  plan = buildPlan(p, { ...allObs, "fees.bounded": undefined });
  assert.match(st(plan, "C1.create").blockedBy.join(), /fees.bounded/);
  plan = buildPlan(p, { ...allObs, "cli.pins": undefined });
  for (const id of ["D1.create", "D1.leasegas", "D1.stop", "D2.create", "D2.leasegas", "D2.stop"]) assert.match(st(plan, id).blockedBy.join(), /cli.pins/, id);
  assert.match(st(plan, "D1.create").command, /--independent .*--contract-pins cli-pins\/canary-contract-pins\.json .*--max-fee-gwei 0\.012/);
  plan = buildPlan(p, { ...allObs, "deploy.C1": undefined, "deploy.C2": undefined });
  assert.equal(st(plan, "D1.create").status, "ready");
  assert.equal(st(plan, "D1.leasegas").status, "ready");
  assert.equal(st(plan, "C1.create").status, "blocked");
  plan = buildPlan(p, allObs, { C1 });
  assert.equal(st(plan, "C1.create").status, "ready");
  assert.deepEqual(st(plan, "C1.create").mutation.ids, [C1]);
  assert.equal(st(plan, "M.migrate").status, "blocked");
  plan = buildPlan(p, allObs, { C1, C2 });
  assert.equal(st(plan, "M.migrate").status, "ready");
  plan = buildPlan({ ...p, approvals: { "trackN.memory": { by: "x", at: "y" } } }, { ...allObs, "trackN.committee": { ok: true, stepId: "z" } }, { C1, C2 });
  for (const id of ["O.stopped", "O.timeout", "O.restart", "O.rollback", "O.shared"]) assert.equal(st(plan, id).status, "blocked", id);
  assert.equal(st(plan, "O.rollback").limitation, "rollback");
  assert.match(String(KNOWN_LACKING_CONTROL_MANIFESTS), /^c7cb436d/);
});

test("step hashes: stable across run-time status, bound to the learned ids and the pins", () => {
  const p = full();
  const a = buildPlan(p, {}, { C1 }), b = buildPlan(p, allObs, { C1 });
  assert.notEqual(st(a, "C1.create").status, st(b, "C1.create").status);
  assert.equal(st(a, "C1.create").stepHash, st(b, "C1.create").stepHash);
  assert.notEqual(st(buildPlan(p, allObs, { C1: C2 }), "C1.create").stepHash, st(b, "C1.create").stepHash);
  assert.notEqual(buildPlan({ ...p, gas: { ...p.gas, rules: "200000" } }).pinsHash, b.pinsHash);
});

test("the protected policy 0x4e62 can never be a target; C1 and C2 must differ", () => {
  const p = full();
  const literal = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";   // literal: a changed constant must not hide it
  assert.equal(PROTECTED_POLICY_4E62, literal);
  assert.throws(() => buildPlan(p, allObs, { C1: literal }), /protected policy/);
  assert.throws(() => buildPlan(p, allObs, { C1, C2: literal }), /protected policy/);
  assert.throws(() => buildPlan(p, allObs, { C1, C2: C1 }), /different/);
  assert.throws(() => buildPlan(p, allObs, { C1: "0xABC" }), /bytes32/);
});

test("mutations: only update on the original vault, from the owner, one canary id; revisions follow the KEPT steps", () => {
  let plan = buildPlan(full(everything), allObs, { C1, C2 });
  let muts = plan.steps.filter((s) => s.mutation);
  assert.equal(muts.length, 9);
  for (const s of muts) {
    assert.equal(s.mutation.target, ORIGINAL_VAULT_V2); assert.equal(s.mutation.fn, "update"); assert.equal(s.mutation.ids.length, 1);
    assert.equal(s.mutation.from, example.owner.address); assert.equal(s.mutation.maxFeePerGasWei, "10000000");
  }
  assert.deepEqual(muts.filter((s) => s.mutation.ids[0] === C1).map((s) => s.mutation.expectPolicyRev), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(muts.filter((s) => s.mutation.ids[0] === C2).map((s) => s.mutation.expectPolicyRev), [0, 1]);
  // disabling optional cases removes their steps, re-wires the order, and renumbers the expected revisions
  plan = buildPlan(full((p) => { everything(p); p.cases.disabled = ["wrong-runtime", "wrong-app", "migration"]; }), allObs, { C1, C2 });
  muts = plan.steps.filter((s) => s.mutation);
  assert.deepEqual(muts.map((s) => [s.id, s.mutation.expectPolicyRev]), [["C1.create", 0], ["C1.rotate", 1], ["N.image.rules", 2], ["N.pause", 3], ["C1.restore", 4]]);
  assert.deepEqual(st(plan, "N.pause").after, ["N.image.boot"]);
  assert.ok(!plan.steps.some((s) => s.id.startsWith("M.") || s.id.startsWith("D2.")));
  assert.deepEqual(st(plan, "Z.final").after, ["D1.stop"]);
  assert.match(plan.statement, /not trustless/); assert.match(plan.statement, /not the corrected r2 candidate/); assert.match(plan.statement, /NOT proof the app consumed a value/);
});

test("aggregate budget: the whole enabled plan (CLI create/lease/stop included) must fit, else every spending step is blocked", () => {
  // the example: migration disabled (profile A) fits 5.5e13; everything enabled does not
  let plan = buildPlan(full(), allObs, { C1 });
  assert.equal(plan.budget.fits, true, JSON.stringify(plan.budget));
  assert.equal(plan.budget.worstCaseWei, String(47_300_000_000_000n));
  assert.equal(plan.budget.cleanupReserveWei, "1500000000000");
  assert.equal(st(plan, "C1.create").status, "ready");
  plan = buildPlan(full((p) => { p.cases = { disabled: [] }; }), allObs, { C1, C2 });
  assert.equal(plan.budget.fits, false);
  assert.equal(plan.budget.worstCaseWei, String(80_100_000_000_000n));
  for (const s of plan.steps.filter((x) => x.mutation || x.spend)) { assert.equal(s.status, "blocked", s.id); assert.match(s.blockedBy.join(), /budget: aggregate worst case/); }
  assert.equal(st(plan, "S0.chain").status, "ready", "reads and probes are not spending");
  plan = buildPlan(full((p) => { p.budget.usdcUnits = "1000"; }), allObs, { C1 });
  assert.match(plan.budget.reasons.join(), /USDC/);
  // lease gas uses the existing reserve path: configure + deposit by the owner, and both stops are cleanup
  const p = buildPlan(full(everything), allObs, { C1, C2 });
  assert.deepEqual(st(p, "D1.leasegas").spend, { txs: ["leaseConfigure", "leaseDeposit"], depositWei: true });
  assert.ok(st(p, "D1.stop").spend.cleanup && st(p, "D2.stop").spend.cleanup);
  assert.deepEqual(st(p, "D1.check").after, ["D1.leasegas"]);
});

test("case matrix coverage: every requested case has steps; one recipient guest at a time", () => {
  const plan = buildPlan(full(everything), allObs, { C1, C2 });
  const cases = new Set(plan.steps.map((s) => s.case));
  for (const c of ["create", "release", "rotate", "wrong-owner", "stale-policy", "nonce-replay", "wrong-image", "wrong-runtime", "wrong-app", "paused",
    "relay-refusals", "migration", "outage", "timeout", "restart", "rollback", "outage-shared"]) assert.ok(cases.has(c), c);
  const order = plan.steps.map((s) => s.id);
  assert.ok(order.indexOf("D1.stop") < order.indexOf("D2.create"));
  assert.deepEqual(st(plan, "D2.create").after, ["D1.stop"]);
  assert.ok(plan.steps.filter((s) => s.kind === "hardware" && !s.id.startsWith("O.")).every((s) => s.requires.includes("hw.oneGuest")));
  assert.equal(COMMITTEE_4774.length, 66);
});
