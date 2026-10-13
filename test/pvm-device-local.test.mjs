// pvm-device-local.mjs: the host agent's handle on the phone from inside it (STANDALONE.md) -- files, launches through the
// app's control endpoint, liveness from the VM process's own alive file, and the evidence exchange behind the bridge token.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { createLocalPvmDevice, controlClient, pidOfProcess } from "../shielded/anchor/avf/runner/pvm-device-local.mjs";

const PKG = "host.enclave.pvmcpu";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pvm-local-"));
const fakeProc = (dir, pid, cmd) => { fs.mkdirSync(path.join(dir, String(pid)), { recursive: true }); fs.writeFileSync(path.join(dir, String(pid), "cmdline"), `${cmd}\0`); };
const base = (o = {}) => ({ files: tmp(), vmName: "pvmprod1", relay: "wss://api.enclave.host/v1/fleet-tunnel", name: "phone-1", agentPort: 18187,
  attachPort: 18188, slots: 4, sleep: async () => {}, ...o });

test("a process is found by its own cmdline, never by a prefix", () => {
  const p = tmp();
  fakeProc(p, 101, PKG); fakeProc(p, 102, `${PKG}:slot1`); fakeProc(p, 103, `${PKG}:slot10`);
  assert.equal(pidOfProcess(PKG, p), 101);
  assert.equal(pidOfProcess(`${PKG}:slot1`, p), 102);
  assert.equal(pidOfProcess(`${PKG}:slot2`, p), null);
});

test("a launch: the same service and typed extras the adb path sent, the old alive file gone first", async () => {
  const calls = [], procDir = tmp();
  const d = createLocalPvmDevice(base({ procDir, launcher: async (service, extras) => calls.push({ service, extras }) }));
  const s2 = d.slot(2);
  await s2.launch({ proofPins: "8453 0x1 0x2 0x3 0x4 0x5", label: "s2-abc", vmMib: 512, cpus: 1, appMem: 256, opts: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, "host.enclave.anchor.avf.AnchorServiceSlot2");
  const ex = Object.fromEntries(calls[0].extras.map(([k, t, v]) => [k, [t, v]]));
  assert.deepEqual(ex.vmname, ["s", "pvmprod1s2"]);
  assert.deepEqual(ex.slot, ["z", true]);
  assert.deepEqual(ex.mem, ["i", 512]);
  assert.deepEqual(ex.cpus, ["i", 1]);
  assert.deepEqual(ex.app_mem, ["i", 256]);
  assert.deepEqual(ex.app_opts, ["z", true]);
  assert.deepEqual(ex.proof_pins, ["s", "8453 0x1 0x2 0x3 0x4 0x5"]);
  assert.equal(ex.relay, undefined, "a slot VM never holds the relay tunnel");
  await d.launch({ label: "idle-1", attachSigner: "http://127.0.0.1:18188/attach-sign" });
  const hx = Object.fromEntries(calls[1].extras.map(([k, t, v]) => [k, [t, v]]));
  assert.equal(calls[1].service, "host.enclave.anchor.avf.AnchorService");
  assert.deepEqual(hx.relay, ["s", "wss://api.enclave.host/v1/fleet-tunnel"]);
  assert.deepEqual(hx.host_agent, ["s", "http://127.0.0.1:18187"]);
  assert.equal(hx.proof_pins, undefined);
  await assert.rejects(d.slot(2).launch({ label: "idle-x", vmMib: 512 }), /starting s2-/);
  await assert.rejects(d.launch({ label: "a b" }), /label/);
});

test("alive: the VM process's own file, this label, a pid that is still that process, and a serving capture", async () => {
  const o = base({ procDir: tmp(), launcher: async () => {} });
  const d = createLocalPvmDevice(o);
  const s1 = d.slot(1);
  fs.mkdirSync(path.join(o.files, "capture"), { recursive: true });
  fs.mkdirSync(path.join(o.files, "run"), { recursive: true });
  fs.writeFileSync(path.join(o.files, "capture", "s1-a.log"), "x\nAPP serving https-p256 ...\n");
  assert.equal(await s1.alive("s1-a"), false, "no alive file");
  fs.writeFileSync(path.join(o.files, "run", "pvmprod1s1.alive"), "777 s1-a\n");
  assert.equal(await s1.alive("s1-a"), false, "the pid is not running");
  fakeProc(o.procDir, 777, `${PKG}:slot1`);
  assert.equal(await s1.alive("s1-a"), true);
  assert.equal(await s1.alive("s1-b"), false, "another label");
  fs.rmSync(path.join(o.procDir, "777"), { recursive: true });
  fakeProc(o.procDir, 778, `${PKG}:slot1`);
  assert.equal(await s1.alive("s1-a"), false, "the process came back with another pid: no VM in it");
  fakeProc(o.procDir, 777, `${PKG}:slot1`); fs.rmSync(path.join(o.procDir, "778"), { recursive: true });
  fs.appendFileSync(path.join(o.files, "capture", "s1-a.log"), "CONTROL closed\n");
  assert.equal(await s1.alive("s1-a"), false, "the capture says it ended");
});

test("staging: private 0600 files, checked by hash; options refused unless they are an options file", async () => {
  const o = base({ procDir: tmp(), launcher: async () => {} });
  const d = createLocalPvmDevice(o);
  const src = path.join(tmp(), "c.wasm"); fs.writeFileSync(src, "component");
  const h = crypto.createHash("sha256").update("component").digest("hex");
  const p = await d.slot(3).stageApp(src, h);
  assert.equal(p, path.join(o.files, "app-slot3.wasm"));
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  await assert.rejects(d.slot(3).stageApp(src, "0".repeat(64)), /not 0000/);
  await d.slot(3).stageOptions("ENV 6162 6364\nEGRESS 4142\n");
  assert.equal(fs.readFileSync(path.join(o.files, "app-opts-slot3"), "utf8"), "ENV 6162 6364\nEGRESS 4142\n");
  await assert.rejects(d.slot(3).stageOptions("rm -rf /"), /not an options file/);
  await d.slot(3).stageOptions(null);
  assert.equal(fs.existsSync(path.join(o.files, "app-opts-slot3")), false);
});

test("exchange: AUTH with the token from the app's private files, re-read once when the VM wrote a new one", async () => {
  const toks = ["a".repeat(64), "b".repeat(64)];
  const seen = [];
  const srv = net.createServer((s) => {
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.split("\n").length < 3) return;
      const [auth, line] = buf.split("\n");
      seen.push(auth);
      s.end(auth === `AUTH ${toks[1]}` ? `ok ${line}` : "bridge: AUTH <token> first");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const o = base({ procDir: tmp(), launcher: async () => {}, bridgeEvidence: srv.address().port });
  const d = createLocalPvmDevice(o);
  fs.writeFileSync(path.join(o.files, "bridge-token"), toks[0]);
  await d.readToken();
  fs.writeFileSync(path.join(o.files, "bridge-token"), toks[1]);
  assert.equal(await d.exchange("PING 1"), "ok PING 1");
  assert.deepEqual(seen, [`AUTH ${toks[0]}`, `AUTH ${toks[1]}`]);
  srv.close();
});

test("the control client sends the token and treats anything but { ok: true } as a failed launch", async () => {
  const dir = tmp(), tokenFile = path.join(dir, "control-token");
  fs.writeFileSync(tokenFile, "c".repeat(64));
  let got = null, answer = { ok: true };
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (d) => b += d); q.on("end", () => { got = { auth: q.headers.authorization, url: q.url, body: JSON.parse(b) }; s.end(JSON.stringify(answer)); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const launch = controlClient({ port: srv.address().port, tokenFile });
  await launch("host.enclave.anchor.avf.AnchorService", [["mode", "s", "app"]]);
  assert.equal(got.auth, `Bearer ${"c".repeat(64)}`);
  assert.equal(got.url, "/launch");
  assert.deepEqual(got.body, { service: "host.enclave.anchor.avf.AnchorService", extras: [["mode", "s", "app"]] });
  answer = { error: "not allowed" };
  await assert.rejects(launch("x", []), /not allowed/);
  fs.writeFileSync(tokenFile, "short");
  await assert.rejects(launch("x", []), /no control token/);
  srv.close();
});
