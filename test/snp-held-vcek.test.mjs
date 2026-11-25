// rpc/snp/attested-fetch.mjs verifyReport: a whole-VM guest's report is judged with the VCEK its host holds before AMD's
// key server is asked, so a manager that AMD refuses (429 after a couple of requests) still attests what it runs.
// The report is the live one the r13 image produced on metal0 (test/fixtures/snp-vm/r13-smoke.json); nothing here
// reaches the network: kds is off, so "AMD would be asked" shows as the refusal that names it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyReport } from "../rpc/snp/attested-fetch.mjs";
import { seedCertChain } from "../relay/snp-verify.mjs";
import { validateConfig, SnpVmManager } from "../rpc/snp/vm-manager.mjs";

const f = JSON.parse(fs.readFileSync(new URL("./fixtures/snp-vm/r13-smoke.json", import.meta.url), "utf8"));
const CHAIN = new URL("./fixtures/amd/Turin-cert_chain.pem", import.meta.url);
const report = Buffer.from(f.doc.report, "base64"), vcek = Buffer.from(f.vcek, "base64");
const opts = { transportKeySpki: Buffer.from(f.spki, "base64"), challenge: Buffer.from(f.nonce, "hex"),
               allowedMeasurements: Object.values(f.versionConfig.snp.measurements).flat(), kds: false, minTcb: f.minTcb };
seedCertChain(f.product, fs.readFileSync(CHAIN, "utf8"));

test("the held VCEK verifies the report without AMD being asked", async () => {
  const v = await verifyReport(report, opts, () => vcek);
  assert.equal(v.ok, true); assert.equal(v.vcekVerified, true); assert.equal(v.tcb.checked, true);
  assert.ok(v.reasons.some((r) => /VCEK auxblob/.test(r)));
});

test("no held copy, an unreadable one, an empty one: the report is judged as before", async () => {
  for (const held of [null, () => null, () => Buffer.alloc(0), () => { throw new Error("ENOENT"); }]) {
    const v = await verifyReport(report, opts, held);
    assert.equal(v.ok, false); assert.match(v.reasons.at(-1), /no VCEK available \(no auxblob; KDS not consulted\)/);
  }
});

test("a held copy that is not this report's key is not an answer, and never a pass", async () => {
  // another certificate entirely (the chain's own ASK), and this chip's VCEK with one byte changed
  const ask = Buffer.from(fs.readFileSync(CHAIN, "utf8").split("-----END CERTIFICATE-----")[0].replace(/-----BEGIN CERTIFICATE-----|\s/g, ""), "base64");
  const bent = Buffer.from(vcek); bent[bent.length - 20] ^= 1;
  for (const held of [ask, bent, Buffer.from("not a certificate")]) {
    const v = await verifyReport(report, opts, () => held);
    // the lookup was tried (it is off here) and gave none, so the answer says what was wrong with the held copy
    assert.equal(v.ok, false); assert.match(v.reasons.at(-1), /none could be had from AMD/); assert.doesNotMatch(v.reasons.join(), /chain verified/);
  }
});

test("what the held copy cannot excuse: another measurement, another key, a TCB below policy", async () => {
  const refused = async (over, why) => { const v = await verifyReport(report, { ...opts, ...over }, () => vcek); assert.equal(v.ok, false, why.source); assert.ok(v.reasons.some((r) => why.test(r)), v.reasons.join(" | ")); };
  await refused({ allowedMeasurements: ["33".repeat(48)] }, /measurement/i);
  await refused({ transportKeySpki: Buffer.alloc(91, 1) }, /does not bind/);
  await refused({ minTcb: { Turin: { ...f.minTcb.Turin, microcode: 255 } } }, /below policy/);
});

test("the second judgement is asked only when the held copy did not settle it", async () => {
  const calls = [];
  const verify = (answers) => async (_r, o) => { calls.push(!!o.auxblob); return answers.shift(); };
  assert.equal((await verifyReport(report, opts, () => vcek, verify([{ ok: true, vcekVerified: true }]))).ok, true);
  assert.deepEqual(calls.splice(0), [true]);
  await verifyReport(report, opts, () => vcek, verify([{ ok: false, reasons: ["VCEK signature over the report is invalid"] }, { ok: true, vcekVerified: true }]));
  assert.deepEqual(calls.splice(0), [true, false]);
  // with none from AMD either, the held copy's own refusal is the one reported
  const both = await verifyReport(report, opts, () => vcek, verify([{ ok: false, reasons: ["TCB below policy"] }, { ok: false, reasons: ["no VCEK available (no auxblob; KDS returned none)"] }]));
  assert.deepEqual([both.ok, both.reasons[0]], [false, "TCB below policy"]); calls.splice(0);
  // "ok" without a verified chain is not settled either
  await verifyReport(report, opts, () => vcek, verify([{ ok: true, vcekVerified: false }, { ok: false, reasons: ["x"] }]));
  assert.deepEqual(calls.splice(0), [true, false]);
});

test("manager config: amd is {product, vcekFile, certChainFile}; a chain that is not AMD's refuses at start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-")), base = { listen: "127.0.0.1:8099", bindings: {} };
  const amd = { product: "Turin", vcekFile: path.join(dir, "vcek.der"), certChainFile: CHAIN.pathname };
  assert.deepEqual(validateConfig({ ...base, amd }).amd, amd);
  for (const [over, why] of [[{ product: "Zen" }, /product/], [{ vcekFile: "vcek.der" }, /absolute/], [{ certChainFile: undefined }, /must be \{product/], [{ extra: 1 }, /must be \{product/]]) {
    const a = { ...amd, ...over }; for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
    assert.throws(() => validateConfig({ ...base, amd: a }), why);
  }
  new SnpVmManager({ ...base, amd });   // a missing VCEK file is no error: AMD is asked as before
  const wrong = path.join(dir, "chain.pem"); fs.writeFileSync(wrong, fs.readFileSync(new URL("./fixtures/amd/Genoa-cert_chain.pem", import.meta.url)));
  assert.throws(() => new SnpVmManager({ ...base, amd: { ...amd, certChainFile: wrong } }), /not AMD's pinned root/);
  fs.rmSync(dir, { recursive: true, force: true });
});
