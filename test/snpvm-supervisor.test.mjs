// supervisor.js snpVm support (metal/snpvm-supervisor-patch.py): a whole-VM SEV-SNP app (Enclave RPC) is claimed through
// the ordinary tryClaim/adopt path with a zero CPU slice and no wasm prefetch, and its launch, liveness and stop go to the
// host's snp-vm manager (rpc/snp/vm-manager.mjs), never to guestd and never into guestd's /vms listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = fs.readFileSync(path.join(ROOT, "supervisor.js"), "utf8");
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, `markers ${a.slice(0, 30)}`); return src.slice(i, j); };
const RELEASE = JSON.parse(fs.readFileSync(path.join(ROOT, "ops/rpc-snp-prod-r7/release-r12/release.json"), "utf8"));
const DEP = "0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f";
const APPREF = "catalog://0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537/3";

function sandbox(over = {}) {
  const calls = { tryClaim: [], req: [] };
  const ctx = vm.createContext({
    console: { log() {}, warn() {} }, lc: (v) => String(v || "").toLowerCase(), SPAWN_TIMEOUT_MS: 1000,
    parseFirewall: ({ ports }) => ports, process: { env: {} }, ISOLATION_BACKEND: "snp-guest-per-app", URL,
    tryClaim: async (...a) => { calls.tryClaim.push(a); return "claimed"; },
    ...over,
  });
  vm.runInContext((between(SRC, "// SNPVM_URL:", "!!body && !!body.snpVm));") + "!!body && !!body.snpVm));").replace(/^const /gm, "var ").replace(/^let /gm, "var ").replace(/import\.meta\.url/g, "\"file:///x/supervisor.js\""), ctx);
  ctx.snpVmReq = over.snpVmReq || (async (m, p, b) => { calls.req.push([m, p, b]); return { status: 200, body: { backend: "snp-vm", bindings: [DEP] } }; });
  vm.runInContext(between(SRC, "// ---- whole-VM SEV-SNP apps (snpVm)", "\nasync function spawnContainer({ deploymentId,"), ctx);
  return { ctx, calls };
}
const gate = (over = {}) => ({ ref: APPREF, wasmRef: "ipfs://bafkreigcdalt", config: JSON.stringify(RELEASE.config), ports: "tcp:8443", min: { memMb: 65536 }, ...over });
const row = (over = {}) => ({ id: DEP, appRef: APPREF, ...over });
const opt = { app: "enclave-rpc", measurementsFrom: APPREF };

test("snpVm option: strict object, short app name, a catalog reference", () => {
  const { ctx } = sandbox();
  assert.deepEqual({ ...ctx.parseSnpVmOption(opt) }, opt);
  assert.throws(() => ctx.parseSnpVmOption({ ...opt, extra: 1 }), /unknown snpVm option/);
  assert.throws(() => ctx.parseSnpVmOption({ ...opt, measurementsFrom: "ipfs://x" }), /catalog/);
  assert.throws(() => ctx.parseSnpVmOption([]), /JSON object/);
});

test("the plan comes from the published r12 version: 8 vCPUs, its measurement, its image hashes, its memory", () => {
  const { ctx } = sandbox();
  const p = ctx.snpVmPlanOf(gate(), APPREF);
  assert.equal(p.vcpus, 8);
  assert.equal(p.memMiB, 65536);
  assert.deepEqual([...p.measurements], [RELEASE.config.snp.measurements["8"]]);
  assert.equal(p.image.rootHash, RELEASE.config.image.rootHash);
  assert.equal(p.vcpuType, "EPYC-v4");
  assert.throws(() => ctx.snpVmPlanOf(gate({ config: '{"runtime":"wasm"}' }), APPREF), /sev-snp-vm/);
  assert.throws(() => ctx.snpVmPlanOf(gate({ config: JSON.stringify({ ...RELEASE.config, snp: { measurements: { 4: "aa", 8: "bb" } } }) }), APPREF), /exactly one vCPU/);
});

test("claim gate: own version only, a manager that answers, a binding for this deployment; then the ordinary tryClaim", async () => {
  const s = sandbox();
  assert.match(await s.ctx.snpVmConsider(row(), gate(), { ...opt, measurementsFrom: APPREF.replace("/3", "/2") }), /own catalog version/);
  const unbound = sandbox({ snpVmReq: async () => ({ status: 200, body: { backend: "snp-vm", bindings: [] } }) });
  assert.match(await unbound.ctx.snpVmConsider(row(), gate(), opt), /no snp-vm binding/);
  const absent = sandbox({ snpVmReq: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.match(await absent.ctx.snpVmConsider(row(), gate(), opt), /no whole-VM SEV-SNP manager/);
  assert.equal(await s.ctx.snpVmConsider(row(), gate(), opt, { hinted: true }), "claimed");
  const [d, g, fw, slice, flags] = s.calls.tryClaim[0];
  assert.equal(d.id, DEP);
  assert.ok(!/^ipfs:\/\//.test(g.wasmRef), "no wasm prefetch for a whole-VM app");
  assert.equal(g._snpVm.vcpus, 8);
  assert.deepEqual({ ...slice }, { cpu: true, cpuShare: 0, gpuShare: 0 });
  assert.deepEqual([...fw], ["tcp:8443"]);
  assert.equal(flags.hinted, true);
});

test("launch: 201 is a new VM, 409 with an sv id is this record's VM to adopt, anything else fails the provision", async () => {
  const plan = { appRef: APPREF, vcpus: 8 };
  const ok = sandbox({ snpVmReq: async (m, p, b) => ({ status: 201, body: { id: "sv0123456789abcdef", name: b.name } }) });
  assert.equal((await ok.ctx.snpVmSpawn(DEP, plan)).vmId, "sv0123456789abcdef");
  const adopt = sandbox({ snpVmReq: async () => ({ status: 409, body: { id: "svfedcba9876543210" } }) });
  assert.equal((await adopt.ctx.snpVmSpawn(DEP, plan)).vmId, "svfedcba9876543210");
  const refused = sandbox({ snpVmReq: async () => ({ status: 409, body: { error: "the bound disks are open in another process" } }) });
  await assert.rejects(refused.ctx.snpVmSpawn(DEP, plan), /refused the launch \(HTTP 409\)/);
});

test("routing: snp-vm instances and launches go to the snp-vm manager; guestd's list and its guests do not", () => {
  const { ctx } = sandbox();
  assert.equal(ctx.SNPVM_URL, "http://10.0.2.2:8099");
  assert.equal(ctx.snpVmRoute("GET", "/vms/sv0123456789abcdef"), true);
  assert.equal(ctx.snpVmRoute("DELETE", "/vms/sv0123456789abcdef"), true);
  assert.equal(ctx.snpVmRoute("POST", "/vms", { name: DEP, snpVm: {} }), true);
  assert.equal(ctx.snpVmRoute("GET", "/vms"), false, "the orphan sweep lists guestd only");
  assert.equal(ctx.snpVmRoute("POST", "/vms/lease", { ids: [DEP] }), false);
  assert.equal(ctx.snpVmRoute("GET", "/vms/gd28bad987"), false);
  assert.equal(ctx.snpVmRoute("POST", "/vms", { name: DEP, derive: {} }), false);
  const off = sandbox({ ISOLATION_BACKEND: "" });
  assert.equal(off.ctx.SNPVM_URL, "");
  assert.equal(off.ctx.snpVmRoute("GET", "/vms/sv0123456789abcdef"), false);
});

test("the hooks: the namespace, the claim branch, the record's plan, the launch branch and the vmReq route are all wired", () => {
  assert.match(SRC, /\.\.\.\(SNPVM_URL \? \["snpVm"\] : \[\]\)\];/);
  assert.match(SRC, /if \("snpVm" in o\) opts\.snpVm = parseSnpVmOption\(o\.snpVm\);/);
  assert.match(SRC, /if \(claimOpts\.snpVm\) return await snpVmConsider\(d, g, claimOpts\.snpVm, \{ resume, hinted \}\);/);
  assert.match(SRC, /\.\.\.\(g\._snpVm \? \{ _snpVm: g\._snpVm \} : \{\}\),/);
  assert.match(SRC, /if \(sv && sv\._snpVm\) return await snpVmSpawn\(deploymentId, sv\._snpVm\);/);
  assert.match(SRC, /function vmReq\(method, path, body, timeoutMs = 120000\) \{\n  if \(snpVmRoute\(method, path, body\)\) return snpVmReq/);
});

// metal0's control image overlays its own (older) supervisor.js: the same patch must apply there. Skipped off that host.
const DEPLOYED = "/home/steven/enclave-prod/metal-deabf8f90/supervisor.js";
test("the patch applies to metal0's deployed supervisor generation as well", { skip: !fs.existsSync(DEPLOYED) }, () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snpvm-sup-")), "supervisor.js");
  fs.copyFileSync(DEPLOYED, tmp);
  execFileSync("python3", ["-I", path.join(ROOT, "metal/snpvm-supervisor-patch.py"), tmp]);
  execFileSync(process.execPath, ["--check", tmp]);
  assert.match(fs.readFileSync(tmp, "utf8"), /async function snpVmConsider\(/);
});
