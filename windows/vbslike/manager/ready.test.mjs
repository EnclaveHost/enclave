// judgeReadyBody: the readiness answer judged as a DOCUMENT, not as a status code.
//
// These exist because of a measured trap (enclave-99, nucbox-k11, 2026-09-24): on an initrd with no
// /.well-known/enclave-ready route, the request fell through the proxy to the APP, which answered
// 200 with "Hello World!\n". Every one of these cases is a 200 that must NOT read as ready, or a
// non-200 that must be told apart from one that should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeReadyBody } from "./ready.mjs";

const APP = "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45";
const ok = (extra = {}) => JSON.stringify({ ready: true, appId: APP, ...extra });

test("THE TRAP: a 200 carrying the app's own answer is not readiness", () => {
  const r = judgeReadyBody(200, Buffer.from("Hello World!\n"), APP);
  assert.equal(r.ok, false);
  assert.equal(r.retry, false, "this is terminal: the guest has no readiness route, retrying cannot fix it");
  assert.match(r.reason, /not a readiness document/);
  assert.match(r.reason, /reached the APP/, "the reason says what actually happened, so nobody re-derives it");
});

test("a readiness document for this app is the only thing that reads as ready", () => {
  const r = judgeReadyBody(200, Buffer.from(ok()), APP);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test("a readiness document for ANOTHER app is refused", () => {
  const other = "d2c4dfc0".padEnd(64, "0");
  const r = judgeReadyBody(200, Buffer.from(JSON.stringify({ ready: true, appId: other })), APP);
  assert.equal(r.ok, false);
  assert.match(r.reason, /names app d2c4dfc0/);
});

test("ready:false is a retry; a missing or odd ready is not", () => {
  assert.equal(judgeReadyBody(200, Buffer.from(JSON.stringify({ ready: false, appId: APP })), APP).retry, true);
  const missing = judgeReadyBody(200, Buffer.from(JSON.stringify({ appId: APP })), APP);
  assert.equal(missing.ok, false);
  assert.equal(missing.retry, false, "a document that never says ready is not a thing to wait on");
});

test("503 is starting, and is the only status worth retrying", () => {
  const r = judgeReadyBody(503, Buffer.alloc(0), APP);
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
  assert.match(r.reason, /still starting/);
});

test("404 says the guest cannot report readiness at all, and does not read as 'not yet'", () => {
  const r = judgeReadyBody(404, Buffer.from("not found"), APP);
  assert.equal(r.ok, false);
  assert.equal(r.retry, false, "an app that 404s unknown paths would otherwise never become ready");
  assert.match(r.reason, /no \/\.well-known\/enclave-ready route/);
});

test("other statuses are failures that quote what came back", () => {
  assert.match(judgeReadyBody(500, Buffer.from("boom"), APP).reason, /answered 500/);
  assert.match(judgeReadyBody(302, Buffer.alloc(0), APP).reason, /answered 302/);
});

test("a 200 whose body is valid JSON but not an object is refused", () => {
  for (const body of ["null", '"ready"', "[1,2]", "true"]) {
    const r = judgeReadyBody(200, Buffer.from(body), APP);
    assert.equal(r.ok, false, `${body} must not read as ready`);
  }
});

test("appId matching is case-insensitive but not prefix-loose", () => {
  assert.equal(judgeReadyBody(200, Buffer.from(ok({ appId: APP.toUpperCase() })), APP).ok, true);
  assert.equal(judgeReadyBody(200, Buffer.from(ok({ appId: APP.slice(0, 8) })), APP).ok, false,
    "a prefix is not the appId");
});


/* ---- the transport, against a server that frames answers the way the real front does ---------- *
 *
 * enclave-99 found this against the spec: the first get() was hand-rolled and understood only
 * content-length and connection:close. The guest's front is Go net/http, which sends any body over
 * its 2,048-byte buffer with `Transfer-Encoding: chunked`, and the attestation document is about
 * 2,208 bytes. So every REAL document came back with the chunk framing still in it - reported as
 * "the attestation answer is not JSON" - or hung to the attempt timeout on a keep-alive connection.
 *
 * judgeReadyBody tests could never catch it: the defect was in getting the bytes, not judging them.
 * These drive the REAL get() over a real socket against a server that frames the way Go does. The
 * session's agent is the seam, so this needs no TLS and no certificate fixture - and a get() that
 * goes back to hand-rolled parsing fails them. */
import net from "node:net";
import http from "node:http";
import { get } from "./ready.mjs";

/** A session shaped like session_()'s, but over a plain socket. */
function plainSession(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const sock = net.connect(port, "127.0.0.1");
  agent.createConnection = () => sock;
  return { sock, agent, spki: null };
}

function goLikeServer({ big, small }) {
  return net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n\r\n")) >= 0) {
        const path = (buf.slice(0, i).split("\r\n")[0] || "").split(" ")[1] || "";
        buf = buf.slice(i + 4);
        if (path.startsWith("/big")) {
          // chunked, several pieces, NO content-length: Go net/http over its 2048-byte buffer
          let out = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";
          for (let p = 0; p < big.length; p += 900) {
            const part = big.slice(p, p + 900);
            out += `${part.length.toString(16)}\r\n${part}\r\n`;
          }
          sock.write(out + "0\r\n\r\n");
        } else {
          sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(small)}\r\n\r\n${small}`);
        }
      }
    });
  });
}

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

test("a >2 KiB CHUNKED answer is read as JSON, not as chunk framing", async () => {
  const doc = JSON.stringify({ report: { doc: "x".repeat(2400) }, abi: "enclave-domain-abi/2" });
  assert.ok(doc.length > 2048, "the fixture must exceed Go's buffer or it would not be chunked");
  const srv = goLikeServer({ big: doc, small: JSON.stringify({ ready: true }) });
  const port = await listen(srv);
  const sess = plainSession(port);
  try {
    const r = await get(sess, "127.0.0.1", "/big", { timeoutMs: 5000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString("utf8"), doc, "the body must be the document, with no chunk sizes in it");
    JSON.parse(r.body.toString("utf8"));   // the thing that failed against the real domain
    assert.doesNotMatch(r.body.toString("utf8"), /^[0-9a-f]+\r\n/i, "no chunk framing may survive");
  } finally { sess.sock.destroy(); srv.close(); }
});

test("the readiness answer rides the SAME session, keep-alive, right after the big one", async () => {
  const doc = JSON.stringify({ report: { doc: "y".repeat(2400) } });
  const ready = JSON.stringify({ ready: true, appId: APP });
  const srv = goLikeServer({ big: doc, small: ready });
  const port = await listen(srv);
  const sess = plainSession(port);
  try {
    const a = await get(sess, "127.0.0.1", "/big", { timeoutMs: 5000 });
    const b = await get(sess, "127.0.0.1", "/.well-known/enclave-ready", { timeoutMs: 5000 });
    assert.equal(a.status, 200);
    assert.equal(b.body.toString("utf8"), ready, "a second request on one session must work: one key, one session");
    assert.equal(judgeReadyBody(b.status, b.body, APP).ok, true);
  } finally { sess.sock.destroy(); srv.close(); }
});

test("a body over the cap is refused rather than buffered without limit", async () => {
  const srv = goLikeServer({ big: "z".repeat(60000), small: "{}" });
  const port = await listen(srv);
  const sess = plainSession(port);
  try {
    await assert.rejects(() => get(sess, "127.0.0.1", "/big", { timeoutMs: 5000, maxBytes: 4096 }), /cap/);
  } finally { sess.sock.destroy(); srv.close(); }
});

/* ---- the verdict carries the key it was reached on -------------------------------------------- *
 *
 * enclave-99's ask, and it closes a real gap: 5d's splice admits a route on `key=<64hex>` and the
 * /vms view names transportKeySha256, so a manager that verifies a domain and forgets WHICH key it
 * verified it on leaves the data plane nothing to compare against. Re-deriving it from a later
 * handshake is not equivalent - a later handshake is a different session and could be a different
 * peer - which is why one definition is exported and used by the verdict itself. */
import crypto from "node:crypto";
import { transportKeyOf } from "./ready.mjs";

test("the transport key is sha256 of the DER SPKI, lowercase hex, and nothing else", () => {
  const spki = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  const want = crypto.createHash("sha256").update(spki).digest("hex");
  assert.equal(transportKeyOf(spki), want);
  assert.match(transportKeyOf(spki), /^[0-9a-f]{64}$/, "the splice preamble wants 64 lowercase hex");
  // a different key is a different value: this is the whole point of carrying it
  assert.notEqual(transportKeyOf(Buffer.from([1, 2, 3])), transportKeyOf(Buffer.from([1, 2, 4])));
  assert.equal(transportKeyOf(new Uint8Array(spki)), want, "Uint8Array and Buffer agree");
});

test("an absent or empty SPKI is refused rather than hashed into a plausible-looking value", () => {
  assert.throws(() => transportKeyOf(null), /must be bytes/);
  assert.throws(() => transportKeyOf("30590313"), /must be bytes/, "a hex STRING is not the SPKI");
  assert.throws(() => transportKeyOf(Buffer.alloc(0)), /empty/,
    "sha256 of nothing is a valid-looking 64-hex value, and admitting a route on it would be a hole");
});
