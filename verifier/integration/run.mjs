#!/usr/bin/env node
// verifier/integration/run.mjs: the STRICT integration command. Resolves the pinned owner revision (resolve.mjs),
// then runs the acceptance suites with ENCLAVE_PVM_MODULE pointing at the resolved entry and
// ENCLAVE_STRICT_INTEGRATION=1, under which an acceptance case that would otherwise skip FAILS. Exit codes:
// 0 all acceptance cases passed; 2 a dependency could not be resolved; 1 a test failed or was skipped;
// 3 NOT ACCEPTED: an OPEN FINDING against the owner's code (verifier/integration/findings.json) still reproduces on the
//   exact pinned revision it was found on. That is not a harness failure and never a pass: the verdict line says so.
//   node verifier/integration/run.mjs [--pin pvm-app-attest] [--dir .verifier-integration] [--no-fetch]
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { classify } from "./verdict.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const pass = process.argv.slice(2).filter((a, i, all) => !(a === "--pin" || all[i - 1] === "--pin"));   // every pin is resolved
const pinsFile = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "pins.json"), "utf8"));
const env = { ...process.env, ENCLAVE_STRICT_INTEGRATION: "1" }; delete env.NODE_TEST_CONTEXT;
for (const [name, pin] of Object.entries(pinsFile)) {
  const r = spawnSync(process.execPath, [path.join(REPO, "verifier", "integration", "resolve.mjs"), "--pin", name, ...pass, "--json"], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) { process.stderr.write(r.stderr || ""); console.error(`integration: dependency ${name} NOT resolved; refusing to run acceptance cases against nothing`); process.exit(2); }
  const manifest = JSON.parse(r.stdout.trim().split("\n").pop());
  // belt and braces: what is on disk must be what the manifest and the pin say, or nothing runs
  const outDir = manifest.dir;
  if (typeof outDir !== "string" || !outDir || manifest.entry !== path.join(outDir, pin.entry) || manifest.commit !== pin.commit) { console.error(`integration: ${name}: the manifest does not match the pin; refusing`); process.exit(2); }
  let onDisk; try { onDisk = JSON.parse(fs.readFileSync(path.join(outDir, "MANIFEST.json"), "utf8")); } catch { console.error(`integration: ${name}: no MANIFEST.json in the materialisation directory; refusing`); process.exit(2); }
  if (onDisk.commit !== pin.commit) { console.error(`integration: ${name}: the materialised commit is not the pinned commit; refusing`); process.exit(2); }
  for (const [rel, want] of Object.entries(pin.files)) {
    let got; try { got = createHash("sha256").update(fs.readFileSync(path.join(outDir, rel))).digest("hex"); } catch { console.error(`integration: ${name}: ${rel} missing from the materialisation; refusing`); process.exit(2); }
    if (got !== want || onDisk.files[rel] !== want) { console.error(`integration: ${name}: ${rel} on disk does not match the pin; refusing`); process.exit(2); }
  }
  if (typeof pin.env !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(pin.env)) { console.error(`integration: ${name}: the pin names no environment variable`); process.exit(2); }
  env[pin.env] = manifest.entry;
  console.log(`integration: ${name} @ ${manifest.commit} (${manifest.branch}) -> ${path.relative(REPO, manifest.entry)} (manifest and hashes re-checked) as ${pin.env}`);
}
// the pinned build artifacts must reproduce byte for byte before any acceptance case runs
const artifacts = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "artifacts.json"), "utf8"));
for (const name of Object.keys(artifacts)) {
  const a = spawnSync(process.execPath, [path.join(REPO, "verifier", "integration", "reproduce.mjs"), "--pin", name], { cwd: REPO, encoding: "utf8" });
  if (a.status !== 0) { process.stderr.write(a.stderr || ""); console.error(`integration: artifact ${name} did NOT reproduce; refusing`); process.exit(2); }
  process.stdout.write(a.stdout.split("\n").filter((l) => /REPRODUCED|== pin/.test(l)).map((l) => `integration: ${l}\n`).join(""));
}
// the browser verifier artifact (verifier/web/dist) must rebuild byte for byte from this tree, with its manifest and notices current
const wa = spawnSync(process.execPath, [path.join(REPO, "verifier", "web", "reproduce.mjs")], { cwd: REPO, encoding: "utf8" });
if (wa.status !== 0) { process.stderr.write(wa.stderr || ""); console.error("integration: the browser verifier artifact did NOT reproduce; refusing"); process.exit(2); }
process.stdout.write(wa.stdout.split("\n").filter((l) => /REPRODUCED/.test(l)).map((l) => `integration: ${l}\n`).join(""));
// the device-run fixtures must be exactly what the owner committed (verifier/integration/fixture-check.mjs)
const fx = spawnSync(process.execPath, [path.join(REPO, "verifier", "integration", "fixture-check.mjs")], { cwd: REPO, encoding: "utf8" });
if (fx.status !== 0) { process.stderr.write(fx.stderr || ""); console.error("integration: a device fixture is NOT what its pin records; refusing"); process.exit(2); }
process.stdout.write(fx.stdout.split("\n").filter(Boolean).map((l) => `integration: ${l}\n`).join(""));
// the reproducible NEXT versions of the real client (verifier/integration/next-build.mjs) must rebuild to their record
const nb = spawnSync(process.execPath, [path.join(REPO, "verifier", "integration", "next-build.mjs")], { cwd: REPO, encoding: "utf8" });
if (nb.status !== 0) { process.stderr.write(nb.stderr || ""); console.error("integration: the next builds did NOT reproduce; refusing"); process.exit(2); }
process.stdout.write(nb.stdout.split("\n").filter((l) => /== record/.test(l)).map((l) => `integration: ${l}\n`).join(""));
env.ENCLAVE_PVM_NEXT_DIR = nb.stdout.trim().split("\n").pop();
const suites = ["test/verifier-fixtures-tracked.test.mjs", "test/verifier-integration-verdict.test.mjs", "test/verifier-envelope.test.mjs", "test/site-verifier-shadow.test.mjs", "test/verifier-linux-canary.test.mjs", "test/verifier-linux-derivation.test.mjs", "test/verifier-linux-hookbin.test.mjs", "test/verifier-hyperv-domain-refused.test.mjs", "test/verifier-pvm-v3.test.mjs", "test/verifier-pvm-instance-device.test.mjs", "test/verifier-pvm-instance-campaign.test.mjs", "test/verifier-pvm-proof-key.test.mjs", "test/verifier-web-package.test.mjs", "test/verifier-web-x509.test.mjs", "test/verifier-web-differential.test.mjs", "test/verifier-web-shadow.test.mjs", "test/verifier-web-browser.test.mjs", "test/verifier-live-differential.test.mjs", "test/verifier-collateral-cache.test.mjs", "test/verifier-snp-genoa.test.mjs", "test/verifier-snp-turin.test.mjs", "test/verifier-fail-closed.test.mjs", "test/verifier-pvm-device.test.mjs", "test/verifier-pvm-evidence.test.mjs", "test/verifier-pvm-abi2.test.mjs", "test/verifier-admission.test.mjs", "test/verifier-sealed-stream.test.mjs", "test/verifier-sealed-traces.test.mjs", "test/verifier-pvm-client-persistence.test.mjs", "test/verifier-pvm-client-update.test.mjs", "test/verifier-pvm-client-supersede.test.mjs", "test/verifier-pvm-policy-deployments.test.mjs", "test/verifier-pvm-client-ext.test.mjs", "test/verifier-pvm-client-activation.test.mjs", "test/verifier-pvm-client-next.test.mjs", "test/verifier-pvm-client-device-activation.test.mjs", "test/verifier-pvm-client-device-activation-2.test.mjs", "test/verifier-pvm-client-device-activation-3.test.mjs", "test/verifier-pvm-stability-50.test.mjs"];
const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=180000", ...suites], { cwd: REPO, encoding: "utf8", env });
const out = t.stdout || "";
console.log(out.split("\n").filter((l) => /^# (tests|pass|fail|cancelled|skipped|todo)/.test(l)).join("  ") || "(no summary in the report)");
// The verdict is verifier/integration/verdict.mjs (tested on real TAP by test/verifier-integration-verdict.test.mjs): every
// not-ok entry at any level counts, the exit status and signal are checked, the report must be complete and consistent,
// and only an OPEN finding recorded against the exact pinned revision (verifier/integration/findings.json; a code pin, or
// "fixture:<name>" for a device-run fixture) can account for an exact case-level failure, giving NOT ACCEPTED (exit 3).
const findings = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "findings.json"), "utf8"));
const fixturesFile = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "fixtures.json"), "utf8"));
const pinCommit = (p) => (p.startsWith("fixture:") ? fixturesFile[p.slice(8)] && fixturesFile[p.slice(8)].commit : pinsFile[p] && pinsFile[p].commit) || null;
const v = classify({ out, status: t.status, signal: t.signal, error: t.error }, { findings, pinCommit });
for (const l of v.lines) console.log(`integration: ${l}`);
if (v.verdict === "FAILED") {
  for (const r of v.reasons) console.log(`integration: FAILED: ${r}`);
  process.stdout.write(out.split("\n").filter((l) => /^\s+error|^\s+\+|^\s+-/.test(l)).slice(0, 60).join("\n") + "\n");
  console.error(`integration: FAILED (${v.reasons.length} reason(s) above)`); process.exit(1);
}
if (v.verdict === "NOT ACCEPTED") { console.error(`integration: NOT ACCEPTED (${v.reasons[0]})`); process.exit(3); }
console.log(`integration: PASS against ${Object.values(pinsFile).map((p) => p.commit.slice(0, 12)).join(", ")}`);
