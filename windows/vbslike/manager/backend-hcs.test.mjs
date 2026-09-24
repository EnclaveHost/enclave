// The HCS backend, driven by a fake launcher speaking the real line protocol.
//
// Mocked: no partition is created here. What is tested is the client half - the protocol, the hash
// agreement, the cleanup, and above all that this path never loses the word for what it is. An HCS
// child partition does not exclude the host, the guest says so on boot
// ("boundary tier=t0-hv partition=hcs-child host_excluded=no"), and a backend that lets that get
// lost between here and a fleet row would be advertising an isolation it does not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HcsPartitionBackend, BOUNDARY, SUPPORTS_HCS } from "./backend-hcs.mjs";

const APPID = "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782";
const mapping = { appId: APPID, bundle: Buffer.from("ENCLAVE-BUNDLE/1\nfixture"),
                  record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } };

/** A launcher that speaks the lab's protocol: a ready line, then one JSON answer per command. */
function fakeLauncher({ appSha256 = APPID, loadError = null, ready = true } = {}) {
  const sent = [];
  const make = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdin = { write: (s) => {
      sent.push(s.trim());
      const [cmd, a1] = s.trim().split(/\s+/);
      queueMicrotask(() => {
        if (cmd === "load") {
          if (loadError) return p.stdout.emit("data", JSON.stringify({ error: loadError }) + "\n");
          p.stdout.emit("data", JSON.stringify({ loaded: { id: 7, label: a1, vmId: "GUID-7",
            appSha256, guestId: "g1", guestPort: 8080, tcpPort: 19007 } }) + "\n");
        } else if (cmd === "destroy") p.stdout.emit("data", JSON.stringify({ destroyed: a1, guest: { exit: 0 } }) + "\n");
        else p.stdout.emit("data", JSON.stringify({ ok: true }) + "\n");
      });
    }, end: () => {} };
    queueMicrotask(() => p.stdout.emit("data", JSON.stringify(ready
      ? { ready: true, launcherKey: "k", boundary: "t0-hv", initrdSha256: "i", kernelSha256: "k" }
      : { error: "no" }) + "\n"));
    return p;
  };
  return { make, sent };
}

async function rig(over = {}, lopts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcsb-"));
  const exe = path.join(dir, "vbslike-host.exe");
  const kernel = path.join(dir, "wsl-kernel");
  const initrd = path.join(dir, "mon.cpio.gz");
  for (const f of [exe, kernel, initrd]) await fs.writeFile(f, "x");
  const L = fakeLauncher(lopts);
  const b = new HcsPartitionBackend({ exe, kernel, initrd, out: dir, spawnFn: L.make, ...over });
  return { b, L, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("it never loses the word for what this boundary is", async () => {
  const r = await rig();
  try {
    assert.equal(BOUNDARY.hostExcluded, false, "an HCS child does not exclude the host");
    assert.equal(BOUNDARY.attested, false);
    assert.equal(BOUNDARY.partition, "hcs-child");
    assert.match(BOUNDARY.note, /never advertise it as verified or host-excluded/);
    const pre = await r.b.preflight();
    assert.equal(pre.ok, true, "it CAN run, which is a different question from what it proves");
    assert.equal(pre.boundary.hostExcluded, false, "and the boundary rides along with the verdict");
    assert.ok(pre.checks.some((c) => c.name === "host excluded" && c.ok === false));
    for (const k of Object.keys(SUPPORTS_HCS)) assert.equal(SUPPORTS_HCS[k], false, `supports.${k}`);
  } finally { await r.cleanup(); }
});

test("a domain is loaded over the launcher's own protocol, and the handle carries the relay port", async () => {
  const r = await rig();
  try {
    const h = await r.b.start(mapping, { instanceId: "dep-1" });
    assert.match(r.L.sent.find((s) => s.startsWith("load")), /^load dep-1 .*dep-1\.bundle$/);
    assert.equal(h.domainId, 7);
    assert.equal(h.tcpPort, 19007, "the host relay port a request reaches the domain through");
    assert.equal(h.guestPort, 8080);
    assert.equal(h.appId, APPID);
    assert.equal(h.boundary.hostExcluded, false);
  } finally { await r.cleanup(); }
});

test("HASH AGREEMENT: a guest that computed another AppID is refused and the domain destroyed", async () => {
  const r = await rig({}, { appSha256: "ff".repeat(32) });
  try {
    await assert.rejects(() => r.b.start(mapping, { instanceId: "dep-2" }),
                         /the guest computed ffff.*we derived 708e.*refusing/);
    assert.ok(r.L.sent.some((s) => s.startsWith("destroy")), "and it does not leave the domain behind");
    assert.equal(r.b.domains.size, 0);
  } finally { await r.cleanup(); }
});

test("loading is not serving: the handle says the guest took the bundle, not that the app answers", async () => {
  const r = await rig();
  try {
    const h = await r.b.start(mapping, { instanceId: "dep-3" });
    assert.equal(h.guest.loaded, true);
    assert.equal(h.appReady, false, "app readiness has its own signal and this backend does not guess it");
    assert.equal("attestation" in h, false);
  } finally { await r.cleanup(); }
});

test("a launcher error is an error, and the bundle file never outlives the attempt", async () => {
  const r = await rig({}, { loadError: "monitor refused the bundle" });
  try {
    await assert.rejects(() => r.b.start(mapping, { instanceId: "dep-4" }), /monitor refused the bundle/);
    const left = await fs.readdir(os.tmpdir());
    assert.equal(left.some((n) => n.startsWith("enclave-bundle-")), false, "temp bundle dirs are cleaned up");
  } finally { await r.cleanup(); }
});

test("a missing launcher or guest image refuses before spawning anything", async () => {
  const r = await rig();
  try {
    await fs.rm(path.join(r.dir, "mon.cpio.gz"));
    const pre = await r.b.preflight();
    assert.equal(pre.ok, false);
    await assert.rejects(() => r.b.start(mapping, { instanceId: "dep-5" }), /missing guest initrd/);
  } finally { await r.cleanup(); }
});

test("stop and teardown go through the launcher, and a failure is reported", async () => {
  const r = await rig();
  try {
    const h = await r.b.start(mapping, { instanceId: "dep-6" });
    assert.deepEqual((await r.b.stop(h)).stopped, true);
    assert.equal(r.b.domains.size, 0);
    await r.b.start(mapping, { instanceId: "dep-7" });
    assert.deepEqual(await r.b.teardown(), { removed: 1 });
  } finally { await r.cleanup(); }
});

test("an instanceId is required, and a mapping with no bundle is refused", async () => {
  const r = await rig();
  try {
    await assert.rejects(() => r.b.start(mapping, {}), /unique instanceId is required/);
    await assert.rejects(() => r.b.start({ appId: APPID }, { instanceId: "dep-8" }), /no bundle bytes/);
  } finally { await r.cleanup(); }
});
