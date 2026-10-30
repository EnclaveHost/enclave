// Independent dashboard mode: the network profile format and what config.js/api.js make of it.
// A saved profile decides which contracts a wallet signs for, so the tests pin: strict validation, no rebinding by the
// mutable address book, a per-tab confirmation for SAVED profiles, and no fallback to the hosted defaults when a
// profile is invalid or unconfirmed.
//   run: node --test test/site-independent-profile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as P from "../site/js/core/independent.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const a = (b) => "0x" + b.repeat(20);
export function sampleProfile(over = {}){
  return {
    format: "enclave-browser-profile", version: 1, name: "test network", chainId: 8453,
    rpcs: ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"], quorum: 2, confirmations: 2,
    contractPins: { version: 1, chainId: 8453, contracts: { registry: a("11"), deployments: a("22"), appCatalog: a("33"), proofOfTime: a("44"),
      enclavePay: a("00"), verificationFees: a("00"), sessionVaultFactory: a("55"), secretVaultV2: a("00") } },
    usdc: a("66"),
    storage: { version: 1, minimumCopies: 2, replicas: [
      { upload: "https://s1.example/add-json", audience: "0x" + "01".repeat(32), gateway: "https://s1.example/ipfs" },
      { upload: "https://s2.example/add-json", audience: "0x" + "02".repeat(32), gateway: "https://s2.example/ipfs" }] },
    directories: ["https://dir-a.example", "http://203.0.113.7:8188"],
    ...over,
  };
}
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m });

test("a complete profile validates and normalizes; the CLI's contract-pin document is embedded unchanged", () => {
  const p = P.validateProfile(sampleProfile());
  assert.equal(p.contracts.deployments, a("22"));
  assert.deepEqual(p.rpcs, ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"]);
  assert.equal(p.storage.replicas.length, 2);
  assert.deepEqual(p.directories, ["https://dir-a.example", "http://203.0.113.7:8188"]);
  // loopback HTTP is allowed for a local node, nothing else is
  assert.ok(P.validateProfile(sampleProfile({ rpcs: ["http://127.0.0.1:8545", "http://localhost:8546"] })));
});

test("invalid profiles are refused with a reason", () => {
  const bad = [
    [{ rpcs: ["https://rpc-a.example"] }, /2–8 RPC/],
    [{ rpcs: ["https://rpc-a.example", "https://rpc-a.example/other"] }, /distinct/],
    [{ rpcs: ["http://rpc-a.example", "https://rpc-b.example"] }, /HTTPS/],
    [{ rpcs: ["https://u:p@rpc-a.example", "https://rpc-b.example"] }, /credentials/],
    [{ quorum: 4 }, /quorum/],
    [{ quorum: 1 }, /quorum/],
    [{ chainId: 1 }, /8453/],
    [{ usdc: a("00") }, /usdc/],
    [{ addressBook: a("00") }, /addressBook/],
    [{ addressBook: "https://book.example" }, /addressBook/],
    [{ extra: true }, /unknown field/],
    [{ contractPins: { version: 1, chainId: 8453, contracts: { ...sampleProfile().contractPins.contracts, deployments: a("00") } } }, /cannot be zero/],
    [{ contractPins: { version: 1, chainId: 8453, contracts: { ...sampleProfile().contractPins.contracts, connectivity: a("77") } } }, /unknown field/],
    [{ storage: { version: 1, minimumCopies: 3, replicas: sampleProfile().storage.replicas } }, /minimum/],
    [{ storage: { version: 1, minimumCopies: 2, replicas: [sampleProfile().storage.replicas[0], { ...sampleProfile().storage.replicas[1], upload: "https://s1.example/add-json", gateway: "https://s1.example/ipfs" }] } }, /distinct/],
    [{ storage: { version: 1, minimumCopies: 2, replicas: [sampleProfile().storage.replicas[0], { ...sampleProfile().storage.replicas[1], gateway: "https://other.example/ipfs" }] } }, /same adapter origin/],
    [{ directories: ["https://dir.example/v1"] }, /bare/],
  ];
  for (const [over, re] of bad) assert.throws(() => P.validateProfile(sampleProfile(over)), re, JSON.stringify(over));
  assert.throws(() => P.parseProfile('{"format":"enclave-browser-profile","format":"x"}'), /duplicate key/);
  assert.throws(() => P.parseProfile("x".repeat(40000)), /32 KiB/);
});

test("saved profiles need this tab's confirmation; built-in ones do not; broken ones never load", () => {
  const text = JSON.stringify(sampleProfile());
  const ls = mem(), ss = mem();
  assert.equal(P.loadProfileState(ls, null, ss).state, "off");
  ls.setItem(P.PROFILE_KEY, text);
  const pending = P.loadProfileState(ls, null, ss);
  assert.equal(pending.state, "unconfirmed");
  assert.equal(pending.profile.contracts.deployments, a("22"), "the profile is parsed so it can be shown for review");
  P.confirmSavedProfile(ls, ss);
  assert.equal(P.loadProfileState(ls, null, ss).state, "on");
  // a later change to the saved text is not covered by an earlier confirmation
  ls.setItem(P.PROFILE_KEY, JSON.stringify(sampleProfile({ name: "swapped" })));
  assert.equal(P.loadProfileState(ls, null, ss).state, "unconfirmed");
  ls.setItem(P.PROFILE_KEY, "{not json");
  const broken = P.loadProfileState(ls, null, ss);
  assert.equal(broken.state, "invalid"); assert.ok(broken.error);
  P.clearProfile(ls, ss);
  assert.equal(P.loadProfileState(ls, text, ss).state, "on", "a profile built into the site's code needs no confirmation");
  assert.throws(() => P.saveProfile("{}", ls, ss), /field|format|profile/);
  assert.equal(ls.getItem(P.PROFILE_KEY), null, "an invalid profile is never persisted");
  P.saveProfile(text, ls, ss);
  assert.equal(P.loadProfileState(ls, null, ss).state, "on", "saving in this tab confirms it here");
});

// config.js/api.js read storage at module scope: each scenario imports a fresh instance.
let n = 0;
async function loadSite({ saved = null, ack = null, planted = {}, host = "enclave.host" } = {}){
  const ls = new Map(Object.entries(planted)), ss = new Map();
  if (saved != null) ls.set(P.PROFILE_KEY, saved);
  if (ack != null) ss.set("enclave_independent_ack", ack);
  globalThis.localStorage = mem(ls); globalThis.sessionStorage = mem(ss);
  globalThis.location = { hostname: host, href: `https://${host}/`, origin: `https://${host}` };
  const q = "?case=" + (++n);
  const config = await import(pathToFileURL(path.join(REPO, "site/js/core/config.js")).href + q);
  return config;
}

test("config.js: an active profile pins every binding and never consults the book or the hosted upload service", async () => {
  const text = JSON.stringify(sampleProfile());
  const c = await loadSite({ saved: text, ack: text, planted: { enclave_rpc: "https://evil.example", enclave_addressbook: a("de") }, host: "localhost" });
  assert.equal(c.INDEPENDENT.state, "on");
  assert.equal(c.DEPLOYMENTS_ADDRESS, a("22"));
  assert.equal(c.APP_CATALOG_ADDRESS, a("33"));
  assert.equal(c.REGISTRY_ADDRESS, a("11"));
  assert.equal(c.SESSION_FACTORY_ADDRESS, a("55"));
  assert.equal(c.USDC_BASE, a("66"));
  assert.equal(c.ADDRESS_BOOK_ADDRESS, "", "no book root, even with a planted loopback override");
  assert.deepEqual(c.APP_CATALOG_RPCS, sampleProfile().rpcs, "planted enclave_rpc is ignored");
  assert.deepEqual(c.__applyAddresses({ deployments: a("99"), appCatalog: a("98") }), [], "a book map cannot rebind the pins");
  assert.equal(c.DEPLOYMENTS_ADDRESS, a("22"));
  assert.equal(c.IPFS_UPLOAD_URL, ""); assert.equal(c.IPFS_JSON_UPLOAD_URL, ""); assert.equal(c.IPFS_IMAGE_UPLOAD_URL, "");
  assert.equal(c.IPFS_IMG_GATEWAY, "https://s1.example/ipfs/");
  assert.equal(c.STORAGE_PLAN.minimumCopies, 2);
  assert.equal(c.FEATURED_ADDRESS, ""); assert.equal(c.PAYMENT_ROUTER_ADDRESS, "");
});

test("config.js: an unconfirmed or invalid profile pins nothing and does not fall back to the hosted defaults", async () => {
  for (const [saved, ack, state] of [[JSON.stringify(sampleProfile()), null, "unconfirmed"], ['{"format":1}', null, "invalid"]]){
    const c = await loadSite({ saved, ack });
    assert.equal(c.INDEPENDENT.state, state);
    assert.equal(c.DEPLOYMENTS_ADDRESS, "", state + ": no ledger to sign against");
    assert.equal(c.APP_CATALOG_ADDRESS, "");
    assert.equal(c.ADDRESS_BOOK_ADDRESS, "");
    assert.deepEqual(c.APP_CATALOG_RPCS, []);
    assert.equal(c.IPFS_UPLOAD_URL, "");
  }
  const off = await loadSite();
  assert.equal(off.INDEPENDENT.state, "off");
  assert.equal(off.ADDRESS_BOOK_ADDRESS, "0xab214342d5A490150A4A977063A2f88E21F80907", "hosted mode is unchanged");
  assert.equal(off.IPFS_UPLOAD_URL, "https://ipfs.enclave.host/add-wasm");
});

test("an explicit platform book allows admin updates while fixed profiles keep their original trust", async () => {
  const text = JSON.stringify(sampleProfile({addressBook:a("ab")}));
  const c = await loadSite({saved:text,ack:text,planted:{enclave_addressbook:a("de")},host:"localhost"});
  assert.equal(c.ADDRESS_BOOK_ADDRESS,a("ab"));
  assert.equal(c.INDEPENDENT.profile.contracts.appCatalog,a("33"));
  assert.deepEqual(c.__applyAddresses({appCatalog:a("98"),reviews:a("97")}),["APP_CATALOG_ADDRESS","REVIEWS_ADDRESS"]);
  assert.equal(c.APP_CATALOG_ADDRESS,a("98"));
  assert.equal(c.INDEPENDENT.profile.contracts.appCatalog,a("33"),"the reviewed profile remains immutable");
  assert.deepEqual(c.__applyAddresses({reviews:""}),["REVIEWS_ADDRESS"]);
  assert.equal(c.REVIEWS_ADDRESS,"","retired optional services turn off");
});

test("api.js: independent mode refuses every central call without network access, with a plain reason", async () => {
  const text = JSON.stringify(sampleProfile());
  await loadSite({ saved: text, ack: text });
  const { Enclave, INDEPENDENT_MODE } = await import(pathToFileURL(path.join(REPO, "site/js/core/api.js")).href + "?case=" + n);
  assert.equal(INDEPENDENT_MODE, true);
  const fetched = []; const real = globalThis.fetch; globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error("network"); };
  try {
    for (const call of [() => Enclave.getPricing(), () => Enclave.getNetworkRoutes(), () => Enclave.accountMe(), () => Enclave.claimHint("0x" + "1".repeat(64))]){
      await assert.rejects(call(), (e) => e.independent === true && /independent mode/.test(e.message));
    }
    assert.throws(() => Enclave.setBase("https://api.enclave.host/v1"), /independent mode/);
    assert.deepEqual(fetched, [], "nothing reached the network");
    assert.equal(Enclave.base, P.INDEPENDENT_API_BASE);
    // host management (logs here) is not a central call any more: it goes to the deployment's own host, after an agreed
    // lease read from the profile's RPCs. Without agreeing RPCs it stops there: no directory, no host, no Enclave origin.
    await assert.rejects(Enclave.logs("0x" + "1".repeat(64)), (e) => e.name === "ManagementUiError" && e.kind === "chain" && /Nothing was sent/.test(e.message));
    const rpcs = new Set(JSON.parse(text).rpcs);
    assert.ok(fetched.length > 0 && fetched.every((u) => rpcs.has(u)), "only the profile's RPCs were asked: " + JSON.stringify(fetched));
  } finally { globalThis.fetch = real; }
});
