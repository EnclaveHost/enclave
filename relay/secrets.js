// Per-deployment secrets: env-var-shaped private values (S3 keys, API tokens)
// the OWNER stores here instead of on the public chain. The catalog config and
// the options-envelope config override are both on-chain and world-readable by
// design — this store is the private companion: values live only on the relay
// (encrypted at rest) and inside the enclave that holds the deployment's lease,
// which injects them into the guest as wasi env vars at app start.
//
// TRUST MODEL — deliberate and documented on the site: the relay operator CAN
// read these (it decrypts to serve the lease-holder), the chain and other
// tenants can NOT. That matches what the store is for (cloud-provider-grade
// secrets, not operator-proof sealing); operator-proof custody remains the
// encrypted-volumes credsEnvelope path (client-side wallet-derived sealing).
// At-rest encryption means a leaked disk/backup is not a secrets leak.
//
// AUTH — three distinct parties, no session system involved:
//   owner writes/reads: EIP-191 personal_sign over a canonical string, the
//     recovered address must equal the deployment's ON-CHAIN owner (the first
//     relay route that checks a wallet signature against the ledger; the
//     upload-token flow only rate-limits). Signatures expire (<=10 min) and
//     are single-use (replay cache to expiry).
//   fleet fetch: HMAC with a key DERIVED from the fleet SECRET — the dns-relay
//     pattern: the relay env holds only HMAC(SECRET, "enclave secrets v1"),
//     never the SECRET itself (SECRET mints session JWTs; this key authorizes
//     secrets fetches and nothing else). Enclaves derive the same key locally,
//     so the fleet needs NO new secret binding. The fetch names the requesting
//     endpoint; it must be the deployment's live on-chain lease holder
//     (runner = keccak256(endpoint)), so a fleet member only ever receives
//     secrets for work the chain says is its.
//
// Endpoints (relay-owned, answer with zero live enclaves like /v1/account/*):
//   POST /v1/secrets/:id       {payload, expiry, signature}   owner mutate
//                              payload = JSON string {set?, del?, clear?}
//                              signs: enclave-secrets:put:<id>:<expiry>:<sha256(payload)>
//   POST /v1/secrets/:id/get   {expiry, signature}            owner read back
//                              signs: enclave-secrets:get:<id>:<expiry>
//   POST /v1/secrets/fetch     {id, endpoint, ts, sig}        lease-holder fetch
//                              sig = HMAC(fetchKey, "<id>:<endpoint>:<ts>")
//
// Config (env): SECRETS_KEY (64-hex, = HMAC(SECRET, "enclave secrets v1"); the
// supervisor header documents the same derivation for DNS_TXT_KEY), plus the
// shared AUTH_DATA_DIR activation switch. Either missing = 503 secrets_disabled.
//
// Values in a guest env are readable by the app, and an app that PRINTS them
// puts them in its owner-readable log — same exposure class as ENCLAVE_CONFIG.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { JsonStore, dataDir, dataFile, makeRateLimiter } from "./store.js";

// One env key, two derived subkeys: labels keep the fetch-auth MAC and the
// at-rest cipher cryptographically independent even though they share a root.
const SECRETS_KEY = (process.env.SECRETS_KEY || "").trim();
const sub = (label) => createHmac("sha256", Buffer.from(SECRETS_KEY, "hex")).update(label).digest();

// The wire/storage contract. Key shape is the POSIX env-var convention; the
// ENCLAVE_ prefix is the platform's own namespace (ENCLAVE_CONFIG, ENCLAVE_ENC_
// TOKEN, ...) — a secret there could shadow a platform channel inside the guest.
export const SECRETS_LIMITS = { maxKeys: 64, maxValueBytes: 4096, maxTotalBytes: 16384 };
export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SIG_TTL_SEC = 600, FETCH_SKEW_SEC = 300;

export const putMessage = (id, expiry, payload) =>
  `enclave-secrets:put:${id}:${expiry}:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
export const getMessage = (id, expiry) => `enclave-secrets:get:${id}:${expiry}`;
export const fetchSig = (keyHex, id, endpoint, ts) =>
  createHmac("sha256", createHmac("sha256", Buffer.from(keyHex, "hex")).update("fetch-auth v1").digest())
    .update(`${id}:${endpoint}:${ts}`).digest("hex");

let store = null;         // JsonStore { byId: { <id>: { rev, updatedAt, blob, missingSince? } } }
let enabled = false;
export const secretsEnabled = () => enabled;

// AES-256-GCM, AAD = the deployment id, so a blob copied onto another record
// fails to open. blob = base64(iv(12) || tag(16) || ciphertext).
function seal(id, env) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sub("at-rest v1"), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(id, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(env), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function open(id, blob) {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", sub("at-rest v1"), raw.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(id, "utf8"));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}

// validate a {NAME: value} env map against the wire contract; throws with the
// first offense named (the CLI/site surface the message verbatim)
export function checkEnvMap(env) {
  const names = Object.keys(env);
  if (names.length > SECRETS_LIMITS.maxKeys) throw new Error(`too many secrets (max ${SECRETS_LIMITS.maxKeys})`);
  let total = 0;
  for (const k of names) {
    if (!SECRET_KEY_RE.test(k)) throw new Error(`"${k}" is not an env-var name ([A-Za-z_][A-Za-z0-9_]*, max 64 chars)`);
    if (/^ENCLAVE_/i.test(k)) throw new Error(`"${k}": the ENCLAVE_ prefix is reserved for platform variables`);
    const v = env[k];
    if (typeof v !== "string") throw new Error(`"${k}" must be a string value`);
    const bytes = Buffer.byteLength(v, "utf8");
    if (bytes > SECRETS_LIMITS.maxValueBytes) throw new Error(`"${k}" is ${bytes} bytes (max ${SECRETS_LIMITS.maxValueBytes} per value)`);
    if (/[\0\r\n]/.test(v)) throw new Error(`"${k}" contains a NUL or newline; env values must be single-line`);
    total += Buffer.byteLength(k, "utf8") + bytes;
  }
  if (total > SECRETS_LIMITS.maxTotalBytes) throw new Error(`secrets total ${total} bytes (max ${SECRETS_LIMITS.maxTotalBytes} per deployment)`);
}

// single-use signatures: a captured owner signature must not replay within its
// expiry window. Bounded map, pruned as it's touched.
const seenSigs = new Map();                                   // sha256(sig) -> expiry(sec)
function sigFresh(signature, expiry) {
  const now = Math.floor(Date.now() / 1000);
  if (seenSigs.size > 10_000) for (const [k, e] of seenSigs) if (e < now) seenSigs.delete(k);
  const mark = createHash("sha256").update(signature).digest("base64");
  if (seenSigs.has(mark)) return false;
  seenSigs.set(mark, expiry);
  return true;
}

const rlOwner = makeRateLimiter({ capacity: 30, refillPerSec: 30 / 60 });   // per recovered wallet
const rlFetch = makeRateLimiter({ capacity: 120, refillPerSec: 10 });       // per source ip (fleet-only traffic)

export async function initSecrets() {
  const dir = dataDir();
  if (!SECRETS_KEY || !dir) {
    console.log(`[secrets] disabled (${!SECRETS_KEY ? "SECRETS_KEY unset" : "no writable AUTH_DATA_DIR"}) — per-deployment secrets 503`);
    return;
  }
  if (!/^[0-9a-f]{64}$/i.test(SECRETS_KEY)) {
    console.error("[secrets] SECRETS_KEY must be 64 hex chars (HMAC(SECRET, \"enclave secrets v1\")) — disabled");
    return;
  }
  store = new JsonStore(dataFile(dir, "secrets.json"), { byId: {} }, { durable: true });
  enabled = true;
  const n = Object.keys(store.data.byId).length;
  console.log(`[secrets] enabled (${n} deployment${n === 1 ? "" : "s"} with stored secrets)`);
}

// resolve one ledger row by exact id (lowercased bytes32); a force-refreshed
// second read covers the seconds right after a claim/create when the relay's
// 10s ledger cache predates the tx.
async function rowOf(ctx, id, { fresh = false } = {}) {
  if (fresh) ctx.ledgerExpire();
  let rows; try { rows = await ctx.ledgerRows(); } catch { return null; }
  return rows.find((d) => String(d.id).toLowerCase() === id) || null;
}

const bad = (ctx, res, req, code, error, message) => ctx.json(res, code, { error, message }, req);

// shared owner-signature gate: parse body, bound expiry, recover the signer,
// match the on-chain owner. Returns { b, d, address } or null (answered).
async function ownerGate(ctx, req, res, id, b, message) {
  const now = Math.floor(Date.now() / 1000);
  const expiry = parseInt(b.expiry, 10);
  const signature = String(b.signature || "");
  if (!Number.isFinite(expiry) || expiry < now || expiry > now + SIG_TTL_SEC)
    return bad(ctx, res, req, 422, "bad_expiry", `expiry must be a unix time within the next ${SIG_TTL_SEC / 60} minutes.`), null;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    return bad(ctx, res, req, 422, "bad_sig", "signature must be a 65-byte personal_sign hex."), null;
  let address;
  try {
    const { recoverMessageAddress } = await import("viem");
    address = (await recoverMessageAddress({ message, signature })).toLowerCase();
  } catch (e) { return bad(ctx, res, req, 400, "bad_sig", "Could not recover the signer: " + (e.shortMessage || e.message)), null; }
  if (!rlOwner(address))
    return bad(ctx, res, req, 429, "rate_limited", "Too many secrets requests from this wallet; retry shortly."), null;
  let d = await rowOf(ctx, id);
  if (!d) d = await rowOf(ctx, id, { fresh: true });          // just-created record: one cache-bypass retry
  if (!d) return bad(ctx, res, req, 404, "not_found", `No deployment ${id} on the ledger.`), null;
  if (String(d.owner).toLowerCase() !== address)
    return bad(ctx, res, req, 403, "not_owner", "The signer does not own this deployment."), null;
  if (!sigFresh(signature, expiry))
    return bad(ctx, res, req, 409, "sig_replayed", "This signature was already used; sign a fresh request."), null;
  return { d, address };
}

const recOf = (id) => store.data.byId[id] || null;
const namesOf = (env) => Object.keys(env).sort();

// core mutate, exported for the MCP tools (same signature contract, no HTTP)
export function applyPut(id, payload) {
  let p; try { p = JSON.parse(payload); } catch { throw new Error("payload must be a JSON string"); }
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("payload must be a JSON object {set?, del?, clear?}");
  for (const k of Object.keys(p)) if (!["set", "del", "clear"].includes(k)) throw new Error(`payload key "${k}" is not one of set/del/clear`);
  const rec = recOf(id);
  let env = p.clear === true ? {} : rec ? open(id, rec.blob) : {};
  for (const k of Array.isArray(p.del) ? p.del : []) delete env[String(k)];
  if (p.set != null) {
    if (typeof p.set !== "object" || Array.isArray(p.set)) throw new Error("set must be an object of NAME: value");
    Object.assign(env, p.set);
  }
  checkEnvMap(env);
  const rev = (rec?.rev || 0) + 1;
  if (!Object.keys(env).length) {
    delete store.data.byId[id];                               // empty = the record is gone, not a tombstone
    store.saveSoon();
    return { rev, names: [], updatedAt: new Date().toISOString() };
  }
  const updatedAt = new Date().toISOString();
  store.data.byId[id] = { rev, updatedAt, blob: seal(id, env) };
  store.saveSoon();
  return { rev, names: namesOf(env), updatedAt };
}

export function readSecrets(id) {                             // exported for MCP get
  const rec = recOf(id);
  return rec ? { rev: rec.rev, updatedAt: rec.updatedAt, env: open(id, rec.blob) } : { rev: 0, updatedAt: null, env: {} };
}

export async function handleSecrets(req, res, u, ctx) {
  if (!enabled)
    return bad(ctx, res, req, 503, "secrets_disabled", "Per-deployment secrets are not configured on this relay.");
  if (req.method !== "POST")
    return bad(ctx, res, req, 405, "method_not_allowed", "Secrets endpoints are POST-only (signatures never belong in URLs).");
  let raw; try { raw = await ctx.readBody(req, 32768); } catch (e) { return bad(ctx, res, req, 413, "too_large", e.message); }
  let b; try { b = JSON.parse(raw.toString() || "{}"); } catch { return bad(ctx, res, req, 400, "bad_json", "Body must be JSON."); }

  // fleet fetch — the lease-holding enclave pulls right before it (re)starts the app
  if (u.pathname === "/v1/secrets/fetch") {
    if (!rlFetch(ctx.clientIp(req)))
      return bad(ctx, res, req, 429, "rate_limited", "Too many secrets fetches; retry shortly.");
    const id = String(b.id || "").toLowerCase();
    const endpoint = String(b.endpoint || "").replace(/\/+$/, "");
    const ts = parseInt(b.ts, 10);
    const sig = String(b.sig || "");
    if (!/^0x[0-9a-f]{64}$/.test(id)) return bad(ctx, res, req, 422, "bad_id", "id must be a bytes32 deployment id.");
    if (!/^https?:\/\//.test(endpoint)) return bad(ctx, res, req, 422, "bad_endpoint", "endpoint must be the enclave's registered origin.");
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > FETCH_SKEW_SEC)
      return bad(ctx, res, req, 422, "bad_ts", `ts must be a unix time within ±${FETCH_SKEW_SEC}s.`);
    const want = Buffer.from(fetchSig(SECRETS_KEY, id, endpoint, ts), "hex");
    const got = /^[0-9a-f]{64}$/.test(sig) ? Buffer.from(sig, "hex") : Buffer.alloc(32);
    if (!timingSafeEqual(want, got))
      return bad(ctx, res, req, 401, "bad_fetch_sig", "The fetch HMAC does not verify.");
    // the chain says who holds the lease; a fresh re-read covers a claim tx
    // newer than the 10s ledger cache (the supervisor fetches right after it)
    const epId = String(await ctx.endpointIdOf(endpoint)).toLowerCase();
    let d = await rowOf(ctx, id);
    const holds = (row) => row && !/^0x0+$/.test(String(row.runner)) && Number(row.leaseUntil) * 1000 > Date.now()
      && String(row.runner).toLowerCase() === epId;
    if (!holds(d)) d = await rowOf(ctx, id, { fresh: true });
    if (!d) return bad(ctx, res, req, 404, "not_found", `No deployment ${id} on the ledger.`);
    if (!holds(d)) return bad(ctx, res, req, 409, "not_lease_holder", "This endpoint does not hold the deployment's live lease.");
    const { rev, env } = readSecrets(id);
    return ctx.json(res, 200, { id, rev, env }, req);
  }

  const m = u.pathname.match(/^\/v1\/secrets\/(0x[0-9a-fA-F]{64})(\/get)?$/);
  if (!m) return bad(ctx, res, req, 404, "not_found", "POST /v1/secrets/:id, /v1/secrets/:id/get, or /v1/secrets/fetch.");
  const id = m[1].toLowerCase();

  if (m[2]) {                                                 // owner read-back
    const gate = await ownerGate(ctx, req, res, id, b, getMessage(id, parseInt(b.expiry, 10)));
    if (!gate) return;
    const { rev, updatedAt, env } = readSecrets(id);
    return ctx.json(res, 200, { id, rev, updatedAt, names: namesOf(env), env }, req);
  }

  // owner mutate
  const payload = typeof b.payload === "string" ? b.payload : null;
  if (payload == null || Buffer.byteLength(payload, "utf8") > 24576)
    return bad(ctx, res, req, 422, "bad_payload", "payload must be a JSON *string* of {set?, del?, clear?} (it is hashed byte-exact into the signed message), under 24576 bytes.");
  const gate = await ownerGate(ctx, req, res, id, b, putMessage(id, parseInt(b.expiry, 10), payload));
  if (!gate) return;
  let out;
  try { out = applyPut(id, payload); }
  catch (e) { return bad(ctx, res, req, 422, "bad_secrets", e.message); }
  return ctx.json(res, 200, { id, ...out,
    note: "A running deployment picks new secrets up on its next start — restart it to apply (enclave restart <id>)." }, req);
}

// Hourly sweep: a stored id whose record has left the ledger (contract
// migration that dropped it, test debris) is purged after a 7-day grace.
// On-chain records normally persist forever, so this fires rarely by design;
// stopped-but-resumable deployments keep their secrets.
export function startSecretsSweep(ctx) {
  if (!enabled) return;
  const GRACE_MS = 7 * 86400_000;
  setInterval(async () => {
    let rows; try { rows = await ctx.ledgerRows(); } catch { return; }
    if (!rows.length) return;                                  // an empty read is an RPC hiccup, not an empty chain
    const onLedger = new Set(rows.map((d) => String(d.id).toLowerCase()));
    let dirty = false;
    for (const [id, rec] of Object.entries(store.data.byId)) {
      if (onLedger.has(id)) { if (rec.missingSince) { delete rec.missingSince; dirty = true; } continue; }
      if (!rec.missingSince) { rec.missingSince = Date.now(); dirty = true; }
      else if (Date.now() - rec.missingSince > GRACE_MS) {
        delete store.data.byId[id]; dirty = true;
        console.log(`[secrets] purged ${id} (off-ledger > 7d)`);
      }
    }
    if (dirty) store.saveSoon();
  }, 3600_000).unref?.();
}
