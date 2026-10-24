// attest-price.mjs offline: the target comes ONLY from a root-approved build.json, re-tied to every present image location; one
// frozen target added to the frozen helpers; their own checks run against that measurement; acceptance is strict. No network.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as W from "../attest-price.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const M = sha(Buffer.from("candidate")).repeat(2).slice(0, 96), KEY = "0x8853f452533e2f05eb4c9289f77dbeacc316d1ed";
const COMMIT = "7dd3acd061af765cdcd9ba21b9744f2f2c6bdf5b", NAME = "dist-leasegas-7dd3acd06";

function fixture({ measurement = M, approve = true, files: over = {} } = {}) {
  const base = fs.mkdtempSync(path.join(HERE, "..", ".attest-price-test-"));
  const img = (root) => { const d = path.join(root, NAME); fs.mkdirSync(d, { recursive: true });
    const files = { MEASUREMENT: measurement + "\n", cmdline: "c", "initramfs.cpio.gz": "i", "manifest.json": "{}", vmlinuz: "k", ...over };
    for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(d, f), b);
    return Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha(Buffer.from(b))])); };
  const prod = path.join(base, "prod"), build = path.join(base, "build"), act = path.join(base, "act");
  fs.mkdirSync(act); const files = img(path.join(build, "stage"));
  const raw = Buffer.from(JSON.stringify({ commit: COMMIT, name: NAME, measurement, files }) + "\n");
  fs.writeFileSync(path.join(act, "build.json"), raw);
  fs.writeFileSync(path.join(act, "APPROVED-BUILD.txt"), `build-sha256 ${approve ? sha(raw) : "0".repeat(64)}\n`);
  return { base, prod, build, act, img, files, done: () => fs.rmSync(base, { recursive: true }) };
}

test("frozen helpers are the pinned bytes", () => W.checkFrozen());

test("the target is only a root-approved build.json, never a prior or malformed measurement", () => {
  const f = fixture(); try {
    const t = W.approvedTarget(f.act, { build: f.build, prod: f.prod });
    assert.equal(t.measurement, M); assert.ok(Object.isFrozen(t)); assert.equal(t.images[0], path.join(f.prod, NAME));
  } finally { f.done(); }
  for (const o of [{ approve: false }, { measurement: W.PRIORS[2] }, { measurement: "ab" }]) {
    const g = fixture(o); try { assert.throws(() => W.approvedTarget(g.act, { build: g.build, prod: g.prod })); } finally { g.done(); }
  }
});

test("image pins: every present location must match build.json; a differing production copy refuses", () => {
  const f = fixture(); try {
    const t = W.approvedTarget(f.act, { build: f.build, prod: f.prod });
    assert.equal(W.checkImage(t), path.join(f.build, "stage", NAME));               // before stage.py: the build stage only
    f.img(f.prod); assert.equal(W.checkImage(t), path.join(f.prod, NAME));          // after an exact copy: production first
    fs.writeFileSync(path.join(f.prod, NAME, "initramfs.cpio.gz"), "j");
    assert.throws(() => W.checkImage(t), /not the approved file/);
    fs.rmSync(path.join(f.prod, NAME), { recursive: true }); fs.rmSync(path.join(f.build, "stage", NAME), { recursive: true });
    assert.throws(() => W.checkImage(t), /no approved image/);
  } finally { f.done(); }
});

test("attest pins the frozen probe to the approved measurement; acceptance is strict; proofkey runs the frozen checks", async () => {
  const f = fixture(); try {
    const t = W.approvedTarget(f.act, { build: f.build, prod: f.prod }); const image = W.checkImage(t);
    const e = await W.installTarget(t, image); assert.equal(e.measurement, M); assert.ok(Object.isFrozen(e));
    await assert.rejects(W.installTarget({ ...t, measurement: W.PRIORS[1] }, image), /different priceRecovery/);
    const { verdict } = await W.attest(t, { deps: { fetchImpl: async () => ({ status: 503, text: async () => "down" }), now: Date.parse("2026-10-23T22:40:00Z") } });
    assert.equal(verdict.target, "priceRecovery"); assert.equal(verdict.expectedMeasurement, M); assert.equal(verdict.accepted, false);
    assert.equal(verdict.wrapper, "attest-price/1"); assert.equal(verdict.buildSha256, t.buildSha256);
    const ok = { pass: true, status: "verified", target: "priceRecovery", expectedMeasurement: M, observedMeasurement: M, failedChecks: [] };
    assert.equal(W.attestAccepted(ok, t), true);
    for (const o of [{ pass: false }, { status: "limited" }, { target: "recovery" }, { observedMeasurement: W.PRIORS[2] }, { failedChecks: ["crl"] }, { failedChecks: undefined }])
      assert.equal(W.attestAccepted({ ...ok, ...o }, t), false, JSON.stringify(o));
    const spki = crypto.randomBytes(91), T = sha(spki);
    const report = (m) => { const r = Buffer.alloc(0x4a0); crypto.createHash("sha256").update(spki).digest().copy(r, 0x50); Buffer.from(m, "hex").copy(r, 0x90); return r; };
    const probe = (m) => async ({ target }) => { assert.equal(target, "priceRecovery");
      return { verdict: { pass: true, status: "verified", observedMeasurement: m, transportKeySha256: T, failedChecks: [], unavailable: [] }, raw: {} }; };
    const sup = (m) => async () => ({ status: 200, text: async () => JSON.stringify({ proofKey: { address: KEY, keySource: "in-enclave" }, sessionKey: { kid: "k" },
      enclave: { attestationDocument: { format: "sev-snp-guest-metal-v1", transportKey: spki.toString("base64"), body: report(m).toString("base64") } } }) });
    const registry = (pk) => async () => ({ endpoint: "https://api.enclave.host/t/metal0", operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab", active: true, proofKey: pk });
    const go = (deps) => W.proofkey(t, { expectProofKey: KEY, deps: { now: "2026-10-23T22:40:00Z", ...deps } }).then((r) => r.verdict);
    let v = await go({ probe: probe(M), fetchImpl: sup(M), registry: registry(KEY) });
    assert.equal(v.status, "verified-legacy"); assert.match(v.parts["B supervisor"], /not hardware-bound/);
    assert.ok(v.limits.some((l) => /not bound into any SNP report_data/.test(l)));
    assert.equal((await go({ probe: probe(M), fetchImpl: sup(M), registry: registry("0x" + "11".repeat(20)) })).status, "pending-registry");
    assert.equal((await go({ probe: probe(W.PRIORS[2]), fetchImpl: sup(M), registry: registry(KEY) })).status, "rejected");
    assert.equal((await go({ probe: probe(M), fetchImpl: sup(W.PRIORS[2]), registry: registry(KEY) })).status, "rejected");
  } finally { f.done(); }
});
