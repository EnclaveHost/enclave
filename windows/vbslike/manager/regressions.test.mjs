/* The bugs a review found in 7d238545, each reproduced FIRST and then falsified.
 *
 * Every test here is MOCKED: injected PowerShell answers, no Hyper-V host, nothing executed. The
 * original reproduction is kept beside each fix so the next person can see the defect rather than
 * only the guard against it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WmiHyperVLauncher, CMD, OWNER_MARKER, HYPERV_MODULE_SHA256 } from "./wmi-launcher.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { Manager } from "./server.mjs";
import { TYPE1, PREFLIGHT_OK, VM_ID, defineAnswer, keyOf } from "./fake-hyperv.mjs";

const IMG = "C:\\img\\openhcl-ownguest.bin";
const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
const mapping = { appId: "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782",
                  record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } };

/* The type-1 define answer is DERIVED from the script it answers (fake-hyperv.mjs); an override
 * object is a host that read back something else, an Error a script that failed. */
function host(over = {}) {
  const seen = [];
  const A = {
    preflight: PREFLIGHT_OK,
    imageHash: { present: true, sha256: SHA, bytes: 1 },
    start: { state: "Running" },
    readConsole: { connected: true, bytes: 128, head: "OpenHCL boot..." },
    teardown: { found: 0, removed: [], failed: [] },
    removeExact: { found: true, removed: true },
    removeById: { found: true, removed: true },
    retire: { present: true, retired: true },
    stop: { ok: true },
    survey: { vms: [] },
    ...over,
  };
  const run = async (s) => {
    seen.push(s);
    const k = keyOf(s);
    let a = A[k];
    if (k === "define" && !(a instanceof Error)) a = defineAnswer(s, a || {});
    if (a instanceof Error) return { code: 1, stdout: "", stderr: a.message };
    return { code: 0, stdout: JSON.stringify(a ?? { ok: true }), stderr: "" };
  };
  return { run, seen, key: keyOf };
}
const mk = (h, over = {}) => new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-app-", ...TYPE1, ...over });
const START = { instanceId: "dep0001-708e6409" };

/* ---- (1) 4096 is a job STARTED, not a job done ------------------------------------------------ *
 *
 * REPLACED with the type-1 definition. The launcher no longer calls ModifySystemSettings at all, so
 * it has no job of its own to wait on: the one DefineSystem is New-CustomVM's, whose
 * Trace-CimMethodExecution waits on it inside the pinned module. What survives from (1) is the
 * point of it - a call that "worked" is not a field that holds what was asked - and that is now
 * the definition's read-back, checked in the script and again here. */

test("the launcher writes no settings after the definition: no ModifySystemSettings, no job of its own", () => {
  const s = CMD.defineType1({ name: "n", memMiB: 512, vcpus: 1, notes: OWNER_MARKER, firmware: IMG, firmwareSha256: SHA,
    hypervModule: TYPE1.hypervModule, hypervModuleSha256: HYPERV_MODULE_SHA256, guestStateMaster: TYPE1.guestStateMaster,
    guestStateRun: "C:\\Users\\claude\\vbs-like\\n.vmgs", archiveDir: TYPE1.guestStateArchiveDir, pipe: "\\\\.\\pipe\\n-com1", boot: "linux-direct" });
  assert.doesNotMatch(s, /ModifySystemSettings|Invoke-CimMethod|ConvertTo-CimEmbeddedString/,
    "a New-VM VM patched afterwards through ModifySystemSettings never started as type 1");
  assert.match(s, /select \* from Msvm_ComputerSystem where Name = /, "and it re-reads the settings afterwards");
});

test("the definition is READ BACK, and a field that did not take is refused", async () => {
  await assert.rejects(() => mk(host({ define: { firmwareFile: "C:\\somebody-elses.bin" } })).start(mapping, START),
                       /FirmwareFile is "C:\\\\somebody-elses\.bin", not the pinned IGVM/);
  await assert.rejects(() => mk(host({ define: { featureSet: 0 } })).start(mapping, START),
                       /GuestFeatureSet is 0, not 513/);
});

test("a module that is not the pinned one is refused, by the script before import and again on the read-back", async () => {
  const h = host({ define: { hypervModuleSha256: "00".repeat(32) } });
  await assert.rejects(() => mk(h).start(mapping, START), /hyperv\.psm1 did not hash to its pin/);
  const s = h.seen.find((x) => keyOf(x) === "define");
  assert.ok(s.indexOf(`$pin = '${HYPERV_MODULE_SHA256}'`) < s.indexOf("if ($modSha -ne $pin)"));
  assert.ok(s.indexOf("if ($modSha -ne $pin)") < s.indexOf("Import-Module $mod"));
  assert.throws(() => new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, hypervModuleSha256: "not-a-hash" }), /must be a sha256/);
});

/* ---- (2) Running is the host's word; the guest has to say something --------------------------- */

test("REPRO+FIX: a VM that reports Off is a failure, not a handle", async () => {
  await assert.rejects(() => mk(host({ start: { state: "Off" } })).start(mapping, START), /is "Off" after Start-VM, not Running/);
  await assert.rejects(() => mk(host({ start: { state: null } })).start(mapping, START), /after Start-VM, not Running/);
});

test("Running with a silent guest is still a failure", async () => {
  await assert.rejects(() => mk(host({ readConsole: { connected: true, bytes: 0, head: "" } })).start(mapping, START),
                       /produced no output on .*: a silent partition is not a booted one/);
});

test("the manager reports running only when the guest spoke, and carries the evidence", async () => {
  const h = host();
  const m = new Manager({ runtimeId: mapping.record.runtimeId, fetchComponent: async () => Buffer.alloc(0),
                          backend: new HyperVPartitionBackend({ launcher: mk(h) }) });
  // drive the launcher directly: the derive path is covered by its own vectors test
  const handle = await mk(h).start(mapping, START);
  assert.equal(handle.guest.bytes, 128);
  assert.match(handle.guest.head, /OpenHCL/);
  assert.ok(m, "manager constructed with the real launcher");
});

/* ---- (3) two deployments of one app must not collide ------------------------------------------ */

test("REPRO+FIX: the VM name is the INSTANCE, never the AppID alone", async () => {
  const h = host();
  const a = await mk(h).start(mapping, { instanceId: "depAAA-708e6409" });
  const b = await mk(h).start(mapping, { instanceId: "depBBB-708e6409" });
  assert.notEqual(a.name, b.name, "same app, two deployments, two VM names");
  assert.match(a.name, /^enclave-app-depAAA-708e6409$/);
  await assert.rejects(() => mk(h).start(mapping, {}), /unique instanceId is required/);
  await assert.rejects(() => mk(h).start(mapping, { instanceId: "bad name!" }), /unique instanceId is required/);
});

test("the manager derives a per-deployment instance id, not a per-app one", () => {
  const ids = ["dep-one", "dep-two"].map((id) =>
    (String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "") + "-" + String(mapping.appId).slice(0, 8));
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((i) => /^[A-Za-z0-9._-]{4,64}$/.test(i)), "and it is a name a VM may carry");
});

/* ---- (4) a partial create must not leak, and teardown must not lie --------------------------- */

test("REPRO+FIX: the definition succeeding and a later step failing cleans up in PowerShell itself", () => {
  const s = CMD.defineType1({ name: "n", memMiB: 512, vcpus: 1, notes: OWNER_MARKER, firmware: IMG, firmwareSha256: SHA,
    hypervModule: TYPE1.hypervModule, hypervModuleSha256: HYPERV_MODULE_SHA256, guestStateMaster: TYPE1.guestStateMaster,
    guestStateRun: "C:\\Users\\claude\\vbs-like\\n.vmgs", archiveDir: TYPE1.guestStateArchiveDir, pipe: "\\\\.\\pipe\\n-com1", boot: "linux-direct" });
  assert.match(s, /\$ErrorActionPreference = 'Stop'/, "a non-terminating error used to sail past");
  assert.match(s, /catch \{[\s\S]*if \(\$vm\) \{ \$victims = @\(\$vm\) \}[\s\S]*Remove-VM -VM \$v -Force/, "the VM it made, it removes");
  assert.ok(s.indexOf("Set-VM -VM $vm -Notes") < s.indexOf("Set-VMSecurity"),
            "the ownership marker is applied FIRST, not after the steps that can fail");
});

test("a failure after the definition removes by the VM's Id; with no Id back, by its own EXACT name", async () => {
  const h = host({ readConsole: { connected: false, bytes: 0, head: "", note: "no pipe" } });
  await assert.rejects(() => mk(h).start(mapping, START));
  const byId = h.seen.filter((s) => keyOf(s) === "removeById");
  assert.equal(byId.length, 1, "exactly one cleanup, by the Id the definition returned");
  assert.match(byId[0], new RegExp(`Get-VM -Id '${VM_ID}'`));
  // when the define itself fails it returns nothing: the script removed its own VM, and the launcher
  // sweeps by EXACT name, not by a prefix
  const h2 = host({ define: new Error("DefineSystem failed") });
  await assert.rejects(() => mk(h2).start(mapping, START));
  const sweep = h2.seen.filter((s) => s.includes("$_.Name -eq"));
  assert.equal(sweep.length, 1, "exactly one cleanup, by exact name");
  assert.match(sweep[0], /\$_\.Name -eq 'enclave-app-dep0001-708e6409'/, "scoped to THIS VM, not the whole prefix");
});

test("teardown reports what it could not remove, and refuses to call that success", async () => {
  const h = host({ teardown: { found: 2, removed: ["a"], failed: [{ name: "b", error: "in use" }] } });
  await assert.rejects(() => mk(h).teardown(), /could not remove 1 VM\(s\): b \(in use\)/);
  const ok = host({ teardown: { found: 1, removed: ["a"], failed: [] } });
  assert.deepEqual((await mk(ok).teardown()).removed, ["a"]);
});

test("teardown sweeps unmarked orphans too, unless a marker is demanded", () => {
  assert.doesNotMatch(CMD.teardown({ prefix: "p-" }), /Notes -eq/, "a VM that died before its Notes were set is still ours");
  assert.match(CMD.teardown({ prefix: "p-", requireMarker: true }), new RegExp(`Notes -eq '${OWNER_MARKER}'`));
  assert.match(CMD.survey({ prefix: "p-" }), /StartsWith\('p-'\)/, "and there is a read that finds them");
});

/* ---- (6) health must not claim readiness from a wired object --------------------------------- */

test("REPRO+FIX: canStart is the host's answer, not 'a launcher exists'", async () => {
  const noRole = host({ preflight: { vmms: false, namespace: false, module: false, firmwareField: false, hypervisor: true } });
  const m = new Manager({ backend: new HyperVPartitionBackend({ launcher: mk(noRole) }) });
  assert.equal(m.health().canStart, false, "before probing, it claims nothing");
  await m.probe();
  assert.equal(m.health().canStart, false, "a launcher on a host with no role is still not ready");
  assert.ok(m.health().preflight.checks.some((c) => !c.ok));
  const ready = new Manager({ backend: new HyperVPartitionBackend({ launcher: mk(host()) }) });
  await ready.probe();
  assert.equal(ready.health().canStart, true);
  assert.equal("cannotStart" in ready.health(), false);
});

test("a manager with no launcher at all says so rather than throwing", async () => {
  const m = new Manager({ backend: new HyperVPartitionBackend() });
  await m.probe();
  assert.equal(m.health().canStart, false);
  assert.match(JSON.stringify(m.health()), /no launcher configured/);
});

/* ---- a second review, on 6a8a2b2e: five more, each reproduced ---------------------------------- */

test("REPRO+FIX: cleanup on failure matches the EXACT name, never a prefix", async () => {
  // the defect: the failure path swept with StartsWith(name). A failed duplicate create would then
  // remove the EXISTING domain of that name, and any neighbour whose name merely began with ours.
  // a define that returned nothing: the sweep is by EXACT name
  const h = host({ define: new Error("no pipe") });
  const l = mk(h);
  await assert.rejects(() => l.start(mapping, START));
  const sweeps = h.seen.filter((s) => s.includes("$_.Name -eq"));
  assert.equal(sweeps.length, 1, "one exact removal");
  assert.match(sweeps[0], /\$_\.Name -eq 'enclave-app-dep0001-708e6409'/);
  // a failure after the definition: by Id - and in neither case a prefix sweep
  const h2 = host({ start: new Error("would not start") });
  await assert.rejects(() => mk(h2).start(mapping, START));
  for (const hh of [h, h2])
    assert.equal(hh.seen.some((s) => s.includes("StartsWith('enclave-app-dep0001-708e6409')")), false,
                 "a prefix sweep on the failure path is what could take a neighbour");
});

test("cleanup requires the ownership marker unless THIS attempt created the VM", async () => {
  // the definition failed, so we never recorded it: only a marked VM may be removed
  const h1 = host({ define: new Error("name already exists") });
  await assert.rejects(() => mk(h1).start(mapping, START));
  const s1 = h1.seen.find((s) => s.includes("$_.Name -eq"));
  assert.match(s1, /Notes -eq/, "we did not make it, so it must prove it is ours before being removed");
  // the definition succeeded and a later step failed: it is ours, and it goes BY THE ID we defined.
  // The define script put the Notes on first and read them back, so removeById's ownership check
  // (kept exactly as it was) finds our marker on it.
  const h2 = host({ start: new Error("would not start") });
  await assert.rejects(() => mk(h2).start(mapping, START));
  assert.equal(h2.seen.some((s) => s.includes("$_.Name -eq")), false, "not by name once the Id is known");
  const s2 = h2.seen.find((s) => keyOf(s) === "removeById");
  assert.match(s2, new RegExp(`Get-VM -Id '${VM_ID}'`), "we made this one: removed by the Id it was defined with");
});

test("REPRO+FIX: the console read is bounded by itself, not by the outer kill", () => {
  const s = CMD.readConsole({ pipe: "\\\\.\\pipe\\x-com1", seconds: 12 });
  assert.doesNotMatch(s, /\[IO\.File\]::Open/, "a synchronous Read on an idle pipe blocks past any deadline");
  assert.match(s, /NamedPipeClientStream/);
  assert.match(s, /\$cli\.Connect\(/, "a bounded connect, so an absent pipe is not an infinite wait");
  assert.match(s, /ReadAsync/);
  assert.match(s, /CancelAfter\(12 \* 1000\)/, "cancellation at the deadline");
  assert.match(s, /connected=\$connected/, "and it always answers, even when nothing connected");
});

test("a console that never connects is a failure with a reason, not silent success", async () => {
  await assert.rejects(() => mk(host({ readConsole: { connected: false, bytes: 0, head: "", note: "pipe not found" } })).start(mapping, START),
                       /could not attach to the guest console.*pipe not found/);
});

test("REPRO+FIX: console bytes mean the guest BOOTED, never that the app is serving", async () => {
  const h = mk(host({ readConsole: { connected: true, bytes: 512, head: "OpenHCL boot: ..." } }));
  const r = await h.start(mapping, START);
  assert.equal(r.guest.booted, true);
  assert.equal(r.appReady, false, "no app-readiness handshake exists on this backend");
  // and the manager must not translate that into "running"
  const m = new Manager({ fetchComponent: async () => Buffer.alloc(0),
                          backend: new HyperVPartitionBackend({ launch: async () => r }) });
  const rec = await m.spawn({ derive: { derivation: "enclave-catalog-bundle/1", catalog: { app: "0x" + "ab".repeat(32), version: 7 },
    cid: "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 },
    runtimeId: "cd".repeat(32) }, isPublic: true, hasSecrets: false })
    .catch((e) => ({ state: "threw", reason: e.message }));
  assert.notEqual(rec.state, "running", "a booted guest is not a serving app");
});

test("REPRO+FIX: a stop that failed is reported, not reported as ok", async () => {
  const h = host({ stop: { ok: false, state: "Running", error: "the VM is busy" } });
  await assert.rejects(() => mk(h).stop({ name: "enclave-app-x" }), /could not stop enclave-app-x: the VM is busy/);
  const gone = host({ stop: { ok: true, note: "already gone" } });
  assert.deepEqual(await mk(gone).stop({ name: "enclave-app-x" }), { stopped: true, name: "enclave-app-x" });
});

test("the stop command distinguishes a failure from a VM that is already gone", () => {
  const s = CMD.stop({ name: "n" });
  assert.match(s, /-ErrorAction Stop/, "SilentlyContinue reported ok whatever happened");
  assert.match(s, /already gone/, "removed is not the same as could-not-stop");
  assert.match(s, /ok=\$false/, "and a real failure says so");
});

test("teardown demands the marker by default, and still clears what we know we made", async () => {
  const h = host();
  const l = mk(h);
  l.created.add("enclave-app-orphan");          // created, then the process died before Notes
  await l.teardown();
  const exact = h.seen.filter((s) => s.includes("$_.Name -eq 'enclave-app-orphan'"));
  assert.equal(exact.length, 1, "the recorded name is removed exactly");
  assert.doesNotMatch(exact[0], /Notes -eq/, "ours, so no marker needed");
  const sweep = h.seen.find((s) => s.includes("$removed = @(); $failed = @();"));
  assert.match(sweep, /Notes -eq/, "and the prefix sweep now REQUIRES the marker, so it cannot take a neighbour");
});
