// A partition's egress path (egress.mjs): configuration, pins, and the two supervised children, driven through a
// protocol-exact fake of both (testdata/fake-egress-child.mjs). Nothing here touches Hyper-V or the registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { egressConfigFromEnv, startEgress, checkPin, loopbackEntry, EGRESS_SERVICE_GUID, EGRESS_VSOCK_PORT } from "./egress.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testdata/fake-egress-child.mjs");
const VM = "5db6d4eb-1619-4936-9d60-c7e3ca67f3a8";
const DEP = "0x" + "a7".repeat(32);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Two "executables" (files whose bytes are their pins) and a spawn that runs the fake for either, with `env`. */
function world({ server = "ok", bridge = "ok", over = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-"));
  const exe = path.join(dir, "shield-egress.exe"), bridgeExe = path.join(dir, "shielded-bridge.exe");
  fs.writeFileSync(exe, "shield-egress bytes"); fs.writeFileSync(bridgeExe, "shielded-bridge bytes");
  const log = path.join(dir, "events.jsonl");
  const spawned = [];
  const spawn = (file, args, opts) => {
    spawned.push({ file, args, opts });
    return nodeSpawn(process.execPath, [FAKE, ...args], { ...opts,
      env: { ...process.env, FAKE_EGRESS_SERVER: server, FAKE_EGRESS_BRIDGE: bridge, FAKE_EGRESS_LOG: log } });
  };
  const cfg = { exe, sha256: sha("shield-egress bytes"), bridgeExe, bridgeSha256: sha("shielded-bridge bytes"),
                socks: "127.0.0.1:30489", appRoutes: null, allow: null, mode: "socks", ...over };
  const events = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { cfg, spawn, spawned, events };
}
const settle = () => new Promise((r) => setTimeout(r, 100));

test("off unless ENCLAVE_EGRESS_V1=1; then every setting is required, and the SOCKS entry is a loopback literal", () => {
  const exe = { ENCLAVE_EGRESS_EXE: "C:\\enclave\\shield-egress.exe", ENCLAVE_EGRESS_EXE_SHA256: "ab".repeat(32),
                ENCLAVE_EGRESS_BRIDGE_EXE: "C:\\enclave\\shielded-bridge.exe", ENCLAVE_EGRESS_BRIDGE_EXE_SHA256: "cd".repeat(32) };
  assert.equal(egressConfigFromEnv({}), null);
  assert.equal(egressConfigFromEnv({ ...exe, ENCLAVE_EGRESS_SOCKS: "127.0.0.1:30489" }), null, "every other setting is inert without the switch");
  assert.equal(egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "true", ...exe, ENCLAVE_EGRESS_SOCKS: "127.0.0.1:30489" }), null, "only exactly 1 turns it on");
  const ok = egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "1", ...exe, ENCLAVE_EGRESS_SOCKS: "127.0.0.1:30489" });
  assert.equal(ok.mode, "socks"); assert.equal(ok.socks, "127.0.0.1:30489"); assert.equal(ok.appRoutes, null);
  assert.equal(egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "1", ...exe, ENCLAVE_EGRESS_APP_ROUTES: "C:\\enclave\\routes.json" }).mode, "app-routes");
  assert.throws(() => egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "1" }), /ENCLAVE_EGRESS_EXE, ENCLAVE_EGRESS_EXE_SHA256.*ENCLAVE_EGRESS_BRIDGE_EXE, ENCLAVE_EGRESS_BRIDGE_EXE_SHA256.*exactly one of/);
  assert.throws(() => egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "1", ...exe }), /exactly one of ENCLAVE_EGRESS_SOCKS/, "no upstream: there is no direct path");
  assert.throws(() => egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "1", ...exe, ENCLAVE_EGRESS_SOCKS: "127.0.0.1:30489", ENCLAVE_EGRESS_APP_ROUTES: "r.json" }), /exactly one of/);
  assert.throws(() => egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "1", ...exe, ENCLAVE_EGRESS_EXE_SHA256: "ab", ENCLAVE_EGRESS_SOCKS: "127.0.0.1:30489" }), /ENCLAVE_EGRESS_EXE_SHA256 \(64 hex\)/);
  for (const bad of ["10.0.0.1:1080", "0.0.0.0:30489", "localhost:30489", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000", "[::1]:30489", "socks5://127.0.0.1:30489"]) {
    assert.equal(loopbackEntry(bad), false, bad);
    assert.throws(() => egressConfigFromEnv({ ENCLAVE_EGRESS_V1: "1", ...exe, ENCLAVE_EGRESS_SOCKS: bad }), /loopback/, bad);
  }
  assert.equal(EGRESS_SERVICE_GUID, `${EGRESS_VSOCK_PORT.toString(16).padStart(8, "0")}-facb-11e6-bd58-64006a7986d3`,
               "the service GUID is vsock 9443's, as the guest's hv_sock transport derives it");
});

test("a start: shield-egress first, then the bridge for THIS partition's 9443 to the port it named; stop ends both, bridge first", async () => {
  const w = world();
  const e = await startEgress({ cfg: w.cfg, vmId: VM, deploymentId: DEP, spawn: w.spawn });
  try {
    assert.equal(e.port, 41234);
    assert.equal(w.spawned.length, 2);
    assert.equal(w.spawned[0].file, w.cfg.exe);
    assert.deepEqual(w.spawned[0].args, ["-listen", "127.0.0.1:0", "-socks", "127.0.0.1:30489"], "loopback only, the SOCKS entry, and no direct option");
    assert.equal(w.spawned[1].file, w.cfg.bridgeExe);
    assert.deepEqual(w.spawned[1].args, [VM, "9443", "41234", "0"], "the partition's own service, to shield-egress's port, supervised by stdin (lifetime 0)");
    assert.ok(w.spawned.every((s) => s.opts.windowsHide === true && s.opts.stdio.join() === "pipe,pipe,pipe"));
  } finally { await e.stop(); }
  await settle();
  const ends = w.events().filter((x) => x.event === "stdin-eof").map((x) => x.role);
  assert.deepEqual(ends, ["bridge", "server"], "stdin EOF ends each, the bridge (the partition's way in) first");
  const out = await Promise.race([e.exited, new Promise((r) => setTimeout(() => r("pending"), 1000))]);
  assert.notEqual(out, "pending", "exited settles once they are gone");
});

test("the per-app route and the host-side list reach shield-egress's argv; a route without a deployment id is refused", async () => {
  const w = world({ over: { socks: null, appRoutes: "C:\\enclave\\routes.json", mode: "app-routes", allow: "https://acct.r2.cloudflarestorage.com" } });
  const e = await startEgress({ cfg: w.cfg, vmId: VM, deploymentId: DEP, spawn: w.spawn });
  await e.stop();
  assert.deepEqual(w.spawned[0].args, ["-listen", "127.0.0.1:0", "-app-routes", "C:\\enclave\\routes.json", "-deployment", DEP,
                                       "-allow", "https://acct.r2.cloudflarestorage.com"]);
  for (const deploymentId of [null, "0xA7", "a7".repeat(32)]) {
    const v = world({ over: { socks: null, appRoutes: "r.json", mode: "app-routes" } });
    await assert.rejects(() => startEgress({ cfg: v.cfg, vmId: VM, deploymentId, spawn: v.spawn }), /deployment's id/);
    assert.equal(v.spawned.length, 0);
  }
});

test("pins: an executable that is not its pinned bytes starts nothing", async () => {
  for (const which of ["sha256", "bridgeSha256"]) {
    const w = world();
    w.cfg[which] = "00".repeat(32);
    await assert.rejects(() => startEgress({ cfg: w.cfg, vmId: VM, spawn: w.spawn }), /hashes [0-9a-f]{64}, not its pin 0{64}/);
    assert.equal(w.spawned.length, 0, `${which}: nothing spawned`);
  }
  assert.throws(() => checkPin("/nonexistent/shield-egress.exe", "00".repeat(32), "x"), /cannot be read/);
});

test("a partition id must be a real one: no wildcard, no junk", async () => {
  for (const vmId of ["00000000-0000-0000-0000-000000000000", "not-a-guid", "", null]) {
    const w = world();
    await assert.rejects(() => startEgress({ cfg: w.cfg, vmId, spawn: w.spawn }), /not a partition id/);
    assert.equal(w.spawned.length, 0);
  }
});

test("shield-egress refusing, hanging or naming no port: the start fails, it is stopped, and no bridge is started", async () => {
  for (const [server, re] of [["exit", /shield-egress exited \(2\).*loopback/], ["hang", /shield-egress readiness timed out/], ["no-port", /named no usable port/]]) {
    const w = world({ server });
    await assert.rejects(() => startEgress({ cfg: w.cfg, vmId: VM, spawn: w.spawn, readyTimeoutMs: 500 }), re, server);
    assert.equal(w.spawned.length, 1, `${server}: the bridge was never started`);
    await settle();
    const ev = w.events();
    assert.ok(ev.some((x) => x.role === "server" && (x.event === "exit" || x.event === "stdin-eof")), `${server}: shield-egress is gone: ${JSON.stringify(ev)}`);
  }
});

test("the bridge refusing (its bind's 10013 when the service is unregistered) fails the start and stops shield-egress too", async () => {
  const w = world({ bridge: "exit" });
  await assert.rejects(() => startEgress({ cfg: w.cfg, vmId: VM, spawn: w.spawn }), /egress bridge exited \(2\).*10013/);
  await settle();
  assert.ok(w.events().some((x) => x.role === "server" && x.event === "stdin-eof"), "shield-egress was stopped");
});

test("after a good start, EITHER child ending settles `exited`, naming which", async () => {
  for (const [opts, who] of [[{ server: "die-later" }, "shield-egress"], [{ bridge: "die-later" }, "shielded-bridge"]]) {
    const w = world(opts);
    const e = await startEgress({ cfg: w.cfg, vmId: VM, spawn: w.spawn });
    const x = await Promise.race([e.exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    assert.ok(x, `${who}: exited never settled`);
    assert.equal(x.who, who); assert.equal(x.code, 1);
    await e.stop();
  }
});
