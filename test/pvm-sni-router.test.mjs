// The pVM host's SNI router (shielded/anchor/avf/runner/sni-router.mjs): each app's TLS reaches the slot VM serving its name,
// byte for byte, from the ClientHello on; anything else is closed.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { clientHelloName, createSniRouter } from "../shielded/anchor/avf/runner/sni-router.mjs";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
/** A backend standing in for a slot VM: it keeps what it was sent and closes. */
async function backend() {
  const got = [];
  const srv = net.createServer((c) => { const chunks = []; c.on("data", (b) => { chunks.push(b); if (Buffer.concat(chunks).length >= 5) { got.push(Buffer.concat(chunks)); c.destroy(); } }); c.on("error", () => {}); });
  const port = await listen(srv);
  return { port, got, close: () => srv.close() };
}
const hello = (port, servername) => new Promise((resolve) => {
  const c = tls.connect({ port, host: "127.0.0.1", servername, rejectUnauthorized: false });
  c.on("error", () => resolve()); c.on("close", () => resolve());
});
const raw = (port, bytes, piece = bytes.length) => new Promise((resolve) => {
  const c = net.connect(port, "127.0.0.1");
  c.on("error", () => resolve()); c.on("close", () => resolve());
  c.on("connect", async () => { for (let i = 0; i < bytes.length; i += piece) { c.write(bytes.subarray(i, i + piece)); await new Promise((r) => setTimeout(r, 2)); } });
});

test("each app's ClientHello reaches the slot VM serving its name, whole and unchanged", async () => {
  const a = await backend(), b = await backend();
  const map = { "aaaaaaaa.app.enclave.host": a.port, "bbbbbbbb.app.enclave.host": b.port };   // gitleaks:allow
  const refused = [];
  const r = createSniRouter({ portFor: (n) => map[n] || null, log: (o) => refused.push(o) });
  const port = await listen(r);
  try {
    await hello(port, "aaaaaaaa.app.enclave.host");   // gitleaks:allow
    await hello(port, "BBBBBBBB.app.enclave.host.");  // gitleaks:allow
    assert.equal(a.got.length, 1); assert.equal(b.got.length, 1);
    assert.equal(clientHelloName(a.got[0]).name, "aaaaaaaa.app.enclave.host");   // gitleaks:allow
    assert.equal(clientHelloName(b.got[0]).name, "bbbbbbbb.app.enclave.host", "case and the trailing dot are a name's own");   // gitleaks:allow
    // the same bytes, a few at a time, and re-framed over two records: the same answer, the same bytes forwarded
    const h = a.got[0];
    await raw(port, h, 7);
    assert.ok(a.got[1].equals(h), "a ClientHello arriving in pieces is forwarded whole");
    const body = h.subarray(5), cut = 40;
    const two = Buffer.concat([Buffer.from([0x16, 3, 1, 0, cut]), body.subarray(0, cut), Buffer.from([0x16, 3, 1, (body.length - cut) >> 8, (body.length - cut) & 255]), body.subarray(cut)]);
    assert.equal(clientHelloName(two).name, "aaaaaaaa.app.enclave.host", "a ClientHello over two records");   // gitleaks:allow
    assert.deepEqual(clientHelloName(h.subarray(0, 60)), { need: true });
    // refused: an unknown name, no name, not TLS
    await hello(port, "cccccccc.app.enclave.host");   // gitleaks:allow
    await hello(port, "");
    await raw(port, Buffer.from("GET / HTTP/1.1\r\nHost: aaaaaaaa.app.enclave.host\r\n\r\n"));   // gitleaks:allow
    assert.equal(a.got.length, 2); assert.equal(b.got.length, 1, "nothing else reached a slot VM");
    assert.deepEqual(refused.map((o) => o.why), ["no app served here by that name", "the ClientHello names no server", "not a TLS handshake record"]);
  } finally { r.close(); a.close(); b.close(); }
});

test("a client that never finishes its ClientHello is closed", async () => {
  const a = await backend();
  const r = createSniRouter({ portFor: () => a.port, helloTimeoutMs: 200 });
  const port = await listen(r);
  try {
    const t0 = Date.now();
    await raw(port, Buffer.from([0x16, 3, 1, 0, 200, 1]));
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(a.got.length, 0);
  } finally { r.close(); a.close(); }
});
