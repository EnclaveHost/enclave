// supervisor.js snpVm support (metal/snpvm-supervisor-patch.py): a whole-VM SEV-SNP app (Enclave RPC) is claimed through
// the ordinary tryClaim/adopt path with the CPU share its VM takes of the node and no wasm prefetch, and its launch, liveness and stop go to the
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
    // metal0's pool: 24 vCPUs, 96 GiB; the share grain and the claim gate's free share as supervisor.js has them
    nodeSpec: () => ({ vcpus: 24, ramGb: 96 }), claimFreeCpu: () => 1,
    normalizeCpuReq: (share) => { const pct = Math.min(100, Math.max(1, Math.round(share * 100))); return { cpu: true, gpuShare: 0, cpuShare: pct / 100, share: pct / 100, pct }; },
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
  // 65536 MiB of a 96 GiB pool is 67% (8 of 24 vCPUs is less); the row dialed nothing more
  assert.deepEqual({ ...slice }, { cpu: true, gpuShare: 0, cpuShare: 0.67, share: 0.67, pct: 67 });
  assert.deepEqual([...fw], ["tcp:8443"]);
  assert.equal(flags.hinted, true);
});

test("claim gate: an unbound deployment is taken by the manager's instance pool when it holds the image, the size fits and a slot is free", async () => {
  const root = RELEASE.config.image.rootHash.toLowerCase();
  const pool = (over = {}) => ({ slots: 2, free: 1, maxVcpus: 8, maxMemMiB: 65536, images: [root], allocated: [], ...over });
  const withPool = (p) => sandbox({ snpVmReq: async () => ({ status: 200, body: { backend: "snp-vm", bindings: [], ...(p ? { pool: p } : {}) } }) });
  assert.equal(await withPool(pool()).ctx.snpVmConsider(row(), gate(), opt), "claimed");
  assert.match(await withPool(pool({ images: [] })).ctx.snpVmConsider(row(), gate(), opt), /does not hold this version's image/);
  assert.match(await withPool(pool({ maxVcpus: 4 })).ctx.snpVmConsider(row(), gate(), opt), /larger than this host's instance pool/);
  assert.match(await withPool(pool({ maxMemMiB: 32768 })).ctx.snpVmConsider(row(), gate(), opt), /larger than this host's instance pool/);
  assert.match(await withPool(pool({ free: 0 })).ctx.snpVmConsider(row(), gate(), opt), /no free instance slot/);
  // a deployment that already holds a slot, and a resume, are not refused for a full pool
  assert.equal(await withPool(pool({ free: 0, allocated: [DEP.toUpperCase().replace("0X", "0x")] })).ctx.snpVmConsider(row(), gate(), opt), "claimed");
  assert.equal(await withPool(pool({ free: 0 })).ctx.snpVmConsider(row(), gate(), opt, { resume: true }), "claimed");
  assert.match(await withPool(null).ctx.snpVmConsider(row(), gate(), opt), /no snp-vm binding/);
});

test("a whole VM holds a CPU share: what its owner dialed, or what it needs of this node if that is more", async () => {
  const { ctx } = sandbox();
  const plan = { vcpus: 8, memMiB: 49152 };                     // Enclave RPC 1.4.1
  assert.equal(ctx.snpVmSlice(plan, 1000).cpuShare, 1, "the dialed 100% is held");
  assert.equal(ctx.snpVmSlice(plan, 10).cpuShare, 0.5, "48 GiB of 96: a 1% dial is lifted to what the VM takes");
  assert.equal(ctx.snpVmSlice(plan, 0).cpuShare, 0.5);
  assert.equal(ctx.snpVmSlice({ vcpus: 20, memMiB: 4096 }, 0).cpuShare, 0.84, "vCPUs decide when they are the larger part, rounded up");
  assert.throws(() => ctx.snpVmSlice({ vcpus: 8, memMiB: 131072 }, 1000), /more than this host's pool/);
  assert.throws(() => ctx.snpVmSlice(plan, 1000, { vcpus: 0, ramGb: 0 }), /no vCPU and RAM pool/);
  // before the manager's pool is heard the node figures are boot defaults: nothing is sized, claimed or booked on them
  assert.throws(() => ctx.snpVmSlice(plan, 500, { vcpus: 4, ramGb: 64, pool: false }), /pool is not read yet/);
  assert.equal(sandbox({ nodeSpec: () => ({ vcpus: 4, ramGb: 64, pool: false }) }).ctx.snpVmDueShare({ _snpVm: plan, _shares: { cpuMilli: 500 } }), 0);
  assert.equal(sandbox({ ISOLATION_BACKEND: "" }).ctx.snpVmSlice(plan, 500, { vcpus: 24, ramGb: 96, pool: false }).cpuShare, 0.5, "a box without the tier has only those figures");
  assert.equal(ctx.snpVmDueShare({ _snpVm: plan, _shares: { cpuMilli: 1000 } }), 1);
  assert.equal(ctx.snpVmDueShare({ _snpVm: { vcpus: 8, memMiB: 131072 }, _shares: { cpuMilli: 1000 } }), 0, "unsizable: nothing taken on a guess");
});

test("the claim gate refuses a new whole VM the node's share ledger has no room for; a resume is never given up", async () => {
  const full = sandbox({ claimFreeCpu: () => 0.4 });
  assert.match(await full.ctx.snpVmConsider(row({ cpuMilli: 10 }), gate({ min: { memMb: 49152 } }), opt), /no free CPU capacity here right now for this whole VM/);
  assert.equal(full.calls.tryClaim.length, 0);
  assert.equal(await full.ctx.snpVmConsider(row({ cpuMilli: 10 }), gate({ min: { memMb: 49152 } }), opt, { resume: true }), "claimed");
  const [, , , slice, flags] = full.calls.tryClaim[0];
  assert.equal(slice.cpuShare, 0.4, "it takes what is free; the reconciler raises it to its due share");
  assert.equal(flags.resume, true);
  const roomy = sandbox({ claimFreeCpu: () => 0.5 });
  assert.equal(await roomy.ctx.snpVmConsider(row({ cpuMilli: 10 }), gate({ min: { memMb: 49152 } }), opt), "claimed");
  assert.equal(roomy.calls.tryClaim[0][3].cpuShare, 0.5);
  const tooBig = sandbox();
  assert.match(await tooBig.ctx.snpVmConsider(row(), gate({ min: { memMb: 131072 } }), opt), /snpVm: the VM needs 8 vCPUs and 131072 MiB/);
});

test("an owner's share change on a whole VM is booked in place: nothing stopped, nothing released", () => {
  // the node's CPU share ledger as supervisor.js keeps it
  const pool = { shareFree: 0 };
  const s = sandbox({ round3: (x) => Math.round(x * 1000) / 1000,
    allocCpu: (share) => { if (pool.shareFree < share - 1e-9) return null; pool.shareFree -= share; return { cpu: true, share }; },
    releaseGpu: (h) => { pool.shareFree = Math.min(1, pool.shareFree + h.share); } });
  const rec = { id: DEP, _snpVm: { vcpus: 8, memMiB: 49152 }, _gpu: { cpu: true, share: 1 }, resources: { gpuShare: 0, cpuShare: 1 },
                _shares: { gpuMilli: 0, cpuMilli: 1000 }, rate: 0, status: "running" };
  // 100% -> 50%: half the node comes back
  assert.deepEqual({ ...s.ctx.snpVmResize(rec, { cpuMilli: 500, gpuMilli: 0, rate: 0n }) }, { ok: true, cpuShare: 0.5 });
  assert.deepEqual([rec._gpu.share, rec.resources.cpuShare, rec._shares.cpuMilli, pool.shareFree], [0.5, 0.5, 500, 0.5]);
  // a dial below what the VM takes books what it takes, and records the dial so the audit does not ask again
  assert.equal(s.ctx.snpVmResize(rec, { cpuMilli: 100, gpuMilli: 0, rate: 0n }).cpuShare, 0.5);
  assert.deepEqual([rec._shares.cpuMilli, pool.shareFree], [100, 0.5]);
  // a grow the node has no room for: the VM keeps the share it held, the record keeps its old dial (asked again later)
  pool.shareFree = 0.2;                                        // another tenant took 30%
  const r = s.ctx.snpVmResize(rec, { cpuMilli: 900, gpuMilli: 0, rate: 0n });
  assert.equal(r.ok, false); assert.match(r.why, /no free CPU share for 0.9 here; the VM keeps running on the 0.5 it holds/);
  assert.deepEqual([rec._gpu.share, rec.resources.cpuShare, rec._shares.cpuMilli, Math.round(pool.shareFree * 1000) / 1000], [0.5, 0.5, 100, 0.2]);
  // ...and one it has room for
  assert.equal(s.ctx.snpVmResize(rec, { cpuMilli: 700, gpuMilli: 0, rate: 0n }).cpuShare, 0.7);
  assert.ok(Math.abs(pool.shareFree) < 1e-9);
  // a pool not read yet moves nothing
  const early = sandbox({ nodeSpec: () => ({ vcpus: 4, ramGb: 64, pool: false }) });
  const held = { id: DEP, _snpVm: rec._snpVm, _gpu: { cpu: true, share: 1 }, _shares: { gpuMilli: 0, cpuMilli: 1000 } };
  assert.match(early.ctx.snpVmResize(held, { cpuMilli: 500, gpuMilli: 0, rate: 0n }).why, /pool is not read yet/);
  assert.deepEqual([held._gpu.share, held._shares.cpuMilli], [1, 1000]);
});

test("the resize hooks: a whole VM's share change returns before any stop, and a resized slice credits its own release", () => {
  const sw = between(SRC, "async function switchTenantVersion(rec, d) {", "\n}\n");
  const own = sw.indexOf("if (rec._snpVm && resize && to === (rec.image && rec.image.reference)) {");
  assert.ok(own > 0 && own < sw.indexOf("const evict = async"), "decided before eviction exists");
  assert.ok(own < sw.indexOf("stopContainer(rec)") && own < sw.indexOf("gateAppReference("), "and before the stop and the catalog gate");
  assert.match(sw.slice(own, sw.indexOf("const evict = async")), /snpVmResize\(rec, d\)[\s\S]*saveStateSoon\(\);\n    return;\n  \}/);
  assert.match(sw, /allocGpu\(slice\.vramGb, slice\.computeShare, slice\.cpuShare, \{ heldReservation: true \}\);/);
});

test("/availability never states more CPU share than the box's own ledger has on the isolation tier", () => {
  const fn = between(SRC, "function advertisedCpuFree(", "\n}\n") + "\n}";
  const run = (backend, shareFree, managerFree) => vm.runInNewContext(fn + "; advertisedCpuFree(m)", { ISOLATION_BACKEND: backend, cpuPool: { shareFree }, m: managerFree, Math, Number });
  assert.equal(run("snp-guest-per-app", 0, 0.2), 0, "a whole VM holding 100% leaves nothing, whatever the manager's room is");
  assert.equal(run("snp-guest-per-app", 0.5, 0.2), 0.2, "the manager's live room still caps it");
  assert.equal(run("snp-guest-per-app", 0.5, 0.9), 0.5);
  assert.equal(run("", 0, 0.7), 0.7, "a box without the tier states its manager's figure, as before");
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

test("the hooks: the namespace, the claim branch, the record's plan, the launch branch, the vmReq route and the certificate skip are all wired", () => {
  assert.match(SRC, /\.\.\.\(SNPVM_URL \? \["snpVm"\] : \[\]\)\];/);
  assert.match(SRC, /if \("snpVm" in o\) opts\.snpVm = parseSnpVmOption\(o\.snpVm\);/);
  assert.match(SRC, /if \(claimOpts\.snpVm\) return await snpVmConsider\(d, g, claimOpts\.snpVm, \{ resume, hinted \}\);/);
  assert.match(SRC, /\.\.\.\(g\._snpVm \? \{ _snpVm: g\._snpVm \} : \{\}\),/);
  assert.match(SRC, /if \(sv && sv\._snpVm\) return await snpVmSpawn\(deploymentId, sv\._snpVm\);/);
  assert.match(SRC, /function vmReq\(method, path, body, timeoutMs = 120000\) \{\n  if \(snpVmRoute\(method, path, body\)\) return snpVmReq/);
  assert.match(SRC, /!rec\.public\) continue;\n    if \(rec\._snpVm\) continue;/, "no guestd certificate pass for a whole-VM app");
});

// metal0's control image overlays its own (older) supervisor.js: the same patch must apply there. Skipped off that host.
const DEPLOYED = "/home/steven/enclave-prod/metal-deabf8f90/supervisor.js";
test("the patch applies to metal0's deployed supervisor generation as well", { skip: !fs.existsSync(DEPLOYED) }, () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snpvm-sup-")), "supervisor.js");
  fs.copyFileSync(DEPLOYED, tmp);
  execFileSync("python3", ["-I", path.join(ROOT, "metal/snpvm-supervisor-patch.py"), tmp]);
  execFileSync(process.execPath, ["--check", tmp]);
  const out = fs.readFileSync(tmp, "utf8");
  assert.match(out, /async function snpVmConsider\(/);
  for (const hook of ["function snpVmSlice(", "function advertisedCpuFree(", "advertisedCpuFree(c.cpuShareFree", "const due = snpVmDueShare(r);",
                      "function snpVmResize(", "const was = rec._shares && rec._shares.cpuMilli, r = snpVmResize(rec, d);", "{ heldReservation: true });"])
    assert.equal(out.split(hook).length, 2, `${hook} once in the patched generation`);
});
