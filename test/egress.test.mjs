// Authenticated egress tests with a standard SOCKS provider stub and real TCP
// targets. Tenant credentials and DNS/private-address policy stay local.
//
// The PHASE-2 block at the bottom additionally drives a REAL patched wasmtime
// (transparent egress: the -S egress shim) with two unmodified guest components,
// proving an app's raw wasi:sockets / wasi:http outbound is transparently routed
// through this same front — and that the raw bypass is gone. Those tests SKIP
// unless a patched wasmtime is pointed at via $ENCLAVE_EGRESS_WASMTIME, so the pure
// phase-1 suite stays green everywhere.
//
//   run: node --test test/egress.test.mjs
//   run (incl. phase 2): ENCLAVE_EGRESS_WASMTIME=/path/to/wasmtime node --test test/egress.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createEgress, egressToken } from "../egress.js";
import { isBlockedHost, parseIp } from "../net-guard.mjs";

const SECRET = new TextEncoder().encode("test-enclave-secret");

// ---- helpers ---------------------------------------------------------------
function reader(sock) {
  let buf = Buffer.alloc(0); const waiters = [];
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
  sock.on("close", () => { for (const w of waiters.splice(0)) w.reject(new Error("closed")); });
  function pump() { while (waiters.length && buf.length >= waiters[0].n) {
    const w = waiters.shift(); const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(out); } }
  return (n) => new Promise((resolve, reject) => { waiters.push({ n, resolve, reject }); pump(); });
}

// minimal SOCKS5 client: greet -> user/pass auth -> CONNECT. Returns
// { authOk, reply } and leaves `sock` as a raw tunnel on success.
async function socks({ port, user, pass, atyp, host, dport }) {
  const sock = net.connect(port, "127.0.0.1");
  await once(sock, "connect");
  const read = reader(sock);
  sock.write(Buffer.from([0x05, 0x01, 0x02]));                 // one method: user/pass
  const method = await read(2);
  assert.equal(method[0], 0x05);
  if (method[1] === 0xff) return { sock, authOk: false, reply: null };
  const u = Buffer.from(user), p = Buffer.from(pass);
  sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
  const auth = await read(2);
  if (auth[1] !== 0x00) return { sock, authOk: false, reply: null };
  // request
  let addr;
  if (atyp === 0x01) addr = Buffer.from(host.split(".").map(Number));
  else if (atyp === 0x04) { const ip = parseIp(host); addr = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) addr[i] = Number((ip.value >> BigInt((15 - i) * 8)) & 0xffn); }
  else { const h = Buffer.from(host); addr = Buffer.concat([Buffer.from([h.length]), h]); }
  const pb = Buffer.alloc(2); pb.writeUInt16BE(dport);
  sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), addr, pb]));
  // reply length depends on the REPLY's ATYP (success = v6 BND.ADDR), not the
  // request's — read the 4-byte header, then the address+port it announces.
  const head = await read(4);
  const rest = head[3] === 0x04 ? await read(16 + 2)
             : head[3] === 0x03 ? await read((await read(1))[0] + 2)
             : await read(4 + 2);
  return { sock, authOk: true, reply: Buffer.concat([head, rest]) };
}

// A real local SOCKS upstream stands in for the TUNA SDK listener.
async function harness() {
  const echo = net.createServer(s => s.pipe(s)); echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const h = await phase2Harness({host: "127.0.0.1", port: echo.address().port});
  return {...h, teardown() {h.teardown(); echo.close();}};
}

// ---- guardrail 2: SSRF classifier (unit) -----------------------------------
test("net-guard blocks internal ranges, allows global unicast", () => {
  for (const b of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.9.9", "169.254.1.1",
                   "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1",
                   "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
                   "::ffff:127.0.0.1", "::ffff:10.1.2.3", "2001:db8::1", "localhost", "FOO.localhost"])
    assert.equal(isBlockedHost(b), true, `${b} should be blocked`);
  for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111",
                   "2a01:4f9:c013:bdfd::1", "example.com", "api.openai.com"])
    assert.equal(isBlockedHost(a), false, `${a} should be allowed`);
});

// ---- guardrail 1: per-deployment credentials -------------------------------
test("wrong SOCKS password is rejected (tenant isolation)", async () => {
  const h = await harness();
  const { authOk } = await socks({ port: h.socksPort, user: "depA", pass: "not-the-token",
                                   atyp: 0x03, host: "echo.test", dport: 80 });
  assert.equal(authOk, false);
  h.teardown();
});

test("TUNA receives the validated destination without a claimed dedicated source IP", async () => {
  const h = await harness();
  try {
    const {sock, reply, authOk} = await socks({port:h.socksPort, user:"depA", pass:egressToken(SECRET,"depA"), atyp:3, host:"echo.test", dport:80});
    assert.equal(authOk, true); assert.equal(reply[1], 0);
    assert.deepEqual(h.opens.at(-1), {host:"93.184.216.34", port:80});
    assert.equal(reply[3], 1); assert.deepEqual([...reply.subarray(4,8)], [0,0,0,0]); sock.destroy();
  } finally {h.teardown();}
});

// ---- happy path: splice integrity ------------------------------------------
test("bytes round-trip through the tunnel both ways", async () => {
  const h = await harness();
  const { sock, reply } = await socks({ port: h.socksPort, user: "depB", pass: egressToken(SECRET, "depB"),
                                        atyp: 0x03, host: "echo.test", dport: 7 });
  assert.equal(reply[1], 0x00);
  const read = reader(sock);
  sock.write(Buffer.from("hello-egress"));
  const got = await read(12);
  assert.equal(got.toString(), "hello-egress");
  sock.destroy(); h.teardown();
});

// ---- guardrail 2: SSRF at the front (literal internal IP) -------------------
test("CONNECT to a loopback literal is denied before leaving the enclave", async () => {
  const h = await harness();
  const { reply } = await socks({ port: h.socksPort, user: "depA", pass: egressToken(SECRET, "depA"),
                                  atyp: 0x01, host: "127.0.0.1", dport: 22 });
  assert.equal(reply[1], 0x02, "REP should be 0x02 (not allowed)");
  assert.equal(h.opens.length, 0, "denied dst must never reach the relay");
  h.teardown();
});

test("DNS resolving into a private network never reaches TUNA", async () => {
  const h = await harness();
  try {
    const {reply} = await socks({port:h.socksPort, user:"depA", pass:egressToken(SECRET,"depA"), atyp:3, host:"private.test", dport:443});
    assert.equal(reply[1], 2); assert.equal(h.opens.length, 0);
  } finally {h.teardown();}
});

// ===========================================================================
// PHASE 2 — TRANSPARENT EGRESS (real patched wasmtime, unmodified guests)
// ===========================================================================
// These drive an ACTUAL patched wasmtime (`-S egress` shim) so an UNMODIFIED
// app's raw wasi:sockets / wasi:http outbound is transparently routed through
// the SAME front + relay as phase 1 — no ENCLAVE_EGRESS in the guest. They prove:
//   (1) transparent routing carries the authenticated tenant's connection;
//   (2) an internal/loopback destination is refused (SSRF; raw bypass closed);
//   (3) with the network locked down a raw dial reaches nothing directly;
//   (4) the wasi:http outgoing handler is mediated too (socks5h domain path).
// Skipped unless $ENCLAVE_EGRESS_WASMTIME points at a patched binary — the phase-1
// suite above needs no toolchain and stays green everywhere.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WASMTIME = process.env.ENCLAVE_EGRESS_WASMTIME;
const GUEST_TCP = process.env.ENCLAVE_EGRESS_GUEST_TCP || `${HERE}fixtures/egress-guest-tcp.wasm`;
const GUEST_HTTP = process.env.ENCLAVE_EGRESS_GUEST_HTTP || `${HERE}fixtures/egress-guest-http.wasm`;
const GUEST_SOCKS = process.env.ENCLAVE_EGRESS_GUEST_SOCKS || `${HERE}fixtures/egress-guest-socks.wasm`;
const phase2Skip = !WASMTIME ? "set $ENCLAVE_EGRESS_WASMTIME to a patched wasmtime to run phase-2 e2e"
  : ![GUEST_TCP, GUEST_HTTP, GUEST_SOCKS].every((g) => fs.existsSync(g)) ? "guest fixtures missing (test/fixtures/*.wasm)"
  : false;

// A harness whose mock relay dials `dialTarget` for every ALLOWED open (it
// ignores the guest's requested host, exactly like test/egress.test.mjs's echo
// relay) and records SOCKS CONNECT destinations. Reused by the TCP + HTTP guests.
async function phase2Harness(dialTarget) {
  const opens = [], handles = [];
  const provider = net.createServer(socket => {
    handles.push(socket); socket.on("error", () => {});
    (async () => {
      const read = reader(socket);
      assert.deepEqual([...await read(3)], [5,1,0]); socket.write(Buffer.from([5,0]));
      const req = await read(5); assert.deepEqual([...req.subarray(0,4)], [5,1,0,3]);
      const host = (await read(req[4])).toString(), port = (await read(2)).readUInt16BE(0);
      opens.push({host, port});
      const dst = net.connect(dialTarget.port, dialTarget.host); handles.push(dst); dst.on("error", () => socket.destroy());
      await once(dst,"connect"); socket.removeAllListeners("data");
      socket.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));
      socket.pipe(dst).pipe(socket); socket.once("close",()=>dst.destroy()); dst.once("close",()=>socket.destroy());
    })().catch(()=>socket.destroy());
  });
  provider.listen(0,"127.0.0.1"); await once(provider,"listening");
  const egress = createEgress({secret:SECRET, socksPort:0, upstream:`socks5://127.0.0.1:${provider.address().port}`,
    lookup: async host => [{address:host === "private.test" ? "127.0.0.1" : "93.184.216.34"}],
    isKnown:id=>id.startsWith("dep")});
  await egress.start();
  return {socksPort:egress.socksPort(), opens, teardown() {for(const s of handles)s.destroy();provider.close();egress.stop();}};
}

// Spawn `wasmtime run` on a command guest with the given TARGET; capture stdout.
// egressOn injects `-S egress` + the host-side ENCLAVE_EGRESS_CRED (guest-invisible);
// inheritNetwork adds -Sinherit-network (the phase-1 raw path, for the negative);
// enclaveEgress exports the guest-visible ENCLAVE_EGRESS url (the phase-1 explicit path).
function runTcpGuest({ socksPort, id, target, egressOn = true, inheritNetwork = false,
                       guest = GUEST_TCP, enclaveEgress = false, loopbackAllow = null }) {
  const args = ["run", "-Scli", "-Sp3", "-Stcp", "-Sudp", "-Sallow-ip-name-lookup"];
  if (inheritNetwork) args.push("-Sinherit-network");
  if (egressOn) args.push("-S", `egress=127.0.0.1:${socksPort}`);
  // the per-deployment loopback policy (wasm_manager passes this on every launch)
  if (loopbackAllow !== null) args.push("-S", `loopback-allow=${loopbackAllow}`);
  if (enclaveEgress) args.push("--env", `ENCLAVE_EGRESS=socks5h://${id}:${egressToken(SECRET, id)}@127.0.0.1:${socksPort}`);
  args.push("--env", `TARGET=${target}`, guest);
  const env = { ...process.env };
  if (egressOn) env.ENCLAVE_EGRESS_CRED = `${id}:${egressToken(SECRET, id)}`;
  return new Promise((resolve) => {
    const p = spawn(WASMTIME, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 20000);
    p.on("close", () => { clearTimeout(kill); resolve({ out: out.trim(), err: err.trim() }); });
  });
}

test("phase2: transparent egress routes an UNMODIFIED guest's raw wasi:sockets outbound",
  { skip: phase2Skip }, async () => {
  const echo = net.createServer((s) => s.on("data", (d) => s.write(d)));
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const h = await phase2Harness({ host: "127.0.0.1", port: echo.address().port });
  // public literal dest passes SSRF at the front; the mock relay dials the echo
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX", target: "93.184.216.34:80" });
  assert.match(r.out, /^OK ping-egress/, `guest out=${JSON.stringify(r.out)} err=${r.err.slice(0, 200)}`);
  const open = h.opens.at(-1);
  // The authenticated tenant dialed the intended public destination.
  assert.equal(open.host, "93.184.216.34"); assert.equal(open.port, 80);
  echo.close(); h.teardown();
});

test("phase2: a locked-down guest dialing a loopback literal is refused",
  { skip: phase2Skip }, async () => {
  // WHAT REFUSES IT, precisely: not the front (the shim never sends a loopback
  // literal there) and not luck. This test used to dial 127.0.0.1:22 with no
  // loopback policy and assert CONNERR - which held only on a machine with
  // nothing on :22. On a box running sshd the guest CONNECTED and read the
  // banner ("OK SSH-2.0-OpenSSH_10.3"), i.e. the test asserting the raw bypass
  // was closed was itself the demonstration that it was open. The policy is
  // what closes it, so the test now runs the production posture: a tenant is
  // launched with the loopback ports it is allowed, and :22 is not among them.
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });   // never dialed (refused in-process)
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX", target: "127.0.0.1:22",
                                loopbackAllow: h.socksPort });
  assert.match(r.out, /^CONNERR/, `expected a connect error, got ${JSON.stringify(r.out)}`);
  assert.equal(h.opens.filter((o) => o.host === "127.0.0.1").length, 0, "a denied loopback dial must never reach the relay");
  h.teardown();
});

test("phase2: phase-1 explicit SOCKS (ENCLAVE_EGRESS) still works under the lockdown (front pass-through)",
  { skip: phase2Skip }, async () => {
  const echo = net.createServer((s) => s.on("data", (d) => s.write(d)));
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const h = await phase2Harness({ host: "127.0.0.1", port: echo.address().port });
  // The guest dials the loopback FRONT itself and speaks SOCKS5 explicitly —
  // the shim must pass that one destination through (everything else stays
  // mediated), or ENCLAVE_EGRESS would be dead on phase-2 toolchains.
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depS",
                                target: "egress-fixture.test:80", guest: GUEST_SOCKS, enclaveEgress: true });
  const m = r.out.match(/^OK (\S+) (.*)$/);
  assert.ok(m, `expected OK <bnd> <reply>, got out=${JSON.stringify(r.out)} err=${r.err.slice(0, 300)}`);
  // The SOCKS front makes no dedicated source-IP claim.
  assert.equal(m[2], "ping-egress");
  // The authenticated SOCKS request still reaches the selected public destination.
  const open = h.opens.at(-1);
  assert.equal(open.host, "93.184.216.34", "the front resolves and validates the destination before TUNA");
  echo.close(); h.teardown();
});

test("phase2: with egress lockdown and no inherit-network, a raw connect reaches nothing",
  { skip: phase2Skip }, async () => {
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  // egress OFF and inherit-network OFF == the phase-2 run-mode network posture
  // with no egress front reachable: the default socket check denies every dial.
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX", target: "93.184.216.34:80",
                                egressOn: false, inheritNetwork: false });
  assert.match(r.out, /^CONNERR/, `raw dial should be denied, got ${JSON.stringify(r.out)}`);
  assert.equal(h.opens.length, 0, "nothing should reach the relay");
  h.teardown();
});

test("phase2: the wasi:http outgoing handler is mediated too (serve mode, socks5h domain)",
  { skip: phase2Skip }, async () => {
  const target = http.createServer((_req, res) => { res.writeHead(200); res.end("hello-from-target"); });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const h = await phase2Harness({ host: "127.0.0.1", port: target.address().port });
  const servePort = 34000 + Math.floor((Date.now() % 1000));
  const id = "depH";
  const env = { ...process.env, ENCLAVE_EGRESS_CRED: `${id}:${egressToken(SECRET, id)}` };
  // a DOMAIN target exercises the socks5h path (relay-side DNS): the front sends
  // the name, so hyper never resolves it locally.
  const p = spawn(WASMTIME, ["serve", "-Scli", "-Shttp", "-Sp3", "-O", "pooling-allocator=n",
    "-S", `egress=127.0.0.1:${h.socksPort}`, "--env", "TARGET=example.test:80",
    "--addr", `127.0.0.1:${servePort}`, GUEST_HTTP], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serr = ""; p.stderr.on("data", (d) => (serr += d));
  const up = await waitForPort(servePort, 10000);
  let body = "", status = 0;
  if (up) {
    await new Promise((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port: servePort, path: "/", method: "GET" }, (res) => {
        status = res.statusCode; res.on("data", (d) => (body += d)); res.on("end", resolve);
      });
      rq.on("error", () => resolve()); rq.end();
    });
  }
  try { p.kill("SIGKILL"); } catch {}
  target.close(); h.teardown();
  assert.ok(up && status === 200, `serve did not respond (up=${up} status=${status} stderr=${serr.slice(0, 200)})`);
  assert.match(body, /hello-from-target/, "wasi:http response must be proxied through egress");
  const open = h.opens.at(-1);
  assert.equal(open.host, "93.184.216.34", "the validated DNS result reaches TUNA as a literal");
  assert.equal(open.port, 80);
});

function waitForPort(port, ms) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => { s.destroy(); Date.now() - t0 > ms ? resolve(false) : setTimeout(tick, 100); });
    };
    tick();
  });
}

// ===========================================================================
// LOOPBACK POLICY — the cross-tenant wall (`-S loopback-allow`)
// ===========================================================================
// The carve-out that makes /encvol reachable (a literal loopback IP dials
// DIRECT, never through the front) also made every SIBLING TENANT reachable:
// each deployment is its own wasmtime process listening on 127.0.0.1:<its
// port> in ONE shared network namespace, so a guest could connect straight
// into a neighbour's app - around the supervisor's /x/:id, which is where a
// PRIVATE deployment's owner check and the deployer's WAF live. No service can
// close that; another tenant's app is not the platform's to gate.
//
// These drive the REAL patched binary against a REAL listener standing in for
// the neighbour, in both network postures a tenant can be launched with.
async function neighbour() {
  const srv = net.createServer((s) => s.on("data", () => s.write("sibling-data")));
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { srv, port: srv.address().port, close: () => srv.close() };
}

test("loopback policy: a dial to a SIBLING's port is refused (transparent egress on)",
  { skip: phase2Skip }, async () => {
  const nb = await neighbour();
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  // the tenant is allowed exactly one loopback port - not the neighbour's
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX",
                                target: `127.0.0.1:${nb.port}`, loopbackAllow: nb.port + 1 });
  assert.match(r.out, /^CONNERR/, `the sibling dial must fail, got ${JSON.stringify(r.out)}`);
  assert.match(r.out, /not this deployment's to dial|denied|permission/i,
    `the refusal should name the policy, got ${JSON.stringify(r.out)}`);
  assert.equal(h.opens.length, 0, "a refused loopback dial must not reach the relay either");
  nb.close(); h.teardown();
});

test("loopback policy: the ALLOWED loopback port still connects (the /encvol plane)",
  { skip: phase2Skip }, async () => {
  const nb = await neighbour();
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  // /encvol is the one loopback plane a tenant is SUPPOSED to reach: naming it
  // must still work, or the policy would break encrypted volumes
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX",
                                target: `127.0.0.1:${nb.port}`, loopbackAllow: nb.port });
  assert.match(r.out, /^OK sibling-data/, `an allowed dial must connect, got ${JSON.stringify(r.out)} err=${r.err.slice(0, 200)}`);
  nb.close(); h.teardown();
});

test("loopback policy: it holds under -Sinherit-network too (the port-serving posture)",
  { skip: phase2Skip }, async () => {
  // This is the posture the policy exists for: a declared-ports app gets
  // `-Sinherit-network`, which installs an allow-ALL address check. Before the
  // policy there was NOTHING between such a tenant and its neighbours.
  const nb = await neighbour();
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX", target: `127.0.0.1:${nb.port}`,
                                egressOn: false, inheritNetwork: true, loopbackAllow: nb.port + 1 });
  assert.match(r.out, /^CONNERR/, `inherit-network must not exempt loopback, got ${JSON.stringify(r.out)}`);
  nb.close(); h.teardown();
});

test("loopback policy: inherit-network keeps the raw network it was granted",
  { skip: phase2Skip }, async () => {
  // The check REPLACES inherit-network's allow-all, so it must not quietly take
  // away what that flag grants: a non-loopback destination still connects. A
  // local non-loopback address stands in for "off box" so the test stays
  // hermetic. Skipped when the box has no such address.
  const os = await import("node:os");
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) return;   // nothing to bind: no verdict either way
  const srv = net.createServer((s) => s.on("data", () => s.write("off-box")));
  srv.listen(0, lan.address); await once(srv, "listening");
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX",
                                target: `${lan.address}:${srv.address().port}`,
                                egressOn: false, inheritNetwork: true, loopbackAllow: "" });
  assert.match(r.out, /^OK off-box/, `a non-loopback dial must still work, got ${JSON.stringify(r.out)}`);
  srv.close(); h.teardown();
});

test("loopback policy: an empty list means NO loopback at all", { skip: phase2Skip }, async () => {
  // A serve-mode app with neither encrypted volumes nor egress gets an empty
  // list, and that is a real answer, not a missing one.
  const nb = await neighbour();
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX",
                                target: `127.0.0.1:${nb.port}`, egressOn: false,
                                inheritNetwork: true, loopbackAllow: "" });
  assert.match(r.out, /^CONNERR/, `empty must deny, got ${JSON.stringify(r.out)}`);
  nb.close(); h.teardown();
});

test("loopback policy: UNSET leaves the old behaviour (a hand-run wasmtime is unchanged)",
  { skip: phase2Skip }, async () => {
  // The manager passes the flag on every tenant launch; the runtime default
  // stays permissive so the manager's own probe processes - which run wasmtime
  // directly, with no flag - behave exactly as before.
  const nb = await neighbour();
  const h = await phase2Harness({ host: "127.0.0.1", port: 1 });
  const r = await runTcpGuest({ socksPort: h.socksPort, id: "depX",
                                target: `127.0.0.1:${nb.port}`, egressOn: false, inheritNetwork: true });
  assert.match(r.out, /^OK sibling-data/, `unset must not restrict, got ${JSON.stringify(r.out)}`);
  nb.close(); h.teardown();
});
