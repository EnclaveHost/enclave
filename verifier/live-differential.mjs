#!/usr/bin/env node
// verifier/live-differential.mjs: the LIVE differential, as glue over what already exists: capture a hosted enclave's
// attestation and collateral (cli.mjs capture: bounded fetches), take the expected measurement ONLY from verified release
// provenance (verifier/provenance.mjs on the release's Sigstore bundle, never from the enclave or a proxy), verify the
// document with this branch's verifier, run the Tinfoil reference (@tinfoilsh/verifier) on the same bytes, and compare.
// Read-only: nothing is written outside --out; no credential is used; every network fetch has a timeout and a size cap.
//   live:    node verifier/live-differential.mjs --host inference.tinfoil.sh --out DIR [--repo EnclaveHost/enclave] [--now iso]
//   offline: node verifier/live-differential.mjs --from DIR --release-bundle F[,F...] --release-digest HEX[,HEX...] --out DIR
//            [--chain F] [--crl F] [--trusted-root F] [--no-reference] [--now iso]
//   control: node verifier/live-differential.mjs --host inference.tinfoil.sh --release-policy verifier/differential/tinfoil-model-router.json --out DIR
// The expected measurements come from the PRODUCTION provenance path (verifier/consumer.mjs): for this repository the
// signed release index first, under the pinned Sigstore root (verifier/roots/sigstore-trusted-root.json) and the built-in
// release policy (verifier/release-policy.json), the unsigned pointer only as the recorded fallback; explicit bundle files
// go through the same releaseExpectationsFrom. --release-policy names a CONTROL: another repository's releases, verified
// under our identity rules with that file's repository, floor and TCB floor stated explicitly (recorded as the caller's
// floor), so the positive path runs on live hardware even while no host runs one of our releases.
// Exit 0 when the two verifiers agree (both verified with the same measurement, "agree"; the same with only our TCB floor
// unstated, "agree-limited"; or both refuse, "agree-refuse"); 1 on a disagreement or a missing reference (a differential
// that cannot compare has not run); 2 when the capture or the provenance step fails.
// The report (DIR/report.json) carries every reason. The reference's own provenance leg (its GitHub proxy) is not run:
// the comparison is on the attestation bytes, the collateral and the served certificate.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { verifyEvidence, spkiOfCert, memoryCollateral, parseReportStrict } from "./index.mjs";
import { releaseExpectations, releaseExpectationsFrom, TRUSTED_ROOT, DEFAULT_REPO } from "./consumer.mjs";
import { parseTag, floorOf, floorRecord } from "./release-policy.mjs";
import { snpProductHint } from "../relay/snp-verify.mjs";

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes("--" + n);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const die = (m, code = 2) => { console.error(`live-differential: ${m}`); process.exit(code); };
const out = opt("out") || die("--out DIR required");
fs.mkdirSync(out, { recursive: true });
const now = opt("now") || new Date().toISOString();
const MAX_FETCH = 4 * 1024 * 1024, TIMEOUT = Number(opt("timeout", "20000"));
async function get(url, accept = "application/json") {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept, "user-agent": "enclave-verifier-live-differential" }, redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer()); if (b.length > MAX_FETCH) throw new Error(`${url}: ${b.length} bytes exceeds the ${MAX_FETCH}-byte cap`); return b;
}
const report = { at: now, mode: opt("from") ? "offline" : "live", host: opt("host") || null, capture: {}, release: { candidates: [], matched: null }, ours: null, reference: null, verdict: null, reasons: [] };
const finish = (verdict, code) => { report.verdict = verdict; fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify({ verdict, host: report.host, matched: report.release.matched, ours: report.ours?.status, reference: report.reference?.attestationOk ?? null }, null, 0)); process.exit(code); };

// 0. a control (another repository's releases, explicit policy): read first, it may name the host
let control = null;
if (opt("release-policy")) {
  control = JSON.parse(fs.readFileSync(opt("release-policy"), "utf8"));
  const floor = parseTag(control.minimumRelease);
  if (!control.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(control.repository) || !floor || floor.flavor !== "gpu") die("--release-policy: a JSON file with repository OWNER/NAME and a bare vX.Y.Z minimumRelease");
  control = { ...control, floor: floor.version };
}

// 1. the capture: live through cli.mjs capture, or a directory laid out the same way (the fixtures)
let cap = opt("from");
if (!cap) {
  const host = opt("host") || control?.host || die("--host or --from required (or a --release-policy naming a host)"); report.host = host;
  cap = path.join(out, "capture");
  const r = spawnSync(process.execPath, [path.join(REPO, "verifier", "cli.mjs"), "capture", "--host", host, "--out", cap], { encoding: "utf8", timeout: 6 * TIMEOUT });
  if (r.status !== 0) { report.reasons.push(`capture failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`); finish("capture-failed", 2); }
  report.capture.log = r.stdout.trim();
}
const rd = (n) => fs.readFileSync(path.join(cap, n));
const rad = JSON.parse(rd("rad.json").toString());
let certPem = null; try { certPem = fs.readFileSync(path.join(cap, "tls-cert.pem"), "utf8"); } catch { try { certPem = JSON.parse(rd("tinfoil-certificate.json").toString()).certificate; } catch {} }
if (!certPem) { report.reasons.push("no served certificate captured: the hosted binding cannot be checked"); finish("capture-failed", 2); }
let body = Buffer.from(rad.body, "base64"); if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body, { maxOutputLength: 64 * 1024 });
const p = parseReportStrict(body), product = snpProductHint(p) || die("no product line from the report");
const vcek = rd("vcek-kds-amd.der");
const chainPem = opt("chain") ? fs.readFileSync(opt("chain"), "utf8") : fs.readFileSync(fs.existsSync(path.join(cap, `${product}-cert_chain.pem`)) ? path.join(cap, `${product}-cert_chain.pem`) : path.join(REPO, "test", "fixtures", "amd", `${product}-cert_chain.pem`), "utf8");
const crlDer = opt("crl") ? fs.readFileSync(opt("crl")) : fs.readFileSync(fs.existsSync(path.join(cap, `${product}-crl.der`)) ? path.join(cap, `${product}-crl.der`) : path.join(REPO, "test", "fixtures", "verifier", "amd", `${product}-crl.der`));
report.capture = { ...report.capture, dir: cap, product, reportVersion: p.version, measurement: Buffer.from(p.measurement).toString("hex") };

// 2. the expected measurement, from verified release provenance only, through the consumers' own code
const trustedRoot = opt("trusted-root") ? JSON.parse(fs.readFileSync(opt("trusted-root"), "utf8")) : TRUSTED_ROOT;
const repo = control?.repository ?? opt("repo", DEFAULT_REPO);
const policy = control ? { minimumRelease: control.floor } : {};
let exp;
try {
  if (opt("release-bundle") || opt("release-digest")) {
    const bundles = (opt("release-bundle") || die("--release-bundle and --release-digest go together")).split(","), digests = (opt("release-digest") || die("--release-bundle and --release-digest go together")).split(",");
    if (bundles.length !== digests.length) die("--release-bundle and --release-digest must pair up");
    const candidates = bundles.map((f, i) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); return { tag: path.basename(f).replace(/\.attestation\.json$/, ""), bundle: j.attestations ? j.attestations[0]?.bundle : j, digest: digests[i].trim().toLowerCase() }; });
    exp = { ...(await releaseExpectationsFrom(candidates, { repo, trustedRoot, policy })), index: { status: "not-consulted", source: "files" } };
  } else {
    exp = await releaseExpectations({ repo, trustedRoot, policy, useIndex: repo === DEFAULT_REPO && !flag("no-index"), timeoutMs: TIMEOUT,
                                      ...(opt("api-base") ? { apiBase: opt("api-base") } : {}), ...(opt("download-base") ? { downloadBase: opt("download-base") } : {}) });
  }
} catch (e) { report.reasons.push(`release provenance: ${e.message}`); finish("provenance-failed", 2); }
report.release = { repo, source: exp.index?.source === "files" ? "files" : exp.index?.status === "verified" ? "signed index" : "unsigned pointer (recorded fallback)",
                   control: control ? { file: opt("release-policy"), repository: control.repository, minimumRelease: control.minimumRelease } : null,
                   index: exp.index, latestTag: exp.latestTag ?? null, candidates: exp.candidates, matched: null,
                   // the floor the provenance leg applied: the consumer's record when it ran the index path, else the same rule
                   floor: exp.index?.floorApplied ? { floorApplied: exp.index.floorApplied, floorSource: exp.index.floorSource, builtinFloor: exp.index.builtinFloor, ...(exp.index.callerBelowBuiltin ? { callerBelowBuiltin: true } : {}) } : floorRecord(floorOf({ caller: policy.minimumRelease ?? null })) };
const allowed = exp.allowed.map((a) => ({ tag: a.tag, measurement: a.measurement }));
if (!allowed.length) { report.reasons.push("no release's provenance verified: there is no expected measurement, so nothing can be verified (fail closed)"); finish("provenance-failed", 2); }

// 3. ours, against the measurements provenance vouched for
const { spki } = spkiOfCert(certPem);
const minTcb = JSON.parse(opt("min-tcb") || "null") || control?.minTcb || undefined;
report.minTcb = minTcb ?? null;
const ours = await verifyEvidence(rad, { policy: { snp: { allowedMeasurements: allowed.map((a) => a.measurement), minTcb } },
  context: { transportKeySpki: spki, certPem, host: report.host || opt("host") || "inference.tinfoil.sh", now }, collateral: memoryCollateral({ chains: { [product]: chainPem }, vceks: { [product]: vcek }, crls: { [product]: crlDer } }) });
report.ours = { status: ours.status, admissionSafe: ours.admissionSafe, omissions: ours.omissions, checks: ours.checks, measurement: ours.claims?.measurement ?? null, reasons: ours.reasons };
report.release.matched = allowed.find((a) => a.measurement === ours.claims?.measurement)?.tag ?? null;

// 4. the reference, on the same bytes
if (flag("no-reference")) report.reference = { skipped: true };
else {
  let mod = null; try { mod = await import("@tinfoilsh/verifier"); } catch {}
  if (!mod) report.reference = { installed: false };
  else {
    const ref = { installed: true, library: "@tinfoilsh/verifier" };
    try { ref.attestation = await mod.verifyAttestation({ format: rad.format, body: rad.body }, vcek.toString("base64")); ref.attestationOk = true; const m = ref.attestation.measurement; ref.measurement = typeof m === "string" ? m : Array.isArray(m?.registers) ? m.registers[0] ?? null : null; }   // the reference reports { type, registers[] }
    catch (e) { ref.attestationOk = false; ref.attestationError = e.message; }
    if (ref.attestationOk) { try { ref.certificate = await mod.verifyCertificate(certPem, report.host || opt("host") || "inference.tinfoil.sh", { format: rad.format, body: rad.body }, ref.attestation.hpkePublicKey); ref.certificateOk = true; } catch (e) { ref.certificateOk = false; ref.certificateError = e.message; } }
    report.reference = ref;
  }
}

// 5. the comparison, like with like: the reference checks the bytes (report, chain, certificate binding) and reports a
// measurement but applies no measurement policy; the same provenance-derived policy is applied to its measurement here,
// so "agree" means both accept the bytes AND the measurement is one a verified release vouches for. The report says
// separately whether the two agree on the bytes and whether the measurement is one of ours: a host running someone
// else's image (Tinfoil's own, for instance) is a policy refusal both sides share, not a disagreement about the bytes.
const R = report.reference;
if (!R || R.skipped || R.installed === false) finish("reference-missing", 1);
const theirsBytes = R.attestationOk === true && R.certificateOk === true;
const inProvenance = (m) => !!m && allowed.some((a) => a.measurement === m);
const theirsAccepts = theirsBytes && inProvenance(R.measurement);
const failed = Object.entries(ours.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
// "limited" is every check passing with an omission recorded (tcb-floor-unjudged when no TCB floor is stated): the bytes are
// accepted, and the verdict is agree-limited when that is the ONLY omission; any other omission stays a disagreement
const oursLimitedOnlyTcb = ours.status === "limited" && failed.length === 0 && (ours.omissions || []).length === 1 && ours.omissions[0] === "tcb-floor-unjudged";
const oursBytes = ours.status === "verified" || oursLimitedOnlyTcb || (ours.status === "rejected" && failed.length === 1 && failed[0] === "measurement");
report.comparison = { bytesAgree: oursBytes === theirsBytes, oursBytesOk: oursBytes, referenceBytesOk: theirsBytes, sameMeasurement: !!R.measurement && R.measurement === report.ours.measurement, measurementInProvenance: inProvenance(report.ours.measurement), oursFailedChecks: failed };
if (ours.status === "verified" && theirsAccepts && R.measurement === report.ours.measurement) finish("agree", 0);
if (oursLimitedOnlyTcb && theirsAccepts && R.measurement === report.ours.measurement) { report.reasons.push("both accept the bytes and the measurement; ours is limited only because no TCB floor was stated (--min-tcb)"); finish("agree-limited", 0); }
if (ours.status !== "verified" && ours.status !== "limited" && !theirsAccepts && report.comparison.bytesAgree) { report.reasons.push(oursBytes ? `both accept the bytes; the measurement ${report.ours.measurement?.slice(0, 16)}... is not one a verified release vouches for (${allowed.map((a) => a.tag).join(", ")}): a policy refusal on both sides` : "both refuse the bytes"); finish("agree-refuse", 0); }
report.reasons.push(`disagreement: ours ${ours.status} (${report.ours.measurement?.slice(0, 16) ?? "-"}; failed ${failed.join(",") || "none"}), reference bytes ${theirsBytes ? "ok" : "refused"} (${R.measurement?.slice(0, 16) ?? R.attestationError ?? R.certificateError ?? "-"})`);
finish("disagree", 1);
