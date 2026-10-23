// windows/node/origin-request.mjs, and the two relay reads/writes the NucBox lost on 2026-10-23 (apptls.requestCert via
// hvcert.issuer, secrets.mjs secretsExist), over REAL sockets: one name, api.enclave.test, resolved to several loopback
// addresses on one port, each address behaving like one front (resets after TCP, refuses, black-holes the handshake,
// serves a valid certificate, a wrong-name one or a self-signed one). The trust is a test CA made here with openssl and
// installed as the process's DEFAULT trust store (tls.setDefaultCACertificates) - the module is given no `ca` of its own.
// Every key and signature is generated for this run; no user key is read.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { originRequest } from "../windows/node/origin-request.mjs";
import { requestCert, makeCsr, selfSigned } from "../windows/node/apptls.mjs";
import { issuer } from "../windows/node/hvcert.mjs";
import { secretsExist, fetchSecrets } from "../windows/node/secrets.mjs";

const NAME = "api.enclave.test";
const ID = "0x" + "7a".repeat(32);
const ENDPOINT = "https://nucbox.example.test/t/fixture";
const A = { reset: "127.0.0.2", good: "127.0.0.3", hang: "127.0.0.4", wrong: "127.0.0.5", self: "127.0.0.6",
            good2: "127.0.0.7", sentReset: "127.0.0.8", refused: "127.0.0.9" };
const operator = privateKeyToAccount(generatePrivateKey());

let T, PORT, base, ca;
const servers = [], sockets = new Set();
const seen = { conns: {}, hellos: {}, reqs: [] };
let respond = null;                       // (rec, res) => void, per test; null = the default relay answers

const ossl = (args) => execFileSync("openssl", args, { cwd: T, stdio: ["ignore", "ignore", "pipe"] });
function leaf(cn) {
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${cn}.key`]);
  ossl(["req", "-new", "-key", `${cn}.key`, "-subj", `/CN=${cn}`, "-out", `${cn}.csr`]);
  fs.writeFileSync(path.join(T, `${cn}.ext`), `subjectAltName=DNS:${cn}\nextendedKeyUsage=serverAuth\n`);
  ossl(["x509", "-req", "-in", `${cn}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2",
        "-out", `${cn}.pem`, "-extfile", `${cn}.ext`]);
  return { key: fs.readFileSync(path.join(T, `${cn}.key`)), cert: fs.readFileSync(path.join(T, `${cn}.pem`)) };
}

function relay(addr, creds) {
  return https.createServer(creds, (req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const rec = { addr, servername: req.socket.servername, host: req.headers.host, method: req.method, url: req.url,
                    body: Buffer.concat(parts).toString("utf8") };
      seen.reqs.push(rec);
      if (addr === A.sentReset) return req.socket.destroy();          // took the request, then dropped the connection
      if (respond) return respond(rec, res);
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/secrets/exists") return res.end(JSON.stringify({ id: JSON.parse(rec.body).id, exists: true }));
      if (req.url === "/v1/certs/issue") return res.end(JSON.stringify({ name: JSON.parse(rec.body).name, certPem: "FIXTURE-CHAIN", notAfter: "2027-01-21T00:00:00Z", ca: "test", cached: true }));
      res.statusCode = 404; res.end("{}");
    });
  });
}

before(async () => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), "origin-request-"));
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  ossl(["req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=origin-request test CA", "-days", "2", "-out", "ca.pem",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
  ca = fs.readFileSync(path.join(T, "ca.pem"), "utf8");
  tls.setDefaultCACertificates([ca]);
  const ok = leaf(NAME), wrong = leaf("wrong.enclave.test"), self = selfSigned(NAME);
  const tlsFor = { [A.good]: relay(A.good, ok), [A.good2]: relay(A.good2, ok), [A.sentReset]: relay(A.sentReset, ok),
                   [A.wrong]: relay(A.wrong, wrong), [A.self]: relay(A.self, { key: self.key, cert: self.cert }) };
  const front = (addr) => net.createServer((s) => {
    sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {});
    seen.conns[addr] = (seen.conns[addr] || 0) + 1;
    if (addr === A.reset) return s.once("data", (d) => { seen.hellos[addr] = d; s.resetAndDestroy(); });
    if (addr === A.hang) return;                                      // TCP completes; the handshake never does
    tlsFor[addr].emit("connection", s);
  });
  const first = front(A.good);
  await new Promise((r) => first.listen(0, A.good, r));
  PORT = first.address().port;
  servers.push(first);
  for (const addr of [A.reset, A.hang, A.wrong, A.self, A.good2, A.sentReset]) {
    const s = front(addr);
    await new Promise((r, j) => { s.once("error", j); s.listen(PORT, addr, r); });
    servers.push(s);
  }
  base = `https://${NAME}:${PORT}`;
});
after(() => {
  for (const s of sockets) s.destroy();
  for (const s of servers) s.close();
  fs.rmSync(T, { recursive: true, force: true });
});

const lookups = [];
const resolver = (...order) => async (name, opts) => { lookups.push({ name, opts }); return order.map((address) => ({ address, family: 4 })); };
const reset = () => { seen.conns = {}; seen.hellos = {}; seen.reqs = []; respond = null; lookups.length = 0; };
const conns = (addr) => seen.conns[addr] || 0;

test("a front that resets after TCP is skipped: the next address of the SAME name answers, with its SNI and Host", { timeout: 15_000 }, async () => {
  reset();
  assert.equal(await secretsExist({ id: ID, base, lookup: resolver(A.reset, A.good) }), true);
  assert.deepEqual(lookups, [{ name: NAME, opts: { all: true } }]);
  assert.equal(conns(A.reset), 1);
  assert.ok(seen.hellos[A.reset].includes(Buffer.from(NAME)), "the broken front was offered the origin's own SNI");
  assert.equal(seen.reqs.length, 1);
  assert.deepEqual(seen.reqs[0], { addr: A.good, servername: NAME, host: `${NAME}:${PORT}`, method: "POST",
                                   url: "/v1/secrets/exists", body: JSON.stringify({ id: ID }) });
});

test("the certificate request is signed once and the SAME bytes reach the address that connects (hvcert issuer path)", { timeout: 15_000 }, async () => {
  reset();
  const name = "c13d4b6a.app.enclave.test";
  const csr = makeCsr(name);
  const sigs = [];
  const sign = async (m) => { const s = await operator.signMessage({ message: m }); sigs.push({ m, s }); return s; };
  const lookup = resolver(A.reset, A.refused, A.good);
  const issue = issuer({ endpoint: ENDPOINT, sign, base, request: (o) => requestCert({ ...o, lookup }) });
  assert.equal(await issue(name, csr.csrPem, csr.spkiHash), "FIXTURE-CHAIN");
  assert.equal(sigs.length, 1);
  assert.equal(seen.reqs.length, 1);
  const got = JSON.parse(seen.reqs[0].body);
  const ts = Number(sigs[0].m.split(":").pop());
  assert.deepEqual(got, { name, csr: csr.csrPem, endpoint: ENDPOINT, ts, opSig: sigs[0].s });
  assert.equal(sigs[0].m, `enclave-certs-issue:${name}:${ENDPOINT}:${csr.spkiHash}:${ts}`);
  assert.equal(seen.reqs[0].addr, A.good);
  assert.equal(seen.reqs[0].servername, NAME);
});

test("DNS order is kept: a healthy first address is used and nothing else is touched", { timeout: 15_000 }, async () => {
  reset();
  const r = await originRequest(`${base}/v1/secrets/exists`, { method: "POST", body: JSON.stringify({ id: ID }), lookup: resolver(A.good, A.good2) });
  assert.equal(r.status, 200);
  assert.equal(r.address, A.good);
  assert.equal(conns(A.good2), 0);
});

test("every address failing is bounded and stays UNKNOWN (a throw), naming each address", { timeout: 30_000 }, async () => {
  reset();
  await assert.rejects(secretsExist({ id: ID, base, lookup: resolver(A.reset, A.refused) }),
    (e) => /is not known/.test(e.message) && e.message.includes(A.reset) && e.message.includes(A.refused) && /ECONNREFUSED/.test(e.message));
  assert.equal(seen.reqs.length, 0);
  // a black-holed handshake gives up its address after its share, so a later healthy one still answers in time
  reset();
  let t = Date.now();
  const r = await originRequest(`${base}/v1/secrets/exists`, { method: "POST", body: "{}", timeoutMs: 6_000, lookup: resolver(A.hang, A.good) });
  assert.equal(r.address, A.good);
  assert.ok(Date.now() - t < 4_500, `rotated after the hang's share (${Date.now() - t} ms)`);
  // and with nothing healthy the whole request ends at its deadline
  reset();
  t = Date.now();
  await assert.rejects(originRequest(`${base}/x`, { timeoutMs: 3_000, lookup: resolver(A.reset, A.refused, A.hang) }),
    (e) => e.name === "TimeoutError" || e.code === "ORIGIN_UNREACHABLE");
  assert.ok(Date.now() - t < 3_800, `bounded by the 3 s deadline (${Date.now() - t} ms)`);
  assert.equal(seen.reqs.length, 0);
  // and the fetch path keeps refusing to round the wire off to "no secrets"
  await assert.rejects(fetchSecrets({ id: ID, endpoint: ENDPOINT, sign: (m) => operator.signMessage({ message: m }), base, lookup: resolver(A.reset, A.refused) }),
    /could not fetch the secrets .* after 3 tries .*ECONNRESET/);
});

test("an address with a wrong-name or self-signed certificate is refused and NOT routed around", { timeout: 15_000 }, async () => {
  for (const [bad, code] of [[A.wrong, "ERR_TLS_CERT_ALTNAME_INVALID"], [A.self, "DEPTH_ZERO_SELF_SIGNED_CERT"]]) {
    reset();
    await assert.rejects(originRequest(`${base}/v1/secrets/exists`, { method: "POST", body: "{}", lookup: resolver(bad, A.good) }), (e) => e.code === code);
    assert.equal(conns(A.good), 0, `${code}: the healthy address after it was not tried`);
    assert.equal(seen.reqs.length, 0, `${code}: the request was never sent`);
    reset();
    await assert.rejects(secretsExist({ id: ID, base, lookup: resolver(bad, A.good) }), /is not known/);
    assert.equal(seen.reqs.length, 0);
  }
  reset();
  await assert.rejects(originRequest(`${base}/`, { lookup: resolver(A.self, A.wrong) }), (e) => e.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.equal(seen.reqs.length, 0);
});

test("the caller's abort and the deadline end the request; a sent request is never re-sent elsewhere", { timeout: 15_000 }, async () => {
  reset();
  respond = () => {};                                              // takes the request, never answers
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(requestCert({ name: "x.app.enclave.test", csrPem: "csr", spkiHash: "0".repeat(64), endpoint: ENDPOINT,
    sign: (m) => operator.signMessage({ message: m }), base, signal: ac.signal, lookup: resolver(A.good, A.good2) }), (e) => e.name === "AbortError");
  assert.equal(conns(A.good2), 0);
  reset();
  respond = () => {};
  const t = Date.now();
  await assert.rejects(originRequest(`${base}/v1/certs/issue`, { method: "POST", body: "{}", timeoutMs: 800, lookup: resolver(A.good, A.good2) }),
    (e) => e.name === "TimeoutError");
  assert.ok(Date.now() - t < 1_500);
  assert.equal(conns(A.good2), 0);
  // an already-aborted signal asks nobody
  reset();
  await assert.rejects(originRequest(`${base}/`, { signal: AbortSignal.abort(), lookup: resolver(A.good) }), (e) => e.name === "AbortError");
  assert.equal(conns(A.good), 0);
});

test("a connection that dropped AFTER the request was sent is not retried at another address (no duplicate POST)", { timeout: 15_000 }, async () => {
  reset();
  const sign = (m) => operator.signMessage({ message: m });
  await assert.rejects(requestCert({ name: "x.app.enclave.test", csrPem: "csr", spkiHash: "0".repeat(64), endpoint: ENDPOINT, sign, base,
                                     lookup: resolver(A.sentReset, A.good) }), (e) => !e.notSent);
  assert.equal(seen.reqs.length, 1);
  assert.equal(seen.reqs[0].addr, A.sentReset);
  assert.equal(conns(A.good), 0);
});

test("HTTP refusals, backoff and redirects are answers: returned once, never rotated around or followed", { timeout: 15_000 }, async () => {
  const sign = (m) => operator.signMessage({ message: m });
  const cert = (lookup) => requestCert({ name: "x.app.enclave.test", csrPem: "csr", spkiHash: "0".repeat(64), endpoint: ENDPOINT, sign, base, lookup });
  reset();
  respond = (rec, res) => { res.statusCode = 403; res.end(JSON.stringify({ error: "wrong_operator", message: "signed by someone else" })); };
  assert.deepEqual(await cert(resolver(A.good, A.good2)), { ok: false, error: "wrong_operator", why: "signed by someone else" });
  assert.equal(conns(A.good2), 0);
  reset();
  respond = (rec, res) => { res.statusCode = 202; res.end(JSON.stringify({ retryAfterSec: 30 })); };
  assert.equal((await cert(resolver(A.good, A.good2))).retryAfterSec, 30);
  assert.equal(conns(A.good2), 0);
  reset();
  respond = (rec, res) => { res.statusCode = 429; res.end(JSON.stringify({ error: "rate_limited" })); };
  await assert.rejects(secretsExist({ id: ID, base, lookup: resolver(A.good, A.good2) }), /not known \(HTTP 429/);
  assert.equal(conns(A.good2), 0);
  assert.equal(seen.reqs.length, 1);
  reset();
  respond = (rec, res) => { res.statusCode = 307; res.setHeader("location", `https://${NAME}:${PORT}/elsewhere`); res.end(); };
  assert.deepEqual(await cert(resolver(A.good, A.good2)), { ok: false, error: "http_307", why: "" });
  await assert.rejects(secretsExist({ id: ID, base, lookup: resolver(A.good, A.good2) }), /not known \(HTTP 307/);
  assert.equal(seen.reqs.filter((r) => r.url === "/elsewhere").length, 0, "the redirect was not followed");
  assert.equal(conns(A.good2), 0);
  reset();
  respond = (rec, res) => { res.statusCode = 308; res.setHeader("location", "https://evil.example.test/v1/certs/issue"); res.end(); };
  assert.equal((await cert(resolver(A.good))).error, "http_308");
  assert.equal(seen.reqs.length, 1);
});

test("no address, a failed lookup, or a non-http(s) url is an error, never a default", { timeout: 15_000 }, async () => {
  await assert.rejects(originRequest(`${base}/`, { lookup: async () => [] }), (e) => e.code === "ORIGIN_UNREACHABLE");
  await assert.rejects(originRequest(`${base}/`, { lookup: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); } }),
    (e) => e.code === "ENOTFOUND");
  await assert.rejects(originRequest("ftp://api.enclave.test/"), /not an http\(s\) origin/);
  await assert.rejects(originRequest(`https://u:p@${NAME}/`), /credentials/);
});
