#!/usr/bin/env node
// verifier/integration/run.mjs: the STRICT integration command. Resolves the pinned owner revision (resolve.mjs),
// then runs the acceptance suites with ENCLAVE_PVM_MODULE pointing at the resolved entry and
// ENCLAVE_STRICT_INTEGRATION=1, under which an acceptance case that would otherwise skip FAILS. Exit codes:
// 0 all acceptance cases passed; 2 the dependency could not be resolved; 1 a test failed or was skipped.
//   node verifier/integration/run.mjs [--pin pvm-app-attest] [--dir .verifier-integration] [--no-fetch]
import path from "node:path";
import { spawnSync } from "node:child_process";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const pass = process.argv.slice(2);
const r = spawnSync(process.execPath, [path.join(REPO, "verifier", "integration", "resolve.mjs"), ...pass, "--json"], { cwd: REPO, encoding: "utf8" });
if (r.status !== 0) { process.stderr.write(r.stderr || ""); console.error("integration: dependency NOT resolved; refusing to run acceptance cases against nothing"); process.exit(2); }
const manifest = JSON.parse(r.stdout.trim().split("\n").pop());
console.log(`integration: ${manifest.pin} @ ${manifest.commit} (${manifest.branch}) -> ${path.relative(REPO, manifest.entry)}`);
const suites = ["test/verifier-pvm-device.test.mjs", "test/verifier-pvm-evidence.test.mjs", "test/verifier-pvm-abi2.test.mjs", "test/verifier-admission.test.mjs"];
const env = { ...process.env, ENCLAVE_PVM_MODULE: manifest.entry, ENCLAVE_STRICT_INTEGRATION: "1" }; delete env.NODE_TEST_CONTEXT;   // TAP, even when spawned from a test
const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=120000", ...suites], { cwd: REPO, encoding: "utf8", env });
const tail = (t.stdout || "").split("\n").filter((l) => /^# (tests|pass|fail|skipped)/.test(l)).join("  ");
const failed = /^# fail (\d+)/m.exec(t.stdout || ""), skipped = /^# skipped (\d+)/m.exec(t.stdout || "");
console.log(tail);
if (t.status !== 0 || !failed || Number(failed[1]) > 0) { process.stdout.write((t.stdout || "").split("\n").filter((l) => /^not ok|^\s+error|^\s+\+|^\s+-/.test(l)).join("\n") + "\n"); console.error("integration: FAILED"); process.exit(1); }
if (skipped && Number(skipped[1]) > 0) { console.error(`integration: ${skipped[1]} acceptance case(s) SKIPPED under strict mode; a skip is a failure here`); process.exit(1); }
console.log(`integration: PASS against ${manifest.commit.slice(0, 12)}`);
