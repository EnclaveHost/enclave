// Every file under test/fixtures/verifier must be TRACKED by git. The repository's ignore rules (*.pem for private keys,
// *.log) silently kept seventeen fixture files out of the commits that added them (public served certificates and the pVM
// owner's run logs), so every local run passed on files a clean clone never had, and main's CI failed on them the day the
// branch landed (2026-09-24). This guard fails on any fixture file that exists here but is not in the index, and the
// strict command runs it. Adding such a file needs `git add -f` and a look at why the rule matched.
//   run: node --test test/verifier-fixtures-tracked.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), DIR = "test/fixtures/verifier";
const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test("every file under test/fixtures/verifier is tracked by git (a clean clone has it), whatever the ignore rules say", () => {
  const present = walk(DIR).sort();
  const tracked = new Set(execFileSync("git", ["ls-files", "--", DIR], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean));
  const untracked = present.filter((f) => !tracked.has(f));
  assert.deepEqual(untracked, [], `fixture files not in the index (git add -f them): ${untracked.join(", ")}`);
  const ignored = execFileSync("git", ["status", "--ignored", "--porcelain", "--", DIR], { cwd: REPO, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("!!")).map((l) => l.slice(3));
  assert.deepEqual(ignored.filter((f) => !f.endsWith("/")), [], "no ignored file under the fixtures");
  assert.ok(present.length > 700, `${present.length} fixture files`);
  for (const f of ["test/fixtures/verifier/genoa-tinfoil/tls-cert.pem", "test/fixtures/verifier/linux-canary-2026-09-24/served-cert.pem", "test/fixtures/verifier/pvm-stability-50/run.log"]) assert.ok(tracked.has(f), `${f} is tracked`);
});
