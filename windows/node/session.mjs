// windows/node/session.mjs -- who is asking, for a deployment that is not public.
//
// A PRIVATE deployment serves its owner and nobody else. The platform proves "you hold wallet X"
// with an ES256 JWT: the control-plane session token in an Authorization header, or - because a
// browser cannot put a bearer on a top-level navigation - a cookie on the app's own origin, bound
// by `aud` to ONE deployment.
//
// THE RULE THAT MATTERS MOST is the one that looks like an oddity: a control-plane token must
// carry NO audience, and a token that names one is refused outright. Both kinds are signed by the
// same key, and the app cookie lives on a TENANT origin where any app bug that can make the
// browser issue a same-origin request can reach it. Without that refusal a leaked app cookie would
// verify identically as a session and open deployment listing, logs and secrets. The blast radius
// of a leaked app cookie stays "that one app" only because of it.
//
// WHAT A SESSION IS WORTH ON THIS BOX, said here because it is not what it is worth on a
// confidential VM. The platform mints this key INSIDE the enclave, so the operator never sees the
// private half and cannot forge a session for somebody else's wallet. Here the key is minted in
// the agent's process in VTL0, beside the proof key and the app-zone TLS key, because VTL1 has no
// way to mint or sign one yet. So on this box a session is worth exactly what the machine owner's
// word is worth - and that is the SAME bar the box already publishes for app traffic
// (`appTls.keyIn: "host-process"`), not a new one: the owner already carries every byte of a
// tenant's traffic and holds the key that terminates its TLS. `/availability` says where this key
// lives too, so a tenant choosing this box is told rather than left to assume.
//
// No `jose` on this box - only viem, ws and tweetnacl - so the JWS is done with node's own crypto.
// ES256 signatures in JWS are raw R||S, which is `dsaEncoding: "ieee-p1363"`, NOT the DER that
// node produces by default; getting that wrong yields a signature every verifier rejects.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

/** RFC 7638 thumbprint: stable per key, unique per box, and what `kid` and `iss` both carry. */
export function jwkThumbprint(jwk) {
  return b64u(createHash("sha256")
    .update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).digest());
}

/**
 * This box's session-signing key: reused from disk, or minted.
 *
 * Persisted so a restart does not invalidate every live session - a tenant re-signing in every
 * time the agent restarts would make the feature unusable on a box that restarts for a config
 * change. Mode 0600, and its exposure is the header's subject.
 */
export function initSessionKey({ dir, log = () => {} }) {
  const file = path.join(dir, "session-ec-p256.pkcs8.pem");
  let priv = null;
  try { priv = createPrivateKey(fs.readFileSync(file, "utf8")); } catch {}
  if (!priv) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    priv = privateKey;
    try { fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }); }
    catch (e) { log(`session: could not persist the key (${e.message}); sessions end at the next restart`); }
    log("session: minted an ES256 session-signing key");
  }
  const pub = createPublicKey(priv);
  const j = pub.export({ format: "jwk" });
  const kid = jwkThumbprint(j);
  return { priv, pub, kid, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y, kid, alg: "ES256", use: "sig" } };
}

/** `aud` for an app-origin cookie. One deployment, and the platform's exact spelling. */
export const appAudience = (id) => "app:" + String(id).toLowerCase();

/** Sign a JWT with this box's session key. `audience` absent = a control-plane session. */
export function mint(key, { subject, audience = null, ttlSec }) {
  const header = b64u(JSON.stringify({ alg: "ES256", kid: key.kid, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: key.kid, sub: subject, iat: now, exp: now + Math.max(1, Math.floor(ttlSec)) };
  if (audience) claims.aud = audience;
  const body = b64u(JSON.stringify(claims));
  const sig = nodeSign("sha256", Buffer.from(`${header}.${body}`), { key: key.priv, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64u(sig)}`;
}

/**
 * Verify a token minted by THIS box, and return its subject, or null.
 *
 * Never throws and never distinguishes WHY it failed to the caller: a verifier that reports "bad
 * signature" separately from "expired" hands an attacker a test they did not have. Everything
 * that is not a valid token for the expected audience reads the same.
 *
 * `audience` is compared here rather than left to the caller for the reason the platform gives:
 * a check the caller might forget is a check that will eventually be forgotten. `null` means a
 * CONTROL-PLANE token, and then a token carrying ANY audience is refused - see the header.
 */
export function verify(key, token, { audience = null, now = Date.now() } = {}) {
  if (!key || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(unb64u(parts[0]).toString("utf8"));
    claims = JSON.parse(unb64u(parts[1]).toString("utf8"));
  } catch { return null; }
  if (!header || header.alg !== "ES256") return null;          // never trust `alg` to select an algorithm
  if (header.kid !== key.kid) return null;                     // not minted by this box
  if (!claims || claims.iss !== key.kid) return null;
  let sig;
  try { sig = unb64u(parts[2]); } catch { return null; }
  if (sig.length !== 64) return null;                          // raw R||S for P-256, nothing else
  let ok = false;
  try {
    ok = nodeVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`),
                    { key: key.pub, dsaEncoding: "ieee-p1363" }, sig);
  } catch { return null; }
  if (!ok) return null;
  const t = Math.floor(now / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= t) return null;
  if (Number.isFinite(claims.nbf) && claims.nbf > t) return null;
  if (audience === null) {
    // THE RULE. An app cookie is signed by this same key and would otherwise verify identically.
    if (claims.aud !== undefined) return null;
  } else {
    const a = claims.aud;
    const list = Array.isArray(a) ? a : [a];
    const want = Buffer.from(String(audience));
    if (!list.some((x) => typeof x === "string" && x.length === want.length
                          && timingSafeEqual(Buffer.from(x), want))) return null;
  }
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  return /^0x[0-9a-fA-F]{40}$/.test(sub) ? sub.toLowerCase() : null;
}

/** Every value sent under `name`, because a planted duplicate must not shadow the real one. */
export function cookieValues(header, name) {
  const out = [];
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    out.push(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The address this request proves, for THIS deployment, or null.
 *
 * Bearer first, then every cookie sent under our name. Each miss is one cheap verify, and the
 * number a browser will send is bounded - trying them all is what stops a planted duplicate from
 * shadowing the real one.
 */
export function addressFor(key, headers, id) {
  if (!key) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(headers?.authorization || ""));
  if (m) { const a = verify(key, m[1].trim()); if (a) return a; }
  for (const c of cookieValues(headers?.cookie, APP_COOKIE)) {
    const a = verify(key, c, { audience: appAudience(id) });
    if (a) return a;
  }
  return null;
}

export const APP_COOKIE = "enclave_app";
