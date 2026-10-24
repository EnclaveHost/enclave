// Relay and custodian-probe modules against FAKE servers (no sockets, no network): message formats, metadata-only
// reads, and the refusal evaluations.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRelay, putMessage, getMessage, evalLegacyCheck, evalRelayRefusals, evalClearProof } from "../driver/relay.mjs";
import { evalNonce, evalStale, probeNonce, probeStale } from "../driver/probe.mjs";
import { commitmentOf } from "../driver/markers.mjs";

const REPO = process.env.CANARY_CLIENT_REPO || "/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2";
const C1 = "0x" + "c1".repeat(32);
const signer = { signMessage: async ({ message }) => "0x" + createHash("sha256").update(message).digest("hex") + "00".repeat(33) };
const resp = (status, body) => new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});

test("relay messages are byte-identical to the pinned relay/secrets.js formats", () => {
  const src = fs.readFileSync(path.join(REPO, "relay/secrets.js"), "utf8");
  assert.ok(src.includes('export const getMessage = (id, expiry) => `enclave-secrets:get:${id}:${expiry}`;'));
  assert.ok(src.includes('`enclave-secrets:put:${id}:${expiry}:${createHash("sha256").update(payload, "utf8").digest("hex")}`'));
  assert.equal(getMessage(C1, 5), `enclave-secrets:get:${C1}:5`);
  assert.equal(putMessage(C1, 5, '{"clear":true}'), `enclave-secrets:put:${C1}:5:${createHash("sha256").update('{"clear":true}').digest("hex")}`);
});

test("getMeta returns names, rev and an equality verdict — never the values", async () => {
  const values = { CANARY_A: "CANARY_20261023T000000Z_c2-legacy_" + "aa".repeat(32), CANARY_B: "CANARY_20261023T000000Z_c2-legacy_" + "bb".repeat(32) };
  const seen = [];
  const relay = createRelay({ api: "https://api.example", now: () => 1_000_000, fetchImpl: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return resp(200, { id: C1, rev: 3, names: Object.keys(values), env: values }); } });
  const meta = await relay.getMeta(C1, signer, { run: "20261023T000000Z", set: "c2-legacy", values });
  assert.deepEqual(meta, { status: 200, error: null, rev: 3, names: ["CANARY_A", "CANARY_B"], valuesEqualMarkers: true });
  assert.ok(!JSON.stringify(meta).includes("aaaa"));
  assert.equal(seen[0][0], `https://api.example/v1/secrets/${C1}/get`);
  assert.equal(seen[0][1].expiry, 1000 + 300);
  const wrong = await relay.getMeta(C1, signer, { run: "20261023T000000Z", set: "c2-legacy", values: { ...values, CANARY_B: values.CANARY_A } });
  assert.equal(wrong.valuesEqualMarkers, false);
  assert.throws(() => createRelay({ api: "http://api.example" }), /https/);
});

test("relay evaluations: legacy check, refusals for a held id, and the clear proof", () => {
  const meta = { status: 200, names: ["CANARY_A"], valuesEqualMarkers: true };
  assert.equal(evalLegacyCheck({ meta, exists: { exists: true, custody: false }, markerNames: ["CANARY_A"] }).outcome, "pass");
  assert.equal(evalLegacyCheck({ meta, exists: { exists: true, custody: true }, markerNames: ["CANARY_A"] }).outcome, "fail");
  assert.equal(evalRelayRefusals({ heldSet: { status: 409, error: "custody_held" }, strangerGet: { status: 403, names: [] }, exists: { custody: true } }).outcome, "pass");
  assert.equal(evalRelayRefusals({ heldSet: { status: 200, error: null }, strangerGet: { status: 403, names: [] }, exists: { custody: true } }).outcome, "fail");
  const proof = { ownerGet: { status: 200, names: [], rev: 0 }, hasIdOnRelayHost: false, markerSearch: { outcome: "pass" }, retentionListed: ["vm snapshot 10-20 (holds old ciphertext)"] };
  const r = evalClearProof(proof);
  assert.equal(r.outcome, "pass"); assert.match(r.evidence.limitation, /listed, not cleared/);
  assert.equal(evalClearProof({ ...proof, hasIdOnRelayHost: true }).outcome, "fail");
  assert.equal(evalClearProof({ ...proof, retentionListed: undefined }).outcome, "fail");
  assert.equal(evalClearProof({ ...proof, ownerGet: { status: 200, names: ["CANARY_A"] } }).outcome, "fail");
});

// A fake custodian with the real nonce semantics: consumed on first use, expiring after 120 s, checks in source order.
function fakeCustodian(cur, { now }) {
  const nonces = new Map();
  let n = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/challenge")) { const nonce = "0x" + (++n).toString(16).padStart(64, "0"); nonces.set(nonce, now() + 120); return resp(200, { encKey: "0x" + "ee".repeat(32), nonce, expiresAt: now() + 120 }); }
    const c = body.challenges[0];
    const exp = nonces.get(c.nonce); nonces.delete(c.nonce);
    if (!exp || exp <= now()) return resp(403, { error: "bad_challenge" });
    if (body.policyRev !== String(cur.policyRev) || body.secretRev !== String(cur.secretRev)) return resp(409, { error: "stale_revision" });
    if (body.committeeId !== cur.committeeId) return resp(409, { error: "wrong_committee" });
    if (body.epoch !== cur.epoch) return resp(409, { error: "stale_epoch" });
    return resp(403, { error: "unsupported_evidence" });
  };
}

test("nonce probe: the burnt nonce and the expired nonce are both bad_challenge; no partial anywhere", async () => {
  const cur = { id: C1, endpoint: "https://api.enclave.host/t/metal0", committeeId: "0x" + "47".repeat(32), epoch: 1, policyRev: 2n, secretRev: 2n };
  let t = 1000;
  const r = await probeNonce({ base: "https://c.example", cur, fetchImpl: fakeCustodian(cur, { now: () => t }), sleep: async (ms) => { t += ms / 1000; }, nowSec: () => t });
  assert.equal(r.outcome, "pass", JSON.stringify(r.evidence));
  assert.deepEqual([r.evidence.first.code, r.evidence.replay.code, r.evidence.expired.code], ["unsupported_evidence", "bad_challenge", "bad_challenge"]);
  // a custodian that accepted a replay, or that returned partials, fails the probe
  assert.equal(evalNonce({ first: { status: 403, keys: ["error"] }, replay: { status: 403, code: "unsupported_evidence", keys: ["error"] }, expired: { status: 403, code: "bad_challenge", keys: ["error"] } }).outcome, "fail");
  assert.equal(evalNonce({ first: { status: 200, keys: ["partials"] }, replay: { status: 403, code: "bad_challenge", keys: [] }, expired: { status: 403, code: "bad_challenge", keys: [] } }).outcome, "fail");
});

test("stale probe: older revisions, another committee and a future epoch are refused with their exact codes", async () => {
  const cur = { id: C1, endpoint: "https://api.enclave.host/t/metal0", committeeId: "0x" + "47".repeat(32), epoch: 1, policyRev: 2n, secretRev: 2n };
  const r = await probeStale({ base: "https://c.example", cur, fetchImpl: fakeCustodian(cur, { now: () => 1000 }), nowSec: () => 1000 });
  assert.equal(r.outcome, "pass", JSON.stringify(r.evidence));
  assert.match(r.evidence.scope, /NOT sealed-state anti-replay/);
  assert.equal(evalStale({ staleRevision: { status: 403, code: "unsupported_evidence", keys: [] }, wrongCommittee: { status: 409, code: "wrong_committee", keys: [] }, staleEpoch: { status: 409, code: "stale_epoch", keys: [] } }).outcome, "fail");
});
