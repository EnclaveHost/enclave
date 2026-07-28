// The admin console's 24-hour operations panel (site/components/admin-console/
// metrics.js) reads the chain twice over: whole records off getPage, and the
// raw event log off eth_getLogs. Both halves are hand-decoded, so both are
// pinned here — the topics against viem and the ABIs, the bucketing and the
// lease reconstruction against hand-built fixtures.
//
// The reconstruction is the part worth testing hardest: "how many were running
// at 03:00" is not a number the chain stores, it is one this module infers from
// overlapping lease intervals, and an off-by-one there paints a plausible,
// wrong history that nobody would catch by looking.
//
//   run: node --test test/admin-metrics.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toEventSelector } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M = await import(path.join(REPO, "site/components/admin-console/metrics.js"));
const { DEP_CREATED_TOPIC } = await import(path.join(REPO, "site/js/core/chain.js"));
const ABI = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/EnclaveDeployments.abi.json"), "utf8"));

const HOUR = 3600;
const eq = (got, want) => assert.equal(String(got).toLowerCase(), String(want).toLowerCase());

test("every event topic matches viem's selector for the same signature", () => {
  for (const [name, sig] of Object.entries(M.EVENT_SIGS)) eq(M.TOPICS[name], toEventSelector(sig));
});

test("the signatures match the events EnclaveDeployments actually declares", () => {
  // the panel reads six events by topic0; if a contract change renames one or
  // moves an argument, the scan would silently return nothing for it
  const declared = Object.fromEntries(ABI.filter((x) => x.type === "event")
    .map((e) => [e.name, e.name + "(" + e.inputs.map((i) => i.type).join(",") + ")"]));
  for (const sig of Object.values(M.EVENT_SIGS)) {
    const name = sig.slice(0, sig.indexOf("("));
    assert.equal(declared[name], sig, `${name} is declared as ${declared[name]}`);
  }
});

test("Created's topic is the one chain.js already pinned by hand", () => {
  eq(M.TOPICS.created, DEP_CREATED_TOPIC);
});

test("buckets are hour-aligned, 24 of them, ending with the hour in progress", () => {
  const now = Math.floor(Date.UTC(2026, 6, 27, 13, 47, 30) / 1000);
  const b = M.makeBuckets(now);
  assert.equal(b.length, 24);
  for (const x of b) assert.equal(x.t1 - x.t0, HOUR);
  for (let i = 1; i < b.length; i++) assert.equal(b[i].t0, b[i - 1].t1);
  const last = b[b.length - 1];
  assert.ok(last.t0 <= now && now < last.t1, "the last bucket is the hour in progress");
  assert.equal(b[0].t0, last.t1 - 24 * HOUR);
});

test("createdBuckets lands each record in its own hour and drops what is older than the window", () => {
  const now = Math.floor(Date.UTC(2026, 6, 27, 13, 47, 30) / 1000);
  const b = M.makeBuckets(now);
  const rows = [
    { createdAt: b[0].t0 },                    // first hour, on the boundary
    { createdAt: b[0].t1 - 1 },                // same hour, last second
    { createdAt: b[5].t0 + 12 },
    { createdAt: b[23].t0 + 5 },               // the hour in progress
    { createdAt: b[0].t0 - 1 },                // one second before the window
    { createdAt: b[23].t1 + 60 },              // impossible (future) - must not land anywhere
  ];
  const got = M.createdBuckets(rows, b);
  assert.equal(got.length, 24);
  assert.equal(got[0], 2);
  assert.equal(got[5], 1);
  assert.equal(got[23], 1);
  assert.equal(got.reduce((a, c) => a + c, 0), 4);
});

/* ---- state-of-now classification ---- */

const rec = (o) => ({
  id: "0x" + "11".repeat(32), active: true, gpuMilli: 0, cpuMilli: 100, createdAt: 0,
  rate: 100, balance6: 0, spent6: 0, runner: "0x" + "0".repeat(64), leaseUntil: 0, ...o,
});
const RUNNER = "0x" + "ab".repeat(32);

test("summarize splits active records into running / waiting / out of funds", () => {
  const now = 1_000_000;
  const s = M.summarize([
    rec({ leaseUntil: now + 60, runner: RUNNER, rate: 300, gpuMilli: 250, cpuMilli: 100, balance6: 5_000_000 }),
    rec({ leaseUntil: now + 60, runner: RUNNER, rate: 200, cpuMilli: 50, balance6: 1_000_000 }),
    rec({ leaseUntil: now - 1, runner: RUNNER, rate: 100, balance6: 900 }),      // lease lapsed, still funded -> waiting
    rec({ leaseUntil: 0, rate: 100, balance6: 99 }),                             // under one second of credit
    rec({ active: false, balance6: 400, spent6: 20 }),
  ], now);

  assert.equal(s.total, 5);
  assert.equal(s.active, 4);
  assert.equal(s.inactive, 1);
  assert.equal(s.running, 2);
  assert.equal(s.waiting, 1);
  assert.equal(s.unfunded, 1);
  assert.equal(s.rate6, 500, "committed spend counts the RUNNING set only");
  assert.equal(s.gpuMilli, 250);
  assert.equal(s.cpuMilli, 150);
  assert.equal(s.runners.size, 1);
  assert.equal(s.balance6, 5_000_000 + 1_000_000 + 900 + 99 + 400, "prepaid held counts every record");
});

test("a lease held by nobody is not running, however far in the future it says", () => {
  const now = 1_000_000;
  // a zero runner with a live leaseUntil is what an imported/never-claimed
  // record looks like; counting it would invent a running deployment
  const s = M.summarize([rec({ leaseUntil: now + 3600, rate: 100, balance6: 10_000 })], now);
  assert.equal(s.running, 0);
  assert.equal(s.waiting, 1);
});

/* ---- lease-history reconstruction ---- */

const T0 = 1_800_000 * HOUR;                   // an exact hour boundary
const buckets = Array.from({ length: 24 }, (_, i) => ({ t0: T0 + i * HOUR, t1: T0 + (i + 1) * HOUR }));
const ev = (kind, id, time, extra = {}) => ({ kind, id, time, amount6: 0, ...extra });

test("a claim covers every hour up to its leaseUntil and no further", () => {
  const { running } = M.bucketHistory([
    ev("claimed", "0xa", T0 + 30, { leaseUntil: T0 + 2 * HOUR + 30 }),
  ], buckets);
  assert.deepEqual(running.slice(0, 5), [1, 1, 1, 0, 0]);
});

test("renewals chain into one continuous run", () => {
  const { running } = M.bucketHistory([
    ev("claimed", "0xa", T0 + 10, { leaseUntil: T0 + HOUR }),
    ev("renewed", "0xa", T0 + HOUR - 5, { leaseUntil: T0 + 2 * HOUR }),
    ev("renewed", "0xa", T0 + 2 * HOUR - 5, { leaseUntil: T0 + 3 * HOUR }),
  ], buckets);
  assert.deepEqual(running.slice(0, 4), [1, 1, 1, 0]);
});

test("a release ends the run at the release, not at the lease it had paid for", () => {
  const { running } = M.bucketHistory([
    ev("claimed", "0xa", T0 + 10, { leaseUntil: T0 + 5 * HOUR }),
    ev("released", "0xa", T0 + HOUR + 60, { amount6: 4_000 }),
  ], buckets);
  assert.deepEqual(running.slice(0, 4), [1, 1, 0, 0], "hour 1 holds it for the first minute; hour 2 does not");
});

test("a deployment re-claimed after a release runs again, and is counted once per hour", () => {
  const { running } = M.bucketHistory([
    ev("claimed", "0xa", T0 + 10, { leaseUntil: T0 + HOUR + 10 }),
    ev("released", "0xa", T0 + 30 * 60),
    ev("claimed", "0xa", T0 + 40 * 60, { leaseUntil: T0 + 2 * HOUR }),
    ev("renewed", "0xa", T0 + 50 * 60, { leaseUntil: T0 + 2 * HOUR }),      // same hour again
  ], buckets);
  assert.deepEqual(running.slice(0, 3), [1, 1, 0], "overlapping segments of ONE id are still one deployment");
});

test("a lease opened before the window still counts in the window's first hours", () => {
  // this is what the preroll scan buys: the renewal that covers t-24h happened
  // BEFORE the window, and without it hour 0 would read as empty
  const { running } = M.bucketHistory([
    ev("renewed", "0xa", T0 - 20 * 60, { leaseUntil: T0 + 90 * 60 }),
  ], buckets);
  assert.deepEqual(running.slice(0, 3), [1, 1, 0]);
});

test("concurrent deployments are counted per hour, not summed over the window", () => {
  const { running } = M.bucketHistory([
    ev("claimed", "0xa", T0 + 10, { leaseUntil: T0 + 3 * HOUR }),
    ev("claimed", "0xb", T0 + 20, { leaseUntil: T0 + HOUR }),
    ev("claimed", "0xc", T0 + HOUR + 10, { leaseUntil: T0 + 2 * HOUR }),
  ], buckets);
  assert.deepEqual(running.slice(0, 4), [2, 2, 1, 0]);
});

test("money buckets split settled, refunded and funded-in by hour", () => {
  const { settled6, refunded6, funded6 } = M.bucketHistory([
    ev("claimed", "0xa", T0 + 10, { leaseUntil: T0 + HOUR, amount6: 1_500_000 }),
    ev("renewed", "0xa", T0 + HOUR + 10, { leaseUntil: T0 + 2 * HOUR, amount6: 500_000 }),
    ev("released", "0xa", T0 + HOUR + 20, { amount6: 200_000 }),
    ev("funded", "0xb", T0 + 30, { amount6: 10_000_000 }),
    ev("fundedEth", "0xb", T0 + 2 * HOUR + 30, { amount6: 4_000_000 }),
    ev("funded", "0xb", T0 - 5, { amount6: 99_000_000 }),          // before the window: ignored
  ], buckets);
  assert.equal(settled6[0], 1_500_000);
  assert.equal(settled6[1], 500_000);
  assert.equal(refunded6[1], 200_000);
  assert.equal(funded6[0], 10_000_000);
  assert.equal(funded6[2], 4_000_000);
  assert.equal(funded6.reduce((a, c) => a + c, 0), 14_000_000, "the pre-window deposit is not counted");
});

test("an empty log yields 24 zeroed buckets, not an empty array", () => {
  const h = M.bucketHistory([], buckets);
  for (const k of ["running", "settled6", "refunded6", "funded6"]) {
    assert.equal(h[k].length, 24);
    assert.ok(h[k].every((v) => v === 0));
  }
});
