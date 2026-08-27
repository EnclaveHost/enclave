// The launcher's certificate config: which credential a metal box hands the
// guest over fw_cfg, and where the guest is told to get certificates.
//
// This is the config-side of retiring the per-box ZeroSSL EAB pair. The
// default has to be "no CA credential leaves this file" -- a first-party
// config.json that still carries acmeEabKid/acmeEabHmac (every one of them
// did, until this change) must stop forwarding them the moment the launcher
// updates, and the guest must instead be pointed at the platform certificate
// service on the relay it already dials. enclave-metal.mjs launches QEMU at
// import, so the decision is a pure function sliced out by text, the way the
// haltpoll launcher-check did it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(join(repo, "metal", "enclave-metal.mjs"), "utf8");
const start = src.indexOf("function certsCfg(");
const end = src.indexOf("const CERTS = certsCfg(cfg);");
assert.ok(start > 0 && end > start, "certsCfg/certsApiOf must stay a self-contained block in enclave-metal.mjs");
const certsCfg = new Function(src.slice(start, end) + "\nreturn certsCfg;")();
const run = (cfg) => { const log = []; return { out: certsCfg(cfg, (m) => log.push(m)), log: log.join("\n") }; };

const RELAY = "wss://api.enclave.host/v1/fleet-tunnel";

test("default: the platform certificate service, derived from the relay the box dials", () => {
  const { out, log } = run({ relayUrl: RELAY });
  assert.deepEqual(out, { certsApi: "https://api.enclave.host" });
  assert.match(log, /platform certificate service at https:\/\/api\.enclave\.host/);
  // and it follows the relay, not a hard-coded host: a box on a staging relay
  // must not ask production for certificates
  assert.equal(run({ relayUrl: "wss://relay.example.test:8443/v1/fleet-tunnel" }).out.certsApi,
    "https://relay.example.test:8443");
});

test("certsApi in config wins over the derived default, trailing slash stripped", () => {
  assert.equal(run({ relayUrl: RELAY, certsApi: "https://certs.example.test/" }).out.certsApi,
    "https://certs.example.test");
  assert.equal(run({ certsApi: "https://certs.example.test" }).out.certsApi, "https://certs.example.test");
});

test("an EAB pair WITHOUT acmeBringYourOwn is dropped, with a warning", () => {
  // the pre-change first-party config.json: this is the case that matters
  const { out, log } = run({ relayUrl: RELAY, acmeEabKid: "kid", acmeEabHmac: "hmac" });
  assert.equal(out.acmeEabKid, undefined);
  assert.equal(out.acmeEabHmac, undefined);
  assert.equal(out.certsApi, "https://api.enclave.host");
  assert.match(log, /NOT forwarded/);
  // acmeBringYourOwn must be the boolean true, not any truthy string
  for (const byo of [false, "true", 1, "yes", null])
    assert.equal(run({ relayUrl: RELAY, acmeEabKid: "kid", acmeEabHmac: "hmac", acmeBringYourOwn: byo }).out.acmeEabKid,
      undefined, `acmeBringYourOwn=${JSON.stringify(byo)} must not forward the pair`);
});

test("acmeBringYourOwn: true with BOTH keys forwards the pair, and still names the service as fallback", () => {
  const { out, log } = run({ relayUrl: RELAY, acmeEabKid: "kid", acmeEabHmac: "hmac", acmeBringYourOwn: true });
  assert.deepEqual(out, { acmeEabKid: "kid", acmeEabHmac: "hmac", certsApi: "https://api.enclave.host" });
  assert.match(log, /bring-your-own/);
});

test("half a pair is never forwarded, flag or not", () => {
  for (const half of [{ acmeEabKid: "kid" }, { acmeEabHmac: "hmac" }]) {
    const { out, log } = run({ relayUrl: RELAY, acmeBringYourOwn: true, ...half });
    assert.deepEqual(out, { certsApi: "https://api.enclave.host" });
    assert.match(log, /not BOTH set/);
    assert.deepEqual(run({ relayUrl: RELAY, ...half }).out, { certsApi: "https://api.enclave.host" });
  }
});

test("no relay and no certsApi: nothing to derive, app-zone TLS is off rather than guessed", () => {
  const { out, log } = run({});
  assert.deepEqual(out, { certsApi: "" });
  assert.match(log, /stays off/);
  assert.deepEqual(run({ relayUrl: "not a url" }).out, { certsApi: "" });
});

test("gsup puts CERTS_API in the supervisor env from fw_cfg, and the EAB pair only as a pair", () => {
  // the guest half of the same contract, read the same way (gsup starts
  // services at import)
  const g = fs.readFileSync(join(repo, "metal", "guest", "gsup.mjs"), "utf8");
  assert.match(g, /\.\.\.\(fw\.certsApi \? \{ CERTS_API: String\(fw\.certsApi\) \} : \{\}\)/);
  assert.match(g, /fw\.acmeEabKid && fw\.acmeEabHmac \? \{\s*ACME_EAB_KID: fw\.acmeEabKid, ACME_EAB_HMAC: fw\.acmeEabHmac/);
});
