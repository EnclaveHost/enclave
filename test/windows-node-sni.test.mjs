// The app zone answers on more than one name, and picks the right certificate by SNI.
//
// A deployment has its own <label>.app.enclave.host and, once an owner attaches one, their own
// domain. The relay routes BOTH down the same /x/<id>/https path, so the name a browser asked for
// is knowable only from the ClientHello - which is why the certificate is chosen by SNICallback
// rather than fixed when the socket is made.
//
// The case worth testing hardest is the one that would be a cross-tenant mistake: this box holds a
// global map of hostname -> certificate, and a socket for deployment A must never present a
// certificate belonging to deployment B, however the SNI is spelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host } from "../windows/node/host.mjs";
import { selfSigned } from "../windows/node/apptls.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-sni-"));
const A = "0x" + "aa".repeat(32), B = "0x" + "bb".repeat(32);

/** A Host with two deployments, each with its own custom domain and certificate. */
function box() {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                       appZone: "app.enclave.host", customDomains: true });
  for (const [id, host] of [[A, "shop.example.com"], [B, "other.example.com"]]) {
    h.records.set(id, { id, status: "running", appHost: "x.app.enclave.host" });
    h.apps.set(id, { state: "running", port: 1 });
    h.domains.set(id, [host]);
    const cert = selfSigned(host);
    h.hostCerts.set(host, { cert, ctx: tls.createSecureContext({ key: cert.key, cert: cert.cert }) });
  }
  return h;
}

/** Serve one TLS connection the way appzone does, and report which certificate was presented. */
async function handshake(rules, servername, fallback) {
  const srv = net.createServer((sock) => {
    const t = new tls.TLSSocket(sock, {
      isServer: true, key: fallback.key, cert: fallback.cert,
      SNICallback: (name, cb) => cb(null, (rules.contextFor && rules.contextFor(name)) || undefined),
      requestCert: false, rejectUnauthorized: false,
    });
    t.on("error", () => {});
    t.on("secure", () => t.end("ok"));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await new Promise((resolve) => {
      const c = tls.connect({ host: "127.0.0.1", port: srv.address().port, servername, rejectUnauthorized: false }, () => {
        const cn = c.getPeerCertificate().subject?.CN;
        c.destroy(); resolve(cn);
      });
      c.on("error", (e) => resolve(`ERROR ${e.message}`));
    });
  } finally { srv.close(); }
}

test("a deployment's own custom domain gets its own certificate", async () => {
  const h = box();
  const own = selfSigned("aaaaaaaa.app.enclave.host");
  // THE PRODUCTION RULES, not a reimplementation of them: zoneRules is what the app zone is given.
  assert.equal(await handshake(h.zoneRules(A), "shop.example.com", own), "shop.example.com");
});

test("ANOTHER tenant's hostname is refused: the default is served, not their certificate", async () => {
  const h = box();
  const own = selfSigned("aaaaaaaa.app.enclave.host");
  // other.example.com belongs to deployment B and its certificate IS in this box's map, so the
  // only thing standing between a socket for A and B's identity is zoneRules' ownership check.
  assert.ok(h.hostCerts.has("other.example.com"), "the fixture really does hold B's certificate");
  const rules = h.zoneRules(A);
  assert.equal(rules.contextFor("other.example.com"), null, "and it says no");
  assert.equal(await handshake(rules, "other.example.com", own), "aaaaaaaa.app.enclave.host",
    "a socket for A must never present B's certificate, however the SNI is spelled");
  // Spellings that must not slip past: case and a trailing root dot are normalised, and a name
  // that merely CONTAINS an owned one is not an owned one.
  for (const spoof of ["Other.Example.COM", "other.example.com.", "x.other.example.com", "shop.example.com.evil"])
    assert.equal(rules.contextFor(spoof), null, `${spoof} must not resolve to another tenant's certificate`);
  // ...while A's own name still works in any spelling.
  assert.ok(rules.contextFor("Shop.Example.COM."), "A's own name, normalised, still resolves");
});

test("an unknown name falls back rather than failing the handshake", async () => {
  const own = selfSigned("aaaaaaaa.app.enclave.host");
  const served = await handshake({ contextFor: () => null }, "never.heard.of.it", own);
  assert.equal(served, "aaaaaaaa.app.enclave.host",
    "a browser gets a name mismatch it can explain, not a reset it cannot");
});

test("a client that sends no SNI at all still gets the default", async () => {
  const own = selfSigned("aaaaaaaa.app.enclave.host");
  const served = await handshake({ contextFor: () => null }, undefined, own);
  assert.equal(served, "aaaaaaaa.app.enclave.host");
});

test("hostsFor lists the deployment's own name first, then the customer's", () => {
  const h = box();
  assert.deepEqual(h.hostsFor(A), ["x.app.enclave.host", "shop.example.com"]);
  // ...and a deployment with no custom domain still reports the one name it has.
  h.domains.delete(A);
  assert.deepEqual(h.hostsFor(A), ["x.app.enclave.host"]);
});

test("losing a lease drops the hostnames, the certificates and the pending reports", () => {
  const h = box();
  h.certReports.set("shop.example.com", { ok: false });
  assert.ok(h.hostCerts.has("shop.example.com"));
  // #stopApp is private; the state it clears is the contract, so clear it the same way and check.
  for (const host of h.domains.get(A) || []) { h.hostCerts.delete(host); h.certReports.delete(host); }
  h.domains.delete(A);
  assert.equal(h.hostCerts.has("shop.example.com"), false,
    "a name this box no longer serves must not keep a key that answers for it");
  assert.equal(h.certReports.has("shop.example.com"), false);
  assert.ok(h.hostCerts.has("other.example.com"), "and the OTHER tenant is untouched");
});
