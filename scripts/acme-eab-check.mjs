#!/usr/bin/env node
// Burn-test an ACME External Account Binding credential from a workstation,
// using the SAME JOSE construction as supervisor.js (helpers mirrored from
// there - keep them in sync). Two modes:
//
//   node scripts/acme-eab-check.mjs --kid <keyId> --hmac <b64MacKey>
//   node scripts/acme-eab-check.mjs --sa eab-sa.json
//
// The second is the provisioner path: it mints a fresh single-use EAB pair
// via Google's Public CA API (exactly like the supervisor's gtsMintEab, incl.
// the REST double-base64 unwrap heuristic - the output SAYS whether the
// heuristic fired, which live-validates it), then registers with that pair.
// Optional: --directory <url> (default Google Trust Services DV).
//
// WARNING: SUCCESS REGISTERS AN ACCOUNT AND CONSUMES THE PAIR (Google EAB is
// single-use). Never test the pair you mean to give the enclave - mint a
// throwaway (`gcloud publicca external-account-keys create`) or use --sa,
// which mints its own throwaway. The registered account is inert: no certs
// are ordered, and abandoning it costs nothing.
import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import fs from "node:fs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? (process.argv[i + 1] || "") : ""; };
const DIRECTORY = (arg("directory") || "https://dv.acme-v02.api.pki.goog/directory").replace(/\/+$/, "");

// ---- mirrored from supervisor.js (pure half) --------------------------------
const b64u     = (b) => Buffer.from(b).toString("base64url");
const b64uJson = (o) => b64u(JSON.stringify(o));
function jwsSignEs256(protectedHeader, payload, privateKey) {
  const prot = b64uJson(protectedHeader);
  const body = payload === null ? "" : b64uJson(payload);
  const sig  = cryptoSign("sha256", Buffer.from(`${prot}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { protected: prot, payload: body, signature: b64u(sig) };
}
function eabJws(kid, hmacB64u, accountJwk, newAccountUrl) {
  const prot    = b64uJson({ alg: "HS256", kid, url: newAccountUrl });
  const payload = b64uJson(accountJwk);
  const sig     = createHmac("sha256", Buffer.from(hmacB64u, "base64url")).update(`${prot}.${payload}`).digest();
  return { protected: prot, payload, signature: b64u(sig) };
}
function gcpSaAssertion(sa, nowSec) {
  const hdr    = b64uJson({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) });
  const claims = b64uJson({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform",
                            aud: "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 });
  const sig    = cryptoSign("sha256", Buffer.from(`${hdr}.${claims}`), sa.private_key);
  return `${hdr}.${claims}.${b64u(sig)}`;
}
// -----------------------------------------------------------------------------

async function main() {
  let kid = arg("kid").trim(), hmac = arg("hmac").trim();
  const dirR = await fetch(DIRECTORY);
  const dir  = await dirR.json().catch(() => null);
  if (!dirR.ok || !dir?.newAccount) {
    console.error(`directory ${DIRECTORY}: HTTP ${dirR.status}, ${dir ? "unusable JSON" : "not JSON (outage page?)"}`);
    process.exit(1);
  }
  console.log(`directory ok: ${DIRECTORY} (externalAccountRequired=${!!dir.meta?.externalAccountRequired})`);

  if (arg("sa")) {
    const raw = fs.readFileSync(arg("sa"), "utf8").trim();
    const sa  = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    const tokR = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${gcpSaAssertion(sa, Math.floor(Date.now() / 1000))}` });
    const tok = await tokR.json().catch(() => null);
    if (!tokR.ok || !tok?.access_token) { console.error(`gcp token: HTTP ${tokR.status} ${JSON.stringify(tok)?.slice(0, 300)}`); process.exit(1); }
    console.log(`gcp token ok (${sa.client_email})`);
    const kR = await fetch(`https://publicca.googleapis.com/v1/projects/${sa.project_id}/locations/global/externalAccountKeys`, {
      method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: "{}" });
    const data = await kR.json().catch(() => null);
    if (!kR.ok || !data?.keyId || !data?.b64MacKey) { console.error(`eab mint: HTTP ${kR.status} ${JSON.stringify(data)?.slice(0, 300)}`); process.exit(1); }
    kid = data.keyId; hmac = data.b64MacKey;
    const once = Buffer.from(hmac, "base64").toString("utf8");
    const wrapped = once.length >= 40 && /^[A-Za-z0-9_-]+={0,2}$/.test(once);
    if (wrapped) hmac = once;
    console.log(`minted throwaway EAB ${kid} - b64MacKey ${wrapped ? "WAS double-base64-wrapped (supervisor heuristic fires)" : "was NOT wrapped (heuristic passes through)"}`);
  }
  if (!kid || !hmac) { console.error("usage: --kid <keyId> --hmac <b64MacKey>  |  --sa <service-account.json>"); process.exit(2); }

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = publicKey.export({ format: "jwk" });
  const jwk = { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
  const nonce = (await fetch(dir.newNonce, { method: "HEAD" })).headers.get("replay-nonce");
  if (!nonce) { console.error("newNonce returned no replay-nonce"); process.exit(1); }
  // GTS rejects contactless accounts; --contact overrides, no CA verifies it
  const contactRaw = arg("contact") || "hostmaster@enclave.host";
  const contact    = contactRaw.includes(":") ? contactRaw : `mailto:${contactRaw}`;
  const r = await fetch(dir.newAccount, { method: "POST", headers: { "content-type": "application/jose+json" },
    body: JSON.stringify(jwsSignEs256({ alg: "ES256", nonce, url: dir.newAccount, jwk },
      { termsOfServiceAgreed: true, contact: [contact],
        externalAccountBinding: eabJws(kid, hmac, jwk, dir.newAccount) }, privateKey)) });
  const body = await r.json().catch(() => ({}));
  if (r.status === 201) {
    console.log(`REGISTERED: ${r.headers.get("location")}`);
    console.log("the pair is now CONSUMED (single-use) - do NOT hand it to the enclave");
  } else {
    console.error(`FAILED HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
