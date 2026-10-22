// files/lan-forwarder.mjs on REAL loopback sockets: the forwarder runs with loopback fixture values (listen 127.0.0.1:<free>,
// peer 127.0.0.2, target a fixture server on 127.0.0.1:<free>); clients connect FROM 127.0.0.2 (permitted) or 127.0.0.3
// (denied) by binding their local address (Linux routes all of 127/8 on lo). Its production CLI is never started here:
// this machine holds 192.168.8.249, so only the CLI's refusal of any argument (before it listens) is executed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startForwarder, LISTEN, PEER, TARGET, LIMITS } from "../files/lan-forwarder.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../files/lan-forwarder.mjs");
const closers = [];
after(async () => { for (const c of closers.reverse()) await c(); });
let targetConns = 0;
async function echoTarget() {
  const s = net.createServer((c) => { targetConns++; c.on("data", (b) => c.write(b)); c.on("error", () => {}); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); closers.push(() => new Promise((ok) => { s.close(() => ok()); }));
  return s.address().port;
}
async function forwarder(limits = {}) {
  const tp = await echoTarget();
  const f = startForwarder({ listen: { host: "127.0.0.1", port: 0 }, peer: "127.0.0.2", target: { host: "127.0.0.1", port: tp }, limits: { ...LIMITS, ...limits } });
  await f.ready; closers.push(() => f.close());
  return { f, port: f.address().port };
}
/** connect from `from`, send `data`, collect what comes back until the socket closes or `ms` pass */
function exchange(port, from, data, ms = 1500) {
  return new Promise((ok) => {
    const c = net.connect({ host: "127.0.0.1", port, localAddress: from });
    let got = Buffer.alloc(0), closed = false;
    c.on("connect", () => { if (data) c.write(data); });
    c.on("data", (b) => { got = Buffer.concat([got, b]); });
    c.on("error", () => {});
    c.on("close", () => { closed = true; ok({ got, closed }); });
    setTimeout(() => { if (!closed) { c.destroy(); ok({ got, closed: false }); } }, ms);
  });
}

test("the fixed production values: listen 192.168.8.249:8549 only, peer 192.168.8.238 only, target 127.0.0.1:8549 only; frozen", () => {
  assert.deepEqual([LISTEN.host, LISTEN.port, PEER, TARGET.host, TARGET.port], ["192.168.8.249", 8549, "192.168.8.238", "127.0.0.1", 8549]);
  for (const o of [LISTEN, TARGET, LIMITS]) assert.ok(Object.isFrozen(o));
  assert.deepEqual(LIMITS, { connections: 8, connectMs: 5000, idleMs: 15000, lifetimeMs: 60000, bytesEachWay: 262144 });
  const src = fs.readFileSync(SRC, "utf8");
  assert.doesNotMatch(src, /process\.env|readFileSync|readFile\(|dns|lookup\(/, "no environment, no file, no name resolution");
  assert.match(src, /const f = startForwarder\(\{ log: \(m\) => console\.log\(m\) \}\);/, "the CLI passes ONLY the frozen values");
});

test("the CLI takes no argument: any target/listen/peer override refuses before listening (exit 2)", () => {
  for (const args of [["--target", "10.0.0.1:22"], ["0.0.0.0"], ["--peer", "192.168.8.1"]]) {
    const r = spawnSync(process.execPath, [SRC, ...args], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, FORWARD_TARGET: "10.0.0.1:22", LAN_FORWARDER_LISTEN: "0.0.0.0:8549" } });
    assert.equal(r.status, 2, JSON.stringify(args)); assert.match(r.stderr, /takes no arguments/);
  }
});

test("the permitted peer is forwarded both ways to the fixed target; a denied peer is closed before a byte and never reaches the target", async () => {
  const { f, port } = await forwarder();
  const ok = await exchange(port, "127.0.0.2", "GET /v1/info\r\n");
  assert.equal(ok.got.toString(), "GET /v1/info\r\n", "echoed through the target");
  const before = targetConns;
  const denied = await exchange(port, "127.0.0.3", "POST /v1/lease\r\n");
  assert.equal(denied.got.length, 0); assert.equal(denied.closed, true, "closed at once");
  assert.equal(targetConns, before, "the target never saw the denied peer");
  assert.equal(f.stats.denied, 1); assert.ok(f.stats.accepted >= 1);
});

test("bounds: bytes each way, idle and total time, concurrent connections", async () => {
  const { f, port } = await forwarder({ bytesEachWay: 1024, idleMs: 300, lifetimeMs: 1200, connections: 2 });
  const big = await exchange(port, "127.0.0.2", Buffer.alloc(4096, 0x61), 1500);
  assert.equal(big.closed, true); assert.ok(big.got.length <= 1024, `at most the cap came back (${big.got.length})`); assert.ok(f.stats.capped >= 1);
  const idle = await exchange(port, "127.0.0.2", null, 1500); assert.equal(idle.closed, true, "an idle connection is closed"); assert.ok(f.stats.timedOut >= 1);
  // two held connections fill the limit; a third is dropped
  const hold = [0, 1].map(() => net.connect({ host: "127.0.0.1", port, localAddress: "127.0.0.2" }));
  for (const h of hold) { h.on("error", () => {}); h.setNoDelay(true); }
  await new Promise((ok) => setTimeout(ok, 100));
  const keep = setInterval(() => { for (const h of hold) h.write("k"); }, 100);
  const third = await exchange(port, "127.0.0.2", "x", 250);
  clearInterval(keep); for (const h of hold) h.destroy();
  assert.equal(third.got.length, 0, "the third concurrent connection is refused");
});

test("only IPv4 literals are accepted for listen, peer and target (no names)", () => {
  assert.throws(() => startForwarder({ listen: { host: "localhost", port: 0 }, peer: "127.0.0.2", target: { host: "127.0.0.1", port: 1 } }), /not an IPv4 literal/);
  assert.throws(() => startForwarder({ listen: { host: "127.0.0.1", port: 0 }, peer: "minipc.lan", target: { host: "127.0.0.1", port: 1 } }), /not an IPv4 literal/);
  assert.throws(() => startForwarder({ listen: { host: "127.0.0.1", port: 0 }, peer: "127.0.0.2", target: { host: "relay.example", port: 1 } }), /not an IPv4 literal/);
});
