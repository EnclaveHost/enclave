// The owner nomination's PUBLIC config path (metal/guest/owner-nomination.mjs): the one checker, the legacy guest's
// handling (gsup.mjs helpers), the HOST_DATA-bound direct config (measured-control.mjs: canonical form, digest, the
// supervisor's env, the control statement), the REAL host launcher (fw_cfg) and the image's file lists. Absent stays
// exactly as before everywhere. The on-chain half is test/owner-nomination.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as ON from "../metal/guest/owner-nomination.mjs";
import * as MC from "../metal/guest/measured-control.mjs";
import { supervisorClosure } from "../metal/supervisor-closure.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-nomination-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const a20 = (b) => "0x" + b.toString(16).padStart(2, "0").repeat(20);
const NOM = (o = {}) => {
  const endpoint = o.endpoint ?? "https://host.example.org";
  return { format: ON.OWNER_NOMINATION_FORMAT, chainId: 8453, ownershipContract: a20(0x55), ownershipCodeHash: "0x" + "ee".repeat(32), registry: a20(0x11),
    hostId: keccak256(toBytes(endpoint)), endpoint, operator: a20(0x99), owner: a20(0x0b),
    rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example", "https://rpc-c.example"], quorum: 2, ...o };
};

test("the checker: canonical form, and every malformed or unsafe nomination refused", () => {
  const n = ON.checkOwnerNomination({ ...NOM(), owner: a20(0x0b).toUpperCase().replace("0X", "0x") });
  assert.equal(n.owner, a20(0x0b));
  assert.deepEqual(Object.keys(n), ["format", "chainId", "ownershipContract", "ownershipCodeHash", "registry", "hostId", "endpoint", "operator", "owner", "rpcs", "quorum"]);
  assert.ok(Object.isFrozen(n));
  for (const [what, raw, why] of [
    ["unknown field", { ...NOM(), extra: 1 }, /unknown field extra/],
    ["missing owner", (({ owner, ...r }) => r)(NOM()), /owner is required/],
    ["zero owner", NOM({ owner: "0x" + "00".repeat(20) }), /owner must be a nonzero address/],
    ["owner is the operator key", NOM({ owner: a20(0x99) }), /other than the operator/],
    ["format", NOM({ format: "v0" }), /format must be/],
    ["endpoint trailing slash", NOM({ endpoint: "https://host.example.org/" }), /exactly as registered/],
    ["endpoint http", NOM({ endpoint: "http://host.example.org" }), /exactly as registered/],
    ["zero hostId", NOM({ hostId: "0x" + "00".repeat(32) }), /hostId must be a nonzero bytes32/],
    ["plain http rpc", NOM({ rpcs: ["http://rpc-a.example", "https://rpc-b.example"] }), /must be https/],
    ["loopback rpc without the test permission", NOM({ rpcs: ["http://127.0.0.1:8545", "https://rpc-b.example"] }), /must be https/],
    ["repeated provider", NOM({ rpcs: ["https://rpc-a.example/x", "https://rpc-a.example/y"] }), /repeats a provider/],
    ["quorum 1", NOM({ quorum: 1 }), /strict majority/],
    ["quorum not a majority", NOM({ rpcs: ["https://a.example", "https://b.example", "https://c.example", "https://d.example"], quorum: 2 }), /strict majority/],
    ["one rpc", NOM({ rpcs: ["https://a.example"], quorum: 1 }), /2\.\.8/],
  ]) assert.throws(() => ON.checkOwnerNomination(raw), why, what);
  assert.equal(ON.checkOwnerNomination(NOM({ rpcs: ["http://127.0.0.1:1", "http://127.0.0.1:2"], quorum: 2 }), { allowLoopbackHttp: true }).quorum, 2);
});

test("legacy guest: fw_cfg is the ONLY source of the supervisor's nomination name; absent or invalid sets none", () => {
  assert.deepEqual(ON.guestOwnerNomination(undefined), { nomination: null, message: null });
  const ok = ON.guestOwnerNomination(JSON.parse(JSON.stringify(ON.checkOwnerNomination(NOM()))));
  assert.match(ok.message, /owner nomination configured: propose 0x0b0b/);
  const env = ON.withOwnerNominationEnv({ PATH: "/bin", [ON.OWNER_NOMINATION_ENV]: JSON.stringify(NOM({ owner: a20(0xf5) })) }, ok.nomination);
  assert.deepEqual(JSON.parse(env[ON.OWNER_NOMINATION_ENV]), JSON.parse(JSON.stringify(ok.nomination)), "a flavor/host-policy copy of the name is replaced");
  assert.equal(env.PATH, "/bin");
  const badOne = ON.guestOwnerNomination({ ...NOM(), owner: a20(0x99) });
  assert.equal(badOne.nomination, null); assert.match(badOne.message, /REFUSED/);
  assert.deepEqual(ON.withOwnerNominationEnv({ B: "2", [ON.OWNER_NOMINATION_ENV]: "{}" }, null), { B: "2" }, "absent: no stray name survives");
  const gsup = fs.readFileSync(path.join(REPO, "metal/guest/gsup.mjs"), "utf8");
  assert.match(gsup, /const OWNER_NOMINATION = CONTROL \? \{ nomination: null, message: null \} : guestOwnerNomination\(fw\.ownerNomination\);/);
  assert.match(gsup, /withOwnerNominationEnv\(withLeaseGasEnv\(supEnv, LEASE_GAS\), OWNER_NOMINATION\.nomination\)/);
});

// the direct (HOST_DATA-bound) config, as test/metal-lease-gas-conduit.test.mjs writes it
const RAW = () => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a20(0x11), deployments: a20(0x12), appCatalog: a20(0x13), proofOfTime: a20(0x14), enclavePay: a20(0), verificationFees: a20(0), sessionVaultFactory: a20(0), secretVaultV2: a20(0) },
  profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
  replicas: { gateways: ["http://192.0.2.10:8189", "https://replica.example"], storagePlan: null },
  identity: { publicUrl: "https://host.example.org", repo: "owner/enclave", operator: a20(0x99) },
  selling: { cpuPrice6: 14, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" }, hostAdmissionSha256: null, controlPort: 8444 });
const BOUND = () => JSON.parse(JSON.stringify(ON.checkOwnerNomination(NOM())));
const KEYS = { proof: { publicKey: "04" + "11".repeat(64) }, session: { jwk: { crv: "P-256", kty: "EC", x: "x", y: "y" } }, controlTls: { spkiSha256: "22".repeat(32) } };

test("direct config: absent keeps the exact config and digest; present it is bound, stated and handed to the supervisor", () => {
  const old = MC.canonicalDirectConfig(RAW()), withN = MC.canonicalDirectConfig({ ...RAW(), ownerNomination: BOUND() });
  assert.equal("ownerNomination" in old, false);
  assert.notEqual(MC.configDigest(withN), MC.configDigest(old), "HOST_DATA covers it: changing it changes the bound digest");
  assert.notEqual(MC.configDigest(MC.canonicalDirectConfig({ ...RAW(), ownerNomination: { ...BOUND(), owner: a20(0x0c) } })), MC.configDigest(withN));
  assert.deepEqual(withN.ownerNomination, ON.checkOwnerNomination(NOM()));
  const env = MC.directSupervisorEnv(withN, { secrets: { secret: "ab".repeat(32) } });
  assert.equal(env[ON.OWNER_NOMINATION_ENV], ON.ownerNominationJson(ON.checkOwnerNomination(NOM())));
  assert.equal(ON.OWNER_NOMINATION_ENV in MC.directSupervisorEnv(old, { secrets: { secret: "ab".repeat(32) } }), false);
  assert.deepEqual(MC.directEnvProblems(env), [], "the direct env rules still hold");
  for (const [what, n, why] of [
    ["another operator", { ...BOUND(), operator: a20(0x98) }, /operator must be identity\.operator/],
    ["another endpoint", JSON.parse(JSON.stringify(ON.checkOwnerNomination(NOM({ endpoint: "https://other.example.org" })))), /endpoint must be identity\.publicUrl/],
    ["another registry", { ...BOUND(), registry: a20(0x12) }, /registry must be contracts\.registry/],
    ["another chain", { ...BOUND(), chainId: 1 }, /chain 1/],
    ["not in its checked form", { ...BOUND(), owner: a20(0x0b).replace("0x0b0b", "0x0B0b") }, /checked form/],
    ["unknown field", { ...BOUND(), x: 1 }, /unknown field/],
  ]) assert.throws(() => MC.canonicalDirectConfig({ ...RAW(), ownerNomination: n }), why, what);
  // the control statement names it (contract, code hash, host, owner); one without keeps its exact shape
  const st = MC.controlStatement({ config: withN, digest: "33".repeat(32), hostData: "44".repeat(32), mode: "snp", keys: KEYS, bootId: "55".repeat(16) });
  assert.deepEqual(MC.parseStatement(st.text).ownerNomination, { ownershipContract: a20(0x55), ownershipCodeHash: "0x" + "ee".repeat(32), hostId: NOM().hostId, owner: a20(0x0b) });
  const plain = MC.controlStatement({ config: old, digest: "33".repeat(32), hostData: "44".repeat(32), mode: "snp", keys: KEYS, bootId: "55".repeat(16) });
  assert.equal("ownerNomination" in MC.parseStatement(plain.text), false);
  const forged = JSON.parse(st.text); forged.ownerNomination.extra = 1;
  assert.throws(() => MC.parseStatement(MC.canonicalJson(forged)), /owner nomination/);
});

// ---- the real launcher (as test/metal-lease-gas-conduit.test.mjs drives it) ----------------------------------------------
const KEY = "ab".repeat(32);
function launch(cfgOver, { direct = null } = {}) {
  const t = fs.mkdtempSync(path.join(tmp, "launch-"));
  fs.mkdirSync(path.join(t, "dist")); fs.mkdirSync(path.join(t, "tmp"));
  fs.writeFileSync(path.join(t, "dist", "vmlinuz"), "k"); fs.writeFileSync(path.join(t, "dist", "initramfs.cpio.gz"), "i");
  fs.writeFileSync(path.join(t, "pair.key"), KEY + "\n", { mode: 0o600 });
  if (direct) fs.writeFileSync(path.join(t, "direct.json"), JSON.stringify(direct));
  fs.writeFileSync(path.join(t, "fake-qemu"), ["#!/bin/sh", "while [ $# -gt 0 ]; do",
    '  if [ "$1" = -fw_cfg ]; then case "$2" in name=opt/org.enclave.metal,file=*) cp "${2#name=opt/org.enclave.metal,file=}" "$FAKE_QEMU_OUT.tmp" && mv "$FAKE_QEMU_OUT.tmp" "$FAKE_QEMU_OUT";; esac; fi',
    "  shift", "done", "exec sleep 30"].join("\n") + "\n", { mode: 0o755 });
  const cfg = { mode: "snp", name: "owner-test", cpus: 1, memMiB: 512, measureGflops: false, dist: path.join(t, "dist"), ovmf: path.join(t, "ovmf.fd"),
    qemu: path.join(t, "fake-qemu"), relayUrl: "wss://relay.example.test/v1/fleet-tunnel",
    isolation: { backend: "snp-guest-per-app", managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKeyFile: path.join(t, "pair.key") },
    ...(direct ? { control: "direct", direct: path.join(t, "direct.json"), relayUrl: undefined, hostfwd: [{ host: 18444, guest: 8444 }] } : {}), ...cfgOver };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
  fs.writeFileSync(path.join(t, "config.json"), JSON.stringify(cfg));
  const out = path.join(t, "fwcfg.json");
  const p = spawn(process.execPath, [path.join(REPO, "metal/enclave-metal.mjs"), "--config", path.join(t, "config.json")],
    { env: { ...process.env, TMPDIR: path.join(t, "tmp"), FAKE_QEMU_OUT: out }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; });
  const exited = new Promise((r) => p.on("exit", (code) => r(code)));
  return { out, p, exited, log: () => log };
}
async function launched(cfgOver = {}, o = {}) {
  const run = launch(cfgOver, o);
  try {
    for (let i = 0; i < 200 && !fs.existsSync(run.out); i++) { if (run.p.exitCode !== null) break; await new Promise((r) => setTimeout(r, 50)); }
    if (!fs.existsSync(run.out)) return { refused: true, code: await Promise.race([run.exited, new Promise((r) => setTimeout(() => r("running"), 3000))]), log: run.log() };
    return { fw: JSON.parse(fs.readFileSync(run.out, "utf8")), log: run.log() };
  } finally { if (run.p.exitCode === null && run.p.signalCode === null) { run.p.kill("SIGTERM"); await run.exited; } }
}

test("the real launcher: the operator's own nomination crosses checked; a wrong one refuses the launch; absent stays absent", async () => {
  const key = generatePrivateKey(), op = privateKeyToAccount(key).address.toLowerCase();
  const pub = "https://api.example.test/t/owner-test";
  const nom = NOM({ endpoint: pub, operator: op });
  for (const k of [key, key.slice(2)]) {   // the operator key as the supervisor accepts it: with or without 0x
    const r = await launched({ publicUrl: pub, registryKey: k, ownerNomination: nom });
    assert.ok(!r.refused, r.log);
    assert.deepEqual(r.fw.ownerNomination, JSON.parse(JSON.stringify(ON.checkOwnerNomination(nom))));
    assert.match(r.log, /owner nomination: propose 0x0b0b/);
  }
  const unkeyed = await launched({ publicUrl: pub, ownerNomination: nom });
  assert.ok(!unkeyed.refused, unkeyed.log);   // no host-side key: the supervisor checks against its own key
  for (const [what, over, why] of [
    ["another operator's key", { publicUrl: pub, registryKey: generatePrivateKey(), ownerNomination: nom }, /is not this host's operator key/],
    ["another endpoint", { publicUrl: "https://api.example.test/t/other", ownerNomination: nom }, /must be this host's publicUrl/],
    ["invalid", { publicUrl: pub, ownerNomination: { ...nom, owner: op } }, /other than the operator/],
  ]) { const r = await launched(over); assert.equal(r.refused, true, what); assert.match(r.log, why, what); }
  const off = await launched({ publicUrl: pub });
  assert.ok(!off.refused, off.log); assert.equal("ownerNomination" in off.fw, false);
});

test("the real launcher, direct control: only the HOST_DATA-bound copy; a host-level one refuses", async () => {
  const r = await launched({ ownerNomination: NOM() }, { direct: { ...RAW(), ownerNomination: BOUND() } });
  assert.equal(r.refused, true, r.log); assert.match(r.log, /takes ownerNomination only inside the bound direct config/);
  const ok = await launched({}, { direct: { ...RAW(), ownerNomination: BOUND() } });
  assert.ok(!ok.refused, ok.log);
  assert.deepEqual(ok.fw.direct.ownerNomination, BOUND()); assert.equal("ownerNomination" in ok.fw, false);
});

test("the image carries it: supervisor closure, the overlay's guest helpers and the image builder's list", () => {
  const { files } = supervisorClosure(REPO);
  for (const f of ["metal/guest/owner-nomination.mjs", "network/host-owner-nomination.mjs", "client/lease-executor-authority.mjs"]) assert.ok(files.includes(f), f);
  assert.match(fs.readFileSync(path.join(REPO, "metal/overlay-control-image.py"), "utf8"), /OPTIONAL_GUEST_FILES = \[.*'owner-nomination\.mjs'\]/);
  assert.match(fs.readFileSync(path.join(REPO, "metal/build-image.mjs"), "utf8"), /'measured-control\.mjs', 'owner-nomination\.mjs'\]\)/);
  // dependency-free: the guest copy imports nothing
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, "metal/guest/owner-nomination.mjs"), "utf8"), /^import /m);
});
