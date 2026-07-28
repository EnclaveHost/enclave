// The metal auto-update POLICY. A metal box cannot be pushed to (CGNAT), so it
// pulls on a timer — which means the decision to restart is taken by a machine
// at 3am with nobody watching. These pin the three rules that make that safe:
// never restart into a release we already run, never restart a busy box without
// a ceiling, and never keep restarting after one has already failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tagNewer, tagCmp, updateVerdict } from "../metal/update.mjs";

const HOUR = 3600 * 1000;

test("tagNewer compares numerically, not lexically", () => {
  assert.equal(tagNewer("v0.5.9-cpu", "v0.5.10-cpu"), true, "v0.5.10 IS newer than v0.5.9");
  assert.equal(tagNewer("v0.5.10-cpu", "v0.5.9-cpu"), false);
  assert.equal(tagNewer("v0.5.10-cpu", "v0.5.10-cpu"), false, "same tag is not newer");
  assert.equal(tagNewer("v0.5.282", "v0.6.0"), true);
  assert.equal(tagNewer(null, "v0.5.1-cpu"), true, "never built = anything is newer");
});

test("an idle box takes the newest release; a current one does nothing", () => {
  assert.equal(updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 0 }).act, "update");
  assert.equal(updateVerdict({ current: "v0.5.2-cpu", latest: "v0.5.2-cpu", running: 0 }).act, "skip");
  // an OLDER "latest" (a yanked release, a stale API page) must never downgrade
  assert.equal(updateVerdict({ current: "v0.5.3-cpu", latest: "v0.5.2-cpu", running: 0 }).act, "skip");
  assert.equal(updateVerdict({ current: "v0.5.1-cpu", latest: null, running: 0 }).act, "skip");
});

test("a busy box defers, but not forever", () => {
  // Restarting a serving box relaunches its tenant AND burns one ACME issuance
  // for its hostname (5 per 168h), so the default waits for idle...
  const busy = updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 1,
                               deferredSince: 0, now: 1 * HOUR });
  assert.equal(busy.act, "defer");
  assert.match(busy.why, /waiting for idle/);
  // ...with a ceiling, or a box that always has a tenant never takes a fix
  const overdue = updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 1,
                                  deferredSince: 0, now: 7 * HOUR });
  assert.equal(overdue.act, "update");
  assert.match(overdue.why, /updating anyway/);
  // epoch 0 is a real timestamp, not "never deferred" — the ceiling above only
  // fires if the code tests deferredSince against null rather than truthiness
  assert.equal(updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 1,
                               deferredSince: null, now: 7 * HOUR }).act, "defer");
  // an operator who opts out of the idle policy gets the restart immediately
  assert.equal(updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 3,
                               onlyWhenIdle: false }).act, "update");
});

test("a rolled-back update halts the loop until a human clears it", () => {
  // The failure this exists for: a release whose manager passes a flag the
  // guest runtime doesn't know kills every tenant at spawn. Retrying it on a
  // 6h timer turns one bad release into a week of nightly outages.
  const v = updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 0, halted: true });
  assert.equal(v.act, "skip");
  assert.match(v.why, /rolled back/);
  // even the never-built case stays halted — the marker outranks everything
  assert.equal(updateVerdict({ current: null, latest: "v0.5.2-cpu", halted: true }).act, "skip");
});

test("a box that has never been built adopts the newest release", () => {
  const v = updateVerdict({ current: null, latest: "v0.5.2-cpu", running: 0 });
  assert.equal(v.act, "update");
  assert.match(v.why, /first build/);
});

test("the newest tag is picked by numeric order across a whole release list", () => {
  // sort() with `tagNewer(a,b) ? 1 : -1` is not a total order (never 0 for
  // equals) and returned v0.5.268 as the max of a list containing v0.5.282.
  // An updater that silently picks an OLD release is worse than one that
  // does nothing, so the ordering itself is pinned.
  const list = ["v0.5.268-cpu", "v0.5.9-cpu", "v0.5.282-cpu", "v0.5.100-cpu", "v0.4.999-cpu"];
  assert.equal(list.slice().sort(tagCmp).pop(), "v0.5.282-cpu");
  assert.equal(tagCmp("v0.5.282-cpu", "v0.5.282-cpu"), 0, "equal tags must compare 0");
  assert.equal(tagCmp("v0.5.9-cpu", "v0.5.10-cpu"), -1);
  assert.equal(tagCmp("v0.5.10-cpu", "v0.5.9-cpu"), 1);
});
