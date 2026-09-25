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
    assert.equal(h.launcherVmId, "GUID-7", "the partition the lab launcher's key signs for, from its own load answer");
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

/* ---- defects 2 and 3, against a fake that keeps lab.rs's real facts ---------------------------- *
 *
 * enclave-99's point about the fake above: its `destroy` accepts ANY argument, so the cleanup
 * assertion only ever proved a line was sent. lab.rs parses destroy/stop/kill arguments with
 * s.parse::<u32>(), and answers are one JSON line per command, in order, with NO request ids.
 * These two fakes keep both facts, so the tests can fail. */

/** destroy/stop/kill take a NUMERIC id, exactly as lab.rs does. */
function strictLauncher({ appSha256 = APPID } = {}) {
  const sent = [];
  const live = new Set();
  const make = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdin = { write: (s) => {
      sent.push(s.trim());
      const [cmd, a1] = s.trim().split(/\s+/);
      queueMicrotask(() => {
        if (cmd === "load") {
          live.add(7);
          p.stdout.emit("data", JSON.stringify({ loaded: { id: 7, label: a1, vmId: "GUID-7",
            appSha256, guestId: "g1", guestPort: 8080, tcpPort: 19007 } }) + "\n");
        } else if (cmd === "destroy" || cmd === "stop" || cmd === "kill") {
          if (!/^\d+$/.test(String(a1 ?? ""))) {
            // the real lab.rs answer for a non-numeric argument
            return p.stdout.emit("data", JSON.stringify({ error: "invalid digit found in string" }) + "\n");
          }
          live.delete(Number(a1));
          p.stdout.emit("data", JSON.stringify({ destroyed: Number(a1), guest: { exit: 0 } }) + "\n");
        } else p.stdout.emit("data", JSON.stringify({ ok: true }) + "\n");
      });
    }, end: () => {} };
    queueMicrotask(() => p.stdout.emit("data", JSON.stringify({ ready: true, launcherKey: "k",
      boundary: "t0-hv", initrdSha256: "i", kernelSha256: "k" }) + "\n"));
    return p;
  };
  return { make, sent, live };
}

test("defect 2: after a hash mismatch the partition is destroyed BY ID, not by label", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcsb2-"));
  const exe = path.join(dir, "e.exe"), kernel = path.join(dir, "k"), initrd = path.join(dir, "i");
  for (const f of [exe, kernel, initrd]) await fs.writeFile(f, "x");
  const L = strictLauncher({ appSha256: "ff".repeat(32) });   // disagrees with what we derived
  const b = new HcsPartitionBackend({ exe, kernel, initrd, out: dir, spawnFn: L.make });
  try {
    await assert.rejects(() => b.start({ appId: APPID, bundle: Buffer.from("b") }, { instanceId: "dep0001-708e6409" }),
      /refusing/);
    const destroy = L.sent.find((l) => l.startsWith("destroy"));
    assert.ok(destroy, "a loaded partition must be destroyed when we refuse it");
    assert.equal(destroy, "destroy 7", "by the numeric id the load answer carried, not the label");
    assert.equal(L.live.size, 0, "and the partition is actually gone, not just a line that was sent");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("defect 2: a destroy that FAILS is reported, not swallowed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcsb3-"));
  const exe = path.join(dir, "e.exe"), kernel = path.join(dir, "k"), initrd = path.join(dir, "i");
  for (const f of [exe, kernel, initrd]) await fs.writeFile(f, "x");
  const L = strictLauncher({ appSha256: "ff".repeat(32) });
  // a launcher that refuses every destroy
  const make = () => { const p = L.make(); const w = p.stdin.write;
    p.stdin.write = (s) => { if (s.trim().startsWith("destroy")) { queueMicrotask(() =>
      p.stdout.emit("data", JSON.stringify({ error: "access denied" }) + "\n")); return; } return w(s); }; return p; };
  const b = new HcsPartitionBackend({ exe, kernel, initrd, out: dir, spawnFn: make });
  try {
    const e = await b.start({ appId: APPID, bundle: Buffer.from("b") }, { instanceId: "i1" }).then(() => null, (x) => x);
    assert.ok(e, "it must still refuse the mismatch");
    assert.match(e.message, /could not be destroyed/,
      "a live partition we failed to destroy must be SAID, or it is an orphan nobody knows about");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("defect 3: after a timed-out command, later answers are NOT shifted onto other commands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcsb4-"));
  const exe = path.join(dir, "e.exe"), kernel = path.join(dir, "k"), initrd = path.join(dir, "i");
  for (const f of [exe, kernel, initrd]) await fs.writeFile(f, "x");
  let emit = null;
  const make = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    emit = (o) => p.stdout.emit("data", JSON.stringify(o) + "\n");
    p.stdin = { write: (s) => {
      const [cmd, a1] = s.trim().split(/\s+/);
      if (cmd === "load") return;                       // answer LATE, after the caller gives up
      queueMicrotask(() => emit(cmd === "destroy" ? { destroyed: Number(a1), guest: { exit: 0 } } : { ok: true }));
    }, end: () => {} };
    queueMicrotask(() => emit({ ready: true, launcherKey: "k", boundary: "t0-hv", initrdSha256: "i", kernelSha256: "k" }));
    return p;
  };
  const b = new HcsPartitionBackend({ exe, kernel, initrd, out: dir, spawnFn: make, loadTimeoutMs: 60 });
  try {
    await assert.rejects(() => b.start({ appId: APPID, bundle: Buffer.from("b") }, { instanceId: "i1" }),
      /did not answer within/);
    // the launcher's answer to that load arrives now, long after we gave up on it
    emit({ loaded: { id: 7, label: "i1", vmId: "G", appSha256: APPID, guestPort: 8080, tcpPort: 19007 } });
    await new Promise((r) => setTimeout(r, 20));
    // a NEW command must get ITS OWN answer, not the stale "loaded" line
    const r = await b.stop({ instanceId: "i1", domainId: 7 }).catch((e) => ({ error: e.message }));
    assert.equal(r && r.loaded, undefined,
      `the timed-out load's answer was delivered to stop(): ${JSON.stringify(r)}`);
    assert.ok(r && (r.destroyed === 7 || r.guest || r.ok), `stop got no answer of its own: ${JSON.stringify(r)}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("the handle names the IMAGE it booted, from the launcher's own ready line", async () => {
  // enclave-99 measured this through the real backend: server.mjs copies h.image into the record,
  // but start() never put `image` on the handle, so the record read null and 5d's datapath - which
  // admits on image + transportKeySha256 - could never route. On this tier there is no launch
  // measurement, so the initrd the launcher actually booted IS the guest's identity.
  const r = await rig();
  try {
    const h = await r.b.start({ appId: APPID, bundle: Buffer.from("b") }, { instanceId: "i1" });
    assert.equal(h.image, "i", "the ready line's initrdSha256, not null");
    assert.equal(h.launcherKey, "k", "and the key that signs this domain's documents");
    assert.equal(h.boundary.hostExcluded, false, "still not host-excluded, whatever else it carries");
  } finally { await r.b.close().catch(() => {}); await r.cleanup(); }
});
