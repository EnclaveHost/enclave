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
const { guestCertRetry, nextGuestCertWakeMs, GUEST_CERT_STARTING_MS, GUEST_CERT_STARTING_TRIES } =
  new Function(src.slice(a, b) + "\nreturn { guestCertRetry, nextGuestCertWakeMs, GUEST_CERT_STARTING_MS, GUEST_CERT_STARTING_TRIES };")();

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
