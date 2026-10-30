// Model volumes on the Windows partition tier, host side (isolation/m3/monitor/modelvol.go verifies them in the guest):
// the store loader, the manager's admission from the MEASURED config and its /health, the launcher's per-run
// differencing disks (PowerShell generated and read back; mocked, as every launcher test is), and node-bridge's plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelVolumes, configVolumes } from "./model-volumes.mjs";
import { vhdFooter } from "../../../sdk/storage/model-volumes.mjs";
import { Manager } from "./server.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { appConfigText, DERIVATION_V5 } from "./derive.mjs";
import { WmiHyperVLauncher, CMD, BOOT_UEFI, checkDisks, q } from "./wmi-launcher.mjs";
import { TYPE1, VM_ID, PREFLIGHT_OK, defineAnswer, keyOf, startAndReadAnswer } from "./fake-hyperv.mjs";
import { isolationPlan } from "../datapath/node-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const vec = JSON.parse(fs.readFileSync(path.join(HERE, "../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(vec.component_hex, "hex");
const REC = vec.ok[0].mapping.record;
const DEP = "0x" + "e7".repeat(32);
const PIN = "11".repeat(32);
const ROOT_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff";
const ROOT_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0";
const line = (name, root, preload, graph) => `${name} ${root} 00ff 4096 4096 10 11 49152 ${preload} ${graph} ${PIN}\n`;

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mv-win-"));
  const table = path.join(dir, "model-volumes.table");
  fs.writeFileSync(table, line("data-b", ROOT_B, "none", "-") + line("gone-c", ROOT_A, "none", "-") + line("qwen-a", ROOT_A, "ggml", "model.gguf")
    + line("short-d", ROOT_A, "none", "-") + line("wrong-e", ROOT_A, "none", "-"));
  const vol = (name, root, vhdBytes = 49152) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "volume.json"), JSON.stringify({ name, image: "volume.img", imageBytes: 49152,
      verity: { alg: "sha256", root, salt: "00ff", dataBlockSize: 4096, hashBlockSize: 4096, dataBlocks: 10, hashOffset: 40960, hashStartBlock: 11 } }));
    fs.writeFileSync(path.join(dir, name, "volume.vhd"), Buffer.concat([Buffer.alloc(vhdBytes), vhdFooter(vhdBytes, Buffer.alloc(16, 7))]));
  };
  vol("qwen-a", ROOT_A); vol("data-b", ROOT_B); vol("short-d", ROOT_A, 45056); vol("wrong-e", ROOT_B);
  return { dir, table };
}

test("the store offers only the pinned volumes it holds as fixed VHDs of the pinned size", () => {
  const s = store();
  const mv = loadModelVolumes({ table: s.table, store: s.dir });
  assert.deepEqual([...mv.have.keys()].sort(), ["data-b", "qwen-a"]);
  assert.equal(mv.have.get("qwen-a").vhd, path.join(s.dir, "qwen-a", "volume.vhd"));
  assert.match(mv.missing["gone-c"], /not in this host's store/);
  assert.match(mv.missing["short-d"], /fixed VHD of the pinned size/);
  assert.match(mv.missing["wrong-e"], /not the pinned volume/);
  assert.deepEqual(configVolumes('{"volumes":[" qwen-a ","data-b","qwen-a",""]}'), ["qwen-a", "data-b"]);
  assert.deepEqual(configVolumes('{"volumes":"qwen-a"}'), []);
  assert.deepEqual(configVolumes("not json"), []);
});

// ---- the manager ---------------------------------------------------------------------------------------------------
function manager(over = {}) {
  const s = store();
  const started = [];
  const backend = new HyperVPartitionBackend({ launch: async (mapping, opts) => { started.push(opts); return { pid: 1, appReady: false, guest: { booted: true, bytes: 1, head: "" }, stop: async () => {} }; } });
  const m = new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, configEnabled: true, fetchConfig: async () => Buffer.from("{}"),
    modelVolumes: { ...loadModelVolumes({ table: s.table, store: s.dir }), nnPreload: true }, backend, ...over });
  return { m, started, s };
}
const v5 = (config) => ({ derive: { ...REC, derivation: DERIVATION_V5, config: appConfigText(config) }, name: DEP, isPublic: true, hasSecrets: false });

test("the manager states the volumes it holds, and the capability only where config is delivered", () => {
  const { m } = manager();
  const h = m.health();
  assert.equal(h.supports.modelVolumes, true);
  assert.equal(h.supports.nnPreload, true);
  assert.deepEqual(h.volumes.map((v) => `${v.name}:${v.backend}:${v.kind}`), ["data-b:none:model", "qwen-a:ggml:model"]);
  assert.equal(h.volumes[1].root, ROOT_A);
  assert.match(h.modelVolumesMissing["gone-c"], /store/);
  const off = manager({ configEnabled: false }).m.health();
  assert.equal(off.supports.modelVolumes, false);
  assert.deepEqual(off.volumes, []);
  assert.equal(new Manager({ runtimeId: REC.runtimeId }).health().supports.modelVolumes, false);
});

test("a spawn attaches exactly the measured config's volumes, from this host's store", async () => {
  const { m, started, s } = manager();
  const r = await m.spawn(v5('{"volumes":["qwen-a","data-b"]}'));
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].volumes, [{ name: "qwen-a", vhd: path.join(s.dir, "qwen-a", "volume.vhd") }, { name: "data-b", vhd: path.join(s.dir, "data-b", "volume.vhd") }]);
  assert.deepEqual(m.domains.get(r.id).volumes, ["qwen-a", "data-b"]);
  // a config without volumes attaches none
  const other = manager();
  await other.m.spawn(v5('{"greeting":"hi"}'));
  assert.equal(other.started[0].volumes, undefined);
});

test("refused, never dropped: names this host lacks, too many, no capability, a body list", async () => {
  for (const [config, want] of [
    ['{"volumes":["llama-70b"]}', /is not on this host: the image's table does not carry it/],
    ['{"volumes":["gone-c"]}', /is not on this host: not in this host's store/],
    ['{"volumes":["a","b","c","d","e","f","g","h","i"]}', /at most 8/],
  ]) await assert.rejects(() => manager().m.spawn(v5(config)), want, config);
  const plain = new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, configEnabled: true, fetchConfig: async () => Buffer.from("{}"),
    backend: new HyperVPartitionBackend({ launch: async () => { throw new Error("must not start"); } }) });
  await assert.rejects(() => plain.spawn(v5('{"volumes":["qwen-a"]}')), /does not mount them/);
  await assert.rejects(() => manager().m.spawn({ ...v5('{"volumes":["qwen-a"]}'), volumes: ["qwen-a"] }), /named in the spawn body/);
});

// ---- the launcher --------------------------------------------------------------------------------------------------
const IMG = "C:\\Users\\claude\\vbs-like\\openhcl-ownguest.bin";
const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
const mapping = { appId: "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782", record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } };
const RUN = "C:\\Users\\claude\\vbs-like";
const NAME = "enclave-app-t-dep0001-708e6409";
const VOLS = [{ name: "qwen-a", vhd: "D:\\models\\qwen-a\\volume.vhd" }, { name: "data-b", vhd: "D:\\models\\data-b\\volume.vhd" }];
function host(over = {}) {
  const seen = [];
  const answers = { preflight: PREFLIGHT_OK, imageHash: { present: true, sha256: SHA, bytes: 1 }, start: { state: "Running" },
    readConsole: { connected: true, bytes: 64, head: "x" }, removeById: { found: true, removed: true }, removeExact: { found: true, removed: true },
    retire: { present: true, retired: true }, removeRunDisks: { removed: ["x"], failed: [] }, attachDisks: { diskPaths: [] }, ...over };
  const run = async (script) => {
    seen.push(script);
    const key = keyOf(script);
    let a = typeof answers[key] === "function" ? answers[key](script) : answers[key];
    if (key === "startAndRead") a = startAndReadAnswer((k) => answers[k]);
    if (key === "define" && !(a instanceof Error)) a = defineAnswer(script, a || {});
    if (a instanceof Error) return { code: 1, stdout: "", stderr: a.message };
    return { code: 0, stdout: JSON.stringify(a ?? { ok: true }), stderr: "" };
  };
  return { run, seen, keys: () => seen.map(keyOf) };
}
const mk = (h, over = {}) => new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-app-t-", ...TYPE1, ...over });

const kidsOf = (script) => [...script.matchAll(/child='((?:[^']|'')*)'\}/g)].map((m) => m[1].replace(/''/g, "'"));

test("each volume is a per-run differencing child of the store's VHD, on SCSI, attached after the definition and before start", async () => {
  const h = host({ attachDisks: (script) => ({ diskPaths: kidsOf(script) }) });
  const r = await mk(h).start(mapping, { instanceId: "dep0001-708e6409", volumes: VOLS });
  assert.deepEqual(h.keys(), ["preflight", "imageHash", "define", "attachDisks", "startAndRead"], "defined and read back, then the disks, then started");
  const def = h.seen[2], att = h.seen[3];
  assert.doesNotMatch(def, /New-VHD|Add-VMHardDiskDrive/, "the definition itself is unchanged: it attaches none");
  const kids = [`${RUN}\\${NAME}.mv-qwen-a.vhd`, `${RUN}\\${NAME}.mv-data-b.vhd`];
  for (const [i, v] of VOLS.entries()) assert.ok(att.includes(`@{parent=${q(v.vhd)}; child=${q(kids[i])}}`), v.name);
  assert.match(att, new RegExp(`Get-VM -Id '${VM_ID}'`), "the VM this attempt defined, by Id");
  assert.match(att, /the ownership marker is absent, so no disk is attached/);
  assert.match(att, /model-volume disks attach before it starts/);
  assert.match(att, /New-VHD -Path \$dk\.child -ParentPath \$dk\.parent -Differencing/, "a child, so the store's VHD is only ever a read-only parent");
  assert.match(att, /Add-VMHardDiskDrive -VM \$v -ControllerType SCSI -Path \$dk\.child/);
  assert.match(att, /refusing to reuse another run''s disk/);
  assert.match(att, /foreach \(\$c in \$made\)/, "a failed attach removes the children it made");
  assert.deepEqual(r.volumes, ["qwen-a", "data-b"]);
  assert.deepEqual(r.disks, kids);
  // stop: the VM, its guest state, then its children - never a store VHD
  const s = host();
  const out = await mk(s).stop({ name: NAME, vmId: VM_ID, disks: r.disks });
  assert.deepEqual(s.keys(), ["removeById", "retire", "removeRunDisks"]);
  const rm = s.seen[2];
  for (const k of kids) assert.ok(rm.includes(q(k)));
  assert.ok(!rm.includes(VOLS[0].vhd), "never a store VHD");
  assert.match(rm, /is still present: its disks are not removed while the worker may hold them/);
  assert.deepEqual(out.disks.failed, []);
  // a handle recovered after a manager restart has no list: its children are swept by the VM's own name, and only those
  const rec = host();
  await mk(rec).stop({ name: NAME, vmId: VM_ID, recovered: true });
  assert.deepEqual(rec.keys(), ["removeById", "retire", "removeRunDisks"]);
  assert.ok(rec.seen[2].includes(`-Filter ${q(`${NAME}.mv-*.vhd`)}`) && rec.seen[2].includes(`-LiteralPath ${q(RUN)}`));
  assert.throws(() => CMD.removeRunDisks({ runDir: RUN, vmId: VM_ID, name: "x*" }), /plain name/);
  // disks that read back as anything else: refused, and the VM and its disks are removed
  const lie = host({ attachDisks: { diskPaths: ["D:\\models\\qwen-a\\volume.vhd"] } });
  await assert.rejects(() => mk(lie).start(mapping, { instanceId: "dep0001-708e6409", volumes: VOLS }), /not this run's model volumes/);
  assert.deepEqual(lie.keys().slice(-3), ["removeById", "retire", "removeRunDisks"]);
  // a start that fails after the attach likewise
  const f = host({ attachDisks: (script) => ({ diskPaths: kidsOf(script) }), readConsole: { connected: true, bytes: 0, head: "" } });
  await assert.rejects(() => mk(f).start(mapping, { instanceId: "dep0001-708e6409", volumes: VOLS }), /silent partition/);
  assert.deepEqual(f.keys().slice(-3), ["removeById", "retire", "removeRunDisks"]);
  // a failed attach removes the VM too (the attach script removed its own children)
  const bad = host({ attachDisks: new Error("New-VHD: access denied") });
  await assert.rejects(() => mk(bad).start(mapping, { instanceId: "dep0001-708e6409", volumes: VOLS }), /access denied/);
  assert.ok(bad.keys().includes("removeById"));
});

test("without volumes nothing is attached, as before; disks are refused where they cannot be honoured", async () => {
  const h = host();
  await mk(h).start(mapping, { instanceId: "dep0001-708e6409" });
  assert.deepEqual(h.keys(), ["preflight", "imageHash", "define", "startAndRead"]);
  const disk = (child, parent = "D:\\models\\q\\volume.vhd") => ({ parent, child });
  const att = (disks) => CMD.attachModelDisks({ vmId: VM_ID, disks, runDir: RUN });
  assert.throws(() => checkDisks([disk(`${RUN}\\x.mv-q.vhd`)], { uefi: true, runDir: RUN }), /linux-direct boot form only/);
  await assert.rejects(() => mk(host(), { boot: BOOT_UEFI, medium: "C:\\m.iso", mediumSha256: SHA }).start(mapping, { instanceId: "dep0001-708e6409", volumes: VOLS }),
    /linux-direct boot form only/);
  assert.throws(() => att([disk("C:\\elsewhere\\x.mv-q.vhd")]), /directly in the run directory/);
  assert.throws(() => att([disk(`${RUN}\\sub\\x.vhd`)]), /directly in the run directory/);
  assert.throws(() => att([disk(`${RUN}\\x.mv-q.vhdx`)]), /directly in the run directory/);
  assert.throws(() => att([disk(`${RUN}\\x.mv-q.vhd`, "relative.vhd")]), /absolute \.vhd/);
  assert.throws(() => att([disk(`${RUN}\\x.mv-q.vhd`, "D:\\m\\it's.vhd")]), /absolute \.vhd/);
  assert.throws(() => att(Array.from({ length: 9 }, (_, i) => disk(`${RUN}\\x.mv-${i}.vhd`))), /at most 8/);
  assert.throws(() => att([]), /no disks/);
  assert.throws(() => CMD.attachModelDisks({ vmId: "not-a-guid", disks: [disk(`${RUN}\\x.mv-q.vhd`)], runDir: RUN }), /not a VM Id/);
  assert.throws(() => CMD.removeRunDisks({ paths: ["D:\\models\\q\\volume.vhd"], runDir: RUN, vmId: VM_ID }), /directly in the run directory/);
  // eight long-path volumes still fit one command line with the launcher's headroom
  const { powershellArgs } = await import("./psrun.mjs");
  const long = Array.from({ length: 8 }, (_, i) => disk(`${RUN}\\enclave-app-hvffffffffffffff-708e6409.mv-a-rather-long-model-volume-name-${i}.vhd`,
    `D:\\enclave\\model-volume-store\\a-rather-long-model-volume-name-${i}\\volume.vhd`));
  const line = ["powershell.exe", ...powershellArgs(att(long))].join(" ").length;
  assert.ok(line < 28000, `the attach script with 8 volumes encodes to ${line} chars`);
});

// ---- node-bridge's plan ----------------------------------------------------------------------------------------------
const planInput = (over = {}) => ({ deploymentId: DEP, deployment: { cpuMilli: 250, gpuMilli: 0, isPublic: true },
  version: { appId: DEP, index: 1, cid: "bafybeiftk3zeblrku6wr5cxd77szxcgg7icanbotl7ivu5lp6yadvlpi7i", memMb: 2048, ports: "" },
  appConfig: { volumes: ["qwen-a", "data-b"] }, hasSecrets: false, waf: {}, volumes: ["qwen-a", "data-b"],
  runtimeId: "cd".repeat(32), require: "hyperv-partition-per-app", appConfigCid: "",
  manager: { backend: "hyperv-partition-per-app", catalog: { derivations: [DERIVATION_V5] }, supports: { config: true, modelVolumes: true, nnPreload: true },
             volumes: [{ name: "qwen-a", backend: "ggml", kind: "model" }, { name: "data-b", backend: "none", kind: "model" }] }, ...over });

test("the plan admits the measured config's volumes the manager holds, and refuses the rest by name", () => {
  const ok = isolationPlan(planInput());
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(JSON.parse(ok.spawn.derive.config).volumes, ["qwen-a", "data-b"], "measured in the config, and nowhere else");
  assert.equal(ok.spawn.volumes, undefined);
  const m = planInput().manager;
  for (const [over, want] of [
    [{ manager: { ...m, supports: { config: true } } }, /does not mount them/],
    [{ manager: { ...m, volumes: [m.volumes[1]] } }, /"qwen-a" is not on this host/],
    [{ manager: { ...m, volumes: [{ ...m.volumes[0], kind: "inference" }, m.volumes[1]] } }, /"qwen-a" is not on this host/],
    [{ manager: { ...m, supports: { config: true, modelVolumes: true } } }, /no ggml preload/],
    [{ appConfig: { volumes: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] } }, /at most 8/],
  ]) {
    const r = isolationPlan(planInput(over));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.input, "volumes");
    assert.match(r.why, want);
  }
  // a data-only volume needs no preload
  assert.equal(isolationPlan(planInput({ appConfig: { volumes: ["data-b"] }, volumes: ["data-b"], manager: { ...m, supports: { config: true, modelVolumes: true } } })).ok, true);
  // no volumes: exactly as before, on any manager
  assert.equal(isolationPlan(planInput({ appConfig: { greeting: "hi" }, volumes: [], manager: { ...m, supports: { config: true }, volumes: [] } })).ok, true);
});
