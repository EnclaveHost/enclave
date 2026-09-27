// The guest-certificate retry policy of supervisor.js (guestCertRetry, nextGuestCertWakeMs), sliced out by text so the
// test runs the production code without starting a supervisor. The case it exists for (2026-09-26, metal-iso0): a
// first launch's first certificate pass ran 2 s after the spawn, got "the instance is starting" from guestd 25 s before
// the guest served, and waited 300 s: 5 of the 8 minutes before the app's public TLS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../supervisor.js", import.meta.url), "utf8");
const a = src.indexOf("const GUEST_CERT_STARTING_MS"), b = src.indexOf("let _guestCertRunning");
assert.ok(a > 0 && b > a, "the policy block is in supervisor.js");
const policy = (text) => new Function(text + "\nreturn { guestCertRetry, nextGuestCertWakeMs, guestCertSkip, guestCertFailure, "
  + "GUEST_CERT_STARTING_MS, GUEST_CERT_STARTING_TRIES };")();
const { guestCertRetry, nextGuestCertWakeMs, guestCertSkip, guestCertFailure, GUEST_CERT_STARTING_MS, GUEST_CERT_STARTING_TRIES } =
  policy(src.slice(a, b));

// the errors the pass sees: routeFor's SpliceRefused for a starting guest; the platform's 202; anything else
const starting = () => Object.assign(new Error("the instance is starting"), { kind: "not-running" });
const inFlight = (sec) => Object.assign(new Error("order for x.app.enclave.host in flight"), { retryMs: sec * 1000 });
const refused = () => new Error("the guest did not verify (refused: …); nothing issued");

test("a guest guestd reports STARTING is retried after 20 s and is not a failure", () => {
  assert.deepEqual(guestCertRetry(starting(), 0, 0), { wait: 20_000, failures: 0, starts: 1 });
  assert.deepEqual(guestCertRetry(starting(), 2, 5), { wait: 20_000, failures: 2, starts: 6 });
});
test("another not-running state (stopped, failed) is a real failure, not a short retry", () => {
  const stopped = Object.assign(new Error("the instance is stopped"), { kind: "not-running" });
  assert.deepEqual(guestCertRetry(stopped, 0, 0), { wait: 300_000, failures: 1, starts: 0 });
});
test("a guest still starting after the short tries stays on the doubling back-off (no cycling back to 20 s)", () => {
  const cap = GUEST_CERT_STARTING_TRIES;
  assert.deepEqual(guestCertRetry(starting(), 0, cap), { wait: 300_000, failures: 1, starts: cap });
  assert.deepEqual(guestCertRetry(starting(), 1, cap), { wait: 600_000, failures: 2, starts: cap });
  // simulated: 31 passes of "starting" give 30 short waits, then only the back-off
  let st = { failures: 0, starts: 0 }; const waits = [];
  for (let i = 0; i < 34; i++) { const r = guestCertRetry(starting(), st.failures, st.starts); waits.push(r.wait); st = r; }
  assert.deepEqual(waits.slice(0, cap), Array(cap).fill(20_000));
  assert.deepEqual(waits.slice(cap), [300_000, 600_000, 1_200_000, 2_400_000]);
  // another answer (a refusal) resets the starting count
  assert.equal(guestCertRetry(refused(), st.failures, st.starts).starts, 0);
});
test("the error's own hint wins (the platform's 202 retryAfterSec)", () => {
  assert.equal(guestCertRetry(inFlight(30), 0, 0).wait, 30_000);
  assert.equal(guestCertRetry(inFlight(30), 3, 0).wait, 30_000);
});
test("real refusals keep the doubling back-off, capped at an hour", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => guestCertRetry(refused(), n - 1, 0).wait),
    [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000]);
});
test("the wake is the first due back-off, or none", () => {
  const now = 1_000_000;
  assert.equal(nextGuestCertWakeMs([], now), null);
  assert.equal(nextGuestCertWakeMs([{ backoffUntil: now - 5 }, { renewAt: now + 9e9 }], now), null);
  assert.equal(nextGuestCertWakeMs([{ backoffUntil: now + 30_000 }, { backoffUntil: now + 20_000 }, null], now), 20_000);
});

// A first launch, simulated on the policy and the wake: the guest spawns at 0 and serves at 25 s; the pass runs at 2 s
// (the spawn's own tick), then at each wake; the platform answers 202 (retry in 30 s) twice, then issues.
test("first launch: the certificate is requested within 20 s of serving, and a 30 s hint is honored at 30 s", () => {
  const SERVES = 25_000; let t = 2_000, st = { failures: 0, starts: 0 }, order = 0; const requests = [];
  for (let i = 0; i < 20; i++) {
    let e = null;
    if (t < SERVES) e = starting();
    else { requests.push(t); if (order++ < 2) e = inFlight(30); }
    if (!e) break;                                            // issued
    const r = guestCertRetry(e, st.failures, st.starts);
    st = { failures: r.failures, starts: r.starts, backoffUntil: t + r.wait };
    t += nextGuestCertWakeMs([st], t) + 100;                  // the loop wakes when the back-off ends (+100 ms)
  }
  assert.ok(requests[0] - SERVES <= 20_000, `first request ${requests[0] - SERVES} ms after serving`);
  assert.ok(requests[1] - requests[0] <= 30_500 && requests[2] - requests[1] <= 30_500, `in-flight retries ${requests[1] - requests[0]}, ${requests[2] - requests[1]} ms`);
  assert.equal(requests.length, 3);
});

// enclave-5d's should-fix (enclave-87: required): the back-off and its counts belong to the INSTANCE. guestd replaced a
// guest that was failing (40 minutes of back-off left, its 30 short tries and 4 failures spent) with a new instance,
// which spawns at 0 and serves at 25 s. Passes run at the loop's ticks (2 s, then every 60 s) and at each wake.
function relaunch({ guestCertSkip, guestCertFailure, nextGuestCertWakeMs }) {
  const OLD = "gdold", NEW = "gdnew", SERVES = 25_000;
  let st = { instanceId: OLD, backoffUntil: 2_400_000, failures: 4, starts: 30, why: "the instance is starting" };
  let t = 2_000, first = null; const asked = [];
  while (t < 3_700_000) {
    if (!guestCertSkip(st, NEW, t)) {
      asked.push(t);
      if (t >= SERVES) return { afterServing: t - SERVES, asked, first };   // it serves: the certificate is issued
      st = guestCertFailure(st, NEW, starting(), t).entry;
      first = first || st;
    }
    const w = nextGuestCertWakeMs([st], t), tick = 2_000 + 60_000 * (Math.floor((t - 2_000) / 60_000) + 1);
    t = w !== null && w < 60_000 ? Math.min(tick, t + w + 100) : tick;
  }
  return { afterServing: null, asked, first };
}
test("a relaunched guest does not inherit its predecessor's back-off: asked at once, certified within 20 s of serving", () => {
  const r = relaunch({ guestCertSkip, guestCertFailure, nextGuestCertWakeMs });
  assert.equal(r.asked[0], 2_000, "the new instance is asked at the first pass");
  assert.deepEqual({ instanceId: r.first.instanceId, failures: r.first.failures, starts: r.first.starts }, { instanceId: "gdnew", failures: 0, starts: 1 });
  assert.ok(r.afterServing !== null && r.afterServing <= 20_000, `requested ${r.afterServing} ms after serving`);
  // the same instance still honors its own back-off and a fresh certificate
  assert.equal(guestCertSkip({ instanceId: "g", backoffUntil: 10 }, "g", 5), true);
  assert.equal(guestCertSkip({ instanceId: "g", renewAt: 10 }, "g", 5), true);
  assert.equal(guestCertSkip({ instanceId: "g", backoffUntil: 10, renewAt: 20 }, "g", 15), true);
  assert.equal(guestCertSkip({ instanceId: "g", backoffUntil: 10 }, "h", 5), false);
  assert.equal(guestCertSkip(undefined, "g", 5), false);
  // the same instance keeps its counts and its installed fields on a failure
  const e1 = guestCertFailure({ instanceId: "g", key: "k", renewAt: 1, failures: 2, starts: 0 }, "g", refused(), 100).entry;
  assert.deepEqual([e1.instanceId, e1.key, e1.failures, e1.backoffUntil], ["g", "k", 3, 100 + 1_200_000]);
});
// The mutants: the REAL source with one half of the fix undone must fail the relaunch (each half alone matters).
test("mutants: undoing either half of the instance keying makes the relaunch wait out the old back-off", () => {
  const block = src.slice(a, b);
  const mutants = {
    "skip ignores the instance": ["if (!st || st.instanceId !== vmId) return false;", "if (!st) return false;"],
    "counts inherited": ["same ? st.failures || 0 : 0, same ? st.starts || 0 : 0", "st && st.failures || 0, st && st.starts || 0"],
  };
  for (const [name, [from, to]] of Object.entries(mutants)) {
    assert.equal(block.split(from).length, 2, `${name}: the mutated text is in the block exactly once`);
    const r = relaunch(policy(block.replace(from, to)));
    assert.ok(r.afterServing === null || r.afterServing > 20_000, `${name}: the mutant still certified within 20 s (${r.afterServing})`);
  }
});
