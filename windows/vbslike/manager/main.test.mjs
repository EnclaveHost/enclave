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
      { env: { ...process.env, ENCLAVE_MANAGER_PORT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

test("cleanup", async () => { await fs.rm(dir, { recursive: true, force: true }); });
