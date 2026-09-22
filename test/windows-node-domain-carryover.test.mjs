// A hostname's TRANSIENT state must belong to whoever owns the hostname NOW.
//
// This box keeps several maps keyed by hostname alone - the certificate, the CA backoff, the
// pending report to the customer - while the thing they are really about is a (deployment,
// hostname) pair. The certificate was bound to its owner after an audit found a cached entry
// answering for the wrong tenant. These tests are the same question asked of the two maps that
// were left behind, and of the generation counter that is supposed to detect a move.
//
// Every one drives the production Host: a stub relay answers the domain fetch, the CA is injected,
// and all the bookkeeping in between is real. A fixture that wrote into domainFails or certReports
// itself would be testing the fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host } from "../windows/node/host.mjs";
import { selfSigned } from "../windows/node/apptls.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-carry-"));
const A = "0x" + "aa".repeat(32), B = "0x" + "bb".repeat(32);
const NAME = "shop.example.com";

/**
 * A Host wired to a stub relay whose answer can be changed between refreshes - which is how a
 * hostname moves between deployments in real life. `posted` records what the box SENT, so a test
 * can look at the report the customer would receive.
 */
async function box({ issue }) {
  const owned = new Map([[A.toLowerCase(), [NAME]], [B.toLowerCase(), []]]);
  const posted = [];
  const relay = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    const body = JSON.parse(Buffer.concat(c).toString("utf8"));
    posted.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ domains: owned.get(body.id) || [] }));
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                       appZone: "app.enclave.host", customDomains: true,
                       relayBase: `http://127.0.0.1:${relay.address().port}`,
                       secretsSign: async () => "0x" + "11".repeat(65),
                       issueCert: issue });
  for (const id of [A, B]) {
    h.records.set(id, { id, status: "running", appHost: `${id.slice(2, 10)}.app.enclave.host` });
    h.apps.set(id, { state: "running", port: 1 });
  }
  const move = (to) => { owned.set(A.toLowerCase(), to === A ? [NAME] : []);
                         owned.set(B.toLowerCase(), to === B ? [NAME] : []); };
  return { h, posted, move, close: () => relay.close() };
}

const ok = ({ hostname }) => {
  const c = selfSigned(hostname);
  return { name: hostname, key: c.key, cert: c.cert, notAfter: new Date(Date.now() + 90 * 864e5).toISOString() };
};

test("a CA backoff earned by ONE deployment does not suppress the NEXT owner's first attempt", { timeout: 20_000 }, async () => {
  let refuse = true, tries = [];
  const { h, move, close } = await box({ issue: async ({ id, hostname }) => {
    tries.push(id.slice(0, 10));
    if (refuse) { const e = new Error("rate limited"); e.retryAfterSec = 3600; throw e; }
    return ok({ hostname });
  } });
  try {
    await h.refreshDomains(A);                       // A asks, the CA refuses, A backs off an hour
    assert.equal(h.hostCerts.has(NAME), false, "A really did fail to get a certificate");
    const back = h.domainFails.get(NAME);
    assert.ok(back && back.until > Date.now(), "and really is in backoff");
    assert.equal(back.owner, A.toLowerCase(), "a backoff records WHOSE it is");

    refuse = false;                                  // the CA would say yes now
    move(B);
    // B refreshes and A does not. That is not a contrived order: A's own refresh happens to clear
    // the backoff on its way out, so the carry-over only bites when A is not there to do it -
    // which is the ordinary case of a deployment that was STOPPED and its domain re-attached
    // elsewhere, and is also just a race between two apps on the same thirty-second tick.
    await h.refreshDomains(B);
    assert.equal(h.domainOwner.get(NAME), B.toLowerCase(), "the index moved the name to B");

    // The backoff was A's. B has never asked for this name in its life.
    assert.ok(tries.includes(B.slice(0, 10)),
      "B's first attempt must reach the CA and not be swallowed by the previous owner's backoff");
    assert.equal(h.hostCerts.get(NAME)?.owner, B.toLowerCase(),
      "so B's customer gets a certificate for their own domain rather than a name mismatch");
  } finally { close(); }
});

test("a failure report earned by ONE deployment is never delivered to the NEXT owner", { timeout: 20_000 }, async () => {
  let refuse = true;
  const { h, posted, move, close } = await box({ issue: async ({ hostname }) => {
    if (refuse) throw new Error("dns-01 lookup failed for zone owned by someone else");
    return ok({ hostname });
  } });
  try {
    await h.refreshDomains(A);
    assert.equal(h.certReports.get(NAME)?.ok, false, "A really did record a failure report");

    refuse = false;
    move(B);
    await h.refreshDomains(B);                       // A is gone; only the new owner refreshes
    posted.length = 0;
    await h.refreshDomains(B);                       // the fetch that would carry a report

    const reports = posted.flatMap((p) => p.report || []);
    const leaked = reports.filter((r) => r.hostname === NAME && r.ok === false);
    assert.deepEqual(leaked, [],
      "B's owner must not be shown the previous tenant's CA error for a name B now holds");
  } finally { close(); }
});

test("an ordinary refresh does not look like a move, so a slow certificate is not discarded", { timeout: 20_000 }, async () => {
  // The generation counter exists to spot a name moving mid-order. It is bumped every time the
  // relay MENTIONS a name, which on this box is every thirty seconds per running app - so an order
  // slower than a tick looks like a move and its result is thrown away. The next tick starts
  // another order, which the tick after that discards in turn, and a customer whose CA is slower
  // than the tick never gets a certificate at all.
  //
  // Two orders, and only the first is ever released: the second exists to be the NEXT TICK, which
  // is the whole point. Awaiting it would be waiting for a gate this test never opens.
  const gates = [];
  const { h, close } = await box({ issue: async ({ hostname }) => {
    await new Promise((r) => gates.push(r));
    return ok({ hostname });
  } });
  try {
    const first = h.refreshDomains(A);                       // tick N: parks inside the CA call
    while (gates.length < 1) await new Promise((r) => setImmediate(r));
    h.refreshDomains(A).catch(() => {});                     // tick N+1: same owner, nothing moved
    while (gates.length < 2) await new Promise((r) => setImmediate(r));

    gates[0]();                                              // tick N's certificate arrives
    await first;
    assert.equal(h.hostCerts.get(NAME)?.owner, A.toLowerCase(),
      "the certificate A ordered is A's; being told again that A owns the name is not a move");
  } finally { close(); }
});
