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
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EnclaveApp } from "../windows/node/apprun.mjs";
import { makeHostCmd } from "../windows/node/appframe.mjs";

const RESP_200 = Buffer.concat([
  (() => { const b = Buffer.alloc(2); b.writeUInt16LE(200, 0); return b; })(),
  Buffer.alloc(4), Buffer.alloc(4),
]).toString("hex");

// One ee-host process. `port` 0 picks a free port; a restart passes the old one.
async function emuHost({ port = 0, checkEpoch = true, avoidEpoch = 0 } = {}) {
  let epoch; do { epoch = (Math.random() * 0xffffffff) >>> 0; } while (!epoch || epoch === avoidEpoch);
  const apps = new Map();          // id -> world
  const effects = [];              // side effects executed: { cmd, epoch, id }
  const refused = [];              // commands refused for a stale epoch: { cmd, epoch, id }
  const holds = [];
  const conns = new Set();
  let nextId = 0;
  const answer = (line) => {
    const [cmd, ...a] = line.split(" ");
    if (cmd === "appabi") return "ok 5 7 0";
    if (cmd === "appopen") { const id = ++nextId; apps.set(id, Number(a[0])); effects.push({ cmd, epoch, id }); return `ok ${id} 1000 ${epoch}`; }
    if (["apphandle", "apprun", "appstop", "appclose"].includes(cmd)) {
      // ee-host.c: apphandle needs "<epoch> <id> <hex>" ("bad request"), the rest "<epoch> <id>" ("bad id")
      if (!/^\d+$/.test(a[0] || "") || !/^\d+$/.test(a[1] || "") || (cmd === "apphandle" && a.length < 3))
        return cmd === "apphandle" ? "err bad request" : "err bad id";
      const e = Number(a[0]), id = Number(a[1]);
      if (checkEpoch && e !== epoch) { refused.push({ cmd, epoch: e, id }); return "err stale epoch"; }
      if (!apps.has(id)) return "err no such app";
      effects.push({ cmd, epoch: e, id });
      if (cmd === "appstop" || cmd === "appclose") apps.delete(id);
      return cmd === "apphandle" ? `ok ${RESP_200} 5` : "ok";
    }
    return "err unknown command";
  };
  const server = net.createServer((sock) => {
    conns.add(sock); sock.on("close", () => conns.delete(sock)); sock.on("error", () => {});
    let buf = "";
    sock.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const reply = () => sock.write(answer(line) + "\n");
        const h = holds.find((x) => !x.taken && x.pred(line));
        if (h) { h.taken = true; h.arrive(reply); } else reply();
      }
    });
  });
  await new Promise((res, rej) => {
    let tries = 0;
    const go = () => {
      const onErr = (e) => { if (e.code === "EADDRINUSE" && tries++ < 100) setTimeout(go, 10); else rej(e); };
      server.once("error", onErr);
      server.listen(port, "127.0.0.1", () => { server.off("error", onErr); res(); });
    };
    go();
  });
  return {
    epoch, apps, effects, refused, port: server.address().port,
    /** The next command matching `pred` is held: its processing and reply wait for release(). */
    hold(pred) {
      const h = { pred, taken: false };
      h.arrived = new Promise((r) => { h.arrive = (reply) => { h.release = reply; r(); }; });
      holds.push(h);
      return h;
    },
    /** The process is going: it accepts nothing more; connections it already accepted live on. */
    stopListening() { server.close(); },
    close() { server.close(); for (const c of conns) c.destroy(); },
  };
}

// An ee-host restart as the agent does it: the generation is bumped first (start.host), the old
// process stops accepting, and a new one binds the same port with ids from 1 and a new epoch.
async function restart(h1, bumpGen, opts = {}) {
  bumpGen();
  h1.stopListening();
  return await emuHost({ port: h1.port, avoidEpoch: h1.epoch, ...opts });
}

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

async function queuedClose({ checkEpoch }) {
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

  const h2 = await restart(h1, () => { gen = 2; }, { checkEpoch });
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
