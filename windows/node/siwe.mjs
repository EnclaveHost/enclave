// windows/node/siwe.mjs -- how somebody proves a wallet to THIS box.
//
// Sign-In With Ethereum, byte-compatible with the platform's own routes (supervisor.js
// /v1/auth/nonce and /v1/auth/login) because the console signs whatever message the server hands
// it and posts it back verbatim. A box whose message differed in any field would be signed against
// happily and then refuse its own login.
//
// WHAT A SIGNATURE HERE BUYS: a session token minted by this box, for this box. It is not a
// platform-wide credential - each enclave mints and verifies with its own key (session.mjs), so a
// token from one box is refused by another. That is deliberate on the platform and inherited here.
//
// THE NONCE IS THE WHOLE OF THE REPLAY DEFENCE, so it is single-use and short-lived: consumed on
// the first login attempt whether or not the signature verifies. A nonce left alive after a failed
// attempt is a nonce an attacker can grind against.
import { randomBytes } from "node:crypto";

const NONCE_TTL_MS = 10 * 60_000;
// Bounded: the sweep runs on a timer, but a burst between sweeps would grow the map without limit.
// Map keeps insertion order, so the oldest go first - and they would expire soonest anyway.
const NONCE_MAX = 4096;

export function nonceStore({ now = () => Date.now() } = {}) {
  const nonces = new Map();
  return {
    issue(address) {
      const nonce = randomBytes(16).toString("hex");
      nonces.set(nonce, { address: address.toLowerCase(), exp: now() + NONCE_TTL_MS });
      while (nonces.size > NONCE_MAX) {
        const k = nonces.keys().next().value;
        if (k === undefined) break;
        nonces.delete(k);
      }
      return nonce;
    },
    /** Consume it, whatever happens next: a nonce that survives a failed attempt can be ground. */
    take(nonce) {
      const rec = nonces.get(nonce);
      nonces.delete(nonce);
      if (!rec || rec.exp < now()) return null;
      return rec;
    },
    sweep() { const t = now(); for (const [k, v] of nonces) if (v.exp < t) nonces.delete(k); },
    get size() { return nonces.size; },
  };
}

/** The exact message the platform issues, so the console can sign it unchanged. */
export function siweMessage({ address, nonce, domain, uri, chainId, issuedAt = new Date() }) {
  const expirationTime = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const statement = "Sign in to Enclave. This signature is free and will not move funds.";
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\n` +
    `URI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\n` +
    `Issued At: ${issuedAt.toISOString()}\nExpiration Time: ${expirationTime.toISOString()}`;
  return { address, message, nonce, statement, domain, uri, version: "1", chainId,
           issuedAt: issuedAt.toISOString(), expirationTime: expirationTime.toISOString() };
}

/**
 * Check a signed SIWE message against this box's parameters, and return the address it proves.
 *
 * Returns `{ address }` or `{ error, message }` - never throws, and the refusals carry the
 * platform's own codes so a client written against the fleet reads them unchanged.
 *
 * Every assertion is on a field the message ACTUALLY CARRIES: an absent field is not asserted, so
 * a legitimate login is never locked out by a format this box did not emit. What is NOT optional
 * is the nonce, because that is the replay defence.
 */
export async function verifyLogin({ message, signature, nonces, domain, uri, chainId, verifyMessage, now = Date.now() }) {
  if (typeof message !== "string" || typeof signature !== "string")
    return { error: "invalid_request", message: "message and signature are required." };
  const nm = /\nNonce: (\S+)\n/.exec(message);
  const am = /^(0x[0-9a-fA-F]{40})$/m.exec(message);
  if (!nm || !am) return { error: "invalid_message", message: "Malformed SIWE message." };

  const d = /^(.+?) wants you to sign in with your Ethereum account:/.exec(message);
  const u = /^URI: (\S+)$/m.exec(message);
  const c = /^Chain ID: (\d+)$/m.exec(message);
  const e = /^Expiration Time: (\S+)$/m.exec(message);
  if (d && d[1] !== domain) return { error: "bad_domain", message: "SIWE message domain does not match this enclave." };
  if (u && u[1] !== uri) return { error: "bad_uri", message: "SIWE message URI does not match this enclave." };
  if (c && Number(c[1]) !== chainId) return { error: "bad_chain", message: "SIWE message chain does not match this enclave." };
  if (e) { const t = Date.parse(e[1]); if (Number.isFinite(t) && t <= now) return { error: "expired", message: "SIWE message has expired." }; }

  // Consumed HERE, before the signature is checked: a nonce that survives a failed verification is
  // one an attacker can keep trying against.
  const rec = nonces.take(nm[1]);
  if (!rec) return { error: "bad_nonce", message: "Unknown or expired nonce." };
  const claimed = am[1].toLowerCase();
  if (rec.address !== claimed) return { error: "address_mismatch", message: "Address does not match nonce." };

  let ok = false;
  try { ok = await verifyMessage({ address: am[1], message, signature }); } catch { ok = false; }
  if (!ok) return { error: "bad_signature", message: "Signature does not match the address." };
  return { address: claimed };
}
