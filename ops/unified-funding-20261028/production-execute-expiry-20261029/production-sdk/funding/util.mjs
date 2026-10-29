// UNREVIEWED SOURCE (unified-funding client-migration-r1). Shared helpers. No network, no key material, no signing.
// Import path: relative, like ../client-r1/funding-codec.mjs (esbuild resolves it when bundling /vendor/funding.js).
import { bytesToHex, keccak256 } from "viem";

/** Every refusal carries a stable code; callers branch on `code`, never on message text. */
export class MigrationError extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = "MigrationError";
    this.code = code;
    this.detail = detail;
  }
}
export const fail = (code, message, detail) => { throw new MigrationError(code, message, detail); };

/** Canonical JSON: sorted keys, bigint -> decimal string, undefined members dropped. Anything else is refused. */
export function canon(v) {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) fail("canon_number", "only safe integers are serialised");
    return String(v);
  }
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") {
    const p = Object.getPrototypeOf(v);
    if (p !== Object.prototype && p !== null) fail("canon_type", "only plain objects are serialised");
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  }
  return fail("canon_type", `cannot serialise ${typeof v}`);
}
export const jsonable = (v) => JSON.parse(canon(v));
export const hashOf = (v) => keccak256(new TextEncoder().encode(canon(v)));

export function randomHex32(c = globalThis.crypto) {
  if (!c || typeof c.getRandomValues !== "function") fail("webcrypto_missing", "crypto.getRandomValues is unavailable");
  const b = new Uint8Array(32);
  c.getRandomValues(b);
  const h = bytesToHex(b);
  if (h === `0x${"0".repeat(64)}`) fail("random_zero", "the random source returned zero");
  return h;
}

const SECRET_KEYS = new Set(["sig", "ownerSig", "signature", "r", "s", "privateKey", "pkcs8", "deposit", "depositSig"]);
/** Journals hold PUBLIC intent / tx state only: any member that could carry a signature or key is refused. */
export function assertPublic(v, path = "entry") {
  if (v !== null && typeof v === "object") {
    const p = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && p !== Object.prototype && p !== null) fail("journal_secret", `${path} is not plain data`);
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEYS.has(k)) fail("journal_secret", `${path}.${k} may not be journaled`);
      assertPublic(x, `${path}.${k}`);
    }
  }
  return v;
}

/** The SDK wire format (sdk/sessions grant.ts ser/de) may write bigints as "123n"; the codec accepts canonical decimals
 *  only. Strip the suffix from digit-only strings in relay RESPONSES. Requests are sent as plain decimals, which both
 *  relays accept (relay/sessions.mjs big(): /^\d{1,78}n?$/; funding-route uint(): decimal strings). */
export function normalizeWire(v) {
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,77})n$/.test(v)) return v.slice(0, -1);
  if (Array.isArray(v)) return v.map(normalizeWire);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeWire(x)]));
  return v;
}
export function wireFetch(f) {
  return async (url, init) => {
    const r = await f(url, init);
    const text = await r.text();
    let body = text;
    try { body = JSON.stringify(normalizeWire(JSON.parse(text))); } catch { /* non-JSON: passed through */ }
    return { ok: r.ok, status: r.status, text: async () => body };
  };
}

export const lower = (a) => String(a ?? "").toLowerCase();
export const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
export const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
