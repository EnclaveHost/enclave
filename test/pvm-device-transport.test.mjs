// The pVM phone's transport (shielded/anchor/avf/runner/pvm-device.mjs): adb on USB while the cable is in, the phone's Wi-Fi
// address learned and its adbd put in TCP mode then; adb over Wi-Fi when the cable is out; the loopback doors made on
// whichever transport the round uses. Driven against a scripted adb (the real tool's command lines, a file for the phone).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPvmDevice } from "../shielded/anchor/avf/runner/pvm-device.mjs";

const FAKE_ADB = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const f = process.env.FAKE_ADB_STATE, lock = f + ".lock";
// the real adb server takes concurrent clients; this file does not: one invocation at a time
for (let i = 0; ; i++) { try { fs.mkdirSync(lock); break; } catch { if (i > 4000) process.exit(9); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } }
process.on("exit", () => { try { fs.rmdirSync(lock); } catch {} });
const st = JSON.parse(fs.readFileSync(f, "utf8"));
const save = () => fs.writeFileSync(f, JSON.stringify(st));
let a = process.argv.slice(2), dev = null;
if (a[0] === "-s") { dev = a[1]; a = a.slice(2); }
st.log.push([dev, ...a].join(" ")); save();
const wifiEp = st.ip + ":" + st.tcpPort;
const attached = [...(st.usb ? [st.serial] : []), ...(st.wifiConnected && st.tcpPort && st.wifiUp ? [wifiEp] : [])];
const fail = (m) => { process.stderr.write(m + "\n"); process.exit(1); };
if (a[0] === "devices") { console.log("List of devices attached"); for (const d of attached) console.log(d + "\tdevice"); process.exit(0); }
if (a[0] === "connect") { if (st.tcpPort && st.wifiUp && a[1] === wifiEp) { st.wifiConnected = true; save(); console.log("connected to " + a[1]); } else console.log("failed to connect to " + a[1]); process.exit(0); }
if (!attached.includes(dev)) fail("adb: device '" + dev + "' not found");
if (a[0] === "shell" && a[1] === "ip -4 addr show wlan0") { console.log("    inet " + st.ip + "/24 brd x scope global wlan0"); process.exit(0); }
if (a[0] === "shell" && a[1] === "getprop service.adb.tcp.port") { console.log(st.tcpPort || ""); process.exit(0); }
if (a[0] === "tcpip") { st.tcpPort = a[1]; st.forwards = st.forwards.filter((x) => x.dev !== dev); st.reverses = st.reverses.filter((x) => x.dev !== dev); save(); console.log("restarting in TCP mode port: " + a[1]); process.exit(0); }
if (a[0] === "wait-for-device") process.exit(0);
if (a[0] === "forward" && a[1] === "--list") { for (const x of st.forwards) console.log(x.dev + " " + x.spec + " " + x.spec); process.exit(0); }
if (a[0] === "forward") { st.forwards = st.forwards.filter((x) => x.spec !== a[1]); st.forwards.push({ dev, spec: a[1] }); save(); process.exit(0); }
if (a[0] === "reverse" && a[1] === "--list") { for (const x of st.reverses.filter((x) => x.dev === dev)) console.log("host-" + x.dev + " " + x.spec + " " + x.spec); process.exit(0); }
if (a[0] === "reverse" && a[1] === "--remove-all") { st.reverses = st.reverses.filter((x) => x.dev !== dev); save(); process.exit(0); }
if (a[0] === "reverse") { st.reverses = st.reverses.filter((x) => x.spec !== a[1]); st.reverses.push({ dev, spec: a[1] }); save(); process.exit(0); }
fail("fake adb: unexpected " + a.join(" "));
`;

function phone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-transport-"));
  const adb = path.join(dir, "adb"), stateFile = path.join(dir, "phone.json");
  fs.writeFileSync(adb, FAKE_ADB, { mode: 0o755 });
  const st = { serial: "SERIAL1", usb: true, ip: "192.168.88.5", tcpPort: "", wifiUp: true, wifiConnected: false, forwards: [], reverses: [], log: [] };
  fs.writeFileSync(stateFile, JSON.stringify(st));
  process.env.FAKE_ADB_STATE = stateFile;
  const events = [];
  const device = createPvmDevice({ adb, serial: "SERIAL1", vmName: "pvmtest", relay: "wss://relay.test/v1/fleet-tunnel", name: "pixel-test",
    agentPort: 18187, attachPort: 18188, egressPort: 18189, slots: 1, wifi: { port: 5555, file: path.join(dir, "phone-wifi.json") }, log: (o) => events.push(o) });
  const get = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const set = (o) => fs.writeFileSync(stateFile, JSON.stringify({ ...get(), ...o }));
  return { dir, device, get, set, events };
}

test("on USB the Wi-Fi address is learned and adb put in TCP mode; off the cable the doors move to Wi-Fi, and back", async () => {
  const p = phone();
  try {
    // plugged in: USB, the address kept, TCP mode set once, the doors on USB
    assert.equal(await p.device.selectTransport(), "usb");
    await p.device.ensurePorts();
    let s = p.get();
    assert.equal(s.tcpPort, "5555");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, "phone-wifi.json"), "utf8")).host, "192.168.88.5");
    assert.deepEqual(s.forwards.map((x) => `${x.dev} ${x.spec}`).sort(), ["SERIAL1 tcp:17786", "SERIAL1 tcp:17787", "SERIAL1 tcp:17796", "SERIAL1 tcp:17797"]);
    assert.deepEqual(s.reverses.map((x) => `${x.dev} ${x.spec}`).sort(), ["SERIAL1 tcp:18187", "SERIAL1 tcp:18188", "SERIAL1 tcp:18189"]);
    assert.equal(await p.device.ensurePorts(), 0, "nothing re-made while it all stands");
    assert.equal(p.get().log.filter((l) => / tcpip /.test(l)).length, 1, "TCP mode set once, not every round");

    // the cable out: the USB doors are gone with the transport; Wi-Fi is connected and the doors made there
    p.set({ usb: false, forwards: [], reverses: [] });
    await p.device.ensurePorts();
    s = p.get();
    assert.deepEqual(p.device.transport(), { via: "wifi", target: "192.168.88.5:5555" });
    assert.ok(s.log.includes(" connect 192.168.88.5:5555"), "adb connect to the address learned on USB");
    assert.deepEqual(s.forwards.map((x) => x.dev), Array(4).fill("192.168.88.5:5555"));
    assert.deepEqual(s.reverses.map((x) => x.dev), Array(3).fill("192.168.88.5:5555"));
    assert.deepEqual(p.events.filter((e) => e.ev === "device-transport").map((e) => e.via), ["wifi"]);

    // the cable back in: USB again; Wi-Fi's reverse doors freed, the forwards re-pointed
    p.set({ usb: true });
    await p.device.ensurePorts();
    s = p.get();
    assert.deepEqual(p.device.transport(), { via: "usb", target: "SERIAL1" });
    assert.deepEqual([...new Set(s.forwards.map((x) => x.dev))], ["SERIAL1"]);
    assert.deepEqual(s.reverses.map((x) => x.dev), Array(3).fill("SERIAL1"));

    // neither: unreachable, said as such (the agent then judges no VM)
    p.set({ usb: false, wifiUp: false, wifiConnected: false });
    await assert.rejects(p.device.ensurePorts(), /not on USB, and adb over Wi-Fi at 192\.168\.88\.5:5555 does not answer/);
  } finally { fs.rmSync(p.dir, { recursive: true, force: true }); }
});

test("off the cable before any address is known: unreachable, with what to do", async () => {
  const p = phone();
  try {
    p.set({ usb: false });
    await assert.rejects(p.device.ensurePorts(), /not on USB, and its Wi-Fi address is not known yet \(plug it in once\)/);
  } finally { fs.rmSync(p.dir, { recursive: true, force: true }); }
});
