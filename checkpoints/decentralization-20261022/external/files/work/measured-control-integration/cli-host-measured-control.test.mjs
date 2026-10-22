// cli/host-independent-lifecycle.mjs with work/measured-control-integration/lifecycle.patch applied: a plan whose supervisor
// runs in the MEASURED control guest. Belongs at test/cli-host-measured-control.test.mjs once the patch lands; until then it
// runs in a scratch copy of the tree with the patch applied. Disposable keys only; nothing leaves 127.0.0.1.
//   * init records the owner's measurements, TCB floor, image and OVMF; refuses combinations it cannot derive honestly;
//   * install writes the guest's direct config and the launcher config, and the REAL metal/enclave-metal.mjs (fake QEMU)
//     accepts them: the measured cmdline token, the config in fw_cfg and HOST_DATA binding exactly that config;
//   * check reports the control row from metal/measured-control-verify.mjs: READY only for "verified".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hostLifecycle, loadPlan, planTrust, directControlConfig, controlLauncherConfig, readinessRows } from "../cli/host-independent-lifecycle.mjs";
import * as MC from "../metal/guest/measured-control.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = path.join(REPO, "contracts/deployments/network-profile-base.json");
const PROFILE_DIGEST = "sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8";
const MEAS = "77".repeat(48);
function scratch(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "host-measured-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
async function cli(argv, opts = {}) {
  const out = [], err = [];
  const code = await hostLifecycle(argv, { out: (s) => out.push(s), err: (s) => err.push(s), env: { HOME: "/nonexistent", ...opts.env }, ...opts.deps });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
function setup(d) {
  const img = path.join(d, "image"); fs.mkdirSync(img); fs.writeFileSync(path.join(img, "vmlinuz"), "k"); fs.writeFileSync(path.join(img, "initramfs.cpio.gz"), "i");
  fs.writeFileSync(path.join(d, "ovmf.fd"), "firmware");
  fs.writeFileSync(path.join(d, "min-tcb.json"), JSON.stringify({ Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } }));
  return { img, ovmf: path.join(d, "ovmf.fd"), minTcb: path.join(d, "min-tcb.json") };
}
const initArgs = (dir, s, extra = []) => ["init", "--dir", dir, "--profile", PROFILE, "--profile-digest", PROFILE_DIGEST, "--rpc", "https://rpc-a.example,https://rpc-b.example",
  "--public-url", "https://host.example.org", "--repo", "example/enclave", "--release-id", "a".repeat(64), "--gateways", "http://203.0.113.5:8189",
  "--guest-mem-mib", "4096", "--guest-cpus", "2", "--price-cpu", "0.05",
  "--control-image", s.img, "--control-measurements", MEAS, "--control-min-tcb", s.minTcb, "--control-ovmf", s.ovmf, "--control-port", "18444", ...extra];

test("init records the measured control plan, and refuses what it cannot derive honestly", async (t) => {
  const d = scratch(t), s = setup(d), dir = path.join(d, "h");
  const r = await cli(initArgs(dir, s));
  assert.equal(r.code, 0, r.err);
  const plan = loadPlan(dir);
  assert.deepEqual(plan.control, { mode: "measured-guest", endpoint: "https://127.0.0.1:18444", hostPort: 18444, measurements: [MEAS], minTcb: s.minTcb, image: s.img, ovmf: s.ovmf, cpus: 4, memMiB: 8192 });
  for (const [extra, re] of [[["--control-measurements", "abc"], /control\.measurements/], [["--policy-dir", path.join(d, "pol")], /hostAdmission/],
    [["--attestation-url", "http://127.0.0.1:1/x"], /attestationUrl does not apply/]]) {
    const args = initArgs(path.join(d, "x" + Math.random().toString(36).slice(2)), s);
    const i = args.indexOf(extra[0]); if (i >= 0) args.splice(i, 2);
    const bad = await cli([...args, ...extra]);
    assert.equal(bad.code, 1, `${extra[0]} must refuse`); assert.match(bad.err, re);
  }
  const run = await cli(["run", "--dir", dir, "--component", "supervisor", "--dry-run"]);
  assert.equal(run.code, 1); assert.match(run.err, /inside the measured control guest/);
});

test("install writes the guest's bound config and the launcher config; the REAL launcher accepts them and binds HOST_DATA", async (t) => {
  const d = scratch(t), s = setup(d), dir = path.join(d, "h"), ud = path.join(d, "units");
  assert.equal((await cli(initArgs(dir, s))).code, 0);
  const plan = loadPlan(dir), ctx = planTrust(plan);
  fs.writeFileSync(path.join(dir, "pair.key"), "cd".repeat(32) + "\n", { mode: 0o600 });
  fs.mkdirSync(plan.guestd.collateralDir, { recursive: true }); fs.writeFileSync(path.join(plan.guestd.collateralDir, "vcek.der"), "vcek");
  const dry = await cli(["install", "--dir", dir, "--unit-dir", ud]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /enclave-independent-host-control\.service/); assert.doesNotMatch(dry.out, /-supervisor\.service/);
  assert.match(dry.out, /metal\/enclave-metal\.mjs/);
  const operator = privateKeyToAccount(fs.readFileSync(path.join(dir, "operator.key"), "utf8").trim()).address;
  assert.doesNotMatch(dry.out, new RegExp(fs.readFileSync(path.join(dir, "operator.key"), "utf8").trim().slice(2)), "the key is named, never printed");
  const applied = await cli(["install", "--dir", dir, "--unit-dir", ud, "--apply"]);
  assert.equal(applied.code, 0, applied.err);
  const direct = JSON.parse(fs.readFileSync(path.join(dir, "direct-control.json"), "utf8"));
  assert.deepEqual(direct, JSON.parse(JSON.stringify(directControlConfig(plan, ctx, operator))));
  assert.equal(direct.identity.operator, operator.toLowerCase()); assert.equal(direct.isolation.managerUrl, "http://10.0.2.2:8095"); assert.equal(direct.selling.cpuPrice6, 14);
  assert.equal(fs.statSync(path.join(dir, "control-launcher.json")).mode & 0o777, 0o600);
  // the REAL launcher with that config (QEMU swapped for a recorder)
  const launcherCfg = { ...JSON.parse(fs.readFileSync(path.join(dir, "control-launcher.json"), "utf8")), qemu: path.join(d, "fake-qemu") };
  assert.deepEqual({ ...launcherCfg, qemu: undefined }, { ...JSON.parse(JSON.stringify(controlLauncherConfig(dir, plan))), qemu: undefined });
  fs.writeFileSync(path.join(d, "fake-qemu"), ["#!/bin/sh", 'printf "%s\\n" "$@" > "$FAKE_ARGS"', "while [ $# -gt 0 ]; do",
    '  if [ "$1" = -fw_cfg ]; then case "$2" in name=opt/org.enclave.metal,file=*) cp "${2#name=opt/org.enclave.metal,file=}" "$FAKE_OUT";; esac; fi', "  shift", "done", "exec sleep 30"].join("\n") + "\n", { mode: 0o755 });
  const cfgFile = path.join(d, "launch.json"); fs.writeFileSync(cfgFile, JSON.stringify(launcherCfg));
  fs.mkdirSync(path.join(d, "tmp"));
  const out = path.join(d, "fw.json"), args = path.join(d, "args.txt");
  const p = spawn(process.execPath, [path.join(REPO, "metal/enclave-metal.mjs"), "--config", cfgFile], { env: { ...process.env, TMPDIR: path.join(d, "tmp"), FAKE_OUT: out, FAKE_ARGS: args }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (b) => { log += b; }); p.stderr.on("data", (b) => { log += b; });
  const exited = new Promise((r) => p.on("exit", r));
  try {
    for (let i = 0; i < 200 && !fs.existsSync(out) && p.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(out), `the launcher did not start the guest:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
    const fw = JSON.parse(fs.readFileSync(out, "utf8")), argv = fs.readFileSync(args, "utf8").split("\n");
    assert.deepEqual(fw.direct, direct);
    const hd = MC.hostDataHex(MC.configDigest(MC.canonicalDirectConfig(direct)));
    assert.ok(argv.some((x) => x.startsWith("sev-snp-guest,") && x.includes(`host-data=${Buffer.from(hd, "hex").toString("base64")}`)), "HOST_DATA binds the installed config");
    assert.equal(argv[argv.indexOf("-append") + 1], "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct");
    const plan2 = await MC.planDirectBoot({ cmdline: argv[argv.indexOf("-append") + 1], fw, reportHostData: hd, viem });
    assert.equal(plan2.ok, true, plan2.reasons?.join("; "));
    assert.equal(plan2.operator, operator.toLowerCase());
  } finally { p.kill("SIGTERM"); await exited; }
});

test("check: the control row is READY only for a verified guest; pending, unknown and rejected never are", async (t) => {
  const d = scratch(t), s = setup(d), dir = path.join(d, "h");
  assert.equal((await cli(initArgs(dir, s))).code, 0);
  const plan = loadPlan(dir);
  fs.mkdirSync(plan.guestd.collateralDir, { recursive: true });
  for (const f of ["vcek.der", "cert_chain.pem"]) fs.writeFileSync(path.join(plan.guestd.collateralDir, f), "x");
  const chainFactory = () => ({ snapshot: async () => { throw new Error("no agreeing quorum (test)"); }, balance: async () => { throw new Error("no agreeing quorum (test)"); } });
  const rowFor = async (verifyControl) => (await readinessRows(dir, {}, { chainFactory, verifyControl, env: { HOME: d } })).find((r) => r.item === "control attestation");
  const seen = [];
  const fake = (status) => async (args) => { seen.push(args); return { status, identity: { measurement: MEAS, proofKey: "0x" + "12".repeat(20) }, reasons: [`${status.toUpperCase()} (x): because`] }; };
  assert.equal((await rowFor(fake("verified"))).status, "ready");
  assert.equal((await rowFor(fake("pending"))).status, "missing");
  assert.equal((await rowFor(fake("unknown"))).status, "unknown");
  assert.equal((await rowFor(fake("rejected"))).status, "failed");
  const a = seen[0];
  assert.equal(a.url, "https://127.0.0.1:18444"); assert.deepEqual(a.expect.measurements, [MEAS]); assert.equal(a.expect.crl, "required");
  assert.equal(a.expect.config.identity.publicUrl, "https://host.example.org"); assert.equal(typeof a.registry, "function");
  await assert.rejects(a.registry(MC.sha256Hex("x")), /no agreeing quorum/, "the registry is read through the owner's quorum (here: failing)");
  // the real verifier, nothing listening: UNKNOWN, and the whole check is not ready
  const port = await new Promise((ok) => { const sv = net.createServer(); sv.listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => ok(p)); }); });
  const real = await readinessRows(dir, {}, { chainFactory, env: { HOME: d } });
  assert.equal(real.find((r) => r.item === "control attestation").status, "unknown");
  assert.ok(!real.some((r) => r.item === "supervisor running"), "no host supervisor is probed for a measured plan");
  void port;
});
