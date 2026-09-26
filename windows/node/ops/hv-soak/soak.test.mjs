// node --test windows/node/ops/hv-soak/ - the parsers, the thresholds and the summary against fake answers and fake
// JSONL, and the TLS check against a local server whose throwaway certificate is made with openssl at test time.
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULTS, CONSOLE_OK, THRESHOLDS, CMD_LIMIT, minifyPs, remoteCommand, appUrlFor, certFacts, tlsCheck, parseRelayRow, encodeGetCall,
  decodeDeployment, boxScript, parseBoxStdout, consumeChunk, scanLog, consoleScan, pickDeploymentVm, digestBox, newEval, step,
  summarize, newSampler, humanLine, parseArgs, exercised, headSentInWindow, splitHistory, HV_GUARD_NOT_COVERED, OUT_OF_SCOPE_VERDICT,
  BODY_KEEP, ECHO_PATTERN, evidenceRegex, ROOT_MAX, CONSOLE_SEC_MAX, PS_RENAMES, reflectableForms, DUMMY_TOKEN, USER_AGENT,
  wsTunnel, xUrlFor,
} from "./soak.mjs";

test("evidenceRegex: the sentinel's body form, for THIS token only, with stdout n > 0", () => {
  const line = (tok, n) => `hvsoakbody289ec97d2c0e token=${tok} path=/hv-soak/${tok} printed stdout=${n}B stderr=${n}B`;
  const re = evidenceRegex(ECHO_PATTERN, "hvsoakabc");
  assert.equal(re.test(line("hvsoakabc", 57)), true);
  assert.equal(re.test(line("hvsoakabc", 0)), false, "stdout=0B");
  assert.equal(re.test(line("hvsoakabd", 57)), false, "another sample's token");
  assert.equal(re.test("hvsoakabc echoed back"), false, "a reflector");
  assert.equal(re.test(`token=hvsoakabcX path=/ printed stdout=5B`), false, "a longer token is not this one");
  assert.equal(evidenceRegex(ECHO_PATTERN, "a.c").test("token=abc path=/ printed stdout=5B"), false, "the token is escaped");
  assert.throws(() => evidenceRegex("printed stdout=[1-9]", "t"), /must contain \{token\}/);
  // the CLI checks a custom pattern compiles and names the token
  assert.equal(parseArgs(["--echo-pattern", "ok {token} wrote=[1-9]"]).echoPattern, "ok {token} wrote=[1-9]");
  assert.throws(() => parseArgs(["--echo-pattern", "wrote=[1-9]"]), /--echo-pattern: .*\{token\}/);
  assert.throws(() => parseArgs(["--echo-pattern", "{token} ("]), /--echo-pattern/);
  assert.equal(parseArgs([]).echoPattern, ECHO_PATTERN);
});

test("--echo-pattern is refused when the soak's OWN request would satisfy it (a reflector could)", () => {
  // bf's case: the printed-evidence words smuggled into the path, percent-encoded
  const smuggled = "/x?q=token={token}%20path=/%20printed%20stdout=5B";
  assert.throws(() => parseArgs(["--path", smuggled]), /matches what the soak itself sends/);
  assert.throws(() => parseArgs(["--path", "/x?q=token={token}+path=/+printed+stdout=5B"]), /matches what the soak itself sends/, "+ as a space");
  assert.throws(() => parseArgs(["--path", "/token={token}%20path=/a%20printed%20stdout=9B"]), /matches what the soak itself sends/);
  // a pattern the header value alone satisfies
  assert.throws(() => parseArgs(["--echo-pattern", "{token}"]), /matches what the soak itself sends/);
  assert.throws(() => parseArgs(["--echo-pattern", "x-hv-soak: {token}"]), /matches what the soak itself sends/, "the request head");
  // the defaults, and an honest custom pattern with an honest path, pass
  assert.equal(parseArgs([]).echoPattern, ECHO_PATTERN);
  assert.equal(parseArgs(["--path", "/ping?hvsoak={token}"]).path, "/ping?hvsoak={token}");
  assert.equal(parseArgs(["--echo-pattern", "wrote {token} to stdout=[1-9][0-9]*B"]).echoPattern, "wrote {token} to stdout=[1-9][0-9]*B");
  // what is rendered: the path, the token, the request head, raw and decoded
  const forms = reflectableForms(smuggled, "https://31136008.app.enclave.host/");
  assert.equal(forms.length, 5);
  assert.ok(forms.some((f) => f.includes(`token=${DUMMY_TOKEN} path=/ printed stdout=5B`)));
  assert.ok(forms.some((f) => f.includes(`user-agent: ${USER_AGENT}`) && f.includes(`x-hv-soak: ${DUMMY_TOKEN}`)));
});

const DEP = DEFAULTS.deployment;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ---------------------------------------------------------------- TLS against a local server */

function makeCert(dir, cn) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", `/CN=${cn}`, "-addext", `subjectAltName=DNS:${cn}`], { stdio: "ignore" });
  return { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) };
}
let openssl = true;
try { execFileSync("openssl", ["version"], { stdio: "ignore" }); } catch { openssl = false; }

test("tlsCheck: verification is ON - a self-signed leaf is recorded (SPKI, serial, issuer) and no response is counted", { skip: !openssl && "no openssl" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvsoak-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { key, cert } = makeCert(dir, "localhost");
  const seen = [];
  const srv = https.createServer({ key, cert }, (req, res) => {
    seen.push([req.url, req.headers["x-hv-soak"], req.method]);
    if (req.url.startsWith("/echo/")) return res.end(`sentinel saw ${req.headers["x-hv-soak"]}\n`);          // the sentinel echoes the token
    if (req.url.startsWith("/e404/")) { res.statusCode = 404; return res.end(`not here: ${req.headers["x-hv-soak"]}\n`); }   // an error page echoing it
    // the sentinel's own body (enclave-5d, e37a29a91): its statement that it PRINTED; /sent0/ printed nothing to stdout
    if (req.url.startsWith("/sent")) {
      const n = req.url.startsWith("/sent0/") ? 0 : 57;
      if (req.url.startsWith("/sent404/")) res.statusCode = 404;                 // the right words on a wrong answer
      return res.end(`hvsoakbody289ec97d2c0e token=${req.headers["x-hv-soak"]} path=${req.url} printed stdout=${n}B stderr=${n}B\n`);
    }
    if (req.url.startsWith("/late/")) return res.end("x".repeat(BODY_KEEP) + req.headers["x-hv-soak"]);   // past the kept bytes
    res.end("Hello World!\n");                                                                          // hello-world never echoes
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const want = sha(crypto.createPublicKey(key).export({ type: "spki", format: "der" }));

  const bad = await tlsCheck(`https://localhost:${port}/hv-soak/x`, { timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.authorized, false);
  assert.equal(bad.authorizationError, "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.equal(bad.status, null, "no status is read over an unverified connection");
  assert.equal(bad.cert.spkiSha256, want);
  assert.match(bad.cert.issuer, /CN=localhost/);
  assert.ok(bad.cert.serial.length > 0);

  const good = await tlsCheck(`https://localhost:${port}/hv-soak/tok123`, { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tok123" } });
  assert.equal(good.ok, true);
  assert.equal(good.authorized, true);
  assert.equal(good.status, 200);
  assert.equal(good.bytes, 13);
  assert.equal(good.cert.spkiSha256, want);
  assert.ok(Number.isFinite(good.latencyMs));
  assert.deepEqual(seen.at(-1), ["/hv-soak/tok123", "tok123", "GET"], "the token rides in the path and in the header");

  // the HEAD probe: the same verified connection rules, the method reaches the server, no body is read
  const head = await tlsCheck(`https://localhost:${port}/hv-soak/tok456`, { method: "HEAD", timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tok456" } });
  assert.deepEqual([head.ok, head.authorized, head.status, head.bytes], [true, true, 200, 0]);
  assert.deepEqual(seen.at(-1), ["/hv-soak/tok456", "tok456", "HEAD"]);
  const headBad = await tlsCheck(`https://localhost:${port}/`, { method: "HEAD", timeoutMs: 5000 });
  assert.deepEqual([headBad.authorized, headBad.status], [false, null]);

  // the token echo: only a verified 200 whose (bounded) body carries THIS token proves the app's output path ran
  const echo = await tlsCheck(`https://localhost:${port}/echo/tokE`, { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tokE" }, expect: "tokE" });
  assert.deepEqual([echo.ok, echo.bodyHasToken], [true, true]);
  assert.equal(Object.keys(echo).includes("body"), false, "the body itself is never returned");
  const plain = await tlsCheck(`https://localhost:${port}/hv-soak/tokP`, { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tokP" }, expect: "tokP" });
  assert.deepEqual([plain.ok, plain.bodyHasToken], [true, false], "hello-world answers 200 but never echoes");
  const other = await tlsCheck(`https://localhost:${port}/echo/x`, { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tokOLD" }, expect: "tokNEW" });
  assert.equal(other.bodyHasToken, false, "another sample's token is not this one's");
  const late = await tlsCheck(`https://localhost:${port}/late/x`, { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tokL" }, expect: "tokL" });
  assert.deepEqual([late.ok, late.bodyHasToken, late.bytes], [true, false, BODY_KEEP + 4], "only the first BODY_KEEP bytes are kept and searched");
  const e404 = await tlsCheck(`https://localhost:${port}/e404/x`, { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tok4" }, expect: "tok4" });
  assert.deepEqual([e404.authorized, e404.status, e404.bodyHasToken], [true, 404, false], "only a 200's body counts, not an error page that reflects the token");
  const unverified = await tlsCheck(`https://localhost:${port}/echo/tokU`, { timeoutMs: 5000, headers: { "x-hv-soak": "tokU" }, expect: "tokU" });
  assert.deepEqual([unverified.ok, unverified.bodyHasToken], [false, false], "an unverified connection proves nothing");
  assert.equal((await tlsCheck(`https://localhost:${port}/echo/n`, { timeoutMs: 5000, ca: cert })).bodyHasToken, null, "no token asked, no answer");

  // C: the printed evidence, not the token, is what counts: a reflector carries the token and states nothing
  const probe = (p, tok, pattern = ECHO_PATTERN) => tlsCheck(`https://localhost:${port}${p}`,
    { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": tok }, expect: tok, evidence: evidenceRegex(pattern, tok) });
  const sentinel = await probe("/sent/hv-soak/tokS", "tokS");
  assert.deepEqual([sentinel.ok, sentinel.bodyHasToken, sentinel.printedEvidence], [true, true, true]);
  const reflector = await probe("/echo/hv-soak/tokR", "tokR");
  assert.deepEqual([reflector.ok, reflector.bodyHasToken, reflector.printedEvidence], [true, true, false], "a reflector 200 with the token is not printed evidence");
  const silent = await probe("/sent0/hv-soak/tokZ", "tokZ");
  assert.deepEqual([silent.bodyHasToken, silent.printedEvidence], [true, false], "printed stdout=0B is not n > 0");
  const s404 = await probe("/sent404/hv-soak/tok5", "tok5");
  assert.deepEqual([s404.authorized, s404.status, s404.printedEvidence], [true, 404, false], "the printed evidence counts only in a 200");

  // a trusted chain for the WRONG name is refused too: the hostname is verified
  const wrong = await tlsCheck(`https://127.0.0.1:${port}/`, { timeoutMs: 5000, ca: cert });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.authorized, false);
  assert.match(wrong.authorizationError, /ALTNAME|IP/);
});

test("tlsCheck: a refused connection is an error with no certificate", async () => {
  const s = https.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  const r = await tlsCheck(`https://127.0.0.1:${port}/`, { timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.cert, null);
  assert.match(r.error, /ECONNREFUSED/);
});

/* --via x: TLS inside a WebSocket, as through the relay's /x splice. The SERVER side is the real `ws` package (a test
   dependency only; soak.mjs speaks WebSocket with Node built-ins), fronting local TLS servers. */
let WSLib = null;
try { WSLib = await import("ws"); } catch { /* the via-x tests are skipped */ }
const X_HOST = "31136008.app.enclave.host";

async function xFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvsoak-x-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "good")); fs.mkdirSync(path.join(dir, "evil"));
  const good = makeCert(path.join(dir, "good"), X_HOST), evil = makeCert(path.join(dir, "evil"), "evil.example");
  const seen = [];
  const app = (req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, token: req.headers["x-hv-soak"], sni: req.socket.servername });
    res.end(`hvsoakbody289ec97d2c0e token=${req.headers["x-hv-soak"]} path=${req.url} printed stdout=57B stderr=57B\n`);
  };
  const tlsGood = https.createServer(good, app), tlsEvil = https.createServer(evil, app);
  await Promise.all([tlsGood, tlsEvil].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
  const net = await import("node:net"), http = await import("node:http");
  const wss = new WSLib.WebSocketServer({ noServer: true, perMessageDeflate: false });
  const conns = [];
  const front = http.createServer();
  front.on("upgrade", (req, socket, head) => {
    const p = req.url;
    if (p.startsWith("/t/busy/")) { socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n"); return; }
    const to = p === `/t/nucbox-k11/x/${DEP}/https` ? tlsGood : p === `/t/evilnode/x/${DEP}/https` ? tlsEvil : p === "/echo" || p === "/hole" ? p : null;
    if (!to) { socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c = { closed: false, pongs: 0 }; conns.push(c);
      ws.on("close", () => { c.closed = true; });
      ws.on("pong", () => { c.pongs++; });
      if (to === "/hole") return;                                            // accepts, then says nothing
      if (to === "/echo") { ws.ping("hi"); ws.on("message", (m) => ws.send(m, { binary: true })); return; }
      const tcp = net.connect(to.address().port, "127.0.0.1");
      const stream = WSLib.createWebSocketStream(ws);
      stream.pipe(tcp).pipe(stream);
      stream.on("error", () => tcp.destroy()); tcp.on("error", () => stream.destroy());
    });
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  t.after(() => { front.close(); tlsGood.close(); tlsEvil.close(); wss.close(); });
  const base = `ws://127.0.0.1:${front.address().port}`;
  return { good, evil, seen, conns, base, xGood: xUrlFor(base.replace(/^ws/, "http"), "nucbox-k11", DEP) };
}

test("--via x: a verified 200 through the WebSocket - same TLS facts, SNI and Host the app's name, printed evidence", { skip: (!openssl && "no openssl") || (!WSLib && "no ws"), timeout: 20000 }, async (t) => {
  const f = await xFixture(t);
  assert.equal(f.xGood, `${f.base}/t/nucbox-k11/x/${DEP}/https`);
  const r = await tlsCheck(`https://${X_HOST}/hv-soak/tokX`, { timeoutMs: 5000, ca: f.good.cert, tunnel: wsTunnel(f.xGood),
    headers: { "x-hv-soak": "tokX" }, expect: "tokX", evidence: evidenceRegex(ECHO_PATTERN, "tokX") });
  assert.deepEqual([r.ok, r.authorized, r.status, r.bodyHasToken, r.printedEvidence], [true, true, 200, true, true]);
  assert.equal(r.cert.spkiSha256, sha(crypto.createPublicKey(f.good.key).export({ type: "spki", format: "der" })));
  assert.match(r.cert.issuer, new RegExp(`CN=${X_HOST.replace(/\./g, "\\.")}`));
  assert.deepEqual(f.seen.at(-1), { method: "GET", url: "/hv-soak/tokX", host: X_HOST, token: "tokX", sni: X_HOST });
  const h = await tlsCheck(`https://${X_HOST}/hv-soak/tokH`, { method: "HEAD", timeoutMs: 5000, ca: f.good.cert, tunnel: wsTunnel(f.xGood), headers: { "x-hv-soak": "tokH" } });
  assert.deepEqual([h.ok, h.status, h.bytes, f.seen.at(-1).method], [true, 200, 0, "HEAD"]);
});

test("--via x: an unverified leaf gives no status; a trusted leaf for the wrong name is refused too", { skip: (!openssl && "no openssl") || (!WSLib && "no ws"), timeout: 20000 }, async (t) => {
  const f = await xFixture(t);
  const n = f.seen.length;
  const r = await tlsCheck(`https://${X_HOST}/hv-soak/tokU`, { timeoutMs: 5000, tunnel: wsTunnel(f.xGood), headers: { "x-hv-soak": "tokU" }, expect: "tokU",
    evidence: evidenceRegex(ECHO_PATTERN, "tokU") });
  assert.deepEqual([r.ok, r.authorized, r.authorizationError, r.status, r.printedEvidence], [false, false, "DEPTH_ZERO_SELF_SIGNED_CERT", null, false]);
  assert.equal(r.cert.spkiSha256, sha(crypto.createPublicKey(f.good.key).export({ type: "spki", format: "der" })), "the leaf is still recorded");
  assert.equal(f.seen.length, n, "nothing reached the app over an unverified connection's response path that was counted");
  const evilX = xUrlFor(f.base.replace(/^ws/, "http"), "evilnode", DEP);
  const w = await tlsCheck(`https://${X_HOST}/`, { timeoutMs: 5000, ca: f.evil.cert, tunnel: wsTunnel(evilX) });
  assert.deepEqual([w.ok, w.authorized, w.status], [false, false, null]);
  assert.match(w.authorizationError, /ALTNAME/, "the hostname is verified against the app's name inside the splice");
});

test("--via x: a WebSocket the relay refuses (503, 404) is a public failure with its status; a silent splice times out and is closed", { skip: (!openssl && "no openssl") || (!WSLib && "no ws"), timeout: 20000 }, async (t) => {
  const f = await xFixture(t);
  const busy = await tlsCheck(`https://${X_HOST}/`, { timeoutMs: 5000, ca: f.good.cert, tunnel: wsTunnel(xUrlFor(f.base.replace(/^ws/, "http"), "busy", DEP)) });
  assert.deepEqual([busy.ok, busy.status, busy.wsStatus, busy.cert], [false, null, 503, null]);
  assert.match(busy.error, /websocket refused \(HTTP 503\)/);
  const nf = await tlsCheck(`https://${X_HOST}/`, { timeoutMs: 5000, tunnel: wsTunnel(`${f.base}/nowhere`) });
  assert.deepEqual([nf.ok, nf.wsStatus], [false, 404]);
  const hole = await tlsCheck(`https://${X_HOST}/`, { timeoutMs: 1200, tunnel: wsTunnel(`${f.base}/hole`) });
  assert.equal(hole.ok, false);
  assert.match(hole.error, /timeout after 1200 ms/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.conns.at(-1).closed, true, "the abandoned splice is closed, not leaked");
  const refused = await tlsCheck(`https://${X_HOST}/`, { timeoutMs: 3000, tunnel: wsTunnel("ws://127.0.0.1:1/x") });
  assert.match(refused.error, /websocket: .*ECONNREFUSED/);
});

test("wsTunnel: frames of every length form round-trip through a real ws server; pings are answered", { skip: !WSLib && "no ws", timeout: 20000 }, async (t) => {
  const f = await xFixture(t);
  const d = await wsTunnel(`${f.base}/echo`)(new AbortController().signal);
  const parts = [crypto.randomBytes(10), crypto.randomBytes(300), crypto.randomBytes(70000)];
  const want = Buffer.concat(parts);
  let got = Buffer.alloc(0);
  const done = new Promise((r, j) => {
    const timer = setTimeout(() => j(new Error(`only ${got.length} of ${want.length} bytes came back`)), 5000);
    d.on("data", (c) => { got = Buffer.concat([got, c]); if (got.length >= want.length) { clearTimeout(timer); r(); } });
    d.on("error", (e) => { clearTimeout(timer); j(e); });
  });
  for (const p of parts) d.write(p);
  await done;
  assert.equal(Buffer.compare(got, want), 0);
  assert.ok(f.conns.at(-1).pongs >= 1, "the server's ping got a pong");
  d.destroy();
});

test("--via x: a relay slow to upgrade is left at the request's timeout, not when its 101 finally comes", { timeout: 20000 }, async (t) => {
  const http = await import("node:http");
  const ev = [];
  const srv = http.createServer();
  srv.on("upgrade", (req, socket) => {
    const t0 = Date.now();
    let left = false;
    const gone = () => { if (!left) { left = true; ev.push(["client left", Date.now() - t0]); } };
    socket.on("end", gone); socket.on("close", gone);
    socket.resume();                                   // an upgrade socket is handed over paused: read, to see the client go
    setTimeout(() => { if (!socket.destroyed) { ev.push(["101 sent", Date.now() - t0]); socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n"); } }, 2500);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const r = await tlsCheck(`https://${X_HOST}/`, { timeoutMs: 800, tunnel: wsTunnel(`ws://127.0.0.1:${srv.address().port}/x`) });
  assert.match(r.error, /timeout after 800 ms/);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(ev[0]?.[0], "client left", `the handshake was aborted with the request: ${JSON.stringify(ev)}`);
  assert.ok(ev[0][1] < 2000, `left at ${ev[0][1]} ms`);
});

test("wsTunnel: a 101 with the wrong Sec-WebSocket-Accept, or an extension nobody asked for, is refused", { timeout: 20000 }, async (t) => {
  const http = await import("node:http");
  let mode = "accept";
  const srv = http.createServer();
  srv.on("upgrade", (req, socket) => {
    const ok = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.end("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n"
      + (mode === "accept" ? "sec-websocket-accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n" : `sec-websocket-accept: ${ok}\r\nsec-websocket-extensions: permessage-deflate\r\n`) + "\r\n");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const url = `ws://127.0.0.1:${srv.address().port}/x`;
  await assert.rejects(wsTunnel(url)(new AbortController().signal), /wrong Sec-WebSocket-Accept/);
  mode = "ext";
  await assert.rejects(wsTunnel(url)(new AbortController().signal), /an extension nobody asked for/);
});

test("certFacts: the SPKI hash is over the DER SubjectPublicKeyInfo, not the certificate", { skip: !openssl && "no openssl" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvsoak-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { key, cert } = makeCert(dir, "a.example");
  const f = certFacts(new crypto.X509Certificate(cert));
  assert.equal(f.spkiSha256, sha(crypto.createPublicKey(key).export({ type: "spki", format: "der" })));
  assert.notEqual(f.spkiSha256, new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase());
  assert.equal(f.subject, "CN=a.example");
});

/* ---------------------------------------------------------------- relay row */

const ROW = { endpoint: "tunnel://nucbox-k11", name: "nucbox-k11", lastSeen: 1790386391, tunnel: true, mode: "hv-node", attach: "attestation",
  tier: "hv-node", hvNode: { hostExcluded: false, verifiedAt: "2026-09-26T01:33:11.151Z" }, serving: false, eligible: false,
  ineligible: "host-attested boot state", availability: { claimScope: "owner-only", owners: ["0x389C3f030a209D04D026228D2D053fEB75DbadcA"], apps: { running: 1 } } };
const relayBody = (row) => ({ updatedAt: "2026-09-26T01:33:21.000Z", enclaves: [{ name: "other" }, ...(row ? [row] : [])] });

test("parseRelayRow: the owner-only hv-node row is ok, and each required field is checked", () => {
  const f = parseRelayRow(relayBody(ROW), "nucbox-k11");
  assert.equal(f.ok, true);
  assert.equal(f.attached, true);
  assert.equal(f.lastSeenAgeSec, 10);
  assert.deepEqual(f.owners, ["0x389c3f030a209d04d026228d2d053feb75dbadca"]);
  assert.equal(f.eligible, false);
  for (const [mut, why] of [
    [{ mode: "metal" }, "mode"], [{ tier: "t0" }, "tier"], [{ attach: "token" }, "attach"], [{ tunnel: false }, "tunnel"],
    [{ hvNode: { hostExcluded: true } }, "hostExcluded true"], [{ hvNode: {} }, "hostExcluded missing"],
    [{ availability: { claimScope: "open" } }, "claimScope"],
  ]) assert.equal(parseRelayRow(relayBody({ ...ROW, ...mut }), "nucbox-k11").ok, false, why);
  assert.deepEqual(parseRelayRow(relayBody(null), "nucbox-k11"), { ok: false, present: false, updatedAt: "2026-09-26T01:33:21.000Z" });
  assert.equal(parseRelayRow({}, "nucbox-k11").ok, false);
});

/* ---------------------------------------------------------------- chain */

test("decodeDeployment: reads the static head of get(bytes32)'s tuple (it has dynamic strings)", () => {
  const w = (x) => BigInt(x).toString(16).padStart(64, "0");
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  const head = [DEP.slice(2), addr("0x389C3f030a209D04D026228D2D053fEB75DbadcA"), w(17 * 32), w(18 * 32), w(19 * 32), w(0), w(10), w(0),
    w(1), w(1), w(1790384307), w(1), w(46400), w(3600), DEFAULTS.enclaveId.slice(2), addr("0x389C3f030a209D04D026228D2D053fEB75DbadcA"), w(1790388031)];
  const hex = "0x" + w(32) + head.join("") + w(0) + w(0) + w(0);
  const d = decodeDeployment(hex);
  assert.deepEqual(d, { owner: "0x389c3f030a209d04d026228d2d053feb75dbadca", active: true, rate: 1, balance6: 46400, spent6: 3600,
                        runnerIsBox: true, leaseUntil: "2026-09-26T02:00:31.000Z" });
  assert.throws(() => decodeDeployment("0x" + w(32)), /short/);
  assert.equal(encodeGetCall(DEP), "0x8eaa6ac0" + DEP.slice(2));
});

/* ---------------------------------------------------------------- the box script is read-only */

const P = { root: DEFAULTS.root, managerPort: 8091, deployment: DEP, nodeFrom: 0, managerFrom: 0, cap: 4 << 20, consoleSec: 25, consoleMaxBytes: 1 << 20 };

test("boxScript: nothing in it changes the box", () => {
  const s = boxScript(P);
  const verbs = [...s.matchAll(/\b([A-Z][a-z]+)-([A-Z][A-Za-z]+)\b/g)].map((m) => `${m[1]}-${m[2]}`);
  const allowed = new Set(["Invoke-WebRequest", "ConvertFrom-Json", "Where-Object", "Get-VMComPort", "New-Object", "Get-VM", "ForEach-Object",
                           "Get-CimInstance", "Join-Path", "ConvertTo-Json"]);
  assert.deepEqual([...new Set(verbs)].filter((v) => !allowed.has(v)), [], "only reading cmdlets");
  assert.doesNotMatch(s, /-Method\b|FileAccess\]::(Write|ReadWrite)|PipeDirection\]::(Out|InOut)|Set-|Remove-|Stop-|Start-|Restart-|\bdel\b|\bmkdir\b/);
  assert.match(s, /\[IO\.FileAccess\]::Read,/);
  assert.match(s, /\[IO\.Pipes\.PipeDirection\]::In,/);
  assert.equal((s.match(/\[IO\.File\]::Open\(/g) || []).length, 1, "one way to open a file: OpenR, for READ");
  assert.match(s, /function OpenR\(\[string\]\$p\) \{ \[IO\.File\]::Open\(\$p, \[IO\.FileMode\]::Open, \[IO\.FileAccess\]::Read, /);
  assert.match(s, /\$_\.status -eq 'running' -and \$_\.guest/, "the console is opened only once the manager's start capture is done");
  assert.doesNotMatch(s, /state\\|operator\.key|proof\.key|delegations/i, "never near the key directory");
});

test("boxScript: refuses inputs that would change what it reads", () => {
  assert.throws(() => boxScript({ ...P, root: "C:\\x'; Remove-Item C:\\ -Recurse; '" }), /root/);
  assert.throws(() => boxScript({ ...P, deployment: "0x12" }), /deployment/);
  assert.throws(() => boxScript({ ...P, nodeFrom: -5 }), /nodeFrom/);
  assert.throws(() => boxScript({ ...P, managerFrom: 1.5 }), /managerFrom/);
  assert.match(boxScript({ ...P, nodeFrom: 12345 }), /\$NodeFrom = \[long\]12345;/);
});

test("the ssh command CARRIES the script (gzipped, minified): nothing is read from stdin, and it fits cmd.exe's 8191", () => {
  // the largest offsets a 12 h run can reach still fit
  const script = boxScript({ ...P, nodeFrom: 99_999_999_999, managerFrom: 99_999_999_999 });
  const cmd = remoteCommand(script);
  assert.ok(cmd.length < CMD_LIMIT, `${cmd.length}`);
  assert.equal(CMD_LIMIT, 8191);
  const boot = Buffer.from(cmd.split(" ").pop(), "base64").toString("utf16le");
  assert.doesNotMatch(boot, /\[Console\]::In/, "no stdin read");
  assert.doesNotMatch(minifyPs(script), /\[Console\]::In/, "the script reads no stdin either");
  const z = boot.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
  assert.equal(zlib.inflateRawSync(Buffer.from(z, "base64")).toString("utf8"), minifyPs(script), "the payload is exactly the minified script");
  assert.match(boot, /\[IO\.Compression\.DeflateStream\]::new\(.*,\[IO\.Compression\.CompressionMode\]0\)/, "raw DEFLATE with a TYPED mode (a string is ambiguous on the box)");
  // minifying drops only comment lines and indentation
  assert.equal(minifyPs("  # a comment\n  $a = 1\n\n    if ($a) { 'x' }  \n"), "$a = 1\nif ($a) { 'x' }");
  assert.throws(() => remoteCommand(script + "\n$z = '" + crypto.randomBytes(6000).toString("hex") + "'"), /over cmd\.exe's 8191/);
});

// a deterministic stream of characters --root allows, so the worst case does not compress away
function rootOf(n, seed = 1) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ._-\\";
  let x = seed, s = "C:\\";
  while (s.length < n) { x = (x * 1103515245 + 12345) % 2147483648; s += a[x % a.length]; }
  return s.replace(/\\+$/, "x");
}

test("the longest allowed --root, the largest offsets and the longest window still fit cmd.exe's 8191", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const root = rootOf(ROOT_MAX, seed);
    assert.equal(root.length, ROOT_MAX);
    const s = boxScript({ ...P, root, managerPort: 65535, nodeFrom: Number.MAX_SAFE_INTEGER, managerFrom: Number.MAX_SAFE_INTEGER, consoleSec: CONSOLE_SEC_MAX });
    const n = remoteCommand(s).length;
    assert.ok(n < CMD_LIMIT, `seed ${seed}: ${n}`);
  }
  // one character longer is refused where it is given, never truncated
  assert.throws(() => boxScript({ ...P, root: rootOf(ROOT_MAX + 1) }), /at most 64 characters/);
  assert.throws(() => parseArgs(["--root", rootOf(ROOT_MAX + 1)]), /--root must be a local absolute path of at most 64/);
  assert.equal(parseArgs(["--root", rootOf(ROOT_MAX)]).root.length, ROOT_MAX);
  assert.throws(() => parseArgs(["--root", "\\\\server\\share\\x"]), /--root/);
  assert.throws(() => parseArgs(["--console-sec", String(CONSOLE_SEC_MAX + 1)]), /at most 120/);
});

test("minifyPs renames to short names: unique per namespace ignoring case, no long name left, no clash with the source", () => {
  const s = minifyPs(boxScript(P));
  for (const long of Object.keys(PS_RENAMES)) {
    const re = long.startsWith("$") ? new RegExp(`\\$${long.slice(1)}\\b`, "i") : new RegExp(`\\b${long}\\b`);
    assert.doesNotMatch(s, re, long);
  }
  for (const isVar of [true, false]) {
    const shorts = Object.entries(PS_RENAMES).filter(([k]) => k.startsWith("$") === isVar).map(([, v]) => v.toLowerCase());
    assert.equal(new Set(shorts).size, shorts.length);
  }
  assert.throws(() => minifyPs("$zc = 1\n$con = 2"), /already names \$zc/, "a short name the source already uses");
  assert.throws(() => minifyPs("$Con = 1"), /still names \$con/, "a differently-cased long name the rename missed");
  assert.equal(minifyPs('function Emit([string]$s) { }\nEmit "$Port/x"'), 'function ZE([string]$s) { }\nZE "$zh/x"', "inside strings too");
});

test("boxScript: every Hyper-V call is bounded, and the script ends its own process", () => {
  const s = boxScript(P);
  assert.match(s, /Bounded \{ param\(\$n\) \(Get-VMComPort -VMName \$n -Number 1\)\.Path \} \$vmName 15000/);
  assert.match(s, /Bounded \{ @\(Get-VM \|/);
  assert.equal((s.match(/Get-VM(ComPort)?\b/g) || []).length, 2, "no unbounded Hyper-V call");
  assert.match(s, /Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 10/);
  assert.match(s, /-TimeoutSec 20/);
  assert.match(s.trim(), /\[Environment\]::Exit\(0\)$/);
});

test("parseBoxStdout: the last HVSOAK1 line, not READY and not the noise around it", () => {
  const out = "** WARNING: post-quantum\nHVSOAK1-READY console\n#< CLIXML\nHVSOAK1 {\"v\":1,\"a\":2}\r\n";
  assert.deepEqual(parseBoxStdout(out), { ok: true, data: { v: 1, a: 2 } });
  assert.equal(parseBoxStdout("HVSOAK1-READY console\n").ok, false);
  assert.match(parseBoxStdout("HVSOAK1 {bad").error, /unparseable/);
});

/* ---------------------------------------------------------------- logs and console */

const NODE_LOG = [
  "01:28:14 [node] [host] registry: listed as https://api.enclave.host/t/nucbox-k11 price 12/sec cpu",
  "01:28:38 [node] [host] 0x31136008 isolation spawned: hvc8633f status=running image=b7ba7731",
  "01:28:45 [node] [host] 0x31136008 isolation adopted: hvc8633f status=running image=b7ba7731",
  "01:30:31 [node] [host] 0x31136008 isolated domain retired (forced relaunch)",
  "Fri 09/25/2026 18:31:27.49 [run] agent.mjs exited -1; restarting in 10 s ",
  "01:33:07 [node] [host] 0x31136008 isolation: manager: this tier refuses what it cannot verify",
  "01:40:00 [node] [host] registry: card price now 0/sec (was 12) tx=0xabc",
  "01:41:00 [node] [host] renewed 0x31136008",
  "01:41:01 [node] [host] renewed 0x99999999",
  "01:42:00 [node] [host] 0x31136008 isolation held, not renewed: boundary",
  "01:43:00 [node] [host] 0x31136008 renew failed: Error: nonce too low",
  "01:44:00 [node] [host] 0x99999999 isolation spawned: hv1 status=running",
  "",
].join("\r\n");

test("scanLog: the markers the soak counts, for THIS deployment where it matters", () => {
  const c = scanLog(NODE_LOG, { deployment: DEP, token: "hvsoakZZ" });
  assert.equal(c.lines, 12);
  assert.equal(c.restart, 2, "spawned + retired for 0x31136008; the other deployment's spawn is not ours");
  assert.equal(c.cardPrice, 1);
  assert.equal(c.renewed, 2);
  assert.equal(c.renewedMine, 1);
  assert.equal(c.notRenewed, 1);
  assert.equal(c.renewFailed, 1);
  assert.equal(c.procRestarts, 1);
  assert.equal(c.errorLines, 1);
  assert.equal(c.refusLines, 1);
  assert.equal(c.tokenHits, 0);
  assert.equal(scanLog(NODE_LOG + "01:50:00 GET /hv-soak/hvsoakZZ\n", { deployment: DEP, token: "hvsoakZZ" }).tokenHits, 1);
  assert.equal(c.restartLines.length, 2);
});

test("consumeChunk: only complete lines are consumed; the next read starts after the last newline", () => {
  const c = consumeChunk({ from: 100, b64: b64("a\nb\npart") });
  assert.equal(c.text, "a\nb\n");
  assert.equal(c.next, 104);
  assert.equal(c.pendingBytes, 4);
  const { buf, ...rest } = consumeChunk({ from: 7, b64: b64("no newline yet") });
  assert.deepEqual(rest, { text: "", next: 7, bytes: 0, pendingBytes: 14 });
  assert.equal(buf.length, 0);
  assert.equal(c.buf.toString(), "a\nb\n");
  assert.equal(consumeChunk({ from: 0, b64: "" }).next, 0);
});

test("consoleScan: the guest's own lines pass; anything else is counted and hashed, never kept", () => {
  const txt = "\r\nMON ready control_port=9000\r\nDOM1 started runtime=2 front=3\r\n[   12.345678] virtio: probe\r\n"
            + "DOM serving unix=/run/front.sock\r\nServing HTTP on http://127.0.0.1:8080/\r\nGET /hv-soak/hvsoakTOK 200\r\nMON dom";
  const c = consoleScan(Buffer.from(txt, "latin1"), { token: "hvsoakTOK" });
  assert.equal(c.lines, 6);
  assert.equal(c.nonMatching, 2);
  assert.deepEqual(c.nonMatchingSha256, [sha("Serving HTTP on http://127.0.0.1:8080/"), sha("GET /hv-soak/hvsoakTOK 200")]);
  assert.equal(c.partialTailBytes, 7);
  assert.equal(c.tokenHits, 1);
  assert.doesNotMatch(JSON.stringify(c), /Serving|hv-soak/, "no line content in the result");
  assert.ok(CONSOLE_OK.test("DOM1 x") && CONSOLE_OK.test("MON x") && CONSOLE_OK.test("[ 1.5] x") && !CONSOLE_OK.test(" DOM x"));
});

test("consoleScan: the fixed front's date-prefixed DOM line is the guest's own; a date-prefixed non-DOM line is still foreign", () => {
  // enclave-d1's box canary: the front's own lines keep Go's log date prefix
  assert.equal(String(CONSOLE_OK), String(/^(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d(\.\d+)? DOM |DOM|MON)|^\[ *[0-9]+\.[0-9]+\]/), "exactly the front's domLine form");
  for (const ok of ["2026/09/26 02:35:48 DOM proxy: GET unreachable", "2026/09/26 03:00:01.123456 DOM proxy: GET timeout",
                    "2026/09/26 03:00:01 DOM front: unsolicited upstream response (19 bytes withheld)"])
    assert.equal(CONSOLE_OK.test(ok), true, ok);
  for (const bad of ["2026/09/26 02:35:48 MON ready control_port=9000", "2026/09/26 02:35:48 app text",
                     "2026/09/26 03:00:01 Unsolicited response received on idle HTTP channel", "2026/09/26 03:00:01 GET /hv-soak/x 200",
                     "2026/09/26 03:00:01 DOMAIN leak", "2026/9/26 03:00:01 DOM x", "2026/09/26 03:00 DOM x", "x 2026/09/26 03:00:01 DOM y"])
    assert.equal(CONSOLE_OK.test(bad), false, bad);
  // and as a verdict: the date is allowed only before DOM
  for (const [line, fails] of [["2026/09/26 02:35:48 DOM proxy: GET unreachable", 0], ["2026/09/26 02:35:48 MON ready", 1], ["2026/09/26 02:35:48 app text", 1]]) {
    const r = step(newEval(), { t: "2026-09-26T03:00:00Z", tls: { ok: true }, box: { ok: true, console: consoleScan(Buffer.from(`${line}\n`)) } });
    assert.equal(r.fail.filter(([id]) => id === "leak").length, fails, line);
  }
  const c = consoleScan(Buffer.from("2026/09/26 03:00:01 DOM proxy: GET unreachable\r\n2026/09/26 03:00:02 GET /hv-soak/hvsoakQ 200\r\n"), { token: "hvsoakQ" });
  assert.deepEqual([c.lines, c.nonMatching, c.tokenHits], [2, 1, 1]);
  const v = step(newEval(), { t: "2026-09-26T03:00:00Z", tls: { ok: true }, box: { ok: true, console: consoleScan(Buffer.from("2026/09/26 03:00:01.5 DOM proxy: GET timeout\n")) } });
  assert.deepEqual(v.fail, [], "a proxy timeout is not a leak");
  assert.deepEqual(consoleScan(Buffer.alloc(0), { token: "x" }), { bytes: 0, lines: 0, nonMatching: 0, nonMatchingSha256: [], partialTailBytes: 0,
                                                                    tokenHits: 0, markerHits: 0, sentinelLines: 0, withheld: 0 });
});

// the target app's HEAD-body marker (a test value: the real one is the sentinel app's, passed with --body-marker)
const MARK = "SENTINEL-BODY-7f3a";
// what the front prints when the HEAD probe's app sends a body: the OLD guest (Go stdlib) and the FIXED one
const OLD_FRONT = `2026/09/26 03:00:01 Unsolicited response received on idle HTTP channel starting with "${MARK}\\n"; err=<nil>`;
const FIXED_FRONT = "DOM front: unsolicited upstream response (19 bytes withheld)";
// the sentinel's own per-request line on stdout and stderr
const SENTINEL_LINE = "-STDOUT-REQ /hv-soak/hvsoakT hvsoakT";

test("consoleScan: the body marker and a -STDOUT-REQ line are sightings; a 'bytes withheld' line is counted and is the guest's own", () => {
  const old = consoleScan(Buffer.from(`MON ok\r\n${OLD_FRONT}\r\n`, "latin1"), { token: "hvsoakZ", marker: MARK });
  assert.equal(old.markerHits, 1);
  assert.equal(old.nonMatching, 1);
  assert.equal(old.withheld, 0);
  const fixed = consoleScan(Buffer.from(`${FIXED_FRONT}\r\n${FIXED_FRONT}\r\n`, "latin1"), { token: "hvsoakZ", marker: MARK });
  assert.deepEqual([fixed.withheld, fixed.nonMatching, fixed.markerHits, fixed.sentinelLines, fixed.lines], [2, 0, 0, 0, 2]);
  const sen = consoleScan(Buffer.from(`${SENTINEL_LINE}\n${SENTINEL_LINE}\n`), { token: "hvsoakT", marker: MARK });
  assert.deepEqual([sen.sentinelLines, sen.tokenHits, sen.nonMatching], [2, 4, 2]);
  assert.equal(consoleScan(Buffer.from(`${OLD_FRONT}\n`), { marker: null }).markerHits, 0, "no marker, no count");
  assert.doesNotMatch(JSON.stringify(old) + JSON.stringify(sen), /Unsolicited|SENTINEL-BODY|STDOUT-REQ \//, "no line content in the result");
});

test("scanLog and digestBox: marker and sentinel sightings in the logs; the baseline read is history, reported apart", () => {
  const c = scanLog(`01:00:00 upstream said ${MARK}\n01:00:01 ${SENTINEL_LINE}\n`, { deployment: DEP, marker: MARK });
  assert.deepEqual([c.markerHits, c.sentinelLines], [1, 1]);
  const st = newSampler();
  const b1 = digestBox(boxRes({ node: `00:00:01 old ${MARK} ${SENTINEL_LINE}\n` }), st, { deployment: DEP, token: "t", marker: MARK });
  assert.deepEqual([b1.logs.node.markerHits, b1.logs.node.history.markerHits, b1.logs.node.sentinelLines, b1.logs.node.history.sentinelLines], [0, 1, 0, 1]);
  const b2 = digestBox(boxRes({ node: `00:05:00 new ${MARK}\n`, nodeFrom: st.offsets.node, console: `${OLD_FRONT}\n${SENTINEL_LINE}\n` }), st,
                       { deployment: DEP, token: "t", marker: MARK });
  assert.equal(b2.logs.node.markerHits, 1);
  assert.equal(b2.console.markerHits, 1);
  assert.equal(b2.console.sentinelLines, 1);
});

/* ---------------------------------------------------------------- digestBox */

const vm = (o = {}) => ({ id: "hv1210563e5e204bbc7cf0f987485949db", name: DEP, instanceId: "hv1210563e5e204b-9c3d10f1", status: "running",
  vmName: "enclave-app-hv1210563e5e204b-9c3d10f1", policy: { memMiB: 128 }, tier: "T0-hv", hostExcluded: false,
  transportKeySha256: "ab".repeat(32), managerEpoch: "e1", guest: { booted: true, bytes: 600, head: "MON ready" }, ...o });
function boxRes({ vms = [vm()], hv = [{ name: "enclave-app-hv1210563e5e204b-9c3d10f1", state: "Running", memMiB: 512, uptimeSec: 60 }],
                  node = NODE_LOG, nodeFrom = 0, manager = "[winmgr] data plane on 127.0.0.1:8092\n", console = "", connected = true,
                  nodePre, managerPre } = {}) {
  // preReady: the log's size before READY; by default the whole read (nothing written after READY); null = not sent
  const pre = (v, dflt) => (v === undefined ? { preReady: dflt } : v === null ? {} : { preReady: v });
  return { ok: true, exit: 0, ms: 30000, readyMs: 3000, ready: connected ? "console" : "noconsole", data: {
    v: 1, vms: vms === null ? { ok: false, error: "503" } : { ok: true, b64: b64(JSON.stringify({ vms, managerEpoch: "e1" })) },
    console: { attempted: connected, connected, note: connected ? "" : "not connected", b64: b64(console) },
    hv: hv === null ? { ok: false, error: "Get-VM failed" } : { ok: true, vms: hv.length === 1 ? hv[0] : hv },
    mem: { ok: true, freeKB: 104857600, totalKB: 117440512 },
    node: { ok: true, size: nodeFrom + Buffer.byteLength(node), from: nodeFrom, reset: false, b64: b64(node),
            ...pre(nodePre, nodeFrom + Buffer.byteLength(node)) },
    manager: { ok: true, size: Buffer.byteLength(manager), from: 0, reset: false, b64: b64(manager), ...pre(managerPre, Buffer.byteLength(manager)) } } };
}

test("digestBox: a running partition, its VM Running, the logs from offset 0 as the baseline", () => {
  const st = newSampler();
  const b = digestBox(boxRes(), st, { deployment: DEP, token: "hvsoakT" });
  assert.equal(b.ok, true);
  assert.equal(b.partition.running, true);
  assert.equal(b.partition.vmState, "Running");
  assert.equal(b.partition.vmMemMiB, 512);
  assert.equal(b.vms.mine.memMiB, 128);
  assert.equal(b.mem.freeMiB, 102400);
  assert.equal(b.logs.node.baseline, true);
  assert.equal(st.offsets.node, Buffer.byteLength(NODE_LOG));
  assert.equal(b.partition.instanceChanged, false);
  // the second read is from the new offset, not a baseline, and a new instance is noticed
  const b2 = digestBox(boxRes({ vms: [vm({ id: "hvNEW" })], node: "01:50:00 [node] x\n", nodeFrom: st.offsets.node }), st, { deployment: DEP, token: "t2" });
  assert.equal(b2.logs.node.baseline, false);
  assert.equal(b2.logs.node.lines, 1);
  assert.equal(b2.partition.instanceChanged, true);
});

test("digestBox: not Running when the manager says so, when Hyper-V says Off, or when there is no record", () => {
  const d = (o) => digestBox(boxRes(o), newSampler(), { deployment: DEP, token: "t" });
  assert.equal(d({ vms: [vm({ status: "starting" })] }).partition.running, false);
  assert.equal(d({ hv: [{ name: vm().vmName, state: "Off", memMiB: 0, uptimeSec: 0 }] }).partition.running, false);
  assert.equal(d({ hv: [] }).partition.vmState, "absent");
  assert.equal(d({ hv: [] }).partition.running, false);
  assert.equal(d({ vms: [] }).partition.status, "absent");
  assert.equal(d({ vms: [] }).partition.running, false);
  assert.equal(d({ hv: null }).partition.running, true, "a failed Get-VM leaves the manager's word");
  assert.equal(d({ vms: null }).partition.running, null, "an unread /vms is unknown, not stopped");
  assert.equal(d({ vms: null }).ok, false);
  // the running record picked over a failed older one
  assert.equal(d({ vms: [vm({ id: "old", status: "failed" }), vm()] }).vms.mine.id, vm().id);
});

test("digestBox: a running partition whose console cannot be read is a failed box read; line contents never kept", () => {
  const st = newSampler();
  assert.equal(digestBox(boxRes({ connected: false }), st, { deployment: DEP, token: "t" }).ok, false);
  const b = digestBox(boxRes({ console: "MON ok\r\nServing HTTP on http://127.0.0.1:8080/ SECRETCANARY\r\n", node: "01:00:00 Error: boom SECRETCANARY\n",
                               nodePre: 0 }), newSampler(), { deployment: DEP, token: "t" });
  assert.equal(b.console.nonMatching, 1);
  assert.equal(b.logs.node.errorLines, 1);
  const h = digestBox(boxRes({ node: "01:00:00 Error: old SECRETCANARY\n" }), newSampler(), { deployment: DEP, token: "t" });
  assert.deepEqual([h.logs.node.errorLines, h.logs.node.history.errorLines], [0, 1], "history is counted apart");
  assert.doesNotMatch(JSON.stringify(h), /SECRETCANARY|old/);
  assert.doesNotMatch(JSON.stringify(b), /SECRETCANARY|Serving HTTP|boom/);
});

/* G2 (enclave-bf): the script reads the logs AFTER READY, so the first read holds this sample's own probe lines too.
   Only bytes below the pre-READY size are history. */
test("splitHistory: whole lines at or below the pre-READY size are history; a crossing line and the rest are judged", () => {
  const buf = Buffer.from("old1\nold2\nnew1\nnew2\n");
  const at = (from, until) => { const r = splitHistory(buf, from, until); return [r.history.toString(), r.current.toString()]; };
  assert.deepEqual(at(0, 10), ["old1\nold2\n", "new1\nnew2\n"]);
  assert.deepEqual(at(0, 12), ["old1\nold2\n", "new1\nnew2\n"], "a line crossing the boundary is judged, never history");
  assert.deepEqual(at(0, 0), ["", "old1\nold2\nnew1\nnew2\n"]);
  assert.deepEqual(at(0, 999), ["old1\nold2\nnew1\nnew2\n", ""]);
  assert.deepEqual(at(100, 50), ["", "old1\nold2\nnew1\nnew2\n"], "a read past the boundary is all judged");
  assert.deepEqual(at(5, 10), ["old1\n", "old2\nnew1\nnew2\n"], "offsets are file offsets: this read starts at byte 5, so 5 bytes are history");
});

test("G2: a marker the first sample's own probe caused (past the pre-READY size) is judged and FAILs; the history before it is not", () => {
  const st = newSampler();
  const hist = `00:00:01 old ${MARK}\n00:00:02 registry: card price now 0/sec (was 12) tx=0x1\n`;
  const mine = `00:00:05 caused by the probe ${MARK}\n00:00:06 registry: card price now 0/sec (was 0) tx=0x2\n`;
  const b = digestBox(boxRes({ node: hist + mine, nodePre: Buffer.byteLength(hist) }), st, { deployment: DEP, token: "t", marker: MARK });
  assert.equal(b.logs.node.baseline, true);
  assert.equal(b.logs.node.historyUntil, Buffer.byteLength(hist));
  assert.equal(b.logs.node.historyBounded, true);
  assert.deepEqual([b.logs.node.markerHits, b.logs.node.history.markerHits], [1, 1]);
  assert.deepEqual([b.logs.node.cardPrice, b.logs.node.history.cardPrice], [1, 1]);
  const r = step(newEval(), { t: "2026-09-26T03:00:00Z", tls: { ok: true, authorized: true, status: 200 }, box: { ok: true, logs: { node: b.logs.node, manager: b.logs.manager }, console: b.console, partition: b.partition } });
  assert.ok(r.fail.some(([id, m]) => id === "leak" && /body marker appeared 1/.test(m)), "the probe's own marker is a leak");
  assert.ok(r.fail.some(([id]) => id === "price"), "a price tx after READY is a price tx");
  // everything before READY is history, however it is chunked: the next sample judges only what is new
  const b2 = digestBox(boxRes({ node: `00:05:00 later\n`, nodeFrom: st.offsets.node, nodePre: 999999 }), st, { deployment: DEP, token: "t", marker: MARK });
  assert.equal(b2.logs.node.history, null, "the boundary is fixed at the first READY");
  assert.equal(b2.logs.node.lines, 1);
});

/* B (enclave-bf): history may ONLY be bounded by the soak's FIRST READY. A first sample without a log's size leaves that
   log with no history at all (everything judged); a later sample's size must never set it, since it already holds the
   earlier samples' probe lines. */
test("B: sample 1 without the pre-READY size, then sample 2 with one -> sample 1's marker is judged (FAIL)", () => {
  const st = newSampler();
  const s1 = `00:00:05 probe of sample 1 ${MARK}\n`;
  const b1 = digestBox(boxRes({ node: s1, nodePre: null }), st, { deployment: DEP, token: "t1", marker: MARK });
  assert.deepEqual([b1.logs.node.ok, b1.logs.node.historyBounded, b1.logs.node.historyUntil, b1.logs.node.markerHits], [true, false, 0, 1]);
  assert.equal(b1.logs.node.history, null);
  const r = step(newEval(), { t: "2026-09-26T03:00:00Z", tls: { ok: true }, box: { ok: true, logs: b1.logs, console: b1.console, partition: b1.partition } });
  assert.ok(r.fail.some(([id]) => id === "leak"));
  assert.ok(r.info.some(([, m]) => /NO history boundary/.test(m)));
  // -1 is the script's "unknown" for a size it could not open for
  assert.equal(digestBox(boxRes({ nodePre: -1 }), newSampler(), { deployment: DEP, token: "t" }).logs.node.historyBounded, false);
});

test("B: the first sample's box read failing entirely leaves no history; sample 2's own size never sets one", () => {
  const st = newSampler();
  digestBox({ ok: false, exit: 255, ms: 15000, error: "ssh: timed out" }, st, { deployment: DEP, token: "t1", marker: MARK });
  // sample 2 reads the log from 0 and brings a pre-READY size that already covers sample 1's probe line
  const lines = `00:00:01 before the soak\n00:00:05 probe of sample 1 ${MARK}\n`;
  const b2 = digestBox(boxRes({ node: lines, nodePre: Buffer.byteLength(lines) }), st, { deployment: DEP, token: "t2", marker: MARK });
  assert.deepEqual([b2.logs.node.historyBounded, b2.logs.node.markerHits, b2.logs.node.lines], [false, 1, 2], "all judged, the old line too");
  // and a reset file is all judged, whatever the boundary was
  const st2 = newSampler();
  digestBox(boxRes({ node: `00:00:01 old ${"x".repeat(200)}\n` }), st2, { deployment: DEP, token: "t" });      // a 214-byte history
  // the new file's lines all sit below the old boundary, so only the reset keeps them from being filed as history
  const res = boxRes({ node: `a\n00:00:01 ${MARK}\n`, nodeFrom: 0 }); res.data.node.reset = true;
  assert.equal(digestBox(res, st2, { deployment: DEP, token: "t", marker: MARK }).logs.node.markerHits, 1, "a new file is not history");
});

test("digestBox: an ssh failure yields only the ssh block", () => {
  const b = digestBox({ ok: false, exit: 255, ms: 15000, error: "ssh: connect timed out" }, newSampler(), { deployment: DEP, token: "t" });
  assert.deepEqual(b, { ok: false, ssh: { ok: false, exit: 255, ms: 15000, readyMs: null, error: "ssh: connect timed out" } });
});

/* ---------------------------------------------------------------- thresholds */

const SPKI_A = "a".repeat(64), SPKI_B = "b".repeat(64);
let clock = Date.parse("2026-09-26T03:00:00Z");
// one sample. The default is a sentinel sample that EXERCISES the leak check: a verified 200 fired at READY with the
// console connected, whose body carried the sentinel's printed evidence. echo:false is hello-world (no token at all);
// printed:false is a REFLECTOR (the token, but no statement that anything was printed).
function S({ ok = true, spki = SPKI_A, authorized = true, status = ok ? 200 : 503, restart = 0, nodeOk = true, baseline = false,
             running = true, price = 0, nonMatching = 0, tokenHits = 0, boxOk = true, sshOk = true, relayOk = true, hostExcluded = false,
             connected = true, latencyMs = 300, t = null, chain = null, head = true, markerHits = 0, nodeMarkerHits = 0, withheld = 0,
             sentinelLines = 0, echo = true, printed = true, trigger = "console", histPrice = 0, histRestart = 0, nodeTokenHits = 0 } = {}) {
  clock += 300_000;
  return { type: "sample", t: t || new Date(clock).toISOString(), deployment: DEP,
    tls: { ok, status: ok ? 200 : status, authorized, latencyMs, cert: spki ? { spkiSha256: spki } : null, error: ok ? null : "x",
           trigger, bodyHasToken: ok && echo, printedEvidence: ok && echo && printed },
    head: { method: "HEAD", trigger: head ? "console" : "fallback", authorized: true, status: 200, sentInWindow: head },
    relay: { ok: relayOk, present: true, hostExcluded, mode: "hv-node" },
    chain: chain || { skipped: true },
    box: { ok: boxOk && sshOk, ssh: { ok: sshOk, error: sshOk ? undefined : "timeout" }, vms: { ok: true },
      partition: sshOk ? { running, status: running ? "running" : "starting" } : undefined,
      logs: sshOk ? { node: nodeOk ? { ok: true, baseline, restart, cardPrice: price, tokenHits: nodeTokenHits, markerHits: nodeMarkerHits, renewed: 0, renewedMine: 0,
                                       history: baseline ? { cardPrice: histPrice, restart: histRestart, markerHits: 0, sentinelLines: 0, lines: 4 } : null }
                                     : { ok: false, error: "x" },
                      manager: { ok: true, tokenHits: 0, markerHits: 0 } } : undefined,
      console: sshOk ? { connected, nonMatching, nonMatchingSha256: Array(nonMatching).fill("c".repeat(64)), tokenHits, markerHits, withheld,
                         sentinelLines, lines: 3 } : undefined } };
}
const run = (samples) => { const ev = newEval(); const vs = samples.map((s) => step(ev, s)); return { ev, vs, fails: ev.events.map((e) => e.id) }; };

test("thresholds: a clean run fails nothing", () => {
  assert.deepEqual(run([S({ baseline: true }), S(), S(), S()]).fails, []);
});

test("thresholds: public FAILs at the 3rd consecutive non-200, once per streak", () => {
  assert.deepEqual(run([S(), S({ ok: false }), S({ ok: false }), S()]).fails, []);
  const r = run([S(), S({ ok: false }), S({ ok: false }), S({ ok: false }), S({ ok: false }), S()]);
  assert.deepEqual(r.fails, ["public"]);
  assert.equal(r.ev.worst.public, 4);
  assert.deepEqual(run([S({ ok: false }), S({ ok: false }), S({ ok: false }), S(), S({ ok: false }), S({ ok: false }), S({ ok: false })]).fails, ["public", "public"]);
  // an unverified 200 is not a 200
  assert.deepEqual(run([S({ ok: false, authorized: false, status: 200 }), S({ ok: false, authorized: false }), S({ ok: false, authorized: false })]).fails, ["public"]);
});

test("thresholds: an SPKI change FAILs unless the node log recorded a restart of the deployment", () => {
  assert.deepEqual(run([S({ baseline: true }), S(), S({ spki: SPKI_B })]).fails, ["spki"]);
  assert.deepEqual(run([S({ baseline: true }), S(), S({ spki: SPKI_B, restart: 2 })]).fails, [], "the same window");
  // restarted after this sample's public check: the new key shows at the next one
  assert.deepEqual(run([S({ baseline: true }), S({ restart: 1 }), S({ spki: null, ok: false }), S({ spki: SPKI_B })]).fails, []);
  // a restart that kept the key clears the pending restart: a later change is unexplained again
  assert.deepEqual(run([S({ baseline: true }), S({ restart: 1 }), S(), S({ spki: SPKI_B })]).fails, ["spki"]);
  // a re-baselined key is the new reference
  assert.deepEqual(run([S({ baseline: true }), S({ spki: SPKI_B, restart: 1 }), S({ spki: SPKI_B }), S({ spki: SPKI_A })]).fails, ["spki"]);
  // restart lines in the log's history (before the first READY) explain nothing
  assert.deepEqual(run([S({ baseline: true, histRestart: 5 }), S({ spki: SPKI_B })]).fails, ["spki"]);
  // the log unreadable when the key changed: judged at the next read, either way
  assert.deepEqual(run([S({ baseline: true }), S({ spki: SPKI_B, nodeOk: false }), S({ spki: SPKI_B, restart: 1 })]).fails, []);
  assert.deepEqual(run([S({ baseline: true }), S({ spki: SPKI_B, nodeOk: false }), S({ spki: SPKI_B })]).fails, ["spki"]);
  // the baseline waits for the first presented leaf
  assert.deepEqual(run([S({ baseline: true, spki: null, ok: false }), S({ spki: SPKI_B })]).fails, []);
});

test("thresholds: partition not Running on 2 consecutive samples; unknown neither counts nor resets", () => {
  assert.deepEqual(run([S({ running: false }), S(), S({ running: false })]).fails, []);
  assert.deepEqual(run([S({ running: false }), S({ running: false })]).fails, ["partition"]);
  assert.deepEqual(run([S({ running: false }), S({ sshOk: false }), S({ running: false })]).fails, ["partition"]);
});

test("thresholds: a first read recorded before G2 (no history split) keeps its old meaning: all history", () => {
  const legacy = S({ baseline: true, price: 2, restart: 3 });
  delete legacy.box.logs.node.history;
  const r = run([legacy, S({ spki: SPKI_B })]);
  assert.deepEqual(r.fails, ["spki"], "no price FAIL from old lines, and old restart lines explain nothing");
  assert.equal(r.ev.price.baseline, 2);
});

test("thresholds: a card-price line past the log's history is a price tx", () => {
  assert.deepEqual(run([S({ baseline: true, histPrice: 3 }), S(), S()]).fails, []);
  const r = run([S({ baseline: true, histPrice: 3 }), S({ price: 1 })]);
  assert.deepEqual(r.fails, ["price"]);
  assert.equal(r.ev.price.baseline, 3);
  assert.equal(r.ev.price.added, 1);
  // G2: a price line in the FIRST read but past the pre-READY size is judged too
  assert.deepEqual(run([S({ baseline: true, histPrice: 3, price: 1 })]).fails, ["price"]);
});

test("thresholds: any non-DOM/MON console line or any token sighting is a leak", () => {
  assert.deepEqual(run([S({ nonMatching: 1 })]).fails, ["leak"]);
  assert.deepEqual(run([S({ tokenHits: 1 })]).fails, ["leak"]);
  assert.deepEqual(run([S({ tokenHits: 1, nonMatching: 2 })]).fails, ["leak", "leak"]);
});

test("thresholds: the HEAD probe's body marker and a sentinel -STDOUT-REQ line are leaks; a 'withheld' line is not", () => {
  assert.deepEqual(run([S({ markerHits: 1 })]).fails, ["leak"]);
  assert.deepEqual(run([S({ nodeMarkerHits: 2 })]).fails, ["leak"], "the marker in node.log");
  assert.deepEqual(run([S({ sentinelLines: 1 })]).fails, ["leak"]);
  const w = run([S({ withheld: 1 }), S({ withheld: 3 })]);
  assert.deepEqual(w.fails, []);
  assert.ok(w.vs[1].info.some(([id, m]) => id === "leak" && /3 'bytes withheld' line\(s\): the HEAD probe reached the front/.test(m)));
});

test("headSentInWindow: only a HEAD fired by READY-with-console, verified and answered", () => {
  const h = { authorized: true, status: 200 };
  assert.equal(headSentInWindow("console", h), true);
  assert.equal(headSentInWindow("console", { authorized: true, status: 405 }), true, "any answer proves it was delivered");
  assert.equal(headSentInWindow("noconsole", h), false, "no console connected: outside any window");
  assert.equal(headSentInWindow("fallback", h), false, "fired by the timer or the session's end");
  assert.equal(headSentInWindow("console", { authorized: false, status: null }), false, "unverified: dropped before sending");
  assert.equal(headSentInWindow("console", { authorized: true, status: null }), false, "no answer");
  assert.equal(headSentInWindow("console", null), false, "--leak-probe off");
});

/* the leak check must not pass vacuously: no leak seen PASSes only on enough EXERCISED samples (enclave-bf's blocker) */
const soakFile = (samples) => [JSON.stringify({ type: "start", interval: 300, deployment: DEP }), ...samples.map((s) => JSON.stringify(s))];
// n samples, `ex` of them exercised; the others miss ONLY the console (box.ok stays true, so no other threshold moves)
const coverage = (n, ex) => { clock = Date.parse("2026-09-27T00:00:00Z"); return soakFile(Array.from({ length: n }, (_, i) => S({ baseline: i === 0, connected: i < ex }))); };

test("exercised: the partition running, a verified 200 fired in the console window whose body echoes the token, the console and both logs read", () => {
  assert.equal(exercised(S()), true);
  for (const [o, why] of [[{ running: false }, "not running"], [{ ok: false }, "no verified 200"], [{ ok: false, authorized: false, status: 200 }, "an unverified 200"],
                          [{ echo: false }, "the body did not echo the token (hello-world): the app's output path is unproven"],
                          [{ printed: false }, "C: a REFLECTOR - the token in a verified 200, but no printed evidence"],
                          [{ trigger: "fallback" }, "the GET fired by the fallback, not inside the console window"],
                          [{ trigger: "noconsole" }, "the GET fired with no console connected"],
                          [{ connected: false }, "no console"], [{ nodeOk: false }, "node.log unread"], [{ sshOk: false }, "no box read"]])
    assert.equal(exercised(S(o)), false, why);
  const m = S(); m.box.logs.manager = { ok: false };
  assert.equal(exercised(m), false, "manager.log unread");
  // the HEAD probe is a tripwire, not coverage (bf's amended G1): neither it nor a "withheld" line makes a sample count
  assert.equal(exercised(S({ head: false })), true, "no HEAD needed");
  assert.equal(exercised(S({ echo: false, withheld: 3 })), false, "withheld lines without the echo prove nothing");
});

test("summarize: no console ever read -> leak NOT EXERCISED and the verdict is not PASS", () => {
  const r = summarize(coverage(10, 0));
  assert.equal(r.pass, false);
  assert.match(r.text, /NOT EXERCISED \(0\/10\) leak .*\[exercised 0\/10, floor 90\.0%\]/);
  assert.match(r.text, /leak check: exercised in 0\/10 samples \(0\.0%; floor 90\.0%\)/);
  assert.match(r.text, /VERDICT: NOT PASS/);
  assert.doesNotMatch(r.text, /VERDICT: PASS/);
  for (const id of ["public", "spki", "partition", "price", "box", "relay"]) assert.match(r.text, new RegExp(`PASS ${id} `), `${id} is untouched`);
});

test("summarize: just under the floor is NOT PASS; at or above it with no hits is PASS", () => {
  const under = summarize(coverage(100, 89));
  assert.equal(under.pass, false);
  assert.match(under.text, /NOT EXERCISED \(89\/100\) leak/);
  const at = summarize(coverage(100, 90));
  assert.equal(at.pass, true);
  assert.match(at.text, /PASS leak .*\[exercised 90\/100, floor 90\.0%\]/);
  assert.match(at.text, /VERDICT: PASS/);
  assert.equal(summarize(coverage(10, 10)).pass, true);
  // the floor is configurable, and whatever it is, 0 exercised samples never PASS (even a floor of 0 through the API)
  assert.equal(summarize(coverage(100, 89), { leakFloor: 0.85 }).pass, true);
  assert.equal(summarize(coverage(10, 0), { leakFloor: 0.01 }).pass, false);
  assert.equal(summarize(coverage(10, 0), { leakFloor: 0 }).pass, false);
  assert.equal(summarize(coverage(10, 1), { leakFloor: 0 }).pass, true);
});

test("summarize: a token hit in an exercised sample is a leak FAIL", () => {
  clock = Date.parse("2026-09-28T00:00:00Z");
  const r = summarize(soakFile([S({ baseline: true }), S(), S({ tokenHits: 1 }), S()]));
  assert.equal(r.pass, false);
  assert.match(r.text, /FAIL leak .*\[exercised 4\/4, floor 90\.0%\]: 1 event\(s\)/);
  assert.match(r.text, /VERDICT: FAIL/);
});

test("summarize: bf's vacuous run - 20 answered HEADs, 0 withheld, 0 marker, a 200 with no echo - is NOT PASS", () => {
  clock = Date.parse("2026-09-29T00:00:00Z");
  const vac = summarize(soakFile(Array.from({ length: 20 }, (_, i) => S({ baseline: i === 0, echo: false, withheld: 0 }))));
  assert.equal(vac.pass, false);
  assert.match(vac.text, /NOT EXERCISED \(0\/20\) leak/);
  assert.match(vac.text, /VERDICT: NOT PASS/);
  assert.match(vac.text, /HEAD tripwire: sent inside the console window in 20\/20 samples/);
  // withheld lines do not rescue it either
  assert.equal(summarize(soakFile(Array.from({ length: 20 }, () => S({ echo: false, withheld: 2 })))).pass, false);
});

test("summarize: the HEAD probe is a tripwire - off or on, it never decides coverage; its sightings FAIL; withheld is INFO", () => {
  clock = Date.parse("2026-09-29T06:00:00Z");
  const off = summarize(soakFile(Array.from({ length: 10 }, (_, i) => S({ baseline: i === 0, head: false }))));
  assert.equal(off.pass, true, "echoed samples are exercised without any HEAD");
  const hit = summarize(soakFile([S({ baseline: true }), S({ markerHits: 1 }), S()]));
  assert.match(hit.text, /FAIL leak .*: 1 event\(s\); first .*body marker appeared 1 time/);
  const w = summarize(soakFile([S({ baseline: true, withheld: 1 }), S({ withheld: 1 }), S()]));
  assert.equal(w.pass, true);
  assert.match(w.text, /'bytes withheld' lines 2 \(INFO\)/);
  // stated plainly in every summary: the front's guard is not covered on hv
  assert.ok(w.text.includes(HV_GUARD_NOT_COVERED));
  assert.match(HV_GUARD_NOT_COVERED, /^NOT COVERED on hv: the front's unsolicited-response guard/);
  assert.equal(w.json.leak.guardNotCovered, HV_GUARD_NOT_COVERED);
});

/* --leak-scope out: the hello-world availability soak. Never a plain "VERDICT: PASS". */
const EVIDENCE = "hv tier: bundle/1 wasi:http under wasmtime serve; hyper frames every response, hello-world never prints (box run 0926)";

test("leak scope out: NOT IN SCOPE with the evidence, verdict from the other thresholds only, never a plain VERDICT line", () => {
  const r = summarize(coverage(10, 0), { leakScope: "out", leakEvidence: EVIDENCE });
  assert.equal(r.pass, true);
  assert.ok(r.text.split("\n").some((l) => l.startsWith(`  NOT IN SCOPE: ${EVIDENCE}`)), "the leak line reads NOT IN SCOPE: <evidence>");
  assert.match(r.text, new RegExp(`^${OUT_OF_SCOPE_VERDICT.replace(/[()]/g, "\\$&")}: PASS$`, "m"));
  assert.equal(OUT_OF_SCOPE_VERDICT, "VERDICT (availability/stability; leak not in scope)");
  assert.doesNotMatch(r.text, /^VERDICT: /m);
  assert.deepEqual([r.json.leakScope, r.json.leakEvidence, r.json.verdict], ["out", EVIDENCE, "PASS"]);
  assert.equal(r.json.thresholds.find((t) => t.id === "leak").status, "NOT IN SCOPE");
  // another threshold failing FAILs it, still in the scoped form
  clock = Date.parse("2026-09-30T00:00:00Z");
  const f = summarize(soakFile([S({ ok: false }), S({ ok: false }), S({ ok: false })]), { leakScope: "out", leakEvidence: EVIDENCE });
  assert.equal(f.pass, false);
  assert.match(f.text, /^VERDICT \(availability\/stability; leak not in scope\): FAIL$/m);
  assert.doesNotMatch(f.text, /^VERDICT: /m);
});

test("A: scope out waives only the exercise, never a sighting - bf's 12 samples, one with a foreign console line and the token in node.log -> FAIL", () => {
  clock = Date.parse("2026-10-01T00:00:00Z");
  const samples = Array.from({ length: 12 }, (_, i) => S({ baseline: i === 0, echo: false, ...(i === 7 ? { nonMatching: 1, nodeTokenHits: 1 } : {}) }));
  const r = summarize(soakFile(samples), { leakScope: "out", leakEvidence: EVIDENCE });
  assert.equal(r.pass, false);
  assert.match(r.text, /^ {2}FAIL leak \(scope out, but seen\): 2 event\(s\); first /m);
  assert.doesNotMatch(r.text, /^ {2}NOT IN SCOPE: /m, "NOT IN SCOPE is only for the not-exercised case");
  assert.match(r.text, /^VERDICT \(availability\/stability; leak not in scope\): FAIL$/m);
  assert.doesNotMatch(r.text, /^VERDICT: /m);
  const leak = r.json.thresholds.find((t) => t.id === "leak");
  assert.deepEqual([leak.status, leak.note, leak.events, r.json.verdict], ["FAIL", "scope out, but seen", 2, "FAIL"]);
  // each kind of sighting alone does it too
  for (const o of [{ markerHits: 1 }, { sentinelLines: 1 }, { tokenHits: 1 }, { nonMatching: 1 }, { nodeTokenHits: 1 }]) {
    clock = Date.parse("2026-10-02T00:00:00Z");
    assert.equal(summarize(soakFile([S({ echo: false }), S({ echo: false, ...o })]), { leakScope: "out", leakEvidence: EVIDENCE }).pass, false, JSON.stringify(o));
  }
});

test("leak scope: taken from the run's header; the default is in scope; out needs its evidence", () => {
  clock = Date.parse("2026-09-30T06:00:00Z");
  const samples = Array.from({ length: 5 }, () => S({ echo: false }));
  const hdr = (h) => [JSON.stringify({ type: "start", interval: 300, deployment: DEP, ...h }), ...samples.map((x) => JSON.stringify(x))];
  const fromHeader = summarize(hdr({ leakScope: "out", leakEvidence: EVIDENCE }));
  assert.match(fromHeader.text, /^VERDICT \(availability\/stability; leak not in scope\): PASS$/m);
  const dflt = summarize(hdr({}));
  assert.match(dflt.text, /^VERDICT: NOT PASS/m, "in scope by default: a vacuous run cannot pass");
  assert.equal(dflt.json.leakScope, "in");
  assert.throws(() => summarize(hdr({ leakScope: "out" })), /needs its evidence/);
  assert.throws(() => summarize(hdr({}), { leakScope: "sideways" }), /one of in, out/);
  // the options override the header, both ways
  assert.match(summarize(hdr({ leakScope: "out", leakEvidence: EVIDENCE }), { leakScope: "in" }).text, /^VERDICT: NOT PASS/m);
});

test("thresholds: the box read FAILs at 3 in a row and is INFO below that", () => {
  const r = run([S({ sshOk: false }), S({ sshOk: false })]);
  assert.deepEqual(r.fails, []);
  assert.ok(r.vs[1].info.some(([id]) => id === "box"));
  assert.deepEqual(run([S({ sshOk: false }), S({ boxOk: false }), S({ sshOk: false })]).fails, ["box"]);
});

test("thresholds: relay row wrong 3 in a row; hostExcluded true at once", () => {
  assert.deepEqual(run([S({ relayOk: false }), S({ relayOk: false }), S()]).fails, []);
  assert.deepEqual(run([S({ relayOk: false }), S({ relayOk: false }), S({ relayOk: false })]).fails, ["relay"]);
  assert.deepEqual(run([S({ relayOk: false, hostExcluded: true })]).fails, ["relay"]);
});

/* ---------------------------------------------------------------- summary */

test("summarize: uptime, latency percentiles, coverage with a gap, PASS/FAIL per threshold", () => {
  clock = Date.parse("2026-09-26T03:00:00Z");
  const lines = [JSON.stringify({ type: "start", interval: 300, deployment: DEP })];
  const lat = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  lat.forEach((l, i) => lines.push(JSON.stringify(S({ baseline: i === 0, latencyMs: l, chain: { ok: true, balance6: 46400 - i * 300, spent6: 3600 + i * 300, leaseUntil: "x", runnerIsBox: true } }))));
  clock += 3 * 300_000;                                          // a 20 min gap (> 2 x interval)
  lines.push(JSON.stringify(S({ ok: false })));
  lines.push(JSON.stringify(S({ ok: false })));
  lines.push("{\"type\":\"sample\",\"t\":\"torn");                // a torn last line is ignored
  // 10 of 12 samples exercised the leak check (83%): under the default 90% floor this could not PASS
  assert.match(summarize(lines).text, /NOT EXERCISED \(10\/12\) leak/);
  const r = summarize(lines, { leakFloor: 0.8 });
  assert.equal(r.pass, true);
  assert.match(r.text, /12 samples/);
  assert.match(r.text, /uptime 83\.3% \(10\/12 verified 200\)/);
  assert.match(r.text, /latency p50 500 ms, p95 1000 ms \(n=10\)/);
  assert.match(r.text, /coverage: 0h45m with no gap longer than 600 s; 1 longer gap\(s\) \(largest 1200 s/);
  assert.match(r.text, /balance6 46400 -> 43700 \(-2700 over 0\.8 h\)/);
  assert.match(r.text, /PASS public/, "two failures in a row are not three");
  for (const th of THRESHOLDS) assert.match(r.text, new RegExp(`(PASS|FAIL) ${th.id}`));
  assert.match(r.text, /VERDICT: PASS/);
  lines.push(JSON.stringify(S({ ok: false })));
  const r2 = summarize(lines);
  assert.match(r2.text, /FAIL public .*1 event\(s\)/);
  assert.match(r2.text, /VERDICT: FAIL/);
  // --since (inclusive) drops the early samples
  const r3 = summarize(lines, { since: new Date(clock - 300_000 * 2).toISOString() });
  assert.match(r3.text, /^hv-soak summary: 3 samples/);
  assert.match(r3.text, /uptime 0\.0% \(0\/3/);
  assert.equal(summarize([]).pass, false);
});

test("summarize: the route is printed (via host / x), with the relay's WebSocket refusals for x", () => {
  clock = Date.parse("2026-10-03T00:00:00Z");
  const xs = [S(), S({ ok: false }), S()].map((s) => ({ ...s, via: "x" }));
  xs[1].tls.wsStatus = 503;
  const r = summarize(soakFile(xs), { leakFloor: 0.5 });
  assert.match(r.text, /^public \(via x\): uptime 66\.7% \(2\/3 verified 200\); .*; ws refusals 1$/m);
  assert.deepEqual(r.json.public.via, ["x"]);
  assert.match(summarize(soakFile([S(), S()])).text, /^public \(via host\): /m, "a record without `via` is host");
});

test("summarize re-evaluates from the observations, not from the stored verdicts", () => {
  clock = Date.parse("2026-09-26T05:00:00Z");
  const a = S({ baseline: true }), b = S({ spki: SPKI_B });
  b.verdict = { fail: [], info: [] };                            // a stale verdict must not be trusted
  assert.match(summarize([JSON.stringify(a), JSON.stringify(b)]).text, /FAIL spki/);
});

/* ---------------------------------------------------------------- CLI and the human line */

test("parseArgs: defaults, the derived URL, and the guards", () => {
  const c = parseArgs([]);
  assert.equal(c.url, "https://31136008.app.enclave.host/");
  assert.equal(appUrlFor(DEP), c.url);
  assert.equal(c.interval, 300);
  assert.equal(c.duration, 43200);
  assert.equal(parseArgs(["--duration", "90m"]).duration, 5400);
  assert.equal(parseArgs(["--interval", "5m"]).interval, 300);
  assert.equal(parseArgs(["--no-chain"]).chain, false);
  assert.equal(c.leakFloor, 0.9);
  assert.equal(parseArgs(["--leak-floor", "95%"]).leakFloor, 0.95);
  assert.equal(parseArgs(["--leak-floor", "0.5"]).leakFloor, 0.5);
  for (const bad of ["0", "1.5", "x", "-1"]) assert.throws(() => parseArgs(["--leak-floor", bad]), /leak-floor/);
  // the HEAD probe's marker has NO default: it is the target app's, and it is required with --leak-probe
  assert.equal(c.leakProbe, false);
  assert.equal(c.bodyMarker, null);
  assert.throws(() => parseArgs(["--leak-probe"]), /needs --body-marker/);
  assert.throws(() => parseArgs(["--body-marker", "SENTINEL-X"]), /only used by --leak-probe/);
  assert.throws(() => parseArgs(["--leak-probe", "--body-marker", "ab"]), /at least 4/);
  const lp = parseArgs(["--leak-probe", "--body-marker", "SENTINEL-X"]);
  assert.deepEqual([lp.leakProbe, lp.bodyMarker], [true, "SENTINEL-X"]);
  assert.throws(() => parseArgs(["--interval", "10"]), /at least 30/);
  assert.throws(() => parseArgs(["--deployment", "0x1"]), /64 hex/);
  // the console window must outlast the requests' 20 s timeout by a margin (bf)
  assert.throws(() => parseArgs(["--console-sec", "10"]), /at least the requests' timeout \(20 s\) \+ 5 s/);
  assert.throws(() => parseArgs(["--console-sec", "24"]), /at least/);
  assert.throws(() => parseArgs(["--console-sec", "x"]), /at least/);
  assert.equal(parseArgs(["--console-sec", "25"]).consoleSec, 25);
  // the request target carries the token
  assert.equal(c.path, "/hv-soak/{token}");
  assert.equal(parseArgs(["--path", "/ping?hvsoak={token}"]).path, "/ping?hvsoak={token}");
  for (const bad of ["/ping", "ping?t={token}", "/a b/{token}", "/x#{token}"]) assert.throws(() => parseArgs(["--path", bad]), /--path/, bad);
  // the availability mode: scope out needs its evidence; evidence needs scope out
  assert.equal(c.leakScope, null);
  assert.throws(() => parseArgs(["--leak-scope", "out"]), /needs --leak-evidence/);
  assert.throws(() => parseArgs(["--leak-scope", "out", "--leak-evidence", "  "]), /needs --leak-evidence/);
  assert.throws(() => parseArgs(["--leak-evidence", "x"]), /goes with --leak-scope out/);
  assert.throws(() => parseArgs(["--leak-scope", "maybe"]), /in or out/);
  const so = parseArgs(["--leak-scope", "out", "--leak-evidence", "hv frames every response"]);
  assert.deepEqual([so.leakScope, so.leakEvidence], ["out", "hv frames every response"]);
  assert.equal(c.via, "host");
  assert.equal(parseArgs(["--via", "x"]).via, "x");
  assert.throws(() => parseArgs(["--via", "sni"]), /--via must be host or x/);
  assert.equal(xUrlFor("https://api.enclave.host", "nucbox-k11", DEP.toUpperCase().replace("0X", "0x")),
               `wss://api.enclave.host/t/nucbox-k11/x/${DEP}/https`, "xsplice's route, the id lowercased");
  assert.throws(() => parseArgs(["--json"]), /for --summary/);
  assert.equal(parseArgs(["--summary", "f.jsonl", "--json"]).json, true);
  assert.throws(() => parseArgs(["--bogus"]), /unknown/);
});

test("humanLine: one line per sample with the verdict under it", () => {
  const st = newSampler();
  const s = { type: "sample", seq: 0, t: "2026-09-26T03:00:00.000Z", deployment: DEP, token: "hvsoakX",
              tls: { ok: false, authorized: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT", cert: { spkiSha256: SPKI_A } },
              relay: parseRelayRow(relayBody(ROW), "nucbox-k11"), chain: { ok: true, balance6: 46400 },
              box: digestBox(boxRes(), st, { deployment: DEP, token: "hvsoakX" }), derived: { spkiEqualsManagerKey: false } };
  const v = step(newEval(), s);
  const h = humanLine(s, v);
  assert.match(h, /^2026-09-26T03:00:00Z #0 \| public\[host\] TLS DEPTH_ZERO_SELF_SIGNED_CERT spki aaaaaaaaaaaa!=vm \| relay ok hv-node\/attestation/);
  assert.match(humanLine({ ...s, via: "x", tls: { ...s.tls, wsStatus: 503 } }, v), /\| public\[x\] TLS DEPTH_ZERO_SELF_SIGNED_CERT ws 503 /);
  assert.match(h, /vm running hv1210563e 128MiB hv Running free 100\.0GiB/);
  assert.match(h, /node \+0\(baseline; history 12 lines\)/, "everything before READY is history, nothing after it");
  assert.match(h, /info spki: SPKI baseline aaaaaaaaaaaaaaaa… \(from an UNVERIFIED leaf\)/);
});
