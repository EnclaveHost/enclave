// prepare.mjs with the PINNED client code (repo-r2 custody/v2/owner.mjs, custody/rules.mjs, its viem): the calldata
// decodes to exactly the planned update, decoys differ from the real image, and every precondition refuses.
// The committee key here is the secp256k1 generator: a well-formed point, NOT the committee's key — this proves the
// encoding path only, never a release.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadClient, prepareMutation, prepareSimulation, rulesFor, DECOY, DECOY_SENDER } from "../driver/prepare.mjs";
import { buildPlan } from "../driver/plan.mjs";
import { checkTxAgainstStep } from "../driver/tx.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.CANARY_CLIENT_REPO || "/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2";
const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "pins.example.json"), "utf8"));
const { source, ...image } = ex.imageCandidateFromChain;
const pins = { ...ex, image, owner: { ...ex.owner, reuseScope: { statedBy: "root", at: "t", onlyPlanCreatedDeployments: true } } };
const obs = Object.fromEntries(["read.vault", "read.committee", "read.protected4e62", "read.owner", "fees.bounded", "custodian.info", "recipient.runner",
  "recipient.billing", "relay.v2aware", "hw.oneGuest", "cli.pins", "deploy.C1", "deploy.C2"].map((k) => [k, { ok: true, stepId: "x" }]));
const C1 = "0x" + "c1".repeat(32);
const plan = buildPlan(pins, obs, { C1, C2: "0x" + "c2".repeat(32) });
const step = (id) => plan.steps.find((s) => s.id === id);
const G = Uint8Array.from(Buffer.from("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex"));
const env = { CANARY_A: "CANARY_20261023T000000Z_c1-rev1_" + "aa".repeat(32), CANARY_B: "CANARY_20261023T000000Z_c1-rev1_" + "bb".repeat(32) };
const chain0 = { block: { number: "1" }, policy: { owner: "0x" + "00".repeat(20), policyRev: 0n, secretRev: 0n }, committee: { Y: G, epoch: 1 }, configText: "", ownerNonce: 10 };

test("decoys are well-formed and differ from the real image; every variant passes the pinned validateRules", async () => {
  const client = await loadClient(REPO);
  for (const v of ["image", "decoy-measurement", "decoy-runtime", "decoy-app"]) client.rules.validateRules(rulesFor(image, v));
  assert.notEqual(DECOY.measurement, image.measurement); assert.notEqual(DECOY.runtimeId, image.runtimeId); assert.notEqual(DECOY.appId, image.appId);
  assert.equal(rulesFor(image, "decoy-runtime").images[0].measurement, image.measurement);
  assert.equal(rulesFor(image, "decoy-measurement").images[0].runtimeId, image.runtimeId);
  assert.throws(() => rulesFor(image, "other"), /unknown rules variant/);
});

test("C1.create: the calldata decodes to update(C1, {expectPolicyRev 0, policy 0x4774 unpaused, rules(image), bundle}) and passes the tx pins", async () => {
  const client = await loadClient(REPO);
  const s = step("C1.create");
  const { prepared, tx } = prepareMutation({ client, pins, step: s, chain: chain0, env });
  const { args } = client.viem.decodeFunctionData({ abi: client.owner.UPDATE_V2_ABI, data: tx.data });
  assert.equal(args[0], C1);
  assert.equal(args[1].expectPolicyRev, 0n); assert.equal(args[1].setPolicy, true); assert.equal(args[1].paused, false);
  assert.equal(args[1].committeeId, "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3");
  assert.equal(args[1].setBundle, true); assert.equal(args[1].clear, false);
  assert.deepEqual(JSON.parse(Buffer.from(args[1].rules.slice(2), "hex").toString()).images[0].measurement, image.measurement);
  assert.equal(prepared.summary.nextSecretRev, "1");
  assert.ok(!JSON.stringify(prepared).includes(env.CANARY_A) && !tx.data.includes(Buffer.from(env.CANARY_A).toString("hex")), "values only inside the ciphertext");
  assert.ok(checkTxAgainstStep(tx, s, prepared, prepared.selector));
  assert.match(prepared.calldataRecordHash, /^[0-9a-f]{64}$/);
});

test("prepare refuses: policyRev out of step, a foreign policy owner, no Y, no values, no config text, a blocked step", async () => {
  const client = await loadClient(REPO);
  assert.throws(() => prepareMutation({ client, pins, step: step("C1.create"), chain: { ...chain0, policy: { ...chain0.policy, policyRev: 1n } }, env }), /out of step/);
  assert.throws(() => prepareMutation({ client, pins, step: step("C1.rotate"), chain: { ...chain0, policy: { owner: "0x" + "99".repeat(20), policyRev: 1n, secretRev: 1n } }, env }), /not the canary owner/);
  assert.throws(() => prepareMutation({ client, pins, step: step("C1.create"), chain: { ...chain0, committee: { Y: "0x02" } }, env }), /committee key Y/);
  assert.throws(() => prepareMutation({ client, pins, step: step("C1.create"), chain: chain0, env: null }), /marker values/);
  assert.throws(() => prepareMutation({ client, pins, step: step("C1.create"), chain: { ...chain0, configText: undefined }, env }), /configText/);
  const blocked = buildPlan(pins, {}, { C1 }).steps.find((s) => s.id === "C1.create");
  assert.throws(() => prepareMutation({ client, pins, step: blocked, chain: chain0, env }), /not a ready mutation/);
});

test("policy-only steps carry no bundle; pause carries paused:true; the decoy rules are what is written", async () => {
  const client = await loadClient(REPO);
  const owner = pins.owner.address;
  const at = (rev) => ({ ...chain0, policy: { owner, policyRev: BigInt(rev), secretRev: 2n } });
  for (const [id, rev, check] of [["N.image.rules", 2, (r) => r.images[0].measurement === DECOY.measurement], ["N.runtime.rules", 3, (r) => r.images[0].runtimeId === DECOY.runtimeId],
    ["N.app.rules", 4, (r) => r.appId === DECOY.appId], ["N.pause", 5, (r) => r.appId === image.appId], ["C1.restore", 6, (r) => r.appId === image.appId]]) {
    const { prepared, tx } = prepareMutation({ client, pins, step: step(id), chain: at(rev) });
    const { args } = client.viem.decodeFunctionData({ abi: client.owner.UPDATE_V2_ABI, data: tx.data });
    assert.equal(args[1].setBundle, false, id); assert.equal(args[1].expectPolicyRev, BigInt(rev), id);
    assert.equal(args[1].paused, id === "N.pause", id);
    assert.ok(check(JSON.parse(Buffer.from(args[1].rules.slice(2), "hex").toString())), id);
    assert.equal(prepared.summary.nextSecretRev, "2", id);
  }
});

test("simulations: NotOwner from a key-less decoy sender; StaleRevision from the owner one revision back", async () => {
  const client = await loadClient(REPO);
  const chain = { policy: { owner: pins.owner.address, policyRev: 2n, secretRev: 2n } };
  const a = prepareSimulation({ client, pins, step: step("N.sim.notOwner"), chain });
  assert.equal(a.from, DECOY_SENDER); assert.equal(a.expectRevert, "NotOwner");
  const b = prepareSimulation({ client, pins, step: step("N.sim.staleRev"), chain });
  assert.equal(b.from, pins.owner.address);
  assert.equal(client.viem.decodeFunctionData({ abi: client.owner.UPDATE_V2_ABI, data: b.data }).args[1].expectPolicyRev, 1n);
});
