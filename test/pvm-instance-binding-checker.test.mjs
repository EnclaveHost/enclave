// The instance-binding device checker (shielded/anchor/avf/runtime/conformance/check-instance-binding.py) held to COVERAGE:
// on a copy of the committed capture (results/pvm-cpu-instance-binding), each mutation below removes, truncates, duplicates,
// misassigns or re-labels one piece of evidence, and the checker must FAIL at the check that covers it -- not merely print a
// smaller green count. The unmutated copy is the control and must PASS. (The Codex audit of 7e88dc76 found the previous
// checker passing with every v3 envelope deleted; the first case below is that repro.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const RUN = path.join(ROOT, "shielded/anchor/avf/results/pvm-cpu-instance-binding");
const CHECK = path.join(ROOT, "shielded/anchor/avf/runtime/conformance/check-instance-binding.py");
const haveRun = fs.existsSync(path.join(RUN, "exchanges.jsonl"));
const ev = (dir, n, ext = "json") => path.join(dir, "evidence", `evidence-${String(n).padStart(3, "0")}.${ext}`);
const rows = (dir) => fs.readFileSync(path.join(dir, "exchanges.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const writeRows = (dir, r) => fs.writeFileSync(path.join(dir, "exchanges.jsonl"), r.map((x) => JSON.stringify(x)).join("\n") + "\n");
const exOf = (dir, label) => rows(dir).find((r) => r.label === label).exchanges[0];
const enroll = (dir, f) => { const p = path.join(dir, "enroll-a.json"); const e = JSON.parse(fs.readFileSync(p, "utf8")); fs.writeFileSync(p, JSON.stringify(f(e))); };

function check(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-check-"));
  try {
    fs.cpSync(RUN, dir, { recursive: true });
    if (mutate) mutate(dir);
    const r = spawnSync("python3", [CHECK, dir], { encoding: "utf8", timeout: 120000 });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const V3_CALLS = ["enroll-a", "bound-a", "other-a", "bound-b", "bound-c"];
const CASES = [
  ["the audit's repro: every v3 envelope deleted (only the v2 one left)", (d) => { for (const l of V3_CALLS) for (const x of ["json", "request", "meta.json"]) fs.rmSync(ev(d, exOf(d, l), x)); },
   /FAIL coverage: the recorded exchanges are exactly the calls' exchanges/],
  ["one v3 envelope deleted (the restart turn's)", (d) => fs.rmSync(ev(d, exOf(d, "bound-b"))), /FAIL coverage: the recorded exchanges are exactly|FAIL bound-b: its envelope re-verifies/],
  ["one envelope truncated (bound-a's, cut in half)", (d) => { const p = ev(d, exOf(d, "bound-a")); fs.writeFileSync(p, fs.readFileSync(p, "utf8").slice(0, 2000)); },
   /FAIL bound-a: its envelope re-verifies as v3/],
  ["an extra exchange no call made (bound-a's duplicated as 007)", (d) => { for (const x of ["json", "request", "meta.json"]) fs.copyFileSync(ev(d, exOf(d, "bound-a"), x), ev(d, 7, x)); },
   /FAIL coverage: the recorded exchanges are exactly the calls' exchanges/],
  ["one exchange claimed by two calls (bound-b pointing at bound-a's)", (d) => { const r = rows(d); r.find((x) => x.label === "bound-b").exchanges = [exOf(d, "bound-a")]; writeRows(d, r); },
   /FAIL coverage: no exchange is claimed by two calls/],
  ["a call recorded twice", (d) => { const r = rows(d); r.push(r.find((x) => x.label === "bound-a")); writeRows(d, r); }, /FAIL coverage: bound-a is recorded once/],
  ["misassigned envelopes: bound-a's and bound-b's swapped", (d) => { const a = ev(d, exOf(d, "bound-a")), b = ev(d, exOf(d, "bound-b")), t = fs.readFileSync(a); fs.copyFileSync(b, a); fs.writeFileSync(b, t); },
   /FAIL bound-a: its envelope re-verifies as v3 over its own nonce/],
  ["misassigned phase: the restart turn's call window moved into phase A", (d) => { const r = rows(d), a = r.find((x) => x.label === "bound-a"), b = r.find((x) => x.label === "bound-b");
     b.utcStart = a.utcStart; b.utcEnd = a.utcEnd; writeRows(d, r); }, /FAIL phase: bound-b ran inside phase B/],
  ["a v3 request re-labelled as v2 (the request line)", (d) => { const p = ev(d, exOf(d, "bound-a"), "request"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("EVIDENCE3 ", "EVIDENCE ")); },
   /FAIL bound-a: exchange \d+ is an EVIDENCE3 request/],
  ["the enrollment record names another instance (its field edited)", (d) => enroll(d, (e) => ({ ...e, instanceId: "ab".repeat(32) })),
   /FAIL enrollment: the record's own envelope re-verifies over the record's nonce and proves the InstanceID it names/],
  ["the enrollment record carries another call's envelope", (d) => enroll(d, (e) => ({ ...e, envelope: JSON.parse(fs.readFileSync(ev(d, exOf(d, "bound-b")), "utf8")) })),
   /FAIL enrollment: the record's own envelope re-verifies|FAIL enrollment: the record's envelope is the very envelope/],
  ["the enrollment record without its envelope", (d) => enroll(d, (e) => { const { envelope, ...rest } = e; return rest; }), /FAIL enrollment: the record's own envelope/],
  ["the per-call capture missing", (d) => fs.rmSync(path.join(d, "exchanges.jsonl")), /FAIL coverage: enroll-a is recorded once/],
];

test("control: the committed device capture, unmutated, PASSES", { skip: !haveRun && "no capture" }, () => {
  const r = check(null);
  assert.equal(r.code, 0, r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  assert.match(r.out, /PASS instance binding on the device/);
});
for (const [name, mutate, want] of CASES) {
  test(`coverage: ${name} -> FAIL at the check that covers it`, { skip: !haveRun && "no capture" }, () => {
    const r = check(mutate);
    assert.equal(r.code, 1, `the checker PASSED a capture with ${name}`);
    assert.match(r.out, want, r.out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  });
}
