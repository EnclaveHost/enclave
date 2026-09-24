// windows/vbslike/review/datapath.test.mjs: the NucBox datapath (enclave-splice/1, windows/vbslike/datapath/datapath.mjs at
// 67354f3b, the guest lane's) under the conditions its own tests do not drive: a first line that arrives in pieces or a
// byte at a time, an oversized first line with no newline, a lookup that throws, the manager's ACTUAL record shape,
// and the id form the manager emits today. Independent review tests (enclave-99, 2026-09-24).
//   run: node --test windows/vbslike/review/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createDataPlane, parsePreamble, admit, PROTO } from "../datapath/datapath.mjs";

const ID = "hv0a1b2c3d", APP = "9c".repeat(32), IMAGE = "44".repeat(32), RT = "cc".repeat(32), KEY = "ab".repeat(32);
const LINE = `${PROTO} id=${ID} app=${APP} image=${IMAGE} runtime=${RT} key=${KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the launcher's relay: echoes what it receives, records it. */
async function relay() {
  const got = []; const srv = net.createServer((s) => { s.on("data", (d) => { got.push(d); s.write(d); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, got, close: () => srv.close() };
}
async function plane(lookup, opts = {}) {
  const dp = createDataPlane({ lookup, preambleTimeoutMs: 800, dialTimeoutMs: 800, idleMs: 2000, ...opts });
  await new Promise((r) => dp.server.listen(0, "127.0.0.1", r));
  return { ...dp, port: dp.server.address().port, close: () => dp.server.close() };
}
function client(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => resolve(s)); s.once("error", reject);
  });
}
const firstLine = (s, ms = 1500) => new Promise((resolve) => { let b = ""; const t = setTimeout(() => resolve(b), ms);
  s.on("data", (d) => { b += d.toString("latin1"); if (b.includes("\n")) { clearTimeout(t); resolve(b.slice(0, b.indexOf("\n"))); } }); s.once("close", () => { clearTimeout(t); resolve(b); }); });

test("a first line that arrives in pieces, or a byte at a time, is still parsed whole and admitted; the bytes after it reach the domain intact", async () => {
  const r = await relay();
  const rec = { status: "running", appId: APP, image: IMAGE, runtimeId: RT, key: KEY, relay: { port: r.port } };
  const dp = await plane(() => rec);
  try {
    for (const pieces of [[LINE.slice(0, 20), LINE.slice(20, 90), LINE.slice(90) + "\n"], [...LINE].map((c) => c).concat(["\n"])]) {
      const s = await client(dp.port);
      for (const p of pieces) { s.write(p); await sleep(2); }
      assert.equal(await firstLine(s), "OK", `pieces=${pieces.length}`);
      const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5]);
      r.got.length = 0; s.write(hello); await sleep(100);
      assert.ok(Buffer.concat(r.got).equals(hello), "the TLS bytes reach the relay byte for byte");
      s.destroy();
    }
    // the first line and the client hello in ONE write: the hello is delivered after OK, not lost and not parsed
    const s = await client(dp.port); r.got.length = 0;
    s.write(Buffer.concat([Buffer.from(LINE + "\n"), Buffer.from("HELLO-AFTER-LINE")]));
    assert.equal(await firstLine(s), "OK"); await sleep(100);
    assert.equal(Buffer.concat(r.got).toString(), "HELLO-AFTER-LINE"); s.destroy();
  } finally { dp.close(); r.close(); }
});

test("an oversized first line with no newline is refused as oversized, not held until the preamble timeout", async () => {
  const dp = await plane(() => null);
  try {
    const s = await client(dp.port); const t0 = Date.now();
    s.write("x".repeat(600));
    const a = await firstLine(s);
    assert.match(a, /^NO .*too long/, a); assert.ok(Date.now() - t0 < 700, "refused at once");
    assert.equal(dp.stats()["refused:oversized"], 1);
  } finally { dp.close(); }
});

test("a lookup that throws is a refusal with the reason, never a crash or an admitted splice", async () => {
  const dp = await plane(() => { throw new Error("manager unreachable"); });
  try {
    const s = await client(dp.port); s.write(LINE + "\n");
    assert.match(await firstLine(s), /^NO the manager could not be asked: manager unreachable/);
    assert.equal(dp.stats()["refused:lookup"], 1); assert.equal(dp.stats().open, 0);
  } finally { dp.close(); }
});

test("admission reads the manager's record as it IS: today's manager record (state, no status, UUID id, no image, no key) admits nothing", () => {
  // the Windows manager's /vms record at 8327498e: { id: uuid, instanceId, appId, recordSha256, componentSha256, policy,
  // catalog, cid, runtimeId, state: "guest-booted" | "failed", appReady, guest, vmName, reason } - no status, no image, no key
  const managerRecord = { id: "3f2a9c1e-5b7d-4e8a-9c1b-2d3e4f5a6b7c", instanceId: "3f2a9c1e5b7d4e8a-9c3d10f1", appId: APP, state: "guest-booted", appReady: false, runtimeId: RT };
  const [outcome] = admit(managerRecord, { app: APP, image: IMAGE, runtime: RT, key: KEY });
  assert.equal(outcome, "refused:not-running", "status is absent, so the route is refused as not running");
  assert.throws(() => parsePreamble(`${PROTO} id=${managerRecord.id} app=${APP} image=${IMAGE} runtime=${RT} key=${KEY}`), /not a partition instance id/,
    "and the manager's UUID id is not an hv id: the supervisor's routeFor would refuse it before this plane is asked");
  // what the view contract the guest lane sent the Windows owner requires of the record, so both sides can be held to it
  const conforming = { status: "running", appId: APP, image: IMAGE, runtimeId: RT, key: KEY, relay: { port: 1 } };
  assert.deepEqual(admit(conforming, { app: APP, image: IMAGE, runtime: RT, key: KEY }), ["", ""]);
  for (const [k, v, why] of [["status", "starting", "refused:not-running"], ["key", "ff".repeat(32), "refused:identity"], ["image", "ee".repeat(32), "refused:identity"], ["relay", null, "refused:no-relay"]])
    assert.equal(admit({ ...conforming, [k]: v }, { app: APP, image: IMAGE, runtime: RT, key: KEY })[0], why, k);
});

test("a splice admitted on a record is ended when the instance is reclaimed, and a second connection is then refused on the fresh lookup", async () => {
  const r = await relay();
  let rec = { status: "running", appId: APP, image: IMAGE, runtimeId: RT, key: KEY, relay: { port: r.port } };
  const dp = await plane(() => rec);
  try {
    const s = await client(dp.port); s.write(LINE + "\n"); assert.equal(await firstLine(s), "OK");
    const closed = new Promise((res) => s.once("close", res));
    rec = { ...rec, status: "failed" }; dp.closeInstance(ID, "domain ended");
    await closed;
    assert.equal(dp.stats()["closed:reclaimed"], 1); assert.equal(dp.stats().open, 0);
    const s2 = await client(dp.port); s2.write(LINE + "\n");
    assert.match(await firstLine(s2), /^NO the instance is failed/); s2.destroy();
  } finally { dp.close(); r.close(); }
});
