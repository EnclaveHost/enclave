// The live differential's orchestrator (verifier/live-differential.mjs) in its OFFLINE mode on the authentic fixtures: the
// captured Genoa document and certificate, the release bundles of both flavors, this branch's verifier and the installed
// Tinfoil reference on the same bytes. It is the same code the shadow workflow runs live; only the capture step differs.
//   run: node --test test/verifier-live-differential.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import http from "node:http";
import { createHash } from "node:crypto";

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
  // the provenance leg is the consumers' own (releaseExpectationsFrom), under the built-in floor from verifier/release-policy.json
  assert.equal(r.report.release.source, "files"); assert.equal(r.report.release.repo, "EnclaveHost/enclave"); assert.deepEqual(r.report.release.floor, { floorApplied: "v0.5.841", floorSource: "built-in", builtinFloor: "v0.5.841" });
  assert.deepEqual(r.report.release.candidates.map((c) => c.tag), ["v0.5.841", "v0.5.841-cpu"]);
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
  assert.match(y, /npm ci --ignore-scripts/); assert.match(y, /live-differential\.mjs --host/);
  assert.match(y, /^  positive-control:\n/m, "the control is its own job, so its result never masks the differential's"); assert.match(y, /live-differential\.mjs --release-policy verifier\/differential\/tinfoil-model-router\.json --out positive-control/);
  assert.match(y, /positive-control:\n(?:.*\n)*?\s+if: \$\{\{ vars\.VERIFIER_LIVE_DIFFERENTIAL == 'enabled' \}\}/, "the control is gated by the same variable");
  assert.match(y, /^  provenance-parity:\n\s+if: \$\{\{ vars\.VERIFIER_LIVE_DIFFERENTIAL == 'enabled' \}\}/m, "the parity check is its own job, gated by the same variable");
  assert.match(y, /provenance-parity\.mjs --out provenance-parity --browser \/usr\/bin\/google-chrome/); assert.match(y, /fetch-depth: 0\n\s+filter: blob:none/, "the manifest history is readable");
  assert.equal((y.match(/^ {4}permissions:\n {6}contents: read$/gm) || []).length, 3, "every job reads only"); assert.equal(/contents: write|id-token|pull-requests/.test(y), false); assert.match(y, /host:\n\s+description:[^\n]*\n\s+required: true/, "the host is a required input with no default"); assert.equal(/default: "inference\.tinfoil\.sh"/.test(y), false);
});

// ---- the CONTROL: Tinfoil's own host against Tinfoil's own release provenance (verifier/differential/tinfoil-model-router.json)
const CONTROL = path.join(REPO, "verifier", "differential", "tinfoil-model-router.json");
const TR = path.join(F, "tinfoil-router"), trDigest = (t) => fs.readFileSync(path.join(TR, `${t}.tinfoil.hash`), "utf8").trim();
const runControl = (extra) => { const out = fs.mkdtempSync(path.join(tmp, "ctl-")); const r = spawnSync(process.execPath, [path.join(REPO, "verifier", "live-differential.mjs"), "--from", path.join(F, "genoa-tinfoil"), "--out", out, "--now", "2026-09-24T05:00:00Z", ...extra], { encoding: "utf8", env, timeout: 120000 }); let report = null; try { report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")); } catch {} return { ...r, report }; };
const trFiles = (t) => ["--release-bundle", path.join(TR, `${t}.attestation.json`), "--release-digest", trDigest(t)];

test("the POSITIVE path on real bytes: Tinfoil's 2026-09-24 capture against Tinfoil's release v0.0.154 (the one that measures it) under the control policy: ours VERIFIED with the TCB floor, the reference accepts, the same measurement: agree, exit 0", { skip: !haveRef && "@tinfoilsh/verifier not installed" }, () => {
  const r = runControl(["--release-policy", CONTROL, ...trFiles("v0.0.154")]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.report.verdict, "agree", JSON.stringify(r.report.reasons));
  assert.equal(r.report.ours.status, "verified", r.report.ours.reasons.join("\n")); assert.deepEqual(r.report.ours.omissions, []); assert.equal(r.report.ours.checks.measurement, true); assert.equal(r.report.ours.checks["tcb policy"], true);
  assert.equal(r.report.release.matched, "v0.0.154"); assert.equal(r.report.release.repo, "tinfoilsh/confidential-model-router");
  assert.deepEqual(r.report.release.control, { file: CONTROL, repository: "tinfoilsh/confidential-model-router", minimumRelease: "v0.0.154" });
  assert.deepEqual(r.report.release.floor, { floorApplied: "v0.0.154", floorSource: "caller", builtinFloor: "v0.5.841", callerBelowBuiltin: true }, "the control's floor is explicit and says it is below ours");
  assert.deepEqual(r.report.minTcb, { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } });
  assert.deepEqual({ bytesAgree: r.report.comparison.bytesAgree, sameMeasurement: r.report.comparison.sameMeasurement, inProvenance: r.report.comparison.measurementInProvenance }, { bytesAgree: true, sameMeasurement: true, inProvenance: true });
});

test("the same without a TCB floor: ours LIMITED (tcb-floor-unjudged only), the reference accepts: agree-limited, exit 0 (before this, a host running a matching release without a stated floor scored as a DISAGREEMENT)", { skip: !haveRef && "@tinfoilsh/verifier not installed" }, () => {
  const noTcb = path.join(tmp, "control-no-tcb.json"); const c = JSON.parse(fs.readFileSync(CONTROL, "utf8")); delete c.minTcb; fs.writeFileSync(noTcb, JSON.stringify(c));
  const r = runControl(["--release-policy", noTcb, ...trFiles("v0.0.154")]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.report.verdict, "agree-limited"); assert.equal(r.report.ours.status, "limited"); assert.deepEqual(r.report.ours.omissions, ["tcb-floor-unjudged"]);
  assert.equal(r.report.comparison.oursBytesOk, true); assert.match(r.report.reasons.join(" "), /no TCB floor was stated/);
});

test("the control's refusals: a newer release (v0.0.155) does not measure the 09-24 capture: agree-refuse; Tinfoil's bundle under OUR policy (no control) fails our identity rules: provenance-failed; a control floor above the release: provenance-failed", { skip: !haveRef && "@tinfoilsh/verifier not installed" }, () => {
  const a = runControl(["--release-policy", CONTROL, ...trFiles("v0.0.155")]);
  assert.equal(a.status, 0, a.stdout + a.stderr); assert.equal(a.report.verdict, "agree-refuse"); assert.equal(a.report.comparison.measurementInProvenance, false);
  const b = runControl([...trFiles("v0.0.154")]);
  assert.equal(b.status, 2); assert.equal(b.report.verdict, "provenance-failed"); assert.match(JSON.stringify(b.report.release.candidates), /EnclaveHost\/enclave|repository|source repository/i, "refused on our identity policy, not silently accepted");
  const high = path.join(tmp, "control-high.json"); fs.writeFileSync(high, JSON.stringify({ ...JSON.parse(fs.readFileSync(CONTROL, "utf8")), minimumRelease: "v0.0.200" }));
  const c = runControl(["--release-policy", high, ...trFiles("v0.0.154")]);
  assert.equal(c.status, 2); assert.equal(c.report.verdict, "provenance-failed"); assert.match(JSON.stringify(c.report.release.candidates), /below the minimum release v0\.0\.200/);
  const bad = path.join(tmp, "control-bad.json"); fs.writeFileSync(bad, JSON.stringify({ repository: "tinfoilsh/confidential-model-router", minimumRelease: "latest" }));
  const d = runControl(["--release-policy", bad, ...trFiles("v0.0.154")]); assert.equal(d.status, 2); assert.match(d.stderr, /bare vX\.Y\.Z minimumRelease/);
});

test("the live provenance leg is the production one: for this repository, the SIGNED index first (a local stand-in for GitHub serving the real 2026-09-25 index and bundles), the pinned root, the recorded floor", { skip: !haveRef && "@tinfoilsh/verifier not installed" }, async () => {
  const M = JSON.parse(fs.readFileSync(path.join(F, "release-index", "mirror-2026-09-25.json"), "utf8"));
  const idx = Buffer.from(M.indexBytes, "base64"), idxSha = createHash("sha256").update(idx).digest("hex");
  const srv = http.createServer((req, res) => {
    const u = req.url.split("?")[0]; const send = (c, b, t = "application/json") => { res.writeHead(c, { "content-type": t }); res.end(b); };
    if (u === "/EnclaveHost/enclave/releases/latest/download/release-index.json") return send(200, idx, "application/octet-stream");
    let m = /^\/EnclaveHost\/enclave\/releases\/download\/([^/]+)\/tinfoil\.hash$/.exec(u);
    if (m) { const r = M.releases.find((x) => x.tag === m[1]); return r ? send(200, r.digest + "\n", "text/plain") : send(404, "Not Found", "text/plain"); }
    m = /^\/repos\/EnclaveHost\/enclave\/attestations\/sha256:([0-9a-f]{64})$/.exec(u);
    if (m) { if (m[1] === idxSha) return send(200, JSON.stringify({ attestations: [{ bundle: M.attestation.bundle }] })); const r = M.releases.find((x) => x.digest === m[1]); return r ? send(200, JSON.stringify({ attestations: [{ bundle: r.attestation.bundle }] })) : send(404, "{}"); }
    send(404, "Not Found", "text/plain");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const out = fs.mkdtempSync(path.join(tmp, "idx-"));
    const r = await new Promise((resolve) => { const ch = spawn(process.execPath, [path.join(REPO, "verifier", "live-differential.mjs"), "--from", path.join(F, "genoa-tinfoil"), "--out", out, "--now", "2026-09-24T05:00:00Z", "--api-base", base, "--download-base", base], { env }); let o = ""; ch.stdout.on("data", (d) => (o += d)); ch.stderr.on("data", (d) => (o += d)); ch.on("close", (code) => resolve({ status: code, out: o })); });
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
    assert.equal(r.status, 0, r.out); assert.equal(report.verdict, "agree-refuse", "Tinfoil's host is not one of our releases");
    assert.equal(report.release.source, "signed index"); assert.equal(report.release.index.status, "verified"); assert.equal(report.release.index.publication.runId, 36089632273);
    assert.deepEqual(report.release.floor, { floorApplied: "v0.5.841", floorSource: "signed index", builtinFloor: "v0.5.841" });
    assert.deepEqual(report.release.candidates.map((c) => [c.tag, c.provenance]), [["v0.5.848", "verified"], ["v0.5.848-cpu", "verified"]]);
  } finally { srv.close(); }
});
