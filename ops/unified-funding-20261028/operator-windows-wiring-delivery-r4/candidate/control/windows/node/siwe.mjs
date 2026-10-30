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
    /** `challenge` is the EXACT message this box issued for this nonce; login requires it back. */
    issue(address, challenge = null) {
      const nonce = randomBytes(16).toString("hex");
      nonces.set(nonce, { address: address.toLowerCase(), challenge, exp: now() + NONCE_TTL_MS });
      while (nonces.size > NONCE_MAX) {
        const k = nonces.keys().next().value;
        if (k === undefined) break;
        nonces.delete(k);
      }
      return nonce;
    },
    /** Attach the challenge after the message is built (the nonce has to exist to go in it). */
    bind(nonce, challenge) { const r = nonces.get(nonce); if (r) r.challenge = challenge; },
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
 * Check a signed SIWE message and return the address it proves.
 *
 * THE MESSAGE MUST BE THE ONE THIS BOX ISSUED, byte for byte (trailing whitespace aside). Not a
 * message that parses as compatible - the exact challenge, recovered by its nonce.
 *
 * This replaces field-by-field validation, which was wrong in a way that looked reasonable: each
 * field was asserted only IF PRESENT, so that a format this box never emitted could not lock a
 * legitimate client out. An audit showed what that actually permits - a message consisting of an
 * arbitrary sentence, an address line and `Nonce: <fresh nonce>` signs in, with no domain, no URI,
 * no chain and no statement of purpose. ERC-4361 requires those fields precisely so that what a
 * user signs says who is asking and what for; a verifier that treats them as optional accepts a
 * signature over something the user was never shown as a login.
 *
 * Comparing to the stored challenge makes every field required and exact without parsing any of
 * them, and costs nothing in compatibility: the console signs the server's message as-is and posts
 * it back. A client that rebuilds the message itself must rebuild it exactly, which it can,
 * because every field in it is the server's own.
 *
 * Returns `{ address }` or `{ error, message }` - never throws, and the refusals keep the
 * platform's codes so a client written against the fleet reads them unchanged.
 */
export async function verifyLogin({ message, signature, nonces, domain, uri, chainId, verifyMessage, now = Date.now() }) {
  if (typeof message !== "string" || typeof signature !== "string")
    return { error: "invalid_request", message: "message and signature are required." };
  const nm = /\nNonce: (\S+)\n/.exec(message);
  const am = /^(0x[0-9a-fA-F]{40})$/m.exec(message);
  if (!nm || !am) return { error: "invalid_message", message: "Malformed SIWE message." };

  // Consumed HERE, before anything else can fail: a nonce that survives a failed attempt is one an
  // attacker can keep trying against.
  const rec = nonces.take(nm[1]);
  if (!rec) return { error: "bad_nonce", message: "Unknown or expired nonce." };

  // THE CHALLENGE ITSELF. A store that kept no challenge cannot make this guarantee, and rather
  // than fall back to the permissive parse it refuses - there is no safe way to accept a message
  // whose fields nobody issued.
  if (typeof rec.challenge !== "string" || !rec.challenge)
    return { error: "invalid_message", message: "This nonce has no issued challenge to check against." };
  if (message.trim() !== rec.challenge.trim())
    return { error: "invalid_message", message: "The signed message is not the one this enclave issued." };

  const claimed = am[1].toLowerCase();
  if (rec.address !== claimed) return { error: "address_mismatch", message: "Address does not match nonce." };
  // The challenge carries its own expiry, and it is ours, so this is a check on our own clock
  // rather than on anything the caller said.
  const e = /^Expiration Time: (\S+)$/m.exec(rec.challenge);
  if (e) { const t = Date.parse(e[1]); if (Number.isFinite(t) && t <= now) return { error: "expired", message: "SIWE message has expired." }; }

  let ok = false;
  try { ok = await verifyMessage({ address: am[1], message, signature }); } catch { ok = false; }
  if (!ok) return { error: "bad_signature", message: "Signature does not match the address." };
  return { address: claimed };
}
