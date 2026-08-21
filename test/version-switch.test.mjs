// Owner version changes (setAppRef) — the pure halves of the supervisor's
// in-place upgrade, driven through the SWITCH_SELFTEST seam (same contract as
// SWEEP_SELFTEST/REACH_SELFTEST):
//
//   needsVersionSwitch    — does the audit restart a serving record onto the
//                           ledger's (changed) appRef? Only RUNNING records
//                           switch in place; every other state rides the
//                           normal claim/provision paths.
//   provisionBackoffHolds — a provision-failure cooldown binds to the appRef
//                           that failed: the owner switching versions is a
//                           fresh chance, not the same doomed item on a timer.
//   shareResizeVerdict    — does the audit re-slice a serving record whose
//                           ledger row carries different bought shares
//                           (setShares, ledger rev 6)? Pre-resize-release
//                           records stamp what they serve first; non-running
//                           states ride the normal claim paths.
//
//   run: node --test test/version-switch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function selftest(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", SWITCH_SELFTEST: JSON.stringify(c),
           REACH_SELFTEST: "", ACME_SELFTEST: "", SWEEP_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const V1 = "catalog://0x" + "cd".repeat(32) + "/0";
const V2 = "catalog://0x" + "cd".repeat(32) + "/1";
const NOW = 1700000000000;

test("only a RUNNING record with a genuinely different ledger ref switches in place", async () => {
  const r = await selftest({ switch: [
    { status: "running", localRef: V1, chainRef: V2 },   // the upgrade: switch
    { status: "running", localRef: V1, chainRef: V1 },   // no change
    { status: "claimed", localRef: V1, chainRef: V2 },   // mid-provision: next pass catches it
    { status: "failed",  localRef: V1, chainRef: V2 },   // terminal: the sweep re-claims with the new ref
    { status: "running", localRef: V1, chainRef: "" },   // RPC anomaly: never tear down on a blank ref
    { status: "running", localRef: "", chainRef: V2 },   // no local identity: nothing to compare
  ] });
  assert.deepEqual(r.switch, [true, false, false, false, false, false]);
});

test("a provision-failure cooldown binds to the appRef that failed", async () => {
  const active = { n: 1, until: NOW + 60_000, ref: V1 };
  const r = await selftest({ backoff: [
    { entry: active, nowMs: NOW, appRef: V1 },                          // same version still failing: hold
    { entry: active, nowMs: NOW, appRef: V2 },                          // owner switched versions: fresh chance
    { entry: { ...active, until: NOW - 1 }, nowMs: NOW, appRef: V1 },   // cooldown over
    { entry: { n: 1, until: NOW + 60_000, ref: null }, nowMs: NOW, appRef: V1 },   // legacy entry (no ref): hold
    { entry: null, nowMs: NOW, appRef: V1 },                            // no failure recorded
  ] });
  assert.deepEqual(r.backoff, [true, false, false, true, false]);
});

test("only a RUNNING record whose ledger row carries different shares re-slices", async () => {
  const held = { gpuMilli: 500, cpuMilli: 250 };
  const r = await selftest({ resize: [
    { status: "running", localShares: held, gpuMilli: 500, cpuMilli: 250 },  // unchanged
    { status: "running", localShares: held, gpuMilli: 800, cpuMilli: 400 },  // grow: resize
    { status: "running", localShares: held, gpuMilli: 200, cpuMilli: 100 },  // shrink: resize
    { status: "running", localShares: held, gpuMilli: 0,   cpuMilli: 250 },  // gpu -> cpu-only: resize
    { status: "running", localShares: held, gpuMilli: "500", cpuMilli: "250" }, // BigInt/string ledger decode: unchanged
    { status: "running", gpuMilli: 800, cpuMilli: 400 },                     // pre-resize-release record: stamp first
    { status: "claimed", localShares: held, gpuMilli: 800, cpuMilli: 400 },  // mid-provision: next pass catches it
    { status: "failed",  localShares: held, gpuMilli: 800, cpuMilli: 400 },  // terminal: the sweep re-claims at the new size
  ] });
  assert.deepEqual(r.resize, ["skip", "resize", "resize", "resize", "skip", "stamp", "skip", "skip"]);
});

test("a held id's decline names the stage and the error, keeping the legacy prefix", async () => {
  const cid = "bafybeiedonoeo54wtykum2pytiwnmmnvp55v4y75txmervqy4elxnkqrfm";
  const r = await selftest({ decline: [
    { entry: { n: 2, until: NOW + 5 * 60_000, ref: V1, stage: "prefetch",
               why: `ipfs fetch failed for ${cid}: HTTP 404`, cid }, nowMs: NOW },
    { entry: { n: 1, until: NOW + 60 * 60_000, ref: V1, stage: "provision",
               why: "wasmtime exited 2" }, nowMs: NOW },
    { entry: { n: 1, until: NOW + 5 * 60_000, ref: V1 }, nowMs: NOW },   // legacy entry: no stage/why recorded
  ] });
  // the 2026-08-20 catalog-wasm outage read as a bare "backing off" for hours;
  // the decline must carry the cause so a queued row diagnoses itself
  assert.match(r.decline[0], /^provisioning failed here recently \(prefetch: ipfs fetch failed for bafybeie.*HTTP 404\); backing off ~5min$/);
  assert.match(r.decline[1], /^provisioning failed here recently \(provision: wasmtime exited 2\); backing off ~60min$/);
  assert.equal(r.decline[2], "provisioning failed here recently; backing off ~5min");
});

test("only prefetch-stage holds re-probe the gateway, at most once a minute", async () => {
  const cid = "bafybeiedonoeo54wtykum2pytiwnmmnvp55v4y75txmervqy4elxnkqrfm";
  const pf = { n: 1, until: NOW + 30 * 60_000, ref: V1, stage: "prefetch", why: "HTTP 404", cid };
  const r = await selftest({ probe: [
    { entry: { ...pf, probedAt: 0 }, nowMs: NOW },                         // never probed: due
    { entry: { ...pf, probedAt: NOW - 10_000 }, nowMs: NOW },              // probed 10s ago: wait
    { entry: { ...pf, probedAt: NOW - 120_000 }, nowMs: NOW },             // probed 2min ago: due again
    { entry: { ...pf, stage: "provision" }, nowMs: NOW },                  // crash-loop guard: NEVER probes
    { entry: { ...pf, cid: null }, nowMs: NOW },                           // legacy entry without a cid: can't probe
    { entry: { n: 1, until: NOW + 60_000, ref: V1 }, nowMs: NOW },         // pre-upgrade entry: no stage at all
    { entry: { ...pf, probeClears: 2 }, nowMs: NOW },                      // cleared twice already: one more chance
    // a byte-serving CID that keeps failing the full verified prefetch must
    // not clear-and-redownload forever: after 3 rounds the ladder rules
    { entry: { ...pf, probeClears: 3 }, nowMs: NOW },
  ] });
  assert.deepEqual(r.probe, [true, false, true, false, false, false, true, false]);
});
