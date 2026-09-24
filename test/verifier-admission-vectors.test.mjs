// verifier/admission-vectors.json is the gate's rule as data: every case replays through admit() with the same decision
// and reason, the file is what the generator produces today (no drift), and the release cases are exactly the ones the
// rule allows. Another implementation of the client's release decision is held to this file.
//   run: node --test test/verifier-admission-vectors.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { vectors, VECTORS_PATH } from "../verifier/admission-vectors.mjs";
import { admit, createNonceRegistry } from "../verifier/admission.mjs";

const file = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));
const fromJson = (v) => v && typeof v === "object" && !Array.isArray(v) && typeof v.hex === "string" && Object.keys(v).length === 1 ? Buffer.from(v.hex, "hex") : Array.isArray(v) ? v.map(fromJson) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJson(x)])) : v;

test("the committed vectors are what the generator produces (no drift between the gate and its published rule)", () => {
  assert.deepEqual(file, JSON.parse(JSON.stringify(vectors())));   // through JSON, as the file was written (undefined-valued keys drop)
});
test("every vector replays through admit() with the same decision and reason, from the file alone", () => {
  for (const c of file.cases) {
    const reg = createNonceRegistry(); for (const n of c.usedNonces) reg.consume(n);
    const r = admit(fromJson(c.verdict), fromJson(c.expect), { clientKind: c.clientKind, observedPeerSpki: c.observedPeerSpki ? Buffer.from(c.observedPeerSpki, "hex") : null, nonceRegistry: reg });
    assert.equal(r.decision, c.decision, c.name); assert.equal(r.reasons.at(-1), c.reason, c.name); assert.deepEqual(r.pinned, c.pinned, c.name);
  }
});
test("the release set is exactly the rule's: verified, safe, omission-free, expectations met, transport bound for the client kind", () => {
  const releases = file.cases.filter((c) => c.decision === "release").map((c) => c.name).sort();
  assert.deepEqual(releases, [
    "domain verified, native, nonce + app id + peer key",
    "hosted verified, browser, HPKE key present",
    "hosted verified, native, own peer key is the bound key",
    "pVM v1 verified, native",
    "pVM v2 verified, browser, app key + sealed window",
    "pVM v2 verified, native, own peer key is the transport key",
    "pVM v3 verified, browser, deployment bound to this instance",
    "pVM v3 verified, native, bound, own peer key is the transport key",
    "pVM v3 verified, unbound deployment (no instance expectation)"
  ]);
  assert.equal(file.cases.length, 49);
  for (const c of file.cases.filter((x) => x.decision === "hold")) assert.equal(c.pinned, null, `${c.name}: a hold pins nothing`);
});
