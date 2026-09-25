// A slot number is unique only WITHIN one ee-host process: ee-host mints app ids from 1 on every
// boot, so after a restart the same numbers name different apps. Two layers keep an id from a dead
// ee-host away from the new one: the node stamps each EnclaveApp with the generation its open was
// issued in and does not send app-scoped commands once that is stale (a local filter), and every
// id-scoped command carries the ee-host's per-boot epoch, which ee-host checks before acting (the
// authority; see enclave-app-epoch-funnel.test.mjs for the restart races through the real funnel).
//
// These tests drive EnclaveApp against an immediate fake host: the audit's cross-generation
// scenario (A at slot 1 gen 1, restart, B at slot 1 gen 2) at the node boundary, and the grammar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnclaveApp } from "../windows/node/apprun.mjs";

// A valid empty "200 OK" response frame (status u16 | nheaders u32 | body_len u32), hex on the wire.
const RESP_200 = Buffer.concat([
  (() => { const b = Buffer.alloc(2); b.writeUInt16LE(200, 0); return b; })(),
  Buffer.alloc(4), // 0 headers
  Buffer.alloc(4), // 0 body
]).toString("hex");

// A fake ee-host line protocol that records every command and answers appopen with the next slot
// and this process's epoch (32 hex digits). `restart()` models a new ee-host process: ids from 1
// again, the next epoch in `epochs`. The defaults carry leading zeros and exceed 2^53, so a node
// that turned the epoch into a Number (or trimmed it) would echo something else.
function fakeHost({ epochs = ["0000000000000000000000000000abcd", "ffffffffffffffffffffffffffffffff"] } = {}) {
  const sent = [];
  let nextSlot = 0;
  const h = {
    sent, epoch: epochs[0], gen: 0,
    hostCmd: async (line) => {
      sent.push(line);
      const [cmd] = line.split(/\s+/);
      if (cmd === "appopen") return `${++nextSlot} 1000 ${h.epoch}`;
      if (cmd === "apphandle") return `${RESP_200} 5`; // valid empty 200 frame, 5us
      if (cmd === "appabi") return "5 3 0";
      return "";
    },
    restart: () => { nextSlot = 0; h.epoch = epochs[++h.gen]; },
  };
  return h;
}

test("an app opened in a prior ee-host generation refuses to send its slot to the new one", async () => {
  const h = fakeHost();
  let gen = 1;
  const mk = (id) => new EnclaveApp({ id, cwasmPath: "x.cwasm", hostCmd: h.hostCmd, world: 2, hostGen: () => gen });

  const a = mk("0xAAAA");
  await a.start();
  assert.equal(a.slot, 1, "A got slot 1 in generation 1");
  assert.equal(a.openedGen, 1);
  assert.equal(a.epoch, "0000000000000000000000000000abcd", "A carries the epoch of the ee-host process that opened it, as the exact string");

  // A serves fine while its generation is current, and its command carries its epoch.
  const ok = await a.handle({ method: "GET", pathRest: "/" });
  assert.equal(ok.status, 200);
  assert.ok(h.sent.some((l) => l.startsWith("apphandle 0000000000000000000000000000abcd 1 ")), "a live app sends apphandle <epoch> <slot>");

  // ee-host restarts: the node bumps the generation, and the new ee-host mints slots from 1 again.
  gen = 2;
  h.restart();
  const b = mk("0xBBBB");
  await b.start();
  assert.equal(b.slot, 1, "B reuses the numeric slot 1 in the new generation");
  assert.equal(b.epoch, "ffffffffffffffffffffffffffffffff");

  // Now a STALE request on A must not reach the new ee-host under slot 1 (which is B).
  const before = h.sent.length;
  const gone = await a.handle({ method: "GET", pathRest: "/" });
  assert.equal(gone.status, 502);
  assert.match(JSON.parse(gone.body.toString()).error, /app_gone/);
  assert.equal(h.sent.length, before, "no command was sent for the stale app");

  // A stop() on the stale app must NOT send appclose/appstop for slot 1 (that would hit B).
  await a.stop();
  assert.equal(h.sent.length, before, "stop sent nothing for a stale slot");
  assert.equal(a.slot, 0, "the stale app is dropped locally");
  assert.equal(a.epoch, "");

  // B, in the current generation, is unaffected and still serves.
  const afterStale = h.sent.length;
  const bok = await b.handle({ method: "GET", pathRest: "/" });
  assert.equal(bok.status, 200);
  assert.ok(h.sent.slice(afterStale).some((l) => l.startsWith("apphandle ffffffffffffffffffffffffffffffff 1 ")), "B's own apphandle for slot 1 goes out under B's epoch");

  // alive() also reports a stale app as down.
  assert.equal(await a.alive(), false);
  assert.equal(await b.alive(), true);
});

test("with no hostGen wired the app is never locally stale, and the epoch still binds its commands", async () => {
  const h = fakeHost({ epochs: ["00000000000000000000000000000077"] });
  const a = new EnclaveApp({ id: "0xCCCC", cwasmPath: "x.cwasm", hostCmd: h.hostCmd, world: 2 });
  await a.start();
  assert.equal(a.openedGen, 0);
  const ok = await a.handle({ method: "GET", pathRest: "/" });
  assert.equal(ok.status, 200);
  await a.stop();
  assert.ok(h.sent.includes("appclose 00000000000000000000000000000077 1"), "close is sent as appclose <epoch> <slot>");
});

test("the same generation is never treated as stale", async () => {
  const h = fakeHost();
  const gen = 7;
  const a = new EnclaveApp({ id: "0xDDDD", cwasmPath: "x.cwasm", hostCmd: h.hostCmd, world: 2, hostGen: () => gen });
  await a.start();
  assert.equal(a.openedGen, 7);
  for (let i = 0; i < 3; i++) assert.equal((await a.handle({ method: "GET", pathRest: "/" })).status, 200);
  await a.stop();
  assert.ok(h.sent.includes("appclose 0000000000000000000000000000abcd 1"), "a same-generation app closes normally");
});

test("an ee-host that returns no epoch is refused: nothing it hands out is used", async () => {
  // An ee-host.exe older than this node answers appopen with "<id> <us>" only. It cannot refuse a
  // stale command, so the node fails the start closed rather than use an unbound id.
  const sent = [];
  const hostCmd = async (line) => { sent.push(line); return line.startsWith("appopen") ? "1 1000" : ""; };
  const a = new EnclaveApp({ id: "0xEEEE", cwasmPath: "x.cwasm", hostCmd, world: 2, hostGen: () => 1 });
  await assert.rejects(a.start(), /no valid app id and epoch/);
  assert.equal(a.slot, 0);
  assert.equal(a.state, "failed");
  const r = await a.handle({ method: "GET", pathRest: "/" });
  assert.equal(r.status, 503, "an app that never got an epoch is not loaded");
  assert.deepEqual(sent.map((l) => l.split(" ")[0]), ["appopen"], "nothing id-scoped was sent");
});

test("a server-shaped app's stop is appstop <epoch> <slot>", async () => {
  const h = fakeHost({ epochs: ["4242424242424242424242424242424f"] });
  const a = new EnclaveApp({ id: "0xFFFF", cwasmPath: "x.cwasm", hostCmd: h.hostCmd, world: 4, port: 1 });
  a.slot = 3; a.epoch = "4242424242424242424242424242424f";   // as start() leaves a running wasi:cli app (its apprun/waitPort need a real port)
  await a.stop();
  assert.deepEqual(h.sent, ["appstop 4242424242424242424242424242424f 3"]);
});
