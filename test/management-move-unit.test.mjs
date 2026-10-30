// The move/release slice of the shared management table, pure (no network, no chain): the exact targets, the outcome
// classes of a release, and the two authorization rules (current lease for release, owner-named host for claimHint).
// The end-to-end path (actual supervisor, gateways, anvil) is test/cli-independent-move.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { MANAGEMENT_OPERATIONS, managementRoute, managementTarget, managementBody } from "../network/management-routes.mjs";
import { classifyManagementAnswer } from "../network/management-outcome.mjs";
import { decideAuthorization } from "../network/management-auth.mjs";
import { sessionKeyHash } from "../windows/node/session-api-auth.mjs";

const id = "0x" + "11".repeat(32), runner = "0x" + "22".repeat(32), other = "0x" + "33".repeat(32);
const vault = "0x" + "44".repeat(20), owner = "0x" + "55".repeat(20), operator = "0x" + "66".repeat(20);

test("release and claimHint are exact table entries; DELETE and every other spelling stay refused", () => {
  assert.equal(managementTarget("release", id), `/v1/deployments/${id}/release`);
  assert.equal(managementTarget("claimHint", id), `/v1/deployments/${id}/claim-hint`);
  assert.deepEqual([MANAGEMENT_OPERATIONS.release.scope, MANAGEMENT_OPERATIONS.release.mutation, MANAGEMENT_OPERATIONS.release.reauthorize],
    ["api.restart", true, false]);
  assert.deepEqual([MANAGEMENT_OPERATIONS.claimHint.scope, MANAGEMENT_OPERATIONS.claimHint.mutation, MANAGEMENT_OPERATIONS.claimHint.host],
    ["api.placement", false, "named"]);
  assert.equal(managementRoute("POST", `/v1/deployments/${id}/release`).op, "release");
  assert.equal(managementRoute("POST", `/v1/deployments/${id}/claim-hint`).op, "claimHint");
  for (const [m, t] of [["DELETE", `/v1/deployments/${id}`], ["GET", `/v1/deployments/${id}/release`], ["POST", `/v1/deployments/${id}/release?evacuate=1`],
    ["POST", `/v1/deployments/${id}/claim-hint/`], ["POST", "/v1/claim-hint"], ["POST", `/v1/deployments/${id}/Release`]])
    assert.equal(managementRoute(m, t), null, `${m} ${t}`);
  assert.equal(managementBody("release").length, 0);
  assert.throws(() => managementBody("release", { action: "stop" }), /no body/);
});

test("a release is succeeded only on the host's released statement; a stop or release it could not confirm is outcome-unknown", () => {
  const c = (status, json, forwarded = true) => classifyManagementAnswer("release", { status, forwarded, json, deploymentId: id }).kind;
  assert.equal(c(200, { id, released: true, status: "released" }), "ok");
  assert.equal(c(200, { id, released: false }), "unknown", "a 200 without the statement is not a success");
  assert.equal(c(200, { id: other, released: true }), "unknown");
  assert.equal(c(502, { code: "stop_unconfirmed", stopped: false }), "unknown", "the stop was attempted");
  assert.equal(c(503, { code: "release_unconfirmed", stopped: true }), "unknown");
  for (const code of ["not_releasable", "release_in_progress", "release_unavailable", "release_blocked", "not_current_runner", "unauthorized", "not_allowed"])
    assert.equal(c(409, { code }), "refused", code);
  // the supervisor's restart refusal while a release of the id is unresolved precedes any effect too
  assert.equal(classifyManagementAnswer("restart", { status: 409, forwarded: true, json: { code: "release_in_progress" }, deploymentId: id }).kind, "refused");
  assert.equal(c(409, { error: "release_in_progress" }, false), "refused", "the gateway's own refusal before forwarding");
  assert.equal(classifyManagementAnswer("release", { status: 200, forwarded: true, readError: new Error("cut"), deploymentId: id }).kind, "unknown");
  // a hint is advisory and idempotent: any failure is just a refusal, never "unknown"
  assert.equal(classifyManagementAnswer("claimHint", { status: 503, forwarded: true, json: { code: "not_claiming" }, deploymentId: id }).kind, "refused");
  assert.equal(classifyManagementAnswer("claimHint", { status: 200, forwarded: true, json: { accepted: false, reason: "x" }, deploymentId: id }).kind, "ok");
});

test("claimHint is authorized for an owner-named host that does NOT hold the lease; release only for the current holder", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }), x = Buffer.from(jwk.x, "base64url"), y = Buffer.from(jwk.y, "base64url");
  const now = Date.now(), parsed = { vault, x, y };
  const facts = (o = {}) => ({ schema: 16, timestamp: now - 1000,
    row: { id, owner: vault, runner: other, runnerOperator: operator, active: true, leaseUntil: String(Math.floor(now / 1000) + 600), ...o.row },
    host: { active: true, operator }, isVault: true, vaultOwner: owner, held: 2, delegation: { supported: false, granted: false },
    session: { keyHash: sessionKeyHash(x, y).toLowerCase(), actions: String((1n << 130n) | (1n << 133n) | (1n << 128n)), envs: 2,
      expiresAt: String(Math.floor(now / 1000) + 3600), live: true, ...o.session } });
  const decide = (f, scope, host) => decideAuthorization(f, { deploymentId: id, runner, scope, parsed, now, host });
  // the lease names ANOTHER runner: a hint to this host is allowed, a release from this host is not
  const hint = decide(facts(), "api.placement", "named");
  assert.equal(hint.ok, true, JSON.stringify(hint)); assert.ok(hint.freshUntil <= now - 1000 + 90000);
  const rel = decide(facts(), "api.restart", "lease");
  assert.deepEqual([rel.ok, rel.code, rel.cacheable], [false, "not_current_runner", "deployment"]);
  // with the lease on this runner, the release passes the gateway's rule
  assert.equal(decide(facts({ row: { runner } }), "api.restart", "lease").ok, true);
  // the named-host rule keeps every session rule: scope, liveness, holder; and refuses an inactive record
  assert.equal(decide(facts({ session: { actions: String(1n << 130n) } }), "api.placement", "named").code, "not_allowed");
  assert.equal(decide(facts({ session: { live: false } }), "api.placement", "named").code, "session_ended");
  assert.equal(decide(facts({ row: { owner: "0x" + "77".repeat(20) } }), "api.placement", "named").code, "not_allowed");
  const off = decide(facts({ row: { active: false } }), "api.placement", "named");
  assert.deepEqual([off.ok, off.code, off.cacheable], [false, "not_claimable", null], "never remembered as 'not ours'");
  // an expired lease is no obstacle to a hint (the record is open: exactly when a hint matters)
  assert.equal(decide(facts({ row: { leaseUntil: "0", runner: "0x" + "00".repeat(32) } }), "api.placement", "named").ok, true);
});
