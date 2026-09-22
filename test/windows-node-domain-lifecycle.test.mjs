// What the GUEST actually receives, and what a socket can still be told, as a deployment's
// hostnames appear, change and move. Driven through production code: refreshDomains, appEnvFor,
// zoneRules and forgetDomains, never a reimplementation of them.
//
// Three things an audit correctly said were untested:
//   1. COLD START. ENCLAVE_HOSTS is built when the app launches. If the names are only learned on
//      a later tick, every freshly started guest gets a list missing the domain its owner attached.
//   2. LIVE ATTACH / DETACH. What happens to the running guest, and what happens to TLS.
//   3. REASSIGNMENT. Certificates are keyed by hostname across the whole box, so a name moving
//      from one deployment to another must stop resolving for the old one AT HANDSHAKE TIME - not
//      whenever the connection happened to be set up.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host } from "../windows/node/host.mjs";
import { selfSigned } from "../windows/node/apptls.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-life-"));
const A = "0x" + "aa".repeat(32), B = "0x" + "bb".repeat(32);
const SIG = "0x" + "11".repeat(65);

/** A stand-in relay whose answer the test changes between ticks. */
async function relay(nextHosts) {
  const server = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    const body = JSON.parse(Buffer.concat(c).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ domains: nextHosts(body.id) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A Host that will talk to that relay, with certificate issuance stubbed to succeed. */
function box(base) {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                       appZone: "app.enclave.host", customDomains: true,
                       relayBase: base, secretsSign: async () => SIG,
                       // The CA is stubbed; EVERYTHING ELSE - the ownership stamp, the global
                       // index, the teardown rules - is production code doing its own bookkeeping.
                       issueCert: async ({ hostname }) => {
                         const c = selfSigned(hostname);
                         return { name: hostname, key: c.key, cert: c.cert,
                                  notAfter: new Date(Date.now() + 90 * 864e5).toISOString() };
                       } });
  return h;
}

const dep = { gpuMilli: 0 };
const ver = { config: "{}" };
const envOf = (h, id) => h.appEnvFor(id, dep, ver, { memMb: 128, config: "{}" });

test("COLD START: the guest's ENCLAVE_HOSTS already carries the attached domain", async () => {
  const r = await relay((id) => (id === A.toLowerCase() ? ["shop.example.com"] : []));
  try {
    const h = box(r.base);
    h.records.set(A, { id: A, status: "provisioning", appHost: "aaaaaaaa.app.enclave.host" });
    // Before the names are known, the guest would be told only its own subdomain...
    assert.equal(envOf(h, A).ENCLAVE_HOSTS, "aaaaaaaa.app.enclave.host");
    // ...which is exactly why the launch path fetches FIRST. `forLaunch` is what makes this work
    // while the record still says "provisioning".
    await h.refreshDomains(A, { forLaunch: true });
    assert.equal(envOf(h, A).ENCLAVE_HOSTS, "aaaaaaaa.app.enclave.host,shop.example.com",
      "a cold-started guest must not be missing the domain its owner attached");
  } finally { await r.close(); }
});

test("a provisioning record is NOT refreshed by the ordinary tick, only by the launch", async () => {
  const r = await relay(() => ["late.example.com"]);
  try {
    const h = box(r.base);
    h.records.set(A, { id: A, status: "provisioning", appHost: "aaaaaaaa.app.enclave.host" });
    await h.refreshDomains(A);                       // the tick's call
    assert.deepEqual(h.domains.get(A), undefined, "the tick leaves a launching record alone");
    await h.refreshDomains(A, { forLaunch: true });
    assert.deepEqual(h.domains.get(A), ["late.example.com"]);
  } finally { await r.close(); }
});

test("LIVE ATTACH: TLS serves the new name at once; the guest's copy waits for a restart", async () => {
  let hosts = [];
  const r = await relay(() => hosts);
  try {
    const h = box(r.base);
    h.records.set(A, { id: A, status: "running", appHost: "aaaaaaaa.app.enclave.host" });
    await h.refreshDomains(A);
    const before = envOf(h, A).ENCLAVE_HOSTS;
    assert.equal(before, "aaaaaaaa.app.enclave.host");
    assert.equal(h.zoneRules(A).contextFor("shop.example.com"), null);

    hosts = ["shop.example.com"];                    // the owner attaches it
    await h.refreshDomains(A);
    // TLS is live immediately - that is what a customer pointing DNS at us needs.
    assert.ok(h.zoneRules(A).contextFor("shop.example.com"), "the new name is servable at once");
    // The guest's environment is a LAUNCH-TIME SNAPSHOT, here and on a platform box alike
    // (supervisor.js builds ENCLAVE_HOSTS in launchSpec and never revisits it). The next start
    // picks it up; nothing restarts a tenant's app because a DNS record appeared.
    assert.equal(envOf(h, A).ENCLAVE_HOSTS, "aaaaaaaa.app.enclave.host,shop.example.com",
      "and the NEXT launch would carry it");
  } finally { await r.close(); }
});

test("LIVE DETACH: the name stops being servable and its key is dropped", async () => {
  let hosts = ["shop.example.com"];
  const r = await relay(() => hosts);
  try {
    const h = box(r.base);
    h.records.set(A, { id: A, status: "running", appHost: "aaaaaaaa.app.enclave.host" });
    await h.refreshDomains(A);
    assert.ok(h.zoneRules(A).contextFor("shop.example.com"));

    hosts = [];                                      // the owner detaches it
    await h.refreshDomains(A);
    assert.equal(h.zoneRules(A).contextFor("shop.example.com"), null, "it stops being served");
    assert.equal(h.hostCerts.has("shop.example.com"), false, "and its key does not linger on the box");
    assert.equal(h.domainOwner.has("shop.example.com"), false);
    assert.equal(envOf(h, A).ENCLAVE_HOSTS, "aaaaaaaa.app.enclave.host");
  } finally { await r.close(); }
});

test("REASSIGNMENT: a rules object made BEFORE the move cannot serve the name after it", async () => {
  // The hazard the live index exists for. `contextFor` used to close over the ownership array as
  // it was when the connection was resolved, and a client may sit between that moment and its
  // ClientHello for as long as it likes - long enough for the name to move to another tenant and
  // for its certificate to be the one this box holds.
  const owner = { [A.toLowerCase()]: ["moving.example.com"], [B.toLowerCase()]: [] };
  const r = await relay((id) => owner[id] || []);
  try {
    const h = box(r.base);
    for (const id of [A, B]) h.records.set(id, { id, status: "running", appHost: `${id.slice(2, 10)}.app.enclave.host` });
    await h.refreshDomains(A);
    await h.refreshDomains(B);

    // A connection for A resolves its rules HERE, while A still owns the name.
    const stale = h.zoneRules(A);
    assert.ok(stale.contextFor("moving.example.com"), "A owns it at this moment");

    // The name moves to B before that connection's ClientHello arrives.
    owner[A.toLowerCase()] = [];
    owner[B.toLowerCase()] = ["moving.example.com"];
    await h.refreshDomains(A);
    await h.refreshDomains(B);

    assert.equal(stale.contextFor("moving.example.com"), null,
      "the OLD owner's rules object must not serve a name that has moved");
    assert.ok(h.zoneRules(B).contextFor("moving.example.com"), "and the new owner serves it");
    assert.equal(h.domainOwner.get("moving.example.com"), B.toLowerCase());
  } finally { await r.close(); }
});

test("a reassigned name survives the OLD deployment's teardown", async () => {
  // forgetDomains runs when a lease goes. It must not take out a name that now belongs to somebody
  // else - which is why it only releases a hostname the departing deployment still owns.
  const owner = { [A.toLowerCase()]: ["moving.example.com"], [B.toLowerCase()]: [] };
  const r = await relay((id) => owner[id] || []);
  try {
    const h = box(r.base);
    for (const id of [A, B]) h.records.set(id, { id, status: "running", appHost: `${id.slice(2, 10)}.app.enclave.host` });
    await h.refreshDomains(A);
    owner[A.toLowerCase()] = []; owner[B.toLowerCase()] = ["moving.example.com"];
    await h.refreshDomains(B);
    assert.equal(h.domainOwner.get("moving.example.com"), B.toLowerCase());

    // A's record still lists it (its own next refresh has not run). Its teardown must leave B's.
    h.domains.set(A, ["moving.example.com"]);
    h.forgetDomains(A);                              // THE PRODUCTION CLEANUP
    assert.equal(h.domainOwner.get("moving.example.com"), B.toLowerCase(),
      "the departing deployment must not evict a name that has been reassigned");
    assert.ok(h.zoneRules(B).contextFor("moving.example.com"), "B keeps serving it");
  } finally { await r.close(); }
});

test("losing a lease drops that deployment's names through the production cleanup", async () => {
  const r = await relay(() => ["gone.example.com"]);
  try {
    const h = box(r.base);
    h.records.set(A, { id: A, status: "running", appHost: "aaaaaaaa.app.enclave.host" });
    await h.refreshDomains(A);
    h.certReports.set("gone.example.com", { ok: false });
    assert.ok(h.hostCerts.has("gone.example.com"));

    h.forgetDomains(A);                              // what #stopApp and #giveUp both call
    assert.equal(h.hostCerts.has("gone.example.com"), false, "no key answering for a name we lost");
    assert.equal(h.certReports.has("gone.example.com"), false);
    assert.equal(h.domainOwner.has("gone.example.com"), false);
    assert.deepEqual(h.domains.get(A), undefined);
    assert.equal(h.zoneRules(A).contextFor("gone.example.com"), null);
  } finally { await r.close(); }
});

test("A STALE CACHE NEVER RECLAIMS A NAME THAT HAS MOVED", async () => {
  // The audit's second finding. `source: "kept"` is this box's own cache, returned because the
  // relay could not be reached. It keeps the app answering, which is the point - but it is not
  // NEWS, and writing it into the ownership index let A take back a name B already held: A loses
  // it, B takes it, A's next fetch FAILS, and A's stale list put A back in the index and started
  // re-issuing a certificate for a name it no longer owned.
  const owner = { [A.toLowerCase()]: ["moving.example.com"], [B.toLowerCase()]: [] };
  const r = await relay((id) => owner[id] || []);
  let closed = false;
  try {
  const h = box(r.base);
  for (const id of [A, B]) h.records.set(id, { id, status: "running", appHost: `${id.slice(2, 10)}.app.enclave.host` });
  await h.refreshDomains(A);
  const oldA = h.zoneRules(A);
  assert.ok(oldA.contextFor("moving.example.com"), "A owns it to begin with");

  owner[A.toLowerCase()] = []; owner[B.toLowerCase()] = ["moving.example.com"];
  await h.refreshDomains(B);
  await r.close(); closed = true;
  assert.equal(h.domainOwner.get("moving.example.com"), B.toLowerCase());

  // Now A refreshes and the relay is gone. Its cached list still names the domain.
  h.cfg.relayBase = "http://127.0.0.1:1";
  await h.refreshDomains(A);
  assert.equal(h.domainOwner.get("moving.example.com"), B.toLowerCase(),
    "a cache must never override newer authoritative knowledge");
  assert.equal(oldA.contextFor("moving.example.com"), null, "A still cannot serve it");
  assert.equal(h.zoneRules(A).contextFor("moving.example.com"), null);
  assert.ok(h.zoneRules(B).contextFor("moving.example.com"), "and B is undisturbed");
  assert.equal(h.hostCerts.get("moving.example.com")?.owner, B.toLowerCase(),
    "nor was a certificate re-issued under A's name");
  } finally { if (!closed) await r.close(); }
});

test("an issuance that lands AFTER the name moves is discarded", async () => {
  // An ACME order can take minutes and a name can move underneath it. A result that arrives late
  // must not be stored: it would put a certificate obtained on A's behalf under a name B owns and
  // set the entry's owner back to A.
  //
  // Self-contained rather than built on the shared helpers, and only A's order is held. Holding
  // BOTH deadlocks: B could never finish, so the move could never happen, so A could never be
  // released. An audit caught that hang and was right that it was the test, not the code.
  const owner = { [A.toLowerCase()]: ["slow.example.com"], [B.toLowerCase()]: [] };
  const srv = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    const body = JSON.parse(Buffer.concat(c).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ domains: owner[body.id] || [] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  let release = () => {};
  const held = new Promise((res) => { release = res; });
  let slowA = Promise.resolve();
  try {
    const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                         appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                         appZone: "app.enclave.host", customDomains: true,
                         relayBase: `http://127.0.0.1:${srv.address().port}`,
                         secretsSign: async () => SIG,
                         issueCert: async ({ id, hostname }) => {
                           if (String(id).toLowerCase() === A.toLowerCase()) await held;
                           const c = selfSigned(hostname);
                           return { name: hostname, key: c.key, cert: c.cert,
                                    notAfter: new Date(Date.now() + 90 * 864e5).toISOString() };
                         } });
    for (const id of [A, B]) h.records.set(id, { id, status: "running", appHost: `${id.slice(2, 10)}.app.enclave.host` });

    slowA = h.refreshDomains(A);                    // A starts asking for a certificate...
    await new Promise((res) => setTimeout(res, 50));
    owner[A.toLowerCase()] = []; owner[B.toLowerCase()] = ["slow.example.com"];
    await h.refreshDomains(B);                      // ...the name moves to B while it is in flight
    assert.equal(h.domainOwner.get("slow.example.com"), B.toLowerCase());
    release();                                      // ...and A's order finally completes
    await slowA;

    assert.equal(h.domainOwner.get("slow.example.com"), B.toLowerCase());
    assert.equal(h.hostCerts.get("slow.example.com")?.owner, B.toLowerCase(),
      "A's late result must not overwrite B's entry");
    assert.equal(h.zoneRules(A).contextFor("slow.example.com"), null);
    assert.ok(h.zoneRules(B).contextFor("slow.example.com"));
  } finally {
    release();                                      // never leave the held order pending
    await slowA.catch(() => {});
    await new Promise((r) => srv.close(r));
  }
});

test("an unreachable relay keeps the names AND keeps serving them", async () => {
  const r = await relay(() => ["shop.example.com"]);
  const h = box(r.base);
  h.records.set(A, { id: A, status: "running", appHost: "aaaaaaaa.app.enclave.host" });
  await h.refreshDomains(A);
  await r.close();                                   // the relay goes away
  h.cfg.relayBase = "http://127.0.0.1:1";
  await h.refreshDomains(A);
  assert.deepEqual(h.domains.get(A), ["shop.example.com"], "a blip must not withdraw a live name");
  assert.ok(h.zoneRules(A).contextFor("shop.example.com"), "and it keeps answering for it");
});
