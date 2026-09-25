// Steven's direction of 2026-09-25 (relayed by enclave-d1): the custom type-1 isolation path is the ONLY NucBox target; the
// ee-engine VBS-enclave backend is not restored; no legacy enclave report may stand in for a custom-VM report. This verifier's
// side of that, on REAL bytes: the boot-64 VBS-enclave evidence from nucbox-k11 (test/fixtures/vbs/boot64-evidence.json, the
// relay's own vbs-verify fixture) is never "verified", under its own format, under the Hyper-V partition format, under the
// proposed node attach format, or under any candidate name for the paravisor's VM report, in the Node and the browser builds;
// and no registered Windows format can be green. The paravisor report has NO format here until real report bytes verify
// under the same boot's IDKS (docs/security/nucbox-custom-vm-verifier.md).
//   run: node --test test/verifier-nucbox-legacy-refused.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyEvidence } from "../verifier/index.mjs";
import { verifyEvidenceWeb } from "../verifier/web/index.mjs";
import { FORMATS, TECH } from "../verifier/envelope.mjs";

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/vbs/boot64-evidence.json", import.meta.url), "utf8"));
const REPORT = Buffer.from(FIX.body.report, "base64");          // the enclave's VBS_ENCLAVE_REPORT package, real bytes
const BODY = Buffer.from(JSON.stringify(FIX.body)).toString("base64");
const WINDOWS = new Set([TECH.VBS, TECH.HYPERV, TECH.WINHOST]);
const never = async (doc, label) => {
  const n = await verifyEvidence(doc), w = await verifyEvidenceWeb(doc);
  for (const [who, v] of [["node", n], ["web", w]]) {
    assert.notEqual(v.status, "verified", `${label} (${who}) must never verify`); assert.notEqual(v.status, "limited", `${label} (${who})`);
    assert.equal(v.admissionSafe, false, `${label} (${who})`); assert.ok(["unsupported", "rejected"].includes(v.status), `${label} (${who}): ${v.status}`);
  }
  return { n, w };
};

test("the real boot-64 legacy VBS-enclave evidence under its own format: the document as the agent builds it (windows/node/agent.mjs: the whole evidence, boot log included, in `body`) is refused over the body cap; a well-formed report-only body is unsupported, the reason saying the backend is RETIRED and never stands in for a custom-VM report", async () => {
  assert.ok(REPORT.length > 500, "the real enclave report package");
  const full = await never({ format: "windows-vbs-enclave/v1", body: BODY }, "windows-vbs-enclave/v1 (as built)");
  assert.equal(full.n.status, "rejected"); assert.match(full.n.reasons.join(" "), /exceeds the 65536-char cap/);
  const reportOnly = Buffer.from(JSON.stringify({ report: FIX.body.report })).toString("base64");
  const { n, w } = await never({ format: "windows-vbs-enclave/v1", body: reportOnly }, "windows-vbs-enclave/v1 (report only)");
  assert.equal(n.status, "unsupported"); assert.equal(n.technology, TECH.VBS);
  assert.match(n.reasons.join(" "), /RETIRED/); assert.match(n.reasons.join(" "), /never stands in for a custom-VM report/); assert.match(n.reasons.join(" "), /VBS/);
  assert.equal(w.status, "unsupported");
});

test("the same enclave report presented as a Hyper-V partition document, as the proposed node attach format, and under candidate names for the paravisor's VM report: never verified; the unregistered names are unknown formats", async () => {
  const asPartition = { format: "hyperv-partition-domain/v1", tier: "T0-hv", nonce: FIX.capture.reportData.padEnd(64, "0").slice(0, 64), report: REPORT.toString("base64") };
  const p = await never(asPartition, "hyperv-partition-domain/v1"); assert.equal(p.n.status, "unsupported"); assert.equal(p.n.technology, TECH.HYPERV);
  const node = await never({ format: "windows-hv-node/v1", body: BODY }, "windows-hv-node/v1");
  assert.equal(node.n.status, "unsupported"); assert.equal(node.n.technology, TECH.WINHOST); assert.match(node.n.reasons.join(" "), /host-attested boot state.*no TEE claim.*host is not excluded/);
  for (const name of ["hyperv-vbs-vm/v1", "windows-hv-vm/v1", "openhcl-vbs-vm-report/v1", "enclave-hv-app-evidence/v1", "windows-vbs-vm-report/v1"]) {
    const r = await never({ format: name, body: BODY, report: REPORT.toString("base64") }, name);
    assert.equal(r.n.status, "unsupported"); assert.match(r.n.reasons.join(" "), /unknown evidence format/, `${name} is not registered: nothing is known about what it proves`);
  }
});

test("no registered Windows format can be green: every one is unsupported or delegated-and-refused here, and the node attach format declares the host NOT excluded", () => {
  const windows = Object.entries(FORMATS).filter(([, s]) => WINDOWS.has(s.technology));
  assert.deepEqual(windows.map(([k]) => k).sort(), ["hyperv-partition-domain/v1", "windows-hv-node/v1", "windows-vbs-enclave/v1"], "a new Windows format must be added here deliberately, with its evidence");
  for (const [k, s] of windows) assert.notEqual(s.supported, true, `${k} must not be supported: true without the contract's evidence (docs/security/nucbox-custom-vm-verifier.md)`);
  assert.equal(FORMATS["windows-hv-node/v1"].hostExcluded, false); assert.equal(FORMATS["hyperv-partition-domain/v1"].hostExcluded, false);
});
