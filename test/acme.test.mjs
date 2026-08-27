// In-enclave ACME (supervisor.js) — the pure half: CSR/DER, RFC 7638
// thumbprints, JWS/EAB signing, dns-01 TXT derivation. The supervisor is a
// monolith with boot side effects, so instead of importing it we drive its
// env-gated self-test seam (ACME_SELFTEST=csr|cas|sni|vectors|platform prints one JSON line and
// exits BEFORE any socket/state work) as a child process, then validate the
// outputs against INDEPENDENT implementations: openssl for the hand-built
// PKCS#10, jose (a second RFC 7638 implementation) for thumbprints, and raw
// node:crypto recomputation for the EAB HMAC and TXT value.
//
// The full ACME network flow (account/order/finalize against ZeroSSL) is
// deliberately untested here: it needs real EAB credentials and public DNS,
// and every network entry point in the supervisor is gated on those envs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint } from "jose";
import http from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { issueSig, issueMessage } from "../relay/certs.js";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

// Spawn the supervisor in self-test mode; the seam exits before boot, so this
// is fast and side-effect free. Warnings go to stderr; the payload is the last
// stdout line. The ACME/registry/book envs are cleared so nothing else stirs.
async function selftest(mode, extraEnv = {}) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", ACME_SELFTEST: mode,
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "",
           CERTS_API: "", TCP_CERT_DOMAIN: "", REGISTRY_PRIVATE_KEY: "", PUBLIC_URL: "",
           ...extraEnv } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
let _vectors = null;
const vectors = async () => (_vectors ??= await selftest("vectors"));

// RFC 7515 Appendix A.3's P-256 key — the fixed vector the selftest hashes.
const VEC_JWK = { kty: "EC", crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" };

// ---------- CSR builder (the hand-rolled DER) --------------------------------

test("CSR: openssl verifies the self-signature and reads the SAN", async (t) => {
  const out = await selftest("csr", { ACME_SELFTEST_NAME: "test.app.enclave.host" });
  assert.match(out.csrPem, /^-----BEGIN CERTIFICATE REQUEST-----\n/);
  assert.match(out.keyPem, /^-----BEGIN PRIVATE KEY-----\n/);   // pkcs8, ready for tls.createSecureContext
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-acme-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const csrPath = path.join(dir, "csr.pem");
  fs.writeFileSync(csrPath, out.csrPem);
  // openssl 3 prints "Certificate request self-signature verify OK" on stderr
  const { stdout, stderr } = await pexec("openssl", ["req", "-in", csrPath, "-verify", "-noout", "-text"]);
  const text = stdout + stderr;
  assert.match(text, /verify OK/i, "openssl must accept the CSR signature");
  assert.match(text, /Subject Alternative Name/, "extensionRequest must carry a SAN");
  assert.match(text, /DNS:test\.app\.enclave\.host/, "the SAN must name the requested host");
  assert.match(text, /ecdsa-with-SHA256/, "signature algorithm");
  assert.match(text, /CN\s*=\s*test\.app\.enclave\.host/, "cosmetic CN");
});

test("CSR: the SAN follows the requested name", async () => {
  const out = await selftest("csr", { ACME_SELFTEST_NAME: "abcd1234.app.enclave.host" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-acme-"));
  try {
    const csrPath = path.join(dir, "csr.pem");
    fs.writeFileSync(csrPath, out.csrPem);
    const { stdout, stderr } = await pexec("openssl", ["req", "-in", csrPath, "-verify", "-noout", "-text"]);
    assert.match(stdout + stderr, /DNS:abcd1234\.app\.enclave\.host/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- RFC 7638 thumbprint ----------------------------------------------

test("thumbprint: matches jose's independent RFC 7638 implementation", async () => {
  const v = await vectors();
  assert.equal(v.thumbprint, await calculateJwkThumbprint(VEC_JWK, "sha256"));
});

test("thumbprint: canonical - member order and extra members don't matter", async () => {
  const v = await vectors();
  assert.equal(v.thumbprintScrambled, v.thumbprint);
  assert.equal(v.ownThumbprintStable, true);
});

// ---------- base64url + JWS ---------------------------------------------------

test("base64url: lossless roundtrip, no padding or +/ characters", async () => {
  const v = await vectors();
  assert.equal(v.b64uRoundtrip, true);
  assert.equal(v.b64uNoPad, true);
});

test("JWS ES256: node verifies the ieee-p1363 signature over protected.payload", async () => {
  const v = await vectors();
  assert.equal(v.jwsVerifies, true);
});

// ---------- dns-01 TXT value ---------------------------------------------------

test("dns-01: TXT value is b64u(sha256(token '.' thumbprint)), recomputed here", async () => {
  const v = await vectors();
  const keyAuth = `token.${await calculateJwkThumbprint(VEC_JWK, "sha256")}`;
  assert.equal(v.dns01, createHash("sha256").update(keyAuth).digest("base64url"));
});

// ---------- CA slot parsing (multi-CA failover config) -------------------------
// ACME_SELFTEST=cas prints the parsed ACME_CAS list (secrets reduced to a
// presence bit) plus the ACME_ENABLED verdict — the config half of the CA
// failover added after the 2026-07-18 ZeroSSL/Sectigo blackout.

const ZEROSSL = "https://acme.zerossl.com/v2/DV90";
const EAB_CA  = "https://acme.example-ca.test/directory";   // any EAB'd fallback (parse-level fixture)
// every ACME env cleared, then the case's overrides
const casOf = (extraEnv) => selftest("cas", {
  ACME_DIRECTORY: "", ACME_DIRECTORY_2: "", ACME_DIRECTORY_3: "",
  ACME_EAB_KID_2: "", ACME_EAB_HMAC_2: "", ACME_EAB_KID_3: "", ACME_EAB_HMAC_3: "",
  ...extraEnv });

test("cas: primary alone - EAB pair rides the default ZeroSSL directory", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h" });
  assert.deepEqual(v.cas, [{ directory: ZEROSSL, host: "acme.zerossl.com", eab: true }]);
});

test("cas: fallback slot rides behind the primary, in order", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                          ACME_DIRECTORY_2: EAB_CA, ACME_EAB_KID_2: "k2", ACME_EAB_HMAC_2: "h2" });
  assert.deepEqual(v.cas.map((c) => c.host), ["acme.zerossl.com", "acme.example-ca.test"]);
  assert.deepEqual(v.cas.map((c) => c.eab), [true, true]);
});

test("cas: an EAB-less fallback (Let's Encrypt style) is a valid slot", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                          ACME_DIRECTORY_2: "https://acme-v02.api.letsencrypt.org/directory" });
  assert.deepEqual(v.cas.map((c) => c.eab), [true, false]);
});

test("cas: half an EAB pair skips the slot, not the feature", async () => {
  const v = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                          ACME_DIRECTORY_2: EAB_CA, ACME_EAB_KID_2: "k2" });   // HMAC_2 missing
  assert.deepEqual(v.cas.map((c) => c.host), ["acme.zerossl.com"]);
});

test("cas: a fallback stands alone when the primary has no EAB pair", async () => {
  const v = await casOf({ ACME_DIRECTORY_2: EAB_CA, ACME_EAB_KID_2: "k2", ACME_EAB_HMAC_2: "h2" });
  assert.deepEqual(v.cas.map((c) => c.host), ["acme.example-ca.test"]);
});

test("cas: the bare default directory is not an opt-in; enabled needs a slot + domain + dns api", async () => {
  assert.deepEqual((await casOf({})).cas, []);
  assert.equal((await casOf({})).enabled, false);
  const partial = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h" });   // no APP_CERT_DOMAIN/DNS_API
  assert.equal(partial.enabled, false);
  const full = await casOf({ ACME_EAB_KID: "k", ACME_EAB_HMAC: "h",
                             APP_CERT_DOMAIN: "app.enclave.host", DNS_API: "http://10.0.0.1:8153" });
  assert.equal(full.enabled, true);
});

// ---------- SNI decision (fail-closed app zone) --------------------------------
// ACME_SELFTEST=sni prints sniDecide's verdict for a fixed case table: "acme"
// (the held CA cert), "bridge" (the pin-verified self-signed pair), or
// "refuse" (fail closed). The invariant under test: an app-zone name is NEVER
// served the self-signed placeholder — a hosted app's TLS either presents its
// real CA cert or the handshake is refused, so click-through/-k clients can't
// send sensitive traffic over an unauthenticatable session. Non-app names and
// SNI-less clients keep the bridge pair (the attested-origin pin flow).

test("sni: app-zone names are CA-or-refuse; pin-flow names keep the bridge pair", async () => {
  const v = await selftest("sni", { APP_CERT_DOMAIN: "app.enclave.host" });
  assert.equal(v.held,       "acme");     // held CA cert always wins
  assert.equal(v.appNoCert,  "refuse");   // the directive: no valid cert -> nothing is sent
  assert.equal(v.subSub,     "refuse");   // any depth under the app zone fails closed
  assert.equal(v.caseFold,   "refuse");   // SNI is case-folded before the zone check
  assert.equal(v.bareDomain, "bridge");   // no app lives at the bare domain
  assert.equal(v.legacyTcp,  "bridge");   // legacy tcp zone = documented pin flow
  assert.equal(v.noSni,      "bridge");   // SNI-less clients = pin flow by definition
});

// A customer's own domain is CA-or-refuse for a sharper reason than an app-zone
// name: the bridge pair is a wildcard for OUR zone, so on their hostname it is
// not merely unauthenticatable, it is plainly invalid. Serving it would put a
// certificate error on the customer's brand. A name we manage nothing for is
// unaffected — that is still the pin flow.
test("sni: an attached custom domain is CA-or-refuse; unmanaged names are untouched", async () => {
  const v = await selftest("sni", { APP_CERT_DOMAIN: "app.enclave.host" });
  assert.equal(v.customHeld,   "acme");     // its own CA cert, minted in-CVM
  assert.equal(v.customNoCert, "refuse");   // attached but not yet issued -> no handshake
  assert.equal(v.unknownName,  "bridge");   // same string, NOT attached -> unchanged behavior
});

test("sni: no APP_CERT_DOMAIN (feature off) leaves every name on the bridge pair", async () => {
  const v = await selftest("sni", {});    // APP_CERT_DOMAIN cleared by the harness
  assert.equal(v.appNoCert, "bridge");
  assert.equal(v.noSni,     "bridge");
});

// ---------- EAB inner JWS ------------------------------------------------------

test("EAB: HS256 inner JWS - header shape, JWK payload, recomputed signature", async () => {
  const v = await vectors();
  // protected header: HS256 + the CA-issued kid + the newAccount URL
  assert.deepEqual(JSON.parse(Buffer.from(v.eab.protected, "base64url")),
                   { alg: "HS256", kid: "kid1", url: "https://ca/newAccount" });
  // payload: the ACME account's public JWK, verbatim
  assert.deepEqual(JSON.parse(Buffer.from(v.eab.payload, "base64url")), VEC_JWK);
  // signature: HMAC-SHA256 over protected.payload with the b64url-DECODED key
  // (the selftest feeds b64u("secret") as the credential, so the raw key is "secret")
  const expect = createHmac("sha256", Buffer.from("secret"))
    .update(`${v.eab.protected}.${v.eab.payload}`).digest("base64url");
  assert.equal(v.eab.signature, expect);
});

// ---------- platform certificate service (slot 0) -----------------------------
// ACME_SELFTEST=platform drives the REAL service client (acmeIssueViaPlatform +
// acmeWalkSlots) against a mock service started here, with stub in-enclave CA
// slots behind it. The mock signs the enclave's CSR with a throwaway openssl
// CA so the returned chain is a real certificate for the enclave's own key -
// which is exactly what the client checks before installing it. The contract
// under test is the one relay/certs.js implements: the wire shape, the two
// signatures, the 200/202/4xx/5xx meanings, and the slot order.

const OP_KEY  = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // a well-known test key, never funded
const OP_ADDR = privateKeyToAccount(OP_KEY).address;
const ENDPOINT = "https://box7.enclave.containers.tinfoil.dev";
const CERTS_KEY = createHmac("sha256", "test-secret").update("enclave certs v1").digest("hex");   // the harness's SECRET
// The wire format, spelled out here INDEPENDENTLY of both files, and then
// cross-checked against the relay's own issueSig / issueMessage so the two
// halves can never drift apart under a green run again (2026-08-27: the
// supervisor keyed its HMAC with the hex string, the relay with the decoded
// bytes, and each side's test pinned its own convention).
//   sig   = HMAC-SHA256(hex-decode(CERTS_KEY), "<name>:<endpoint>:<spkiHash>:<ts>") hex
//   opSig = personal_sign("enclave-certs-issue:<name>:<endpoint>:<spkiHash>:<ts>")
//   spkiHash = sha256 hex of the CSR key's DER SubjectPublicKeyInfo
const wireTuple  = (name, endpoint, spkiHash, ts) => `${name}:${endpoint}:${spkiHash}:${ts}`;
const wireSig    = (keyHex, name, endpoint, spkiHash, ts) =>
  createHmac("sha256", Buffer.from(keyHex, "hex")).update(wireTuple(name, endpoint, spkiHash, ts)).digest("hex");
const wireOpText = (name, endpoint, spkiHash, ts) => `enclave-certs-issue:${wireTuple(name, endpoint, spkiHash, ts)}`;
const spkiHashOfPem = (pubPem) =>
  createHash("sha256").update(createPublicKey(pubPem).export({ type: "spki", format: "der" })).digest("hex");
// relay/certs.js under the amended contract takes (keyHex, name, endpoint,
// spkiHash, ts) / (name, endpoint, spkiHash, ts). Until the relay half lands
// the imports still have the old arity; the cross-file pin then reports
// itself as pending rather than asserting against the wrong signature.
const RELAY_BINDS_KEY = issueSig.length === 5 && issueMessage.length === 4;
function assertRelayPins(t, keyHex, name, endpoint, spkiHash, ts, sig, opText) {
  if (!RELAY_BINDS_KEY) { t.diagnostic("relay/certs.js issueSig/issueMessage do not take spkiHash yet: cross-file pin PENDING the relay track"); return; }
  assert.equal(sig, issueSig(keyHex, name, endpoint, spkiHash, ts), "sig must be byte-for-byte what relay/certs.js expects");
  assert.equal(opText, issueMessage(name, endpoint, spkiHash, ts), "opSig text must be byte-for-byte what relay/certs.js recovers over");
}

// A throwaway CA, made once; the mock signs CSRs with it.
let _ca = null;
async function caDir() {
  if (_ca) return _ca;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-certs-ca-"));
  await pexec("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"), "-days", "2", "-subj", "/CN=Enclave Test CA"]);
  return (_ca = dir);
}
const randomName = () => createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8);
async function signCsr(csrPem, days = 90) {
  const ca = await caDir();
  const n = randomName();
  fs.writeFileSync(path.join(ca, `${n}.csr`), csrPem);
  await pexec("openssl", ["x509", "-req", "-in", path.join(ca, `${n}.csr`), "-CA", path.join(ca, "ca.pem"),
    "-CAkey", path.join(ca, "ca.key"), "-CAcreateserial", "-days", String(days), "-copy_extensions", "copy",
    "-out", path.join(ca, `${n}.pem`)]);
  return fs.readFileSync(path.join(ca, `${n}.pem`), "utf8") + fs.readFileSync(path.join(ca, "ca.pem"), "utf8");
}
async function csrInfo(csrPem) {
  const f = path.join(await caDir(), `${randomName()}.info.csr`);
  fs.writeFileSync(f, csrPem);
  const { stdout } = await pexec("openssl", ["req", "-in", f, "-noout", "-text", "-verify"]);
  const { stdout: pub } = await pexec("openssl", ["req", "-in", f, "-noout", "-pubkey"]);
  return { text: stdout, pubkey: pub.trim() };
}
async function leafPubkey(certPem) {
  const f = path.join(await caDir(), `${randomName()}.leaf.pem`);
  fs.writeFileSync(f, certPem);
  const { stdout } = await pexec("openssl", ["x509", "-in", f, "-noout", "-pubkey"]);
  return stdout.trim();
}

// The mock service: `script` = the replies in order (each a function of the
// body; the last one repeats), `seen` = every request it received.
async function mockService(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, body });
      const step = script.length > 1 ? script.shift() : script[0];
      const reply = await step(body);
      if (reply.raw) { res.writeHead(reply.status, { "content-type": "text/html" }); return res.end(reply.raw); }
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}
const ok200 = async (body) => ({ status: 200, json: { name: body.name, certPem: await signCsr(body.csr), ca: "zerossl", cached: false } });

const platformOf = (api, c, extra = {}) => selftest("platform", {
  CERTS_API: api, APP_CERT_DOMAIN: "app.enclave.host", ACME_SELFTEST_PLATFORM: JSON.stringify(c), ...extra });
const ZS = { host: "acme.zerossl.com", outcome: "ok" }, LE = { host: "acme-v02.api.letsencrypt.org", outcome: "ok" };
const APP = "abcd1234.app.enclave.host";

test("platform: an app-zone name goes to the service first; the returned chain is installed for the enclave's own key", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, opKey: OP_KEY, cas: [ZS, LE] });
  assert.equal(v.inZone, true);
  const [r] = v.rounds;
  assert.equal(r.outcome, "issued");
  assert.deepEqual(r.tried, ["platform"], "no in-enclave CA is spent when the service issues");
  assert.equal(r.issuer, "platform (zerossl)");                       // the log line reads "issued <name> via platform (zerossl)"
  assert.equal(r.caHost, "platform");
  assert.equal(r.ctxOk, true, "a TLS context was built from OUR key + THEIR chain");
  assert.equal(r.keyHeld, true);
  assert.ok(r.expiresAt > Date.now() + 80 * 86400_000 && r.renewAt < r.expiresAt, "renewAt at 2/3 of the leaf's lifetime");
  // the request the service saw: exactly the contract's body
  assert.equal(svc.seen.length, 1);
  const { url, body } = svc.seen[0];
  assert.equal(url, "/v1/certs/issue");
  assert.deepEqual(Object.keys(body).sort(), ["csr", "endpoint", "name", "opSig", "sig", "ts"], "the harness SECRET counts as the fleet secret (flag unset = Tinfoil), so sig rides along");
  assert.equal(body.name, APP);
  assert.equal(body.endpoint, ENDPOINT);
  assert.ok(Math.abs(body.ts - Date.now() / 1000) < 60, "ts is unix seconds, now");
  // the CSR: one CN, one SAN dNSName, both the name, EC P-256, self-signature ok
  const info = await csrInfo(body.csr);
  assert.match(info.text, /CN\s*=\s*abcd1234\.app\.enclave\.host/);
  assert.match(info.text, /DNS:abcd1234\.app\.enclave\.host/);
  assert.match(info.text, /prime256v1|P-256/);
  assert.equal((info.text.match(/DNS:/g) || []).length, 1);
  // the leaf we got back is for the CSR's key
  assert.equal(await leafPubkey(r.certPem), info.pubkey);
});

test("platform: sig = HMAC-SHA256(hex-decode(CERTS_KEY), '<name>:<endpoint>:<spkiHash>:<ts>') hex; CERTS_KEY = HMAC-SHA256(SECRET, 'enclave certs v1') hex; pinned against relay/certs.js issueSig", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [] });
  assert.equal(v.fleetSecretPresent, true, "FLEET_SECRET_PRESENT unset + SECRET set = the fleet secret (the Tinfoil image sets no flag)");
  assert.equal(v.certsKey, CERTS_KEY);
  // the printed vector: spkiHash recomputed here from the printed key's SPKI
  assert.equal(v.spkiHash, spkiHashOfPem(v.vecKeyPem));   // createPublicKey accepts a private PEM and yields its public half
  assert.equal(v.tuple, wireTuple(APP, ENDPOINT, v.spkiHash, 1700000000));
  assert.equal(v.sig, wireSig(CERTS_KEY, APP, ENDPOINT, v.spkiHash, 1700000000));
  assert.notEqual(v.sig, createHmac("sha256", CERTS_KEY).update(v.tuple).digest("hex"), "NOT the hex string's own bytes as the key");
  assertRelayPins(t, CERTS_KEY, APP, ENDPOINT, v.spkiHash, 1700000000, v.sig, v.opSigText);
  // and the live request's sig recomputes from ITS ts and ITS CSR's key the same way
  const { body } = svc.seen[0];
  const info = await csrInfo(body.csr);
  const spki = spkiHashOfPem(info.pubkey);
  assert.equal(body.sig, wireSig(CERTS_KEY, body.name, body.endpoint, spki, body.ts));
  assert.equal(body.spkiHash, undefined, "spkiHash is not a body field: the relay derives it from the CSR it parsed");
  assertRelayPins(t, CERTS_KEY, body.name, body.endpoint, spki, body.ts, body.sig, wireOpText(body.name, body.endpoint, spki, body.ts));
  assert.equal(body.opSig, undefined, "no operator key on this box -> no opSig field (the relay decides)");
});

test("platform: opSig = EIP-191 personal_sign by the registry operator of 'enclave-certs-issue:<name>:<endpoint>:<spkiHash>:<ts>'; pinned against relay/certs.js issueMessage", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, opKey: OP_KEY, cas: [] });
  assert.equal(v.opSigText, wireOpText(APP, ENDPOINT, v.spkiHash, 1700000000));
  assert.equal(await verifyMessage({ address: OP_ADDR, message: v.opSigText, signature: v.opSig }), true);
  const { body } = svc.seen[0];
  const spki = spkiHashOfPem((await csrInfo(body.csr)).pubkey);
  const opText = wireOpText(body.name, body.endpoint, spki, body.ts);
  assert.equal(await verifyMessage({ address: OP_ADDR, message: opText, signature: body.opSig }), true,
    "the operator signature recovers over the text the relay rebuilds from (name, endpoint, the CSR's SPKI hash, ts)");
  if (RELAY_BINDS_KEY)
    assert.equal(await verifyMessage({ address: OP_ADDR, message: issueMessage(body.name, body.endpoint, spki, body.ts), signature: body.opSig }), true);
  else t.diagnostic("relay/certs.js issueMessage does not take spkiHash yet: cross-file pin PENDING the relay track");
  // a CSR for another key would not verify: the signature binds THIS key
  const other = await selftest("csr", { ACME_SELFTEST_NAME: body.name });
  const otherSpki = spkiHashOfPem((await csrInfo(other.csrPem)).pubkey);
  assert.equal(await verifyMessage({ address: OP_ADDR, message: wireOpText(body.name, body.endpoint, otherSpki, body.ts), signature: body.opSig }), false);
  // the two tuples differ only by their prefix: the relay checks both over the same (name, endpoint, spkiHash, ts)
  assert.equal(v.opSigText, `enclave-certs-issue:${v.tuple}`);
});

// A3: only a box whose SECRET is the fleet secret sends the fleet HMAC. gsup
// says which with FLEET_SECRET_PRESENT=0 (SECRET = randomBytes(32) there); a
// present-but-wrong sig would be 401 bad_sig at the relay, fail closed, and
// the box would never reach the service. So: no CERTS_KEY, no sig, opSig only.
test("platform: a seller box (FLEET_SECRET_PRESENT=0, a minted SECRET) sends NO sig - opSig alone authorizes it", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, opKey: OP_KEY, cas: [ZS] }, { FLEET_SECRET_PRESENT: "0" });
  assert.equal(v.fleetSecretPresent, false);
  assert.equal(v.certsKey, "", "no fleet secret -> no CERTS_KEY derived from the random one");
  assert.equal(v.sig, "");
  assert.equal(v.rounds[0].outcome, "issued");
  assert.equal(v.rounds[0].issuer, "platform (zerossl)");
  const { body } = svc.seen[0];
  assert.deepEqual(Object.keys(body).sort(), ["csr", "endpoint", "name", "opSig", "ts"], "sig is absent, not empty");
  const spki = spkiHashOfPem((await csrInfo(body.csr)).pubkey);
  assert.equal(await verifyMessage({ address: OP_ADDR, message: wireOpText(body.name, body.endpoint, spki, body.ts), signature: body.opSig }), true);
  // ...and the explicit values the launcher may pass
  for (const flag of ["false", "off"]) {
    const w = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, opKey: OP_KEY, cas: [] }, { FLEET_SECRET_PRESENT: flag });
    assert.equal(w.certsKey, "", `FLEET_SECRET_PRESENT=${flag}`);
  }
  const on = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, opKey: OP_KEY, cas: [] }, { FLEET_SECRET_PRESENT: "1" });
  assert.equal(on.certsKey, CERTS_KEY);
});

test("platform: a box with neither the fleet secret nor an operator key fails the name BEFORE the round trip; the in-enclave CAs still run", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [ZS] }, { FLEET_SECRET_PRESENT: "0" });
  assert.deepEqual(v.rounds[0].tried, ["platform", "acme.zerossl.com"]);
  assert.equal(v.rounds[0].issuer, "acme.zerossl.com");
  assert.deepEqual(v.rounds[0].cooled, [], "not the service's fault: nothing cools");
  assert.equal(v.rounds[0].pendingHeld, false, "no key is minted for a request that cannot be signed");
  assert.equal(svc.seen.length, 0, "the service saw nothing");
  const none = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [] }, { FLEET_SECRET_PRESENT: "0" });
  assert.match(none.rounds[0].error, /neither an operator key nor the fleet secret/);
});

// A8: at boot the endpoint is "" until the register tx confirms (Tinfoil has
// no PUBLIC_URL). That is a deferral (15-30 s), never a name-level failure
// that walks the in-enclave CAs for every held name on every restart.
test("platform: not registered yet (endpoint '') DEFERS 15-30 s - no in-enclave CA is walked, nothing cools, no key is minted", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: "", opKey: OP_KEY, cas: [ZS, LE] });
  const [r] = v.rounds;
  assert.equal(r.outcome, "deferred");
  assert.match(r.error, /not registered its endpoint yet/);
  assert.ok(r.deferMs >= 15_000 && r.deferMs <= 30_000, `deferMs ${r.deferMs}`);
  assert.deepEqual(r.tried, ["platform"], "the deferral ends the round before Let's Encrypt is spent");
  assert.deepEqual(r.cooled, []);
  assert.equal(r.pendingHeld, false);
  assert.equal(r.plan.why, "deferred");
  assert.equal(r.plan.failures, 0, "the pump counts no failure against the name");
  assert.equal(svc.seen.length, 0);
});

test("platform: a custom domain, a deeper name, and a foreign zone never touch the service; TCP_CERT_DOMAIN opts a second zone in", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  for (const name of ["shop.example.com", `x.${APP}`, "app.enclave.host", "abcd1234.enclave.host"]) {
    const v = await platformOf(svc.url, { name, endpoint: ENDPOINT, cas: [ZS, LE] });
    assert.equal(v.inZone, false, name);
    assert.deepEqual(v.rounds[0].tried, ["acme.zerossl.com"], `${name}: straight to the in-enclave CAs`);
    assert.equal(v.rounds[0].issuer, "acme.zerossl.com");
  }
  assert.equal(svc.seen.length, 0, "the service saw nothing");
  const tcp = await platformOf(svc.url, { name: "abcd1234.tcp.enclave.host", endpoint: ENDPOINT, cas: [ZS] }, { TCP_CERT_DOMAIN: "tcp.enclave.host" });
  assert.deepEqual(tcp.zones, ["app.enclave.host", "tcp.enclave.host"]);
  assert.equal(tcp.inZone, true);
  assert.deepEqual(tcp.rounds[0].tried, ["platform"]);
  const noTcp = await platformOf(svc.url, { name: "abcd1234.tcp.enclave.host", endpoint: ENDPOINT, cas: [ZS] });
  assert.equal(noTcp.inZone, false, "the tcp zone is not a platform zone unless configured");
});

// A4: the relay holds the POST up to CERTS_SYNC_WAIT_MS (8 s) before it says
// 202; the supervisor's own bound for this call (CERTS_HTTP_MS, 30 s) must
// clear that with margin, or every real order aborts client-side. The mock
// relay here is "slow" for longer than a CA call's default 20 s would be
// worth simulating: it sleeps past the point where a 1 s bound would abort.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("platform: 202 { retryAfterSec } after a SLOW relay defers the name - no in-enclave CA is spent, the retry lands at retryAfterSec with the SAME key", async (t) => {
  const svc = await mockService([async () => { await sleep(1500); return { status: 202, json: { name: APP, retryAfterSec: 45 } }; }, ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [ZS, LE], rounds: 2 }, { ACME_HTTP_TIMEOUT_MS: "1000" });
  assert.equal(v.certsHttpMs, 30_000, "the platform POST's own bound: > the relay's 8 s sync wait, independent of ACME_HTTP_TIMEOUT_MS");
  const [a, b] = v.rounds;
  assert.equal(a.outcome, "deferred", "1.5 s of relay is within CERTS_HTTP_MS even with the CA bound at 1 s");
  assert.equal(a.deferMs, 45_000);
  assert.deepEqual(a.tried, ["platform"], "a deferral ends the round: the in-enclave slots are NOT walked");
  assert.deepEqual(a.cooled, [], "a deferral cools nothing off");
  assert.equal(a.pendingHeld, true, "the minted key waits for the retry");
  assert.deepEqual(a.plan, { failures: 0, nextAt: 1_000_000 + 45_000, why: "deferred" });   // acmeReconcileAt(nextAt), failures untouched
  assert.equal(b.outcome, "issued");
  assert.equal(b.pendingHeld, false);
  assert.equal(svc.seen.length, 2);
  const [k1, k2] = await Promise.all(svc.seen.map((s) => csrInfo(s.body.csr)));
  assert.equal(k1.pubkey, k2.pubkey, "the retry re-presents the same SPKI, so the service's (name, SPKI) cache hits");
  assert.equal(a.pendingSpki, spkiHashOfPem(k1.pubkey), "what is held IS that SPKI");
  assert.equal(v.plans.deferred.failures, 3, "a deferral does not count as a failure");
  assert.equal(v.plans.deferred.nextAt, 1_000_000 + 45_000);
});

test("platform: a POST that times out cools the slot but KEEPS the minted key - the next ask re-presents the same SPKI", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const svc = await mockService([async () => { await gate; return { status: 202, json: { name: APP, retryAfterSec: 45 } }; }, ok200]);
  t.after(async () => { release(); await svc.close(); });
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [], rounds: 2 }, { CERTS_HTTP_TIMEOUT_MS: "700" });
  assert.equal(v.certsHttpMs, 700);
  const [a, b] = v.rounds;
  assert.equal(a.outcome, "failed");
  assert.equal(a.caLevel, true, "a timeout indicts the slot, like a CA");
  assert.match(a.error, /platform: /);
  assert.deepEqual(a.cooled, ["platform"]);
  assert.equal(a.pendingHeld, true, "pending was stored BEFORE the fetch, so the timeout does not lose the key");
  assert.equal(b.outcome, "issued", "every slot cooling = try anyway; the relay (which may have finished the order meanwhile) answers");
  assert.equal(svc.seen.length, 2);
  const [k1, k2] = await Promise.all(svc.seen.map((s) => csrInfo(s.body.csr)));
  assert.equal(k1.pubkey, k2.pubkey, "same SPKI after the timeout: the relay's cache / in-flight order for (name, SPKI) matches");
  assert.equal(a.pendingSpki, spkiHashOfPem(k1.pubkey));
  assert.equal(b.pendingHeld, false, "installed -> dropped");
});

test("platform: a 5xx keeps the minted key too (the relay may still be working the order); a 4xx drops it", async (t) => {
  const svc = await mockService([async () => ({ status: 503, json: { error: "certs_disabled" } }), ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [], rounds: 2 });
  assert.equal(v.rounds[0].pendingHeld, true);
  const [k1, k2] = await Promise.all(svc.seen.map((s) => csrInfo(s.body.csr)));
  assert.equal(k1.pubkey, k2.pubkey);
  const refuse = await mockService([async () => ({ status: 403, json: { error: "not_lease_holder" } })]);
  t.after(refuse.close);
  const r = await platformOf(refuse.url, { name: APP, endpoint: ENDPOINT, cas: [] });
  assert.equal(r.rounds[0].pendingHeld, false);
});

test("platform: 4xx is name-level - the in-enclave slots run unchanged and nothing cools off", async (t) => {
  const svc = await mockService([async () => ({ status: 403, json: { error: "not_lease_holder", message: "no live lease held by endpoint" } })]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [ZS, LE] });
  const [r] = v.rounds;
  assert.equal(r.outcome, "issued");
  assert.deepEqual(r.tried, ["platform", "acme.zerossl.com"]);
  assert.equal(r.issuer, "acme.zerossl.com");
  assert.deepEqual(r.cooled, []);
  assert.equal(r.pendingHeld, false, "a refusal ends the order; the next attempt starts fresh");
});

test("platform: 5xx / an outage page / no service at all cools the service slot off like a CA and falls through", async (t) => {
  const svc = await mockService([async () => ({ status: 503, json: { error: "certs_disabled" } })]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [ZS, LE] });
  assert.deepEqual(v.rounds[0].tried, ["platform", "acme.zerossl.com"]);
  assert.equal(v.rounds[0].issuer, "acme.zerossl.com");
  assert.deepEqual(v.rounds[0].cooled, ["platform"]);
  const html = await mockService([async () => ({ status: 200, raw: "<html>maintenance</html>" })]);
  t.after(html.close);
  const h = await platformOf(html.url, { name: APP, endpoint: ENDPOINT, cas: [ZS] });
  assert.deepEqual(h.rounds[0].cooled, ["platform"]);
  assert.equal(h.rounds[0].issuer, "acme.zerossl.com");
  // nothing listening: a network error, same verdict
  const dead = await mockService([ok200]); await dead.close();
  const d = await platformOf(dead.url, { name: APP, endpoint: ENDPOINT, cas: [ZS] });
  assert.deepEqual(d.rounds[0].cooled, ["platform"]);
  assert.equal(d.rounds[0].issuer, "acme.zerossl.com");
  // a cooling service slot is skipped on the next round while the CAs work
  const two = await mockService([async () => ({ status: 500, json: { error: "boom" } }), ok200]);
  t.after(two.close);
  const w = await platformOf(two.url, { name: APP, endpoint: ENDPOINT, cas: [ZS], rounds: 2 });
  assert.deepEqual(w.rounds[1].tried, ["acme.zerossl.com"], "round 2 skips the cooling platform slot");
  assert.equal(two.seen.length, 1);
});

test("platform: a chain that is not for our key or our name is rejected (the slot cools off) rather than installed", async (t) => {
  const wrongKey = await mockService([async (body) => {
    const other = await selftest("csr", { ACME_SELFTEST_NAME: body.name });        // a CSR for the same name, another key
    return { status: 200, json: { name: body.name, certPem: await signCsr(other.csrPem), ca: "zerossl" } }; }]);
  t.after(wrongKey.close);
  const v = await platformOf(wrongKey.url, { name: APP, endpoint: ENDPOINT, cas: [ZS] });
  assert.deepEqual(v.rounds[0].cooled, ["platform"]);
  assert.equal(v.rounds[0].issuer, "acme.zerossl.com");
  const wrongName = await mockService([async (body) => {
    const other = await selftest("csr", { ACME_SELFTEST_NAME: "ffff0000.app.enclave.host" });
    return { status: 200, json: { name: body.name, certPem: await signCsr(other.csrPem), ca: "zerossl" } }; }]);
  t.after(wrongName.close);
  const n = await platformOf(wrongName.url, { name: APP, endpoint: ENDPOINT, cas: [] });
  assert.equal(n.rounds[0].outcome, "failed");
  assert.equal(n.rounds[0].caLevel, true);
});

test("platform: the retry plan - a cooling slot retries when it is back, name-level failure doubles from 5 min", async (t) => {
  const svc = await mockService([ok200]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [] });
  assert.deepEqual(v.plans.cooling, { failures: 4, nextAt: 1_000_000 + 31_000, why: "cooling" });
  assert.deepEqual(v.plans.backoff, { failures: 2, nextAt: 1_000_000 + 600_000, why: "backoff" });
});

test("platform: every slot refusing the name fails the round name-level; no slot at all is an error, not a hang", async (t) => {
  const svc = await mockService([async () => ({ status: 400, json: { error: "bad_csr", message: "CN != name" } })]);
  t.after(svc.close);
  const v = await platformOf(svc.url, { name: APP, endpoint: ENDPOINT, cas: [{ host: "acme.zerossl.com", outcome: "nameErr" }] });
  assert.equal(v.rounds[0].outcome, "failed");
  assert.equal(v.rounds[0].caLevel, false);
  assert.match(v.rounds[0].error, /refused/);
  const none = await platformOf(svc.url, { name: "shop.example.com", endpoint: ENDPOINT, cas: [] });
  assert.equal(none.rounds[0].outcome, "failed");
  assert.match(none.rounds[0].error, /no issuance slot/);
});

test("cas: CERTS_API alone (no EAB, no DNS_API) enables app-zone issuance through the platform service", async () => {
  const v = await casOf({ CERTS_API: "https://api.enclave.host", APP_CERT_DOMAIN: "app.enclave.host" });
  assert.equal(v.platform, true);
  assert.equal(v.enabled, true);
  assert.deepEqual(v.cas, []);
  const noZone = await casOf({ CERTS_API: "https://api.enclave.host" });
  assert.equal(noZone.enabled, false, "still needs APP_CERT_DOMAIN");
});
