// A failed read is not an empty list.
//
// 2026-09-25: a relay deploy crash-looped the API relay for about six minutes (ERR_MODULE_NOT_FOUND
// on a file the deploy did not copy), so the proxy answered 502 with no CORS headers. The signed-in
// dashboard put one "couldn't load enclaves: Could not reach ..." line in the list body while its
// status counters read 0 (Queued selected), and the fleet panel said "No app hosts available right
// now". The owner has twelve deployments (5 stopped, 1 queued, 1 unfunded, 5 running); none were
// lost, the read failed. These pin what the panels may show instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = (m) => import(pathToFileURL(path.join(ROOT, "site/js/core", m)).href);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const { LastGood, listIdentity, failureReason } = await core("list-state.js");
const { BUCKETS, bucketOf, countBuckets } = await core("deploy-status.js");
const { createFleetReader } = await core("fleet-read.js");

const W1 = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", W2 = "0x1111111111111111111111111111111111111111";
const liveOwnerList = [
  ...Array(5).fill("stopped"), "queued", "unfunded", ...Array(5).fill("running"),
].map((status, i) => ({ id: "0x" + String(i).padStart(64, "0"), status }));

test("status categories: the live owner list's twelve rows land in the right tabs", () => {
  assert.deepEqual(countBuckets(liveOwnerList), { all: 12, running: 5, queued: 2, ended: 5, failed: 0 });
});

test("every status has a tab, and the tabs are the template's", () => {
  for (const s of ["provisioning", "queued", "pending", "claiming", "claimed", "starting", "created", "awaiting_payment", "unfunded", "unknown"])
    assert.equal(bucketOf(s), "queued", s);
  for (const s of ["failed", "error"]) assert.equal(bucketOf(s), "failed", s);
  for (const s of ["stopped", "stopping", "terminated", "expired", "something-new", "", undefined, null])
    assert.equal(bucketOf(s), "ended", String(s));
  assert.equal(bucketOf("RUNNING"), "running");
  const tabs = [...read("site/components/deployments/deployments.html").matchAll(/data-bucket="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["all", ...BUCKETS]);
});

test("a failed first read is an error with nothing to show, never an empty list", () => {
  const g = new LastGood();
  const v = g.failed(listIdentity(W1, false, null), Object.assign(new Error("Could not reach"), { status: 0 }));
  assert.equal(v.kind, "error");
  assert.equal(v.rows, null);
});

test("a failed refresh shows the same wallet's last good rows, marked stale with their time", () => {
  const g = new LastGood();
  g.ok(listIdentity(W1, false, null), liveOwnerList, 1000);
  const v = g.failed(listIdentity(W1.toUpperCase().replace("0X", "0x"), false, null), { status: 502 }, 5000);
  assert.equal(v.kind, "stale");
  assert.equal(v.at, 1000);
  assert.deepEqual(countBuckets(v.rows), { all: 12, running: 5, queued: 2, ended: 5, failed: 0 });
});

test("another wallet's rows are never shown: a failure after a switch is an error", () => {
  const g = new LastGood();
  g.ok(listIdentity(W1, false, null), liveOwnerList, 1000);
  assert.equal(g.failed(listIdentity(W2, false, null), { status: 0 }).kind, "error");
  assert.equal(g.failed(listIdentity(W1, true, "acct-a"), { status: 0 }).kind, "error", "same wallet, now with an account session");
  g.ok(listIdentity(null, true, "acct-a"), [liveOwnerList[0]], 2000);
  assert.equal(g.failed(listIdentity(null, true, "acct-b"), { status: 0 }).kind, "error", "another account");
  assert.equal(g.failed(null, { status: 0 }).kind, "error", "no identity never shows cached rows");
});

test("an account session without an id has no identity, so its failure shows no cached rows", () => {
  assert.equal(listIdentity(null, true, null), null);
  assert.equal(listIdentity(W1, true, null), null);
  assert.equal(listIdentity(null, false, null), null);
  assert.equal(listIdentity(W1, false, null), listIdentity(W1.toUpperCase().replace("0X", "0x"), false, null));
  const g = new LastGood();
  g.ok(listIdentity(W1, true, null), liveOwnerList);
  assert.equal(g.failed(listIdentity(W1, true, null), { status: 0 }).kind, "error");
});

test("recovery: the next good read is fresh and replaces what was stale", () => {
  const g = new LastGood(), who = listIdentity(W1, false, null);
  g.ok(who, liveOwnerList.slice(0, 3), 1000);
  assert.equal(g.failed(who, { status: 502 }).kind, "stale");
  const v = g.ok(who, liveOwnerList, 9000);
  assert.equal(v.kind, "fresh");
  assert.equal(g.failed(who, { status: 502 }).rows.length, 12);
  assert.equal(g.failed(who, { status: 502 }).at, 9000);
});

test("failure reasons say what is known: no answer is not called a CORS problem", () => {
  assert.equal(failureReason({ status: 0, message: "Could not reach https://api.enclave.host/v1/deployments?owner=0x... Check the endpoint is live and returns CORS headers." }),
    "the Enclave API did not answer");
  assert.equal(failureReason({ status: 502, message: "HTTP 502 Bad Gateway" }), "the Enclave API answered HTTP 502");
  assert.match(failureReason({ status: 503, message: "No enclave in the fleet is taking work right now" }), /HTTP 503: No enclave in the fleet/);
  assert.equal(failureReason(new SyntaxError("Unexpected token")), "the read failed");
  assert.doesNotMatch(failureReason({ status: 0 }), /cors/i);
});

// ---- the fleet panel: API down -> up -> 502 -> up, through the shared reader ----
const answer = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const fleetBody = { enclaves: [
  { name: "cpu-b", endpoint: "tunnel://b", availability: { gpu: false } },
  { name: "gpu-a", endpoint: "tunnel://z", availability: { gpu: true } },
] };

test("fleet: a failed first read is an error state, not 'no app hosts'; then stale; then recovered", async () => {
  const script = [() => Promise.reject(new TypeError("Failed to fetch")), () => answer(200, fleetBody), () => answer(502, "Bad Gateway"), () => answer(200, fleetBody)];
  const seen = [];
  const refresh = createFleetReader((url, init) => { seen.push(url); assert.equal(init.headers.Accept, "application/json"); return script.shift()(); });
  const fl = {};
  await refresh(fl, "https://api.enclave.host/v1");
  assert.equal(fl.error, "the Enclave API did not answer");
  assert.deepEqual(fl.rows, []);
  assert.equal(fl.staleAt, 0);
  await refresh(fl, "https://api.enclave.host/v1");
  assert.equal(fl.error, null);
  assert.deepEqual(fl.rows.map((e) => e.name), ["gpu-a", "cpu-b"], "GPU boxes first");
  const goodAt = Date.now();
  await refresh(fl, "https://api.enclave.host/v1");
  assert.equal(fl.error, "the Enclave API answered HTTP 502");
  assert.deepEqual(fl.rows.map((e) => e.name), ["gpu-a", "cpu-b"], "the last good table stays, marked stale");
  assert.ok(fl.staleAt > 0 && fl.staleAt <= goodAt);
  await refresh(fl, "https://api.enclave.host/v1");
  assert.equal(fl.error, null);
  assert.equal(fl.staleAt, 0);
  assert.deepEqual(seen, Array(4).fill("https://api.enclave.host/enclaves"));
});

test("fleet: a body that is not JSON is a failed read too", async () => {
  const refresh = createFleetReader(() => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } }));
  const fl = {};
  await refresh(fl, "https://api.enclave.host/v1");
  assert.equal(fl.error, "the read failed");
  assert.deepEqual(fl.rows, []);
});

// ---- the component glue, pinned in source (the components import browser globals) ----

test("no page blanks the fleet on failure any more; all three use the shared reader", () => {
  for (const p of ["site/js/pages/dashboard.js", "site/js/pages/host.js", "site/js/pages/architecture.js"]) {
    const s = read(p);
    assert.doesNotMatch(s, /fl\.rows\s*=\s*\[\]/, p);
    assert.match(s, /refreshFleetInto\(document\.querySelector\("\.[a-z]+-fleet c-fleet-list"\), Enclave\.base\)/, p);
  }
  const fleet = read("site/components/fleet-list/fleet-list.js");
  const at = (t) => { const i = fleet.indexOf(t); assert.ok(i >= 0, t); return i; };
  assert.ok(at("fleet-error") < at("No app hosts available right now"), "the failed-read branch is decided before the empty state");
  assert.match(fleet, /static properties = \{ rows: null, error: null, staleAt: 0 \}/);
});

test("a failed list read keeps polling, shows unknown counts, and never shows another identity's rows", () => {
  const s = read("site/components/deployments/deployments.js");
  const refresh = s.slice(s.indexOf("  async refresh(opts) {"), s.indexOf("  _listFailed(who, e) {"));
  const failed = s.slice(s.indexOf("  _listFailed(who, e) {"), s.indexOf("  _loadNote(v) {"));
  assert.doesNotMatch(s, /couldn’t load enclaves:/, "the bare error line is gone");
  assert.match(refresh, /this\._listFailed\(who, e\);\s*\n\s*this\._startPoll\(\);/, "a failure keeps the poll running");
  assert.match(refresh, /this\._good\.ok\(who, list\);/, "a good read is remembered for its identity");
  assert.match(refresh, /if \(this\._rowsFor !== who\)\{ this\._rowsFor = null; this\._list = \[\]; body\.innerHTML = ""; \}/,
    "rows painted for another identity are cleared before the read");
  assert.match(failed, /n\.textContent = "–"/, "counters read unknown, not 0");
  assert.match(failed, /this\._list = \[\]; this\._rowsFor = null;/);
  assert.doesNotMatch(failed, /No apps yet/);
  assert.match(failed, /enc-retry/);
});
