// Per-deployment secrets (relay/secrets.js) — the private companion to the
// public on-chain config: owner-signed writes, at-rest AES-GCM sealing, and
// the lease-holder fetch HMAC. These tests pin
//   (1) the canonical signed strings the CLI/site/MCP all hand-build,
//   (2) the fetch-HMAC derivation the SUPERVISOR mirrors inline
//       (HMAC(HMAC(SECRETS_KEY, "fetch-auth v1"), id:endpoint:ts)),
//   (3) the wire-contract limits (names, sizes, ENCLAVE_ reservation),
//   (4) the HTTP gates: on-chain owner match, expiry bounds, single-use
//       signatures, and lease-holder-only fetch.
//
//   run: node --test test/secrets.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

// module config is read at import: stage env FIRST (the same activation
// switches production uses - SECRETS_KEY + AUTH_DATA_DIR)
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-secrets-test-"));
const KEY = "ab".repeat(32);
process.env.SECRETS_KEY = KEY;
process.env.AUTH_DATA_DIR = DIR;

const { initSecrets, handleSecrets, secretsEnabled, applyPut, readSecrets,
        checkEnvMap, putMessage, getMessage, fetchSig, SECRETS_LIMITS, SECRET_KEY_RE } =
  await import("../relay/secrets.js");
await initSecrets();

const OWNER = privateKeyToAccount("0x" + "11".repeat(32));
const OTHER = privateKeyToAccount("0x" + "22".repeat(32));
const ID = "0x" + "cd".repeat(32);
const RUNNER = "0x" + "aa".repeat(32);
const ENDPOINT = "https://enclave1.example";

// one mutable ledger row set + a relayCtx-shaped test double (the same members
// api-relay.js hands the real handler)
let rows = [];
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => Buffer.from(JSON.stringify(req.body)),
  clientIp: () => "203.0.113.7",
  ledgerRows: async () => rows,
  ledgerExpire: () => {},
  endpointIdOf: async (ep) => (ep === ENDPOINT ? RUNNER : "0x" + "ee".repeat(32)),
  // WHO the registry says owns each endpoint. `epOwner` is swapped per test:
  // null = unregistered (nothing to prove), an address = that operator's key is
  // required, and a thrown error = an unreadable registry.
  operatorOfEndpoint: async (ep) => {
    if (typeof epOwner === "function") return epOwner(ep);
    return epOwner;
  },
};
let epOwner = null;
const call = async (pathname, body) => {
  const res = {};
  await handleSecrets({ method: "POST", body }, res, new URL("http://x" + pathname), ctx);
  return res;
};
const leaseRow = (over = {}) => ({ id: ID, owner: OWNER.address, runner: RUNNER,
  leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 1800), ...over });
const expiryNow = () => Math.floor(Date.now() / 1000) + 300;
const putBody = async (account, payload, expiry = expiryNow()) =>
  ({ payload, expiry, signature: await account.signMessage({ message: putMessage(ID, expiry, payload) }) });
const getBody = async (account, expiry = expiryNow()) =>
  ({ expiry, signature: await account.signMessage({ message: getMessage(ID, expiry) }) });

test("module is enabled under the test env switches", () => {
  assert.equal(secretsEnabled(), true);
});

test("canonical strings are exactly what clients hand-build", () => {
  const payload = '{"set":{"A":"1"}}';
  assert.equal(putMessage(ID, 1234, payload),
    `enclave-secrets:put:${ID}:1234:${createHash("sha256").update(payload, "utf8").digest("hex")}`);
  assert.equal(getMessage(ID, 1234), `enclave-secrets:get:${ID}:1234`);
});

test("fetchSig matches the supervisor's inline double-HMAC derivation", () => {
  // supervisor.js: HMAC(HMAC(SECRETS_FETCH_KEY_bytes, "fetch-auth v1"), `${id}:${endpoint}:${ts}`)
  const inner = createHmac("sha256", Buffer.from(KEY, "hex")).update("fetch-auth v1").digest();
  const want = createHmac("sha256", inner).update(`${ID}:${ENDPOINT}:777`).digest("hex");
  assert.equal(fetchSig(KEY, ID, ENDPOINT, 777), want);
});

test("checkEnvMap enforces the wire contract", () => {
  checkEnvMap({ S3_KEY: "v", lower_ok: "v", _LEAD: "v" });
  assert.throws(() => checkEnvMap({ "9BAD": "v" }), /env-var name/);
  assert.throws(() => checkEnvMap({ "BAD-DASH": "v" }), /env-var name/);
  assert.throws(() => checkEnvMap({ ENCLAVE_CONFIG: "v" }), /reserved/);
  assert.throws(() => checkEnvMap({ enclave_sneaky: "v" }), /reserved/);   // case-insensitive reservation
  assert.throws(() => checkEnvMap({ A: 5 }), /string value/);
  assert.throws(() => checkEnvMap({ A: "a\nb" }), /single-line/);
  assert.throws(() => checkEnvMap({ A: "x".repeat(SECRETS_LIMITS.maxValueBytes + 1) }), /max 4096/);
  assert.throws(() => checkEnvMap(Object.fromEntries(
    Array.from({ length: SECRETS_LIMITS.maxKeys + 1 }, (_, i) => ["K" + i, "v"]))), /too many/);
  assert.equal(SECRET_KEY_RE.test("A".repeat(64)), true);
  assert.equal(SECRET_KEY_RE.test("A".repeat(65)), false);
});

test("applyPut/readSecrets: merge, del, clear, rev; empty set deletes the record", () => {
  let r = applyPut(ID, JSON.stringify({ set: { A: "1", B: "2" } }));
  assert.equal(r.rev, 1); assert.deepEqual(r.names, ["A", "B"]);
  r = applyPut(ID, JSON.stringify({ set: { B: "3", C: "4" } }));       // merge over stored
  assert.equal(r.rev, 2);
  assert.deepEqual(readSecrets(ID).env, { A: "1", B: "3", C: "4" });
  r = applyPut(ID, JSON.stringify({ del: ["A", "NOPE"] }));
  assert.deepEqual(readSecrets(ID).env, { B: "3", C: "4" });
  r = applyPut(ID, JSON.stringify({ clear: true, set: { Z: "9" } }));  // replace-all (the site's Save)
  assert.deepEqual(readSecrets(ID).env, { Z: "9" });
  applyPut(ID, JSON.stringify({ clear: true }));
  assert.deepEqual(readSecrets(ID), { rev: 0, updatedAt: null, env: {} });
  assert.throws(() => applyPut(ID, "not json"), /JSON string/);
  assert.throws(() => applyPut(ID, JSON.stringify({ nope: 1 })), /set\/del\/clear/);
});

test("at-rest blobs are AES-GCM under the derived key, sealed to their deployment id (AAD)", () => {
  applyPut(ID, JSON.stringify({ set: { A: "1" } }));
  const disk = JSON.parse(fs.readFileSync(path.join(DIR, "secrets.json"), "utf8"));
  const rec = disk.byId[ID];
  assert.ok(rec.blob, "record persisted");
  assert.ok(!JSON.stringify(disk).includes('"A":"1"'), "values must not be plaintext on disk");
  // independent decrypt with the documented derivation: right AAD opens,
  // a blob spliced onto another id (wrong AAD) is refused by the tag check
  const encKey = createHmac("sha256", Buffer.from(KEY, "hex")).update("at-rest v1").digest();
  const raw = Buffer.from(rec.blob, "base64");
  const dec = (aad) => {
    const d = createDecipheriv("aes-256-gcm", encKey, raw.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  };
  assert.match(dec(ID), /"A":"1"/);
  assert.throws(() => dec("0x" + "ef".repeat(32)));
  applyPut(ID, JSON.stringify({ clear: true }));
});

test("owner put: 200 for the on-chain owner, 403 for anyone else", async () => {
  rows = [leaseRow()];
  let res = await call(`/v1/secrets/${ID}`, await putBody(OWNER, JSON.stringify({ set: { S3_KEY: "s3cr3t" } })));
  assert.equal(res.code, 200);
  assert.equal(res.body.rev >= 1, true);
  assert.deepEqual(res.body.names, ["S3_KEY"]);
  res = await call(`/v1/secrets/${ID}`, await putBody(OTHER, JSON.stringify({ set: { EVIL: "x" } })));
  assert.equal(res.code, 403);
  assert.equal(res.body.error, "not_owner");
});

test("owner get returns values; signatures are single-use; expiry is bounded", async () => {
  rows = [leaseRow()];
  const b = await getBody(OWNER);
  let res = await call(`/v1/secrets/${ID}/get`, b);
  assert.equal(res.code, 200);
  assert.equal(res.body.env.S3_KEY, "s3cr3t");
  res = await call(`/v1/secrets/${ID}/get`, b);                        // exact replay
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "sig_replayed");
  res = await call(`/v1/secrets/${ID}/get`, await getBody(OWNER, Math.floor(Date.now() / 1000) - 5));
  assert.equal(res.code, 422);
  assert.equal(res.body.error, "bad_expiry");
  res = await call(`/v1/secrets/${ID}/get`, await getBody(OWNER, Math.floor(Date.now() / 1000) + 3600));
  assert.equal(res.code, 422);
});

test("bad secrets payloads burn a 422 (relay is the validating authority)", async () => {
  rows = [leaseRow()];
  const res = await call(`/v1/secrets/${ID}`, await putBody(OWNER, JSON.stringify({ set: { ENCLAVE_CONFIG: "x" } })));
  assert.equal(res.code, 422);
  assert.equal(res.body.error, "bad_secrets");
  assert.match(res.body.message, /reserved/);
});

test("fetch: released only to the live lease holder with a valid HMAC", async () => {
  rows = [leaseRow()];
  const ts = Math.floor(Date.now() / 1000);
  const ok = { id: ID, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID, ENDPOINT, ts) };
  let res = await call("/v1/secrets/fetch", ok);
  assert.equal(res.code, 200);
  assert.equal(res.body.env.S3_KEY, "s3cr3t");
  assert.equal(res.body.rev >= 1, true);

  // wrong endpoint (valid fleet HMAC for it, but not the lease holder)
  const ep2 = "https://enclave2.example";
  res = await call("/v1/secrets/fetch", { id: ID, endpoint: ep2, ts, sig: fetchSig(KEY, ID, ep2, ts) });
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "not_lease_holder");

  // garbage HMAC
  res = await call("/v1/secrets/fetch", { ...ok, sig: "0".repeat(64) });
  assert.equal(res.code, 401);

  // stale timestamp
  res = await call("/v1/secrets/fetch", { id: ID, endpoint: ENDPOINT, ts: ts - 3600, sig: fetchSig(KEY, ID, ENDPOINT, ts - 3600) });
  assert.equal(res.code, 422);

  // expired lease
  rows = [leaseRow({ leaseUntil: BigInt(Math.floor(Date.now() / 1000) - 10) })];
  const ts2 = ts + 1;
  res = await call("/v1/secrets/fetch", { id: ID, endpoint: ENDPOINT, ts: ts2, sig: fetchSig(KEY, ID, ENDPOINT, ts2) });
  assert.equal(res.code, 409);
});

test("fetch for a deployment with nothing stored answers rev 0, empty env", async () => {
  const ID2 = "0x" + "77".repeat(32);
  rows = [leaseRow({ id: ID2 })];
  const ts = Math.floor(Date.now() / 1000);
  const res = await call("/v1/secrets/fetch", { id: ID2, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID2, ENDPOINT, ts) });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.env, {});
  assert.equal(res.body.rev, 0);
});

test("unknown deployment 404s for owner ops", async () => {
  rows = [];
  const id99 = "0x" + "99".repeat(32);
  const expiry = expiryNow();
  const res = await call(`/v1/secrets/${id99}`, {
    payload: "{}", expiry,
    signature: await OWNER.signMessage({ message: putMessage(id99, expiry, "{}") }),
  });
  assert.equal(res.code, 404);
});

// ---- the endpoint's OWN key, not just the fleet's ---------------------------
// The fetch HMAC is a SHARED derived key: it proves "a holder of the fleet key",
// so on its own any fleet member could name another member's endpoint and be
// handed that deployment's secrets. The registry says which operator registered
// each endpoint, and only that operator holds the key — so a registered
// endpoint must sign the same tuple with it.
const OP = privateKeyToAccount("0x" + "31".repeat(32));
const IMPOSTOR = privateKeyToAccount("0x" + "32".repeat(32));
const opSigFor = (acct, id, ep, ts) =>
  acct.signMessage({ message: `enclave-secrets-fetch:${id}:${ep}:${ts}` });

test("fetch: a REGISTERED endpoint must sign with the operator that registered it", async () => {
  rows = [leaseRow()];
  epOwner = OP.address;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const base = { id: ID, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID, ENDPOINT, ts) };

    // the fleet HMAC alone is no longer enough
    let res = await call("/v1/secrets/fetch", base);
    assert.equal(res.code, 401);
    assert.equal(res.body.error, "no_operator_sig");

    // ...nor is a signature from ANOTHER fleet member's key (the exact case the
    // shared key could not distinguish)
    res = await call("/v1/secrets/fetch", { ...base, opSig: await opSigFor(IMPOSTOR, ID, ENDPOINT, ts) });
    assert.equal(res.code, 403);
    assert.equal(res.body.error, "wrong_operator");

    // ...nor one bound to a different tuple (another deployment's secrets)
    const other = "0x" + "5c".repeat(32);
    res = await call("/v1/secrets/fetch", { ...base, opSig: await opSigFor(OP, other, ENDPOINT, ts) });
    assert.equal(res.code, 403);

    // the real operator is served
    res = await call("/v1/secrets/fetch", { ...base, opSig: await opSigFor(OP, ID, ENDPOINT, ts) });
    assert.equal(res.code, 200);
    assert.equal(res.body.env.S3_KEY, "s3cr3t");
  } finally { epOwner = null; }
});

test("fetch: an UNREGISTERED endpoint is unchanged, and a dead registry fails closed", async () => {
  rows = [leaseRow()];
  const ts = Math.floor(Date.now() / 1000);
  const base = { id: ID, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID, ENDPOINT, ts) };

  // no registry entry: nothing to prove (such an endpoint cannot hold a lease
  // in the first place, so this relaxes nothing)
  epOwner = null;
  assert.equal((await call("/v1/secrets/fetch", base)).code, 200);

  // once an owner HAS been seen, an unreadable registry keeps demanding it
  epOwner = OP.address;
  assert.equal((await call("/v1/secrets/fetch",
    { ...base, opSig: await opSigFor(OP, ID, ENDPOINT, ts) })).code, 200);
  epOwner = () => { throw new Error("rpc down"); };
  try {
    let res = await call("/v1/secrets/fetch", { ...base, opSig: await opSigFor(IMPOSTOR, ID, ENDPOINT, ts) });
    assert.equal(res.code, 403, "a known owner must survive an unreadable registry");
    res = await call("/v1/secrets/fetch", { ...base, opSig: await opSigFor(OP, ID, ENDPOINT, ts) });
    assert.equal(res.code, 200, "...and the real operator still gets through");
  } finally { epOwner = null; }
});

test("fetch: the rollout lever can forgive a MISSING signature, never a wrong one", async () => {
  // SECRETS_REQUIRE_OPSIG=0 exists for exactly one case - a relay that updated
  // before the enclaves did - so it must sit on the missing-signature branch
  // only. Behaviour with the lever ON is covered above (wrong_operator = 403);
  // this pins that the lever cannot move it, which a runtime test cannot show
  // without a second, uninitialised module instance.
  const src = fs.readFileSync(new URL("../relay/secrets.js", import.meta.url), "utf8");
  const wrong = src.indexOf("wrong_operator");
  const lever = src.indexOf("if (REQUIRE_OPSIG)");
  assert.ok(wrong > 0 && lever > wrong,
    "the wrong-key refusal must come BEFORE the lever, so the lever can never reach it");
  assert.match(src, /if \(signer && signer !== owner\)/, "a wrong key is refused unconditionally");
});
