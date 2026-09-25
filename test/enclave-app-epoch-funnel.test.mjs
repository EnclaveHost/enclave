// The two ee-host restart races Codex found in the node-only generation guard, reproduced through
// the REAL transport funnel (appframe.mjs makeHostCmd: serialized, one connection per command)
// against a loopback server that speaks ee-host's app line protocol, epoch included:
//
//   1. deferred open: an appopen reaches the old ee-host, which answers only after the restart.
//      The node used to stamp the generation AFTER the await, so the app looked current and a
//      later appclose <slot> reached the new ee-host's app of the same number.
//   2. queued command: an appclose queued in the funnel before a restart connects to the NEW
//      ee-host after it. No check at EnclaveApp entry can stop a command already in the queue.
//
// The emulator mirrors ee-host.c's check: an id-scoped command must carry the epoch of the boot
// that minted the id, or it is refused before any side effect. Each scenario also runs against the
// same emulator with that check switched off, to show the interleaving is real and reachable
// through the funnel - i.e. that it is the host's refusal, not the test's timing, that saves the
// other tenant.
import { test, after } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { EnclaveApp } from "../windows/node/apprun.mjs";
import { makeHostCmd, parseAppOpenReply } from "../windows/node/appframe.mjs";
import { RESP_200, emuHost, restart, closeAllEmuHosts } from "./helpers/ee-host-emu.mjs";

after(closeAllEmuHosts);

async function deferredOpen({ checkEpoch }) {
  const h1 = await emuHost();
  const hostCmd = makeHostCmd(h1.port, "127.0.0.1", 10_000);
  let gen = 1;
  const mk = (id) => new EnclaveApp({ id, cwasmPath: "x.cwasm", hostCmd, world: 2, hostGen: () => gen });

  const held = h1.hold((l) => l.startsWith("appopen "));
  const a = mk("0xAAAA");
  const aStart = a.start().then(() => "started", (e) => e);
  await held.arrived;                                   // A's open is inside the old ee-host

  const h2 = await restart(h1, () => { gen = 2; }, { checkEpoch });
  const b = mk("0xBBBB");
  const bStart = b.start();                             // queued behind A's open in the funnel

  held.release();                                       // the old ee-host answers A only now
  const aResult = await aStart;
  await bStart;
  await hostCmd("appabi");                              // drain the funnel
  return { h1, h2, a, b, aResult, hostCmd };
}

test("deferred open across a restart: the dead host's slot is never used against the new host", async () => {
  const { h1, h2, a, b, aResult } = await deferredOpen({ checkEpoch: true });
  try {
    assert.ok(aResult instanceof Error && /restarted while this app was being opened/.test(aResult.message),
      `A's start fails once its open straddled a restart (got ${aResult})`);
    assert.equal(a.openedGen, 1, "A is stamped with the generation its open was ISSUED in, not the one current when the reply landed");
    assert.equal(a.slot, 0);
    assert.equal(a.state, "failed");

    assert.equal(b.slot, 1, "B took slot 1 on the new host");
    assert.equal(b.epoch, h2.epoch);

    // A released the slot its open produced, under the OLD epoch; the new host refused it.
    assert.deepEqual(h2.refused, [{ cmd: "appclose", epoch: h1.epoch, id: 1 }]);
    assert.ok(!h2.effects.some((x) => x.epoch === h1.epoch), "the new host executed nothing under the old epoch");
    assert.ok(h2.apps.has(1), "B's slot 1 is intact");
    assert.equal((await b.handle({ method: "GET", pathRest: "/" })).status, 200, "B still serves");

    // A later stop() on A sends nothing: it no longer holds a slot.
    const n = h2.effects.length + h2.refused.length;
    await a.stop();
    assert.equal(h2.effects.length + h2.refused.length, n);
  } finally { h1.close(); h2.close(); }
});

test("deferred open, host epoch check OFF: the same interleaving frees the other tenant (not vacuous)", async () => {
  const { h1, h2, b } = await deferredOpen({ checkEpoch: false });
  try {
    assert.deepEqual(h2.effects.filter((x) => x.cmd === "appclose"), [{ cmd: "appclose", epoch: h1.epoch, id: 1 }],
      "without the host's check, A's release lands on the new host's slot 1");
    assert.ok(!h2.apps.has(1), "... which was B's");
    await assert.rejects(b.handle({ method: "GET", pathRest: "/" }), /no such app/);
  } finally { h1.close(); h2.close(); }
});

async function queuedClose({ checkEpoch = true, forceSame = false } = {}) {
  const h1 = await emuHost();
  const hostCmd = makeHostCmd(h1.port, "127.0.0.1", 10_000);
  let gen = 1;
  const mk = (id) => new EnclaveApp({ id, cwasmPath: "x.cwasm", hostCmd, world: 2, hostGen: () => gen });

  const a = mk("0xAAAA");
  await a.start();
  assert.equal(a.slot, 1);
  assert.equal(a.epoch, h1.epoch);

  // A slow request holds the funnel inside the old host. Behind it, still in generation 1, queue
  // C's open and A's stop - which is NOT stale at entry, so it enqueues appclose <E1> 1.
  const held = h1.hold((l) => l.startsWith("apphandle "));
  const req = a.handle({ method: "GET", pathRest: "/" });
  await held.arrived;
  const c = mk("0xCCCC");
  const cStart = c.start().then(() => "started", (e) => e);
  const aStop = a.stop();

  // forceSame: the new process draws the OLD process's epoch - a forced identity collision.
  const h2 = await restart(h1, () => { gen = 2; }, { checkEpoch, ...(forceSame ? { forceEpoch: h1.epoch } : {}) });
  held.release();                                       // the old host answers the slow request, then is gone
  assert.equal((await req).status, 200);

  // The queue now runs against the NEW host: C's open takes slot 1 there, then A's queued
  // appclose for slot 1 arrives.
  await aStop;
  const cResult = await cStart;
  await hostCmd("appabi");
  return { h1, h2, a, c, cResult };
}

test("queued appclose across a restart: the new host refuses it before acting", async () => {
  const { h1, h2, a, c, cResult } = await queuedClose({ checkEpoch: true });
  try {
    assert.deepEqual(h2.refused, [{ cmd: "appclose", epoch: h1.epoch, id: 1 }], "A's queued appclose reached the new host and was refused");
    assert.ok(!h2.effects.some((x) => x.epoch === h1.epoch), "the new host executed nothing under the old epoch");
    // C's open ran on the new host but was issued in generation 1, so C fails its start and
    // releases the slot under the NEW host's epoch - its own orphan, which the new host accepts.
    assert.ok(cResult instanceof Error && /restarted while this app was being opened/.test(cResult.message));
    assert.deepEqual(h2.effects.map((x) => [x.cmd, x.epoch, x.id]), [["appopen", h2.epoch, 1], ["appclose", h2.epoch, 1]]);
    assert.equal(a.slot, 0); assert.equal(c.slot, 0);
  } finally { h1.close(); h2.close(); }
});

test("queued appclose, host epoch check OFF: it frees the new host's app of that id (not vacuous)", async () => {
  const { h1, h2 } = await queuedClose({ checkEpoch: false });
  try {
    assert.deepEqual(h2.effects.filter((x) => x.cmd === "appclose")[0], { cmd: "appclose", epoch: h1.epoch, id: 1 },
      "without the host's check, A's queued close is executed against the new host's slot 1 (C's)");
  } finally { h1.close(); h2.close(); }
});

test("FORCED SAME EPOCH (the limit an identity check has): a queued appclose lands on the new process's app", async () => {
  // The epoch check can only tell processes apart if their epochs differ. Force the new ee-host to
  // draw the old one's epoch and the queued appclose - which already passed every node-side check
  // before the restart - is accepted and frees the new process's app of that id: the original
  // cross-tenant bug, back. The node's generation filter cannot help, because the command was
  // queued while it was current. This is why the first version's 32-bit epoch with a time/pid
  // fallback was not enough, and why ee-epoch.h draws 128 bits from the OS CSPRNG and fails closed
  // instead of falling back.
  const { h1, h2 } = await queuedClose({ forceSame: true });
  try {
    assert.equal(h2.epoch, h1.epoch, "the collision was forced");
    assert.deepEqual(h2.refused, [], "nothing is refused: the stale command looks current");
    assert.deepEqual(h2.effects.filter((x) => x.cmd === "appclose")[0], { cmd: "appclose", epoch: h1.epoch, id: 1 },
      "A's queued appclose executed against the new process's slot 1 (C's)");
  } finally { h1.close(); h2.close(); }
});

test("the epoch round-trips losslessly: leading zeros and values past 2^53 are echoed byte for byte", async () => {
  for (const forced of ["00000000000000000000000000000001", "0000000000000000000000000000abcd",
                        "ffffffffffffffffffffffffffffffff", "0000000000200000000000000000001f"]) {
    const h = await emuHost({ forceEpoch: forced });
    try {
      const hostCmd = makeHostCmd(h.port, "127.0.0.1", 10_000);
      const app = new EnclaveApp({ id: "0xAB", cwasmPath: "x.cwasm", hostCmd, world: 2, hostGen: () => 1 });
      await app.start();
      assert.equal(app.epoch, forced);
      assert.equal(typeof app.epoch, "string");
      assert.equal((await app.handle({ method: "GET", pathRest: "/" })).status, 200, `${forced}: the host accepted the echoed epoch`);
      await app.stop();
      assert.deepEqual(h.effects.map((x) => [x.cmd, x.epoch]), [["appopen", forced], ["apphandle", forced], ["appclose", forced]]);
      assert.deepEqual(h.refused, []);
    } finally { h.close(); }
  }
});

test("appopen replies are parsed strictly: anything but <id> <load_us> <32 lowercase hex, not zero> is refused", () => {
  const E = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(parseAppOpenReply(`7 1234 ${E}`), { id: 7, loadUs: 1234, epoch: E });
  assert.deepEqual(parseAppOpenReply(`4294967295 0 ${E}`), { id: 4294967295, loadUs: 0, epoch: E });
  for (const [bad, why] of [
    ["1 1000", "old grammar, no epoch"], ["1 1000 12345", "old 32-bit numeric epoch"],
    ["1 1000 4294967295", "old max 32-bit epoch"], [`1 1000 ${E.toUpperCase()}`, "uppercase"],
    [`1 1000 ${E.slice(1)}`, "31 digits"], [`1 1000 ${E}0`, "33 digits"],
    ["1 1000 00000000000000000000000000000000", "all-zero epoch"], [`1 1000 0x${E.slice(2)}`, "0x prefix"],
    [`1 1000 ${E} extra`, "a 4th token"], [`1  1000 ${E}`, "double space"], [`0 1000 ${E}`, "id 0"],
    [`01 1000 ${E}`, "leading zero id"], [`4294967296 1000 ${E}`, "id past u32"], [`-1 1000 ${E}`, "signed id"],
    [`1 -5 ${E}`, "signed load time"], ["", "empty"], [undefined, "undefined"],
  ]) assert.equal(parseAppOpenReply(bad), null, why);
});

test("an ee-host whose RNG failed has no epoch: it opens nothing and every app command is refused", async () => {
  const h = await emuHost({ noEpoch: true });
  try {
    const hostCmd = makeHostCmd(h.port, "127.0.0.1", 10_000);
    const app = new EnclaveApp({ id: "0xAB", cwasmPath: "x.cwasm", hostCmd, world: 2, hostGen: () => 1 });
    await assert.rejects(app.start(), /app epoch unavailable/);
    assert.equal(app.slot, 0);
    const E = "0123456789abcdef0123456789abcdef";
    for (const cmd of [`apphandle ${E} 1 ${RESP_200}`, `apprun ${E} 1`, `appstop ${E} 1`, `appclose ${E} 1`])
      await assert.rejects(hostCmd(cmd), /app epoch unavailable/, cmd);
    assert.deepEqual(h.effects, [], "nothing was opened or acted on");
  } finally { h.close(); }
});

test("an appopen reply with an invalid, zero or old-grammar epoch is refused and nothing is sent under it", async () => {
  const net = await import("node:net");
  for (const reply of ["ok 1 1000", "ok 1 1000 42", "ok 1 1000 00000000000000000000000000000000",
                       "ok 1 1000 0123456789ABCDEF0123456789ABCDEF"]) {
    const got = [];
    const srv = net.createServer((sk) => sk.on("data", (d) => { got.push(String(d).trim()); sk.write(reply + "\n"); }));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const hostCmd = makeHostCmd(srv.address().port, "127.0.0.1", 10_000);
      const app = new EnclaveApp({ id: "0xAB", cwasmPath: "x.cwasm", hostCmd, world: 2, hostGen: () => 1 });
      await assert.rejects(app.start(), /no valid app id and epoch/, reply);
      await app.stop();
      assert.deepEqual(got.map((l) => l.split(" ")[0]), ["appopen"], `${reply}: nothing id-scoped followed`);
    } finally { srv.close(); }
  }
});

test("every id-scoped command carrying a dead boot's epoch is refused through the funnel", async () => {
  const h1 = await emuHost();
  const hostCmd = makeHostCmd(h1.port, "127.0.0.1", 10_000);
  await hostCmd("appopen 2 x.cwasm");
  const h2 = await restart(h1, () => {});
  try {
    const [id, , e2] = (await hostCmd("appopen 2 y.cwasm")).split(" ");
    assert.equal(id, "1");
    for (const cmd of [`apphandle ${h1.epoch} 1 ${RESP_200}`, `apprun ${h1.epoch} 1`, `appstop ${h1.epoch} 1`, `appclose ${h1.epoch} 1`]) {
      await assert.rejects(hostCmd(cmd), /stale epoch/, cmd);
    }
    // the old grammar (no epoch) is refused too: a node older than this ee-host fails closed
    await assert.rejects(hostCmd("appclose 1"), /bad id/);
    assert.ok(h2.apps.has(1), "the new host's app 1 survived all of them");
    assert.equal(await hostCmd(`appclose ${e2} 1`), "", "its own epoch is accepted");
    assert.ok(!h2.apps.has(1));
  } finally { h1.close(); h2.close(); }
});

// apptool.mjs, the hand tool, speaks the same grammar: it prints the epoch from appopen and its
// get/close take "<epoch> <id>", so a hand-driven command against a restarted ee-host fails closed.
const APPTOOL = fileURLToPath(new URL("../windows/node/apptool.mjs", import.meta.url));
const tool = (port, ...args) => new Promise((resolve) => {
  execFile(process.execPath, [APPTOOL, ...args], { env: { ...process.env, HOST_PORT: String(port) }, timeout: 20_000 },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
});

test("apptool: run/get/close carry the epoch; a dead boot's epoch and the old grammar are refused", async () => {
  const h1 = await emuHost();
  let h2;
  try {
    const run = await tool(h1.port, "run", "4", "x.cwasm", "K=V");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, new RegExp(`loaded as app 1 \\(epoch ${h1.epoch}\\)`));
    assert.deepEqual(h1.effects.map((x) => [x.cmd, x.id]), [["appopen", 1], ["apprun", 1]], "apprun went out as apprun <epoch> <id> and was accepted");

    const get = await tool(h1.port, "get", String(h1.epoch), "1", "/");
    assert.equal(get.code, 0, get.out);
    assert.match(get.out, /status 200/);

    const old = await tool(h1.port, "close", "1");
    assert.notEqual(old.code, 0, "close <id> without an epoch is refused as usage");
    assert.ok(h1.apps.has(1));

    h2 = await restart(h1, () => {});
    await tool(h2.port, "open", "2", "y.cwasm");                        // the new boot's app 1
    const stale = await tool(h2.port, "close", String(h1.epoch), "1");
    assert.notEqual(stale.code, 0);
    assert.match(stale.out, /stale epoch/);
    assert.ok(h2.apps.has(1), "the new boot's app 1 survives a close under the old epoch");

    const mine = await tool(h2.port, "close", String(h2.epoch), "1");
    assert.equal(mine.code, 0, mine.out);
    assert.ok(!h2.apps.has(1));
  } finally { h1.close(); h2?.close(); }
});

test("apptool refuses an ee-host that answers appopen without an epoch", async () => {
  const net = await import("node:net");
  const srv = net.createServer((s) => s.on("data", () => s.write("ok 1 1000\n")));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await tool(srv.address().port, "run", "4", "x.cwasm");
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no valid app id and epoch/);
  } finally { srv.close(); }
});
