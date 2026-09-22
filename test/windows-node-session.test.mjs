// Who is asking, for a deployment that is not public. This is an access-control boundary, so the
// tests are mostly about what must be REFUSED.
//
// The rule that looks like an oddity and is the most important one: a control-plane token must
// carry NO audience, and one that names an audience is refused outright. App-origin cookies are
// signed by the same key and live on a tenant origin, where any app bug that can make the browser
// issue a same-origin request can reach them. Without that refusal a leaked app cookie would
// verify identically as a session and open deployment listing, logs and secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sign as nodeSign } from "node:crypto";
import { initSessionKey, mint, verify, appAudience, addressFor, cookieValues, jwkThumbprint, APP_COOKIE }
  from "../windows/node/session.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-sess-"));
const key = initSessionKey({ dir });
const WALLET = "0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C";
const ID = "0x" + "ab".repeat(32);
const b64u = (b) => Buffer.from(b).toString("base64url");

test("a session this box minted verifies, and yields the wallet", () => {
  const t = mint(key, { subject: WALLET, ttlSec: 3600 });
  assert.equal(verify(key, t), WALLET.toLowerCase());
});

test("an app cookie is bound to ONE deployment", () => {
  const t = mint(key, { subject: WALLET, audience: appAudience(ID), ttlSec: 600 });
  assert.equal(verify(key, t, { audience: appAudience(ID) }), WALLET.toLowerCase());
  const other = "0x" + "cd".repeat(32);
  assert.equal(verify(key, t, { audience: appAudience(other) }), null,
    "a cookie minted for another deployment on this same box must fail closed");
});

test("an app cookie is NOT a session, however it is presented", () => {
  const cookie = mint(key, { subject: WALLET, audience: appAudience(ID), ttlSec: 600 });
  assert.equal(verify(key, cookie), null,
    "the blast radius of a leaked app cookie stays 'that one app' only because of this");
  // ...and it does not become one by being sent as a bearer either.
  assert.equal(addressFor(key, { authorization: `Bearer ${cookie}` }, ID), null);
});

test("a session IS accepted as a session, and as the app cookie's carrier it is not", () => {
  const sess = mint(key, { subject: WALLET, ttlSec: 3600 });
  assert.equal(addressFor(key, { authorization: `Bearer ${sess}` }, ID), WALLET.toLowerCase());
  // A control-plane token in the cookie jar is not an app token: it names no audience.
  assert.equal(addressFor(key, { cookie: `${APP_COOKIE}=${sess}` }, ID), null);
});

test("an expired or not-yet-valid token is refused", () => {
  const t = mint(key, { subject: WALLET, ttlSec: 1 });
  assert.equal(verify(key, t), WALLET.toLowerCase());
  assert.equal(verify(key, t, { now: Date.now() + 2000 }), null, "expired");
});

test("a token minted by ANOTHER key is refused, even with our kid on it", () => {
  const other = initSessionKey({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-sess2-")) });
  assert.notEqual(other.kid, key.kid);
  assert.equal(verify(key, mint(other, { subject: WALLET, ttlSec: 3600 })), null);
  // Now forge the header so the kid matches ours but the signature is theirs.
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "ES256", kid: key.kid, typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: key.kid, sub: WALLET, iat: now, exp: now + 3600 }));
  const sig = nodeSign("sha256", Buffer.from(`${header}.${body}`), { key: other.priv, dsaEncoding: "ieee-p1363" });
  assert.equal(verify(key, `${header}.${body}.${b64u(sig)}`), null,
    "a matching kid is a hint, never a credential");
});

test("alg is never taken from the token", () => {
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ iss: key.kid, sub: WALLET, iat: now, exp: now + 3600 }));
  for (const alg of ["none", "HS256", "ES384", "RS256"]) {
    const header = b64u(JSON.stringify({ alg, kid: key.kid, typ: "JWT" }));
    // "none" with an empty signature is the classic; HS256 signed with the public key is the other.
    assert.equal(verify(key, `${header}.${body}.`), null, `${alg} with no signature`);
    // 64 bytes so it is the right LENGTH for raw R||S - the refusal must come from the algorithm
    // check, not from a length check that happens to fire first.
    const fake = b64u(Buffer.alloc(64, 0x41));
    assert.equal(verify(key, `${header}.${body}.${fake}`), null, `${alg} with a well-formed but wrong signature`);
    // ...and a signature that is genuinely valid ES256 must STILL be refused when the header
    // claims another algorithm, which is the actual attack.
    const real = nodeSign("sha256", Buffer.from(`${header}.${body}`), { key: key.priv, dsaEncoding: "ieee-p1363" });
    assert.equal(verify(key, `${header}.${body}.${b64u(real)}`), null,
      `${alg} with a REAL ES256 signature: the header must not select the algorithm`);
  }
});

test("a signature in DER rather than raw R||S is refused", () => {
  // The trap this module's header warns about, from the other side: node signs DER by default,
  // and a verifier that accepted it would accept signatures a real JWS client cannot produce.
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "ES256", kid: key.kid, typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: key.kid, sub: WALLET, iat: now, exp: now + 3600 }));
  const der = nodeSign("sha256", Buffer.from(`${header}.${body}`), { key: key.priv });   // DER
  assert.notEqual(der.length, 64);
  assert.equal(verify(key, `${header}.${body}.${b64u(der)}`), null);
});

test("junk in any position is refused rather than thrown", () => {
  for (const t of ["", ".", "a.b", "a.b.c.d", "....", "a.b.c",
                   "eyJhbGciOiJFUzI1NiJ9..", "x".repeat(5000), null, undefined, 42, {}]) {
    assert.equal(verify(key, t), null, JSON.stringify(t));
  }
});

test("a subject that is not an address yields nothing", () => {
  for (const sub of ["", "not-an-address", "0x123", "0x" + "z".repeat(40), WALLET + "00"])
    assert.equal(verify(key, mint(key, { subject: sub, ttlSec: 600 })), null, sub);
});

test("every cookie sent under our name is tried, so a planted duplicate cannot shadow the real one", () => {
  const good = mint(key, { subject: WALLET, audience: appAudience(ID), ttlSec: 600 });
  const header = `${APP_COOKIE}=junk; other=x; ${APP_COOKIE}=${good}; ${APP_COOKIE}=alsojunk`;
  assert.deepEqual(cookieValues(header, APP_COOKIE).length, 3);
  assert.equal(addressFor(key, { cookie: header }, ID), WALLET.toLowerCase());
});

test("the kid is the RFC 7638 thumbprint, and it is per box", () => {
  const j = key.jwk;
  assert.equal(key.kid, jwkThumbprint(j));
  assert.equal(j.alg, "ES256");
  assert.equal(j.crv, "P-256");
  assert.ok(!("d" in j), "the published JWK must never carry the private half");
});

test("the key survives a restart, so a tenant is not signed out by a config change", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ee-sess3-"));
  const first = initSessionKey({ dir: d });
  const t = mint(first, { subject: WALLET, ttlSec: 3600 });
  const second = initSessionKey({ dir: d });           // as if the agent restarted
  assert.equal(second.kid, first.kid);
  assert.equal(verify(second, t), WALLET.toLowerCase());
});
