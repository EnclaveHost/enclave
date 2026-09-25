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
// WHICH guest: the measurement, AppID and runtime a release admits are PREDICTED by the relay for the deployment's catalog
// version (relay/measurement-predict.mjs, via ctx.expectedGuestFor): from the chain, the component verified by its CID, the
// catalog's derivation rule and a pinned domain release. Nothing the host or the guest states is its own allowlist.
//
// OFF unless SECRETS_ATTESTED_RELEASE is set, and then only with its policy and every provider wired (fail closed).
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, diffieHellman, hkdfSync, randomBytes,
         createCipheriv, createDecipheriv, sign as edSign, verify as edVerify } from "node:crypto";
import fs from "node:fs";
import { endpointOperator, recoverOp, makeReplayCache, rowOf, holdsLease } from "./fleet-auth.js";

export const RELEASE_DOMAIN = Buffer.from("enclave-secrets-release-v1\n");
export const SEAL_INFO = Buffer.from("enclave-secrets-release-v1 seal\n");
export const BINDING_DOMAIN_LABEL = "enclave-secrets-release-v1";
export const RESPONSE_DOMAIN = Buffer.from("enclave-secrets-release-v1 response\n");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
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

// ---- v1.2: the relay SIGNS every release (enclave-5d). The seal gives confidentiality but no origin: its key is public (the
// request carries it) and the host carries the ticket, so anyone who could terminate TLS as the relay (a mis-issued
// certificate) could seal a forged {config, secrets}. With the relay's key pinned in the measured front, that is a DoS at
// worst. The guest verifies BEFORE it opens the seal.
//   sig = Ed25519(release key, sha256("enclave-secrets-release-v1 response\n" ‖ id(32) ‖ ticket ‖ sealKey ‖ sha256(sealed)))
//   keyId = sha256(the raw 32-byte public key) hex, first 16 characters: a selector among the guest's pinned keys
export const signingKeyFromSeed = (seed) => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, b32(seed, "Ed25519 seed")]), format: "der", type: "pkcs8" });
export const ed25519RawPublic = (key) => Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url");
export const keyIdOf = (rawPublic) => sha256(Buffer.from(rawPublic)).toString("hex").slice(0, 16);
export function responseDigest({ id, ticket, sealKey, sealed }) {
  return sha256(RESPONSE_DOMAIN, idBytes(id), b32(ticket, "ticket"), b32(sealKey, "sealKey"), sha256(Buffer.from(sealed)));
}
export const signResponse = (signingKey, fields) => edSign(null, responseDigest(fields), signingKey);
// the guest's half (and the tests'): true only for a signature by THIS raw public key over exactly these fields
export function verifyResponse({ publicKey, sig, ...fields }) {
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b32(publicKey, "Ed25519 public key").toString("base64url") }, format: "jwk" });
    return edVerify(null, responseDigest(fields), pub, Buffer.from(sig));
  } catch { return false; }
}
// The release signing seed: SECRETS_RELEASE_SIGNING_KEY_FILE (preferred: the seed stays in its own file, out of the env file
// and out of every copy of it), or SECRETS_RELEASE_SIGNING_KEY. The file must be a regular file readable by its owner only
// (no group or other bits), owned by this process's user or root, holding one line of 64 hex. Setting both is refused.
function signingSeedHex() {
  const file = String(process.env.SECRETS_RELEASE_SIGNING_KEY_FILE || "").trim(), inline = String(process.env.SECRETS_RELEASE_SIGNING_KEY || "").trim();
  if (file && inline) { console.error("[secrets-release] both SECRETS_RELEASE_SIGNING_KEY_FILE and SECRETS_RELEASE_SIGNING_KEY are set: refused"); return null; }
  if (!file) return inline.toLowerCase();
  try {
    const st = fs.statSync(file);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (st.uid !== uid && st.uid !== 0)) {
      console.error(`[secrets-release] ${file}: must be a regular file, mode 0600 or stricter, owned by this user or root: refused`);
      return null;
    }
    return fs.readFileSync(file, "utf8").trim().toLowerCase();
  } catch (e) { console.error(`[secrets-release] ${file}: unreadable (${e.code || e.message})`); return null; }
}
function signingKeyEnv() {
  const s = signingSeedHex();
  if (!/^[0-9a-f]{64}$/.test(s || "")) return null;
  // a SEPARATE key (enclave-d1): a release seed equal to any other key this relay holds is no separate key at all
  for (const other of ["RELAY_TXT_KEY", "DNS_TXT_KEY", "SECRETS_KEY", "CERTS_KEY"])
    if (String(process.env[other] || "").trim().toLowerCase() === s) {
      console.error(`[secrets-release] SECRETS_RELEASE_SIGNING_KEY equals ${other}: refused (it must be its own key)`);
      return null;
    }
  try { return signingKeyFromSeed(Buffer.from(s, "hex")); } catch { return null; }
}

// ---- config: a JSON VALUE (object or array), never a string (enclave-5d) ----
// The guest's ENCLAVE_CONFIG is the value's compact serialization, so a config fetched as TEXT is parsed here, and a value
// that is itself a JSON string (which the app would receive as one quoted string) is refused, never passed on.
export function configValue(x) {
  const v = typeof x === "string" ? JSON.parse(x) : x;
  if (v === null || typeof v !== "object") throw new Error("the config is not a JSON object or array");
  return v;
}

// ---- the SNP report fields the relay reads itself, AFTER the verifier has checked the report's signature ----
export function reportFields(report) {
  const r = Buffer.from(report);
  if (r.length < 0x2a0) throw new Error("report too short");
  return { policy: r.readBigUInt64LE(0x08), vmpl: r.readUInt32LE(0x30), signingKey: (r.readUInt32LE(0x48) >> 2) & 0x7,
           reportData: r.subarray(0x50, 0x90), measurement: r.subarray(0x90, 0xc0), hostData: r.subarray(0xc0, 0xe0),
           chipId: r.subarray(0x1a0, 0x1e0) };
}
const nonZero = (b) => Buffer.from(b).some((x) => x !== 0);

// ---- config ----
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
// the TCB floor, per product ({"Genoa":{"bootloader":…,"tee":…,"snp":…,"microcode":…},…}); anything malformed is no floor
function minTcbEnv() {
  try {
    const o = JSON.parse(String(process.env.SECRETS_RELEASE_MIN_TCB || ""));
    return o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length ? o : null;
  } catch { return null; }
}
// the VMPL the release client's report must state: the monitor's (0..3)
function vmplEnv() { const s = String(process.env.SECRETS_RELEASE_VMPL ?? "").trim(); return /^[0-3]$/.test(s) ? Number(s) : null; }
// the deployments a release may serve: "*" (every deployment the other checks admit) or a list of bytes32 ids (a staged
// rollout's defence in depth, enclave-63); unset is none
function deploymentsEnv() {
  const s = String(process.env.SECRETS_RELEASE_DEPLOYMENTS || "").trim().toLowerCase();
  if (s === "*") return "*";
  const ids = s.split(",").map((x) => x.trim()).filter((x) => /^0x[0-9a-f]{64}$/.test(x));
  return ids.length ? new Set(ids) : null;
}
export const releaseConfig = () => ({
  on: /^(1|true|on|yes)$/i.test(String(process.env.SECRETS_ATTESTED_RELEASE || "").trim()),
  deployments: deploymentsEnv(),
  minTcb: minTcbEnv(),                                         // passed to the verifier explicitly: never left to a provider
  vmpl: vmplEnv(),                                             // pinned, and re-read from the report below
  signingKey: signingKeyEnv(),                                 // v1.2: every release is signed with it
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
  return [!cfg.on && "SECRETS_ATTESTED_RELEASE", !cfg.deployments && "SECRETS_RELEASE_DEPLOYMENTS", !cfg.minTcb && "SECRETS_RELEASE_MIN_TCB",
          cfg.vmpl === null && "SECRETS_RELEASE_VMPL", !cfg.signingKey && "SECRETS_RELEASE_SIGNING_KEY(_FILE)",
          typeof ctx.versionConfigFor !== "function" && "the version-config lookup", typeof ctx.leaseHolderChipIds !== "function" && "the lease holder's chip ids",
          typeof ctx.verifyGuestEvidence !== "function" && "the guest-evidence verifier", typeof ctx.runtimeIdOf !== "function" && "the runtime-id function",
          typeof ctx.expectedGuestFor !== "function" && "the measurement predictor", typeof ctx.hostEligibility !== "function" && "the eligibility verdict",
          typeof ctx.confirmRow !== "function" && "the confirmed ledger read", typeof ctx.prewarmCollateral !== "function" && "the AMD collateral prewarm",
          ...(typeof ctx.predictorProblems === "function" ? ctx.predictorProblems() : [])].filter(Boolean);
}
// a prediction refusal as an answer: the relay's own inability (503) or the version's (403)
// the supervisor's DEP_CONFIG_CID_RE and DEP_MANIFEST_KEYS (supervisor.js): what a config CID looks like, and the only keys
// an inline config may carry beside one (the routing manifest)
export const CONFIG_CID_RE = /^[A-Za-z0-9]{10,100}$/, MANIFEST_KEYS = ["volumes"];
const PREDICTION_503 = new Set(["warming", "busy", "prediction_unavailable", "catalog_unreachable", "component_unavailable", "prediction_failed", "predictor_unconfigured"]);
// how long a release waits for a prediction still being computed before answering 503 warming (its ticket kept)
const PREDICT_WAIT_MS = 10_000;
const predictionOf = async (ctx, row) => {
  try { return await ctx.expectedGuestFor(row, { forPrivate: !!row && row.isPublic === false, waitMs: PREDICT_WAIT_MS }); }
  catch (e) { return { ok: false, code: "prediction_failed", reason: e.message }; }
};
const predictionRefusal = (p) => {
  const code = p && p.ok === false && typeof p.code === "string" && p.code ? p.code : "prediction_unavailable";
  return [code === "prediction_unavailable" || PREDICTION_503.has(code) ? 503 : 403, code,
          `No expected guest for this deployment: ${(p && p.ok === false && p.reason) || "the predictor gave no usable answer"}.`];
};

// GET /v1/secrets/release-status?id=0x<64 hex> -> { id, listed }: whether attested release is enabled for this deployment.
// The owner's decision lives ONLY in SECRETS_RELEASE_DEPLOYMENTS; a supervisor asks here at spawn to choose the guest image
// (enclave-5d, d1's option (i)). Public: deployment ids are public on chain and the answer names nothing else. 503 while
// release is off or not fully configured, which a supervisor reads as not listed; the missing pieces are not named here.
export function releaseStatus(u, req, res, ctx, { bad, rate }) {
  if (!rate(`status:${ctx.clientIp(req)}`)) return bad(429, "rate_limited", "Too many status requests; retry shortly.");
  const cfg = releaseConfig();
  if (missingFor(ctx, cfg).length) return bad(503, "release_off", "Attested release is not enabled on this relay.");
  const id = String(u.searchParams.get("id") || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return bad(422, "bad_id", "id must be a bytes32 deployment id.");
  ctx.json(res, 200, { id, listed: cfg.deployments === "*" || cfg.deployments.has(id) }, req);
}

// GET /v1/expected-guest?id=0x<64 hex> -> { id, catalogRef, appId, images: [{ release, runtimeId, measurement,
// releaseAdmitted }] }: the guest this deployment must be running, PREDICTED by the relay from the chain and the pinned
// domain releases (enclave-d1, GUEST-POOL-ROLLOUT row 6: the per-app certificate gate's independent trust root). Over
// every INSTALLED release (`releaseAdmitted` says which the release itself admits). Public and read-only: AppIDs and
// measurements are derivable from the chain. Only for a PUBLIC deployment holding a live lease (the certificate gate
// asks for nothing else), so a public request can trigger a prediction only for an approved version of a public, leased
// deployment: a set the catalog owner governs, bounded further by the predictor's queue and cache and a per-IP rate.
// Independent of SECRETS_ATTESTED_RELEASE and SECRETS_RELEASE_DEPLOYMENTS. A guest matches only as a (measurement,
// runtimeId) PAIR of one image, with appId equal. Never waits long for a cold prediction: 503 warming, Retry-After.
const EXPECTED_WAIT_MS = 3_000;
export async function expectedGuest(u, req, res, ctx, { bad, rate }) {
  if (!rate(`expected:${ctx.clientIp(req)}`)) return bad(429, "rate_limited", "Too many expected-guest requests; retry shortly.");
  const missing = [typeof ctx.expectedGuestFor !== "function" && "the measurement predictor", typeof ctx.confirmRow !== "function" && "the confirmed ledger read",
                   ...(typeof ctx.predictorProblems === "function" ? ctx.predictorProblems() : [])].filter(Boolean);
  if (missing.length) return bad(503, "prediction_unconfigured", "Guest prediction is not configured on this relay.");
  const id = String(u.searchParams.get("id") || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return bad(422, "bad_id", "id must be a bytes32 deployment id.");
  let row;
  try { row = await ctx.confirmRow(id); }
  catch (e) {
    if (e && e.code === "no_deployment") return bad(404, "no_deployment", `The ledger holds no deployment ${id}.`);
    return bad(503, "ledger_unconfirmed", "The deployment's record could not be confirmed; retry shortly.");
  }
  if (row.isPublic === false) return bad(403, "not_public", "Only a public deployment's expected guest is published here.");
  if (/^0x0*$/.test(String(row.runner || "")) || !(Number(row.leaseUntil) * 1000 > Date.now()))
    return bad(409, "not_leased", "The deployment holds no live lease, so no guest of it is expected now.");
  let p;
  try { p = await ctx.expectedGuestFor(row, { forPrivate: false, waitMs: EXPECTED_WAIT_MS, set: "cert" }); }
  catch (e) { p = { ok: false, code: "prediction_failed", reason: e.message }; }
  if (!p || p.ok !== true || !Array.isArray(p.images) || !p.images.length) {
    const code = (p && p.ok === false && p.code) || "prediction_unavailable";
    if (code === "not_catalog") return bad(404, "not_catalog", "The deployment does not run a catalog version.");
    const [status, error, message] = predictionRefusal(p);
    if (status === 503) {
      const after = code === "warming" ? 5 : 30;
      if (typeof res.setHeader === "function") res.setHeader("Retry-After", String(after));
      return ctx.json(res, 503, { error, message, retryAfterSec: after }, req);
    }
    return bad(status, error, message);
  }
  const releaseSet = new Set((typeof ctx.predictorSets === "function" && ctx.predictorSets().release) || []);
  ctx.json(res, 200, { id, catalogRef: String(row.appRef || "").toLowerCase(), appId: p.appId,
    images: p.images.map((i) => ({ release: i.release, runtimeId: i.runtimeId, measurement: i.measurement, releaseAdmitted: releaseSet.has(i.release) })) }, req);
}

// handles /v1/secrets/release-ticket and /v1/secrets/release; returns false for any other path.
// `envOf(id)`: the deployment's decrypted secrets ({} when none). `bad(code, error, message)` answers a refusal.
export async function handleRelease(path, b, req, res, ctx, { envOf, bad, rate }) {
  if (path !== "/v1/secrets/release-ticket" && path !== "/v1/secrets/release") return false;
  const cfg = releaseConfig(), missing = missingFor(ctx, cfg);
  if (missing.length) { bad(503, "release_unconfigured", `Attested release is not configured on this relay (missing: ${missing.join(", ")}).`); return true; }
  // rate: a ticket request by client IP (the supervisor's own); a release by its ticket's ENDPOINT, peeked without being
  // consumed, so many guests behind one host address do not share one bucket (enclave-5d); an unknown ticket by IP
  const peek = path === "/v1/secrets/release" ? tickets.get(String(b.ticket || "")) : null;
  if (!rate(peek ? `ep:${peek.endpoint}` : `ip:${ctx.clientIp(req)}`)) { bad(429, "rate_limited", "Too many release requests; retry shortly."); return true; }
  const id = String(b.id || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) { bad(422, "bad_id", "id must be a bytes32 deployment id."); return true; }
  if (cfg.deployments !== "*" && !cfg.deployments.has(id)) { bad(403, "release_not_enabled", `Attested release is not enabled for ${id} on this relay.`); return true; }
  const epIdOf = async (endpoint) => String(await ctx.endpointIdOf(endpoint)).toLowerCase();
  // the lease holder: holds D's live lease NOW, and the relay holds it eligible NOW (U7). The record the decision rests on
  // is re-read by id through two or more AGREEING RPCs (ctx.confirmRow, enclave-d1); a disagreement or an unreachable
  // provider is the relay's own inability (503, `retry`), never a pass.
  const leaseHolder = async (endpoint, epId) => {   // → { refusal: [code, error, message], retry? } or { row }
    let row = await rowOf(ctx, id);
    if (!holdsLease(row, epId)) row = await rowOf(ctx, id, { fresh: true });
    if (!holdsLease(row, epId)) return { refusal: [403, "not_lease_holder", `${endpoint} does not hold a live lease for ${id}.`] };
    let confirmed;
    try { confirmed = await ctx.confirmRow(id); }
    catch (e) { return { retry: true, refusal: [503, "ledger_unconfirmed", `The deployment's record could not be confirmed (${e.message}); retry shortly.`] }; }
    if (!holdsLease(confirmed, epId)) return { refusal: [403, "not_lease_holder", `${endpoint} does not hold a live lease for ${id} (confirmed read).`] };
    const elig = ctx.hostEligibility(epId);
    if (!elig || !elig.eligible) return { refusal: [403, "host_ineligible", `the lease holder is not an eligible host (U7)${elig && elig.reason ? `: ${elig.reason}` : ""}.`] };
    return { row: confirmed };
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
    // warm the prediction while the guest boots (a cold one derives and measures); its answer is judged at release
    Promise.resolve().then(() => ctx.expectedGuestFor(holder.row, { forPrivate: holder.row.isPublic === false })).catch(() => {});
    ctx.json(res, 200, { ticket, expiresAt: exp }, req);
    return true;
  }

  // ---- release: the guest presents the ticket ONCE ----
  let ticket, sealKey;
  try { ticket = b32(Buffer.from(String(b.ticket || ""), "base64"), "ticket"); sealKey = b32(Buffer.from(String(b.sealKey || ""), "base64"), "sealKey"); }
  catch (e) { bad(422, "bad_request", e.message); return true; }
  // A ticket is consumed on its first presentation whatever the verdict (a burn is DoS only; logged), with ONE exception:
  // when the relay itself cannot predict the expected guest yet (503: warming, busy, ...), the ticket is KEPT and the guest
  // retries within its TTL (enclave-d1). The prediction depends only on the deployment's row, never on the ticket or the
  // evidence, so answering it first is no oracle.
  const tk = ticket.toString("base64"), t = tickets.get(tk);
  if (!t || t.exp < Date.now() / 1000 || t.id !== id) {
    tickets.delete(tk);
    if (t) console.warn(`[secrets-release] ticket for ${t.id} presented ${t.id !== id ? `for ${id}` : "after expiry"}: burned`);
    bad(403, "bad_ticket", "Unknown, expired or already-used ticket, or one issued for another deployment."); return true;
  }
  const holder = await leaseHolder(t.endpoint, t.epId);
  if (holder.refusal) { if (!holder.retry) tickets.delete(tk); bad(...holder.refusal); return true; }
  const row = holder.row;
  // the guest this deployment must be running, predicted for its catalog version (never taken from the host or the guest)
  const expected = await predictionOf(ctx, row);
  if (!expected || expected.ok !== true || !/^[0-9a-f]{64}$/.test(String(expected.appId)) || !Array.isArray(expected.images) || !expected.images.length) {
    const [code, error, message] = predictionRefusal(expected);
    if (code !== 503 || tickets.get(tk) !== t) tickets.delete(tk);   // a 503 keeps the ticket for a retry within its TTL
    console.warn(`[secrets-release] ${id}: no prediction (${code === 503 ? "ticket kept" : "ticket burned"}): ${message}`);
    bad(code, error, message); return true;
  }
  // what the guest gets: the ledger envelope's config (inline, or its configCid resolved here) and the deployment's secrets.
  // Resolved BEFORE the ticket is consumed: it depends only on the deployment's record, and an unresolvable CID is the
  // relay's own 503, which keeps the ticket for the guest's retry. Nothing is released until the evidence verifies below.
  const envelope = String((row && row.configCid) || "").trim();
  // the config, as the tier delivers it today: the supervisor's split (overrideConfigFields: the options envelope decides
  // when it names config OR configCid, else the catalog VERSION does) and, within that source, the manager's rule
  // (wasm_manager.py: "if both arrive the CID wins and the inline field is ignored": beside a CID the inline field is only
  // the routing manifest, never the app's document); null only when neither source names one
  let o;
  try { o = envelope ? JSON.parse(envelope) : {}; if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("x"); }
  catch { tickets.delete(tk); bad(422, "bad_envelope", "The deployment's options envelope is not a JSON object."); return true; }
  // the envelope's config namespaces exactly as the supervisor's parseDepOptions admits them (enclave-d1): a present
  // configCid is a bare CID; a present config is a plain object without _media and, beside a CID, only the routing manifest
  // (volumes). Key PRESENCE decides, not truthiness: {"configCid":"", "config":{…}} is refused, never read as "no CID".
  const envRefusal = (() => {
    if ("configCid" in o && (typeof o.configCid !== "string" || !CONFIG_CID_RE.test(o.configCid)))
      return "the envelope's configCid is not a bare CID (10-100 alphanumeric characters)";
    if ("config" in o) {
      const c = o.config;
      if (!c || Array.isArray(c) || typeof c !== "object") return "the envelope's config is not a JSON object";
      if ("_media" in c) return "the envelope's config carries the reserved _media key";
      if ("configCid" in o) { const extra = Object.keys(c).filter((k) => !MANIFEST_KEYS.includes(k)); if (extra.length) return `beside a configCid the envelope's config may only carry ${MANIFEST_KEYS.join("/")}`; }
    }
    return null;
  })();
  if (envRefusal) { tickets.delete(tk); bad(422, "bad_envelope", `${envRefusal}.`); return true; }
  let config = null, source = null;
  const resolveCid = async (cid, whose) => {
    if (typeof ctx.resolveConfigCid !== "function") throw Object.assign(new Error("This relay cannot resolve a configCid."), { code: 503, error: "config_unresolvable" });
    const got = await ctx.resolveConfigCid(String(cid));
    if (got == null) throw Object.assign(new Error(`${whose} configCid did not resolve.`), { code: 503, error: "config_unresolvable" });
    return got;
  };
  try {
    if ("config" in o || "configCid" in o) {
      if ("configCid" in o) { config = await resolveCid(o.configCid, "The deployment's"); source = "the envelope's configCid"; }
      else { config = o.config; source = "the envelope's config"; }
    } else {
      // the version's config through the agreeing RPCs: a read that fails (a timeout, the RPCs disagreeing, a record that
      // cannot be confirmed just now) is the relay's OWN inability, a 503 that keeps the ticket for the guest's retry,
      // never a verdict on the config (enclave-e3 L3 / enclave-d1: it burned the ticket as 422 bad_config)
      let ver;
      try { ver = await ctx.versionConfigFor(id); }
      catch (e) {   // the cause's first line only (a library's message can run to many lines of request detail)
        const why = String((e && e.message) || e).split("\n")[0].slice(0, 200);
        throw Object.assign(new Error(`The version's config could not be read just now (${why}).`), { code: 503, error: "config_unresolvable" });
      }
      if (ver && ver.configCid) {
        if (typeof ver.configCid !== "string" || !CONFIG_CID_RE.test(ver.configCid))
          throw Object.assign(new Error("The version's configCid is not a bare CID."), { code: 422, error: "bad_config" });
        config = await resolveCid(ver.configCid, "The version's"); source = "the version's configCid";
      }
      else if (ver && ver.config !== undefined && ver.config !== null && ver.config !== "") { config = ver.config; source = "the version's config"; }
    }
    if (source) config = configValue(config);
  } catch (e) {
    // only an HTTP status of our own is answered as one (an error carrying another code, e.g. a library's string, is not)
    if (Number.isInteger(e.code)) { if (e.code !== 503) tickets.delete(tk); bad(e.code, e.error, e.message); return true; }   // a 503 keeps the ticket
    tickets.delete(tk); bad(422, "bad_config", `${source || "The config"} is not a JSON object or array (${e.message}).`); return true;
  }
  // the AMD collateral the evidence will need, fetched BEFORE the ticket is consumed (enclave-d1): a KDS or CRL outage is the
  // relay's own 503 and keeps the ticket, instead of a verifier "rejected" that would burn it. It judges nothing.
  // Only for a report that names a chip the ticket was issued for (enclave-d1): a 503 keeps the ticket, so otherwise one ticket
  // could drive a KDS fetch per retry for any CHIP_ID written into an unverified report. Anything else skips the prewarm
  // and is refused below, after consumption, by the verifier and the relay's own CHIP_ID check.
  let warm = { ok: true, skipped: "the report names no chip the ticket was issued for" };
  let chip0 = null;
  try { chip0 = reportFields(Buffer.from(String((b.evidence && b.evidence.report) || ""), "base64")).chipId.toString("hex"); } catch {}
  if (chip0 && t.chips.includes(chip0)) {
    try { warm = await ctx.prewarmCollateral(b.evidence); } catch (e) { warm = { ok: false, missing: [e.message] }; }
  }
  if (!warm || warm.ok !== true) {
    const why = `AMD collateral is unavailable right now (${((warm && warm.missing) || ["no answer"]).join(", ")}); retry shortly`;
    console.warn(`[secrets-release] ${id}: ${why} (ticket kept)`); bad(503, "collateral_unavailable", `${why}.`); return true;
  }
  if (tickets.get(tk) !== t) { bad(403, "bad_ticket", "Unknown, expired or already-used ticket, or one issued for another deployment."); return true; }
  tickets.delete(tk);   // consumed: everything below judges the guest's evidence
  const doc = b.evidence;
  if (!doc || typeof doc !== "object" || doc.format !== "sev-snp-guest-domain-v1" || doc.abi !== "enclave-domain-abi/2"
      || typeof doc.report !== "string" || typeof doc.transportKey !== "string" || !doc.runtime || typeof doc.runtime !== "object") {
    bad(422, "bad_evidence", "evidence must be a sev-snp-guest-domain-v1 document stating abi enclave-domain-abi/2, its transport key and its runtime."); return true;
  }
  // a release document states no verifier `nonce`: the ticket is committed in the binding, and a release report must never
  // pass for an ordinary nonce-bound attestation wherever it is logged or re-verified
  if (doc.nonce !== undefined) { bad(422, "bad_evidence", "a release document must not state a nonce (the ticket is bound in report_data)."); return true; }
  let runtimeId, appId, binding, report, measurements;
  try {
    runtimeId = b32(await ctx.runtimeIdOf(doc.runtime), "runtime id");
    // the images this runtime may run in: an admitted release's runtime AND its measurement, as one pair
    measurements = expected.images.filter((m) => m.runtimeId === runtimeId.toString("hex")).map((m) => m.measurement);
    if (!measurements.length) { bad(403, "runtime_not_admitted", "The guest's runtime is not the runtime of an admitted domain release."); return true; }
    appId = b32(Buffer.from(expected.appId, "hex"), "app id");
    binding = releaseBinding({ id, transportSpki: Buffer.from(doc.transportKey, "base64"), ticket, runtimeId, sealKey });
    report = Buffer.from(doc.report, "base64");
  } catch (e) { bad(422, "bad_evidence", e.message); return true; }
  const v = await ctx.verifyGuestEvidence(doc, { allowedMeasurements: measurements, minTcb: cfg.minTcb, expectedVmpl: cfg.vmpl,
                                                 expectedBinding: binding, expectedAppId: appId, expectedHostData: idBytes(id) });
  if (!v || v.status !== "verified") {
    console.warn(`[secrets-release] ${id}: evidence REFUSED: ${(v && v.reasons && v.reasons.at(-1)) || "no verdict"}`);
    bad(403, "evidence_refused", (v && v.reasons && v.reasons.at(-1)) || "The guest's evidence did not verify."); return true;
  }
  // belt and braces over the verified report: the fields this release depends on, read here
  let f; try { f = reportFields(report); } catch (e) { bad(422, "bad_evidence", e.message); return true; }
  const why = f.signingKey !== 0 ? "the report is not VCEK-signed"
    : (f.policy >> 19n) & 1n ? "the guest policy allows DEBUG"
    : f.vmpl !== cfg.vmpl ? `the report states VMPL ${f.vmpl}, not the pinned ${cfg.vmpl}`
    : !measurements.includes(f.measurement.toString("hex")) ? "the measurement is not the one predicted for this deployment's version under an admitted release"
    : !f.reportData.subarray(0, 32).equals(binding) ? "report_data[0:32] is not this release's binding"
    : !f.reportData.subarray(32, 64).equals(appId) ? "report_data[32:64] is not this deployment's app"
    : !f.hostData.equals(idBytes(id)) ? "HOST_DATA is not this deployment"
    : !nonZero(f.chipId) ? "the report's CHIP_ID is zero (masked)"
    : !t.chips.includes(f.chipId.toString("hex")) ? "the report is not from a chip the lease holder attested with"
    : null;
  if (why) { console.warn(`[secrets-release] ${id}: REFUSED: ${why}`); bad(403, "evidence_refused", why); return true; }
  const plaintext = JSON.stringify({ id, envelopeSha256: sha256(Buffer.from(envelope)).toString("hex"), config, secrets: envOf(id) || {},
                                     issuedAt: new Date().toISOString() });
  let sealed;
  try { sealed = sealRelease({ id, ticket, sealKey, plaintext }); }
  catch (e) { bad(422, "bad_seal_key", e.message); return true; }
  const sig = signResponse(cfg.signingKey, { id, ticket, sealKey, sealed });
  console.log(`[secrets-release] ${id}: released to a verified guest on ${t.endpoint} (runtime ${runtimeId.toString("hex").slice(0, 12)}…)`);
  ctx.json(res, 200, { id, sealed: sealed.toString("base64"), sig: sig.toString("base64"), keyId: keyIdOf(ed25519RawPublic(cfg.signingKey)) }, req);
  return true;
}
