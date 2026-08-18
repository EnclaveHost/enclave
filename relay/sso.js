/* ============================================================
   Sign in with Enclave (SSO): mint EST1 tokens for tenant apps.

   A tenant app that wants "the same login as enclave.host" cannot
   share the credential - a WalletConnect pairing is per dapp and a
   passkey is bound to this RP - so what travels is a CLAIM: a
   short-lived signed note ("EST1 token") naming the signed-in
   account's wallet address and ONE deployment as its audience. The
   app verifies it inside its own enclave against a pinned signer
   address, statelessly; the platform is trusted exactly once, at
   mint. The app-side contract is enclave-apps/eyesoff-ai/
   PLATFORM-sso.md; the verifier is that repo's sso.rs.

   Token: EST1.<b64url(claims JSON)>.<b64url(65-byte r||s||v)>
   Claims {v:1, sub:<acct_<hex> account id>, aud:<0x64-hex
   deployment>, iat, exp}, keys SORTED so a token minted here for
   the spec vector's claims is byte-identical to the one pinned in
   the app's test suite (the vector predates account subs and
   carries an address; the verifier takes both shapes). The signature is EIP-191 personal_sign over
   the token's own first two segments ("EST1.<b64>"), byte exact -
   no canonical-JSON step for two implementations to disagree on.

   WHO the token names: the relay ACCOUNT (auth.js) - sub is the
   account id (acct_<hex>), whatever proved it (passkey or wallet
   SIWE). The passkey IS the identity; a wallet is just one way an
   account authenticates, so no wallet is required, asserted, or
   even mentioned. SIWE find-or-create keys accounts by wallet, so
   a wallet user's account id is stable across browsers too.
   Audience is caller-chosen and NOT validated against the ledger
   on purpose: binding is the protection (a token for deployment X
   opens only X), and a token for a nonexistent deployment opens
   nothing.

   The key: SSO_SIGNER_KEY (or SSO_SIGNER_KEY_FILE), a DEDICATED
   secp256k1 key - never the provisioner or any key that signs
   transactions. This endpoint signs whatever it is asked to at
   the rate limit, so its blast radius must be "logins". Expiry is
   the only revocation there is (the verifier is stateless), which
   is why TTLs clamp at 7 days. The signer address is published at
   GET /v1/sso/signer and site/.well-known/sso-signer.json; apps
   pin it in their deployment config.
   ============================================================ */
import fs from "node:fs";
import { makeRateLimiter } from "./store.js";
import { accountsEnabled, verifyAccountSession } from "./auth.js";

const TTL_DEFAULT = 86400, TTL_MIN = 300, TTL_MAX = 604800;

let enabled = false;
let signer = null;            // viem local account (lazy import, auth.js pattern)

export async function initSso() {
  let keyHex = (process.env.SSO_SIGNER_KEY || "").trim();
  const keyFile = (process.env.SSO_SIGNER_KEY_FILE || "").trim();
  if (!keyHex && keyFile) {
    try { keyHex = fs.readFileSync(keyFile, "utf8").trim(); }
    catch (e) { console.error(`[sso] cannot read SSO_SIGNER_KEY_FILE (${e.message}) - sign-in mint disabled`); return { enabled: false }; }
  }
  if (!keyHex) { console.log("[sso] SSO_SIGNER_KEY unset - sign-in token mint disabled"); return { enabled: false }; }
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    signer = privateKeyToAccount(keyHex.startsWith("0x") ? keyHex : "0x" + keyHex);
  } catch (e) {
    console.error(`[sso] viem missing (${e.message}) - sign-in token mint disabled`);
    return { enabled: false };
  }
  enabled = true;
  console.log(`[sso] enabled - signer ${signer.address}`);
  return { enabled: true };
}

export const ssoEnabled = () => enabled;
export const ssoSignerAddress = () => (enabled ? signer.address : null);

/* Mint one token. Exported bare (not just via HTTP) so the test suite can
   pin the byte-exact spec vector against the app repo's. Hex addresses
   canonicalize to lowercase; account ids pass through as minted. */
export async function mintEst1({ sub, aud, iat, exp }) {
  if (!enabled) throw new Error("sso disabled");
  const s = String(sub);
  const claims = { aud: String(aud).toLowerCase(), exp, iat,
                   sub: /^0x/i.test(s) ? s.toLowerCase() : s, v: 1 };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const message = "EST1." + payload;
  const sigHex = await signer.signMessage({ message });   // EIP-191, r||s||v with v 27/28
  return message + "." + Buffer.from(sigHex.slice(2), "hex").toString("base64url");
}

const rlMint = makeRateLimiter({ capacity: 30, refillPerSec: 1 });
const err = (ctx, res, req, code, error, message) => ctx.json(res, code, { error, message }, req);
async function bodyJson(req, ctx, max = 8192) {
  const raw = await ctx.readBody(req, max);
  try { return JSON.parse(raw.toString() || "{}"); } catch { return null; }
}

export async function handleSso(req, res, u, ctx) {
  const p = u.pathname;

  // the pin, readable by anyone (also shipped as a site .well-known file);
  // short cache so a rotation propagates inside minutes
  if (p === "/v1/sso/signer" && req.method === "GET") {
    if (!enabled) return err(ctx, res, req, 503, "sso_disabled", "Sign-in token minting is not configured on this relay.");
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...ctx.cors(req) });
    return res.end(JSON.stringify({ signer: signer.address }));
  }

  if (p === "/v1/sso/token" && req.method === "POST") {
    if (!enabled) return err(ctx, res, req, 503, "sso_disabled", "Sign-in token minting is not configured on this relay.");
    if (!accountsEnabled()) return err(ctx, res, req, 503, "accounts_disabled", "Accounts are not configured on this relay.");
    if (!rlMint(ctx.clientIp(req))) return err(ctx, res, req, 429, "rate_limited", "Too many attempts; retry shortly.");
    const sess = await verifyAccountSession(req.headers.authorization);
    if (!sess) return err(ctx, res, req, 401, "unauthorized", "Sign in first.");
    const b = await bodyJson(req, ctx);
    if (!b) return err(ctx, res, req, 400, "bad_json", "Body must be JSON.");

    const aud = String(b.aud || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(aud))
      return err(ctx, res, req, 400, "bad_aud", "aud must be a bytes32 deployment id (0x + 64 hex).");

    let ttl = parseInt(b.ttl, 10);
    if (!Number.isFinite(ttl)) ttl = TTL_DEFAULT;
    ttl = Math.max(TTL_MIN, Math.min(TTL_MAX, ttl));
    const iat = Math.floor(Date.now() / 1000);
    // the session IS the identity: whoever this account proved itself to be
    // (passkey or wallet), that is who the app is told showed up
    const token = await mintEst1({ sub: sess.accountId, aud, iat, exp: iat + ttl });
    return ctx.json(res, 200, {
      token, signer: signer.address,
      sub: sess.accountId, aud: aud.toLowerCase(), iat, exp: iat + ttl,
    }, req);
  }

  return err(ctx, res, req, 404, "not_found", "No such sso endpoint.");
}
