// Custom domains on the VBS box: the hostnames a customer attached to their deployment.
//
// The FAILURE SEMANTICS are what this file is mostly about, because they are asymmetric and
// getting them backwards takes a paying customer's site down. Mirrored from the platform runner
// (supervisor.js fetchDepDomains):
//
//   * 503 (a relay without the feature) and 404 (the deployment is not on its ledger view) are
//     AUTHORITATIVE "no custom domains" and clear the list;
//   * anything else - a timeout, a 5xx, a wire error, a refused signature - KEEPS the last known
//     list, because a relay blip must not withdraw a live customer's certificate or stop their
//     app answering on their own name.
//
// That is the opposite of the secrets fetch, where a refusal throws, and deliberately so: there,
// launching without secrets is a silent misconfiguration; here, forgetting a hostname is an outage.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchDomains } from "../windows/node/domains.mjs";

const ID = "0x" + "ab".repeat(32);
const EP = "https://api.enclave.host/t/test";
const SIG = "0x" + "11".repeat(65);
const sign = async () => SIG;

/** A stand-in relay that answers however the test wants, and records what it was sent. */
async function relay(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    let body = {}; try { body = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {}
    seen.push({ url: req.url, body });
    handler(req, res, body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen,
           close: () => new Promise((r) => server.close(r)) };
}
const json = (res, status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

test("the fetch is signed by the operator over the relay's exact tuple", async () => {
  const r = await relay((_q, res) => json(res, 200, { domains: ["shop.example.com"] }));
  try {
    const out = await fetchDomains({ id: ID, endpoint: EP + "/", sign, base: r.base });
    assert.deepEqual(out.hosts, ["shop.example.com"]);
    assert.equal(r.seen[0].url, "/v1/domains/fetch");
    const b = r.seen[0].body;
    assert.equal(b.id, ID.toLowerCase());
    // The trailing slash is stripped BEFORE signing: the relay strips what it verifies, so signing
    // the unstripped spelling recovers the right key over the wrong message and returns 403.
    assert.equal(b.endpoint, EP, "the endpoint must be the stripped form the relay verifies");
    assert.equal(b.opSig, SIG);
    assert.ok(Math.abs(Date.now() / 1000 - b.ts) < 30, "and a fresh timestamp");
  } finally { await r.close(); }
});

test("503 and 404 are authoritative: the list is cleared", async () => {
  for (const status of [503, 404]) {
    const r = await relay((_q, res) => json(res, status, { error: "nope" }));
    try {
      const out = await fetchDomains({ id: ID, endpoint: EP, sign, base: r.base,
                                       previous: ["old.example.com"] });
      assert.deepEqual(out.hosts, [], `HTTP ${status} means no custom domains, not "ask again"`);
      assert.equal(out.source, "none");
    } finally { await r.close(); }
  }
});

test("a 5xx or a timeout KEEPS the last known list", async () => {
  const r = await relay((_q, res) => json(res, 500, { error: "boom" }));
  try {
    const out = await fetchDomains({ id: ID, endpoint: EP, sign, base: r.base,
                                     previous: ["shop.example.com", "www.shop.example.com"] });
    assert.deepEqual(out.hosts, ["shop.example.com", "www.shop.example.com"],
      "a relay blip must not withdraw a live customer's certificate");
    assert.equal(out.source, "kept");
  } finally { await r.close(); }
});

test("an unreachable relay keeps the list too", async () => {
  const out = await fetchDomains({ id: ID, endpoint: EP, sign, base: "http://127.0.0.1:1",
                                   previous: ["shop.example.com"] });
  assert.deepEqual(out.hosts, ["shop.example.com"]);
  assert.equal(out.source, "kept");
});

test("a refused signature keeps the list and says which machine to look at", async () => {
  const r = await relay((_q, res) => json(res, 401, { error: "bad_fetch_sig", message: "no valid signature" }));
  try {
    const out = await fetchDomains({ id: ID, endpoint: EP, sign, base: r.base, previous: ["a.example"] });
    assert.deepEqual(out.hosts, ["a.example"]);
    assert.match(out.why, /clock/, "a 401 here is usually this box's clock, and the operator fixes it here");
  } finally { await r.close(); }
});

test("only usable hostnames survive, deduplicated and bounded", async () => {
  const r = await relay((_q, res) => json(res, 200, { domains: [
    "Shop.Example.COM.", "shop.example.com", "has space.example", "", "ok2.example",
    "x".repeat(300) + ".example", 42, null, "singlelabel", "-bad.example", "a..b.example",
  ] }));
  try {
    const out = await fetchDomains({ id: ID, endpoint: EP, sign, base: r.base });
    assert.deepEqual(out.hosts, ["shop.example.com", "ok2.example"],
      "lowercased, the root dot dropped, duplicates collapsed, junk refused");
    // The two that caught a real bug: `String(42)` is "42" and `String(null)` is "null", and both
    // sail through a bare character class. A relay answering with a number would otherwise have
    // had this box ask a CA to certify "42".
    assert.ok(!out.hosts.includes("42") && !out.hosts.includes("null"));
  } finally { await r.close(); }
});

test("the issuance report rides along and is only cleared once it is taken", async () => {
  const r = await relay((_q, res) => json(res, 200, { domains: ["a.example"] }));
  try {
    const report = [{ hostname: "a.example", ok: false, error: "issue_failed", message: "CA said no" }];
    const out = await fetchDomains({ id: ID, endpoint: EP, sign, base: r.base,
                                     previous: ["a.example"], report });
    assert.deepEqual(r.seen[0].body.report, report, "the customer's only way to learn a CA refused them");
    assert.deepEqual(out.delivered, ["a.example"]);
  } finally { await r.close(); }
  // ...and a fetch that FAILED delivers nothing, so the report is retried rather than lost.
  const bad = await fetchDomains({ id: ID, endpoint: EP, sign, base: "http://127.0.0.1:1",
                                   previous: ["a.example"], report: [{ hostname: "a.example", ok: false }] });
  assert.deepEqual(bad.delivered, []);
});

test("no relay configured is not an error, and signs nothing", async () => {
  let asked = false;
  const out = await fetchDomains({ id: ID, endpoint: EP, sign: async () => { asked = true; return SIG; }, base: "" });
  assert.deepEqual(out.hosts, []);
  assert.equal(out.source, "off");
  assert.equal(asked, false, "a signature is a commitment; do not make one with nowhere to send it");
});

test("a malformed id or endpoint is refused before anything is signed", async () => {
  let asked = false;
  const s = async () => { asked = true; return SIG; };
  await assert.rejects(() => fetchDomains({ id: "nope", endpoint: EP, sign: s, base: "http://x" }), /bytes32/);
  await assert.rejects(() => fetchDomains({ id: ID, endpoint: "not-a-url", sign: s, base: "http://x" }), /registered http/);
  assert.equal(asked, false, "signing tuples built from junk is how a key ends up over a message nobody audited");
});
