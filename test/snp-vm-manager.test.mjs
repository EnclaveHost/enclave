// rpc/snp/vm-manager.mjs: the host manager that lets a fleet host's supervisor run a whole-VM SEV-SNP app (catalog
// runtime "sev-snp-vm", Enclave RPC) like any other app, over guestd's /vms contract and guestd-control/1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SnpVmManager, idFor, parsePlan, launchConfigFor, validateConfig, serve } from "../rpc/snp/vm-manager.mjs";
import { GuestdControl } from "../isolation/m4/guestd/control-client.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const DEP = "0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f";
const M = "220e5ec0" + "ab".repeat(44);
const CMDLINE = "root=/dev/mapper/vroot ro enclave.roothash=" + "3d".repeat(32) + " console=ttyS0";
const OVMF = Buffer.from("ovmf bytes");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snpvm-"));
  const image = path.join(dir, "image");
  fs.mkdirSync(image);
  fs.writeFileSync(path.join(image, "IMAGE.json"), JSON.stringify({ rootHash: "3d".repeat(32), cmdline: CMDLINE }));
  fs.writeFileSync(path.join(dir, "ovmf.fd"), OVMF);
  const cfg = { listen: "127.0.0.1:0", stateDir: path.join(dir, "state"), bindings: { [DEP]: {
    image, run: path.join(dir, "run"), unit: "enclave-rpc-snp-guest", cpus: 8, ovmf: path.join(dir, "ovmf.fd"),
    attestOrigin: "https://127.0.0.1:18443", hostfwd: [[18443, 8443]],
    disks: [{ path: path.join(dir, "l1.qcow2"), serial: "RPC-l1", discard: true }, { path: path.join(dir, "base.qcow2"), serial: "RPC-base", cache: "writeback", discard: true }] } } };
  return { dir, cfg };
}
const plan = (over = {}) => ({ appRef: "catalog://0x0f62858500000000000000000000000000000000000000000000000000ebb537/3", vcpus: 8, memMiB: 65536,
  measurements: [M], vcpuType: "EPYC-v4", image: { rootHash: "3d".repeat(32), ovmfSha256: sha(OVMF), cmdlineSha256: sha(Buffer.from(CMDLINE)) }, ...over });

function fakeHost() {
  const active = new Set(), calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "systemctl" && args[1] === "is-active") return { code: active.has(args[3]) ? 0 : 3, stdout: "", stderr: "" };
    if (cmd === "systemctl" && args[1] === "stop") { active.delete(args[2]); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "systemd-run") { active.add(args.find((a) => a.startsWith("--unit=")).slice(7) + ".service"); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { active, calls, exec };
}

test("plan: strict fields, measured vCPU type, 48-byte measurements", () => {
  assert.equal(parsePlan(plan()).vcpus, 8);
  assert.throws(() => parsePlan({ ...plan(), extra: 1 }), /unknown snpVm plan field/);
  assert.throws(() => parsePlan(plan({ vcpuType: "host" })), /EPYC-v4/);
  assert.throws(() => parsePlan(plan({ measurements: ["ab"] })), /48-byte/);
  assert.throws(() => parsePlan(plan({ image: { rootHash: "x" } })), /rootHash/);
});

test("the bound image must match the version's root hash, cmdline, OVMF and vCPUs", () => {
  const { cfg } = fixture();
  const b = cfg.bindings[DEP];
  const c = launchConfigFor(DEP, b, parsePlan(plan()));
  assert.deepEqual([c.cpus, c.memoryMiB, c.hostData, c.hostfwd], [8, 65536, DEP.slice(2), [[18443, 8443]]]);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ image: { ...plan().image, rootHash: "ee".repeat(32) } }))), /root hash/);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ image: { ...plan().image, cmdlineSha256: "ee".repeat(32) } }))), /cmdline/);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ image: { ...plan().image, ovmfSha256: "ee".repeat(32) } }))), /OVMF/);
  assert.throws(() => launchConfigFor(DEP, b, parsePlan(plan({ vcpus: 4 }))), /vCPUs/);
});

test("config: a disk bound to two deployments is refused", () => {
  const { cfg } = fixture();
  const other = "0x" + "11".repeat(32);
  cfg.bindings[other] = { ...cfg.bindings[DEP], unit: "other" };
  assert.throws(() => validateConfig(cfg), /more than one deployment/);
});

test("spawn: unbound deployments and busy disks start nothing; a bound one starts through launch.py", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  let busy = ["4242"];
  const m = new SnpVmManager(cfg, { exec: h.exec, attest: async () => true, diskUsers: () => busy, launcher: "/opt/launch.py" });
  assert.equal((await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: "0x" + "22".repeat(32), snpVm: plan() }) })).status, 403);
  const refused = await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /open in another process/);
  assert.ok(!h.calls.some((c) => c[0] === "systemd-run"));
  busy = [];
  const r = await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, idFor(DEP));
  const run = h.calls.find((c) => c[0] === "systemd-run");
  assert.ok(run.includes("--unit=enclave-rpc-snp-guest") && run.includes("/opt/launch.py"));
  const launch = JSON.parse(fs.readFileSync(run.at(-1), "utf8"));
  assert.equal(launch.hostData, DEP.slice(2));
  assert.equal(launch.disks.length, 2);
});

test("status: starting until attested, running after, failed when the unit ends; a 409 names the instance to adopt", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  let attested = false;
  const m = new SnpVmManager(cfg, { exec: h.exec, attest: async () => { if (!attested) throw new Error("front not up"); return true; }, diskUsers: () => [] });
  const id = (await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) })).body.id;
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "starting");
  attested = true;
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "running");
  const again = await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) });
  assert.deepEqual([again.status, again.body.id], [409, id]);
  assert.equal((await m.handle({ method: "GET", path: "/vms" })).body.vms.length, 1);
  h.active.clear();
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "failed");
});

test("recover: a running bound unit is listed after a manager restart, and re-launch adopts it", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  h.active.add("enclave-rpc-snp-guest.service");
  const m = new SnpVmManager(cfg, { exec: h.exec, attest: async () => true, diskUsers: () => [] });
  await m.recover();
  const id = idFor(DEP);
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "starting");   // plan unknown until re-launch
  assert.equal((await m.handle({ method: "POST", path: "/vms", body: JSON.stringify({ name: DEP, snpVm: plan() }) })).status, 409);
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).body.status, "running");
  assert.equal((await m.handle({ method: "DELETE", path: `/vms/${id}` })).status, 200);
  assert.ok(h.calls.some((c) => c[0] === "systemctl" && c[2] === "stop"));
  assert.equal((await m.handle({ method: "GET", path: `/vms/${id}` })).status, 404);
});

test("the supervisor's own guestd-control/1 client reaches it, and an unauthenticated caller does not", async () => {
  const { cfg } = fixture();
  const h = fakeHost();
  const key = Buffer.from("ab".repeat(32), "hex");
  const srv = serve(new SnpVmManager(cfg, { exec: h.exec, attest: async () => true, diskUsers: () => [] }), key);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const c = new GuestdControl(base, key);
    const health = await c.request("GET", "/health");
    assert.equal(health.body.backend, "snp-vm");
    const r = await c.request("POST", "/vms", { name: DEP, snpVm: plan() }, { idempotent: false });
    assert.equal(r.status, 201);
    const raw = await fetch(base + "/vms");
    assert.equal(raw.status, 401);
  } finally { await new Promise((r) => srv.close(r)); }
});
