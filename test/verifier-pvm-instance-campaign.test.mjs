// The completeness review (test/helpers/pvm-instance-campaign.mjs) of the pinned instance-binding campaign, and its
// differential against the thirteen mutations Codex's audit and the owner's fixed checker use: each applied to a COPY of
// the capture must be refused with a named reason, never with a smaller count; the unmutated copy must pass. This is the
// verifier's own answer to the audit's finding that a checker scoring all() over whatever remains on disk accepts an
// incomplete capture.
//   run: node --test test/verifier-pvm-instance-campaign.test.mjs   (strict: ENCLAVE_PVM_MODULE resolved by the runner)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewInstanceCampaign } from "./helpers/pvm-instance-campaign.mjs";
import { loadOwnerModule } from "../verifier/pvm-evidence.mjs";

const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const owner = await loadOwnerModule();
if (STRICT && !owner) throw new Error("strict integration: the owner's module is not resolved");
const skip = !owner && "owner module absent";
const F = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "verifier", "pvm-instance-device");
const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-campaign-")); fs.cpSync(F, d, { recursive: true }); return d; };
const rows = (d) => fs.readFileSync(path.join(d, "exchanges.jsonl"), "utf8").split("\n").filter(Boolean);
const writeRows = (d, ls) => fs.writeFileSync(path.join(d, "exchanges.jsonl"), ls.join("\n") + "\n");
const ev = (d, n, ext = "json") => path.join(d, "evidence", `evidence-${n}.${ext}`);

test("the pinned capture passes the completeness review with every check positively established", { skip }, async () => {
  const r = await reviewInstanceCampaign(F);
  assert.deepEqual(r.problems, []); assert.equal(r.ok, true);
  assert.ok(r.checks >= 25, `${r.checks} checks`); assert.deepEqual(r.facts.calls, ["enroll-a", "bound-a", "other-a", "unbound-a", "bound-b", "bound-c"]); assert.deepEqual(r.facts.phases, ["a", "b", "c"]);
  assert.equal(r.facts.instanceId, r.facts.logged.a); assert.equal(r.facts.logged.b, r.facts.logged.a); assert.equal(r.facts.logged.c, r.facts.logged.a);
});

const MUTATIONS = [
  ["the audit's reproduction: every v3 envelope deleted", (d) => { for (const n of ["001", "002", "003", "005", "006"]) for (const x of ["json", "request", "meta.json"]) fs.rmSync(ev(d, n, x)); }, /owned by .* but missing from disk/],
  ["one envelope deleted", (d) => { fs.rmSync(ev(d, "005")); }, /exchange 005 is owned by bound-b but missing from disk/],
  ["one envelope truncated", (d) => { const p = ev(d, "003"), s = fs.readFileSync(p, "utf8"); fs.writeFileSync(p, s.slice(0, s.length >> 1)); }, /call other-a: exchange 003 envelope unreadable/],
  ["an extra duplicated exchange 007", (d) => { for (const x of ["json", "request", "meta.json"]) fs.copyFileSync(ev(d, "002", x), ev(d, "007", x)); }, /exchange 007 is on disk but owned by no call/],
  ["two calls claiming one exchange", (d) => { writeRows(d, rows(d).map((l) => { const r = JSON.parse(l); if (r.label === "bound-b") r.exchanges = [2]; return JSON.stringify(r); })); }, /exchange 002 owned by two calls/],
  ["a call row duplicated", (d) => { const ls = rows(d); writeRows(d, [...ls, ls[1]]); }, /call row duplicated: bound-a/],
  ["bound-a's and bound-b's envelopes swapped", (d) => { const a = fs.readFileSync(ev(d, "002")), b = fs.readFileSync(ev(d, "005")); fs.writeFileSync(ev(d, "002"), b); fs.writeFileSync(ev(d, "005"), a); }, /call bound-a: re-verification of exchange 002 over its request nonce/],
  ["bound-b's window moved into phase A", (d) => { writeRows(d, rows(d).map((l) => { const r = JSON.parse(l); if (r.label === "bound-b") { r.utcStart = "2026-09-24T20:04:55.000Z"; r.utcEnd = "2026-09-24T20:04:59.000Z"; } return JSON.stringify(r); })); }, /call bound-b: exchange 005 was sent at .* outside the call's window|call bound-b: its window .* is outside phase B/],
  ["a v3 request relabelled EVIDENCE", (d) => { const p = ev(d, "002", "request"); fs.writeFileSync(p, fs.readFileSync(p, "latin1").replace("EVIDENCE3 ", "EVIDENCE "), "latin1"); }, /call bound-a: exchange 002 request kind is EVIDENCE, the call's is EVIDENCE3/],
  ["the enrollment record with an edited instanceId", (d) => { const p = path.join(d, "enroll-a.json"), j = JSON.parse(fs.readFileSync(p, "utf8")); j.instanceId = "00" + j.instanceId.slice(2); fs.writeFileSync(p, JSON.stringify(j, null, 1)); }, /enrollment record: instanceId is not SHA-256 of its instanceKey/],
  ["the enrollment record with another call's envelope", (d) => { const p = path.join(d, "enroll-a.json"), j = JSON.parse(fs.readFileSync(p, "utf8")); j.envelope = JSON.parse(fs.readFileSync(ev(d, "002"), "utf8").trim()); fs.writeFileSync(p, JSON.stringify(j, null, 1)); }, /enrollment record: its envelope is not byte-equal .* to the carrier's envelope for enroll-a/],
  ["the enrollment record with no envelope", (d) => { const p = path.join(d, "enroll-a.json"), j = JSON.parse(fs.readFileSync(p, "utf8")); delete j.envelope; fs.writeFileSync(p, JSON.stringify(j, null, 1)); }, /enrollment record has no envelope/],
  ["exchanges.jsonl missing", (d) => { fs.rmSync(path.join(d, "exchanges.jsonl")); }, /exchanges.jsonl missing/],
];

test("each of the thirteen mutations of a copy is refused with its named reason, and the unmutated copy passes", { skip }, async () => {
  const clean = copy(); const base = await reviewInstanceCampaign(clean); assert.equal(base.ok, true, base.problems.join(" | ")); fs.rmSync(clean, { recursive: true, force: true });
  for (const [name, mutate, want] of MUTATIONS) {
    const d = copy();
    try {
      mutate(d);
      const r = await reviewInstanceCampaign(d);
      assert.equal(r.ok, false, `${name}: must be refused`);
      assert.ok(r.problems.some((p) => want.test(p)), `${name}: expected a problem matching ${want}, got: ${r.problems.join(" | ")}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});
