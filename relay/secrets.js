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
//     (runner = keccak256(endpoint)), so secrets only ever leave here for work
//     the chain says a fleet member is doing.
//     BE PRECISE ABOUT WHAT THE HMAC PROVES. The derived key is SHARED
//     fleet-wide, so on its own it authenticates "a holder of the fleet key",
//     not "this endpoint" — any fleet member could name another's endpoint and
//     be served that deployment's secrets. A symmetric fleet key cannot express
//     mutual isolation between members, so it does not have to: the endpoint's
//     OWN key does.
//   operator signature (2026-07-27): when the claimed endpoint has an
//     EnclaveRegistry entry, the fetch must ALSO carry `opSig` — a personal_sign
//     over the same <id>:<endpoint>:<ts> tuple by the operator that registered
//     it. That key is per-enclave and never leaves its CVM, so naming somebody
//     else's endpoint now needs their key, not just the fleet's. An endpoint
//     with no entry cannot be a lease holder anyway, so nothing is relaxed for
//     it; a registry read that fails falls back to the last owner seen (an RPC
//     blip must not become the way in). This is the per-enclave identity the
//     peer-JWKS note used to defer — reached with the key the box already has.
//
// Endpoints (relay-owned, answer with zero live enclaves like /v1/account/*):
//   POST /v1/secrets/:id       {payload, expiry, signature}   owner mutate
//                              payload = JSON string {set?, del?, clear?}
//                              signs: enclave-secrets:put:<id>:<expiry>:<sha256(payload)>
//   POST /v1/secrets/:id/get   {expiry, signature}            owner read back
//                              signs: enclave-secrets:get:<id>:<expiry>
//   POST /v1/secrets/fetch     {id, endpoint, ts, sig, opSig}  lease-holder fetch
//                              sig   = HMAC(fetchKey, "<id>:<endpoint>:<ts>")
//                              opSig = personal_sign by the endpoint's registry
//                                      operator of
//                                      "enclave-secrets-fetch:<id>:<endpoint>:<ts>"
//
// Config (env): SECRETS_KEY (64-hex, = HMAC(SECRET, "enclave secrets v1"); the
// supervisor header documents the same derivation for DNS_TXT_KEY), plus the
// shared AUTH_DATA_DIR activation switch. Either missing = 503 secrets_disabled.
//
// Values in a guest env are readable by the app, and an app that PRINTS them
// puts them in its owner-readable log — same exposure class as ENCLAVE_CONFIG.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { JsonStore, dataDir, dataFile, makeRateLimiter } from "./store.js";
// the fleet-route primitives shared with certs.js (one spelling per rule)
import { endpointOperator, recoverOp, makeReplayCache, rowOf, holdsLease } from "./fleet-auth.js";

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
// Enforce the per-enclave operator signature on fetches from a REGISTERED
// endpoint (see the AUTH note above). Default ON; SECRETS_REQUIRE_OPSIG=0 is the
// lever for one case only — a rollout where this relay updated before the
// enclaves did — and every use of it is logged with the endpoint to fix.
const REQUIRE_OPSIG = !/^(0|false|off|no)$/i.test((process.env.SECRETS_REQUIRE_OPSIG ?? "1").trim());

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

// single-use signatures: a captured owner signature must not replay within
// its expiry window (fleet-auth.js makeReplayCache).
const sigFresh = makeReplayCache();

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

// Core mutate. Exported for TESTS only - and it performs NO authorization: the
// owner signature is checked by ownerGate in the HTTP layer above, never here.
// Any future caller (MCP included - its secrets tools deliberately POST to the
// HTTP endpoints carrying the owner's signature, rather than reaching in here)
// must go through that gate. Calling this directly is an owner-check bypass.
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

export function readSecrets(id) {          // TESTS only - unauthenticated, see applyPut
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
    const fleetOk = timingSafeEqual(want, got);
    // SECOND FACTOR: the endpoint's OWN key, not the fleet's. The HMAC above is
    // a shared derived key — it authenticates "a holder of the fleet key", so
    // by itself any fleet member could name ANOTHER member's endpoint and be
    // served that deployment's secrets (the header above has always said so).
    // The registry entry for this endpoint names an operator, and only that
    // operator holds the key: when the entry exists, the caller must sign the
    // same tuple with it. An endpoint with no registry entry cannot be a lease
    // holder anyway, so there is nothing to relax for.
    const owner = await endpointOperator(ctx, endpoint);
    let opOk = false;
    if (owner) {
      const signer = await recoverOp(`enclave-secrets-fetch:${id}:${endpoint}:${ts}`, b.opSig);
      opOk = !!signer && signer === owner;
      // A WRONG key is always refused — that is the whole point, and no rollout
      // produces one. A MISSING one can only come from a supervisor older than
      // this check, and the relay and the enclave images ship independently: if
      // the relay lands first, every secret-bearing app on the fleet launches
      // without its secrets until the enclaves catch up. So the missing case is
      // loud and has an operator lever (REQUIRE=0) to unblock a bad rollout
      // order; enforcing is the default, and the log names exactly what to fix.
      if (signer && signer !== owner) {
        // Logged for the same reason the missing-signature case below is, and
        // the omission cost a real investigation: a WRONG key and a MISSING
        // one produce the same end state (an app running with unresolved
        // $NAME placeholders), but only one of them said so. Silence here made
        // "the enclave never asked" and "the enclave asked and was refused"
        // indistinguishable from this side.
        console.error(`[secrets] ${endpoint} fetch REFUSED: signed by ${signer}, `
          + `but the endpoint is registered to ${owner} (deployment ${id})`);
        return bad(ctx, res, req, 403, "wrong_operator",
          `The fetch is signed by ${signer}, but ${endpoint} is registered to ${owner}.`);
      }
      if (!signer) {
        console.error(`[secrets] ${endpoint} fetched WITHOUT an operator signature `
          + `(registered to ${owner}) — its supervisor predates the per-enclave check`
          + (REQUIRE_OPSIG ? "; REFUSED" : "; allowed by SECRETS_REQUIRE_OPSIG=0"));
        if (REQUIRE_OPSIG)
          return bad(ctx, res, req, 401, "no_operator_sig",
            "This endpoint is registered on chain; the fetch must be signed by its operator key (opSig).");
      }
    }
    // EITHER factor opens the fetch, because the operator one is the STRONGER
    // of the two and the lease check below is what actually scopes it.
    //
    // The fleet HMAC only ever proved "a holder of the fleet key" — which is
    // why it needed the operator signature beside it. The operator signature
    // proves control of the key that REGISTERED this endpoint on chain, and
    // the ledger then says whether that endpoint holds this deployment's live
    // lease. A box passing both is, by definition, the box running the app;
    // handing it the app's secrets is the entire purpose of the plane.
    //
    // Requiring the fleet key ON TOP of that bought nothing and cost a great
    // deal: it meant a self-hosted enclave could only serve secret-bearing
    // apps by holding a key that also authorizes pushing ANY _acme-challenge
    // TXT in the app zone (dns-relay's fleet-HMAC path) — i.e. obtaining a CA
    // certificate for every deployment hostname on the platform. On a metal
    // box that key would sit in an operator-readable config file outside the
    // CVM, so the enclave boundary would not protect it. No third-party seller
    // can ever be given it, and no first-party box should have to be.
    if (!fleetOk && !opOk) {
      console.error(`[secrets] ${endpoint} fetch REFUSED for ${id}: no valid fleet HMAC`
        + (owner ? ` and no signature by its registered operator ${owner}` : " and no registry entry to authorize it"));
      return bad(ctx, res, req, 401, "bad_fetch_sig",
        owner ? "The fetch carries neither a valid fleet HMAC nor a signature by this endpoint's registered operator."
              : "The fetch HMAC does not verify, and this endpoint has no on-chain registry entry to authorize it instead.");
    }
    // the chain says who holds the lease; a fresh re-read covers a claim tx
    // newer than the 10s ledger cache (the supervisor fetches right after it)
    const epId = String(await ctx.endpointIdOf(endpoint)).toLowerCase();
    let d = await rowOf(ctx, id);
    const holds = (row) => holdsLease(row, epId);
    if (!holds(d)) d = await rowOf(ctx, id, { fresh: true });
    if (!d) return bad(ctx, res, req, 404, "not_found", `No deployment ${id} on the ledger.`);
    if (!holds(d)) {
      console.error(`[secrets] ${endpoint} fetch REFUSED for ${id}: not the live lease holder `
        + `(ledger runner ${d.runner}, leaseUntil ${d.leaseUntil})`);
      return bad(ctx, res, req, 409, "not_lease_holder", "This endpoint does not hold the deployment's live lease.");
    }
    const { rev, env } = readSecrets(id);
    // SUCCESS is logged too, and that is the point of this pair rather than a
    // nicety. A launch that comes up without its secrets looks identical from
    // the relay whether the fetch was refused, or never arrived at all — and
    // "never arrived" is a real failure mode here (an enclave that cannot
    // reach this relay outbound). With every outcome logged, SILENCE for a
    // deployment that just launched means the request did not get here.
    //
    // Read that carefully: it says the request was never SENT, not that egress
    // ate it. Both were live causes. The supervisor's respawn path used to
    // relaunch tenants without ever asking (see launchSpec in supervisor.js),
    // so silence pointed at the network when the truth was that nobody dialled;
    // now every launch path fetches, and silence really does mean the wire.
    // Names and values stay out of it; the count is enough to tell "served
    // nothing" from "served three".
    console.log(`[secrets] ${endpoint} fetch OK for ${id}: rev ${rev}, ${Object.keys(env).length} name(s)`);
    return ctx.json(res, 200, { id, rev, env }, req);
  }

  // existence probe — deliberately UNAUTHENTICATED (rate-limited with the
  // fetch bucket): a secrets-INCAPABLE runner (a metal box without the fleet
  // secret) asks this before claiming, so a secret-bearing deployment is
  // never claimed by a box that would launch it without its env. It leaks
  // only the boolean "this public deployment id has secrets staged" — names
  // and values stay behind the authenticated paths.
  if (u.pathname === "/v1/secrets/exists") {
    if (!rlFetch(ctx.clientIp(req)))
      return bad(ctx, res, req, 429, "rate_limited", "Too many probes; retry shortly.");
    const id = String(b.id || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) return bad(ctx, res, req, 422, "bad_id", "id must be a bytes32 deployment id.");
    return ctx.json(res, 200, { id, exists: !!recOf(id) }, req);
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
