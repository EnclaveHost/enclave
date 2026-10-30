// The Windows consumer node's secrets fetch (windows/node/secrets.mjs) against a stub of the
// route it talks to (relay/secrets.js POST /v1/secrets/fetch).
//
// The stub is not a mock that says yes: it VERIFIES the request the way the relay does -- the id
// shape, the endpoint shape, the ±300s skew, and the recovery of `opSig` over the literal tuple
// "enclave-secrets-fetch:<id>:<endpoint>:<ts>" -- and answers 401/403/422 when it does not hold.
// So the signed message is pinned byte for byte by construction: get the spelling wrong on the node
// side and the happy-path test fails as a refusal, which is exactly how it would fail in
// production. The literal string is also asserted directly below, spelled out a second time, so
// this file says what the contract IS rather than only that both sides agree.
//
// The rest is about the one failure mode that matters here: "no secrets staged" and "this box was
// refused" both end with the app running and its $NAME placeholders unresolved, and from inside the
// guest they look identical. An empty snapshot must come back empty; a refusal must throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fetchSecrets, mergeEnv } from "../windows/node/secrets.mjs";

// This box's operator key: generated on the box, registered on chain, and the ONLY factor it sends
// (it holds no fleet key by design -- relay/secrets.js says why that key must never reach a
// consumer PC). The module takes a sign function, so the key never enters it.
const OP = privateKeyToAccount("0x" + "11".repeat(32));
const sign = (message) => OP.signMessage({ message });
const ID = "0x" + "ab".repeat(32);
const ENDPOINT = "https://api.enclave.host/t/nucbox-k11";
const SECRET_VALUE = "AKIAEXAMPLE/never-in-a-log";

const send = (res, status, body) => {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(s);
};

/**
 * A stub relay. `script` is (call, i) => { status, body } for the i-th request; the stub applies
 * relay/secrets.js's own gates first and only reaches the script if the request would have passed
 * them. Every request is recorded for the assertions in the tests.
 */
async function stubRelay(script) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const call = { method: req.method, path: req.url, ctype: req.headers["content-type"] || "", raw };
      calls.push(call);
      let b = {};
      try { b = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "bad_json", message: "Body must be JSON." }); }
      call.body = b;
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed", message: "POST-only." });
      if (req.url !== "/v1/secrets/fetch") return send(res, 404, { error: "not_found", message: "POST /v1/secrets/fetch." });
      const id = String(b.id || "").toLowerCase();
      const endpoint = String(b.endpoint || "").replace(/\/+$/, "");
      const ts = parseInt(b.ts, 10);
      if (!/^0x[0-9a-f]{64}$/.test(id)) return send(res, 422, { error: "bad_id", message: "id must be a bytes32 deployment id." });
      if (!/^https?:\/\//.test(endpoint)) return send(res, 422, { error: "bad_endpoint", message: "endpoint must be the enclave's registered origin." });
      if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300)
        return send(res, 422, { error: "bad_ts", message: "ts must be a unix time within ±300s." });
      // The second factor, and the only one this box sends. Same recovery as relay/fleet-auth.js
      // recoverOp, over the same tuple relay/secrets.js builds from the values IT parsed.
      let signer = null;
      try { signer = (await recoverMessageAddress({ message: `enclave-secrets-fetch:${id}:${endpoint}:${ts}`, signature: b.opSig })).toLowerCase(); } catch {}
      call.signer = signer;
      if (!signer) return send(res, 401, { error: "no_operator_sig", message: "This endpoint is registered on chain; the fetch must be signed by its operator key (opSig)." });
      if (signer !== OP.address.toLowerCase())
        return send(res, 403, { error: "wrong_operator", message: `The fetch is signed by ${signer}, but ${endpoint} is registered to ${OP.address.toLowerCase()}.` });
      const out = script(call, calls.length - 1);
      return send(res, out.status, out.body);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls,
           close: () => new Promise((r) => srv.close(r)) };
}

test("a normal fetch: the relay's own tuple, signed by the operator key, two names back", async (t) => {
  const relay = await stubRelay((call) => ({ status: 200,
    body: { id: call.body.id, rev: 7, env: { S3_ACCESS_KEY: SECRET_VALUE, API_TOKEN: "t0ken" } } }));
  t.after(relay.close);
  const lines = [];
  // The endpoint arrives with trailing slashes on purpose: the relay strips them BEFORE it builds
  // the message it verifies, so a node that signed the unstripped spelling recovers the right key
  // over the wrong message and is refused 403 -- a refusal that reads like a stolen key.
  const got = await fetchSecrets({ id: ID, endpoint: ENDPOINT + "//", sign, base: relay.base, log: (m) => lines.push(m) });

  assert.deepEqual(got.env, { S3_ACCESS_KEY: SECRET_VALUE, API_TOKEN: "t0ken" });
  assert.equal(got.count, 2);
  assert.equal(got.rev, 7);
  assert.equal(got.source, "relay");
  assert.deepEqual(got.dropped, []);

  assert.equal(relay.calls.length, 1, "one round trip, no retry on a served answer");
  const c = relay.calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.path, "/v1/secrets/fetch");
  assert.match(c.ctype, /application\/json/);
  assert.equal(c.body.id, ID.toLowerCase(), "the id is lowercased, as the relay lowercases what it verifies");
  assert.equal(c.body.endpoint, ENDPOINT, "trailing slashes are gone from the endpoint that is signed and sent");
  assert.ok(Math.abs(Date.now() / 1000 - c.body.ts) < 30, "ts is this box's clock in unix seconds");
  assert.match(c.body.opSig, /^0x[0-9a-f]{130}$/i, "a 65-byte personal_sign hex");
  // NOT the fleet HMAC. That derived key also authorizes dns-relay's _acme-challenge pushes, i.e.
  // a certificate for every deployment hostname on the platform, and on a consumer PC it would sit
  // in a VTL0 file. This box must never hold it, so it must never send a `sig`.
  assert.equal("sig" in c.body, false, "no fleet HMAC: this box holds no fleet key");

  // The contract, spelled out independently of the module: this exact string, and the recovered
  // signer is the operator.
  const message = `enclave-secrets-fetch:${ID.toLowerCase()}:${ENDPOINT}:${c.body.ts}`;
  assert.equal((await recoverMessageAddress({ message, signature: c.body.opSig })).toLowerCase(), OP.address.toLowerCase());
  assert.equal(c.signer, OP.address.toLowerCase());

  // Names and counts are logged because a launch without them is invisible; values never are.
  assert.ok(lines.some((l) => /rev 7/.test(l) && /S3_ACCESS_KEY/.test(l)), `names and rev are logged: ${lines.join(" | ")}`);
  for (const l of lines) assert.equal(l.includes(SECRET_VALUE), false, "a secret value must never reach a log line");
});

test("a deployment with no secrets comes back empty, not refused", async (t) => {
  const relay = await stubRelay((call) => ({ status: 200, body: { id: call.body.id, rev: 0, env: {} } }));
  t.after(relay.close);
  const got = await fetchSecrets({ id: ID, endpoint: ENDPOINT, sign, base: relay.base });
  assert.deepEqual(got.env, {});
  assert.equal(got.count, 0);
  assert.equal(got.source, "relay", "served, and what it served was nothing -- that is an answer");
});

test("a 403 refusal THROWS, with the relay's reason, and does not retry", async (t) => {
  // The relay's own wording for an endpoint whose registry entry names a different key. Reached
  // here by signing with a key the stub does not expect, so the 403 is produced by the same check
  // the relay runs, not scripted.
  const relay = await stubRelay(() => ({ status: 200, body: { id: ID, rev: 1, env: { NOPE: "x" } } }));
  t.after(relay.close);
  const stranger = privateKeyToAccount("0x" + "22".repeat(32));
  await assert.rejects(
    () => fetchSecrets({ id: ID, endpoint: ENDPOINT, sign: (m) => stranger.signMessage({ message: m }), base: relay.base }),
    (e) => {
      assert.match(e.message, /403/);
      assert.match(e.message, /wrong_operator/);
      assert.match(e.message, /registry entry/, "the reason has to say what to fix on this box");
      assert.match(e.message, new RegExp(ID), "and which deployment was refused");
      return true;
    });
  assert.equal(relay.calls.length, 1, "a wrong key does not fix itself in four seconds: no retry");
});

test("a name that would replace a platform channel is dropped, with a logged reason", async (t) => {
  const relay = await stubRelay((call) => ({ status: 200, body: { id: call.body.id, rev: 2, env: {
    ENCLAVE_CONFIG: "{\"model\":\"theirs\"}",          // the app's whole config
    ENCLAVE_INFERENCE_URL: "http://elsewhere/",        // this box's own addition, outside the four
    "BAD NAME": "x",                                   // argv/env-block would split it wrong
    NEWLINED: "a\nb",                                  // would break the NUL-delimited block
    NOT_A_STRING: 7,
    GOOD_TOKEN: "keepme",
    EMPTY_IS_FINE: "",
  } } }));
  t.after(relay.close);
  const lines = [];
  const got = await fetchSecrets({ id: ID, endpoint: ENDPOINT, sign, base: relay.base, log: (m) => lines.push(m) });

  assert.deepEqual(got.env, { GOOD_TOKEN: "keepme", EMPTY_IS_FINE: "" });
  assert.equal(got.count, 2);
  assert.deepEqual(got.dropped.sort(), ["BAD NAME", "ENCLAVE_CONFIG", "ENCLAVE_INFERENCE_URL", "NEWLINED", "NOT_A_STRING"]);
  for (const name of got.dropped)
    assert.ok(lines.some((l) => l.includes(`"${name}"`) && /--/.test(l)), `"${name}" was dropped with a reason: ${lines.join(" | ")}`);
  assert.ok(lines.some((l) => l.includes("ENCLAVE_CONFIG") && /platform/.test(l)));

  // And the second, independent reason the collision cannot land: the platform's own variables are
  // written over the secrets, so the config the guest reads is the one the claim policy accepted.
  const env = mergeEnv({ ENCLAVE_CONFIG: "{\"model\":\"ours\"}", ENCLAVE_MEM_MB: "512" }, { GOOD_TOKEN: "keepme", ENCLAVE_CONFIG: "{\"model\":\"theirs\"}" });
  assert.equal(env.ENCLAVE_CONFIG, "{\"model\":\"ours\"}");
  assert.equal(env.ENCLAVE_MEM_MB, "512");
  assert.equal(env.GOOD_TOKEN, "keepme");
  const base = { ENCLAVE_CONFIG: "{}" };
  mergeEnv(base, { X: "1" });
  assert.deepEqual(base, { ENCLAVE_CONFIG: "{}" }, "mergeEnv returns a new object and leaves no secret in the caller's");
});

test("a malformed 200 throws rather than launching an app on it", async (t) => {
  const bodies = [
    { id: ID, rev: 1, env: "nope" },                               // env is not a map
    "<html>captive portal</html>",                                 // not JSON at all
    { id: "0x" + "cd".repeat(32), rev: 1, env: { X: "1" } },       // an answer about another deployment
  ];
  const relay = await stubRelay((call, i) => ({ status: 200, body: bodies[i] }));
  t.after(relay.close);
  const expect = [/no env object/, /not JSON/, /answered for 0xcdcd/];
  for (const re of expect)
    await assert.rejects(() => fetchSecrets({ id: ID, endpoint: ENDPOINT, sign, base: relay.base }), re);
  assert.equal(relay.calls.length, 3, "each malformed answer is final, not retried");
});

test("a 409 right after our own claim tx is ledger lag, and is retried", async (t) => {
  // The relay re-reads the ledger fresh before it refuses, but our claim may still be unmined --
  // the one refusal class that does fix itself, so it gets the platform runner's backoff.
  const relay = await stubRelay((call, i) => i === 0
    ? { status: 409, body: { error: "not_lease_holder", message: "This endpoint does not hold the deployment's live lease." } }
    : { status: 200, body: { id: call.body.id, rev: 1, env: { API_TOKEN: "t" } } });
  t.after(relay.close);
  const got = await fetchSecrets({ id: ID, endpoint: ENDPOINT, sign, base: relay.base });
  assert.equal(got.count, 1);
  assert.equal(relay.calls.length, 2);
  assert.notEqual(relay.calls[1].body.ts, undefined);
  assert.notEqual(relay.calls[1].body.opSig, relay.calls[0].body.opSig, "re-signed per attempt, so a backoff cannot age the tuple out");
});

test("a relay without the secrets plane, and a box with no relay at all, inject nothing", async (t) => {
  const relay = await stubRelay(() => ({ status: 503, body: { error: "secrets_disabled", message: "Per-deployment secrets are not configured on this relay." } }));
  t.after(relay.close);
  const off = await fetchSecrets({ id: ID, endpoint: ENDPOINT, sign, base: relay.base });
  assert.equal(off.source, "disabled");
  assert.equal(off.count, 0);
  assert.equal(relay.calls.length, 1, "503 is authoritative: no retry");

  const none = await fetchSecrets({ id: ID, endpoint: ENDPOINT, sign, base: "" });
  assert.equal(none.source, "off");
  assert.equal(none.count, 0);
});

test("the request is checked before the key signs anything", async (t) => {
  await assert.rejects(() => fetchSecrets({ id: "dep_7", endpoint: ENDPOINT, sign, base: "http://127.0.0.1:1" }), /not a bytes32/);
  await assert.rejects(() => fetchSecrets({ id: ID, endpoint: "nucbox-k11", sign, base: "http://127.0.0.1:1" }), /registered http\(s\) origin/);
  await assert.rejects(() => fetchSecrets({ id: ID, endpoint: ENDPOINT, sign: null, base: "http://127.0.0.1:1" }), /no operator sign function/);
  // A broken sign function is caught here rather than at the relay, where it logs as "its
  // supervisor predates the per-enclave check" and sends an operator hunting a rollout problem.
  await assert.rejects(() => fetchSecrets({ id: ID, endpoint: ENDPOINT, sign: async () => "0xdead", base: "http://127.0.0.1:1" }),
    /65-byte personal_sign/);
});
