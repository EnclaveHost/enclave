// site/js/core/config.js — the test-only localStorage overrides are inert off loopback.
//
// enclave_rpc pins every chain read to one endpoint, and js/core/addressbook.js
// resolves the contract addresses over exactly those reads. So a planted
// enclave_rpc (or enclave_addressbook, the root the resolve starts from) does
// not merely show wrong data: it decides which contract the user's wallet is
// asked to sign create/fund/USDC against. Both exist only so a local run can
// point at anvil, and localStorage OUTLIVES the foothold that wrote it, so the
// gate is on the page's origin — a condition enclave.host can never satisfy —
// rather than on the value, which the attacker picks.
//
//   run: node --test test/config-dev-overrides.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site/js/core/config.js");

const EVIL_RPC  = "https://rpc.evil.example";
const EVIL_BOOK = "0x00000000000000000000000000000000deadbeef";
const REAL_BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";

// config.js reads location + localStorage at module scope, so each scenario
// needs a fresh module instance: import with a unique query to bust the cache.
let n = 0;
async function loadOn(hostname, overrides = {}) {
  const store = new Map(Object.entries(overrides));
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  if (hostname === null) delete globalThis.location;
  else globalThis.location = { hostname, href: `https://${hostname}/`, origin: `https://${hostname}` };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  return import(`${pathToFileURL(CONFIG).href}?case=${++n}`);
}

const PLANTED = { enclave_rpc: EVIL_RPC, enclave_addressbook: EVIL_BOOK };

test("on the production origin both overrides are ignored", async () => {
  const c = await loadOn("enclave.host", PLANTED);
  assert.ok(!c.APP_CATALOG_RPCS.includes(EVIL_RPC), "attacker RPC must not enter the read pool");
  assert.ok(c.APP_CATALOG_RPCS.length > 1, "the real failover pool is used");
  assert.equal(c.ADDRESS_BOOK_ADDRESS, REAL_BOOK, "the address-book root stays the baked one");
});

test("on loopback the e2e overrides still work", async () => {
  // the e2e site is served from http://localhost:18899 (WebAuthn needs a
  // domain, so not 127.0.0.1) and seeds enclave_rpc -> its anvil
  const c = await loadOn("localhost", PLANTED);
  assert.deepEqual(c.APP_CATALOG_RPCS, [EVIL_RPC], "a local run pins to its own chain");
  assert.equal(c.ADDRESS_BOOK_ADDRESS, EVIL_BOOK);
  const ip = await loadOn("127.0.0.1", PLANTED);
  assert.deepEqual(ip.APP_CATALOG_RPCS, [EVIL_RPC]);
});

test("hosts that merely look like loopback do NOT pass the gate", async () => {
  // the interesting one is the suffix: a substring or prefix test would hand
  // the gate to any attacker who can name a host
  for (const h of ["localhost.evil.example", "notlocalhost", "127.0.0.1.evil.example",
                   "evil.example", "xlocalhost", "localhostx"]) {
    const c = await loadOn(h, PLANTED);
    assert.ok(!c.APP_CATALOG_RPCS.includes(EVIL_RPC), `${h} must not be treated as loopback`);
    assert.equal(c.ADDRESS_BOOK_ADDRESS, REAL_BOOK, h);
  }
});

test("no location at all (a node import) gets production rules", async () => {
  const c = await loadOn(null, PLANTED);
  assert.ok(!c.APP_CATALOG_RPCS.includes(EVIL_RPC));
  assert.equal(c.ADDRESS_BOOK_ADDRESS, REAL_BOOK);
});

test("the accounts off switch is deliberately NOT gated", async () => {
  // "0" is the documented emergency per-browser kill switch for the accounts
  // UI; it must keep working on the real origin, and it only ever takes
  // features away
  const off = await loadOn("enclave.host", { enclave_accounts: "0" });
  assert.equal(off.ACCOUNTS_ENABLED, false);
  const dflt = await loadOn("enclave.host", {});
  assert.equal(dflt.ACCOUNTS_ENABLED, true);
});
