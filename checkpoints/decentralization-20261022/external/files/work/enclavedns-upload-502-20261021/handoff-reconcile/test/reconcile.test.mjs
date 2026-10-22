// Fixture tests for reconcile-upload.mjs. The REAL handoff directory is only READ (pins, plan, frozen artifact); the
// journals, the r3 receipts and the output directory are temp copies; systemctl / systemd-run are a fake. Nothing runs
// against the live unit, the network, a wallet or a chain.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as R from "../reconcile-upload.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const { DNS } = await import(path.join(R.HANDOFF, "trust.mjs"));
const { frozenWasm } = await import(path.resolve(R.HANDOFF, "../../site-host-live-publish/handoff/site-upload.mjs"));
const { bytes, dag } = frozenWasm(DNS);

function fixture({ upload = { status: "ready", lastError: "upload: HTTP 502", plan: R.PLAN_SHA }, result = {}, extra = {}, unknown = false } = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-")), jdir = path.join(t, "journals"), r3 = path.join(t, "r3"), out = path.join(t, "out");
  for (const d of [jdir, r3, out]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(jdir, "upload.json"), JSON.stringify(upload, null, 2) + "\n");
  fs.writeFileSync(path.join(jdir, "session.json"), JSON.stringify({ status: "started", plan: R.PLAN_SHA }) + "\n");
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(jdir, k), v);
  const at = "2026-10-21T20:00:00.000Z";
  fs.writeFileSync(path.join(r3, "direct-r3-attempt.json"), JSON.stringify({ at, artifact: DNS.wasm.sha256, cid: DNS.expectedCid, bytes: bytes.length }));
  fs.writeFileSync(path.join(r3, "direct-r3-upload-accepted.json"), JSON.stringify({ cid: DNS.expectedCid, at: "2026-10-21T20:00:30.000Z", httpStatus: 200 }));
  const res = { status: "verified", cid: DNS.expectedCid, artifactSha256: DNS.wasm.sha256, bytes: bytes.length, carSha256: "ab".repeat(32), blocks: dag.blocks.length,
    verifiedAt: "2026-10-21T20:01:00.000Z", source: DNS.upload.carUrl(DNS.expectedCid), uploadOrigin: "https://7ae476a3.app.enclave.host",
    humanWalletUsed: false, chainTransactions: 0, ...result };
  fs.writeFileSync(path.join(r3, "direct-r3-result.json"), JSON.stringify(res, null, 2));
  if (unknown) fs.writeFileSync(path.join(r3, "direct-r3-unknown.json"), "{}");
  return { t, jdir, r3, out, resultSha: sha(fs.readFileSync(path.join(r3, "direct-r3-result.json"))) };
}
// the fake systemd: a loaded, active, reviewed unit; stop -> inactive; systemd-run (exact args) -> active again
function fakeSystemd({ argv = R.ARGV, wd = R.HANDOFF, active = true, onStop = () => {} } = {}) {
  const s = { active, argv, wd, calls: [] };
  const run = (cmd, a) => {
    s.calls.push([cmd, ...a].join(" "));
    if (cmd === "systemctl" && a[1] === "show") return [`LoadState=${s.active ? "loaded" : "not-found"}`, `ActiveState=${s.active ? "active" : "inactive"}`,
      `WorkingDirectory=${s.wd}`, "MemoryMax=268435456", "MainPID=4242", `ExecStart={ path=${s.argv[0]} ; argv[]=${s.argv.join(" ")} ; ignore_errors=no }`].join("\n") + "\n";
    if (cmd === "systemctl" && a[1] === "stop") { onStop(); s.active = false; return ""; }
    if (cmd === "systemd-run") { assert.deepEqual(a, ["--user", "--unit=enclavedns-release-handoff-v2", "-p", "MemoryMax=268435456", `--working-directory=${R.HANDOFF}`, ...R.ARGV]); s.active = true; s.argv = R.ARGV; return ""; }
    throw new Error("unexpected command " + cmd);
  };
  return { s, run };
}
const go = (argv, f, sd) => R.main(argv, { r3: f.r3, jdir: f.jdir, out: f.out, run: sd.run, sleep: async () => {} });

test("check: every gate holds on the reviewed pins, the r3 proof and a ready journal; nothing is changed", async () => {
  const f = fixture(), sd = fakeSystemd(), before = fs.readFileSync(path.join(f.jdir, "upload.json"));
  const { exit, report } = await go([], f, sd);
  assert.equal(exit, 0, JSON.stringify(report)); assert.equal(report.result, "check passed: nothing changed");
  assert.deepEqual(report.artifact, { sha256: DNS.wasm.sha256, cid: DNS.expectedCid, bytes: bytes.length, blocks: dag.blocks.length });
  assert.ok(Number.isInteger(report.artifact.blocks) && report.artifact.blocks > 1, "the frozen DAG's block count is a real number");
  assert.ok(fs.readFileSync(path.join(f.jdir, "upload.json")).equals(before));
  assert.ok(sd.s.calls.every((c) => c.startsWith("systemctl --user show")), "check only reads the unit");
});

test("proof refusals: unknown outcome, not verified, other CID/artifact, partial DAG, human wallet, transactions, unreviewed bytes", async () => {
  for (const [opts, why] of [[{ unknown: true }, /unknown/], [{ result: { status: "failed" } }, /status/], [{ result: { cid: "bafyother" } }, /cid/],
    [{ result: { artifactSha256: "00".repeat(32) } }, /artifactSha256/], [{ result: { blocks: dag.blocks.length - 1 } }, /blocks/],
    [{ result: { humanWalletUsed: true } }, /humanWalletUsed/], [{ result: { chainTransactions: 1 } }, /chainTransactions/],
    [{ result: { verifiedAt: "2026-10-21T19:00:00.000Z" } }, /verifiedAt/]]) {
    const f = fixture(opts), { exit, report } = await go([], f, fakeSystemd());
    assert.equal(exit, 1, JSON.stringify(report)); assert.match(report.why, why);
  }
  const f = fixture(), { exit, report } = await go(["--execute", "--result-sha", "00".repeat(32)], f, fakeSystemd());
  assert.equal(exit, 1); assert.match(report.why, /reviewed bytes/);
});

test("journal refusals: already uploaded / uploading, a publish or upgrade journal, another plan", async () => {
  for (const [opts, why] of [[{ upload: { status: "uploaded", plan: R.PLAN_SHA } }, /uploaded, not/], [{ upload: { status: "uploading", plan: R.PLAN_SHA } }, /uploading/],
    [{ extra: { "publish.json": "{}" } }, /publish.json exists/], [{ extra: { "upgrade.json": "{}" } }, /upgrade.json exists/],
    [{ upload: { status: "ready", plan: "11".repeat(32) } }, /another plan/]]) {
    const f = fixture(opts), { exit, report } = await go([], f, fakeSystemd());
    assert.equal(exit, 1, JSON.stringify(report)); assert.match(report.why, why);
  }
});

test("unit refusals: not active, another command or directory", async () => {
  for (const sd of [fakeSystemd({ active: false }), fakeSystemd({ argv: [...R.ARGV.slice(0, -1)] }), fakeSystemd({ wd: "/tmp" })]) {
    const { exit, report } = await go([], fixture(), sd);
    assert.equal(exit, 1, JSON.stringify(report)); assert.match(report.why, /enclavedns-release-handoff-v2/);
  }
});

test("execute: stop, CAS, backup, the server's uploaded shape + provenance, the SAME unit recreated; a second run refuses", async () => {
  const f = fixture(), sd = fakeSystemd(), old = fs.readFileSync(path.join(f.jdir, "upload.json"));
  const { exit, report } = await go(["--execute", "--result-sha", f.resultSha], f, sd);
  assert.equal(exit, 0, JSON.stringify(report));
  const j = JSON.parse(fs.readFileSync(path.join(f.jdir, "upload.json"), "utf8"));
  assert.deepEqual(Object.keys(j), ["status", "cid", "carSha256", "blocks", "verifiedAt", "expiry", "provenance", "plan"]);
  assert.equal(j.status, "uploaded"); assert.equal(j.cid, DNS.expectedCid); assert.equal(j.blocks, dag.blocks.length); assert.equal(j.plan, R.PLAN_SHA);
  assert.equal(j.expiry, null); assert.equal(j.provenance.humanWalletUsed, false); assert.equal(j.provenance.chainTransactions, 0);
  assert.equal(j.provenance.resultSha256, f.resultSha);
  assert.equal((fs.statSync(path.join(f.jdir, "upload.json")).mode & 0o777), 0o600);
  assert.ok(fs.readFileSync(report.written.backup).equals(old), "the backup is the old journal");
  const order = sd.s.calls.map((c) => c.split(" ").slice(0, 3).join(" "));
  assert.ok(order.indexOf("systemctl --user stop") < order.indexOf("systemd-run --user --unit=enclavedns-release-handoff-v2"));
  assert.equal(sd.s.calls.filter((c) => c.startsWith("systemctl --user stop")).length, 1, "exactly one stop, of exactly this unit");
  assert.ok(sd.s.calls.filter((c) => c.includes(" stop ")).every((c) => c.endsWith(R.UNIT)));
  const again = await go(["--execute", "--result-sha", f.resultSha], f, fakeSystemd());
  assert.equal(again.exit, 1); assert.match(again.report.why, /uploaded, not/);
});

test("execute CAS: the journal changes while the unit stops -> nothing written, the unit is recreated on the old journal", async () => {
  const f = fixture(), up = path.join(f.jdir, "upload.json");
  const sd = fakeSystemd({ onStop: () => fs.writeFileSync(up, JSON.stringify({ status: "awaiting-signature", message: "m", expiry: 1, plan: R.PLAN_SHA })) });
  const { exit, report } = await go(["--execute", "--result-sha", f.resultSha], f, sd);
  assert.equal(exit, 1, JSON.stringify(report)); assert.match(report.why, /CAS/);
  assert.equal(JSON.parse(fs.readFileSync(up, "utf8")).status, "awaiting-signature", "not overwritten");
  assert.ok(sd.s.calls.some((c) => c.startsWith("systemd-run")) && sd.s.active, "the handoff is back");
});

test("rollback: CAS on the written bytes, the backup restored, the same unit recreated", async () => {
  const f = fixture(), sd = fakeSystemd();
  const { report } = await go(["--execute", "--result-sha", f.resultSha], f, sd);
  const rb = await go(["--rollback", "--written-sha", report.written.uploadSha256, "--backup", report.written.backup], f, sd);
  assert.equal(rb.exit, 0, JSON.stringify(rb.report));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.jdir, "upload.json"), "utf8")).status, "ready");
  const wrong = await go(["--rollback", "--written-sha", "00".repeat(32), "--backup", report.written.backup], f, sd);
  assert.equal(wrong.exit, 1); assert.match(wrong.report.why, /CAS/);
});

test("the REAL handoff server (in memory, fake journals) loads the written record: upload done, next step publish", async () => {
  const { createPublisherServer } = await import(path.join(R.HANDOFF, "server.mjs"));
  const { buildHandoffPlan } = await import(path.join(R.HANDOFF, "handoff-plan.mjs"));
  const { plan, sha256 } = buildHandoffPlan(DNS);
  assert.equal(sha256, R.PLAN_SHA, "the rebuilt plan is the approved plan");
  const f = fixture(), proof = R.checkProof({ r3: f.r3, DNS, dag, bytes });
  const mem = { session: { status: "started", plan: R.PLAN_SHA }, upload: R.uploadedRecord(proof) };
  const journals = Object.fromEntries(["session", "upload", "publish", "upgrade"].map((k) => [k, { read: () => mem[k] || { status: "ready" }, write: (v) => { mem[k] = v; } }]));
  const app = createPublisherServer({ t: DNS, plan, planSha256: sha256, journals, start: async () => ({}), prepare: async () => ({}), verify: async () => ({}),
    release: async () => ({}), uploadMessage: () => ({}), runUpload: async () => { throw new Error("never"); } });
  const v = app.view();
  assert.equal(v.upload.status, "uploaded"); assert.equal(v.upload.cid, DNS.expectedCid); assert.equal(v.next, "publish");
});
