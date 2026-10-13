// Referral codes: a free-form attribution flag, recorded so the team can report later on who brought which machine.
// Nothing is gated on it and nothing is paid on it.
//
//   host    a host machine (nucbox-k11-4, metal0, ...): its node sends `x-metal-referral` when it attaches its tunnel, and
//           the code is recorded against the machine's tunnel name only once the attach has PROVEN that name (tunnel.js
//           bind). Windows: EnclaveSetup --referral / the installer's field; Linux: `enclave host init --referral`.
//           Or, for a host that cannot send the header yet (a Linux host on an older guest image): its operator key signs
//           referralMessage(name, code) and `enclave host referral` POSTs it to /v1/referrals/host; recorded only when
//           the signer is the name's REGISTERED owner on chain.
//   device  a phone running the Enclave mobile app: POST /v1/referrals {installId, code, platform} once, keyed by a random
//           id the app made at install. Unauthenticated (a phone has no identity here), so bounded and rate-limited.
//
// The FIRST code a machine reports is its code; a different later one is kept beside it (laterCodes) and never replaces
// it. GET /v1/admin/referrals (x-admin-token) is the report: every entry, and how many machines each code brought.
import { timingSafeEqual } from "node:crypto";
import { JsonStore, makeRateLimiter } from "./store.js";

export const REFERRAL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const INSTALL_RE = /^[0-9a-f]{32}$/;
const PLATFORMS = new Set(["android", "ios"]);
const MAX_ENTRIES = 50_000, MAX_LATER = 5;

/** What a host's operator key signs to say its machine's referral code (personal_sign). */
export const referralMessage = (name, code) => `enclave-referral:${name}:${code}`;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A referral code as given (trimmed), or null when it is absent or not a code. */
export function referralCode(v) {
  const s = String(v ?? "").trim();
  return REFERRAL_RE.test(s) ? s : null;
}

export function createReferrals({ file = null, store = null, adminToken = "", now = Date.now,
                                  // (name) -> the name's registered owner (lower-case address) or ""; (message, sig) -> signer
                                  ownerOf = async () => "", signerOf = async () => "",
                                  limit = makeRateLimiter({ capacity: 10, refillPerSec: 1 / 60 }) } = {}) {
  const db = store || (file ? new JsonStore(file, { version: 1, entries: {} }) : { data: { version: 1, entries: {} }, saveSoon() {} });
  db.data.entries ||= {};

  function record(key, code, fields) {
    const entries = db.data.entries, e = entries[key], at = new Date(now()).toISOString();
    if (!e) {
      if (Object.keys(entries).length >= MAX_ENTRIES) return "full";
      entries[key] = { code, ...fields, firstSeenAt: at, lastSeenAt: at };
      db.saveSoon();
      return "recorded";
    }
    const was = e.lastSeenAt;
    e.lastSeenAt = at;
    Object.assign(e, fields);
    let changed = false;
    if (e.code !== code && !(e.laterCodes || []).includes(code) && (e.laterCodes || []).length < MAX_LATER) {
      (e.laterCodes ||= []).push(code);
      changed = true;
    }
    // a host re-attaches on every restart: refresh its last-seen at most hourly, so the file is not rewritten each time
    if (changed || Date.parse(at) - Date.parse(was) > 3_600_000) db.saveSoon();
    return e.code === code ? "existing" : "kept-first";
  }

  /** A host machine proved its name and said its referral code (tunnel.js, on a successful bind). */
  function recordHost(name, code, { via = "", operator = "" } = {}) {
    const c = referralCode(code);
    if (!c || !name) return null;
    return record(`host:${name}`, c, { kind: "host", name, ...(via ? { via } : {}), ...(operator ? { operator } : {}) });
  }

  const adminOk = (given) => {
    if (!adminToken) return false;
    const a = Buffer.from(String(given ?? ""), "utf8"), b = Buffer.from(adminToken, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** The report: every machine with its code, and how many machines each code brought (hosts and phones apart). */
  function report() {
    const entries = Object.entries(db.data.entries).map(([key, e]) => ({ key, ...e }))
      .sort((a, b) => String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)));
    const byCode = {};
    for (const e of entries) {
      const c = (byCode[e.code] ||= { hosts: 0, devices: 0 });
      c[e.kind === "host" ? "hosts" : "devices"]++;
    }
    return { entries, byCode };
  }

  /** POST /v1/referrals (a phone), GET /v1/admin/referrals (the report). true when it answered. */
  async function route(req, res, url, { json, readJson, ip }) {
    const p = url.pathname;
    if (p === "/v1/referrals") {
      if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
      if (!limit(ip)) { json(res, 429, { error: "rate_limited" }); return true; }
      const body = await readJson(req).catch(() => null);
      const code = referralCode(body?.code), id = String(body?.installId || "").toLowerCase(), platform = String(body?.platform || "");
      if (!code) { json(res, 400, { error: "bad_code", message: "a referral code is 1-64 letters, digits, '.', '_' or '-'" }); return true; }
      if (!INSTALL_RE.test(id) || !PLATFORMS.has(platform)) { json(res, 400, { error: "bad_request", message: "installId (32 hex) and platform (android|ios) are required" }); return true; }
      const app = typeof body?.app === "string" ? body.app.slice(0, 64) : "";
      const outcome = record(`device:${id}`, code, { kind: "device", platform, ...(app ? { app } : {}) });
      json(res, outcome === "full" ? 503 : 200, outcome === "full" ? { error: "full" } : { ok: true, outcome });
      return true;
    }
    if (p === "/v1/referrals/host") {
      if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
      if (!limit(ip)) { json(res, 429, { error: "rate_limited" }); return true; }
      const body = await readJson(req).catch(() => null);
      const code = referralCode(body?.code), name = String(body?.name || "");
      if (!code || !NAME_RE.test(name) || !/^0x[0-9a-fA-F]{130}$/.test(String(body?.signature || ""))) {
        json(res, 400, { error: "bad_request", message: "name, code and the operator's signature of " + JSON.stringify(referralMessage("<name>", "<code>")) + " are required" });
        return true;
      }
      const [owner, signer] = await Promise.all([ownerOf(name).catch(() => ""), signerOf(referralMessage(name, code), body.signature).catch(() => "")]);
      if (!owner) { json(res, 409, { error: "not_registered", message: `${name} is not registered on chain yet: report the code once it is` }); return true; }
      if (!signer || signer.toLowerCase() !== owner.toLowerCase()) { json(res, 403, { error: "not_owner", message: `${name} is registered to ${owner}, not the signer` }); return true; }
      json(res, 200, { ok: true, outcome: recordHost(name, code, { via: "operator-signature", operator: owner.toLowerCase() }) });
      return true;
    }
    if (p === "/v1/admin/referrals") {
      if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      if (!adminOk(req.headers["x-admin-token"])) { json(res, adminToken ? 401 : 503, { error: adminToken ? "unauthorized" : "not_configured" }); return true; }
      json(res, 200, report());
      return true;
    }
    return false;
  }

  return { recordHost, report, route, store: db };
}
