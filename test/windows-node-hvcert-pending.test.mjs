// hvcert.mjs retry accounting with a fake clock: the certificate service's 202 (order in flight / paced / backing off,
// with its retry hint) is waited out at that hint and is NOT a failure; a genuine refusal still backs off 30 s doubling
// to an hour; success and a new partition instance reset. The errors are built by the real issuer() over a scripted
// request (the same objects ensureGuestCert rethrows unchanged); _ensure stands in for the partition round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHvCertPass, issuer, CERT_RETRY_BASE_MS } from "../windows/node/hvcert.mjs";

const DEP = "0x" + "ef".repeat(32), OWNER = "0x" + "11".repeat(20), APP = "a".repeat(64);
const INST = "hv" + "1".repeat(32), INST2 = "hv" + "2".repeat(32);
const PENDING = { ok: false, retryAfterSec: 30, why: "the relay is still getting it" };      // apptls.requestCert's 202
const BACKOFF = { ok: false, retryAfterSec: 240, why: "the relay is still getting it" };     // 202 "backoff after n failure(s)"
const REFUSED = { ok: false, error: "issue_failed", why: "No CA issued x: ACME 429" };       // 502, no hint
const EVIDENCE = { ok: false, error: "app_evidence_required", why: "not yet" };               // 403, no hint
const OK = { ok: true, certPem: "-----BEGIN CERTIFICATE-----" };

function harness() {
  let t = 1_000_000_000_000;
  const replies = [], logs = [];
  const issue = issuer({ endpoint: "https://node.example", sign: async () => "0x", request: async () => replies.shift() });
  const p = createHvCertPass({
    client: { get: async () => null }, dataAddr: "127.0.0.1:1", runtimeId: "0".repeat(64), endpoint: "https://node.example",
    sign: async () => "0x", served: (o) => o === OWNER, log: (m) => logs.push(m), now: () => t,
    _ensure: async () => {
      await issue("ef.app.enclave.host", "CSR", "spki");      // throws for every non-200 reply, exactly as in production
      return { key: "k".repeat(64), serial: "01", notAfter: t + 90 * 86400e3, renewAt: t + 60 * 86400e3, issuer: "test", verdict: "ok" };
    } });
  const recs = (instance = INST) => new Map([[DEP, { status: "running", isPublic: true, owner: OWNER, isolation: { instance, appId: APP } }]]);
  return {
    p, logs, recs,
    at: () => t,
    advance: (ms) => { t += ms; },
    async step(reply, instance) { replies.push(reply); await p.pass(recs(instance)); return p.state(DEP); },
    waitOf(st) { return st.backoffUntil - t; },
  };
}

test("ten 202 polls then one genuine refusal: the refusal waits 30 s (the first failure), not an hour", async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) {
    const st = await h.step(PENDING);
    assert.equal(st.failures, 0, "a 202 is not counted");
    assert.equal(h.waitOf(st), 30_000, "the service's own hint is honoured");
    h.advance(30_000);
  }
  const st = await h.step(REFUSED);
  assert.equal(st.failures, 1);
  assert.equal(h.waitOf(st), CERT_RETRY_BASE_MS, "first genuine failure -> 30 s");
});

test("genuine refusals still back off 30 s doubling to the one-hour cap, 202s in between neither count nor reset", async () => {
  const h = harness(), waits = [];
  for (let i = 0; i < 9; i++) {
    const st = await h.step(i % 2 ? EVIDENCE : REFUSED);
    waits.push(h.waitOf(st)); h.advance(h.waitOf(st));
    const mid = await h.step(PENDING);                         // a poll between refusals
    assert.equal(mid.failures, i + 1, "the count is kept across a 202");
    h.advance(h.waitOf(mid));
  }
  assert.deepEqual(waits, [30, 60, 120, 240, 480, 960, 1920, 3600, 3600].map((s) => s * 1000));
});

test("the service's retry hint is honoured for a 202 (clamped 5 s .. 1 h) and a refusal without one uses the backoff", async () => {
  const h = harness();
  let st = await h.step(BACKOFF);
  assert.equal(h.waitOf(st), 240_000); assert.equal(st.failures, 0);
  h.advance(240_000);
  st = await h.step({ ok: false, retryAfterSec: 99999, why: "paced" });
  assert.equal(h.waitOf(st), 3_600_000); assert.equal(st.failures, 0);
  h.advance(3_600_000);
  st = await h.step({ ok: false, retryAfterSec: 1, why: "paced" });
  assert.equal(h.waitOf(st), 5_000);
});

test("nothing is asked again before the backoff ends, for a 202 or a refusal", async () => {
  const h = harness();
  await h.step(REFUSED);
  h.advance(29_000);
  const before = h.p.state(DEP);
  await h.p.pass(h.recs());                                   // no scripted reply: an ask here would throw "no answer"
  assert.deepEqual(h.p.state(DEP), before);
});

test("success resets the count; a NEW partition instance starts from zero; a 202 after success keeps the installed record intact until due", async () => {
  const h = harness();
  await h.step(REFUSED); h.advance(30_000);
  await h.step(REFUSED); h.advance(60_000);
  let st = await h.step(OK);
  assert.equal(st.failures, undefined); assert.equal(st.instanceId, INST); assert.ok(st.renewAt > h.at());
  // a relaunch: another instance; its first refusal is a first failure (30 s), not a continuation
  st = await h.step(REFUSED, INST2);
  assert.equal(st.instanceId, INST2); assert.equal(st.failures, 1); assert.equal(h.waitOf(st), 30_000);
  // and on the old instance's count: a refusal after a 202 on a new instance still counts from that instance only
  h.advance(30_000); st = await h.step(PENDING, INST2);
  assert.equal(st.failures, 1);
});

test("only the issuer's structured 202 is exempt: other errors on the way (judge refusal, transport) still count", async () => {
  let t = 0;
  const p = createHvCertPass({ client: { get: async () => null }, dataAddr: "127.0.0.1:1", runtimeId: "0".repeat(64), endpoint: "x", sign: async () => "0x",
    served: () => true, now: () => t,
    _ensure: async () => { const e = new Error("the guest did not verify (reject: x); nothing issued"); e.retryMs = 30_000; throw e; } });
  const recs = new Map([[DEP, { status: "running", isPublic: true, owner: OWNER, isolation: { instance: INST, appId: APP } }]]);
  await p.pass(recs);
  assert.equal(p.state(DEP).failures, 1, "an error that is not the issuer's 202 is a failure even if it carries a delay");
  const iss = issuer({ endpoint: "x", sign: async () => "0x", request: async () => ({ ok: false, error: "issue_failed", retryAfterSec: 30, why: "x" }) });
  await assert.rejects(iss("n", "c", "k"), (err) => err.certPending === undefined && err.retryMs === 30_000, "an error WITH a hint is still a refusal");
});
