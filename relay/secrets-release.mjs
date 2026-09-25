// Attested release of a deployment's config and secrets to its per-app SNP GUEST (contract v1.1, docs/security/
// attested-release.md). Today a deployment's secrets leave the relay only for the lease holder's supervisor (/v1/secrets/
// fetch). On the per-app isolation tier the app runs in its own SNP guest, and the supervisor's manager lives on the HOST,
// so anything handed to it crosses the host in plaintext; this releases to the guest itself instead, sealed to a key only
// that guest holds, after the relay has verified the guest's attestation against the deployment, its app, the lease holder
// and the lease holder's chip.
//
//   POST /v1/secrets/release-ticket {id, endpoint, ts, opSig}   the lease holder's supervisor asks for a one-use ticket
//     opSig = personal_sign by the endpoint's registry operator of "enclave-secrets-release-ticket:<id>:<endpoint>:<ts>"
//   POST /v1/secrets/release {id, ticket, sealKey, evidence}     the guest, over its OWN TLS, presents the ticket once
//     evidence: the guest-domain document (sev-snp-guest-domain-v1, abi enclave-domain-abi/2)
//     report_data[0:32] = releaseBinding(...) below; report_data[32:64] = the AppID (the monitor's, never the client's)
//     → { id, sealed }  sealed = ephPub(32) ‖ iv(12) ‖ AES-256-GCM(plaintext) ‖ tag(16), key per sealKeyOf below
//
// The release binding has its OWN domain: the guest's public attestation endpoint signs Bind2 (isolation/contract/
// runtime.mjs) over any caller nonce, and the host sees the ticket, so Bind2 over the ticket would be an oracle. Every
// field after the domain line is a fixed 32 bytes (enclave-d1). The deployment id is inside it, and HOST_DATA must be the
// same deployment: AppID names an APP, so without it a lease holder hosting two tenants of one app could route A's ticket
// to B's guest (enclave-d1's confused deputy).
//
// OFF unless SECRETS_ATTESTED_RELEASE is set, and then only with its policy and every provider wired (fail closed).
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, diffieHellman, hkdfSync, randomBytes,
         createCipheriv, createDecipheriv } from "node:crypto";
import { endpointOperator, recoverOp, makeReplayCache, rowOf, holdsLease } from "./fleet-auth.js";

export const RELEASE_DOMAIN = Buffer.from("enclave-secrets-release-v1\n");
export const SEAL_INFO = Buffer.from("enclave-secrets-release-v1 seal\n");
export const BINDING_DOMAIN_LABEL = "enclave-secrets-release-v1";
const TICKET_TTL_SEC = 120, SKEW_SEC = 300, MAX_TICKETS = 5000;
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const b32 = (x, what) => {
  const b = Buffer.isBuffer(x) ? x : Buffer.from(x || []);
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
};
export function idBytes(id) {
  if (!/^0x[0-9a-f]{64}$/.test(String(id))) throw new Error("id must be a bytes32 deployment id (0x + 64 lowercase hex)");
  return Buffer.from(String(id).slice(2), "hex");
}

// report_data[0:32] of a release report: sha256(domain ‖ id(32 raw) ‖ sha256(transport SPKI DER) ‖ ticket ‖ runtimeId ‖ sealKey)
export function releaseBinding({ id, transportSpki, ticket, runtimeId, sealKey }) {
  if (!Buffer.isBuffer(transportSpki) || transportSpki.length < 32) throw new Error("transportSpki must be a DER SPKI");
  return sha256(RELEASE_DOMAIN, idBytes(id), sha256(transportSpki), b32(ticket, "ticket"), b32(runtimeId, "runtimeId"), b32(sealKey, "sealKey"));
}

// ---- the seal: X25519 + HKDF-SHA256 + AES-256-GCM, bound to the deployment, the ticket and both public keys ----
export const x25519PublicKey = (raw) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b32(raw, "X25519 public key").toString("base64url") }, format: "jwk" });
export const x25519PrivateKey = (raw) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, b32(raw, "X25519 private key")]), format: "der", type: "pkcs8" });
export const rawPublicOf = (key) => Buffer.from((key.type === "private" ? createPublicKey(key) : key).export({ format: "jwk" }).x, "base64url");
function sealKeyOf({ id, ticket, ephPub, sealKey, shared }) {
  // a low-order seal key yields an all-zero shared secret: refused, whatever OpenSSL would do with it
  if (!shared || shared.length !== 32 || shared.every((b) => b === 0)) throw new Error("all-zero X25519 shared secret (a low-order seal key)");
  return Buffer.from(hkdfSync("sha256", shared, b32(ticket, "ticket"), Buffer.concat([SEAL_INFO, idBytes(id), ephPub, sealKey]), 32));
}
function x25519(privateKey, publicRaw) {
  try { return diffieHellman({ privateKey, publicKey: x25519PublicKey(publicRaw) }); }
  catch { throw new Error("all-zero X25519 shared secret (a low-order seal key)"); }   // OpenSSL refuses an all-zero result
}
// _ephPrivate / _iv: test vectors only (a real seal is always a fresh ephemeral key and a random IV)
export function sealRelease({ id, ticket, sealKey, plaintext, _ephPrivate, _iv }) {
  const sk = b32(sealKey, "sealKey");
  const eph = _ephPrivate ? x25519PrivateKey(_ephPrivate) : generateKeyPairSync("x25519").privateKey;
  const ephPub = rawPublicOf(eph);
  const key = sealKeyOf({ id, ticket, ephPub, sealKey: sk, shared: x25519(eph, sk) });
  const iv = _iv ? Buffer.from(_iv) : randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return Buffer.concat([ephPub, iv, ct, c.getAuthTag()]);
}
// the guest's half (and the tests'): throws unless the blob opens under exactly this deployment, ticket and seal key
export function openRelease({ id, ticket, sealPrivateKey, sealed }) {
  const s = Buffer.from(sealed);
  if (s.length < 32 + 12 + 16) throw new Error("sealed blob too short");
  const ephPub = s.subarray(0, 32), iv = s.subarray(32, 44), tag = s.subarray(s.length - 16), ct = s.subarray(44, s.length - 16);
  const priv = Buffer.isBuffer(sealPrivateKey) ? x25519PrivateKey(sealPrivateKey) : sealPrivateKey;
  const key = sealKeyOf({ id, ticket, ephPub, sealKey: rawPublicOf(priv), shared: x25519(priv, ephPub) });
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---- the SNP report fields the relay reads itself, AFTER the verifier has checked the report's signature ----
export function reportFields(report) {
  const r = Buffer.from(report);
  if (r.length < 0x2a0) throw new Error("report too short");
  return { policy: r.readBigUInt64LE(0x08), vmpl: r.readUInt32LE(0x30), signingKey: (r.readUInt32LE(0x48) >> 2) & 0x7,
           reportData: r.subarray(0x50, 0x90), hostData: r.subarray(0xc0, 0xe0), chipId: r.subarray(0x1a0, 0x1e0) };
}
const nonZero = (b) => Buffer.from(b).some((x) => x !== 0);

// ---- config ----
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const listEnv = (name, n) => String(process.env[name] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  .filter((s) => { const ok = HEX(n).test(s); if (!ok) console.error(`[secrets-release] ${name}: ignoring a malformed entry`); return ok; });
// the TCB floor, per product ({"Genoa":{"bootloader":…,"tee":…,"snp":…,"microcode":…},…}); anything malformed is no floor
function minTcbEnv() {
  try {
    const o = JSON.parse(String(process.env.SECRETS_RELEASE_MIN_TCB || ""));
    return o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length ? o : null;
  } catch { return null; }
}
// the VMPL the release client's report must state: the monitor's (0..3)
function vmplEnv() { const s = String(process.env.SECRETS_RELEASE_VMPL ?? "").trim(); return /^[0-3]$/.test(s) ? Number(s) : null; }
export const releaseConfig = () => ({
  on: /^(1|true|on|yes)$/i.test(String(process.env.SECRETS_ATTESTED_RELEASE || "").trim()),
  measurements: listEnv("SECRETS_RELEASE_MEASUREMENTS", 96),   // reviewed, non-debug per-app guest images, fail-closed firmware only
  runtimeIds: listEnv("SECRETS_RELEASE_RUNTIME_IDS", 64),      // the admitted runtime SET
  minTcb: minTcbEnv(),                                         // passed to the verifier explicitly: never left to a provider
  vmpl: vmplEnv(),                                             // pinned, and re-read from the report below
});

// ---- tickets: one use, 120 s, bound to the lease holder and the chips it has attested with ----
const tickets = new Map();   // ticket (base64) -> { id, endpoint, epId, chips: [hex], exp }
const opFresh = makeReplayCache();
function sweepTickets() {
  const now = Date.now() / 1000;
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
}
export const _internals = { tickets };

// provider check: every piece the release needs, or a 503 that names what is missing
function missingFor(ctx, cfg) {
  return [!cfg.on && "SECRETS_ATTESTED_RELEASE", !cfg.measurements.length && "SECRETS_RELEASE_MEASUREMENTS",
          !cfg.runtimeIds.length && "SECRETS_RELEASE_RUNTIME_IDS", !cfg.minTcb && "SECRETS_RELEASE_MIN_TCB",
          cfg.vmpl === null && "SECRETS_RELEASE_VMPL", typeof ctx.leaseHolderChipIds !== "function" && "the lease holder's chip ids",
          typeof ctx.verifyGuestEvidence !== "function" && "the guest-evidence verifier", typeof ctx.runtimeIdOf !== "function" && "the runtime-id function",
          typeof ctx.appIdFor !== "function" && "the AppID derivation", typeof ctx.hostEligibility !== "function" && "the eligibility verdict"].filter(Boolean);
}

// handles /v1/secrets/release-ticket and /v1/secrets/release; returns false for any other path.
// `envOf(id)`: the deployment's decrypted secrets ({} when none). `bad(code, error, message)` answers a refusal.
export async function handleRelease(path, b, req, res, ctx, { envOf, bad, rate }) {
  if (path !== "/v1/secrets/release-ticket" && path !== "/v1/secrets/release") return false;
  const cfg = releaseConfig(), missing = missingFor(ctx, cfg);
  if (missing.length) { bad(503, "release_unconfigured", `Attested release is not configured on this relay (missing: ${missing.join(", ")}).`); return true; }
  if (!rate(ctx.clientIp(req))) { bad(429, "rate_limited", "Too many release requests; retry shortly."); return true; }
  const id = String(b.id || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) { bad(422, "bad_id", "id must be a bytes32 deployment id."); return true; }
  const epIdOf = async (endpoint) => String(await ctx.endpointIdOf(endpoint)).toLowerCase();
  // the lease holder: holds D's live lease NOW, and the relay holds it eligible NOW (U7)
  const leaseHolder = async (endpoint, epId) => {   // → { refusal: [code, error, message] } or { row }
    let row = await rowOf(ctx, id);
    if (!holdsLease(row, epId)) row = await rowOf(ctx, id, { fresh: true });
    if (!holdsLease(row, epId)) return { refusal: [403, "not_lease_holder", `${endpoint} does not hold a live lease for ${id}.`] };
    const elig = ctx.hostEligibility(epId);
    if (!elig || !elig.eligible) return { refusal: [403, "host_ineligible", `the lease holder is not an eligible host (U7)${elig && elig.reason ? `: ${elig.reason}` : ""}.`] };
    return { row };
  };

  if (path === "/v1/secrets/release-ticket") {
    const endpoint = String(b.endpoint || "").replace(/\/+$/, ""), ts = parseInt(b.ts, 10);
    if (!/^https?:\/\//.test(endpoint)) { bad(422, "bad_endpoint", "endpoint must be the enclave's registered origin."); return true; }
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SKEW_SEC) { bad(422, "bad_ts", `ts must be a unix time within ±${SKEW_SEC}s.`); return true; }
    const owner = await endpointOperator(ctx, endpoint);
    const signer = await recoverOp(`enclave-secrets-release-ticket:${id}:${endpoint}:${ts}`, b.opSig);
    if (!owner || !signer || signer !== owner) { bad(403, "operator_sig", "The ticket must be signed by the endpoint's registered operator key."); return true; }
    if (!opFresh(b.opSig, ts + SKEW_SEC)) { bad(409, "replay", "This signature was already used."); return true; }
    const epId = await epIdOf(endpoint);
    const holder = await leaseHolder(endpoint, epId);
    if (holder.refusal) { bad(...holder.refusal); return true; }
    // the chips the lease holder has ATTESTED with (its SNP tunnel attach): a release report must come from one of them
    const chips = ((await ctx.leaseHolderChipIds(endpoint)) || []).map((c) => String(c).toLowerCase()).filter((c) => HEX(128).test(c) && /[1-9a-f]/.test(c));
    if (!chips.length) { bad(403, "no_attested_chip", "The lease holder has no attested SEV-SNP chip (a VCEK-signed attach with a non-zero CHIP_ID) on this relay."); return true; }
    sweepTickets();
    if (tickets.size >= MAX_TICKETS) { bad(503, "busy", "Too many outstanding release tickets; retry shortly."); return true; }
    const ticket = randomBytes(32).toString("base64"), exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
    tickets.set(ticket, { id, endpoint, epId, chips, exp });
    ctx.json(res, 200, { ticket, expiresAt: exp }, req);
    return true;
  }

  // ---- release: the guest presents the ticket ONCE ----
  let ticket, sealKey;
  try { ticket = b32(Buffer.from(String(b.ticket || ""), "base64"), "ticket"); sealKey = b32(Buffer.from(String(b.sealKey || ""), "base64"), "sealKey"); }
  catch (e) { bad(422, "bad_request", e.message); return true; }
  const t = tickets.get(ticket.toString("base64"));
  tickets.delete(ticket.toString("base64"));   // consumed on first presentation, whatever the verdict (a burn is DoS only; logged)
  if (!t || t.exp < Date.now() / 1000 || t.id !== id) {
    if (t) console.warn(`[secrets-release] ticket for ${t.id} presented ${t.id !== id ? `for ${id}` : "after expiry"}: burned`);
    bad(403, "bad_ticket", "Unknown, expired or already-used ticket, or one issued for another deployment."); return true;
  }
  const holder = await leaseHolder(t.endpoint, t.epId);
  if (holder.refusal) { bad(...holder.refusal); return true; }
  const row = holder.row;
  const doc = b.evidence;
  if (!doc || typeof doc !== "object" || doc.format !== "sev-snp-guest-domain-v1" || doc.abi !== "enclave-domain-abi/2"
      || typeof doc.report !== "string" || typeof doc.transportKey !== "string" || !doc.runtime || typeof doc.runtime !== "object") {
    bad(422, "bad_evidence", "evidence must be a sev-snp-guest-domain-v1 document stating abi enclave-domain-abi/2, its transport key and its runtime."); return true;
  }
  // a release document states no verifier `nonce`: the ticket is committed in the binding, and a release report must never
  // pass for an ordinary nonce-bound attestation wherever it is logged or re-verified
  if (doc.nonce !== undefined) { bad(422, "bad_evidence", "a release document must not state a nonce (the ticket is bound in report_data)."); return true; }
  let runtimeId, appId, binding, report;
  try {
    runtimeId = b32(await ctx.runtimeIdOf(doc.runtime), "runtime id");
    if (!cfg.runtimeIds.includes(runtimeId.toString("hex"))) { bad(403, "runtime_not_admitted", "The guest's runtime is not in the admitted set."); return true; }
    appId = await ctx.appIdFor(id);
    if (!appId) { bad(503, "appid_underivable", "The relay cannot derive this deployment's app id right now."); return true; }
    appId = b32(appId, "app id");
    binding = releaseBinding({ id, transportSpki: Buffer.from(doc.transportKey, "base64"), ticket, runtimeId, sealKey });
    report = Buffer.from(doc.report, "base64");
  } catch (e) { bad(422, "bad_evidence", e.message); return true; }
  const v = await ctx.verifyGuestEvidence(doc, { allowedMeasurements: cfg.measurements, minTcb: cfg.minTcb, expectedVmpl: cfg.vmpl,
                                                 expectedBinding: binding, expectedAppId: appId, expectedHostData: idBytes(id),
                                                 bindingDomain: BINDING_DOMAIN_LABEL });
  if (!v || v.status !== "verified") {
    console.warn(`[secrets-release] ${id}: evidence REFUSED: ${(v && v.reasons && v.reasons.at(-1)) || "no verdict"}`);
    bad(403, "evidence_refused", (v && v.reasons && v.reasons.at(-1)) || "The guest's evidence did not verify."); return true;
  }
  // belt and braces over the verified report: the fields this release depends on, read here
  let f; try { f = reportFields(report); } catch (e) { bad(422, "bad_evidence", e.message); return true; }
  const why = f.signingKey !== 0 ? "the report is not VCEK-signed"
    : (f.policy >> 19n) & 1n ? "the guest policy allows DEBUG"
    : f.vmpl !== cfg.vmpl ? `the report states VMPL ${f.vmpl}, not the pinned ${cfg.vmpl}`
    : !f.reportData.subarray(0, 32).equals(binding) ? "report_data[0:32] is not this release's binding"
    : !f.reportData.subarray(32, 64).equals(appId) ? "report_data[32:64] is not this deployment's app"
    : !f.hostData.equals(idBytes(id)) ? "HOST_DATA is not this deployment"
    : !nonZero(f.chipId) ? "the report's CHIP_ID is zero (masked)"
    : !t.chips.includes(f.chipId.toString("hex")) ? "the report is not from a chip the lease holder attested with"
    : null;
  if (why) { console.warn(`[secrets-release] ${id}: REFUSED: ${why}`); bad(403, "evidence_refused", why); return true; }
  // what the guest gets: the ledger envelope's config (inline, or its configCid resolved here) and the deployment's secrets
  const envelope = String((row && row.configCid) || "").trim();
  let config = null;
  try {
    const o = envelope ? JSON.parse(envelope) : {};
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
    if (o.config !== undefined) config = o.config;
    else if (o.configCid !== undefined) {
      if (typeof ctx.resolveConfigCid !== "function") { bad(503, "config_unresolvable", "This relay cannot resolve a configCid."); return true; }
      config = await ctx.resolveConfigCid(String(o.configCid));
      if (config == null) { bad(503, "config_unresolvable", "The deployment's configCid did not resolve."); return true; }
    }
  } catch { bad(422, "bad_envelope", "The deployment's options envelope is not a JSON object."); return true; }
  const plaintext = JSON.stringify({ id, envelopeSha256: sha256(Buffer.from(envelope)).toString("hex"), config, secrets: envOf(id) || {},
                                     issuedAt: new Date().toISOString() });
  let sealed;
  try { sealed = sealRelease({ id, ticket, sealKey, plaintext }); }
  catch (e) { bad(422, "bad_seal_key", e.message); return true; }
  console.log(`[secrets-release] ${id}: released to a verified guest on ${t.endpoint} (runtime ${runtimeId.toString("hex").slice(0, 12)}…)`);
  ctx.json(res, 200, { id, sealed: sealed.toString("base64") }, req);
  return true;
}
