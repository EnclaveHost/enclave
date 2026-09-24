// The optional deployment table of the signed client policy and the selection step, as agreed with the pVM owner
// (client 0.4.0): this branch's independent verifier (verifier/pvm-policy.mjs) on lab-signed vectors, and a DIFFERENTIAL
// against the owner's pinned trust.js (verifyPolicy, selectDeployment at the pinned commit) on the same vectors: every
// accept/refuse decision must agree. A table names which app a deployment is expected to run; the expectation never
// comes from a catalog or a relay; an id is canonical bytes32 and is never normalised; nothing is implied by default.
//   run: ENCLAVE_PVM_CLIENT_SRC=<pinned cli.mjs, 0.4.0 or later> node --test test/verifier-pvm-policy-deployments.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyClientPolicy, selectDeployment, keyFingerprint, DEPLOYMENT_ID } from "../verifier/pvm-policy.mjs";
import { keys, signedPolicy, rawPub, fpOf, APP } from "./helpers/pvm-lab.mjs";

const SRC = process.env.ENCLAVE_PVM_CLIENT_SRC || "", STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const trustPath = SRC ? path.resolve(path.dirname(SRC), "src", "trust.js") : "";
let owner = null;
if (trustPath && fs.existsSync(trustPath)) { owner = await import(pathToFileURL(trustPath).href); if (!owner.selectDeployment) owner = null; }
if (STRICT && !owner) throw new Error("strict integration: the pinned client source with selectDeployment (0.4.0 or later) is missing (ENCLAVE_PVM_CLIENT_SRC)");
const skipDiff = !owner && "owner's pinned source with deployment selection absent (ENCLAVE_PVM_CLIENT_SRC at 0.4.0 or later)";

const K = keys(), APP2 = "5a".repeat(32), NOW = Date.now();
const D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32), D3 = "0x" + "d3".repeat(32);
// the lab signer returns bookkeeping beside the envelope (digest, serial); a carrier serves exactly { policy, sig }, and so do these
const wire = (e) => ({ policy: e.policy, sig: e.sig });
const mine = (env, over = {}) => verifyClientPolicy(wire(env), { anchorFp: fpOf(K.policy), serialFloor: 1, now: NOW, clientVersion: "0.4.0", ...over });
const theirs = async (env, over = {}) => owner.verifyPolicy(wire(env), { state: { policyFp: fpOf(K.policy), nextPolicyFp: null, serial: 1, digest: null, releaseFp: fpOf(K.release), nextReleaseFp: null, ...over.state }, now: NOW, clientVersion: "0.4.0" });
const pol = (serial, opts) => signedPolicy(K, serial, { appIds: [APP, APP2], ...opts });

const VECTORS = [
  ["no table: the 15-field policy unchanged", pol(2), true],
  ["one entry", pol(2, { deployments: [{ id: D1, app: APP }] }), true],
  ["three entries, two apps", pol(2, { deployments: [{ id: D1, app: APP }, { id: D2, app: APP2 }, { id: D3, app: APP }] }), true],
  ["entry keys in the other order (id, app)", pol(2, { deployments: [{ app: APP, id: D1 }] }), true],
  ["the table placed before the other fields", pol(2, { deployments: [{ id: D1, app: APP }], rawBody: (b) => ({ deployments: b.deployments, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== "deployments")) }) }), true],
  ["64 entries", pol(2, { deployments: Array.from({ length: 64 }, (_, i) => ({ id: "0x" + i.toString(16).padStart(64, "0"), app: APP })) }), true],
  ["empty table", pol(2, { deployments: [] }), false],
  ["65 entries", pol(2, { deployments: Array.from({ length: 65 }, (_, i) => ({ id: "0x" + i.toString(16).padStart(64, "0"), app: APP })) }), false],
  ["table is an object", pol(2, { deployments: { id: D1, app: APP } }), false],
  ["table is a string", pol(2, { deployments: "0x00" }), false],
  ["table is null", pol(2, { deployments: null }), false],
  ["entry is a string", pol(2, { deployments: [D1] }), false],
  ["entry is null", pol(2, { deployments: [null] }), false],
  ["entry is an array", pol(2, { deployments: [[D1, APP]] }), false],
  ["entry with an extra key", pol(2, { deployments: [{ id: D1, app: APP, name: "x" }] }), false],
  ["entry missing app", pol(2, { deployments: [{ id: D1 }] }), false],
  ["uppercase id", pol(2, { deployments: [{ id: "0x" + "D1".repeat(32), app: APP }] }), false],
  ["id without 0x", pol(2, { deployments: [{ id: "d1".repeat(32), app: APP }] }), false],
  ["id of 63 hex", pol(2, { deployments: [{ id: "0x" + "d1".repeat(31) + "d", app: APP }] }), false],
  ["id of 65 hex", pol(2, { deployments: [{ id: D1 + "0", app: APP }] }), false],
  ["app not admitted by appIds", pol(2, { deployments: [{ id: D1, app: "77".repeat(32) }] }), false],
  ["app not hex", pol(2, { deployments: [{ id: D1, app: "not hex" }] }), false],
  ["duplicate id", pol(2, { deployments: [{ id: D1, app: APP }, { id: D1, app: APP2 }] }), false],
  ["duplicate id, same app", pol(2, { deployments: [{ id: D1, app: APP }, { id: D1, app: APP }] }), false],
];

test("this branch's verifier: each table vector is accepted or refuses the WHOLE policy as the contract says; a refused policy yields no expectations for anything", () => {
  for (const [name, env, ok] of VECTORS) {
    const r = mine(env); assert.equal(r.ok, ok, `${name}: ${r.reason}`);
    if (!ok) assert.equal(r.policy, null, `${name}: nothing usable from a refused policy`);
  }
  assert.equal(DEPLOYMENT_ID.test(D1), true); assert.equal(DEPLOYMENT_ID.test(D1.toUpperCase()), false);
});
test("selection on a verified policy: by deployment the app is the table's; unknown, tableless, non-canonical, mismatched and empty selections are refused; nothing is implied", () => {
  const withTable = mine(pol(2, { deployments: [{ id: D1, app: APP }, { id: D2, app: APP2 }] })), noTable = mine(pol(2));
  assert.equal(withTable.ok, true); assert.equal(noTable.ok, true);
  assert.deepEqual(selectDeployment(withTable.policy, { deployment: D1 }), { ok: true, app: APP, deployment: D1, instances: null });
  assert.deepEqual(selectDeployment(withTable.policy, { deployment: D2, app: APP2 }), { ok: true, app: APP2, deployment: D2, instances: null });
  assert.match(selectDeployment(withTable.policy, { deployment: D3 }).reason, /does not name deployment/);
  assert.match(selectDeployment(noTable.policy, { deployment: D1 }).reason, /names no deployments/);
  assert.match(selectDeployment(noTable.policy, { deployment: D1, app: APP }).reason, /names no deployments/, "no silent fallback to --app when --deployment was given");
  assert.match(selectDeployment(withTable.policy, { deployment: D1.toUpperCase() }).reason, /never normalised/);
  assert.match(selectDeployment(withTable.policy, { deployment: D1.slice(2) }).reason, /never normalised/);
  assert.match(selectDeployment(withTable.policy, { deployment: D1, app: APP2 }).reason, /not the app the signed policy expects/);
  assert.match(selectDeployment(withTable.policy, {}).reason, /no app or deployment selected/);
  assert.match(selectDeployment(withTable.policy, { app: "77".repeat(32) }).reason, /does not admit/);
  assert.deepEqual(selectDeployment(withTable.policy, { app: APP }), { ok: true, app: APP, deployment: null, instances: null }, "--app alone keeps its meaning when --deployment is absent");
  const e = withTable.expectationsForSelection({ deployment: D2 }); assert.equal(e.ok, true); assert.equal(e.app, APP2); assert.equal(e.deployment, D2); assert.equal(e.expect.appId.toString("hex"), APP2);
  assert.equal(withTable.expectationsForSelection({ deployment: D3 }).ok, false);
});
test("the table is signed and monotonic like every field: a lower serial mapping a deployment to another app is a rollback; the same serial with another table is equivocation; a table under a stranger's key is refused", () => {
  const s5 = pol(5, { deployments: [{ id: D1, app: APP2 }] }), s4 = pol(4, { deployments: [{ id: D1, app: APP }] });
  const a = mine(s5); assert.equal(a.ok, true);
  const rb = mine(s4, { state: { serial: 5, digest: a.digest } }); assert.equal(rb.ok, false); assert.match(rb.reason, /rollback/);
  const eq = mine(pol(5, { deployments: [{ id: D1, app: APP }] }), { state: { serial: 5, digest: a.digest } }); assert.equal(eq.ok, false); assert.match(eq.reason, /equivocation/);
  const stranger = signedPolicy(K, 6, { key: K.other, appIds: [APP], deployments: [{ id: D1, app: APP }] }); assert.match(mine(stranger).reason, /anchor does not name/);
  const unsigned = { policy: Buffer.from(JSON.stringify({ deployments: [{ id: D1, app: APP }] })).toString("base64"), sig: "00".repeat(64) };
  assert.equal(verifyClientPolicy(unsigned, { anchorFp: fpOf(K.policy), serialFloor: 1, now: NOW, clientVersion: "0.4.0" }).ok, false, "a bare 'catalog' object served as a policy is refused");
});
test("differential: the owner's pinned trust.js and this verifier agree on every table vector and every selection", { skip: skipDiff }, async () => {
  for (const [name, env, ok] of VECTORS) {
    const t = await theirs(env), m = mine(env);
    assert.equal(t.ok, ok, `${name}: owner ${t.reasons?.[0]}`); assert.equal(m.ok, t.ok, `${name}: disagreement (mine: ${m.reason}; theirs: ${t.reasons?.[0]})`);
  }
  const withTable = (await theirs(pol(2, { deployments: [{ id: D1, app: APP }, { id: D2, app: APP2 }] }))).policy, noTable = (await theirs(pol(2))).policy;
  const cases = [[withTable, { deployment: D1 }], [withTable, { deployment: D2, app: APP2 }], [withTable, { deployment: D3 }], [noTable, { deployment: D1 }], [noTable, { deployment: D1, app: APP }], [withTable, { deployment: D1.toUpperCase() }], [withTable, { deployment: D1.slice(2) }], [withTable, { deployment: D1, app: APP2 }], [withTable, {}], [withTable, { app: APP }], [withTable, { app: "77".repeat(32) }]];
  for (const [p, sel] of cases) { const a = owner.selectDeployment(p, sel), b = selectDeployment(p, sel); assert.equal(b.ok, a.ok, `${JSON.stringify(sel)}: mine ${b.reason || "ok"} vs theirs ${a.reason || "ok"}`); if (a.ok) assert.deepEqual({ app: b.app, deployment: b.deployment }, { app: a.app, deployment: a.deployment }); }
  assert.ok(owner.CLIENT_VERSION && owner.CLIENT_VERSION >= "0.4.0", `the pinned source is ${owner.CLIENT_VERSION}`);
});
