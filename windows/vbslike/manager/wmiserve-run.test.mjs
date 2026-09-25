// wmiserve-run.mjs against a protocol-exact fake wmiserve (testdata/fake-wmiserve.mjs, which hashes the real bundle
// file). Every refusal the strict reader makes is driven here, and each test fails if its check is removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWmiserve, writeBundle } from "./wmiserve-run.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testdata/fake-wmiserve.mjs");
const VM = "3f1c0f6e-7a2b-4c3d-8e9f-0a1b2c3d4e5f";
const IGVM = "7c".repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmiserve-run-"));
const bundle = Buffer.from("enclave-catalog-bundle/1 test bytes");
const appId = crypto.createHash("sha256").update(bundle).digest("hex");
const bundleFile = writeBundle({ dir, instanceId: "inst-1", bundle, appId });
// every run spawns the fake under node, in the mode named, recording its argv
const spawnAs = (mode, argsFile = null, closedFile = null) => (exe, args, opts) =>
  nodeSpawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...process.env, FAKE_WMISERVE: mode, ...(argsFile ? { FAKE_WMISERVE_ARGS: argsFile } : {}),
                                                             ...(closedFile ? { FAKE_WMISERVE_CLOSED: closedFile } : {}) } });
// A refusal expected: the error, or - if the run was wrongly ACCEPTED - the run stopped (so the test process can exit)
// and an assertion failure. A removed check then fails here instead of hanging on a live child.
async function refusedBy(p) {
  const r = await p.then(async (ok) => { await ok.stop(); return null; }, (e) => e);
  assert.ok(r instanceof Error, "the run was accepted where it must be refused");
  return r;
}
const run = (mode, over = {}) => runWmiserve({ exe: "vbslike-host.exe", vmId: VM, bundleFile, appId, tcpPort: 19201, igvmSha256: IGVM,
                                               readyTimeoutMs: 5_000, closeTimeoutMs: 1_000, spawn: spawnAs(mode, over.argsFile, over.closedFile), ...over });

test("a well-behaved run is ready with the loaded domain, and stop() closes it through stdin", async () => {
  const argsFile = path.join(dir, "args.json"), closedFile = path.join(dir, "closed-by-stop");
  const r = await run("ok", { argsFile, closedFile });
  try {
  assert.equal(r.domainId, 1); assert.equal(r.guestPort, 40001); assert.equal(r.tcpPort, 19201);
  assert.equal(r.appSha256, appId); assert.equal(r.boot, "39725c19e15c91afe488ce62251055f5");
  assert.equal(Buffer.from(r.launcherKey, "base64").length, 32);
  const argv = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.deepEqual(argv.slice(0, 3), ["wmiserve", "--vm", VM]);
  assert.equal(argv[argv.indexOf("--hold") + 1], "stdin", "the relay lives until the manager says otherwise, or dies");
  assert.equal(argv[argv.indexOf("--igvm-sha256") + 1], IGVM); assert.equal(argv.includes("--medium-sha256"), false);
  const s = await r.stop();
  assert.deepEqual(s, { closed: true, how: "closed" });
  assert.equal((await r.exited).code, 0);
  assert.equal(fs.readFileSync(closedFile, "utf8"), "line", "stop() closes it through a NON-BLANK line, not only the EOF after it");
  } finally { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone, as it should be */ } }
});

test("EOF on stdin with no line (the manager's pipe closing, as when it dies) ends serving with closed", async () => {
  let child = null;
  const closedFile = path.join(dir, "closed-by-eof");
  const spawn = (exe, args, opts) => (child = spawnAs("ok", null, closedFile)(exe, args, opts));
  const r = await run("ok", { spawn });
  try {
    child.stdin.end();                                    // EOF, and no line was written
    const ex = await Promise.race([r.exited, new Promise((res) => setTimeout(() => res("still serving"), 3_000))]);
    assert.notEqual(ex, "still serving", "EOF on stdin did not end serving: only --hold stdin does that");
    assert.equal(ex.code, 0);
    assert.deepEqual(await r.stop(), { closed: true, how: "already exited" }, "it said closed before exiting");
    assert.equal(fs.readFileSync(closedFile, "utf8"), "eof");
  } finally { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ } }
});

test("an older monitor's load answer (no boot) is accepted with boot null; a malformed boot is refused", async () => {
  const r = await run("no-boot"); assert.equal(r.boot, null); await r.stop();
  assert.match((await refusedBy(run("bad-boot"))).message, /boot "xyz" is not 32 hex/);
});

for (const [mode, why] of [
  ["report-unbound", /report service is not bound/],
  ["load-fail", /step load failed: hash disagreement/],
  ["not-agreed", /were not compared and agreed/],
  ["wrong-app", /the guest loaded eeee.*not the AppID/],
  ["wrong-vm", /wmiserve joined 00000000/],
  ["out-of-order", /expected step "report-service", got "load"/],
  ["not-json", /a line that is not JSON/],
  ["relay-wrong-port", /the relay is on 19202, not the port asked for/],
  ["exit-early", /exited before "ready" \(code 3/],
]) {
  test(`refused: ${mode}`, async () => {
    assert.match((await refusedBy(run(mode))).message, why);
  });
}

test("no ready within the deadline is a failure, and the child is killed", async () => {
  const t = Date.now();
  await assert.rejects(() => run("hang", { readyTimeoutMs: 400 }), /no "ready" within 400 ms \(last step: relay\)/);
  assert.ok(Date.now() - t < 3_000);
});

test("a child that ignores the close line is killed at the close deadline", async () => {
  const r = await run("ignore-stdin", { closeTimeoutMs: 300 });
  try {
    const s = await r.stop();
    assert.equal(s.how, "killed after the close deadline"); assert.equal(s.closed, false);
  } finally { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone, as it should be */ } }
});

test("exactly one identity, a VM GUID and a relay port are required before anything is spawned", async () => {
  let spawned = 0; const spawn = () => { spawned++; throw new Error("must not spawn"); };
  await assert.rejects(() => runWmiserve({ exe: "x", vmId: VM, bundleFile, appId, tcpPort: 1, spawn }), /exactly one identity/);
  await assert.rejects(() => runWmiserve({ exe: "x", vmId: VM, bundleFile, appId, tcpPort: 1, igvmSha256: IGVM, mediumSha256: IGVM, spawn }), /exactly one identity/);
  await assert.rejects(() => runWmiserve({ exe: "x", vmId: "vm-1", bundleFile, appId, tcpPort: 1, igvmSha256: IGVM, spawn }), /GUID/);
  await assert.rejects(() => runWmiserve({ exe: "x", vmId: VM, bundleFile, appId, tcpPort: 0, igvmSha256: IGVM, spawn }), /TCP port/);
  assert.equal(spawned, 0);
});

test("the bundle file: named by instance id, hashed after writing, refused (and removed) when it is not the AppID", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wmiserve-bundle-"));
  const f = writeBundle({ dir: d, instanceId: "inst-2", bundle, appId });
  assert.equal(path.basename(f), "inst-2.bundle"); assert.deepEqual(fs.readFileSync(f), bundle);
  assert.throws(() => writeBundle({ dir: d, instanceId: "inst-3", bundle, appId: "ab".repeat(32) }), /hashes to .* not the AppID/);
  assert.equal(fs.existsSync(path.join(d, "inst-3.bundle")), false, "a refused bundle is not left behind");
  assert.throws(() => writeBundle({ dir: d, instanceId: "../x", bundle, appId }), /safe instance id/);
});
