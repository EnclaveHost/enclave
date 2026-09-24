// What the PUBLIC app-host list is allowed to show.
//
// The incident. On 2026-09-23 the nucbox-k11 operator key ran out of Base gas, its five leases
// lapsed, and the relay was already excluding it from tenant compute (a VBS enclave whose app-zone
// TLS key and session key live in the host process is verified evidence for a different contract,
// not for this one). All of that is true and all of it is published. And for a day and a half the
// public list headed "what can I deploy on right now" showed that PC anyway, with a paragraph of
// security caveats where its capacity should have been - because the component kept an explicit
// exception for a consumer node at serving:false and printed e.ineligible underneath.
//
// The rule now: a row appears only when the relay's own current verdict says a deployment can land
// on it. Everything else is left out rather than explained. The evidence is not deleted - it is in
// /enclaves (status, eligible, ineligible, notClaiming) and in the architecture page's prose - it is
// just not a row in a list of machines a reader is about to buy from.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appHostVisible, HOST_STALE_AFTER_SEC } from "../site/js/core/pricing.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 1790266080;

// THE EXACT LIVE ROW, copied from https://api.enclave.host/enclaves on 2026-09-24T16:10Z.
// Attached, healthy, answering, tunnel mode vbs, operator key empty, relay verdict eligible:false.
const nucbox = {
  endpoint: "tunnel://nucbox-k11", name: "nucbox-k11", repo: "EnclaveHost/enclave",
  lastSeen: 1790266080, tunnel: true, mode: "vbs", tier: "vbs-dev",
  serving: false, eligible: false,
  ineligible: "verified enclave report, but the app-zone key and traffic run through the host: the isolation contract is not met",
  availability: {
    ok: true, role: "windows-vbs-node", gpu: false, teeCpu: "windows-vbs-enclave", tier: "vbs-dev",
    claimEnabled: false, gasRenewalsLeft: 0, registered: true, cpuShareFree: 0.75, nodeSlotsFree: 8,
    apps: { isolation: "vbs-enclave", inTee: true, running: 0, capacity: 8, scope: "market" },
    appTls: { served: true, keyIn: "host-process", terminatesIn: "host-process" },
    session: { keyIn: "host-process", alg: "ES256" },
    shielded: { worker: "vulkan", device: "AMD Radeon 780M Graphics", vramGb: 16, vramBudgetGb: 8, vramFreeGb: 8 },
  },
};

// A box that really is selling: serving, and the relay says eligible.
const selling = { name: "kryptos", tunnel: true, mode: "snp", lastSeen: NOW - 30, serving: true, eligible: true,
                  availability: { ok: true, gpu: true, teeCpu: "amd-sev-snp", gpuShareFree: 0.5, maxShare: 0.9, claimEnabled: true } };
const relayRow = { name: "us-west", relay: true, lastSeen: NOW - 30, serving: false,
                   availability: { relay: { sni: true, tunnelHub: true } } };

test("the live nucbox row - online, no gas, eligible:false, serving:false - is not in the public list", () => {
  assert.equal(appHostVisible(nucbox, NOW), false);
  // and not for any single reason alone: fix only the gas and it is still excluded
  assert.equal(appHostVisible({ ...nucbox, serving: true }, NOW), false, "eligible:false still excludes it");
  // ...fix only the relay verdict and it is still excluded, because it is taking no work
  assert.equal(appHostVisible({ ...nucbox, eligible: true }, NOW), false, "serving:false still excludes it");
  // both, and it belongs there
  assert.equal(appHostVisible({ ...nucbox, serving: true, eligible: true }, NOW), true);
});

test("a box's own word never overrides the relay's serving verdict", () => {
  const boasting = { ...nucbox, eligible: true, serving: false,
                     availability: { ...nucbox.availability, claimEnabled: true } };
  assert.equal(appHostVisible(boasting, NOW), false,
               "availability.claimEnabled is the BOX talking about itself; serving is the relay's answer");
});

test("a serving, eligible host is shown", () => {
  assert.equal(appHostVisible(selling, NOW), true);
});

test("relay-only rows are never app hosts", () => {
  assert.equal(appHostVisible(relayRow, NOW), false);
  assert.equal(appHostVisible({ ...relayRow, serving: true, eligible: true }, NOW), false,
               "relay:true is decided before anything else: it sells no compute at all");
});

test("unknown and unconfirmed are not yes", () => {
  assert.equal(appHostVisible({ name: "old", lastSeen: NOW, availability: { teeCpu: "amd-sev-snp" } }, NOW), false,
               "no serving verdict at all: a missing answer is not a yes");
  assert.equal(appHostVisible({ name: "x", serving: true, lastSeen: NOW, availability: {} }, NOW), false,
               "serving but nothing said about its CPU technology: unconfirmed eligibility");
  assert.equal(appHostVisible(null, NOW), false);
  assert.equal(appHostVisible(undefined, NOW), false);
});

test("an older relay that sends no eligible field is judged on the same evidence", () => {
  const { eligible, ...noVerdict } = { ...selling };
  assert.equal(appHostVisible({ ...noVerdict, serving: true }, NOW), true, "a confidential CPU still qualifies");
  const phone = { name: "pixel", tunnel: true, mode: "avf", serving: true, lastSeen: NOW,
                  availability: { teeCpu: "android-pvm" } };
  assert.equal(appHostVisible(phone, NOW), false, "verified evidence for a DIFFERENT contract is not this one");
});

test("stale and offline rows drop out even if they were serving when last heard", () => {
  assert.equal(appHostVisible({ ...selling, lastSeen: NOW - HOST_STALE_AFTER_SEC - 1 }, NOW), false);
  assert.equal(appHostVisible({ ...selling, lastSeen: NOW - HOST_STALE_AFTER_SEC + 1 }, NOW), true, "just inside the window is still live");
  assert.equal(appHostVisible({ ...selling, lastSeen: 0 }, NOW), true,
               "a row with no lastSeen at all is left to the relay, which already drops silent rows");
});

// The component, pinned: the predicate is only worth anything if the list actually calls it, and
// the two exceptions that caused this are gone rather than merely unreachable.
test("the fleet list filters on that rule and keeps no exceptions (pinned in source)", () => {
  const src = fs.readFileSync(path.join(ROOT, "site/components/fleet-list/fleet-list.js"), "utf8");
  assert.match(src, /const rows = \(this\.rows \|\| \[\]\)\.filter\(\(e\) => appHostVisible\(e\)\);/,
               "one filter, the shared rule, no local variant");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /e\.ineligible/, "the security paragraph is not printed in the sales list");
  assert.doesNotMatch(code, /consumerNode\s*\(/, "the consumer-node exception is gone, not just unreachable");
  assert.doesNotMatch(code, /e\.relay === true/, "relay-only rows are filtered out, not rendered");
  assert.doesNotMatch(code, /availability\?\.claimEnabled|a\.claimEnabled/, "the box's own claim flag decides nothing here");
  assert.match(src, /No app hosts available right now/, "and the empty state says so plainly");
});

test("every public consumer feeds the component the same unfiltered relay rows (pinned in source)", () => {
  for (const page of ["site/js/pages/host.js", "site/js/pages/architecture.js", "site/js/pages/dashboard.js"]) {
    const src = fs.readFileSync(path.join(ROOT, page), "utf8");
    assert.match(src, /fl\.rows = \(j\.enclaves \|\| \[\]\)/, `${page} assigns the relay's rows`);
    assert.doesNotMatch(src, /\.filter\(\s*\(?e\)?\s*=>\s*e\.serving/, `${page} must not keep its own visibility rule`);
  }
});
