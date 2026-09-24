// verifier/envelope.mjs: what the harness does with evidence it should not trust or does not understand.
// Every case here proves a NEGATIVE: the verdict is never "verified" for an unknown, unimplemented,
// development or malformed document, and the reason names why.
//   run: node --test test/verifier-envelope.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { verifyEvidence, parseEnvelope } from "../verifier/index.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url);
const rad = JSON.parse(fs.readFileSync(new URL("genoa-tinfoil/rad.json", F), "utf8"));

test("unknown format -> unsupported, never verified", async () => {
  const v = await verifyEvidence({ format: "vendor-x/quote/v9", body: rad.body });
  assert.equal(v.status, "unsupported"); assert.match(v.reasons[0], /unknown evidence format/);
});
test("development and T0 formats -> rejected", async () => {
  for (const format of ["dev-unattested-metal-v1", "none"]) {
    const v = await verifyEvidence({ format, body: Buffer.alloc(0x4a0).toString("base64") });
    assert.equal(v.status, "rejected", format); assert.match(v.reasons[0], /proves nothing|no hardware report/);
  }
});
test("Intel TDX, VBS enclave and Hyper-V partition documents -> unsupported with the pointer to their own verifier", async () => {
  // each on its own real shape (the Hyper-V front's document carries its report in `report`, not `body`)
  for (const [format, re, doc] of [["tdx-guest-metal-v1", /Intel TDX/, { body: Buffer.from("{}").toString("base64") }], ["https://tinfoil.sh/predicate/tdx-guest/v1", /Intel TDX/, { body: Buffer.from("{}").toString("base64") }],
                              ["windows-vbs-enclave/v1", /vbs-verify|VBS/, { body: Buffer.from("{}").toString("base64") }], ["hyperv-partition-domain/v1", /judge-hv|Hyper-V/, { tier: "T0-hv", nonce: "ab".repeat(32), report: Buffer.from("{}").toString("base64"), appSha256: "cd".repeat(32) }]]) {
    const v = await verifyEvidence({ format, ...doc });
    assert.equal(v.status, "unsupported", format); assert.match(v.reasons.join(" "), re);
    assert.equal(v.claims, null);
  }
});
test("a GPU report on its own is not CPU evidence", async () => {
  const v = await verifyEvidence({ format: "nvidia-cc/v1", body: "AAAA" });
  assert.equal(v.status, "unsupported");
});
test("malformed envelopes are refused before any cryptography", () => {
  assert.throws(() => parseEnvelope(null), /not an object/);
  assert.throws(() => parseEnvelope({ format: rad.format }), /missing/);
  assert.throws(() => parseEnvelope({ format: rad.format, body: rad.body + "!" }), /strict base64/);
  assert.throws(() => parseEnvelope({ format: rad.format, body: "A".repeat(70 * 1024) }), /cap/);
  // the hosted format is gzip; a plain body is not that format
  assert.throws(() => parseEnvelope({ format: rad.format, body: Buffer.alloc(0x4a0).toString("base64") }), /must be gzip/);
  // the metal format is not gzip; a gzip body is not that format
  assert.throws(() => parseEnvelope({ format: "sev-snp-guest-metal-v1", body: gzipSync(Buffer.alloc(0x4a0)).toString("base64") }), /is gzip but/);
  // a gzip bomb stays bounded
  assert.throws(() => parseEnvelope({ format: rad.format, body: gzipSync(Buffer.alloc(1 << 20)).toString("base64") }), /over the cap|cap/);
  assert.throws(() => parseEnvelope({ format: 123, body: rad.body }), /format/);
});
test("a well-formed hosted envelope parses to the raw 0x4a0-byte report", () => {
  const env = parseEnvelope(rad);
  assert.equal(env.body.length, 0x4a0); assert.equal(env.spec.technology, "amd-sev-snp"); assert.equal(env.spec.binding, "hosted-tinfoil");
});

// ---- the per-format SHAPE (2026-09-24): the body field's exact name, closed or open top level, declared fields validated --
const domainDoc = JSON.parse(fs.readFileSync(new URL("turin-m4a/doc.json", F), "utf8")).doc;
const metalBody = Buffer.alloc(0x4a0).toString("base64");
test("shapes: the hosted document is closed to exactly { format, body } (the certificate binds nothing else); the body field is never an alias", () => {
  assert.doesNotThrow(() => parseEnvelope(rad));
  assert.throws(() => parseEnvelope({ ...rad, transportKey: "AAAA" }), /unexpected field `transportKey`.*closed/);
  assert.throws(() => parseEnvelope({ ...rad, note: "x" }), /unexpected field `note`/);
  assert.throws(() => parseEnvelope({ format: rad.format, report: rad.body }), /carries `report` but this format's body field is `body`/);
  assert.throws(() => parseEnvelope({ ...rad, report: rad.body }), /carries `report`/);
});
test("shapes: a metal document as the guest agent emits it (transport key, unsigned certs, name, manifest, volumes) parses; each declared field is validated when present; unknown fields are tolerated but bounded", () => {
  const agentDoc = { format: "sev-snp-guest-metal-v1", body: metalBody, certs: Buffer.alloc(300).toString("base64"), transportKey: Buffer.alloc(44).toString("base64"), transportKeyFp: "ab".repeat(32), padKey: "cd".repeat(32), name: "box-1", manifest: { image: "x" }, volumes: { models: [] }, futureField: 1 };
  const env = parseEnvelope(agentDoc); assert.equal(env.body.length, 0x4a0); assert.equal(env.shape.body, "body");
  assert.throws(() => parseEnvelope({ ...agentDoc, transportKeyFp: "AB".repeat(32) }), /transportKeyFp must be 64 lowercase hex/);
  assert.throws(() => parseEnvelope({ ...agentDoc, transportKey: "not base64!" }), /transportKey is not strict base64/);
  assert.throws(() => parseEnvelope({ ...agentDoc, name: "n".repeat(129) }), /name must be a string of at most 128/);
  assert.throws(() => parseEnvelope({ ...agentDoc, manifest: "text" }), /manifest must be a JSON object/);
  assert.throws(() => parseEnvelope({ ...agentDoc, certs: "A".repeat(97 * 1024) }), /certs exceeds/);
  assert.throws(() => parseEnvelope({ ...agentDoc, report: metalBody }), /carries `report`/);
  assert.throws(() => parseEnvelope(Object.fromEntries([...Object.entries(agentDoc), ...Array.from({ length: 30 }, (_, i) => [`k${i}`, i])])), /top-level fields exceeds the cap/);
  assert.throws(() => parseEnvelope({ ...agentDoc, blob: "x".repeat(1024 * 1024) }), /exceeds the document cap/);
});
test("shapes: the real domain document parses with its report in `report`; `body` is another format's field; its declared claims are validated for shape only", () => {
  const env = parseEnvelope(domainDoc); assert.equal(env.shape.body, "report"); assert.equal(env.body.length, 0x4a0); assert.equal(env.doc.abi, "enclave-domain-abi/2");
  const { report, ...rest } = domainDoc;
  assert.throws(() => parseEnvelope({ ...rest, body: report }), /carries `body` but this format's body field is `report`/);
  assert.throws(() => parseEnvelope({ ...domainDoc, abi: "enclave-domain-abi/3" }), /abi must be one of/);
  assert.throws(() => parseEnvelope({ ...domainDoc, nonce: domainDoc.nonce.slice(1) }), /nonce must be 64 lowercase hex/);
  assert.throws(() => parseEnvelope({ ...domainDoc, appSha256: domainDoc.appSha256.toUpperCase() }), /appSha256 must be 64 lowercase hex/);
  assert.throws(() => parseEnvelope({ ...domainDoc, runtime: "wasmtime" }), /runtime must be a JSON object/);
  assert.throws(() => parseEnvelope({ ...domainDoc, tier: "T".repeat(17) }), /tier must be a string/);
  assert.doesNotThrow(() => parseEnvelope({ ...domainDoc, reason: "", boundary: { plane: 2 } }), "the front's optional fields");
});
test("shapes: AVF v2 requires the pad key the transcript binds, 32 bytes of lowercase hex; v1 may carry one; the VBS and Hyper-V documents parse to a body on their own field names", () => {
  const avfBody = Buffer.from(JSON.stringify({ chain: [], signature: "" })).toString("base64");
  assert.throws(() => parseEnvelope({ format: "android-avf-pvm/v2", body: avfBody }), /padKey is required/);
  assert.throws(() => parseEnvelope({ format: "android-avf-pvm/v2", body: avfBody, padKey: "AB".repeat(32) }), /padKey must be 64 lowercase hex/);
  assert.doesNotThrow(() => parseEnvelope({ format: "android-avf-pvm/v2", body: avfBody, padKey: "ab".repeat(32), transportKey: Buffer.alloc(44).toString("base64") }));
  assert.doesNotThrow(() => parseEnvelope({ format: "android-avf-pvm/v1", body: avfBody }));
  assert.throws(() => parseEnvelope({ format: "android-avf-pvm/v1", body: avfBody, padKey: "zz" }), /padKey must be 64 lowercase hex/);
  assert.equal(parseEnvelope({ format: "windows-vbs-enclave/v1", body: avfBody, transportKey: Buffer.alloc(44).toString("base64"), padKey: "ab".repeat(32) }).shape.body, "body");
  const hv = parseEnvelope({ format: "hyperv-partition-domain/v1", tier: "T0-hv", nonce: "ab".repeat(32), report: Buffer.from("{}").toString("base64"), appSha256: "cd".repeat(32) }); assert.equal(hv.shape.body, "report");
  assert.throws(() => parseEnvelope({ format: "hyperv-partition-domain/v1", body: Buffer.from("{}").toString("base64") }), /carries `body` but this format's body field is `report`/);
});
test("shapes: the verdict on a malformed shape is rejected before any cryptography, never unsupported and never verified", async () => {
  const v = await verifyEvidence({ ...rad, extra: 1 }); assert.equal(v.status, "rejected"); assert.match(v.reasons[0], /MALFORMED: .*unexpected field/);
  const w = await verifyEvidence({ format: "android-avf-pvm/v2", body: Buffer.from("{}").toString("base64") }); assert.equal(w.status, "rejected"); assert.match(w.reasons[0], /padKey is required/);
});
