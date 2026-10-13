// Runner-level checks of the strict command's verdict (verifier/integration/verdict.mjs, the function run.mjs calls), on
// REAL TAP produced by node --test on small synthetic test files: a clean complete run passes; a failing case, a hanging
// case (cancelled), a file that exits the process mid-test, a file that fails to load, a file-level timeout (a not-ok
// entry named like a file), a skip and a todo each FAIL closed; a signal death, a non-zero exit with a clean report, a
// zero exit with a failing report, a truncated report and a count/name mismatch each FAIL; an open finding recorded
// against the exact pinned revision accounts for its exact case-level failure only (NOT ACCEPTED, exit 3), never for a
// file or path, and not on another revision or when closed. No test failure can disappear by name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classify, parseTap } from "../verifier/integration/verdict.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, src) => { fs.writeFileSync(path.join(tmp, name), src); return name; };
const FILES = {
  ok: write("ok.test.mjs", 'import test from "node:test"; test("a passes", () => {}); test("b passes", () => {});\n'),
  failcase: write("failcase.test.mjs", 'import test from "node:test"; import assert from "node:assert/strict"; test("c passes", () => {}); test("d fails", () => { assert.equal(1, 2, "one is not two"); });\n'),
  hang: write("hang.test.mjs", 'import test from "node:test"; test("e passes", () => {}); test("f hangs", () => new Promise(() => {}));\n'),
  crash: write("crash.test.mjs", 'import test from "node:test"; test("g passes", () => {}); test("h exits the process", () => { process.exit(2); });\n'),
  loadfail: write("loadfail.test.mjs", 'throw new Error("boom at load");\n'),
  filehang: write("filehang.test.mjs", 'import test from "node:test"; test("k passes", () => {}); await new Promise(() => {});\n'),
  skip: write("skip.test.mjs", 'import test from "node:test"; test("i skipped", { skip: "reason" }, () => {});\n'),
  todo: write("todo.test.mjs", 'import test from "node:test"; test("j todo", { todo: "later" }, () => { throw new Error("x"); });\n'),
};
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const run = (...files) => { const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=1500", ...files], { cwd: tmp, encoding: "utf8", env }); return { out: r.stdout, status: r.status, signal: r.signal, error: r.error }; };
const noFindings = { findings: {}, pinCommit: () => null };
const PIN = "a".repeat(40);
const finding = (name, { status = "open", knownOn = PIN } = {}) => ({ findings: { F: { status, pin: "some-pin", knownOn, cases: [name] } }, pinCommit: (p) => (p === "some-pin" ? PIN : null) });
const reasonsOf = (v) => v.reasons.join(" | ");

test("a clean, complete run with exit 0 is PASS; its report parses to entries and counts that agree", () => {
  const r = run(FILES.ok); assert.equal(r.status, 0);
  const tap = parseTap(r.out); assert.equal(tap.complete, true); assert.equal(tap.entries.length, 2); assert.equal(tap.counts.pass, 2);
  const v = classify(r, noFindings); assert.equal(v.verdict, "PASS", reasonsOf(v)); assert.equal(v.exit, 0); assert.deepEqual(v.reasons, []);
});
test("a failing case with no finding is FAILED and named; with an open finding on the exact pinned revision it is NOT ACCEPTED (exit 3); closed or on another revision it is FAILED", () => {
  const r = run(FILES.ok, FILES.failcase); assert.equal(r.status, 1);
  let v = classify(r, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /unaccounted failing entry \(testCodeFailure\): d fails/);
  v = classify(r, finding("d fails")); assert.equal(v.verdict, "NOT ACCEPTED", reasonsOf(v)); assert.equal(v.exit, 3); assert.deepEqual(v.accounted, [{ name: "d fails", finding: "F" }]);
  v = classify(r, finding("d fails", { status: "closed" })); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /unaccounted failing entry/);
  v = classify(r, finding("d fails", { knownOn: "b".repeat(40) })); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /unaccounted/); assert.match(v.lines.join(" | "), /no longer pinned/);
  v = classify(r, finding("some other case")); assert.equal(v.verdict, "FAILED", "a finding naming another case accounts for nothing"); assert.match(reasonsOf(v), /d fails/);
});
test("a hanging case is cancelled by the timeout: FAILED even though the report says fail 0", () => {
  const r = run(FILES.ok, FILES.hang); assert.equal(r.status, 1); assert.equal(parseTap(r.out).counts.fail, 0); assert.equal(parseTap(r.out).counts.cancelled, 1);
  const v = classify(r, finding("f hangs")); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /cancelled or timed out \(cancelledByParent\): f hangs/);
});
test("a file that exits the process mid-test and a file that fails to load are file-named not-ok entries: FAILED, and a finding may never account for a path", () => {
  for (const f of [FILES.crash, FILES.loadfail]) {
    const r = run(FILES.ok, f); assert.equal(r.status, 1);
    let v = classify(r, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), new RegExp(`unaccounted failing entry \\(testCodeFailure\\): ${f.replace(".", "\\.")}`));
    v = classify(r, finding(f)); assert.equal(v.verdict, "FAILED", "a finding naming the file path is refused and the entry stays unaccounted"); assert.match(reasonsOf(v), /names a file or path as a case/);
    v = classify(r, finding("some other case", { status: "closed" })); assert.equal(v.verdict, "FAILED");
  }
});
test("a file-level timeout (the reported gap): a not-ok entry named like a test file with fail 1 is FAILED whatever the findings say, closed or open", () => {
  const r = run(FILES.ok, FILES.filehang); assert.equal(r.status, 1);
  const tap = parseTap(r.out); const fileEntry = tap.entries.find((e) => !e.ok); assert.ok(fileEntry, "a not-ok entry"); assert.match(fileEntry.name, /filehang\.test\.mjs$/);
  let v = classify(r, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /filehang\.test\.mjs/);
  v = classify(r, { findings: { X: { status: "closed", pin: "p", knownOn: PIN, cases: ["anything"] } }, pinCommit: () => PIN }); assert.equal(v.verdict, "FAILED");
  v = classify(r, finding(fileEntry.name)); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /names a file or path/);
});
test("a skip and a todo are each FAILED and named, even with exit 0", () => {
  let r = run(FILES.ok, FILES.skip); assert.equal(r.status, 0); let v = classify(r, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /skipped entry .*: i skipped/);
  r = run(FILES.ok, FILES.todo); assert.equal(r.status, 0); v = classify(r, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /todo entry .*: j todo/);
});
test("a signal death, a non-zero exit with a clean report, and a zero exit with a failing report are each FAILED", () => {
  const clean = run(FILES.ok), failing = run(FILES.ok, FILES.failcase);
  let v = classify({ ...clean, status: null, signal: "SIGKILL" }, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /terminated by signal SIGKILL/);
  v = classify({ ...clean, status: 1 }, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /exited 1 with no failing entry/);
  v = classify({ ...failing, status: 0 }, finding("d fails")); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /exited 0 although its report lists failing entries/);
  v = classify({ out: "", status: 0, error: new Error("spawn ENOENT") }, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /could not be started/);
});
test("a truncated report (no summary, or no plan) and a count/name mismatch are each FAILED", () => {
  const clean = run(FILES.ok);
  const cut = clean.out.slice(0, clean.out.indexOf("1..")); let v = classify({ ...clean, out: cut }, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /malformed or truncated report/);
  const noPlan = clean.out.replace(/^1\.\.\d+\n/m, ""); v = classify({ ...clean, out: noPlan }, noFindings); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /no plan line/);
  const failing = run(FILES.ok, FILES.failcase);
  const lied = failing.out.replace(/^# fail 1$/m, "# fail 0").replace(/^# pass 3$/m, "# pass 4"); v = classify({ ...failing, out: lied }, finding("d fails")); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /count mismatch/);
  const renamed = failing.out.replace("not ok 2 - d fails", "not ok 2 - d passes really"); v = classify({ ...failing, out: renamed }, finding("d fails")); assert.equal(v.verdict, "FAILED", "a renamed failing entry is not the finding's case");
  const dropped = failing.out.replace(/# Subtest: d fails\nnot ok 2 - d fails\n(?:  .*\n)+/, ""); v = classify({ ...failing, out: dropped }, finding("d fails")); assert.equal(v.verdict, "FAILED"); assert.match(reasonsOf(v), /entries|count mismatch|plan/);
});
test("an open finding whose case passes on its recorded revision is NOT ACCEPTED (a wrong record), never PASS", () => {
  const clean = run(FILES.ok); const v = classify(clean, finding("a passes")); assert.equal(v.verdict, "NOT ACCEPTED"); assert.equal(v.exit, 3); assert.match(v.lines.join(" | "), /cases pass there: correct or close the entry/);
});
test("the strict runner calls this classifier and nothing else decides the verdict", () => {
  const src = fs.readFileSync(new URL("../verifier/integration/run.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ classify \} from "\.\/verdict\.mjs"/); assert.match(src, /classify\(\{ out, status: t\.status, signal: t\.signal, error: t\.error \}/);
  assert.equal(/filter\(\(n\) => !\/\^test\\\//.test(src), false, "no filtering of entries by file-like name remains"); assert.equal(src.includes('process.exit(0)'), false);
  assert.ok(src.includes('if (v.verdict === "FAILED")') && src.includes('if (v.verdict === "NOT ACCEPTED")'));
});
