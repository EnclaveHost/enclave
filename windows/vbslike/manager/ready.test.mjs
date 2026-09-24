// judgeReadyBody: the readiness answer judged as a DOCUMENT, not as a status code.
//
// These exist because of a measured trap (enclave-99, nucbox-k11, 2026-09-24): on an initrd with no
// /.well-known/enclave-ready route, the request fell through the proxy to the APP, which answered
// 200 with "Hello World!\n". Every one of these cases is a 200 that must NOT read as ready, or a
// non-200 that must be told apart from one that should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeReadyBody } from "./ready.mjs";

const APP = "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45";
const ok = (extra = {}) => JSON.stringify({ ready: true, appId: APP, ...extra });

test("THE TRAP: a 200 carrying the app's own answer is not readiness", () => {
  const r = judgeReadyBody(200, Buffer.from("Hello World!\n"), APP);
  assert.equal(r.ok, false);
  assert.equal(r.retry, false, "this is terminal: the guest has no readiness route, retrying cannot fix it");
  assert.match(r.reason, /not a readiness document/);
  assert.match(r.reason, /reached the APP/, "the reason says what actually happened, so nobody re-derives it");
});

test("a readiness document for this app is the only thing that reads as ready", () => {
  const r = judgeReadyBody(200, Buffer.from(ok()), APP);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test("a readiness document for ANOTHER app is refused", () => {
  const other = "d2c4dfc0".padEnd(64, "0");
  const r = judgeReadyBody(200, Buffer.from(JSON.stringify({ ready: true, appId: other })), APP);
  assert.equal(r.ok, false);
  assert.match(r.reason, /names app d2c4dfc0/);
});

test("ready:false is a retry; a missing or odd ready is not", () => {
  assert.equal(judgeReadyBody(200, Buffer.from(JSON.stringify({ ready: false, appId: APP })), APP).retry, true);
  const missing = judgeReadyBody(200, Buffer.from(JSON.stringify({ appId: APP })), APP);
  assert.equal(missing.ok, false);
  assert.equal(missing.retry, false, "a document that never says ready is not a thing to wait on");
});

test("503 is starting, and is the only status worth retrying", () => {
  const r = judgeReadyBody(503, Buffer.alloc(0), APP);
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
  assert.match(r.reason, /still starting/);
});

test("404 says the guest cannot report readiness at all, and does not read as 'not yet'", () => {
  const r = judgeReadyBody(404, Buffer.from("not found"), APP);
  assert.equal(r.ok, false);
  assert.equal(r.retry, false, "an app that 404s unknown paths would otherwise never become ready");
  assert.match(r.reason, /no \/\.well-known\/enclave-ready route/);
});

test("other statuses are failures that quote what came back", () => {
  assert.match(judgeReadyBody(500, Buffer.from("boom"), APP).reason, /answered 500/);
  assert.match(judgeReadyBody(302, Buffer.alloc(0), APP).reason, /answered 302/);
});

test("a 200 whose body is valid JSON but not an object is refused", () => {
  for (const body of ["null", '"ready"', "[1,2]", "true"]) {
    const r = judgeReadyBody(200, Buffer.from(body), APP);
    assert.equal(r.ok, false, `${body} must not read as ready`);
  }
});

test("appId matching is case-insensitive but not prefix-loose", () => {
  assert.equal(judgeReadyBody(200, Buffer.from(ok({ appId: APP.toUpperCase() })), APP).ok, true);
  assert.equal(judgeReadyBody(200, Buffer.from(ok({ appId: APP.slice(0, 8) })), APP).ok, false,
    "a prefix is not the appId");
});
