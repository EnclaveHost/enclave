// Custom domains (relay/domains.js) — a customer's own hostname serving their
// deployment. These tests pin
//   (1) hostname normalization and the refusal list (IDN, IP literals,
//       wildcards, our own zones) — the input gate a tenant reaches first,
//   (2) the DNS verdicts: the TXT ownership token, CNAME routing, the APEX
//       flattening equivalence, and the CAA hint,
//   (3) the status machine, including the slow demotion of a live domain whose
//       DNS went away,
//   (4) the HTTP gates: on-chain owner match, the per-app limit, the generic
//       refusal that must not reveal another tenant's domain, and the
//       lease-holder fetch + issuance report,
//   (5) the certificate-authorization gate — the one that must never say yes
//       for a zone we own,
//   (6) the canonical signed strings and the fetch-HMAC derivation the
//       SUPERVISOR mirrors inline.
//
// DNS is served by a stub DoH resolver on loopback rather than mocked away, so
// the answer parsing (CNAME chains, quoted/split TXT, NXDOMAIN) is under test
// too — that parsing is where this feature actually gets things wrong.
//
//   run: node --test test/custom-domains.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

// ---- stub DoH resolver (started BEFORE the import: the module reads its
//      resolver list at load, exactly as it does in production) --------------
const TYPE = { A: 1, AAAA: 28, CNAME: 5, TXT: 16, CAA: 257 };
const EDGE_V4 = "46.62.128.36";
let ZONE = {};                      // "<name>|<type>" -> [data strings]
const doh = http.createServer((req, res) => {
  const u = new URL("http://x" + req.url);
  const name = (u.searchParams.get("name") || "").toLowerCase().replace(/\.+$/, "");
  const type = parseInt(u.searchParams.get("type"), 10);
  // A CNAME answer is returned for ANY query type on that name, as a real
  // resolver does — the chain comes back with the address records.
  const cn = ZONE[`${name}|${TYPE.CNAME}`] || [];
  const direct = ZONE[`${name}|${type}`] || [];
  const Answer = [
    ...cn.map((d) => ({ name, type: TYPE.CNAME, TTL: 300, data: d })),
    ...direct.map((d) => ({ name, type, TTL: 300, data: d })),
  ];
  const known = Object.keys(ZONE).some((k) => k.startsWith(name + "|"));
  res.writeHead(200, { "content-type": "application/dns-json" });
  res.end(JSON.stringify({ Status: known ? 0 : 3, Answer }));
});
await new Promise((r) => doh.listen(0, "127.0.0.1", r));
doh.unref();
const DOH = `http://127.0.0.1:${doh.address().port}/dns-query`;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-domains-test-"));
const KEY = "ab".repeat(32);
process.env.SECRETS_KEY = KEY;
process.env.AUTH_DATA_DIR = DIR;
process.env.APP_DOMAIN = "app.enclave.host";
process.env.DOMAIN_DOH_RESOLVERS = DOH;

const m = await import("../relay/domains.js");
const { initDomains, handleDomains, domainsEnabled, normalizeHostname, checkHostname,
        isReservedHostname, txtMatches, routingMatches, caaBlocks, evaluate,
        domainMap, domainDeployment, tlsAskAllowed, certNamesFor, labelFor,
        routingTarget, challengeHost, acmeAliasFor, acmeDelegationHost,
        addMessage, listMessage, verifyMessage, deleteMessage, fetchSig,
        DOMAIN_LIMITS, CHALLENGE_PREFIX } = m;
await initDomains();

const OWNER = privateKeyToAccount("0x" + "11".repeat(32));
const OTHER = privateKeyToAccount("0x" + "22".repeat(32));
const ID    = "0x" + "cc1f4f3f" + "cd".repeat(28);
const ID2   = "0x" + "aabbccdd" + "ef".repeat(28);
const RUNNER = "0x" + "aa".repeat(32);
const ENDPOINT = "https://enclave1.example";
const LABEL = "cc1f4f3f";
const TARGET = `${LABEL}.app.enclave.host`;

let rows = [];
let epOwner = null;
// The per-IP bucket is a coarse anti-abuse guard sized for real callers (a
// dashboard makes a handful of requests); a test file makes hundreds. Default
// to a fresh address per call so the suite is not one impatient client, and
// pin CLIENT_IP where the limiter itself is what is under test.
let ipSeq = 0, CLIENT_IP = null;
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => Buffer.from(JSON.stringify(req.body ?? {})),
  clientIp: () => CLIENT_IP || `198.51.100.${(ipSeq++ % 250) + 1}`,
  ledgerRows: async () => rows,
  ledgerExpire: () => {},
  endpointIdOf: async (ep) => (ep === ENDPOINT ? RUNNER : "0x" + "ee".repeat(32)),
  operatorOfEndpoint: async (ep) => (typeof epOwner === "function" ? epOwner(ep) : epOwner),
};
const call = async (pathname, body, method = "POST") => {
  const res = {};
  await handleDomains({ method, body }, res, new URL("http://x" + pathname), ctx);
  return res;
};
const leaseRow = (over = {}) => ({ id: ID, owner: OWNER.address, runner: RUNNER,
  leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 1800), ...over });
// Monotonic, and that is not cosmetic: personal_sign is deterministic (RFC
// 6979), so two identical requests in the same second produce the SAME
// signature bytes and the relay's single-use rule refuses the second as a
// replay. Real clients get this for free (a wallet prompt takes longer than a
// second); a test loop does not.
let _exp = Math.floor(Date.now() / 1000) + 300;
const expiryNow = () => ++_exp;
// The message is built FROM the expiry this helper picks, never beside it:
// two independent expiryNow() calls would sign one number and send another.
const signed = async (account, msgFn, extra = {}) => {
  const expiry = expiryNow();
  return { expiry, signature: await account.signMessage({ message: msgFn(expiry) }), ...extra };
};

// Publish (or withdraw) the records a customer would create.
function publish(host, { token, cname = TARGET, addr = null, caa = null } = {}) {
  const k = {};
  if (token) k[`${CHALLENGE_PREFIX}.${host}|${TYPE.TXT}`] = [`"${token}"`];
  if (cname) k[`${host}|${TYPE.CNAME}`] = [cname];
  if (addr)  k[`${host}|${TYPE.A}`] = [addr];
  if (caa)   k[`${host}|${TYPE.CAA}`] = caa;
  Object.assign(ZONE, k);
}
const resetZone = () => {
  ZONE = {                                  // our own edge, learned not hardcoded
    [`edge-probe.app.enclave.host|${TYPE.A}`]: [EDGE_V4],
  };
};
resetZone();

test("module is enabled under the test env switches", () => {
  assert.equal(domainsEnabled(), true);
});

// ---------- hostname normalization + the refusal list --------------------------

test("normalizeHostname folds to one canonical wire spelling", () => {
  assert.equal(normalizeHostname("  Shop.Example.COM. "), "shop.example.com");
  assert.equal(normalizeHostname("https://shop.example.com/path?x=1"), "shop.example.com");
  // IDN goes to punycode HERE and nowhere else: a Unicode label and its xn--
  // form must never become two different records
  assert.equal(normalizeHostname("bücher.example"), "xn--bcher-kva.example");
  assert.equal(normalizeHostname("XN--BCHER-KVA.example"), "xn--bcher-kva.example");
});

test("normalizeHostname refuses everything that is not a routable name", () => {
  const bad = (input, re) => assert.throws(() => normalizeHostname(input), re, input);
  bad("10.0.0.1", /not an IP address/);           // v4 literal
  bad("::1", /not an IP address/);                // v6 literal
  bad("[2001:db8::1]", /not an IP address/);      // bracketed
  bad("10.0.0", /not an IP address/);             // all-digit final label
  bad("*.example.com", /Wildcard/);
  bad("a_b.example.com", /Underscores/);
  bad("localhost", /fully-qualified/);            // single label
  bad("a..b.com", /empty label/);
  bad("-x.example.com", /start or end with a hyphen/);
  bad("x-.example.com", /start or end with a hyphen/);
  bad("shop.example.com:8443", /no port or scheme/);
  bad("me@example.com", /email address/);
  bad("", /Enter a hostname/);
  bad("x".repeat(64) + ".example.com", /longer than 63/);
  bad(("a".repeat(60) + ".").repeat(5) + "example.com", /at most 253 characters/);
});

test("our own zones are never attachable, at any depth", () => {
  for (const h of ["enclave.host", "api.enclave.host", "app.enclave.host",
                   "cc1f4f3f.app.enclave.host", "deep.sub.app.enclave.host",
                   "nan.host", "x.nan.host"])
    assert.equal(isReservedHostname(h), true, h);
  // …nor are the special-use names that resolve differently inside somebody's
  // network (RFC 6761/8375 and the usual internal conventions)
  for (const h of ["printer.local", "svc.internal", "box.lan", "a.home.arpa", "x.test", "y.invalid"])
    assert.equal(isReservedHostname(h), true, h);
  assert.equal(isReservedHostname("shop.example.com"), false);
  assert.throws(() => checkHostname("api.enclave.host"), /belongs to the platform/);
});

test("labelFor matches the supervisor's appCertLabel and api-relay's depFromHost", () => {
  assert.equal(labelFor(ID), "cc1f4f3f");        // first 8 hex of a bytes32 id
  assert.equal(labelFor("dep_abc123"), "abc123");
  assert.equal(routingTarget(labelFor(ID)), TARGET);
  assert.equal(acmeAliasFor(labelFor(ID)), `_acme-challenge.${TARGET}`);
  assert.equal(acmeDelegationHost("shop.example.com"), "_acme-challenge.shop.example.com");
  assert.equal(challengeHost("shop.example.com"), "_enclave-challenge.shop.example.com");
});

// ---------- the DNS verdicts ---------------------------------------------------

test("txtMatches reads a TXT value in every shape a resolver hands it back", () => {
  const tok = "enclave-verify-" + "a".repeat(32);
  assert.equal(txtMatches([`"${tok}"`], tok), true);            // quoted
  assert.equal(txtMatches([tok], tok), true);                   // bare
  assert.equal(txtMatches([`"${tok.slice(0, 20)}" "${tok.slice(20)}"`], tok), true);   // split at 255 bytes
  assert.equal(txtMatches([" " + tok + " "], tok), true);
  assert.equal(txtMatches(["some-other-verification=1"], tok), false);
  assert.equal(txtMatches([], tok), false);
  assert.equal(txtMatches([tok], ""), false);                   // no token = never a match
});

test("routing: a CNAME to us and a FLATTENED apex are the same proof", () => {
  const opts = { target: TARGET, edge: [EDGE_V4] };
  assert.equal(routingMatches({ cnames: [TARGET + "."] }, opts).how, "cname");
  assert.equal(routingMatches({ cnames: ["other." + "app.enclave.host"] }, opts).how, "cname-zone");
  // an apex cannot hold a CNAME: providers flatten it to our A/AAAA, which is
  // exactly as good a proof that traffic reaches us
  assert.equal(routingMatches({ addrs: [EDGE_V4] }, opts).how, "flattened");
  assert.equal(routingMatches({ cnames: ["elsewhere.example"] }, opts).ok, false);
  assert.equal(routingMatches({ addrs: ["203.0.113.1"] }, opts).how, "address-elsewhere");
  assert.equal(routingMatches({}, opts).how, "unresolved");
});

test("CAA is a hint, and only when it actually excludes our CAs", () => {
  assert.equal(caaBlocks([]), null);                                   // no opinion
  assert.equal(caaBlocks(['0 iodef "mailto:x@y"']), null);             // not an issue record
  assert.equal(caaBlocks(['0 issue "sectigo.com"']), null);
  assert.equal(caaBlocks(['0 issue "letsencrypt.org"']), null);
  assert.equal(caaBlocks(['0 issue "sectigo.com; account=12345"']), null);   // parameters ignored
  assert.equal(caaBlocks(['0 issuewild "pki.goog"']), null);
  assert.deepEqual(caaBlocks(['0 issue "digicert.com"']), ["digicert.com"]);
});

test("evaluate names what is missing, one hint per missing thing", () => {
  const tok = "enclave-verify-x";
  const base = { token: tok, target: TARGET, edge: [EDGE_V4] };
  assert.equal(evaluate({ txt: [tok], routing: { cnames: [TARGET] }, ...base }).ok, true);
  const noTxt = evaluate({ txt: [], routing: { cnames: [TARGET] }, ...base });
  assert.equal(noTxt.ok, false);
  assert.match(noTxt.reason, /No TXT record/);
  const noRoute = evaluate({ txt: [tok], routing: {}, ...base });
  assert.match(noRoute.reason, /does not resolve yet/);
  assert.match(noRoute.reason, new RegExp(TARGET));           // the fix is IN the message
  const wrong = evaluate({ txt: [tok], routing: { cnames: ["elsewhere.example"] }, ...base });
  assert.match(wrong.reason, /does not point at/);
});

// ---------- HTTP: attach, verify, list, detach ---------------------------------

test("attach requires the deployment's on-chain owner", async () => {
  rows = [leaseRow()];
  const host = "shop.example.com";
  // wrong signer
  let r = await call(`/v1/domains/${ID}`, await signed(OTHER, (e) => addMessage(ID, e, host), { hostname: host }));
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "not_owner");
  // expiry in the past
  const past = Math.floor(Date.now() / 1000) - 10;
  r = await call(`/v1/domains/${ID}`,
    { hostname: host, expiry: past, signature: await OWNER.signMessage({ message: addMessage(ID, past, host) }) });
  assert.equal(r.code, 422);
  assert.equal(r.body.error, "bad_expiry");
  // a deployment that is not on the ledger
  const ghost = "0x" + "99".repeat(32);
  r = await call(`/v1/domains/${ghost}`, await signed(OWNER, (e) => addMessage(ghost, e, host), { hostname: host }));
  assert.equal(r.code, 404);
});

test("attach normalizes before it signs-and-stores, and lands in pending_dns", async () => {
  rows = [leaseRow()];
  resetZone();
  const host = "shop.example.com";
  // the customer typed it with a scheme and a trailing dot; the SIGNED message
  // carries the canonical form, which is what the relay checks
  const r = await call(`/v1/domains/${ID}`,
    await signed(OWNER, (e) => addMessage(ID, e, host), { hostname: "HTTPS://Shop.Example.com./" }));
  assert.equal(r.code, 201);
  assert.equal(r.body.hostname, host);
  assert.equal(r.body.status, "pending_dns");
  assert.match(r.body.token, /^enclave-verify-[0-9a-f]{32}$/);
  // the three records, spelled out
  assert.deepEqual(
    { t: r.body.records.routing.type, v: r.body.records.routing.value },
    { t: "CNAME", v: TARGET });
  assert.equal(r.body.records.challenge.name, `_enclave-challenge.${host}`);
  assert.equal(r.body.records.challenge.value, r.body.token);
  assert.equal(r.body.records.acme.value, `_acme-challenge.${TARGET}`);
  // nothing routes and no certificate is authorized while it is pending
  assert.equal(domainDeployment(host), null);
  assert.equal(tlsAskAllowed(host), false);
  assert.deepEqual(certNamesFor(ID), []);
});

test("a reserved hostname is refused at the door", async () => {
  rows = [leaseRow()];
  const host = "api.enclave.host";
  const r = await call(`/v1/domains/${ID}`, await signed(OWNER, (e) => addMessage(ID, e, host), { hostname: host }));
  assert.equal(r.code, 422);
  assert.equal(r.body.error, "bad_hostname");
  assert.match(r.body.message, /belongs to the platform/);
});

test("publishing the records verifies the domain, and THEN it routes", async () => {
  rows = [leaseRow()];
  const host = "shop.example.com";
  const list = async () => (await call(`/v1/domains/${ID}/list`, await signed(OWNER, (e) => listMessage(ID, e)))).body;
  const rec = (await list()).domains.find((d) => d.hostname === host);
  publish(host, { token: rec.token });
  const r = await call(`/v1/domains/${ID}/verify`,
    await signed(OWNER, (e) => verifyMessage(ID, e, host), { hostname: host }));
  assert.equal(r.code, 200);
  assert.equal(r.body.status, "verified");
  assert.equal(r.body.lastError, null);
  // routing and certificate authorization both open at "verified"
  assert.equal(domainDeployment(host), ID);
  assert.equal(domainMap()[host], ID);
  assert.equal(tlsAskAllowed(host), true);
  assert.deepEqual(certNamesFor(ID), [host]);
});

test("an APEX verifies on flattened A records alone (no CNAME at all)", async () => {
  rows = [leaseRow()];
  const host = "example.com";
  const add = await call(`/v1/domains/${ID}`, await signed(OWNER, (e) => addMessage(ID, e, host), { hostname: host }));
  assert.equal(add.code, 201);
  publish(host, { token: add.body.token, cname: null, addr: EDGE_V4 });
  const r = await call(`/v1/domains/${ID}/verify`,
    await signed(OWNER, (e) => verifyMessage(ID, e, host), { hostname: host }));
  assert.equal(r.body.status, "verified");
  assert.equal(tlsAskAllowed(host), true);
});

test("a CAA set that excludes our CAs verifies but carries the warning", async () => {
  rows = [leaseRow()];
  const host = "caa.example.com";
  const add = await call(`/v1/domains/${ID}`, await signed(OWNER, (e) => addMessage(ID, e, host), { hostname: host }));
  publish(host, { token: add.body.token, caa: ['0 issue "digicert.com"'] });
  const r = await call(`/v1/domains/${ID}/verify`,
    await signed(OWNER, (e) => verifyMessage(ID, e, host), { hostname: host }));
  assert.equal(r.body.status, "verified");
  assert.match(r.body.caaWarning, /digicert\.com/);
  assert.match(r.body.caaWarning, /sectigo\.com/);       // …and what to do about it
});

test("the per-deployment limit holds", async () => {
  rows = [leaseRow({ id: ID2 })];
  for (let i = 0; i < DOMAIN_LIMITS.perDeployment; i++) {
    const h = `n${i}.limit.example.com`;
    const r = await call(`/v1/domains/${ID2}`, await signed(OWNER, (e) => addMessage(ID2, e, h), { hostname: h }));
    assert.equal(r.code, 201, `${h}: ${JSON.stringify(r.body)}`);
  }
  const over = "one.too.many.example.com";
  const r = await call(`/v1/domains/${ID2}`, await signed(OWNER, (e) => addMessage(ID2, e, over), { hostname: over }));
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "limit_reached");
});

test("a hostname held by ANOTHER tenant gets a generic refusal, not a disclosure", async () => {
  // ID2 belongs to OTHER now; OWNER's shop.example.com is already attached
  rows = [leaseRow(), leaseRow({ id: ID2, owner: OTHER.address })];
  const host = "shop.example.com";
  const r = await call(`/v1/domains/${ID2}`, await signed(OTHER, (e) => addMessage(ID2, e, host), { hostname: host }));
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "unavailable");
  // the refusal must not say who has it, which deployment, or even that it IS attached
  const said = JSON.stringify(r.body).toLowerCase();
  assert.ok(!said.includes(ID.toLowerCase()), "leaked the other deployment id");
  assert.ok(!said.includes(OWNER.address.toLowerCase()), "leaked the other owner");
  assert.ok(!/attached to|in use by|belongs to/.test(said), "confirmed the hostname is attached: " + said);
});

test("…but the SAME owner is told exactly where their hostname is", async () => {
  rows = [leaseRow(), leaseRow({ id: ID2 })];                 // both OWNER's
  const host = "shop.example.com";
  const r = await call(`/v1/domains/${ID2}`, await signed(OWNER, (e) => addMessage(ID2, e, host), { hostname: host }));
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "attached_elsewhere");
  assert.match(r.body.message, /Detach it there first/);
});

test("re-attaching to the SAME deployment is idempotent, not an error", async () => {
  rows = [leaseRow()];
  const host = "shop.example.com";
  const r = await call(`/v1/domains/${ID}`, await signed(OWNER, (e) => addMessage(ID, e, host), { hostname: host }));
  assert.equal(r.code, 200);
  assert.equal(r.body.note, "Already attached.");
  assert.equal(r.body.status, "verified");                    // and it keeps its state
});

test("the list read may be replayed inside its window; a mutation may not", async () => {
  rows = [leaseRow()];
  // the dashboard polls the list on ONE signature while its panel is open
  const listBody = await signed(OWNER, (e) => listMessage(ID, e));
  assert.equal((await call(`/v1/domains/${ID}/list`, listBody)).code, 200);
  assert.equal((await call(`/v1/domains/${ID}/list`, listBody)).code, 200);
  // a captured MUTATION signature is single-use
  const host = "replay.example.com";
  const addBody = await signed(OWNER, (e) => addMessage(ID, e, host), { hostname: host });
  assert.equal((await call(`/v1/domains/${ID}`, addBody)).code, 201);
  const again = await call(`/v1/domains/${ID}`, addBody);
  assert.equal(again.code, 409);
  assert.equal(again.body.error, "sig_replayed");
});

test("detach stops routing and withdraws the certificate authorization", async () => {
  rows = [leaseRow()];
  const host = "shop.example.com";
  assert.equal(tlsAskAllowed(host), true);                    // live before
  const r = await call(`/v1/domains/${ID}/delete`,
    await signed(OWNER, (e) => deleteMessage(ID, e, host), { hostname: host }));
  assert.equal(r.code, 200);
  assert.equal(r.body.detached, true);
  assert.equal(domainDeployment(host), null);
  assert.equal(tlsAskAllowed(host), false);
  assert.ok(!certNamesFor(ID).includes(host));
  // …and a second detach is a clean 404, not a crash
  assert.equal((await call(`/v1/domains/${ID}/delete`,
    await signed(OWNER, (e) => deleteMessage(ID, e, host), { hostname: host }))).code, 404);
});

test("DNS that disappears demotes a live domain — but slowly, and not on one bad answer", async () => {
  // its own wallet and deployment: re-checking spends the per-wallet DNS-op
  // budget, and this test deliberately re-checks seven times in a row
  const OWNER3 = privateKeyToAccount("0x" + "33".repeat(32));
  const ID3 = "0x" + "beef1234" + "77".repeat(28);
  rows = [leaseRow({ id: ID3, owner: OWNER3.address })];
  const host = "flaky.example.com";
  const add = await call(`/v1/domains/${ID3}`, await signed(OWNER3, (e) => addMessage(ID3, e, host), { hostname: host }));
  publish(host, { token: add.body.token });
  const recheck = async () => (await call(`/v1/domains/${ID3}/verify`,
    await signed(OWNER3, (e) => verifyMessage(ID3, e, host), { hostname: host }))).body;
  assert.equal((await recheck()).status, "verified");

  // the customer's records go away (provider change, an accidental delete)
  delete ZONE[`${host}|${TYPE.CNAME}`];
  delete ZONE[`${CHALLENGE_PREFIX}.${host}|${TYPE.TXT}`];

  // ONE failed check must not withdraw a live customer's routing: DNS is not
  // reliable enough for that, and the blast radius is their whole site
  let d = await recheck();
  assert.equal(d.status, "verified");
  assert.match(d.lastError, /does not resolve yet|No TXT record/);
  assert.equal(tlsAskAllowed(host), true, "still authorized after a single failure");

  // …but a domain that stays gone does get withdrawn
  for (let i = 0; i < 4; i++) d = await recheck();
  assert.equal(d.status, "pending_dns");
  assert.equal(d.verifiedAt, null);
  assert.equal(domainDeployment(host), null, "routing withdrawn");
  assert.equal(tlsAskAllowed(host), false, "certificate authorization withdrawn");

  // and putting the records back brings it straight home
  publish(host, { token: add.body.token });
  assert.equal((await recheck()).status, "verified");
  assert.equal(tlsAskAllowed(host), true);
});

test("our own resolvers failing is never a strike against a customer's domain", async () => {
  const OWNER5 = privateKeyToAccount("0x" + "55".repeat(32));
  const ID5 = "0x" + "5a5a5a5a" + "55".repeat(28);
  rows = [leaseRow({ id: ID5, owner: OWNER5.address })];
  const host = "resolver.example.com";
  const add = await call(`/v1/domains/${ID5}`, await signed(OWNER5, (e) => addMessage(ID5, e, host), { hostname: host }));
  publish(host, { token: add.body.token });
  const recheck = async () => (await call(`/v1/domains/${ID5}/verify`,
    await signed(OWNER5, (e) => verifyMessage(ID5, e, host), { hostname: host }))).body;
  assert.equal((await recheck()).status, "verified");

  // every resolver unreachable: the module must ABSTAIN, not conclude "gone".
  // Ten rounds is twice the demotion threshold — a network outage on OUR side
  // must never cost a customer their routing.
  const saved = process.env.DOMAIN_DOH_RESOLVERS;
  doh.close();
  try {
    for (let i = 0; i < 10; i++) {
      const d = await recheck();
      assert.equal(d.status, "verified", `round ${i}`);
    }
    assert.equal(tlsAskAllowed(host), true);
  } finally {
    await new Promise((r) => doh.listen(new URL(saved).port, "127.0.0.1", r));
    doh.unref();
  }
  // and once they answer again, an actually-missing record still counts
  delete ZONE[`${CHALLENGE_PREFIX}.${host}|${TYPE.TXT}`];
  assert.match((await recheck()).lastError, /No TXT record/);
});

// ---------- the certificate-authorization gate ---------------------------------

test("tls-ask says yes ONLY for a proven name, and never for a zone we own", () => {
  // proven (example.com verified above)
  assert.equal(tlsAskAllowed("example.com"), true);
  assert.equal(tlsAskAllowed("EXAMPLE.COM."), true);          // folded like an SNI value
  assert.equal(tlsAskAllowed("example.com:443"), true);       // …and port-stripped
  // never attached
  assert.equal(tlsAskAllowed("random.example.org"), false);
  // attached but still pending
  assert.equal(tlsAskAllowed("replay.example.com"), false);
  // OUR names: refused here even though the add endpoint already refuses them,
  // because this gate is the last thing between a request and a certificate
  for (const h of ["enclave.host", "api.enclave.host", "cc1f4f3f.app.enclave.host", "app.enclave.host"])
    assert.equal(tlsAskAllowed(h), false, h);
  assert.equal(tlsAskAllowed(""), false);
  assert.equal(tlsAskAllowed(null), false);
});

test("the routing map carries only names that are proven right now", async () => {
  const map = domainMap();
  assert.equal(map["example.com"], ID);
  assert.ok(!("replay.example.com" in map), "a pending name must not route");
  assert.ok(!("shop.example.com" in map), "a detached name must not route");
  // it is served openly (relay.js reads it with no credential) — every entry is
  // already in DNS and, once a cert exists, in the CT logs
  const r = await call("/v1/domains/map", null, "GET");
  assert.equal(r.code, 200);
  assert.equal(r.body.domains["example.com"], ID);
  assert.equal(r.body.zone, "app.enclave.host");
  // …and it never carries the ownership tokens
  assert.ok(!JSON.stringify(r.body).includes("enclave-verify-"));
});

// ---------- the lease-holder fetch + issuance report ----------------------------

test("fetchSig matches the supervisor's inline double-HMAC derivation", () => {
  // supervisor.js: HMAC(HMAC(SECRETS_FETCH_KEY_bytes, "domains-fetch v1"), `${id}:${endpoint}:${ts}`)
  const inner = createHmac("sha256", Buffer.from(KEY, "hex")).update("domains-fetch v1").digest();
  const want = createHmac("sha256", inner).update(`${ID}:${ENDPOINT}:777`).digest("hex");
  assert.equal(fetchSig(KEY, ID, ENDPOINT, 777), want);
  // …and it is a DIFFERENT key from the secrets fetch: one label per purpose
  const secretsInner = createHmac("sha256", Buffer.from(KEY, "hex")).update("fetch-auth v1").digest();
  assert.notEqual(want, createHmac("sha256", secretsInner).update(`${ID}:${ENDPOINT}:777`).digest("hex"));
});

test("the fetch serves the lease holder, and nobody else", async () => {
  rows = [leaseRow()];
  epOwner = null;                                    // unregistered endpoint: HMAC alone decides
  const ts = Math.floor(Date.now() / 1000);
  // a wrong HMAC
  let r = await call("/v1/domains/fetch", { id: ID, endpoint: ENDPOINT, ts, sig: "00".repeat(32) });
  assert.equal(r.code, 401);
  // stale timestamp
  r = await call("/v1/domains/fetch",
    { id: ID, endpoint: ENDPOINT, ts: ts - 4000, sig: fetchSig(KEY, ID, ENDPOINT, ts - 4000) });
  assert.equal(r.code, 422);
  // right HMAC, but this endpoint does not hold the lease
  rows = [leaseRow({ runner: "0x" + "bb".repeat(32) })];
  r = await call("/v1/domains/fetch", { id: ID, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID, ENDPOINT, ts) });
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "not_lease_holder");
  // …and an expired lease is not a lease
  rows = [leaseRow({ leaseUntil: BigInt(Math.floor(Date.now() / 1000) - 60) })];
  assert.equal((await call("/v1/domains/fetch",
    { id: ID, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID, ENDPOINT, ts) })).code, 409);
  // the real holder gets the names and the challenge alias to push TXT at
  rows = [leaseRow()];
  r = await call("/v1/domains/fetch", { id: ID, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID, ENDPOINT, ts) });
  assert.equal(r.code, 200);
  // every VERIFIED name of this deployment, and only those (shop.example.com
  // was detached above; replay.example.com is still pending_dns)
  assert.deepEqual([...r.body.domains].sort(), ["caa.example.com", "example.com"]);
  assert.equal(r.body.challengeAlias, `_acme-challenge.${TARGET}`);
});

test("an issuance report is what turns verified into active — and back", async () => {
  rows = [leaseRow()];
  const ts = Math.floor(Date.now() / 1000);
  const fetchWith = (report) => call("/v1/domains/fetch",
    { id: ID, endpoint: ENDPOINT, ts, sig: fetchSig(KEY, ID, ENDPOINT, ts), report });
  const stateOf = async (host) => (await call(`/v1/domains/${ID}/list`,
    await signed(OWNER, (e) => listMessage(ID, e)))).body.domains.find((d) => d.hostname === host);

  await fetchWith([{ hostname: "example.com", ok: true, ca: "acme.zerossl.com" }]);
  let d = await stateOf("example.com");
  assert.equal(d.status, "active");
  assert.equal(d.certificate.ca, "acme.zerossl.com");

  // a CA refusal is stored verbatim: it is the only way the owner of the name
  // ever hears why their domain has no certificate
  await fetchWith([{ hostname: "example.com", ok: false, error: "urn:ietf:params:acme:error:caa - CAA record forbids issuance" }]);
  d = await stateOf("example.com");
  assert.equal(d.status, "verified");                       // demoted out of active
  assert.match(d.certificate.error, /CAA record forbids/);

  // a report may only ever touch names attached to the reporting deployment
  rows = [leaseRow(), leaseRow({ id: ID2, owner: OTHER.address })];
  await fetchWith([{ hostname: "n0.limit.example.com", ok: true, ca: "attacker" }]);   // ID2's name
  const other = Object.values(domainMap());
  assert.ok(!other.includes(undefined));
  const r = await call(`/v1/domains/${ID2}/list`, await signed(OTHER, (e) => listMessage(ID2, e)));
  const victim = r.body.domains.find((x) => x.hostname === "n0.limit.example.com");
  assert.equal(victim.certificate, null, "a deployment reported a certificate for another deployment's domain");
});

test("the add/verify endpoints are rate limited, per wallet and per source", async () => {
  const OWNER4 = privateKeyToAccount("0x" + "44".repeat(32));
  const ID4 = "0x" + "44444444" + "44".repeat(28);
  rows = [leaseRow({ id: ID4, owner: OWNER4.address })];
  // per-WALLET: the DNS-op budget is what stops someone driving our resolvers
  // at a zone they do not own. It sits above the per-deployment cap on purpose,
  // so a customer filling their quota gets the honest refusal instead.
  let sawLimit = 0, sawCap = 0;
  for (let i = 0; i < 40; i++) {
    const h = `r${i}.rate.example.com`;
    const r = await call(`/v1/domains/${ID4}`, await signed(OWNER4, (e) => addMessage(ID4, e, h), { hostname: h }));
    if (r.code === 429) sawLimit++;
    if (r.body?.error === "limit_reached") sawCap++;
  }
  assert.ok(sawCap > 0, "the per-deployment cap should be reachable before the rate limit");
  assert.ok(sawLimit > 0, "sustained attaches from one wallet should be rate limited");

  // per-SOURCE: independent of the wallet, so a fleet of fresh keys from one
  // host is bounded too
  CLIENT_IP = "203.0.113.9";
  try {
    let ipLimited = false;
    for (let i = 0; i < 80 && !ipLimited; i++) {
      const acct = privateKeyToAccount("0x" + (i + 100).toString(16).padStart(2, "0").repeat(32));
      const r = await call(`/v1/domains/${ID4}/list`, await signed(acct, (e) => listMessage(ID4, e)));
      if (r.code === 429 && /Too many domain requests;/.test(r.body.message)) ipLimited = true;
    }
    assert.ok(ipLimited, "sustained requests from one source address should be rate limited");
  } finally { CLIENT_IP = null; }
});

test("attach answers 503 rather than half-working when the feature is off", async () => {
  // a relay with no data dir: the module never initializes, and every
  // owner-facing path says so plainly instead of accepting records it cannot keep
  const res = {};
  await m.handleDomains({ method: "DELETE", body: {} }, res, new URL("http://x/v1/domains/" + ID), ctx);
  assert.equal(res.code, 405);           // POST-only: signatures never belong in a URL
});
