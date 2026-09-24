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
  for (const [format, re] of [["tdx-guest-metal-v1", /Intel TDX/], ["https://tinfoil.sh/predicate/tdx-guest/v1", /Intel TDX/],
                              ["windows-vbs-enclave/v1", /vbs-verify|VBS/], ["hyperv-partition-domain/v1", /judge-hv|Hyper-V/]]) {
    const v = await verifyEvidence({ format, body: Buffer.from("{}").toString("base64") });
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
