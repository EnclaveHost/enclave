// The hardware canary's own steps, against the fake host: what it reports as a pass must be a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCanary } from "./launcher-canary.mjs";
import { TYPE1, PREFLIGHT_OK, VM_ID, defineAnswer, processorAnswer, keyOf } from "../fake-hyperv.mjs";

const SHA = "a44bb55a89bb0e6d2757287032070662041a0952eaf3713901cedc92404717e4";
const cfg = { ...TYPE1, imagePath: "C:\\Users\\claude\\vbs-like\\pkg\\x\\guest\\igvm-vbs\\c.bin", imageSha256: SHA,
              prefix: "enclave-mgrcanary-", memMiB: 2048, vcpus: 1 };

/** A host that keeps its VMs: define adds one (with the Notes it was asked for), removeById drops it. */
function host({ removeFails = false, silent = false, head = "MON ready" } = {}) {
  const vms = new Map();
  const run = async (s) => {
    const k = keyOf(s);
    const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
    if (k === "preflight") return ok(PREFLIGHT_OK);
    if (k === "imageHash") return ok({ present: true, sha256: SHA, bytes: 77794396 });
    if (k === "define") { const a = defineAnswer(s); vms.set(a.id, { vmId: a.id, name: a.name, state: "Off", notes: a.notes }); return ok(a); }
    if (k === "processor") return ok(processorAnswer(s));
    if (k === "startAndRead") { for (const v of vms.values()) v.state = "Running";
      return ok({ state: "Running", console: { connected: true, bytes: silent ? 0 : 613, head: silent ? "" : head, sawUntil: !silent } }); }
    if (k === "readConsole") return ok({ connected: true, bytes: silent ? 0 : 613, head: silent ? "" : "MON ready" });
    if (k === "survey") return ok({ vms: [...vms.values()] });
    if (k === "removeById" || k === "removeExact") {
      if (removeFails) return ok({ found: true, removed: false, error: "InvalidState" });
      const had = vms.size > 0; vms.clear(); return ok({ found: had, removed: had });
    }
    if (k === "retire") return ok({ present: true, retired: true });
    return ok({ ok: true });
  };
  return { run, vms };
}

async function go(h) { const lines = []; const r = await runCanary({ run: h.run, cfg, say: (o) => lines.push(o), guestReadySec: 1 }); return { r, lines }; }

test("a host that does what it is asked: every step holds, and the canary says so", async () => {
  const h = host();
  const { r, lines } = await go(h);
  assert.equal(r, true, JSON.stringify(lines));
  assert.deepEqual(lines.map((l) => l.step), ["preflight", "start", "survey", "stop", "survey-after", "result"]);
  const sv = lines.find((l) => l.step === "survey");
  assert.equal(sv.vm.vmId, VM_ID); assert.match(sv.identity.id, /^hv[0-9a-f]{32}$/);
  assert.equal(h.vms.size, 0);
});

test("a VM the launcher could not remove is a FAILED canary, and survey-after names it", async () => {
  const { r, lines } = await go(host({ removeFails: true }));
  assert.equal(r, false);
  assert.equal(lines.find((l) => l.step === "stop").ok, false);
  const after = lines.find((l) => l.step === "survey-after");
  assert.equal(after.ok, false); assert.equal(after.left.length, 1);
});

test("a silent guest fails start, the launcher's own cleanup removes it, and nothing is left", async () => {
  const h = host({ silent: true });
  const { r, lines } = await go(h);
  assert.equal(r, false);
  assert.match(lines.find((l) => l.step === "error").error, /silent partition/);
  assert.equal(lines.find((l) => l.step === "survey-after").ok, true);
  assert.equal(h.vms.size, 0);
});

test("a share-sized canary (16 VPs pool, 21%) passes only when Hyper-V AND the guest show 4 VPs at 84%", async () => {
  const sized = { ...cfg, cpuPoolVcpus: 16, cpuShare: .21 };
  const run1 = async (h) => { const lines = []; const r = await runCanary({ run: h.run, cfg: sized, say: (o) => lines.push(o), guestReadySec: 1 }); return { r, lines }; };
  const good = await run1(host({ head: "\nMON snp=0 vcpus=4 memMiB=1833 boot_ms=300\nMON ready" }));
  assert.equal(good.r, true, JSON.stringify(good.lines));
  const c = good.lines.find((l) => l.step === "cpu");
  assert.deepEqual(c.want, { vcpus: 4, limit: 84000, reservation: 84000 });
  assert.deepEqual([c.readback.vcpus, c.readback.limit, c.readback.reservation], [4, 84000, 84000]);
  for (const head of ["\nMON snp=0 vcpus=1 memMiB=1833 boot_ms=300\nMON ready", "MON ready"]) {
    const bad = await run1(host({ head }));
    assert.equal(bad.r, false, `${JSON.stringify(head)}: a guest that does not show every VP online is not an SMP pass`);
    assert.equal(bad.lines.find((l) => l.step === "cpu").ok, false);
    assert.equal(bad.lines.find((l) => l.step === "survey-after").ok, true, "and its VM is still removed");
  }
});
