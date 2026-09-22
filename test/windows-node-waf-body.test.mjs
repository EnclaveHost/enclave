// The request-body limit, over REAL sockets with real chunked encoding.
//
// The bug this exists for: `maxBodyMb` only ever checked the declared content-length, and a
// chunked request declares none. An audit drove Host.proxy against a loopback app with a 1 KB
// limit and a 2 KB body: WITH a content-length it was refused and the app saw nothing; WITHOUT
// one it returned 200 and the app received all 2048 bytes. The app-zone handler made it worse by
// accumulating every chunk with no bound at all, so an endless body could exhaust the agent before
// any rule was consulted.
//
// Two properties are tested here, both end to end rather than by inspection:
//   1. an oversized body never reaches the app, however it is framed;
//   2. an oversized body is never fully HELD - the read stops at the limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Host } from "../windows/node/host.mjs";
import { readBounded, readOrRefuse } from "../windows/node/appzone.mjs";
import { parseWaf, bodyLimit } from "../windows/node/waf.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-body-"));

/** A real loopback app that counts every byte it is given. */
async function app() {
  let received = 0;
  const server = http.createServer(async (req, res) => {
    for await (const c of req) received += c.length;
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, got: () => received, reset: () => { received = 0; },
           close: () => new Promise((r) => server.close(r)) };
}

/** A Host wired to that app with the given rules. */
function boxFor(port, wafRules) {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {} });
  h.records.set("0xaa", { id: "0xaa", status: "running", waf: wafRules });
  h.apps.set("0xaa", { state: "running", port });
  return h;
}

test("an oversized body is refused and the app sees none of it, declared length or not", async () => {
  const a = await app();
  try {
    const h = boxFor(a.port, parseWaf({ maxBodyMb: 0.001 }));           // 1048 bytes
    const body = Buffer.alloc(2048, 0x61);
    for (const [label, headers] of [["no content-length", {}],
                                    ["honest content-length", { "content-length": "2048" }],
                                    ["LYING content-length", { "content-length": "10" }]]) {
      a.reset();
      const r = await h.proxy("0xaa", { method: "POST", pathRest: "/", headers, body, ip: "1.1.1.1" });
      assert.equal(r.status, 413, `${label}: must be refused`);
      assert.equal(a.got(), 0, `${label}: the app must receive nothing`);
      assert.match(String(r.body), /waf_body/);
    }
    // ...and a body INSIDE the limit still reaches the app untouched.
    a.reset();
    const small = Buffer.alloc(512, 0x62);
    const ok = await h.proxy("0xaa", { method: "POST", pathRest: "/", headers: {}, body: small, ip: "1.1.1.1" });
    assert.equal(ok.status, 200);
    assert.equal(a.got(), 512, "a legitimate body is delivered in full");
  } finally { await a.close(); }
});

test("a deployment with NO body rule is not limited by one", async () => {
  const a = await app();
  try {
    const h = boxFor(a.port, parseWaf({ rps: 100 }));      // rules, but nothing about bodies
    const body = Buffer.alloc(64 * 1024, 0x63);
    const r = await h.proxy("0xaa", { method: "POST", pathRest: "/", headers: {}, body, ip: "1.1.1.1" });
    assert.equal(r.status, 200);
    assert.equal(a.got(), 64 * 1024, "the owner asked for no body limit, so there is none");
  } finally { await a.close(); }
});

// ---- the streaming half: what the app zone actually reads -------------------------------------

/** Feed `readBounded` a real chunked stream of `total` bytes in `chunk`-sized pieces. */
async function streamOf(total, chunk = 4096) {
  let left = total;
  return Readable.from((async function* () {
    while (left > 0) { const n = Math.min(chunk, left); left -= n; yield Buffer.alloc(n, 0x64); }
  })());
}

test("the app zone stops reading at the limit instead of buffering past it", async () => {
  const limit = 64 * 1024;
  const r = await readBounded(await streamOf(1024 * 1024, 4096), limit);
  assert.equal(r.over, true, "a 1 MB body under a 64 KB limit is over");
  assert.equal(r.body.length, 0, "and nothing oversized is handed on");
  // The peak held is ONE CHUNK over the cap, not the whole body: that is the memory property.
  assert.ok(r.seen <= limit + 4096, `stopped at ${r.seen} bytes, not ${1024 * 1024}`);
});

test("an endless body is stopped, not accumulated", async () => {
  // The shape that could exhaust the agent: a stream that never ends. It must terminate at the
  // limit rather than run until memory does.
  const endless = Readable.from((async function* () {
    for (;;) yield Buffer.alloc(8192, 0x65);
  })());
  const r = await readBounded(endless, 32 * 1024);
  assert.equal(r.over, true);
  assert.ok(r.seen <= 32 * 1024 + 8192, `stopped at ${r.seen} bytes`);
});

test("a body inside the limit comes back whole and byte-exact", async () => {
  const r = await readBounded(await streamOf(50_000, 4096), 64 * 1024);
  assert.equal(r.over, false);
  assert.equal(r.body.length, 50_000);
  assert.ok(r.body.every((b) => b === 0x64));
});

test("a client that aborts mid-body leaves nothing behind", async () => {
  // Node surfaces an aborted request as an error on the stream. readBounded must not swallow it
  // into a partial body that then gets served to the app as if it were complete.
  const s = Readable.from((async function* () {
    yield Buffer.alloc(1024, 0x66);
    throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  })());
  await assert.rejects(() => readBounded(s, 64 * 1024), /aborted/,
    "an abort propagates rather than becoming a short body the app cannot tell apart");
});

test("an app that answers without end is cut off, not buffered", async () => {
  // The same hole in the other direction: the app's RESPONSE is buffered whole by the proxy, so a
  // tenant whose app streams forever would exhaust the agent and take every OTHER tenant on the
  // box down with it. Its own memory is the enclave's problem; the agent's is this.
  let sent = 0, stopped = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const pump = () => {
      if (stopped || res.destroyed || res.writableEnded) return;
      sent += 65536;
      if (sent > 64 * 1048576 * 4) { stopped = true; try { res.destroy(); } catch {} ; return; }  // test safety net
      if (res.write(Buffer.alloc(65536, 0x67))) setImmediate(pump); else res.once("drain", pump);
    };
    pump();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true,
                         cpuPricePerSec6: 12, log: () => {}, maxBodyMb: 1 });
    h.records.set("0xbb", { id: "0xbb", status: "running" });
    h.apps.set("0xbb", { state: "running", port: server.address().port });
    const r = await h.proxy("0xbb", { method: "GET", pathRest: "/", headers: {}, ip: "1.1.1.1" });
    assert.equal(r.status, 502);
    assert.match(String(r.body), /app_response_too_large/);
    // It stopped near the cap rather than running to the safety net.
    assert.ok(sent < 16 * 1048576, `the proxy pulled ${sent} bytes before cutting off`);
  } finally { stopped = true; await new Promise((r) => server.close(r)); }
});

test("an oversized CHUNKED request gets a real 413 back, with a reason", async () => {
  // THE audit's case, over a real socket with real chunked framing and no content-length at all -
  // the framing under which the limit previously did not exist.
  //
  // What this does NOT test, stated so nobody reads more into it: the close ORDERING. I checked,
  // and the earlier ordering (destroy the request right after res.end) delivers the 413 too on
  // node 22, so this passes either way. The ordering in readOrRefuse is the version that does not
  // depend on a flush winning a race, not a fix for a failure anyone observed.
  let delivered = null;
  const server = http.createServer(async (req, res) => {
    const body = await readOrRefuse(req, res, 1024);
    if (body === null) return;                       // refused: it answered already
    delivered = body.length;
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const post = (bytes, chunked) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/",
                               headers: chunked ? { "transfer-encoding": "chunked" }
                                                : { "content-length": String(bytes) } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") }));
    });
    req.on("error", (e) => resolve({ status: 0, body: `ERROR ${e.code || e.message}` }));
    let left = bytes;
    const pump = () => {
      if (left <= 0) return req.end();
      const n = Math.min(4096, left); left -= n;
      if (req.write(Buffer.alloc(n, 0x68))) setImmediate(pump); else req.once("drain", pump);
    };
    pump();
  });
  try {
    delivered = null;
    const over = await post(64 * 1024, true);       // chunked: NO content-length at all
    assert.equal(over.status, 413, `a chunked oversized body must be told, not reset (got ${over.body})`);
    assert.match(over.body, /waf_body/, "and told WHY");
    assert.equal(delivered, null, "the handler never saw a body");

    delivered = null;
    const ok = await post(512, true);
    assert.equal(ok.status, 200);
    assert.equal(delivered, 512, "a legitimate chunked body still arrives whole");
  } finally { await new Promise((r) => server.close(r)); }
});

test("the limit handed to the app zone is the deployment's own, when it set one", () => {
  assert.equal(bodyLimit(parseWaf({ maxBodyMb: 2 })), 2 * 1048576);
  assert.equal(bodyLimit(parseWaf({ maxBodyMb: 0.001 })), 1049);
  assert.equal(bodyLimit(parseWaf({ rps: 5 })), null, "no body rule means the caller's ceiling applies");
  assert.equal(bodyLimit(null), null);
});
