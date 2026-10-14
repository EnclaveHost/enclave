// verifier/metal-box.mjs: the orchestration around the SNP verdict for a metal box reached through the relay (the CLI's
// `enclave attest`, the site's live verify). The SNP rules themselves are verifier/snp.mjs's (test/verifier-snp-*.test.mjs);
// here the verdict function is a stub that records what it was given, so each rule of the orchestration is pinned alone:
// OUR nonce reaches both the relay and the verdict, the transport key comes from the document, the measurement source is
// named, and an operator-stated expectation can never come out "verified".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyMetalBoxWith, TCB_FLOORS, OPERATOR_STATED, FRESH_ATTESTATION_PATH } from "../verifier/metal-box.mjs";

const M1 = "11".repeat(48), M2 = "22".repeat(48);
const SPKI = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const docFor = (over = {}) => ({ format: "sev-snp-guest-metal-v1", body: Buffer.alloc(1184).toString("base64"), transportKey: SPKI.toString("base64"), certs: Buffer.from("aux").toString("base64"), name: "metal0", ...over });
function deps({ answer = (nonceHex) => ({ status: 200, body: { name: "metal0", nonce: nonceHex, document: docFor(), operatorAllowlist: { measurements: [M1, "nothex"], admittedAtAttach: M1 } } }),
                verdict = { status: "verified", omissions: [], reasons: ["ok"], checks: { chain: true, measurement: true, binding: true }, claims: { measurement: M1, product: "Turin", tcb: { reported: {} } } } } = {}) {
  const seen = { urls: [], verify: [] };
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  return { seen, nonce, d: {
    fetchImpl: async (url) => { seen.urls.push(url); const n = new URL(url).searchParams.get("nonce"); const a = answer(n); return { status: a.status, text: async () => JSON.stringify(a.body) }; },
    verify: async (doc, args) => { seen.verify.push({ doc, ...args }); return typeof verdict === "function" ? verdict(doc, args) : verdict; },
    collateral: { tag: "collateral" }, randomBytes: () => nonce, sha256: async (b) => new Uint8Array(createHash("sha256").update(b).digest()),
    toBytes: (u) => Buffer.from(u), now: () => new Date("2026-10-14T07:00:00Z") } };
}

test("metal box: OUR nonce goes to the relay and into the verdict's binding; the transport key and the box's own VCEK table come from the document", async () => {
  const { d, seen, nonce } = deps();
  const r = await verifyMetalBoxWith(d, { apiBase: "https://api.example", name: "metal0" });
  assert.equal(seen.urls.length, 1);
  assert.equal(seen.urls[0], `https://api.example${FRESH_ATTESTATION_PATH("metal0")}?nonce=${Buffer.from(nonce).toString("hex")}`);
  const v = seen.verify[0];
  assert.deepEqual(v.context.nonce, Buffer.from(nonce)); assert.deepEqual(v.context.transportKeySpki, SPKI);
  assert.deepEqual(v.context.auxblob, Buffer.from("aux")); assert.equal(v.collateral.tag, "collateral");
  assert.deepEqual(v.policy.snp.minTcb, TCB_FLOORS, "the published floors apply unless the caller states one");
  assert.deepEqual(v.policy.snp.allowedMeasurements, [M1], "a malformed allowlist entry is dropped, never matched");
  assert.equal(r.nonce, Buffer.from(nonce).toString("hex"));
  assert.equal(r.transportKeySha256, createHash("sha256").update(SPKI).digest("hex"));
  assert.match(r.channel, /TLS ends at the relay/);
});

test("metal box: a measurement matched only by the operator's allowlist is LIMITED with the named omission, never verified", async () => {
  const { d } = deps();
  const r = await verifyMetalBoxWith(d, { name: "metal0" });
  assert.equal(r.status, "limited"); assert.equal(r.admissionSafe, false);
  assert.ok(r.omissions.includes(OPERATOR_STATED));
  assert.match(r.expected.source, /operator allowlist/);
  assert.equal(r.expected.admittedAtAttach, M1);
});

test("metal box: a caller-pinned measurement is the policy, and a clean verdict is verified", async () => {
  const { d, seen } = deps();
  const r = await verifyMetalBoxWith(d, { name: "metal0", expected: { measurements: [M1.toUpperCase(), M2], source: "--expect" } });
  assert.deepEqual(seen.verify[0].policy.snp.allowedMeasurements, [M1, M2]);
  assert.equal(r.status, "verified"); assert.equal(r.admissionSafe, true); assert.equal(r.expected.source, "--expect");
  assert.equal((await verifyMetalBoxWith(deps().d, { name: "metal0", expected: { measurements: ["abc"] } })).status, "unavailable", "a malformed pin is refused before any fetch");
});

test("metal box: a refusal by the verdict stays a refusal (no omission can lift or lower it), and failed checks are listed", async () => {
  const { d } = deps({ verdict: { status: "rejected", omissions: [], reasons: ["REJECT: binding"], checks: { chain: true, binding: false }, claims: { measurement: M2 } } });
  const r = await verifyMetalBoxWith(d, { name: "metal0" });
  assert.equal(r.status, "rejected"); assert.deepEqual(r.failedChecks, ["binding"]); assert.ok(!r.omissions.includes(OPERATOR_STATED));
});

test("metal box: the relay answering for another nonce, a non-metal document, an HTTP error or a bad name are UNAVAILABLE, and nothing is verified", async () => {
  for (const [label, answer, name] of [
    ["another nonce", () => ({ status: 200, body: { nonce: "00".repeat(32), document: docFor() } }), "metal0"],
    ["hosted format", (n) => ({ status: 200, body: { nonce: n, document: docFor({ format: "https://Cloud Provider.sh/predicate/sev-snp-guest/v2" }) } }), "metal0"],
    ["no transport key", (n) => ({ status: 200, body: { nonce: n, document: docFor({ transportKey: undefined }) } }), "metal0"],
    ["HTTP 404", () => ({ status: 404, body: { error: "no_box", message: "no attested SEV-SNP box named x" } }), "metal0"],
    ["bad name", () => ({ status: 200, body: {} }), "../etc"],
  ]) {
    const { d, seen } = deps({ answer });
    const r = await verifyMetalBoxWith(d, { name });
    assert.equal(r.status, "unavailable", label); assert.equal(seen.verify.length, 0, `${label}: the verdict never ran`);
  }
});
