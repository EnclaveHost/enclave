// The metal auto-update POLICY. A metal box cannot be pushed to (CGNAT), so it
// pulls on a timer — which means the decision to restart is taken by a machine
// at 3am with nobody watching. These pin the three rules that make that safe:
// never restart into a release we already run, never restart a busy box without
// a ceiling, and never keep restarting after one has already failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tagNewer, tagCmp, updateVerdict } from "../metal/update.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(REPO, "metal", "build-image.mjs");
const buildImage = (args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [BUILDER, ...args],
      { encoding: "utf8", stdio: "pipe", timeout: 60000 }) };
  } catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` }; }
};

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

test("a busy box updates by default; deferring is opt-in, and bounded when chosen", () => {
  // The default USED to wait for idle, to ration Let's Encrypt duplicates (5
  // per 168h per name) across restarts. App-zone names go to the platform
  // certificate service now — ZeroSSL under the platform EAB, LE only behind
  // it and paced centrally — so a restart no longer spends a scarce thing,
  // and a box must not sit on an old release for a reason that expired.
  assert.equal(updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 3 }).act, "update",
               "tenants alone no longer postpone a release");
  // an operator who wants the old behaviour asks for it...
  const busy = updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 1,
                               onlyWhenIdle: true, deferredSince: 0, now: 1 * HOUR });
  assert.equal(busy.act, "defer");
  assert.match(busy.why, /waiting for idle/);
  // ...with a ceiling, or a box that always has a tenant never takes a fix
  const overdue = updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 1,
                                  onlyWhenIdle: true, deferredSince: 0, now: 7 * HOUR });
  assert.equal(overdue.act, "update");
  assert.match(overdue.why, /updating anyway/);
  // epoch 0 is a real timestamp, not "never deferred" — the ceiling above only
  // fires if the code tests deferredSince against null rather than truthiness
  assert.equal(updateVerdict({ current: "v0.5.1-cpu", latest: "v0.5.2-cpu", running: 1,
                               onlyWhenIdle: true, deferredSince: null, now: 7 * HOUR }).act, "defer");
  // and opting out explicitly is still the same answer as the default
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

// The image the updater installs is only as good as the one the builder makes.
// On 2026-09-04 metal0 built one whose module set was EMPTY — the host was
// running 7.1.6 while /usr/lib/modules held only 7.2.2, an upgrade away — so
// the guest came up with no virtio_net, no network, no relay tunnel and no
// health, and only the rollback saved the box. The builder now takes the
// module version from the kernel it PACKS, and refuses a mismatch outright.
test("the builder resolves modules for the kernel it packs, not the one the host runs", () => {
  const r = buildImage(["--print-kver"]);
  assert.ok(r.ok, `--print-kver should resolve without building: ${r.out.slice(0, 300)}`);
  const j = JSON.parse(r.out.trim().split("\n").pop());
  assert.ok(fs.existsSync(j.modroot), `${j.modroot} must exist — an absent tree is the bug this pins`);
  // the packed kernel and the module tree must be the same kernel: distros
  // keep a copy beside the modules, and that copy is the proof
  const beside = path.join(j.modroot, "vmlinuz");
  if (fs.existsSync(beside))
    assert.equal(Buffer.compare(fs.readFileSync(j.kernel), fs.readFileSync(beside)), 0,
      "packing one kernel with another's modules is what shipped a netless guest");
});

test("a kernel/module mismatch fails the build instead of shipping a module-less initramfs", () => {
  const r = buildImage(["--kver", "9.9.9-does-not-exist", "--print-kver"]);
  assert.equal(r.ok, false, "a missing module tree must be fatal, not a warning");
  assert.match(r.out, /no module tree at/);
  assert.match(r.out, /--kver/, "the refusal says how to fix it");
});
