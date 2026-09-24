// windows/vbslike/review/main-entry.test.mjs: the manager started the way PRODUCTION starts it (windows/vbslike/manager/main.mjs
// as a process, configured by environment), asked over its own HTTP surface what RuntimeID it pins spawns to.
//
// Why: record-to-route.test.mjs proved the readiness join green by constructing Manager({ runtime }) directly. main.mjs
// at d9084612 constructs Manager({ runtimeId }) with NO runtime, so the real entry point judges every domain with
// expectRuntime undefined: no identity pinned, an ABI/1 downgrade not refused (found by enclave-53). The seam this case
// specifies: main.mjs reads the image's runtime identity from ENCLAVE_RUNTIME_IDENTITY (a path to the runtime.json the
// guest image states; the package carries it as guest/runtime.json), gives the Manager `runtime`, and the RuntimeID the
// manager reports and pins spawns to is DERIVED from it with the contract's runtimeId(); a separately configured hash
// (ENCLAVE_RUNTIME_ID) is not an input any more. Red until wired.
//   run: node --test windows/vbslike/review/main-entry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { runtimeId } from "../../../isolation/contract/runtime.mjs";
import { RUNTIME } from "./fake-domain.mjs";

const MAIN = new URL("../manager/main.mjs", import.meta.url).pathname;
const DERIVED = Buffer.from(runtimeId(RUNTIME)).toString("hex");
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const getJson = (port, p) => new Promise((res, rej) => { const r = http.get({ host: "127.0.0.1", port, path: p }, (a) => { let d = ""; a.on("data", (c) => d += c); a.on("end", () => { try { res({ status: a.statusCode, body: JSON.parse(d) }); } catch (e) { rej(e); } }); }); r.on("error", rej); });

/** Start main.mjs with this environment, wait for /health, hand back health and a stop(). */
async function startMain(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-entry-"));
  const identityPath = path.join(dir, "runtime.json"); fs.writeFileSync(identityPath, JSON.stringify(RUNTIME));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, VMMGR_PORT: String(port), ENCLAVE_CID_FETCHER: path.join(dir, "fetch-cid.py"), PYTHON_BIN: "python3", ...extraEnv(identityPath) };
  const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = ""; child.stdout.on("data", (c) => { log += c; }); child.stderr.on("data", (c) => { log += c; });
  const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { stop(); throw new Error(`main.mjs exited ${child.exitCode} before answering: ${log.slice(-400)}`); }
    try { const h = await getJson(port, "/health"); return { health: h.body, log, stop }; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  stop(); throw new Error(`main.mjs did not answer /health within 20 s: ${log.slice(-400)}`);
}

test("started as production starts it, with the image's runtime identity configured, the manager reports the RuntimeID DERIVED from that identity", async () => {
  const m = await startMain((identityPath) => ({ ENCLAVE_RUNTIME_IDENTITY: identityPath }));
  try {
    assert.equal(m.health.backend, "hyperv-partition-per-app");
    assert.equal(m.health.catalog && m.health.catalog.runtimeId, DERIVED,
      `main.mjs pins spawns to ${JSON.stringify(m.health.catalog && m.health.catalog.runtimeId)}: the identity in ENCLAVE_RUNTIME_IDENTITY is not read, so readiness is judged with expectRuntime undefined (no identity pinned, ABI/1 not refused)`);
  } finally { m.stop(); }
});

test("a separately configured hash is not an input: with ENCLAVE_RUNTIME_ID naming another value, the reported RuntimeID is still the one derived from the identity", async () => {
  const m = await startMain((identityPath) => ({ ENCLAVE_RUNTIME_IDENTITY: identityPath, ENCLAVE_RUNTIME_ID: "ab".repeat(32) }));
  try {
    assert.equal(m.health.catalog && m.health.catalog.runtimeId, DERIVED, "two independently supplied values that must agree are two values that will eventually disagree: the hash must be derived, never configured");
  } finally { m.stop(); }
});

test("a hash configured with NO identity is a refusal to start (exit 2), not a manager that runs pinning nothing (the owner's stricter reading of the spec, adopted)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-entry-"));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, VMMGR_PORT: String(port), ENCLAVE_CID_FETCHER: path.join(dir, "fetch-cid.py"), PYTHON_BIN: "python3", ENCLAVE_RUNTIME_ID: "ab".repeat(32) };
  const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = ""; child.stdout.on("data", (c) => { log += c; }); child.stderr.on("data", (c) => { log += c; });
  try {
    const code = await new Promise((res) => { const t = setTimeout(() => res(null), 15_000); child.once("exit", (c) => { clearTimeout(t); res(c); }); });
    assert.equal(code, 2, `main.mjs ${code === null ? "kept running" : "exited " + code} with a hash and no identity: ${log.slice(-300)}`);
    assert.match(log, /pins nothing|ENCLAVE_RUNTIME_IDENTITY/, "and says why");
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});
