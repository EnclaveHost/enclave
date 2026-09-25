// A slot number is unique only WITHIN one ee-host process: ee-host mints app ids from 1 on every
// boot, so after a restart the same numbers name different apps. The node stamps each EnclaveApp
// with the ee-host generation it was opened in and refuses app-scoped commands once that is stale,
// so a slot from a dead ee-host can never reach a new one that has reused the number.
//
// Reproduces the cross-generation aliasing the audit warned about, at the node boundary: open app A
// (slot 3, gen 1); the ee-host restarts (gen -> 2); a stale request/stop on A must NOT send slot 3
// to the new ee-host, where slot 3 is now app B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnclaveApp } from "../windows/node/apprun.mjs";

// A valid empty "200 OK" response frame (status u16 | nheaders u32 | body_len u32), hex on the wire.
const RESP_200 = Buffer.concat([
  (() => { const b = Buffer.alloc(2); b.writeUInt16LE(200, 0); return b; })(),
  Buffer.alloc(4), // 0 headers
  Buffer.alloc(4), // 0 body
]).toString("hex");

// A fake ee-host line protocol that records every command and answers appopen with the next slot.
function fakeHost() {
  const sent = [];
  let nextSlot = 0;
  const hostCmd = async (line) => {
    sent.push(line);
    const [cmd] = line.split(/\s+/);
    if (cmd === "appopen") return `${++nextSlot} 1000 wasi:http`;
    if (cmd === "apphandle") return `${RESP_200} 5`; // valid empty 200 frame, 5us
    if (cmd === "appabi") return "5 3 0";
    return "";
  };
  return { hostCmd, sent, resetSlots: () => { nextSlot = 0; } };
}

test("an app opened in a prior ee-host generation refuses to send its slot to the new one", async () => {
  const h = fakeHost();
  let gen = 1;
  const mk = (id) => new EnclaveApp({ id, cwasmPath: "x.cwasm", hostCmd: h.hostCmd, world: 2, hostGen: () => gen });

  const a = mk("0xAAAA");
  await a.start();
  assert.equal(a.slot, 1, "A got slot 1 in generation 1");
  assert.equal(a.openedGen, 1);

  // A serves fine while its generation is current.
  const ok = await a.handle({ method: "GET", pathRest: "/" });
  assert.equal(ok.status, 200);
  assert.ok(h.sent.some((l) => l.startsWith("apphandle 1 ")), "a live app sends apphandle for its slot");

  // ee-host restarts: the node bumps the generation, and the new ee-host mints slots from 1 again.
  gen = 2;
  h.resetSlots();
  const b = mk("0xBBBB");
  await b.start();
  assert.equal(b.slot, 1, "B reuses the numeric slot 1 in the new generation");

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

  // B, in the current generation, is unaffected and still serves.
  const afterStale = h.sent.length;
  const bok = await b.handle({ method: "GET", pathRest: "/" });
  assert.equal(bok.status, 200);
  assert.ok(h.sent.slice(afterStale).some((l) => l.startsWith("apphandle 1 ")), "B's own apphandle for slot 1 still goes through");

  // alive() also reports a stale app as down.
  assert.equal(await a.alive(), false);
  assert.equal(await b.alive(), true);
});

test("with no hostGen wired the app behaves exactly as before (never stale)", async () => {
  // Backward-compatible: an EnclaveApp constructed without a hostGen function is never considered
  // stale, so existing behaviour is unchanged where the generation is not threaded through.
  const h = fakeHost();
  const a = new EnclaveApp({ id: "0xCCCC", cwasmPath: "x.cwasm", hostCmd: h.hostCmd, world: 2 });
  await a.start();
  assert.equal(a.openedGen, 0);
  const ok = await a.handle({ method: "GET", pathRest: "/" });
  assert.equal(ok.status, 200);
  await a.stop();
  assert.ok(h.sent.some((l) => l.startsWith("appclose 1")), "close is still sent when generation is not tracked");
});

test("the same generation is never treated as stale", async () => {
  const h = fakeHost();
  const gen = 7;
  const a = new EnclaveApp({ id: "0xDDDD", cwasmPath: "x.cwasm", hostCmd: h.hostCmd, world: 2, hostGen: () => gen });
  await a.start();
  assert.equal(a.openedGen, 7);
  for (let i = 0; i < 3; i++) assert.equal((await a.handle({ method: "GET", pathRest: "/" })).status, 200);
  await a.stop();
  assert.ok(h.sent.some((l) => l.startsWith("appclose 1")), "a same-generation app closes normally");
});
