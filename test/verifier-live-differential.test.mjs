// The live differential's orchestrator (verifier/live-differential.mjs) in its OFFLINE mode on the authentic fixtures: the
// captured Genoa document and certificate, the release bundles of both flavors, this branch's verifier and the installed
// Tinfoil reference on the same bytes. It is the same code the shadow workflow runs live; only the capture step differs.
//   run: node --test test/verifier-live-differential.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";

const REPO = new URL("..", import.meta.url).pathname, F = path.join(REPO, "test", "fixtures", "verifier");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-diff-")); test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const digest = (n) => fs.readFileSync(path.join(F, "release", n), "utf8").trim();
const BUNDLES = [path.join(F, "release", "v0.5.841.attestation.json"), path.join(F, "release", "v0.5.841-cpu.attestation.json")].join(","), DIGESTS = [digest("v0.5.841.tinfoil.hash"), digest("v0.5.841-cpu.tinfoil.hash")].join(",");
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const run = (capDir, extra = []) => { const out = fs.mkdtempSync(path.join(tmp, "out-")); const r = spawnSync(process.execPath, [path.join(REPO, "verifier", "live-differential.mjs"), "--from", capDir, "--release-bundle", BUNDLES, "--release-digest", DIGESTS, "--out", out, "--now", "2026-09-24T05:00:00Z", ...extra], { encoding: "utf8", env }); let report = null; try { report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")); } catch {} return { ...r, report }; };
const haveRef = fs.existsSync(path.join(REPO, "node_modules", "@tinfoilsh", "verifier", "package.json"));

test("offline on the authentic Genoa capture (Tinfoil's own host, not one of our releases): both accept the bytes, the measurement is not one our verified provenance vouches for, so both refuse under the same policy: agree-refuse, exit 0, with the comparison stating exactly that", { skip: !haveRef && "@tinfoilsh/verifier not installed" }, () => {
  const r = run(path.join(F, "genoa-tinfoil"));
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.report.verdict, "agree-refuse");
  assert.equal(r.report.ours.status, "rejected"); assert.deepEqual(r.report.comparison.oursFailedChecks, ["measurement"], "ours refuses on the measurement policy alone");
  assert.equal(r.report.reference.attestationOk, true); assert.equal(r.report.reference.certificateOk, true); assert.equal(r.report.reference.measurement, r.report.ours.measurement);
  assert.deepEqual({ bytesAgree: r.report.comparison.bytesAgree, sameMeasurement: r.report.comparison.sameMeasurement, inProvenance: r.report.comparison.measurementInProvenance }, { bytesAgree: true, sameMeasurement: true, inProvenance: false });
  assert.equal(r.report.release.matched, null); assert.equal(r.report.release.candidates.filter((c) => c.provenance === "verified").length, 2, "both flavors' provenance verified; neither measures this host's image");
  assert.match(r.report.reasons.join(" "), /not one a verified release vouches for/); assert.equal(r.report.mode, "offline");
});
test("a mutated document (one byte of the signature) is refused by both: agree-refuse, exit 0; the report keeps both refusals", { skip: !haveRef && "@tinfoilsh/verifier not installed" }, () => {
  const cap = path.join(tmp, "mutated"); fs.mkdirSync(cap, { recursive: true });
  for (const n of ["tinfoil-certificate.json", "tls-cert.pem", "vcek-kds-amd.der"]) fs.copyFileSync(path.join(F, "genoa-tinfoil", n), path.join(cap, n));
  const rad = JSON.parse(fs.readFileSync(path.join(F, "genoa-tinfoil", "rad.json"), "utf8")); const body = gunzipSync(Buffer.from(rad.body, "base64")); body[0x2a0] ^= 0x01;
  fs.writeFileSync(path.join(cap, "rad.json"), JSON.stringify({ ...rad, body: gzipSync(body).toString("base64") }));
  const r = run(cap);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.report.verdict, "agree-refuse"); assert.equal(r.report.ours.status, "rejected"); assert.equal(r.report.reference.attestationOk, false); assert.equal(r.report.comparison.bytesAgree, true); assert.equal(r.report.comparison.oursBytesOk, false, "the bytes themselves are refused, not only the policy");
});
test("without the reference the differential has not run: reference-missing, exit 1, never a silent pass; a report is still written", () => {
  const r = run(path.join(F, "genoa-tinfoil"), ["--no-reference"]);
  assert.equal(r.status, 1); assert.equal(r.report.verdict, "reference-missing"); assert.equal(r.report.reference.skipped, true);
});
test("no verified provenance means no expected measurement: provenance-failed, exit 2, nothing verified", () => {
  const out = fs.mkdtempSync(path.join(tmp, "out-")); const r = spawnSync(process.execPath, [path.join(REPO, "verifier", "live-differential.mjs"), "--from", path.join(F, "genoa-tinfoil"), "--release-bundle", BUNDLES, "--release-digest", ["0".repeat(64), "1".repeat(64)].join(","), "--out", out, "--now", "2026-09-24T05:00:00Z"], { encoding: "utf8", env });
  assert.equal(r.status, 2, r.stdout + r.stderr); const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")); assert.equal(report.verdict, "provenance-failed"); assert.equal(report.ours, null); assert.match(report.reasons.join(" "), /no release's provenance verified/);
});
test("the shadow workflow runs on dispatch or the daily schedule, gated by the repository variable and a named host, read-only and pinned", () => {
  const y = fs.readFileSync(path.join(REPO, ".github", "workflows", "verifier-live-differential.yml"), "utf8");
  assert.match(y, /^\s+schedule:\n\s+- cron: "17 6 \* \* \*"/m, "scheduled daily (2026-09-25), gated by the same variable and a host variable"); assert.equal(/^\s+push:/m.test(y), false); assert.equal(/^\s+pull_request:/m.test(y), false);
  assert.match(y, /if: \$\{\{ vars\.VERIFIER_LIVE_DIFFERENTIAL == 'enabled' && \(inputs\.host != '' \|\| vars\.VERIFIER_LIVE_HOST != ''\) \}\}/, "the job runs only when enabled AND a host is named");
  assert.match(y, /--host "\$\{\{ inputs\.host \|\| vars\.VERIFIER_LIVE_HOST \}\}"/, "the dispatch input wins; the schedule takes the variable");
  assert.match(y, /workflow_dispatch:/); assert.match(y, /vars\.VERIFIER_LIVE_DIFFERENTIAL == 'enabled'/); assert.match(y, /permissions:\n  contents: read/);
  assert.equal(/secrets\./.test(y), false, "no secret"); for (const m of y.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)) assert.ok(m[2], m[1]); assert.equal((y.match(/uses: /g) || []).length, (y.match(/uses: [^@\s]+@[0-9a-f]{40}/g) || []).length, "every action pinned by commit");
  assert.match(y, /npm ci --ignore-scripts/); assert.match(y, /live-differential\.mjs --host/); assert.match(y, /host:\n\s+description:[^\n]*\n\s+required: true/, "the host is a required input with no default"); assert.equal(/default: "inference\.tinfoil\.sh"/.test(y), false);
});
