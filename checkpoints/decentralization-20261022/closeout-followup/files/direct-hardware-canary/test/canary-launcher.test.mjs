// Source-level dry run of the canary launch path, with NO QEMU: the PUBLISHED launcher (tree/metal/enclave-metal.mjs) runs with
// the canary's exact host-config shape and canary/qemu-restrict.sh as cfg.qemu, but the wrapper's "real QEMU" is
// test/fake-qemu.sh, which only records its argv and the fw_cfg file and sleeps. Then the PUBLISHED planDirectBoot judges that
// fw_cfg against the measured cmdline. Plus the wrapper's refusals and verify-canary's acceptance() rules.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const D = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TREE = path.join(D, "tree"), IMAGE = path.resolve(D, "../measured-image-build/image/dist-direct-6f2c7da46");
const MC = await import(path.join(TREE, "metal/guest/measured-control.mjs"));
const { buildOwnerConfig } = await import(path.join(D, "canary/owner-config.mjs"));
const { acceptance, hardwareVerdict } = await import(path.join(D, "canary/verify-canary.mjs"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const FAKE = path.join(D, "test/fake-qemu.sh"), WRAP = path.join(D, "canary/qemu-restrict.sh");
const CMDLINE = "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the published launcher builds the measured, restricted, key-less launch from the canary config", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canary-dry-")); fs.chmodSync(tmp, 0o700);
  const priv = path.join(tmp, "private"); fs.mkdirSync(path.join(priv, "tmp"), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const oc = buildOwnerConfig({ managerPort: 40961, dataPort: 40962 });
  fs.writeFileSync(path.join(priv, "owner-config.json"), oc.text, { mode: 0o600 });
  const key = "ab".repeat(32); fs.writeFileSync(path.join(priv, "pairing.key"), key + "\n", { mode: 0o600 });
  const host = { mode: "snp", name: "direct-control-canary", cpus: 4, memMiB: 4096, dist: IMAGE, ovmf: "/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd",
    qemu: WRAP, sevDevice: "/dev/sev", control: "direct", direct: path.join(priv, "owner-config.json"),
    isolation: { backend: "snp-guest-per-app", pairingKeyFile: path.join(priv, "pairing.key"), managerUrl: "http://10.0.2.2:40961", dataAddr: "10.0.2.2:40962" },
    hostfwd: [{ host: 40960, guest: 8444 }], measureGflops: false };
  fs.writeFileSync(path.join(priv, "host-config.json"), JSON.stringify(host), { mode: 0o600 });
  const argvFile = path.join(tmp, "argv.bin"), fwCopy = path.join(tmp, "fwcfg.json");
  assert.notEqual(FAKE, "/usr/bin/qemu-system-x86_64");
  const env = { PATH: `${D}/bin:/usr/bin:/usr/sbin:/bin`, HOME: process.env.HOME, LANG: "C.UTF-8", TMPDIR: path.join(priv, "tmp"),
    CANARY_REAL_QEMU: FAKE, CANARY_REAL_QEMU_SHA256: sha(fs.readFileSync(FAKE)), CANARY_QEMU_ARGV_LOG: path.join(tmp, "qemu-argv.log"),
    FAKE_ARGV: argvFile, FAKE_FWCFG_COPY: fwCopy };
  const L = spawn(process.execPath, [path.join(TREE, "metal/enclave-metal.mjs"), "--config", path.join(priv, "host-config.json")], { env, cwd: priv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; L.stdout.on("data", (d) => (log += d)); L.stderr.on("data", (d) => (log += d));
  t.after(() => { try { process.kill(-L.pid, "SIGKILL"); } catch {} });
  const end = Date.now() + 30000;
  while (Date.now() < end && !fs.existsSync(argvFile)) await sleep(100);
  assert.ok(fs.existsSync(argvFile), log);
  process.kill(-L.pid, "SIGTERM"); await new Promise((r) => L.once("exit", r));
  const argv = fs.readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
  const val = (f) => argv.flatMap((x, i) => (x === f ? [argv[i + 1]] : []));
  assert.deepEqual(val("-append"), [CMDLINE]);
  assert.deepEqual(val("-smp"), ["4"]); assert.deepEqual(val("-m"), ["4096"]);
  assert.deepEqual(val("-kernel"), [path.join(IMAGE, "vmlinuz")]); assert.deepEqual(val("-initrd"), [path.join(IMAGE, "initramfs.cpio.gz")]);
  assert.deepEqual(val("-bios"), [host.ovmf]);
  assert.deepEqual(val("-netdev"), ["user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:40960-:8444"], "restricted slirp, one loopback forward to the control front only");
  const snp = val("-object").filter((x) => x.startsWith("sev-snp-guest,"));
  assert.equal(snp.length, 1); assert.match(snp[0], /kernel-hashes=on/);
  assert.ok(snp[0].includes(`host-data=${Buffer.from(oc.hostData, "hex").toString("base64")}`), "HOST_DATA binds the owner config");
  assert.ok(!argv.includes("-drive"));
  assert.equal(fs.readFileSync(fwCopy + ".mode", "utf8").trim(), "600");
  const fw = JSON.parse(fs.readFileSync(fwCopy, "utf8"));
  for (const k of ["registryKey", "fleetSecret", "relayUrl", "tunnelToken"]) assert.equal(fw[k], "", k);
  assert.ok(!fw.certsApi && !fw.acmeEabKid && !fw.relayHost && !fw.leaseGas && !fw.ownerNomination);
  assert.deepEqual(fw.volumes, []); assert.deepEqual(fw.direct, JSON.parse(oc.text));
  assert.deepEqual(fw.isolation, { managerUrl: "http://10.0.2.2:40961", dataAddr: "10.0.2.2:40962", pairingKey: key });
  // the guest's own boot decision on exactly this fw_cfg (published planDirectBoot)
  const plan = await MC.planDirectBoot({ cmdline: CMDLINE, fw, reportHostData: oc.hostData });
  assert.equal(plan.ok, true, JSON.stringify(plan.reasons)); assert.equal(plan.bound, true); assert.equal(plan.selling, false);
  assert.equal(plan.env.REGISTRY_ENABLED, "0"); assert.equal(plan.env.CLAIM_ENABLED, "0"); assert.ok(!("REGISTRY_PRIVATE_KEY" in plan.env));
  for (const k of ["SECRETS_API", "DOMAINS_API", "CERTS_API", "DNS_API"]) assert.equal(plan.env[k], "", k);
  assert.equal(plan.env.ENCLAVE_PLATFORM_HOST_POLICY, "production", "admin host policy stays on in direct mode");
  assert.equal(plan.env.VMMGR_URL, "http://10.0.2.2:40961"); assert.equal(plan.mcp, null); assert.equal(plan.platformApi, null);
  const wrong = await MC.planDirectBoot({ cmdline: CMDLINE, fw, reportHostData: "00".repeat(32) });
  assert.equal(wrong.ok, false, "a HOST_DATA that does not bind the config refuses to boot");
});

test("qemu-restrict.sh refuses anything but one plain user-net netdev and the pinned binary", () => {
  const good = ["-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:40960-:8444"];
  const run = (args, env = {}) => spawnSync("bash", [WRAP, ...args], { env: { PATH: "/usr/bin:/bin", CANARY_REAL_QEMU: "/usr/bin/true", CANARY_REAL_QEMU_SHA256: sha(fs.readFileSync("/usr/bin/true")), ...env }, encoding: "utf8" });
  assert.equal(run(good).status, 0);
  assert.equal(run(good, { CANARY_REAL_QEMU_SHA256: "00".repeat(32) }).status, 97);
  assert.equal(run(good, { CANARY_REAL_QEMU_SHA256: "" }).status, 97);
  for (const bad of [[], [...good, ...good], ["-netdev", "user,id=net0,restrict=off,hostfwd=tcp:127.0.0.1:1-:8444"], ["-netdev", "user,id=net0,guestfwd=tcp:10.0.2.100:1-cmd:x"],
                     ["-netdev", "user,id=net0,hostfwd=tcp:0.0.0.0:40960-:8444"], ["-netdev", "tap,id=net0"], [...good, "-netdev"]])
    assert.equal(run(bad).status, 97, JSON.stringify(bad));
});

test("acceptance: every promised check is required; registry is diagnostic only", () => {
  const M = "ab".repeat(48), rt = { gsupSha256: "1", helperSha256: "2", supervisorSha256: "3" };
  const final = (o = {}) => ({ status: "pending", identity: { measurement: M, controlTlsSpkiSha256: "k" },
    checks: { statement: true, config: true, "endpoint key": true, report: true, supervisor: true, registry: null, ...o } });
  const R = (o = {}, f = final()) => ({ expected: { measurement: M, runtime: rt }, evidence: { status: 200 }, final: f,
    statementChecks: { configDigest: true, hostData: true, peerIsControlTls: true, controlTlsSpkiSha256: "k", mode: "snp",
      runtime: { gsupSha256: true, helperSha256: true, supervisorSha256: true }, noMcpOrPlatformApi: true, operatorMatchesConfig: true, ...o }, verdict: hardwareVerdict(f, M) });
  const ok = acceptance(R());
  assert.equal(ok.pass, true, ok.failed.join(", ")); assert.equal(ok.diagnostic.registry, "pending");
  for (const [name, r] of [["runtime mismatch", R({ runtime: { gsupSha256: true, helperSha256: false, supervisorSha256: true } })],
                           ["runtime missing", R({ runtime: {} })], ["mcp role present", R({ noMcpOrPlatformApi: false })],
                           ["HOST_DATA mismatch", R({ hostData: false })], ["other boot", R({ controlTlsSpkiSha256: "other" })],
                           ["dev mode", R({ mode: "dev" })], ["report false", R({}, final({ report: false }))],
                           ["wrong measurement", R({}, { ...final(), identity: { measurement: "cd".repeat(48), controlTlsSpkiSha256: "k" } })],
                           ["supervisor unknown", R({}, { ...final({ supervisor: null }), status: "unknown" })]])
    assert.equal(acceptance(r).pass, false, name);
  // a "verified" registry cannot make up for a failed hardware or runtime check
  assert.equal(acceptance(R({ runtime: {} }, { ...final({ registry: true }), status: "verified" })).pass, false);
  // the operator label is diagnostic, not proof of a key-less launch
  assert.equal(acceptance(R({ operatorMatchesConfig: false })).pass, true);
});

test("owner config is bare, not selling, and never names production guestd", () => {
  const a = buildOwnerConfig({ managerPort: 40961, dataPort: 40962 });
  assert.equal(a.config.identity.publicUrl, "https://direct-control-canary.invalid");
  assert.deepEqual(a.config.selling, { cpuPrice6: null, payout: null });
  for (const k of ["mcp", "platformApi", "platformPolicyCarriers", "leaseGas", "ownerNomination"]) assert.ok(!(k in a.config), k);
  assert.equal(a.hostData, MC.hostDataHex(MC.configDigest(a.config)));
  assert.throws(() => buildOwnerConfig({ managerPort: 8095, dataPort: 40962 }), /production guestd/);
  assert.throws(() => buildOwnerConfig({ managerPort: 40961, dataPort: 8096 }), /production guestd/);
});
