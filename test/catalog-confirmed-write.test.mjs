// An approval must show the moment its receipt lands - not on the next
// catalog read that happens to succeed.
//
// Reported 2026-08-16: approving an app pops "catalog refresh failed …" and the
// card keeps its Pending badge until the page is manually refreshed. Both halves
// come from the same place. `setApproval` confirms on-chain, and THEN the page
// asks the rotating pool of public Base RPCs to re-read the whole catalog -
// which is the worst moment in the session to ask, because our own receipt
// polling has just been bursting against that pool. It fails (toast, store keeps
// the pre-approval paint), or it lands on a replica that hasn't indexed the
// block and repaints the OLD ruling on purpose. See enclave-catalog-owner-ui-race.
//
// The fix: a write with a receipt is authority. It is recorded, painted at once,
// and re-applied over every read until a FRESH read agrees with it (replicas
// caught up) or it ages out. This file drives that overlay directly, out of
// site/js/core/catalog.js, against a fake localStorage.
//
//   run: node --test test/catalog-confirmed-write.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = fs.readFileSync(path.join(REPO, "site/js/core/catalog.js"), "utf8");
const APPS = fs.readFileSync(path.join(REPO, "site/js/pages/apps.js"), "utf8");

/* Lift the overlay out of the browser module: everything it closes over is a
   parameter, so one `ls` object stands in for localStorage and survives across
   "page loads" (a second load() over the same store = a fresh module). */
function load(ls, store){
  const start = CATALOG.indexOf("const WRITE_TTL");
  assert.ok(start > 0, "catalog.js no longer defines the confirmed-write overlay");
  const end = CATALOG.indexOf("/* Resolves true when a fresh chain read landed");
  assert.ok(end > start, "the overlay block's end marker moved");
  const body = CATALOG.slice(start, end).replace(/\bexport /g, "");
  const emitted = [];
  const cached = [];
  const fn = new Function("lsGet", "lsSet", "APP_CATALOG_ADDRESS", "STORE", "catCacheSet", "emit",
    body + "; return { applyCatalogWrites, noteCatalogWrite };")(
      (k) => (k in ls ? ls[k] : null), (k, v) => { ls[k] = v; }, "0xCAT",
      store, (apps) => cached.push(apps), (n, d) => emitted.push({ n, ...d }));
  return { ...fn, emitted, cached };
}

// one app, one pending version - the shape the moderation queue reads
const catalog = (approval = 0, active = true) => ([{
  appId: "0xabc", slug: "risc-box", active, versions: [{ version: "0.6.20", approval, verified: false, yanked: false }],
}]);
const newStore = (apps) => ({ apps, byId: {}, loaded: true });
const writesIn = (ls) => JSON.parse(ls["enclave_catalog_writes_0xCAT"] || "{}");

test("the approval paints on the receipt, before any read", () => {
  const store = newStore(catalog(0));
  const { noteCatalogWrite, emitted, cached } = load({}, store);

  noteCatalogWrite("0xabc", 0, "approval", 1);

  assert.equal(store.apps[0].versions[0].approval, 1, "the store must carry the confirmed ruling immediately");
  assert.equal(cached.length, 1, "the localStorage catalog must be re-cached, or a reload undoes it");
  assert.deepEqual(emitted.map(e => e.n), ["enclave:catalog"], "the page repaints off this event");
  assert.equal(emitted[0].type, "loaded");
});

test("a lagging replica cannot repaint the old ruling", () => {
  const ls = {};
  const store = newStore(catalog(0));
  const { noteCatalogWrite, applyCatalogWrites } = load(ls, store);
  noteCatalogWrite("0xabc", 0, "approval", 1);

  // the post-tx re-read lands on a replica that hasn't indexed the block
  const stale = catalog(0);
  applyCatalogWrites(stale, true);

  assert.equal(stale[0].versions[0].approval, 1, "the receipt outranks a replica that hasn't caught up");
  assert.equal(Object.keys(writesIn(ls)).length, 1, "and the write stays live until a read agrees");
});

test("a read that agrees retires the write", () => {
  const ls = {};
  const store = newStore(catalog(0));
  const { noteCatalogWrite, applyCatalogWrites } = load(ls, store);
  noteCatalogWrite("0xabc", 0, "approval", 1);

  applyCatalogWrites(catalog(1), true);          // replicas caught up

  assert.deepEqual(writesIn(ls), {}, "an overlay that outlives its purpose is how the next real change gets hidden");
});

test("a cached paint never retires the write - that is the reload path", () => {
  const ls = {};
  const store = newStore(catalog(0));
  load(ls, store).noteCatalogWrite("0xabc", 0, "approval", 1);

  // page reload: the cache was written WITH the approval, so it agrees with the
  // overlay by construction. Retiring on that would hand the next stale read the
  // pending badge back - the exact bug, one refresh later.
  const fresh = load(ls, newStore(catalog(1)));
  fresh.applyCatalogWrites(catalog(1), false);
  assert.equal(Object.keys(writesIn(ls)).length, 1, "only a chain read may retire a write");

  const stale = catalog(0);
  fresh.applyCatalogWrites(stale, true);
  assert.equal(stale[0].versions[0].approval, 1, "and after a reload it still outranks a lagging replica");
});

test("the write survives the page refresh it used to require", () => {
  const ls = {};
  load(ls, newStore(catalog(0))).noteCatalogWrite("0xabc", 0, "approval", 1);

  const store2 = newStore(catalog(0));           // a fresh session, cache-less, reading stale
  const { applyCatalogWrites } = load(ls, store2);
  applyCatalogWrites(store2.apps, true);
  assert.equal(store2.apps[0].versions[0].approval, 1, "persisted in localStorage, keyed by catalog address");
});

test("an aged-out write is dropped, never applied", () => {
  const ls = { "enclave_catalog_writes_0xCAT": JSON.stringify({
    "0xabc|0|approval": { appId: "0xabc", idx: 0, field: "approval", value: 1, at: Date.now() - 3600000 } }) };

  const apps = catalog(0);
  const { applyCatalogWrites } = load(ls, newStore(apps));
  applyCatalogWrites(apps, true);

  assert.equal(apps[0].versions[0].approval, 0, "past the TTL the chain is the only authority again");
  assert.deepEqual(writesIn(ls), {});
});

test("a later write from somewhere else retires ours on sight", () => {
  const ls = {};
  const { noteCatalogWrite, applyCatalogWrites } = load(ls, newStore(catalog(0)));
  noteCatalogWrite("0xabc", 0, "approval", 1);   // approved here…

  const elsewhere = catalog(2);                  // …then rejected from another tab or the CLI
  applyCatalogWrites(elsewhere, true);

  assert.equal(elsewhere[0].versions[0].approval, 2,
    "a third value is the chain moving past us, not a replica lagging behind us");
  assert.deepEqual(writesIn(ls), {}, "so the overlay steps aside at once, not in fifteen minutes");
});

test("a read missing the app holds the write instead of dropping it", () => {
  const ls = {};
  const { noteCatalogWrite, applyCatalogWrites } = load(ls, newStore(catalog(0)));
  noteCatalogWrite("0xabc", 0, "approval", 1);

  applyCatalogWrites([], true);                  // a replica so far behind the app isn't there
  assert.equal(Object.keys(writesIn(ls)).length, 1, "absence is not agreement");
});

test("app-level writes (delist/relist) ride the same path", () => {
  const ls = {};
  const store = newStore(catalog(1, true));
  const { noteCatalogWrite, applyCatalogWrites } = load(ls, store);
  noteCatalogWrite("0xabc", null, "active", false);

  assert.equal(store.apps[0].active, false);
  const stale = catalog(1, true);
  applyCatalogWrites(stale, true);
  assert.equal(stale[0].active, false, "idx null addresses the app row, not a version");
});

/* ---- the wiring, asserted at the source level ----
   The overlay is only reached if every moderation transaction declares what it
   wrote; a call site that forgets is silently back to the old behaviour. */
test("every catalog moderation tx declares the field it writes", () => {
  const decl = (name) => {
    const m = new RegExp("const\\s+" + name + "\\s*=[\\s\\S]{0,600}").exec(APPS);
    assert.ok(m, "apps.js no longer defines " + name);
    return m[0];
  };
  assert.match(decl("setApprovalTx"), /field:\s*"approval",\s*value:\s*st/, "approve/reject must paint from its receipt");
  assert.match(decl("setVerifiedTx"), /field:\s*"verified"/);
  assert.match(decl("yankTx"), /field:\s*"yanked"/);
  assert.match(decl("setActiveTx"), /field:\s*"active"/);
  assert.match(APPS, /noteCatalogWrite\(write\.appId, write\.idx, write\.field, write\.value\)/,
    "catTx must record the write once the receipt lands");
});

test("a quiet re-read failure does not toast", () => {
  const i = APPS.indexOf('on("enclave:catalog"');
  assert.ok(i > 0);
  const handler = APPS.slice(i, i + 900);
  assert.match(handler, /if \(d\.quiet\) return;/,
    "the ruling is already on screen - 'catalog refresh failed' would be shouting about nothing");
  assert.ok(handler.indexOf("if (d.quiet) return;") < handler.indexOf("showToast"),
    "the quiet check must come BEFORE the toast");
  assert.match(APPS, /loadCatalog\(true, \{ quiet: true \}\)/, "and the failed re-read must retry on its own");
});
