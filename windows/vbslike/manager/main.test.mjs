// The ENTRY POINT, run as a process. Not the Manager class - this file exists because the
// defect-11 fix was correct in server.mjs and NOT REACHED from main.mjs (enclave-53, by reading).
// main.mjs passed only runtimeId, so this.runtime was null, expectRuntime was undefined, and
// checkRuntime pinned nothing: any admissible runtime a domain stated was accepted, AND an ABI/1
// document was not refused as a downgrade, because judge.mjs refuses that only when want.runtime is
// given. A manager started the normal way silently accepted what the ABI/2 binding exists to
// prevent, while record-to-route was green because it constructs the Manager directly.
//
// So these spawn the real entry point with real environment variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeId as runtimeIdOf } from "../../../isolation/contract/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "main.mjs");
const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64",
                  hostIsa: "x86_64", cpuFeatures: "baseline", wx: "enforced", cache: "none" };
const RID = Buffer.from(runtimeIdOf(RUNTIME)).toString("hex");

/** Run main.mjs with an environment and collect what it said, bounded. */
function run(env, { ms = 8000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MAIN],
      // VMMGR_PORT is the variable main.mjs reads; without it every run listened on 8091 and two
      // concurrent runs (another worktree) failed with EADDRINUSE.
      { env: { ...process.env, ENCLAVE_MANAGER_PORT: "0", VMMGR_PORT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { p.kill(); resolve({ code: null, out, err, timedOut: true }); }, ms);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut: false }); });
  });
}

let dir, identityFile;
test("fixture", async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "winmgr-main-"));
  identityFile = path.join(dir, "runtime.json");
  await fs.writeFile(identityFile, JSON.stringify(RUNTIME));
});

test("a RuntimeID hash WITHOUT the identity is refused at startup, not quietly accepted", async () => {
  const r = await run({ ENCLAVE_RUNTIME_ID: RID, ENCLAVE_RUNTIME_IDENTITY: "" });
  assert.equal(r.code, 2, "it must refuse to start rather than run pinning nothing");
  assert.match(r.err, /cannot pin a runtime/);
  assert.match(r.err, /ABI\/1 downgrade/, "the operator is told WHAT it would fail to refuse");
});

test("the identity WINS over a stale RuntimeID, loudly rather than silently", async () => {
  // enclave-99's spec: ENCLAVE_RUNTIME_ID stops being an input, and the derived value wins. Agreed,
  // because a stale variable must not take the manager down - but it is said, because an operator
  // who set it believed they were pinning something, and a silent no-op is this lane's whole theme.
  const r = await run({ ENCLAVE_RUNTIME_ID: "ab".repeat(32), ENCLAVE_RUNTIME_IDENTITY: identityFile });
  assert.ok(r.timedOut, `a stale variable must not stop the manager; it exited ${r.code}: ${r.err.slice(0,200)}`);
  assert.match(r.out, new RegExp(`RuntimeID ${RID}`), "the DERIVED id is what it runs with");
  assert.match(r.err, /pins nothing/, "and the ignored variable is called out, not swallowed");
});

test("with the identity, it starts and derives the RuntimeID from it", async () => {
  const r = await run({ ENCLAVE_RUNTIME_IDENTITY: identityFile });
  assert.ok(r.timedOut, `it should stay up serving; instead it exited ${r.code}: ${r.err.slice(0, 300)}`);
  assert.match(r.out, new RegExp(`RuntimeID ${RID}`), "the derived id is printed, so a mismatch is visible");
  assert.match(r.out, /wasmtime\/48\.0\.1 jit x86_64/);
});

test("with neither, it still starts: judging nothing is a choice an operator may make explicitly", async () => {
  const r = await run({ ENCLAVE_RUNTIME_ID: "", ENCLAVE_RUNTIME_IDENTITY: "" });
  assert.ok(r.timedOut, `expected it to run; exited ${r.code}: ${r.err.slice(0, 200)}`);
  assert.doesNotMatch(r.out, /RuntimeID/, "and it does not claim to pin one");
});

test("a contradictory launcher configuration is refused at startup: the boot form is stated, never guessed", async () => {
  const base = { ENCLAVE_RUNTIME_IDENTITY: identityFile, ENCLAVE_GUEST_IGVM: "C:\\x\\openhcl-cvm.bin",
                 ENCLAVE_GUEST_IGVM_SHA256: "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3" };
  for (const [extra, why] of [
    [{ ENCLAVE_BOOT_FORM: "uefi" }, /boot must be one of uefi-medium, linux-direct/],
    [{ ENCLAVE_BOOT_FORM: "linux-direct", ENCLAVE_GUEST_MEDIUM: "C:\\x\\guest.iso", ENCLAVE_GUEST_MEDIUM_SHA256: "ab".repeat(32) }, /no medium may be attached/],
    [{ ENCLAVE_BOOT_FORM: "", ENCLAVE_GUEST_MEDIUM: "C:\\x\\guest.iso", ENCLAVE_GUEST_MEDIUM_SHA256: "ab".repeat(32) }, /never inferred/],
  ]) {
    const r = await run({ ...base, ...extra });
    assert.equal(r.code, 2, `${JSON.stringify(extra)}: it must refuse to start, not run with a guessed boot form`);
    assert.match(r.err, /REFUSING TO START: the launcher configuration is invalid/);
    assert.match(r.err, why);
  }
});

test("cleanup", async () => { await fs.rm(dir, { recursive: true, force: true }); });

/* ---- serving through wmiserve: all three settings, and the executable pinned by hash ------------------- */
// their own fixture: the file's earlier cleanup removes `dir`
async function serveFixture() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "winmgr-serve-"));
  const id = path.join(d, "runtime.json"); await fs.writeFile(id, JSON.stringify(RUNTIME));
  return { d, id };
}
test("a partial wmiserve configuration is refused at startup, naming what is missing", async () => {
  const { d, id } = await serveFixture();
  const r = await run({ ENCLAVE_RUNTIME_IDENTITY: id, ENCLAVE_WMISERVE_EXE: process.execPath });
  await fs.rm(d, { recursive: true, force: true });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /missing ENCLAVE_WMISERVE_EXE_SHA256 \(64 hex\), ENCLAVE_BUNDLE_DIR/);
});

test("a wmiserve executable that does not hash to its pin is refused at startup", async () => {
  const { d, id } = await serveFixture();
  const exe = path.join(d, "wmiserve.exe"); await fs.writeFile(exe, "not the pinned bytes");
  const r = await run({ ENCLAVE_RUNTIME_IDENTITY: id, ENCLAVE_WMISERVE_EXE: exe, ENCLAVE_WMISERVE_EXE_SHA256: "ab".repeat(32),
                        ENCLAVE_BUNDLE_DIR: path.join(d, "bundles") });
  await fs.rm(d, { recursive: true, force: true });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /hashes [0-9a-f]{64}, not the pinned abab/);
});

test("the pinned wmiserve executable is accepted and said, and the manager runs", async () => {
  const { d, id } = await serveFixture();
  const exe = path.join(d, "wmiserve-ok.exe"); await fs.writeFile(exe, "the pinned bytes");
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update("the pinned bytes").digest("hex");
  const r = await run({ ENCLAVE_RUNTIME_IDENTITY: id, ENCLAVE_WMISERVE_EXE: exe, ENCLAVE_WMISERVE_EXE_SHA256: sha.toUpperCase(),
                        ENCLAVE_BUNDLE_DIR: path.join(d, "bundles") });
  await fs.rm(d, { recursive: true, force: true });
  assert.ok(r.timedOut, `it must keep running; it exited ${r.code}: ${r.err.slice(0, 200)}`);
  assert.match(r.out, new RegExp(`serving through wmiserve .* \\(sha256 ${sha}\\)`));
});

/* ---- outbound HTTPS (egress.mjs): off by default, all-or-nothing when on, and both executables pinned ------------- */
async function egressFixture() {
  const { d, id } = await serveFixture();
  const exe = path.join(d, "shield-egress.exe"), bridge = path.join(d, "shielded-bridge.exe");
  await fs.writeFile(exe, "shield-egress bytes"); await fs.writeFile(bridge, "shielded-bridge bytes");
  const { createHash } = await import("node:crypto");
  const h = (s) => createHash("sha256").update(s).digest("hex");
  return { d, env: { ENCLAVE_RUNTIME_IDENTITY: id, ENCLAVE_EGRESS_V1: "1", ENCLAVE_EGRESS_EXE: exe, ENCLAVE_EGRESS_EXE_SHA256: h("shield-egress bytes"),
                     ENCLAVE_EGRESS_BRIDGE_EXE: bridge, ENCLAVE_EGRESS_BRIDGE_EXE_SHA256: h("shielded-bridge bytes"),
                     ENCLAVE_EGRESS_SOCKS: "127.0.0.1:30489" } };
}
test("egress: ENCLAVE_EGRESS_V1=1 with a setting missing or the SOCKS entry off loopback is refused at startup", async () => {
  const { d, env } = await egressFixture();
  const r1 = await run({ ...env, ENCLAVE_EGRESS_BRIDGE_EXE: "", ENCLAVE_EGRESS_SOCKS: "" });
  const r2 = await run({ ...env, ENCLAVE_EGRESS_SOCKS: "10.0.0.1:1080" });
  await fs.rm(d, { recursive: true, force: true });
  assert.equal(r1.code, 2, r1.err);
  assert.match(r1.err, /REFUSING TO START: ENCLAVE_EGRESS_V1=1 needs ENCLAVE_EGRESS_BRIDGE_EXE, exactly one of ENCLAVE_EGRESS_SOCKS/);
  assert.equal(r2.code, 2, r2.err);
  assert.match(r2.err, /must be a loopback IPv4 literal/);
});

test("egress: an executable that is not its pinned bytes is refused at startup", async () => {
  const { d, env } = await egressFixture();
  const r = await run({ ...env, ENCLAVE_EGRESS_BRIDGE_EXE_SHA256: "ab".repeat(32) });
  await fs.rm(d, { recursive: true, force: true });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /REFUSING TO START: the shielded-bridge executable \(egress\) at .* hashes [0-9a-f]{64}, not its pin abab/);
});

test("egress: pinned and complete, the manager runs and says so", async () => {
  const { d, env } = await egressFixture();
  const r = await run(env);
  await fs.rm(d, { recursive: true, force: true });
  assert.ok(r.timedOut, `it must keep running; it exited ${r.code}: ${r.err.slice(0, 200)}`);
  assert.match(r.out, /egress ON \(socks\): shield-egress .* \(sha256 [0-9a-f]{64}\), bridge .* \(sha256 [0-9a-f]{64}\); secret deployments only/);
});
