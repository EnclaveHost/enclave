// Referral codes (relay/referrals.mjs): what a host machine and a mobile-app install are recorded with, the first code
// sticking, and the admin report.
import test from "node:test";
import assert from "node:assert/strict";
import { createReferrals, referralCode } from "../relay/referrals.mjs";

const ADMIN = "admin-secret-token";
function call(r, method, path, { body, headers = {}, ip = "1.2.3.4" } = {}) {
  let status = 0, out = null;
  const req = { method, headers };
  const res = {};
  return r.route(req, res, new URL("https://api.example" + path), {
    json: (_res, s, b) => { status = s; out = b; }, ip,
    readJson: async () => { if (body instanceof Error) throw body; return body; },
  }).then((handled) => ({ handled, status, body: out }));
}
const id = (c) => c.repeat(32 / c.length);

test("a code is 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit", () => {
  for (const ok of ["steven", "ACME-2026", "a.b_c-d", "x".repeat(64)]) assert.equal(referralCode(` ${ok} `), ok);
  for (const bad of ["", "-lead", "has space", "x".repeat(65), "emoji😀", null, undefined, "a/b"]) assert.equal(referralCode(bad), null);
});

test("a host machine keeps its FIRST code; a different later code is kept beside it, never instead", () => {
  let t = Date.parse("2026-10-13T12:00:00Z");
  const r = createReferrals({ now: () => t });
  assert.equal(r.recordHost("nucbox-k11-4", "steven", { via: "attestation(hv-node)", operator: "0xabc" }), "recorded");
  t += 60_000;
  assert.equal(r.recordHost("nucbox-k11-4", "steven"), "existing");
  assert.equal(r.recordHost("nucbox-k11-4", "someone-else"), "kept-first");
  assert.equal(r.recordHost("metal0", "bad code"), null, "an invalid code records nothing");
  assert.equal(r.recordHost("", "steven"), null);
  const [e] = r.report().entries;
  assert.deepEqual({ ...e }, { key: "host:nucbox-k11-4", code: "steven", kind: "host", name: "nucbox-k11-4", via: "attestation(hv-node)",
    operator: "0xabc", firstSeenAt: "2026-10-13T12:00:00.000Z", lastSeenAt: "2026-10-13T12:01:00.000Z", laterCodes: ["someone-else"] });
});

test("a phone reports its code once per install; bad requests and floods are refused", async () => {
  const r = createReferrals();
  const ok = await call(r, "POST", "/v1/referrals", { body: { installId: id("a1"), code: "steven", platform: "android", app: "host.enclave.app" } });
  assert.deepEqual(ok, { handled: true, status: 200, body: { ok: true, outcome: "recorded" } });
  assert.equal((await call(r, "POST", "/v1/referrals", { body: { installId: id("a1"), code: "steven", platform: "android" } })).body.outcome, "existing");
  for (const body of [{ installId: id("a2"), code: "no spaces", platform: "android" }, { installId: "short", code: "x", platform: "android" },
                      { installId: id("a2"), code: "x", platform: "windows" }, new Error("not json")])
    assert.equal((await call(r, "POST", "/v1/referrals", { body, ip: "5.6.7.8" })).status, 400);
  assert.equal((await call(r, "GET", "/v1/referrals")).status, 405);
  const flood = createReferrals();
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await call(flood, "POST", "/v1/referrals", { body: { installId: id(i.toString(16).padStart(2, "0")), code: "x", platform: "ios" }, ip: "9.9.9.9" })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
  assert.equal(codes[10], 429, "ten from one address, then rate-limited");
});

test("the report needs the admin token and counts machines per code, hosts and phones apart", async () => {
  const r = createReferrals({ adminToken: ADMIN });
  r.recordHost("nucbox-k11-4", "steven"); r.recordHost("metal0", "steven"); r.recordHost("other-box", "acme");
  await call(r, "POST", "/v1/referrals", { body: { installId: id("b1"), code: "acme", platform: "android" } });
  assert.equal((await call(r, "GET", "/v1/admin/referrals")).status, 401);
  assert.equal((await call(r, "GET", "/v1/admin/referrals", { headers: { "x-admin-token": "wrong-token-of-another-len" } })).status, 401);
  const rep = await call(r, "GET", "/v1/admin/referrals", { headers: { "x-admin-token": ADMIN } });
  assert.equal(rep.status, 200);
  assert.deepEqual(rep.body.byCode, { steven: { hosts: 2, devices: 0 }, acme: { hosts: 1, devices: 1 } });
  assert.equal(rep.body.entries.length, 4);
  assert.equal((await call(createReferrals(), "GET", "/v1/admin/referrals", { headers: { "x-admin-token": "" } })).status, 503, "no token configured: no report");
  assert.equal((await call(r, "GET", "/v1/other")).handled, false);
});

test("a Linux host's operator key may report its machine's code: only the name's REGISTERED owner is believed", async () => {
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const { recoverMessageAddress } = await import("viem");
  const { referralMessage } = await import("../relay/referrals.mjs");
  const op = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  const owners = { metal0: op.address.toLowerCase() };
  const r = createReferrals({ ownerOf: async (n) => owners[n] || "", signerOf: (message, signature) => recoverMessageAddress({ message, signature }) });
  const post = async (name, code, who) => call(r, "POST", "/v1/referrals/host", { ip: "7.7.7.7",
    body: { name, code, signature: await who.signMessage({ message: referralMessage(name, code) }) } });
  assert.equal((await post("metal0", "steven", other)).status, 403, "not the owner");
  assert.equal((await post("unregistered-box", "steven", op)).status, 409, "a name nobody registered yet");
  const signedOther = await op.signMessage({ message: referralMessage("metal0", "acme") });
  assert.equal((await call(r, "POST", "/v1/referrals/host", { body: { name: "metal0", code: "steven", signature: signedOther } })).status, 403,
    "a signature over a different code proves nothing");
  assert.deepEqual((await post("metal0", "steven", op)).body, { ok: true, outcome: "recorded" });
  const [e] = r.report().entries;
  assert.equal(e.key, "host:metal0"); assert.equal(e.via, "operator-signature"); assert.equal(e.operator, op.address.toLowerCase());
  assert.equal((await call(r, "POST", "/v1/referrals/host", { body: { name: "metal0", code: "x" } })).status, 400);
});
