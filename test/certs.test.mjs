// Platform certificates (relay/certs.js): the relay-side ACME client that
// trades a lease-holder's CSR for a CA certificate on <label>.APP_ZONE, with
// the CA account and EAB pair on the relay and the private key in the CVM.
// These tests pin
//   (1) the gates: name authorization (our zones, one canonical label, never a
//       customer domain / apex / reserved name), the derived-key HMAC, ts skew,
//       single-use signatures (EVERY factor present is spent), the operator
//       signature, the on-chain lease — and that both signed tuples BIND THE
//       KEY: a tuple signed over one CSR's SPKI does not open another CSR;
//   (2) CSR validation from DER: exactly {CN==name, SAN==[name]}, P-256 or
//       RSA>=2048, a verifying self-signature (openssl builds the inputs);
//   (3) the ACME flow against TWO MOCK CAs (never a real one): EAB-checked
//       registration once per CA (persisted encrypted), dns-01 through a mock
//       DNS_API that checks the DNS_TXT_KEY HMAC, finalize with the caller's
//       CSR, and the failover rules — 5xx cools a CA off and falls over,
//       rateLimited moves to the next CA without cooling, a nonce timeout gets
//       a second chance once another CA proved the network;
//   (4) the cache (same key = cached:true, no order) and the 202 paths;
//   (5) hostile DER (the negative-length loop, indefinite/non-minimal lengths,
//       lengths past the end) is a 400, never a hang or an escape;
//   (6) persistence across the reply: a finalized order still `processing` at
//       the poll deadline is kept and RESUMED on the next ask (no fallover), a
//       dead persisted account is re-registered once, a failure that lands
//       after the 202 went out is still recorded and backs the next ask off;
//   (7) a relay without CERTS_KEY (SECRETS_KEY as the sealing root) takes
//       opSig-only requests and refuses sig-bearing ones.
//
//   run: node --test test/certs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, createPublicKey, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const pexec = promisify(execFile);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-certs-test-"));
const b64u = (b) => Buffer.from(b).toString("base64url");
const b64uJson = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// ---- openssl helpers: keys, CSRs, and the mock CA's own signing pair --------
let _n = 0;
async function genKey(kind = "p256") {
  const f = path.join(DIR, `k${++_n}.pem`);
  const args = kind === "p256" ? ["-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"]
             : kind === "p384" ? ["-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-384"]
             : ["-algorithm", "RSA", "-pkeyopt", `rsa_keygen_bits:${kind.slice(3)}`];
  await pexec("openssl", ["genpkey", ...args, "-out", f]);
  return f;
}
async function csrFor(name, { key, cn = name, san = name, extra = [] } = {}) {
  key ||= await genKey();
  const out = path.join(DIR, `c${++_n}.pem`);
  const args = ["req", "-new", "-key", key, "-subj", `/CN=${cn}`, "-out", out];
  if (san !== null) args.push("-addext", `subjectAltName=${Array.isArray(san) ? san.map((s) => "DNS:" + s).join(",") : "DNS:" + san}`);
  for (const e of extra) args.push("-addext", e);
  await pexec("openssl", args);
  return fs.readFileSync(out, "utf8");
}
const CA_KEY = path.join(DIR, "ca.key"), CA_PEM = path.join(DIR, "ca.pem");
await pexec("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                        "-keyout", CA_KEY, "-out", CA_PEM, "-subj", "/CN=Mock CA", "-days", "1"]);
async function signLeaf(csrDer) {
  const csr = path.join(DIR, `f${++_n}.csr`), leaf = path.join(DIR, `f${_n}.pem`);
  fs.writeFileSync(csr, csrDer);
  await pexec("openssl", ["x509", "-req", "-in", csr, "-inform", "DER", "-CA", CA_PEM, "-CAkey", CA_KEY, "-CAcreateserial",
                          "-days", "90", "-copy_extensions", "copy", "-out", leaf]);
  return fs.readFileSync(leaf, "utf8") + fs.readFileSync(CA_PEM, "utf8");
}

// ---- mock DNS_API: the challenge-push daemon's /v1/txt, HMAC-checked --------
const DNS_TXT_KEY = "cd".repeat(32);
const dns = { records: new Map(), posts: 0, deletes: 0, badSig: 0 };
const dnsServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const want = createHmac("sha256", DNS_TXT_KEY).update(raw).digest("hex");
    if (req.url !== "/v1/txt" || req.headers["x-relay-sig"] !== want) { dns.badSig++; res.writeHead(401); return res.end("{}"); }
    const { name, value } = JSON.parse(raw.toString());
    if (req.method === "POST") { dns.posts++; if (!dns.records.has(name)) dns.records.set(name, new Set()); dns.records.get(name).add(value); }
    else { dns.deletes++; dns.records.get(name)?.delete(value); }
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
});
await new Promise((r) => dnsServer.listen(0, "127.0.0.1", r));
const DNS_API = `http://127.0.0.1:${dnsServer.address().port}`;

// ---- mock ACME CA (RFC 8555 subset) -----------------------------------------
// Verifies every JWS (ES256, single-use nonces, url binding), checks EAB when
// required, validates dns-01 by looking in the mock DNS store, and signs the
// finalize CSR with openssl. `mode` steers failure injection at newOrder /
// newNonce: "ok" | "5xx" | "rateLimited" | "nonceHangOnce"; `slowFinalizeMs`
// keeps a finalized order `processing` (with Retry-After: 1) for that long;
// `slowInvalidMs` delays the challenge answer and then fails validation.
function mockCa({ eab = null } = {}) {
  const ca = { mode: "ok", slowFinalizeMs: 0, slowInvalidMs: 0, calls: {}, accounts: new Map(), orders: new Map(), nonces: new Set(), hung: [], url: "", close: null };
  const count = (k) => { ca.calls[k] = (ca.calls[k] || 0) + 1; };
  const nonce = () => { const n = b64u(createHash("sha256").update(String(Math.random())).digest()).slice(0, 22); ca.nonces.add(n); return n; };
  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", "replay-nonce": nonce(), ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const problem = (code, type, detail) => send(code, { type: `urn:ietf:params:acme:error:${type}`, detail }, { "content-type": "application/problem+json" });
    const u = new URL(req.url, ca.url);
    if (u.pathname === "/directory") {
      count("directory");
      return send(200, { newNonce: ca.url + "/nonce", newAccount: ca.url + "/new-account", newOrder: ca.url + "/new-order",
                         meta: { externalAccountRequired: !!eab } });
    }
    if (u.pathname === "/nonce") {
      count("nonce");
      if (ca.mode === "nonceHangOnce") { ca.mode = "ok"; ca.hung.push(res); return; }   // never answers
      return send(200, "");
    }
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      let jws; try { jws = JSON.parse(Buffer.concat(chunks).toString()); } catch { return problem(400, "malformed", "not JSON"); }
      const prot = b64uJson(jws.protected);
      const payload = jws.payload === "" ? null : b64uJson(jws.payload);
      if (prot.url !== ca.url + u.pathname) return problem(400, "malformed", `url ${prot.url} != ${ca.url + u.pathname}`);
      if (!ca.nonces.delete(prot.nonce)) return problem(400, "badNonce", "unknown nonce");
      const jwk = prot.jwk || ca.accounts.get(prot.kid)?.jwk;
      if (!jwk) return problem(400, "accountDoesNotExist", "no jwk/kid");
      const key = createPublicKey({ key: jwk, format: "jwk" });
      if (!cryptoVerify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(jws.signature, "base64url")))
        return problem(400, "malformed", "bad JWS signature");

      if (u.pathname === "/new-account") {
        count("newAccount");
        if (eab) {
          const e = payload?.externalAccountBinding;
          if (!e) return problem(400, "externalAccountRequired", "EAB required");
          const ep = b64uJson(e.protected);
          if (ep.kid !== eab.kid || ep.alg !== "HS256" || ep.url !== ca.url + "/new-account") return problem(400, "malformed", "bad EAB header");
          const want = b64u(createHmac("sha256", Buffer.from(eab.hmac, "base64url")).update(`${e.protected}.${e.payload}`).digest());
          if (want !== e.signature) return problem(401, "unauthorized", "bad EAB signature");
          const inner = b64uJson(e.payload);
          if (JSON.stringify(inner) !== JSON.stringify(jwk)) return problem(400, "malformed", "EAB payload is not the account key");
        }
        const kid = `${ca.url}/acct/${ca.accounts.size + 1}`;
        ca.accounts.set(kid, { jwk, thumbprint: b64u(createHash("sha256").update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).digest()) });
        return send(201, { status: "valid" }, { location: kid });
      }
      const acct = ca.accounts.get(prot.kid);
      if (!acct) return problem(400, "accountDoesNotExist", "unknown kid");
      if (u.pathname === "/new-order") {
        count("newOrder");
        if (ca.mode === "5xx") { res.writeHead(500, { "content-type": "text/html" }); return res.end("<h1>maintenance</h1>"); }
        if (ca.mode === "rateLimited") return problem(429, "rateLimited", "too many certificates already issued for exact set of domains");
        const id = String(ca.orders.size + 1);
        const name = payload.identifiers[0].value;
        const o = { id, name, status: "pending", authz: "pending", token: b64u(createHash("sha256").update("tok" + id + Math.random()).digest()), thumbprint: acct.thumbprint, cert: null };
        ca.orders.set(id, o);
        return send(201, { status: "pending", identifiers: payload.identifiers, authorizations: [`${ca.url}/authz/${id}`], finalize: `${ca.url}/finalize/${id}` },
                    { location: `${ca.url}/order/${id}` });
      }
      const m = u.pathname.match(/^\/(authz|chal|finalize|order|cert)\/(\d+)$/);
      const o = m && ca.orders.get(m[2]);
      if (!o) return problem(404, "malformed", "no such order");
      const authzBody = () => ({ status: o.authz, identifier: { type: "dns", value: o.name },
        challenges: [{ type: "dns-01", url: `${ca.url}/chal/${o.id}`, token: o.token, status: o.authz === "valid" ? "valid" : "pending",
                       ...(o.authz === "invalid" ? { error: { type: "urn:ietf:params:acme:error:unauthorized", detail: "no TXT" } } : {}) }] });
      if (m[1] === "authz") { count("authz"); return send(200, authzBody()); }
      if (m[1] === "chal") {
        count("challenge");
        if (ca.slowInvalidMs) { await new Promise((r) => setTimeout(r, ca.slowInvalidMs)); o.authz = "invalid"; return send(200, authzBody().challenges[0]); }
        const want = b64u(createHash("sha256").update(`${o.token}.${o.thumbprint}`).digest());
        o.authz = dns.records.get(`_acme-challenge.${o.name}`)?.has(want) ? "valid" : "invalid";
        if (o.authz === "valid") o.status = "ready";
        return send(200, authzBody().challenges[0]);
      }
      if (m[1] === "finalize") {
        count("finalize");
        if (o.authz !== "valid") return problem(403, "orderNotReady", "authz not valid");
        const csrDer = Buffer.from(payload.csr, "base64url");
        try { o.cert = await signLeaf(csrDer); o.status = "valid"; }
        catch (e) { o.status = "invalid"; o.error = e.message; }
        if (ca.slowFinalizeMs) { o.releaseAt = Date.now() + ca.slowFinalizeMs; o.status = "processing"; }
        return send(200, { status: o.status });
      }
      if (m[1] === "order") {
        count("orderPoll");
        if (o.status === "processing" && o.releaseAt) {
          if (Date.now() < o.releaseAt) return send(200, { status: "processing" }, { "retry-after": "1" });
          o.status = "valid"; o.releaseAt = 0;
        }
        return send(200, { status: o.status, ...(o.cert && o.status === "valid" ? { certificate: `${ca.url}/cert/${o.id}` } : {}), ...(o.error ? { error: { detail: o.error } } : {}) });
      }
      if (m[1] === "cert") { count("cert"); res.writeHead(200, { "content-type": "application/pem-certificate-chain", "replay-nonce": nonce() }); return res.end(o.cert); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    ca.url = `http://127.0.0.1:${server.address().port}`;
    ca.close = () => { for (const r of ca.hung) try { r.destroy(); } catch {} server.close(); };
    resolve(ca);
  }));
}
const EAB = { kid: "platform-kid", hmac: b64u(Buffer.from("platform-eab-secret-bytes")) };
const ca1 = await mockCa({ eab: EAB });        // "zerossl" slot: EAB required
const ca2 = await mockCa();                    // "letsencrypt" slot: no EAB

// ---- module env (read at import) --------------------------------------------
const KEY = "ab".repeat(32);
Object.assign(process.env, {
  CERTS_KEY: KEY, DNS_API, DNS_TXT_KEY, APP_ZONE: "app.enclave.host", TCP_ZONE: "tcp.enclave.host", AUTH_DATA_DIR: DIR,
  CERTS_ENDPOINT_BURST: "500", CERTS_CA_BURST: "500",       // the suite asks far more often than a real box may
  ACME_EAB_KID: EAB.kid, ACME_EAB_HMAC: EAB.hmac, ACME_CONTACT: "certs@example.test",
  ACME_DIRECTORY: ca1.url + "/directory", ACME_DIRECTORY_2: ca2.url + "/directory",
  CERTS_HTTP_TIMEOUT_MS: "400", CERTS_CA_COOLDOWN_MS: "1500", CERTS_DNS_SETTLE_MS: "0",
  CERTS_POLL_MS: "20", CERTS_POLL_TIMEOUT_MS: "3000", CERTS_SYNC_WAIT_MS: "10000",
});
const { initCerts, handleCerts, certsEnabled, issueSig, issueMessage, parseCsr, authorizeName, _internals } =
  await import("../relay/certs.js");
await initCerts();

// ---- relayCtx double + the ledger ----------------------------------------------
const OP = privateKeyToAccount("0x" + "11".repeat(32));
const OTHER = privateKeyToAccount("0x" + "22".repeat(32));
const ID = "0x" + "cd".repeat(32);
const NAME = "cdcdcdcd.app.enclave.host";
const RUNNER = "0x" + "aa".repeat(32);
const ENDPOINT = "https://enclave1.example";
let rows = [];
let epOwner = OP.address.toLowerCase();
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => Buffer.from(JSON.stringify(req.body)),
  clientIp: () => "203.0.113.7",
  ledgerRows: async () => rows,
  ledgerExpire: () => {},
  // every https://enclaveN.example is "this box" (later tests take a fresh N to sidestep the per-endpoint pacing bucket)
  endpointIdOf: async (ep) => (/^https:\/\/enclave\d+\.example$/.test(ep) ? RUNNER : "0x" + "ee".repeat(32)),
  operatorOfEndpoint: async () => epOwner,
};
const leaseRow = (over = {}) => ({ id: ID, owner: OTHER.address, runner: RUNNER, leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 1800), ...over });
const now = () => Math.floor(Date.now() / 1000);
// every body gets a distinct, strictly increasing ts inside the skew window:
// two asks with one ts are the SAME signed tuple, i.e. a replay by design
let _seq = 0;
const nextTs = () => now() + (_seq++ % 500);
// sha256(SPKI) of a CSR's key, computed by openssl — independent of the
// parser under test, so the tuple the tests sign is the one a real box signs
async function spkiHashOf(csrPem) {
  const f = path.join(DIR, `s${++_n}.csr`);
  fs.writeFileSync(f, csrPem);
  const { stdout } = await pexec("openssl", ["req", "-in", f, "-pubkey", "-noout"]);
  return createHash("sha256").update(createPublicKey(stdout).export({ type: "spki", format: "der" })).digest("hex");
}
// `signedCsr`: sign the tuple over THAT CSR's key while sending `csr` (the
// key-binding tests); default = the CSR being sent
let EP = ENDPOINT;   // the requesting box; later tests move to a sibling to get a fresh per-endpoint bucket
async function body({ name = NAME, csr, signedCsr, endpoint = EP, ts = nextTs(), account = OP, sig, opSig, key = KEY } = {}) {
  csr ||= await csrFor(name);
  const spkiHash = await spkiHashOf(signedCsr || csr);
  return { name, csr, endpoint, ts,
           sig: sig ?? issueSig(key, name, endpoint, spkiHash, ts),
           opSig: opSig ?? await account.signMessage({ message: issueMessage(name, endpoint, spkiHash, ts) }) };
}
const call = async (b, pathname = "/v1/certs/issue", method = "POST") => {
  const res = {};
  await handleCerts({ method, body: b }, res, new URL("http://x" + pathname), ctx);
  return res;
};
const settle = () => new Promise((r) => setTimeout(r, 30));
const sanOf = (pem) => new X509Certificate(pem).subjectAltName;

test.after(() => { ca1.close(); ca2.close(); dnsServer.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

test("module is enabled under the test env switches; both CA slots built in order", () => {
  assert.equal(certsEnabled(), true);
  assert.deepEqual(_internals.CAS.map((c) => c.name), ["zerossl", "letsencrypt"]);
  assert.equal(_internals.CAS[0].eabKid, EAB.kid);
});

test("route shape: 404 off-route, 405 non-POST", async () => {
  assert.equal((await call({}, "/v1/certs/other")).code, 404);
  assert.equal((await call({}, "/v1/certs/issue", "GET")).code, 405);
});

test("name authorization: our zones only, one canonical label", () => {
  assert.equal(authorizeName("cdcdcdcd.app.enclave.host").id, "0xcdcdcdcd");
  assert.equal(authorizeName("CDCDCDCD.app.enclave.host.").name, "cdcdcdcd.app.enclave.host");
  assert.equal(authorizeName("0xcdcdcdcd.tcp.enclave.host").zone, "tcp.enclave.host");
  assert.equal(authorizeName("dep-abc123.app.enclave.host").error, "bad_label");  // retired-era ids: not on any ledger
  assert.equal(authorizeName("shop.example.com").error, "not_platform_zone");     // a customer's domain
  assert.equal(authorizeName("app.enclave.host").error, "not_platform_zone");     // the zone apex
  assert.equal(authorizeName("enclave.host").error, "not_platform_zone");         // the platform apex
  assert.equal(authorizeName("api.enclave.host").error, "not_platform_zone");     // a reserved platform host
  assert.equal(authorizeName("box.app.enclave.host").error, "bad_label");         // not a deployment label
  assert.equal(authorizeName("x.cdcdcdcd.app.enclave.host").error, "bad_label");  // a second level
  assert.equal(authorizeName("cdcdcdcd.app.enclave.host.evil.com").error, "not_platform_zone");
  assert.equal(authorizeName("").error, "bad_name");
});

test("refusals never reach a CA: customer domain, apex, reserved, bad sig, stale ts, replay, wrong operator, no lease", async () => {
  rows = [leaseRow()];
  const orders = () => (ca1.calls.newOrder || 0) + (ca2.calls.newOrder || 0);
  const before = orders();
  let r = await call(await body({ name: "shop.example.com" }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "not_platform_zone");
  r = await call(await body({ name: "app.enclave.host" }));
  assert.equal(r.code, 403);
  r = await call(await body({ name: "api.enclave.host" }));
  assert.equal(r.code, 403);
  r = await call(await body({ sig: "00".repeat(32) }));
  assert.equal(r.code, 401); assert.equal(r.body.error, "bad_sig");
  r = await call(await body({ ts: now() - 700 }));
  assert.equal(r.code, 422); assert.equal(r.body.error, "bad_ts");
  r = await call(await body({ endpoint: "not-a-url" }));
  assert.equal(r.code, 422); assert.equal(r.body.error, "bad_endpoint");
  // wrong operator key over the right tuple
  r = await call(await body({ account: OTHER }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "wrong_operator");
  r = await call(await body({ opSig: "0x" + "00".repeat(65) }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "no_operator_sig");
  // an endpoint the registry does not know cannot be authorized by anyone
  epOwner = null;
  r = await call(await body());
  assert.equal(r.code, 403); assert.equal(r.body.error, "unregistered_endpoint");
  epOwner = OP.address.toLowerCase();
  // lease held by somebody else / expired / no such deployment / ambiguous prefix
  rows = [leaseRow({ runner: "0x" + "bb".repeat(32) })];
  r = await call(await body());
  assert.equal(r.code, 403); assert.equal(r.body.error, "not_lease_holder");
  rows = [leaseRow({ leaseUntil: BigInt(now() - 10) })];
  r = await call(await body());
  assert.equal(r.code, 403); assert.equal(r.body.error, "not_lease_holder");
  rows = [];
  r = await call(await body());
  assert.equal(r.code, 403); assert.equal(r.body.error, "not_found");
  rows = [leaseRow(), leaseRow({ id: "0x" + "cd".repeat(4) + "ee".repeat(28) })];
  r = await call(await body());
  assert.equal(r.code, 403); assert.equal(r.body.error, "not_found");
  // a CSR that does not parse is refused BEFORE any signature is spent (the
  // tuples bind the key, so there is nothing to verify them against)
  rows = [leaseRow()];
  const bc = await body({ csr: await csrFor("other.app.enclave.host") });   // wrong-CN CSR
  r = await call(bc);
  assert.equal(r.code, 400); assert.equal(r.body.error, "bad_csr");
  r = await call(bc);
  assert.equal(r.code, 400, "an unparsed CSR spends no signature");
  // replay: the same signed tuple twice (after the first one passed the signature gate)
  rows = [leaseRow({ runner: "0x" + "bb".repeat(32) })];
  const b = await body();
  r = await call(b);
  assert.equal(r.code, 403); assert.equal(r.body.error, "not_lease_holder");
  r = await call(b);
  assert.equal(r.code, 409); assert.equal(r.body.error, "sig_replayed");
  rows = [leaseRow()];
  assert.equal(orders(), before, "no refusal reached a CA");
});

test("CSR validation from DER: exactly CN==name + SAN==[name], P-256 or RSA>=2048, verifying signature", async () => {
  const ok = parseCsr(await csrFor(NAME), NAME);
  assert.equal(ok.keyType, "ec-p256"); assert.equal(ok.cn, NAME); assert.deepEqual(ok.sans, [NAME]);
  assert.match(ok.spkiHash, /^[0-9a-f]{64}$/);
  const rsa = parseCsr(await csrFor(NAME, { key: await genKey("rsa2048") }), NAME);
  assert.equal(rsa.keyType, "rsa-2048");
  const cases = [
    [await csrFor(NAME, { cn: "other.app.enclave.host" }), /CN is/],
    [await csrFor(NAME, { san: "other.app.enclave.host" }), /SAN is/],
    [await csrFor(NAME, { san: [NAME, "extra.app.enclave.host"] }), /exactly one dNSName/],
    [await csrFor(NAME, { san: null }), /attribute/],
    [await csrFor(NAME, { extra: ["basicConstraints=CA:FALSE"] }), /exactly one extension/],
    [await csrFor(NAME, { key: await genKey("rsa1024") }), /at least 2048/],
    [await csrFor(NAME, { key: await genKey("p384") }), /P-256/],
    ["-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----", /DER/],
    ["not a csr", /PEM/],
  ];
  for (const [pem, re] of cases) assert.throws(() => parseCsr(pem, NAME), re, `expected ${re}`);
  // a tampered CSR (one byte flipped in the CN) fails the self-signature, not merely the name
  const good = await csrFor(NAME);
  const der = Buffer.from(good.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const i = der.indexOf(Buffer.from(NAME)); der[i] = "d".charCodeAt(0);       // "cdcd..." -> "ddcd..." in the CN only
  const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString("base64")}\n-----END CERTIFICATE REQUEST-----`;
  assert.throws(() => parseCsr(tampered, "ddcdcdcd.app.enclave.host"), /CN is|SAN is|self-signature/);
});
test("happy path via the ZeroSSL slot: EAB-bound account, dns-01 through DNS_API, the caller's CSR is what gets signed", async () => {
  rows = [leaseRow()];
  const key = await genKey();
  const csr = await csrFor(NAME, { key });
  const r = await call(await body({ csr }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, NAME); assert.equal(r.body.ca, "zerossl"); assert.equal(r.body.cached, false);
  assert.match(r.body.certPem, /-----BEGIN CERTIFICATE-----/);
  assert.equal(sanOf(r.body.certPem), `DNS:${NAME}`);
  // the leaf carries the CALLER's public key — the relay signed nothing and made no key
  const leaf = new X509Certificate(r.body.certPem);
  const spki = createPublicKey(fs.readFileSync(key)).export({ type: "spki", format: "der" });
  assert.ok(leaf.publicKey.export({ type: "spki", format: "der" }).equals(spki));
  assert.ok(new Date(r.body.notAfter) > new Date(r.body.notBefore));
  assert.equal(ca1.calls.newAccount, 1, "EAB registration happened once");
  assert.equal(ca1.calls.finalize, 1);
  await settle();
  assert.equal(dns.posts, 1); assert.equal(dns.deletes, 1); assert.equal(dns.badSig, 0);
  assert.equal(dns.records.get(`_acme-challenge.${NAME}`)?.size || 0, 0, "TXT cleaned up");
  // account persisted encrypted: the blob opens under the directory AAD and never holds a plaintext key
  const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, "certs.json"), "utf8"));
  const blob = onDisk.accounts[ca1.url + "/directory"];
  assert.ok(blob && !blob.includes("PRIVATE KEY"));
  const acct = _internals.open(ca1.url + "/directory", blob);
  assert.equal(acct.kid, `${ca1.url}/acct/1`); assert.match(acct.pkcs8, /BEGIN PRIVATE KEY/);
  assert.throws(() => _internals.open(ca2.url + "/directory", blob));
  assert.equal(Object.keys(onDisk.certs).length, 1);
  // cache: the same key again = cached, no new order; a new key = a new order, same account
  const orders = ca1.calls.newOrder;
  const r2 = await call(await body({ csr: await csrFor(NAME, { key }) }));
  assert.equal(r2.code, 200); assert.equal(r2.body.cached, true); assert.equal(r2.body.certPem, r.body.certPem);
  assert.equal(ca1.calls.newOrder, orders);
  const r3 = await call(await body({ csr: await csrFor(NAME) }));
  assert.equal(r3.code, 200); assert.equal(r3.body.cached, false);
  assert.equal(ca1.calls.newOrder, orders + 1); assert.equal(ca1.calls.newAccount, 1);
  assert.equal(Object.keys(_internals.store().data.certs).length, 1, "one cert per name: the old key's record is replaced");
});

test("TCP_ZONE names are accepted with the same label rule", async () => {
  rows = [leaseRow()];
  const name = "cdcdcdcd.tcp.enclave.host";
  const r = await call(await body({ name }));
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(sanOf(r.body.certPem), `DNS:${name}`);
});

test("a seller box without a fleet SECRET: the operator signature + the lease authorize on their own; sig is optional but verified when sent", async () => {
  rows = [leaseRow()];
  // opSig only (sig omitted): issued
  const b = await body({ sig: "" });
  const r = await call(b);
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(sanOf(r.body.certPem), `DNS:${NAME}`);
  // the same request again is a replay: opSig is the single-use token when there is no fleet factor
  const again = await call(b);
  assert.equal(again.code, 409); assert.equal(again.body.error, "sig_replayed");
  // opSig only, but by the wrong operator / missing: refused
  let x = await call(await body({ sig: "", account: OTHER }));
  assert.equal(x.code, 403); assert.equal(x.body.error, "wrong_operator");
  x = await call(await body({ sig: "", opSig: "" }));
  assert.equal(x.code, 403); assert.equal(x.body.error, "no_operator_sig");
  // a wrong sig is never ignored, even with a valid opSig
  x = await call(await body({ sig: "11".repeat(32) }));
  assert.equal(x.code, 401); assert.equal(x.body.error, "bad_sig");
});

test("5xx at the first CA cools it off and falls over to Let's Encrypt; while cooling it is not tried", async () => {
  rows = [leaseRow()];
  ca1.mode = "5xx";
  const o1 = ca1.calls.newOrder, o2 = ca2.calls.newOrder || 0;
  let r = await call(await body());
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(ca1.calls.newOrder, o1 + 1); assert.equal(ca2.calls.newOrder, o2 + 1);
  assert.equal(ca2.calls.newAccount, 1, "the eab-less slot registered without EAB");
  ca1.mode = "ok";
  r = await call(await body());                              // ca1 still cooling: straight to ca2
  assert.equal(r.code, 200); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(ca1.calls.newOrder, o1 + 1);
  await new Promise((s) => setTimeout(s, 1600));            // cool-off elapses
  r = await call(await body());
  assert.equal(r.code, 200); assert.equal(r.body.ca, "zerossl");
});

test("rateLimited at the first CA moves to the next without cooling it off", async () => {
  rows = [leaseRow()];
  ca1.mode = "rateLimited";
  const o1 = ca1.calls.newOrder;
  let r = await call(await body());
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  ca1.mode = "ok";
  r = await call(await body());                              // not cooling: ca1 is tried again at once
  assert.equal(r.code, 200); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.newOrder, o1 + 2);
});

test("a nonce timeout at the first CA gets a second chance once the second CA proved the network", async () => {
  rows = [leaseRow()];
  _internals.CAS[0].nonce = null;                           // force a newNonce round trip
  ca1.mode = "nonceHangOnce";                               // first HEAD /nonce never answers (400ms timeout)
  ca2.mode = "rateLimited";                                 // ca2 reaches its endpoints, refuses the name
  const r = await call(await body());
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.mode, "ok");
  ca2.mode = "ok";
  assert.equal(_internals.CAS[0].downUntil, 0, "success clears the latch");
});

test("every CA refusing the name = 502, then a backoff 202; every CA cooling = 202 with retryAfterSec", async () => {
  rows = [leaseRow()];
  const name = "cdcdcdcdcd.app.enclave.host";              // a longer prefix of the same id: a fresh name for the backoff
  ca1.mode = "rateLimited"; ca2.mode = "rateLimited";
  let r = await call(await body({ name }));
  assert.equal(r.code, 502); assert.equal(r.body.error, "issue_failed");
  ca1.mode = "ok"; ca2.mode = "ok";
  r = await call(await body({ name }));
  assert.equal(r.code, 202); assert.ok(r.body.retryAfterSec >= 1 && r.body.retryAfterSec <= 60);
  ca1.mode = "5xx"; ca2.mode = "5xx";
  r = await call(await body());
  assert.equal(r.code, 502);                                // both cooled this round (no network proven)
  r = await call(await body());
  assert.equal(r.code, 202); assert.equal(r.body.retryAfterSec, 60, "the per-name backoff answers first");
  r = await call(await body({ name: "cdcdcdcdcdcd.app.enclave.host" }));   // a fresh name: every CA is cooling
  assert.equal(r.code, 202); assert.ok(r.body.retryAfterSec >= 1 && r.body.retryAfterSec <= 15, JSON.stringify(r.body));
  ca1.mode = "ok"; ca2.mode = "ok";
  await new Promise((s) => setTimeout(s, 1600));
  delete _internals.store().data.failures[NAME];
  r = await call(await body());
  assert.equal(r.code, 200);
});

test("a duplicate ask while the order is in flight rides the same order", async () => {
  rows = [leaseRow()];
  const key = await genKey();
  const [a, b] = await Promise.all([call(await body({ csr: await csrFor(NAME, { key }) })), call(await body({ csr: await csrFor(NAME, { key }) }))]);
  assert.equal(a.code, 200); assert.equal(b.code, 200);
  assert.equal(a.body.certPem, b.body.certPem);
  assert.equal(a.body.cached !== b.body.cached, true, "one issued, one joined");
});

// ---- regressions from the 2026-08-27 review ------------------------------------

EP = "https://enclave2.example";
const pemOf = (der) => `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.from(der).toString("base64")}\n-----END CERTIFICATE REQUEST-----`;
test("hostile DER is a fast 400, never a hang: negative 4-byte length, indefinite, non-minimal, past-the-end, zero-length nesting", async () => {
  const cases = {
    // the reviewer's pattern: 30 10 | 30 08 00*8 | 02 84 ff ff ff f0 -> len -16 through int32 shifts, kids() walked 2 -> 12 -> 2 forever
    negative4: [0x30, 0x10, 0x30, 0x08, 0,0,0,0,0,0,0,0, 0x02, 0x84, 0xff, 0xff, 0xff, 0xf0],
    topBit4:   [0x30, 0x10, 0x30, 0x08, 0,0,0,0,0,0,0,0, 0x02, 0x84, 0x80, 0x00, 0x00, 0x02],
    fiveBytes: [0x30, 0x11, 0x30, 0x08, 0,0,0,0,0,0,0,0, 0x02, 0x85, 0x00, 0x00, 0x00, 0x00, 0x01],
    pastEnd:   [0x30, 0x06, 0x30, 0x04, 0x02, 0x81, 0xff, 0x00],
    indefinite:[0x30, 0x80, 0x30, 0x00, 0x00, 0x00],
    nonMinimal:[0x30, 0x04, 0x02, 0x81, 0x01, 0x00],            // long form for a length < 128
    leadingZero:[0x30, 0x05, 0x02, 0x82, 0x00, 0x01, 0x00],      // 0x82 00 01: a leading zero length byte
    zeroSeqs:  [0x30, 0x06, 0x30, 0x00, 0x30, 0x00, 0x30, 0x00],
    topShort:  [0x30, 0x84, 0xff, 0xff, 0xff, 0xff],
    deep:      (() => { let b = [0x02, 0x01, 0x00]; for (let i = 0; i < 40; i++) b = [0x30, b.length, ...b]; return b; })(),
  };
  for (const [what, bytes] of Object.entries(cases)) {
    const t0 = Date.now();
    let err = null;
    try { parseCsr(pemOf(Uint8Array.from(bytes)), NAME); } catch (e) { err = e; }
    assert.ok(err instanceof Error && err.message, `${what}: must throw an Error`);
    assert.ok(Date.now() - t0 < 500, `${what}: parser must fail fast, took ${Date.now() - t0}ms`);
  }
  // the whole thing through the route: 400 bad_csr, no signature spent, no CA touched
  rows = [leaseRow()];
  const before = (ca1.calls.newOrder || 0) + (ca2.calls.newOrder || 0);
  const r = await call(await body({ csr: pemOf(Uint8Array.from(cases.negative4)), signedCsr: await csrFor(NAME) }));
  assert.equal(r.code, 400); assert.equal(r.body.error, "bad_csr");
  assert.equal((ca1.calls.newOrder || 0) + (ca2.calls.newOrder || 0), before);
});

test("replay: dropping `sig` from a captured first-party request does not reopen it (opSig is spent too)", async () => {
  rows = [leaseRow()];
  const key = await genKey();
  const b = await body({ csr: await csrFor(NAME, { key }) });
  const r = await call(b);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  // verbatim replay
  let x = await call(b);
  assert.equal(x.code, 409); assert.equal(x.body.error, "sig_replayed");
  // the same tuple with the fleet factor dropped: opSig was marked on the first pass
  x = await call({ ...b, sig: "" });
  assert.equal(x.code, 409); assert.equal(x.body.error, "sig_replayed");
  // the same tuple with the fleet factor dropped AND another CSR for the same name:
  // the tuple names the first key, so it cannot even verify — and it is spent anyway
  const attacker = await csrFor(NAME);
  x = await call({ ...b, sig: "", csr: attacker });
  assert.equal(x.code, 409);
  assert.equal(Object.values(_internals.store().data.certs).filter((c) => c.name === NAME).length, 1);
  assert.equal(Object.values(_internals.store().data.certs).find((c) => c.name === NAME).spkiHash, await spkiHashOf(b.csr), "the legit record was not evicted");
});

test("the signed tuples bind the key: a CSR for another key than the one signed over is refused", async () => {
  rows = [leaseRow()];
  const signedOver = await csrFor(NAME), sent = await csrFor(NAME);
  const before = (ca1.calls.newOrder || 0) + (ca2.calls.newOrder || 0);
  // first-party: the fleet HMAC is over the other key -> 401
  let r = await call(await body({ csr: sent, signedCsr: signedOver }));
  assert.equal(r.code, 401); assert.equal(r.body.error, "bad_sig");
  // seller (opSig only): the operator signed the other key -> recovers to a different address
  r = await call(await body({ csr: sent, signedCsr: signedOver, sig: "" }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "wrong_operator");
  assert.equal((ca1.calls.newOrder || 0) + (ca2.calls.newOrder || 0), before, "nothing reached a CA");
  // and the exact same tuple over the right CSR is fine
  r = await call(await body({ csr: sent, sig: "" }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
});

test("the wire format is pinned: HMAC over hex-decoded CERTS_KEY of <name>:<endpoint>:<spkiHash>:<ts>; opSig text enclave-certs-issue:<...same>", async () => {
  const csr = await csrFor(NAME);
  const h = await spkiHashOf(csr), ts = 1700000000;
  assert.equal(issueSig(KEY, NAME, ENDPOINT, h, ts),
               createHmac("sha256", Buffer.from(KEY, "hex")).update(`${NAME}:${ENDPOINT}:${h}:${ts}`).digest("hex"));
  assert.notEqual(issueSig(KEY, NAME, ENDPOINT, h, ts), createHmac("sha256", KEY).update(`${NAME}:${ENDPOINT}:${h}:${ts}`).digest("hex"), "the key is the 32 decoded bytes, not the hex string");
  assert.equal(issueMessage(NAME, ENDPOINT, h, ts), `enclave-certs-issue:${NAME}:${ENDPOINT}:${h}:${ts}`);
  assert.equal(parseCsr(csr, NAME).spkiHash, h, "the relay's spkiHash is sha256 of the DER SubjectPublicKeyInfo");
});

test("a finalized order still `processing` at the poll deadline is kept (202) and RESUMED on the next ask — no fallover, one order", async () => {
  rows = [leaseRow()];
  const key = await genKey();
  ca1.slowFinalizeMs = 4000;                                // > CERTS_POLL_TIMEOUT_MS (3 s): the deadline passes while processing
  const o1 = ca1.calls.newOrder, o2 = ca2.calls.newOrder || 0, polls = ca1.calls.orderPoll || 0;
  let r = await call(await body({ csr: await csrFor(NAME, { key }) }));
  assert.equal(r.code, 202, JSON.stringify(r.body));
  assert.ok(r.body.retryAfterSec >= 1 && r.body.retryAfterSec <= 300, JSON.stringify(r.body));
  assert.equal(ca1.calls.newOrder, o1 + 1); assert.equal(ca2.calls.newOrder || 0, o2, "no fallover to the next CA");
  assert.equal(_internals.CAS[0].downUntil, 0, "processing is not a CA failure");
  assert.ok((ca1.calls.orderPoll || 0) - polls <= 6, `Retry-After honoured (${(ca1.calls.orderPoll || 0) - polls} polls in 3 s)`);
  const keyOf = (h) => `${NAME}|${h}`;
  const h = await spkiHashOf(await csrFor(NAME, { key }));
  const held = _internals.store().data.orders[keyOf(h)];
  assert.ok(held && held.ca === "zerossl" && held.orderUrl && held.finalizeUrl && held.csrDer, "the order is persisted");
  assert.equal(_internals.store().data.failures[NAME], undefined, "not a failure");
  await new Promise((s) => setTimeout(s, 1700));           // the CA finishes
  r = await call(await body({ csr: await csrFor(NAME, { key }) }));
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl"); assert.equal(r.body.cached, false);
  assert.equal(ca1.calls.newOrder, o1 + 1, "resumed, not re-ordered");
  assert.equal(_internals.store().data.orders[keyOf(h)], undefined, "the order record is dropped when done");
  ca1.slowFinalizeMs = 0;
  await settle();
  assert.equal(dns.records.get(`_acme-challenge.${NAME}`)?.size || 0, 0, "TXT cleaned up after the resume");
});

test("a persisted order survives a relay restart: the slot starts with no account and resumes from the store", async () => {
  rows = [leaseRow()];
  const key = await genKey();
  ca1.slowFinalizeMs = 4000;
  const o1 = ca1.calls.newOrder, o2 = ca2.calls.newOrder || 0, regs = ca1.calls.newAccount;
  let r = await call(await body({ csr: await csrFor(NAME, { key }) }));
  assert.equal(r.code, 202, JSON.stringify(r.body));
  // "restart": the in-memory slot forgets its account; the sealed blob and the order are on disk
  _internals.CAS[0].account = null; _internals.CAS[0].dir = null;
  await new Promise((s) => setTimeout(s, 1700));
  r = await call(await body({ csr: await csrFor(NAME, { key }) }));
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.newOrder, o1 + 1, "resumed, not re-ordered"); assert.equal(ca2.calls.newOrder || 0, o2, "no fallover");
  assert.equal(ca1.calls.newAccount, regs, "the persisted account was reloaded, not re-registered");
  ca1.slowFinalizeMs = 0; await settle();
});

test("a persisted order is resumed FIRST on its own CA even when an earlier slot is healthy again", async () => {
  rows = [leaseRow()];
  const key = await genKey();
  ca1.mode = "rateLimited"; ca2.slowFinalizeMs = 4000;      // the order lands on Let's Encrypt and is still processing
  const o2 = ca2.calls.newOrder || 0;
  let r = await call(await body({ csr: await csrFor(NAME, { key }) }));
  assert.equal(r.code, 202, JSON.stringify(r.body));
  assert.equal(ca2.calls.newOrder, o2 + 1);
  const o1 = ca1.calls.newOrder;                            // after the refused first attempt
  const h = await spkiHashOf(await csrFor(NAME, { key }));
  assert.equal(_internals.store().data.orders[`${NAME}|${h}`]?.ca, "letsencrypt");
  ca1.mode = "ok";                                          // ZeroSSL is back: the walk would try it first
  await new Promise((s) => setTimeout(s, 1700));
  r = await call(await body({ csr: await csrFor(NAME, { key }) }));
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(ca1.calls.newOrder, o1, "ZeroSSL was not asked for a fresh order");
  assert.equal(ca2.calls.newOrder, o2 + 1, "the Let's Encrypt order was collected, not re-placed");
  assert.equal(_internals.store().data.orders[`${NAME}|${h}`], undefined);
  ca2.slowFinalizeMs = 0; await settle();
});

test("a purged account during a renewal wave: concurrent names re-register ONE account and all issue on the same CA", async () => {
  rows = [leaseRow()];
  const dirKey = ca1.url + "/directory";
  const regs = ca1.calls.newAccount, o2 = ca2.calls.newOrder || 0;
  ca1.accounts.clear();
  const names = ["cdcdcdcdcdcdcdcdcdcd.app.enclave.host", "cdcdcdcdcdcdcdcdcdcdcd.app.enclave.host", "cdcdcdcdcdcdcdcdcdcdcdcd.app.enclave.host"];   // labels no other test touches
  const bodies = await Promise.all(names.map((name) => body({ name })));
  const rs = await Promise.all(bodies.map((b) => call(b)));
  for (const r of rs) { assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl"); }
  assert.equal(ca1.calls.newAccount, regs + 1, "exactly one re-registration");
  assert.equal(ca2.calls.newOrder || 0, o2, "nothing fell over to Let's Encrypt");
  assert.ok(_internals.CAS[0].account?.kid, "the slot holds the fresh account");
  assert.equal(_internals.open(dirKey, _internals.store().data.accounts[dirKey]).kid, _internals.CAS[0].account.kid);
});

test("accountDoesNotExist on the persisted account drops it, re-registers once and retries", async () => {
  rows = [leaseRow()];
  const dirKey = ca1.url + "/directory";
  const blobBefore = _internals.store().data.accounts[dirKey];
  const regs = ca1.calls.newAccount;
  ca1.accounts.clear();                                     // the CA purged every account
  const r = await call(await body());
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.newAccount, regs + 1, "registered exactly once more");
  assert.notEqual(_internals.store().data.accounts[dirKey], blobBefore, "a new account blob is persisted");
  assert.equal(_internals.open(dirKey, _internals.store().data.accounts[dirKey]).kid, _internals.CAS[0].account.kid);
});

test("two names on a fresh slot register ONE account (registration is serialized)", async () => {
  EP = "https://enclave3.example";
  rows = [leaseRow()];
  const dirKey = ca2.url + "/directory";
  delete _internals.store().data.accounts[dirKey];
  _internals.CAS[1].account = null;
  ca1.mode = "rateLimited";                                 // both names go to the second slot
  const regs = ca2.calls.newAccount || 0;
  const [a, b] = await Promise.all([call(await body({ name: "cdcdcdcdcdcdcd.app.enclave.host" })), call(await body({ name: "cdcdcdcdcdcdcdcd.app.enclave.host" }))]);
  ca1.mode = "ok";
  assert.equal(a.code, 200, JSON.stringify(a.body)); assert.equal(b.code, 200, JSON.stringify(b.body));
  assert.equal(ca2.calls.newAccount, regs + 1);
});

test("a failure that lands after the 202 went out is still recorded: the next ask is a backoff 202, not a fresh order", async () => {
  // a module instance whose sync window (200 ms) is shorter than the CA's slow refusal
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-certs-late-"));
  Object.assign(process.env, { CERTS_SYNC_WAIT_MS: "200", AUTH_DATA_DIR: dir });
  const m = await import("../relay/certs.js?late=1");
  await m.initCerts();
  Object.assign(process.env, saved);
  assert.equal(m.certsEnabled(), true);
  rows = [leaseRow()];
  ca1.slowInvalidMs = 300; ca2.slowInvalidMs = 300;         // validation "fails" 300 ms after the challenge is answered (inside the 400 ms HTTP timeout)
  const name = "cdcdcdcdcdcdcdcdcd.app.enclave.host";
  const key = await genKey();
  const o1 = ca1.calls.newOrder;
  const res = {};
  await m.handleCerts({ method: "POST", body: await body({ name, csr: await csrFor(name, { key }) }) }, res, new URL("http://x/v1/certs/issue"), ctx);
  assert.equal(res.code, 202, JSON.stringify(res.body)); assert.equal(res.body.retryAfterSec, 30);
  await new Promise((s) => setTimeout(s, 1500));           // both CAs refuse, after the reply
  const f = m._internals.store().data.failures[name];
  assert.ok(f && f.n === 1 && /invalid/.test(f.error), `failure recorded after the reply: ${JSON.stringify(f)}`);
  const res2 = {};
  await m.handleCerts({ method: "POST", body: await body({ name, csr: await csrFor(name, { key }) }) }, res2, new URL("http://x/v1/certs/issue"), ctx);
  assert.equal(res2.code, 202); assert.ok(res2.body.retryAfterSec >= 1 && res2.body.retryAfterSec <= 60, JSON.stringify(res2.body));
  assert.equal(ca1.calls.newOrder, o1 + 1, "the backoff answered first: no new order");
  ca1.slowInvalidMs = 0; ca2.slowInvalidMs = 0;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a relay without CERTS_KEY (SECRETS_KEY seals the store) issues for opSig-only requests and for sig-bearing ones it cannot check (operator signature + lease authorize)", async () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-certs-nokey-"));
  delete process.env.CERTS_KEY;
  Object.assign(process.env, { SECRETS_KEY: "ef".repeat(32), AUTH_DATA_DIR: dir });
  const m = await import("../relay/certs.js?nokey=1");
  await m.initCerts();
  Object.assign(process.env, saved); delete process.env.SECRETS_KEY;
  assert.equal(m.certsEnabled(), true);
  rows = [leaseRow()];
  const go = async (b) => { const res = {}; await m.handleCerts({ method: "POST", body: b }, res, new URL("http://x/v1/certs/issue"), ctx); return res; };
  let r = await go(await body({ sig: "" }));
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(sanOf(r.body.certPem), `DNS:${NAME}`);
  r = await go(await body({ csr: await csrFor(NAME) }));    // a fleet HMAC this relay cannot check: not a refusal, opSig + lease carry it
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(sanOf(r.body.certPem), `DNS:${NAME}`);
  // a WRONG opSig is still refused even though the sig is present: nothing checks sig here
  r = await go(await body({ account: OTHER }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "wrong_operator");
  // the account blob is sealed under SECRETS_KEY and opens there, not under the main instance's CERTS_KEY
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "certs.json"), "utf8"));
  const blob = onDisk.accounts[ca1.url + "/directory"];
  assert.ok(blob && !blob.includes("PRIVATE KEY"));
  assert.match(m._internals.open(ca1.url + "/directory", blob).pkcs8, /BEGIN PRIVATE KEY/);
  assert.throws(() => _internals.open(ca1.url + "/directory", blob));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("disabled module answers 503 certs_disabled", async () => {
  // a second instance of the module with the switches unset: the import cache
  // is per-URL, so a query string yields a fresh evaluation
  const saved = { ...process.env };
  delete process.env.CERTS_KEY;
  const m = await import("../relay/certs.js?disabled=1");
  await m.initCerts();
  Object.assign(process.env, saved);
  assert.equal(m.certsEnabled(), false);
  const res = {};
  await m.handleCerts({ method: "POST", body: {} }, res, new URL("http://x/v1/certs/issue"), ctx);
  assert.equal(res.code, 503); assert.equal(res.body.error, "certs_disabled");
});
