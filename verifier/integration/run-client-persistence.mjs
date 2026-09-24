#!/usr/bin/env node
// verifier/integration/run-client-persistence.mjs: resolve the pinned BUILT installed client and run the black-box
// persistence suite against it, strictly (a missing client fails, a skipped case fails). Kept apart from run.mjs because
// this suite asserts the behaviour the owner's fix must have: against a revision with the gap it FAILS by design, and the
// output is the reproduction. Exit 0 when every case passes, 1 when a case fails (the gap is present), 2 when the client
// could not be resolved.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const pins = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "pins.json"), "utf8"));
const pin = pins["pvm-client-dist"];
const r = spawnSync(process.execPath, [path.join(REPO, "verifier", "integration", "resolve.mjs"), "--pin", "pvm-client-dist", ...process.argv.slice(2), "--json"], { cwd: REPO, encoding: "utf8" });
if (r.status !== 0) { process.stderr.write(r.stderr || ""); console.error("client-persistence: the built client was NOT resolved; nothing to test"); process.exit(2); }
const manifest = JSON.parse(r.stdout.trim().split("\n").pop());
console.log(`client-persistence: ${pin.entry} @ ${manifest.commit} (${pin.note.split(";")[0]})`);
const env = { ...process.env, [pin.env]: manifest.entry, ENCLAVE_STRICT_INTEGRATION: "1" }; delete env.NODE_TEST_CONTEXT;
const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=120000", "test/verifier-pvm-client-persistence.test.mjs"], { cwd: REPO, encoding: "utf8", env });
const lines = (t.stdout || "").split("\n");
console.log(lines.filter((l) => /^# (tests|pass|fail|skipped)/.test(l)).join("  "));
const failed = lines.filter((l) => /^not ok/.test(l));
// each failing case with its assertion, so the reproduction reads without a rerun
const blocks = (t.stdout || "").split(/^(?=(?:not ok|ok) \d+ - )/m).filter((b) => b.startsWith("not ok"));
for (const b of blocks) { const head = b.split("\n")[0]; const err = /error: \|-\n((?:    .*\n)+)/.exec(b); const msg = err ? err[1].split("\n").map((l) => l.trim()).filter((l) => l && !/^(\+ actual|- expected|\.\.\.)/.test(l)).join(" ").slice(0, 300) : ""; console.log(`  ${head}\n      -> ${msg}`); }
if (t.status !== 0 || failed.length) { console.error(`client-persistence: ${failed.length} case(s) FAILED against ${manifest.commit.slice(0, 12)}: the persistence gap is present in this revision (or the fix does not meet the rule)`); process.exit(1); }
if (/^# skipped [1-9]/m.test(t.stdout || "")) { console.error("client-persistence: a case was skipped under strict mode; a skip is a failure here"); process.exit(1); }
console.log(`client-persistence: PASS against ${manifest.commit.slice(0, 12)}`);
