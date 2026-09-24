// windows/vbslike/review/hcs-cleanup.test.mjs: the HCS backend against the launcher's REAL line protocol.
//
// Independent review tests (enclave-99, 2026-09-24). backend-hcs.test.mjs drives the backend with a fake launcher that
// answers any `destroy <arg>` with success. The launcher it ports (windows/vbslike/host/src/lab.rs at the box's build
// lineage ef1b2077, identical on this branch) does not: `destroy <id>` parses <id> as a u32 and answers
// {"error": ...} for anything else, and it answers strictly one JSON line per command in order, with no request ids.
// This fake keeps those two facts and a set of LIVE partitions, so a cleanup that only looked like one fails here.
//   run: node --test windows/vbslike/review/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HcsPartitionBackend } from "../manager/backend-hcs.mjs";
import { Manager } from "../manager/server.mjs";

const ROOT = new URL("../../../", import.meta.url);
const LAB = fs.readFileSync(new URL("windows/vbslike/host/src/lab.rs", ROOT), "utf8");
const VEC = JSON.parse(fs.readFileSync(new URL("isolation/contract/catalog/derive_vectors.json", ROOT), "utf8"));
const component = Buffer.from(VEC.component_hex, "hex");
const V1 = VEC.ok.find((v) => v.name === "v1");
const APPID = V1.mapping.appId;
const mapping = { appId: APPID, bundle: Buffer.from("ENCLAVE-BUNDLE/1\nfixture"), record: V1.record };

/** lab.rs, kept honest: numeric ids, one answer per command in order, a live set, optional delays. */
function labLauncher({ appSha256 = APPID, delayMs = {}, refuseDestroy = false } = {}) {
  const live = new Map(); let nextId = 1; const sent = [];
  const L = { live, sent, refuseDestroy };
  const make = () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    const answer = (cmd, obj) => setTimeout(() => p.stdout.emit("data", JSON.stringify(obj) + "\n"), delayMs[cmd] || 0);
    const idOf = (s) => (/^\d+$/.test(s) ? Number(s) : null);       // lab.rs: s.parse::<u32>()
    p.stdin = { write: (s) => {
      const line = s.trim(); sent.push(line);
      const [cmd, a1] = line.split(/\s+/);
      if (cmd === "load") { const id = nextId++; live.set(id, a1);
        return answer(cmd, { loaded: { id, label: a1, vmId: `GUID-${id}`, appSha256, guestId: `g${id}`, guestPort: 8080, tcpPort: 19000 + id } }); }
      if (cmd === "destroy" || cmd === "stop" || cmd === "kill") {
        const id = idOf(a1 || "");
        if (id === null) return answer(cmd, { error: "invalid digit found in string" });
        if (!live.has(id)) return answer(cmd, { error: "no such partition" });
        if (L.refuseDestroy) return answer(cmd, { error: "destroy: the partition is busy (HCS_E_OPERATION_PENDING)" });
        if (cmd !== "stop") live.delete(id);
        return answer(cmd, { [cmd === "kill" ? "killed" : cmd === "stop" ? "stopped" : "destroyed"]: a1, guest: { exit: 0 } });
      }
      return answer(cmd, { error: "unknown command" });
    }, end: () => {} };
    queueMicrotask(() => p.stdout.emit("data", JSON.stringify({ ready: true, launcherKey: "k", boundary: "t0-hv", initrdSha256: "i", kernelSha256: "k" }) + "\n"));
    return p;
  };
  L.make = make;
  return L;
}
async function rig(lopts = {}, over = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hcs-review-"));
  for (const f of ["vbslike-host.exe", "wsl-kernel", "mon.cpio.gz"]) await fsp.writeFile(path.join(dir, f), "x");
  const L = labLauncher(lopts);
  const b = new HcsPartitionBackend({ exe: path.join(dir, "vbslike-host.exe"), kernel: path.join(dir, "wsl-kernel"), initrd: path.join(dir, "mon.cpio.gz"), out: dir, spawnFn: L.make, ...over });
  return { b, L, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test("lab.rs still parses the id of destroy/stop/kill as a u32 and answers one line per command (the facts this fake keeps)", () => {
  assert.match(LAB, /let id_of = \|s: &str\| s\.parse::<u32>\(\)/);
  assert.match(LAB, /"destroy" if parts\.len\(\) >= 2 => match id_of\(parts\[1\]\)/);
  assert.match(LAB, /println!\("\{answer\}"\)/);
  assert.doesNotMatch(LAB, /request_id|"req"|correlation/, "no request ids: answers are correlated by order alone");
});

test("HASH AGREEMENT cleanup really destroys the partition: after a guest computed another AppID, no partition is live", async () => {
  const r = await rig({ appSha256: "ff".repeat(32) });
  try {
    await assert.rejects(() => r.b.start(mapping, { instanceId: "dep0001-708e6409" }), /the guest computed ffff/);
    const destroy = r.L.sent.find((s) => s.startsWith("destroy "));
    assert.ok(destroy, "a destroy was sent");
    assert.match(destroy, /^destroy \d+$/, `the launcher takes a numeric id; it was sent ${JSON.stringify(destroy)} and answered "invalid digit found in string"`);
    assert.equal(r.L.live.size, 0, `${r.L.live.size} partition(s) still live after the cleanup that reported nothing`);
  } finally { await r.cleanup(); }
});

test("answers stay correlated after a timeout: a late answer to a timed-out load must not be read as the next command's", async () => {
  const r = await rig({ delayMs: { load: 200, destroy: 50 } }, { loadTimeoutMs: 40 });
  try {
    await assert.rejects(() => r.b.start(mapping, { instanceId: "dep0002-708e6409" }), /did not answer within/);
    await new Promise((res) => setTimeout(res, 300));          // the launcher's real answer arrives after the timeout
    // the partition the launcher loaded is live; stop it by the id the launcher knows
    const res = await r.b.stop({ instanceId: "dep0002-708e6409", domainId: 1 });
    assert.equal(res.stopped, true);
    assert.deepEqual(res.guest, { exit: 0 }, `stop read ${JSON.stringify(res.guest)}: the stale "loaded" line was taken as the destroy's answer`);
    assert.equal(r.L.live.size, 0, "and the partition is gone");
  } finally { await r.cleanup(); }
});

test("the manager's record carries the HCS boundary word and the relay port, and /health says what the boundary is", async () => {
  const r = await rig();
  try {
    const m = new Manager({ backend: r.b, fetchComponent: async () => component, runtimeId: V1.record.runtimeId });
    await m.probe();
    const h = m.health();
    assert.equal(h.canStart, true);
    assert.ok(h.boundary && h.boundary.hostExcluded === false && h.boundary.tier === "t0-hv", `health carries no boundary: ${JSON.stringify(h.boundary)}; the row above it cannot say "host not excluded"`);
    const rec = await m.spawn({ derive: V1.record, name: "0x" + "d3".repeat(32), image: `ipfs://${V1.record.cid}`, appPort: 8080, isPublic: true, hasSecrets: false, id: "dep-3" });
    assert.notEqual(rec.status, "failed", rec.reason);
    assert.ok(rec.boundary && rec.boundary.hostExcluded === false, `the record lost the boundary: ${JSON.stringify(rec.boundary)}`);
    assert.equal(rec.relay && rec.relay.port, 19001, "the host relay port a request reaches the domain through (record.relay), or nothing can route");
    assert.equal(rec.appReady, false);
  } finally { await r.cleanup(); }
});

test("DELETE through the manager with a launcher that cannot destroy a LIVE partition: not ok, not forgotten", async () => {
  const r = await rig();
  try {
    const m = new Manager({ backend: r.b, fetchComponent: async () => component, runtimeId: V1.record.runtimeId });
    const rec = await m.spawn({ derive: V1.record, name: "0x" + "d4".repeat(32), image: `ipfs://${V1.record.cid}`, appPort: 8080, isPublic: true, hasSecrets: false, id: "dep-4" });
    assert.equal(r.L.live.size, 1);
    r.L.refuseDestroy = true;                                     // the launcher answers an error and the partition stays live
    let removed = null, threw = null;
    try { removed = await m.remove(rec.id); } catch (e) { threw = e; }          // a failed stop may be reported by throwing (the owner's shape) or by a non-ok answer
    assert.equal(r.L.live.size, 1, "the partition is still live: the launcher refused");
    assert.ok(threw || (removed && removed !== true && removed.stillListed === true), `remove answered ${JSON.stringify(removed)} for a domain the launcher could not destroy`);
    assert.ok(m.get(rec.id), "the record stays listed while the partition runs: never an orphan the manager no longer lists");
  } finally { await r.cleanup(); }
});
