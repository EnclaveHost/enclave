// relay/fleet-status.mjs: a row's state in one word, and a reason derived from the row's own
// evidence rather than from its mode.
//
// The incident these pin: nucbox-k11 was attached, answering inference end to end and healthy, and
// the panel could only say "not serving" -- the same thing it says about a box that has gone away --
// with one sentence about the VBS class rather than about that box. An operator could not tell an
// outage from an admission decision, nor what to fix.
import test from "node:test";
import assert from "node:assert/strict";
import { hostStatus, ineligibleReason, claimBlockReason } from "../relay/fleet-status.mjs";

const NOW = 1790265600;
const nucbox = (over = {}, availOver = {}) => ({
  name: "nucbox-k11", tunnel: true, mode: "vbs", tier: "vbs-dev", lastSeen: NOW - 60,
  availability: {
    ok: true, teeCpu: "windows-vbs-enclave", claimEnabled: false,
    apps: { inTee: true, isolation: "vbs-enclave", running: 0, capacity: 8 },
    appTls: { served: true, keyIn: "host-process", terminatesIn: "host-process" },
    session: { keyIn: "host-process", alg: "ES256" },
    ...availOver,
  },
  ...over,
});

test("online-but-excluded is not the same state as offline", () => {
  const live = nucbox();
  assert.equal(hostStatus(live, { serving: false, nowSec: NOW }), "online");
  assert.equal(hostStatus(live, { serving: true, nowSec: NOW }), "serving");
  // silent for longer than the staleness window: that IS an outage, and reads as one
  assert.equal(hostStatus(nucbox({ lastSeen: NOW - 7200 }), { serving: false, nowSec: NOW, staleAfterSec: 3600 }), "offline");
  // a dialed row the relay has never heard from
  assert.equal(hostStatus({ name: "x", tunnel: false, lastSeen: 0 }, { nowSec: NOW }), "offline");
  assert.equal(hostStatus(null), "offline");
});

test("the reason names what is missing ON THIS BOX, not the class it belongs to", () => {
  const r = ineligibleReason(nucbox(), { eligible: false });
  assert.match(r, /app TLS terminates in the host-process/);
  assert.match(r, /app-zone TLS key is in the host-process/);
  assert.match(r, /session-signing key is in the host-process/);
  assert.match(r, /tier vbs-dev/, "the development tier is part of why, and is named");
  // the disclosure is kept, and it is about properties, never about an operating system
  assert.doesNotMatch(r, /Windows|windows/, "an OS name is not a reason");
  assert.match(r, /verified enclave report/, "what the box DID prove is still said");
});

test("a box that fixes one property gets a shorter reason, so progress is visible", () => {
  const partlyFixed = nucbox({ tier: "vbs" }, {
    appTls: { served: true, keyIn: "enclave", terminatesIn: "enclave" },
    session: { keyIn: "host-process", alg: "ES256" },
  });
  const r = ineligibleReason(partlyFixed, { eligible: false });
  assert.doesNotMatch(r, /app TLS terminates/);
  assert.doesNotMatch(r, /app-zone TLS key/);
  assert.doesNotMatch(r, /tier vbs-dev/);
  assert.match(r, /session-signing key is in the host-process/, "what remains is still named");
});

test("a box's own word that it meets the contract is not evidence, and does not read as a pass", () => {
  const selfReported = nucbox({ tier: "vbs" }, {
    apps: { inTee: true, isolationContract: true, running: 0, capacity: 8 },
    appTls: { served: true, keyIn: "enclave", terminatesIn: "enclave" },
    session: { keyIn: "enclave", alg: "ES256" },
  });
  const r = ineligibleReason(selfReported, { eligible: false });
  assert.match(r, /the relay holds no evidence/);
  assert.match(r, /a box's own word is not evidence/);
  // and the caller's verdict still governs: a row the relay DID admit has no reason at all
  assert.equal(ineligibleReason(selfReported, { eligible: true }), null);
});

test("the node's own stated gap is carried through when it publishes one", () => {
  const withGap = nucbox({}, { apps: { inTee: true, contractGap: "app-zone TLS key and traffic run through the host OS; tier vbs-dev" } });
  assert.match(ineligibleReason(withGap, { eligible: false }), /app-zone TLS key and traffic run through the host OS/);
});

test("every other row keeps the reason it had", () => {
  assert.equal(ineligibleReason({ relay: true }, { eligible: false }), "carries traffic only");
  assert.match(ineligibleReason({ tunnel: true, mode: "avf" }, { eligible: false }), /no pVM CPU capability report admitted yet/);
  assert.match(ineligibleReason({ tunnel: true, mode: "avf", capsRefused: true }, { eligible: false }), /capability report was refused/);
  assert.match(ineligibleReason({ tunnel: true, mode: "avf" }, { eligible: false, lane: "pvm-cpu" }), /inference lane on its owner's phone/);
  assert.match(ineligibleReason({ tunnel: true, mode: "token" }, { eligible: false }), /no hardware quote verified/);
  assert.match(ineligibleReason({ tunnel: false, availability: { teeCpu: "windows-vbs-enclave" } }, { eligible: false }),
               /presents windows-vbs-enclave, not a confidential CPU/);
  assert.match(ineligibleReason({ tunnel: false, availability: { teeCpu: "x", gpu: true } }, { eligible: false }),
               /exposed only through Enclave Shield/);
  assert.match(ineligibleReason({ tunnel: false, availability: {} }, { eligible: false }), /never named its CPU technology/);
});

test("a box that takes no work at all says why, and an empty operator key is a reason", () => {
  // the incident, exactly: attached, healthy, answering inference, claimEnabled false, and the
  // operator key on Base holding less than one renewal's gas.
  const outOfGas = nucbox({}, { claimEnabled: false, gasRenewalsLeft: 0 });
  const r = claimBlockReason(outOfGas);
  assert.match(r, /operator key is out of gas/);
  assert.match(r, /neither claim a lease nor renew one/, "both halves: nothing new starts and nothing already held survives");
  assert.match(r, /^it reports/, "the box states this; the relay has not checked the chain, and the wording admits it");
});

test("not-claiming is a separate axis from not-eligible, and neither stands in for the other", () => {
  // claiming, but the relay does not admit its evidence: no claim reason, and the eligibility one stands
  const claiming = nucbox({}, { claimEnabled: true, gasRenewalsLeft: 500 });
  assert.equal(claimBlockReason(claiming), null);
  assert.match(ineligibleReason(claiming, { eligible: false }), /app TLS terminates/);
  // and a row the relay WOULD admit can still be taking nothing
  assert.match(claimBlockReason(nucbox({}, { claimEnabled: false, gasRenewalsLeft: 0 })), /out of gas/);
});

test("the other things a box can say about not claiming each get their own words", () => {
  const say = (over) => claimBlockReason(nucbox({}, { claimEnabled: false, ...over }));
  assert.match(say({ registered: false }), /not registered on the ledger/);
  assert.match(say({ ok: false }), /unhealthy/);
  assert.match(say({ apps: { inTee: true, isolationContract: false } }), /does not meet the isolation contract/);
  assert.match(say({}), /without saying why/, "silence is reported as silence, not invented");
  assert.equal(claimBlockReason({}), null, "a row that says nothing about claiming gets no sentence");
});
