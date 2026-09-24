#!/usr/bin/env node
// verifier/integration/run.mjs: the STRICT integration command. Resolves the pinned owner revision (resolve.mjs),
// then runs the acceptance suites with ENCLAVE_PVM_MODULE pointing at the resolved entry and
// ENCLAVE_STRICT_INTEGRATION=1, under which an acceptance case that would otherwise skip FAILS. Exit codes:
// 0 all acceptance cases passed; 2 the dependency could not be resolved; 1 a test failed or was skipped.
//   node verifier/integration/run.mjs [--pin pvm-app-attest] [--dir .verifier-integration] [--no-fetch]
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  if (typeof pin.env !== "string" || !/^[A-Z_]+$/.test(pin.env)) { console.error(`integration: ${name}: the pin names no environment variable`); process.exit(2); }
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
const suites = ["test/verifier-pvm-device.test.mjs", "test/verifier-pvm-evidence.test.mjs", "test/verifier-pvm-abi2.test.mjs", "test/verifier-admission.test.mjs", "test/verifier-sealed-stream.test.mjs", "test/verifier-sealed-traces.test.mjs", "test/verifier-pvm-client-persistence.test.mjs"];
const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=120000", ...suites], { cwd: REPO, encoding: "utf8", env });
const tail = (t.stdout || "").split("\n").filter((l) => /^# (tests|pass|fail|skipped)/.test(l)).join("  ");
const failed = /^# fail (\d+)/m.exec(t.stdout || ""), skipped = /^# skipped (\d+)/m.exec(t.stdout || "");
console.log(tail);
if (t.status !== 0 || !failed || Number(failed[1]) > 0) { process.stdout.write((t.stdout || "").split("\n").filter((l) => /^not ok|^\s+error|^\s+\+|^\s+-/.test(l)).join("\n") + "\n"); console.error("integration: FAILED"); process.exit(1); }
if (skipped && Number(skipped[1]) > 0) { console.error(`integration: ${skipped[1]} acceptance case(s) SKIPPED under strict mode; a skip is a failure here`); process.exit(1); }
console.log(`integration: PASS against ${Object.values(pinsFile).map((p) => p.commit.slice(0, 12)).join(", ")}`);
