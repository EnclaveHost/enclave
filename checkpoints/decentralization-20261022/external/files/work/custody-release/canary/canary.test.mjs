// Release-plumbing tests for the quote-only canary verifier (verify-custodian-quote.mjs). The positive path needs real AMD
// hardware (that is the canary); here: the wrapper's own refusals with an injected verifier, and the REAL verifyQuote
// (offline: kds false) refusing a synthetic-chain report.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.join(HERE, "../../custody-owner-migration/tree");     // test helpers (synthetic AMD chain) live there
const { synthChain, synthReport } = await import(path.join(TREE, "test/helpers/snp-synth.mjs"));
const { resign } = await import(path.join(TREE, "test/helpers/custody-rig.mjs"));
const { machineBinding } = await import(path.join(HERE, "../repo/custody/v2/member.mjs"));
const { verifyQuote } = await import(path.join(HERE, "../repo/relay/snp-verify.mjs"));
const { verifyCustodianQuote } = await import(path.join(HERE, "verify-custodian-quote.mjs"));

const MEAS = "7f".repeat(48), sha = (b) => "0x" + createHash("sha256").update(b).digest("hex");
const manifest = { role: "enclave-custodian-v2", measurement: MEAS, measurementSha256: sha(Buffer.from(MEAS, "hex")), commit: "c635fd68" };
const S = synthChain();
function evidence({ measurement = MEAS, machineMeasurement, debug = false } = {}) {
  const machine = { identity: "0x" + randomBytes(20).toString("hex"), encKey: "0x" + randomBytes(32).toString("hex"), endpoint: "https://api.enclave.host/t/custody-release-canary",
                    chipId: "0x" + randomBytes(32).toString("hex"), registryId: "0x" + randomBytes(32).toString("hex"), measurement: machineMeasurement || sha(Buffer.from(measurement, "hex")) };
  const nonce = randomBytes(32).toString("hex");
  const rd = Buffer.concat([Buffer.from(machineBinding(machine, Buffer.from(nonce, "hex"))), Buffer.alloc(32)]);
  const report = resign(S, synthReport(S, { reportData: rd }), { measurement, debug });
  return { nonce, evidence: { machine, report: report.toString("base64"), auxblob: null } };
}
const okVerify = async () => ({ ok: true, reasons: ["stub"] });

test("the wrapper accepts only the RELEASE measurement, a consistent machine record and a non-debug guest", async () => {
  const e = evidence();
  assert.equal((await verifyCustodianQuote({ manifest, ...e, verify: okVerify })).ok, true);
  const wrong = evidence({ measurement: "6f".repeat(48) });
  assert.match((await verifyCustodianQuote({ manifest, ...wrong, verify: okVerify })).reasons.join(), /not the release measurement/);
  const rec = evidence({ machineMeasurement: sha(Buffer.from("00", "hex")) });
  assert.match((await verifyCustodianQuote({ manifest, ...rec, verify: okVerify })).reasons.join(), /machine record/);
  const dbg = evidence({ debug: true });
  assert.match((await verifyCustodianQuote({ manifest, ...dbg, verify: okVerify })).reasons.join(), /DEBUG/);
  assert.match((await verifyCustodianQuote({ manifest: { ...manifest, role: "x" }, ...e, verify: okVerify })).reasons.join(), /release manifest/);
  assert.match((await verifyCustodianQuote({ manifest, evidence: e.evidence, nonce: "zz", verify: okVerify })).reasons.join(), /nonce/);
  const refused = await verifyCustodianQuote({ manifest, ...e, verify: async () => ({ ok: false, reasons: ["VCEK chain"] }) });
  assert.deepEqual([refused.ok, refused.reasons], [false, ["verifyQuote: VCEK chain"]]);
});

test("the REAL verifyQuote (offline) never accepts a synthetic-chain report as AMD hardware", async () => {
  const e = evidence();
  const v = await verifyCustodianQuote({ manifest, ...e, verify: (r, o) => verifyQuote(r, { ...o, kds: false }) });
  assert.equal(v.ok, false);
  assert.ok(v.verifier && v.verifier.ok === false, "refused by the verifier itself");
});
