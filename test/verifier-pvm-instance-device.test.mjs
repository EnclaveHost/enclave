// Independent review of the pVM owner's Pixel 10 INSTANCE-BINDING campaign (fixtures.json pvm-instance-device, the owner's
// 7e88dc76): every recorded exchange re-verified offline through THIS verifier's adapter over the owner's module pinned at
// 193cf823 (unchanged in 7e88dc76) under Google's roots, with the expectations taken from the type-2 policy the client had
// committed and the nonce from each request line, never from the envelope. Proves, from the raw files: the enrolled
// InstanceID is SHA-256 of the instance key the VM presented over the enrollment's own nonce; the type-2 policy binds the
// deployment to exactly it; every EVIDENCE3 answer is a v3 envelope proving that InstanceID, across the first boot, a
// restart and a same-key APK update (the same instance key, new transport keys); the SAME genuine VM is refused for a
// deployment bound to another instance, after its app and Bind3 checks passed; an unbound deployment answers over v2 and a
// v2 answer is a downgrade for a bound one; the gate releases only the bound turns; no envelope was cut (the owner's NUL
// bug). Not measured by the owner and not claimed here: re-provisioning (a new instance.img).
//   run: node --test test/verifier-pvm-instance-device.test.mjs   (strict: ENCLAVE_PVM_MODULE resolved by the runner)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readExchanges, reverifyExchange, expectFromPolicy } from "./helpers/pvm-device-evidence.mjs";
import { verifyClientPolicy, selectDeployment } from "../verifier/pvm-policy.mjs";
import { verifyPvmEvidence } from "../verifier/pvm-evidence.mjs";
import { admit, RELEASE, HOLD } from "../verifier/admission.mjs";
import { loadOwnerModule } from "../verifier/pvm-evidence.mjs";

const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const owner = await loadOwnerModule();
if (STRICT && !owner) throw new Error("strict integration: the owner's module is not resolved");
const skip = !owner && "owner module absent";
const F = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "verifier", "pvm-instance-device");
const js = (f) => JSON.parse(fs.readFileSync(path.join(F, f), "utf8")), txt = (f) => fs.readFileSync(path.join(F, f), "utf8");
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const enroll = js("enroll-a.json"), anchor = js("cli-install.json").anchor, policy2 = js("policies/policy-2.json");
const meta = (n) => js(`evidence/evidence-${n}.meta.json`), exs = readExchanges(path.join(F, "evidence"));
const runs = txt("exchanges.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const P = verifyClientPolicy(policy2, { anchorFp: anchor.policyKeyFp, serialFloor: anchor.serialFloor, now: Date.parse(meta("002").answeredAt), clientVersion: "0.5.0" });
const body = P.policy, D_BOUND = body && body.deployments[0].id, D_OTHER = body && body.deployments[1].id;

test("the enrollment record: the InstanceID is SHA-256 of the instance key the VM presented over the enrollment's own nonce, and the type-2 policy binds the deployment to exactly it", { skip }, () => {
  assert.equal(enroll.type, "enclave-pvm-instance-enrollment/1"); assert.equal(enroll.alreadyBound, false);
  assert.equal(sha256hex(Buffer.from(enroll.instanceKey, "hex")), enroll.instanceId); assert.match(enroll.instanceKey, /^302a300506032b6570032100[0-9a-f]{64}$/);
  assert.equal(exs[0].asked, 3); assert.equal(exs[0].nonce, enroll.nonce, "the enrollment's nonce is the first exchange's request");
  assert.equal(exs[0].envelope.instanceKey, enroll.instanceKey); assert.equal(exs[0].envelope.spki, enroll.transportSpki);
  assert.equal(P.ok, true, P.reason); assert.equal(body.type, "enclave-pvm-client-policy/2"); assert.equal(body.serial, 2);
  assert.deepEqual(selectDeployment(body, { deployment: enroll.deployment }).instances, [enroll.instanceId]);
  assert.equal(D_BOUND, enroll.deployment); assert.notEqual(selectDeployment(body, { deployment: D_OTHER }).instances[0], enroll.instanceId, "the other deployment is bound to another instance");
  const e = P.expectationsForSelection({ deployment: D_BOUND }); assert.deepEqual(e.expect.instanceIds, [enroll.instanceId]); assert.deepEqual(e.expect.formats, ["enclave-pvm-app-evidence/v3"]);
  assert.deepEqual(runs.map((r) => [r.label, r.rc]), [["enroll-a", 0], ["bound-a", 0], ["other-a", 1], ["unbound-a", 0], ["bound-b", 0], ["bound-c", 0]], "the six client runs and their exit codes");
});

test("every EVIDENCE3 answer re-verifies as v3 proving the enrolled InstanceID (five: first boot, restart, same-key update), with one instance key and new transport keys per boot; no answer was cut", { skip }, async () => {
  assert.equal(exs.length, 6); assert.deepEqual(exs.map((e) => e.asked), [3, 3, 3, 2, 3, 3]);
  for (const ex of exs) { assert.equal(ex.parseError, null, `exchange ${ex.n} parses`); assert.ok(ex.envelopeText.endsWith("\n") && !ex.envelopeText.includes("\0"), `exchange ${ex.n} ends in its newline, never a NUL (the owner's payload bug)`); }
  const v3 = exs.filter((e) => e.asked === 3), keys = new Set(), transports = new Set();
  for (const ex of v3) {
    const r = await reverifyExchange(ex, body, { now: Date.parse(meta(ex.n).answeredAt), instanceIds: [enroll.instanceId] });
    assert.equal(r.ok, true, `exchange ${ex.n}: ${r.why}`); assert.equal(r.verdict.claims.format, "enclave-pvm-app-evidence/v3"); assert.equal(r.verdict.claims.instanceId, enroll.instanceId);
    keys.add(r.verdict.claims.instanceKey); transports.add(r.verdict.claims.transportSpki);
    assert.equal(r.gate.decision, RELEASE, `exchange ${ex.n}: the gate releases the bound turn`);
  }
  assert.deepEqual([...keys], [enroll.instanceKey], "one instance key across the first boot, the restart and the same-key update");
  assert.ok(transports.size >= 3, `new transport keys per boot (${transports.size} distinct across five v3 exchanges)`);
  assert.notEqual(exs[4].envelope.spki, exs[1].envelope.spki, "after the restart (phase B) the transport key is new");
  assert.notEqual(exs[5].envelope.spki, exs[4].envelope.spki, "after the same-key update (phase C) the transport key is new again");
});

test("the SAME genuine VM is refused for a deployment bound to ANOTHER instance, after its app, Bind3 and instance-signature checks passed; and it verifies for the deployment bound to it", { skip }, async () => {
  const ex = exs[2];   // other-a: the client refused at verify and sent nothing (rc 1)
  const other = selectDeployment(body, { deployment: D_OTHER }).instances;
  const refused = await reverifyExchange(ex, body, { now: Date.parse(meta(ex.n).answeredAt), instanceIds: other });
  assert.equal(refused.ok, false); assert.match(refused.why, /not one bound to the selected deployment/);
  const text = refused.verdict.reasons.join(" | ");
  for (const s of ["Bind3", "the instance key signed this challenge"]) assert.ok(text.includes(s), `the owner's checks before the instance refusal ran (${s})`);
  assert.equal(admit(refused.verdict, expectFromPolicy(body, ex.nonce, { instanceIds: other }), { clientKind: "browser" }).decision, HOLD);
  const accepted = await reverifyExchange(ex, body, { now: Date.parse(meta(ex.n).answeredAt), instanceIds: [enroll.instanceId] });
  assert.equal(accepted.ok, true, accepted.why); assert.equal(accepted.verdict.claims.instanceId, enroll.instanceId, "the same envelope verifies for the deployment bound to this instance: app identity and instance identity are two facts");
});

test("the unbound deployment answered over v2 with no instance; the same v2 answer is a downgrade for a bound deployment; a v3 answer for an unbound deployment still verifies", { skip }, async () => {
  const ex = exs[3]; assert.equal(ex.asked, 2); assert.equal(ex.envelope.format, "enclave-pvm-app-evidence/v2");
  const r = await reverifyExchange(ex, body, { now: Date.parse(meta(ex.n).answeredAt) });
  assert.equal(r.ok, true, r.why); assert.equal(r.verdict.claims.instanceId, null); assert.equal(r.verdict.claims.instanceKey, null);
  const bound = await verifyPvmEvidence(ex.envelope, expectFromPolicy(body, ex.nonce, { instanceIds: [enroll.instanceId] }), { now: Date.parse(meta(ex.n).answeredAt) });
  assert.equal(bound.status, "rejected"); assert.match(bound.reasons.at(-1), /enclave-pvm-app-evidence\/v3.*downgrade/, "refused as a downgrade before any certificate (the narrowed formats or the bound-deployment rule, both name v3)");
  const u = await reverifyExchange(exs[1], body, { now: Date.parse(meta("002").answeredAt) });
  assert.equal(u.ok, true, u.why); assert.equal(u.verdict.claims.instanceId, enroll.instanceId, "a v3 answer verifies for an unbound selection too, and still names its instance");
});

test("the owner's record is honest about its limits: the checker passed, re-provisioning is stated unmeasured, and the NUL-bug attempts are named", { skip }, () => {
  const check = txt("check.txt"), notes = txt("NOTES.md");
  assert.match(check, /^PASS instance binding on the device/m); assert.match(check, /re-verified \(6 of 6\)/);
  assert.match(notes, /Not measured\.\*\* Re-provisioning|Not measured.*Re-provisioning/s);
  assert.match(notes, /NUL/); assert.match(notes, /attempts 1-4|attempts 1-3/);
  assert.equal(fs.existsSync(path.join(F, "policy-key.json")), true); assert.match(txt("policy-key.json"), /LAB TEST KEY/);
  assert.ok(!/"privateKey"|BEGIN PRIVATE KEY|"seed"/.test(fs.readdirSync(F).map((f) => (fs.statSync(path.join(F, f)).isFile() ? txt(f) : "")).join("")), "no private key in the top-level files");
});
