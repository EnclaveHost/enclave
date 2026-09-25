// ready.mjs checkAnswer, against a REAL TLS server: the question the manager's answer sweep asks a running domain.
// Same key and a readiness document for this app: ok. Another key: keyChanged. Anything else: not ok, and never a throw.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { selfSigned } from "../windows/node/apptls.mjs";
import { checkAnswer, transportKeyOf } from "../windows/vbslike/manager/ready.mjs";

const APP = "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782";
const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
async function domain(answer) {
  const c = selfSigned("127.0.0.1");
  const s = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
    if (req.url !== "/.well-known/enclave-ready") { res.writeHead(404); return res.end(); }
    const [code, body] = answer(); res.writeHead(code, { "content-type": "application/json" }); res.end(body);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); servers.push(s);
  const key = transportKeyOf(new crypto.X509Certificate(c.cert).publicKey.export({ type: "spki", format: "der" }));
  return { port: s.address().port, key };
}
const READY = () => [200, JSON.stringify({ ready: true, appId: APP })];

test("the verified key still answering, ready for this app: ok", async () => {
  const d = await domain(READY);
  assert.deepEqual(await checkAnswer({ port: d.port, appId: APP, transportKeySha256: d.key, timeoutMs: 3000 }), { ok: true });
});

test("another key (another boot, another domain): keyChanged, naming both hashes", async () => {
  const d = await domain(READY);
  const r = await checkAnswer({ port: d.port, appId: APP, transportKeySha256: "ab".repeat(32), timeoutMs: 3000 });
  assert.equal(r.ok, false); assert.equal(r.keyChanged, true);
  assert.ok(r.reason.includes(d.key) && r.reason.includes("ab".repeat(32)), r.reason);
});

test("the right key but not ready, or the APP's own 200: not ok, not a key change", async () => {
  for (const answer of [() => [503, "{}"], () => [200, "Hello World!"], () => [200, JSON.stringify({ ready: true, appId: "ee".repeat(32) })]]) {
    const d = await domain(answer);
    const r = await checkAnswer({ port: d.port, appId: APP, transportKeySha256: d.key, timeoutMs: 3000 });
    assert.equal(r.ok, false); assert.equal(r.keyChanged, false); assert.ok(r.reason, JSON.stringify(r));
  }
});

test("nothing listening: not ok with the reason, and no throw", async () => {
  const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise((r) => s.close(r));
  const r = await checkAnswer({ port, appId: APP, transportKeySha256: "ab".repeat(32), timeoutMs: 2000 });
  assert.equal(r.ok, false); assert.equal(r.keyChanged, false); assert.match(r.reason, /no TLS session/);
});
