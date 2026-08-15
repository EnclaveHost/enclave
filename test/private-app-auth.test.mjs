// Private-app browser access (supervisor.js) — the token layer behind it.
//
// A private deployment is owner-only, and the owner's proof used to be a
// bearer header. A browser's top-level navigation cannot send one, so clicking
// a link to your own private app answered a bare 401 JSON blob. The fix adds a
// SECOND CARRIAGE for the same owner check — an app-origin cookie — and the
// whole safety of that rests on one crossing being impossible:
//
//   the cookie token and the control-plane session token are signed by the
//   SAME in-enclave ES256 key, with the same issuer and the same kid.
//
// Only the audience separates them. That token is handed to a page on a TENANT
// origin, so if it were also a control-plane session it would carry deployment
// listing, logs, secrets and every other `authed` route with it. Reading either
// verifier alone cannot show the crossing is closed — it takes both, which is
// what this file pins. Driven through the APPAUTH_SELFTEST seam, same contract
// as WAF_SELFTEST/TENANT_HEADERS_SELFTEST.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

const ID_A  = "0x" + "a".repeat(64);
const ID_B  = "0x" + "b".repeat(64);
const OWNER = "0x0b2d009c1f2a3b4c5d6e7f8091a2b3c4d5e6ee61";

async function selftest(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret",
           // never touch the real tmpfs path; a fresh key per run is fine
           SESSION_KEY_DIR: mkdtempSync(path.join(tmpdir(), "enc-appauth-")),
           APPAUTH_SELFTEST: JSON.stringify({ ids: [ID_A, ID_B], addrs: [OWNER], ...c }),
           WAF_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test("an app cookie opens its own deployment and no other", async () => {
  const r = await selftest({});
  // checksummed, like every other address the supervisor returns
  assert.equal(r.appForOwnId.toLowerCase(), OWNER);
  // a sibling deployment on this SAME enclave is signed by this same key: only
  // the audience refuses it
  assert.equal(r.appForOtherId, null);
});

test("an app cookie is NOT a control-plane session (no privilege escalation)", async () => {
  const r = await selftest({});
  // THE load-bearing assertion. If this ever returns an address, a token that
  // lives in a cookie on a tenant origin has become a full 7-day session for
  // /v1/deployments, /logs, /secrets and the rest.
  assert.equal(r.appAsSession, null);
});

test("a real session still verifies, and is not usable as an app cookie", async () => {
  const r = await selftest({});
  assert.equal(r.sessAsSession.toLowerCase(), OWNER);
  // the reverse crossing: a control-plane token names no audience, so it can
  // never be redeemed at the app-origin hand-off either
  assert.equal(r.sessAsApp, null);
});

test("the app cookie is stripped from the proxied request, the app's own kept", async () => {
  const r = await selftest({ cookies: [
    "enclave_app=TOK; sid=abc",          // ours plus a tenant's
    "sid=abc; enclave_app=TOK",          // order must not matter
    "  enclave_app=TOK  ",               // whitespace around the pair
    "sid=abc",                           // nothing of ours
    "",                                  // no cookie header at all
    "enclave_app_other=TOK; sid=abc",    // a PREFIX of our name is not our name
  ] });
  assert.deepEqual(r.cookies.map((c) => c.read), [["TOK"], ["TOK"], ["TOK"], [], [], []]);
  // what the tenant actually receives: never our pair, always its own
  assert.deepEqual(r.cookies.map((c) => c.kept),
    ["sid=abc", "sid=abc", "", "sid=abc", "", "enclave_app_other=TOK; sid=abc"]);
});

// `app.enclave.host` is not a public suffix, so a hostile tenant can set
// `enclave_app=junk; Domain=app.enclave.host` and have the browser deliver it to
// a VICTIM's app origin next to the real host-only cookie — ordered first, since
// RFC 6265 §5.4 sorts by longer path then earlier creation and the attacker
// picks both. Reading only the first pair turned that into a permanent lockout
// from a paid app. Every value must be considered, and none may reach the tenant.
test("a planted duplicate cookie cannot shadow the real one, or survive into the tenant", async () => {
  const r = await selftest({ cookies: [
    "enclave_app=PLANTED; enclave_app=REAL; sid=abc",
    "enclave_app=PLANTED; sid=abc; enclave_app=REAL",
  ] });
  assert.deepEqual(r.cookies[0].read, ["PLANTED", "REAL"]);
  assert.deepEqual(r.cookies[1].read, ["PLANTED", "REAL"]);
  assert.deepEqual(r.cookies.map((c) => c.kept), ["sid=abc", "sid=abc"]);
});

test("the hand-off sets a locked-down cookie, and only for a valid app token", async () => {
  const r = await selftest({ routes: [
    { url: "/__enclave/session", method: "POST", auth: "tok" },        // the happy path
    { url: "/__enclave/session?x=1", method: "POST", auth: "tok" },    // a query string must not defeat the match
    { url: "/__enclave/session", method: "POST", auth: "sess" },       // a CONTROL-PLANE token is not redeemable
    { url: "/__enclave/session", method: "POST" },                     // no credential at all
    { url: "/__enclave/session", method: "POST", auth: "tok",          // right token, deployment changed hands
      owner: "0x0000000000000000000000000000000000000001" },
  ] });
  assert.deepEqual(r.routes.map((x) => x.status), [204, 204, 401, 401, 401]);
  assert.deepEqual(r.routes.map((x) => x.set), ["set", "set", "", "", ""]);
  // Every attribute is load-bearing: HttpOnly keeps app JS out of it, Secure
  // keeps it off plaintext, and the ABSENCE of Domain= keeps it host-only
  // (never enclave.host, never a sibling). SameSite=STRICT is the one to guard
  // hardest: a cookie is ambient where the old bearer was not, so Lax would let
  // any site navigate an owner's browser into an authenticated GET on their
  // private app — and the tenant cannot defend itself, since we strip the
  // cookie before proxying and leave it nothing to gate on.
  assert.deepEqual(r.routes[0].attrs, ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]);
  assert.equal(r.routes[0].name, "enclave_app");
  assert.ok(!r.routes[0].attrs.some((a) => /^Domain=/i.test(a)), "cookie must be host-only");
});

test("sign-out clears the cookie, and unrelated paths fall through to the gate", async () => {
  const r = await selftest({ routes: [
    { url: "/__enclave/signout", method: "POST" },
    { url: "/__enclave/session", method: "GET" },       // the fragment-reader page
    { url: "/", method: "GET" },                        // the app's own traffic
    { url: "/__enclave/session", method: "DELETE" },    // an unhandled method
  ] });
  // handled=false means "not ours" - the request continues to the owner gate,
  // which is what keeps a tenant's own path space intact.
  assert.deepEqual(r.routes.map((x) => x.handled), [true, true, false, false]);
  assert.equal(r.routes[0].set, "cleared");
  assert.equal(r.routes[1].status, 200);
});

test("only a browser navigation gets HTML; every API caller keeps its JSON 401", async () => {
  const r = await selftest({ reqs: [
    { method: "GET", headers: { "sec-fetch-dest": "document" } },              // a real navigation
    { method: "GET", headers: { accept: "text/html,application/xhtml+xml" } }, // no Sec-Fetch: sniff Accept
    { method: "GET", headers: { "sec-fetch-dest": "empty",
                                accept: "text/html" } },                       // fetch() from a page: NOT a nav
    { method: "GET", headers: { accept: "*/*" } },                             // default fetch/curl
    { method: "GET", headers: {} },                                            // no hints at all
    { method: "POST", headers: { "sec-fetch-dest": "document" } },             // a form post is not a GET nav
  ] });
  assert.deepEqual(r.reqs, [true, true, false, false, false, false]);
});
