// The launcher's per-app isolation runtime config: what a metal node's host hands its guest over fw_cfg as
// `isolation`. The attested-release opt-in is the operator's `isolation.release: true` in the host config
// (isolation/restore/ENABLEMENT.md step 3); gsup reads it from fw_cfg and only then passes ISOLATION_RELEASE=1 to the
// supervisor. 4c-c-b (2026-09-25) booted the gsup half with the host half missing: the launcher built fw_cfg's
// `isolation` from three named keys and dropped `release`, so gsup logged "attested release off".
//
// Three layers, because a text-sliced helper alone is the kind of check that missed it (enclave-d1):
//   1. isoRuntimeOf, sliced out by text (enclave-metal.mjs launches QEMU at import; the certsCfg pattern);
//   2. the REAL launcher, run with a fake QEMU that copies out the fw_cfg file it is handed: the bytes the guest reads;
//   3. the contract across the boundary: gsup still reads fw_cfg `isolation` and gates on `release === true`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(repo, "metal", "enclave-metal.mjs");
const src = fs.readFileSync(LAUNCHER, "utf8");
const gsup = fs.readFileSync(join(repo, "metal", "guest", "gsup.mjs"), "utf8");
const start = src.indexOf("function isoRuntimeOf(");
const end = src.indexOf("const ISO = (cfg.isolation");
assert.ok(start > 0 && end > start, "isoRuntimeOf must stay a self-contained block in enclave-metal.mjs");
const isoRuntimeOf = new Function(src.slice(start, end) + "\nreturn isoRuntimeOf;")();

const KEY = "ab".repeat(32);
const BASE = { backend: "snp-guest-per-app", managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096",
               pairingKeyFile: "/home/op/enclave-prod/guestd-pair.key" };

// ---- 1. the decision ----------------------------------------------------------------------------------------------
test("release: true is forwarded, with the endpoints and the key, and nothing else", () => {
  assert.deepEqual(isoRuntimeOf({ ...BASE, release: true }, KEY),
    { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKey: KEY, release: true });
});

test("absent or false forwards NO release key; any other value refuses (a typo must not pass for an opt-in)", () => {
  for (const release of [undefined, false])
    assert.deepEqual(Object.keys(isoRuntimeOf({ ...BASE, release }, KEY)).sort(), ["dataAddr", "managerUrl", "pairingKey"],
      `release=${JSON.stringify(release)}`);
  for (const release of ["true", "false", 1, 0, "yes", null, {}, [true]])
    assert.throws(() => isoRuntimeOf({ ...BASE, release }, KEY), /isolation\.release must be the boolean true or false/,
      `release=${JSON.stringify(release)} must refuse`);
});

test("no other isolation key crosses to the guest (backend, the key FILE path, anything added later)", () => {
  const out = isoRuntimeOf({ ...BASE, release: true, extra: "x", legacyImage: true, minTcb: {} }, KEY);
  assert.deepEqual(Object.keys(out).sort(), ["dataAddr", "managerUrl", "pairingKey", "release"]);
  assert.ok(!JSON.stringify(out).includes("guestd-pair.key"), "the key file path stays on the host");
});

test("the endpoints default as before and must be IPv4 literals", () => {
  assert.deepEqual(isoRuntimeOf({ backend: "snp-guest-per-app" }, KEY),
    { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKey: KEY });
  assert.throws(() => isoRuntimeOf({ ...BASE, managerUrl: "http://guestd.local:8095" }, KEY), /IPv4 literals/);
  assert.throws(() => isoRuntimeOf({ ...BASE, dataAddr: "[::1]:8096" }, KEY), /IPv4 literals/);
});

// ---- 2. the real launcher, a fake QEMU ------------------------------------------------------------------------------
// The fake QEMU copies the file named by `-fw_cfg name=opt/org.enclave.metal,file=…` (what the guest reads at
// /sys/firmware/qemu_fw_cfg/by_name/opt/org.enclave.metal/raw) to $FAKE_QEMU_OUT, then sleeps until the launcher
// stops it. TMPDIR is private, so the launcher's stale-fw_cfg sweep never looks at the real /tmp.
function launchWith(isolation) {
  const t = fs.mkdtempSync(join(os.tmpdir(), "metal-iso-test-"));
  fs.mkdirSync(join(t, "dist")); fs.mkdirSync(join(t, "tmp"));
  fs.writeFileSync(join(t, "dist", "vmlinuz"), "not a kernel");
  fs.writeFileSync(join(t, "dist", "initramfs.cpio.gz"), "not an initrd");
  fs.writeFileSync(join(t, "pair.key"), KEY + "\n", { mode: 0o600 });
  fs.writeFileSync(join(t, "fake-qemu"), [
    "#!/bin/sh",
    "while [ $# -gt 0 ]; do",
    '  if [ "$1" = -fw_cfg ]; then case "$2" in name=opt/org.enclave.metal,file=*)',
    '    cp "${2#name=opt/org.enclave.metal,file=}" "$FAKE_QEMU_OUT.tmp" && mv "$FAKE_QEMU_OUT.tmp" "$FAKE_QEMU_OUT";; esac; fi',
    "  shift",
    "done",
    "exec sleep 30",
  ].join("\n") + "\n", { mode: 0o755 });
  const cfg = { mode: "snp", name: "iso-test", cpus: 1, memMiB: 512, dist: join(t, "dist"), ovmf: join(t, "ovmf.fd"),
                qemu: join(t, "fake-qemu"), relayUrl: "wss://relay.example.test/v1/fleet-tunnel",
                isolation: { ...BASE, pairingKeyFile: join(t, "pair.key"), ...isolation } };
  fs.writeFileSync(join(t, "config.json"), JSON.stringify(cfg));
  const out = join(t, "fwcfg.json");
  const p = spawn(process.execPath, [LAUNCHER, "--config", join(t, "config.json")],
    { env: { ...process.env, TMPDIR: join(t, "tmp"), FAKE_QEMU_OUT: out }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; });
  const exited = new Promise((r) => p.on("exit", (code, sig) => r({ code, sig })));
  return { t, p, out, exited, log: () => log };
}
async function fwCfgOf(isolation) {
  const run = launchWith(isolation);
  try {
    const first = await Promise.race([
      (async () => { for (let i = 0; i < 200; i++) { if (fs.existsSync(run.out)) return "file"; await new Promise((r) => setTimeout(r, 50)); } return "timeout"; })(),
      run.exited.then(() => "exited"),
    ]);
    assert.equal(first, "file", `the fake QEMU never received the fw_cfg file (${first}); launcher output:\n${run.log()}`);
    return { fw: JSON.parse(fs.readFileSync(run.out, "utf8")), log: run.log() };
  } finally {
    run.p.kill("SIGTERM");                  // this exact child; its handler stops the fake QEMU
    await run.exited;
    fs.rmSync(run.t, { recursive: true, force: true });
  }
}

test("the real launcher hands the guest isolation.release === true for release: true", async () => {
  const { fw, log } = await fwCfgOf({ release: true });
  assert.deepEqual(fw.isolation, { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKey: KEY, release: true });
  assert.match(log, /attested release OPTED IN/);
});

test("the real launcher hands the guest NO release key when it is absent or false", async () => {
  for (const isolation of [{}, { release: false }]) {
    const { fw, log } = await fwCfgOf(isolation);
    assert.deepEqual(Object.keys(fw.isolation).sort(), ["dataAddr", "managerUrl", "pairingKey"], JSON.stringify(isolation));
    assert.match(log, /attested release off/);
  }
});

test("the real launcher REFUSES release: \"true\" (a string) and never starts QEMU", async () => {
  const run = launchWith({ release: "true" });
  try {
    // it must EXIT, before any QEMU: a launcher that reads the typo as "off" starts QEMU instead (and never exits)
    const first = await Promise.race([
      run.exited.then(({ code }) => ({ what: "exited", code })),
      (async () => { for (let i = 0; i < 200; i++) { if (fs.existsSync(run.out)) return { what: "qemu started" }; await new Promise((r) => setTimeout(r, 50)); } return { what: "timeout" }; })(),
    ]);
    assert.equal(first.what, "exited", `a non-boolean release must fail the launch, not run it (${first.what}); output:\n${run.log()}`);
    assert.notEqual(first.code, 0, "a non-boolean release must fail the launch");
    assert.match(run.log(), /isolation\.release must be the boolean true or false/);
    assert.equal(fs.existsSync(run.out), false, "QEMU must not have been started");
  } finally {
    if (run.p.exitCode === null && run.p.signalCode === null) { run.p.kill("SIGTERM"); await run.exited; }
    fs.rmSync(run.t, { recursive: true, force: true });
  }
});

// ---- 3. the contract across the boundary ----------------------------------------------------------------------------
test("the host half and the guest half name the same thing", () => {
  // the launcher puts isoRuntimeOf's result into fw_cfg as `isolation`...
  assert.match(src, /ISO_RUNTIME = isoRuntimeOf\(ISO, key\);/);
  assert.match(src, /\.\.\.\(ISO_RUNTIME \? \{ isolation: ISO_RUNTIME \} : \{\}\)/);
  // ...and gsup reads fw_cfg's `isolation` and opts in on exactly `release === true`
  assert.match(gsup, /const ISO_CFG = \(fw\.isolation && typeof fw\.isolation === 'object'\) \? fw\.isolation : \{\};/);
  assert.match(gsup, /\.\.\.\(ISO_CFG\.release === true \? \{ ISOLATION_RELEASE: '1' \} : \{\}\)/);
});
