// Source-level dry run of the canary launch path, with NO QEMU: the PUBLISHED launcher (tree/metal/enclave-metal.mjs) runs with
// the canary's exact host-config shape and canary/qemu-restrict.sh as cfg.qemu, but the wrapper's "real QEMU" is
// test/fake-qemu.sh, which only records its argv and the fw_cfg file and sleeps. Then the PUBLISHED planDirectBoot judges that
// fw_cfg against the measured cmdline. Plus the wrapper's refusals and verify-canary's acceptance() rules.
// Adapted 2026-10-25 for the verifier-only 0235e7d96 image: 2048 MiB, the chainVerifier owner config, A..D acceptance, launcher refusal.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const D = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TREE = path.join(D, "tree"), IMAGE = path.resolve(D, "../final-proof-image-stage/out/dist-direct-10cdf913");
const MC = await import(path.join(TREE, "metal/guest/measured-control.mjs"));
const { buildOwnerConfig } = await import(path.join(D, "canary/owner-config.mjs"));
const { acceptance, hardwareVerdict, tamperReport, tamperStatement, flipHex, offlineReport } = await import(path.join(D, "canary/verify-canary.mjs"));
const AV = await import(path.join(TREE, "network/attested-verifier-client.mjs"));
const { CANARY } = await import(path.join(D, "canary/owner-config.mjs"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const FAKE = path.join(D, "test/fake-qemu.sh"), WRAP = path.join(D, "canary/qemu-restrict.sh");
const CMDLINE = "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the published launcher builds the measured, restricted, key-less launch from the canary config", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canary-dry-")); fs.chmodSync(tmp, 0o700);
  const priv = path.join(tmp, "private"); fs.mkdirSync(path.join(priv, "tmp"), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const oc = buildOwnerConfig({ managerPort: 40961, dataPort: 40962, proofPort: 40963 });
  fs.writeFileSync(path.join(priv, "owner-config.json"), oc.text, { mode: 0o600 });
  const key = "ab".repeat(32); fs.writeFileSync(path.join(priv, "pairing.key"), key + "\n", { mode: 0o600 });
  const host = { mode: "snp", name: "direct-control-canary", cpus: 4, memMiB: 2048, dist: IMAGE, ovmf: "/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd",
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
  assert.deepEqual(val("-smp"), ["4"]); assert.deepEqual(val("-m"), ["2048"]);
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
  assert.ok(!("chainVerifier" in fw) && !("platformPolicyCarriers" in fw), "the verifier is bound only inside the direct config");
  assert.equal(fw.direct.chainVerifier.expose, "attested"); assert.deepEqual(fw.direct.chainVerifier.proofSources, ["http://10.0.2.2:40963/"]);
  assert.deepEqual(fw.volumes, []); assert.deepEqual(fw.direct, JSON.parse(oc.text));
  assert.deepEqual(fw.isolation, { managerUrl: "http://10.0.2.2:40961", dataAddr: "10.0.2.2:40962", pairingKey: key });
  // the guest's own boot decision on exactly this fw_cfg (published planDirectBoot)
    // the image's /opt/rpc-runtime/IMAGE.json is the commit's metal/chain-verifier-image.json (10cdf913: sha c8fde7bb, helios 8250f08a): judge with exactly it
  const imageFile = path.join(TREE, "metal/chain-verifier-image.json");
  assert.equal(sha(fs.readFileSync(imageFile)), "c8fde7bb367a134f3c7434d7aa98da73ef3a2079ad4cb6bb9833741224efaee8");
  const paths = { ...MC.GUEST_PATHS, chainVerifierImage: imageFile };
  const plan = await MC.planDirectBoot({ cmdline: CMDLINE, fw, reportHostData: oc.hostData, paths });
  assert.equal(plan.ok, true, JSON.stringify(plan.reasons)); assert.equal(plan.bound, true); assert.equal(plan.selling, false);
  assert.equal(plan.env.REGISTRY_ENABLED, "0"); assert.equal(plan.env.CLAIM_ENABLED, "0"); assert.ok(!("REGISTRY_PRIVATE_KEY" in plan.env));
  for (const k of ["SECRETS_API", "DOMAINS_API", "CERTS_API", "DNS_API"]) assert.equal(plan.env[k], "", k);
  assert.equal(plan.env.ENCLAVE_PLATFORM_HOST_POLICY, "production", "admin host policy stays on in direct mode");
  assert.equal(plan.env.VMMGR_URL, "http://10.0.2.2:40961"); assert.equal(plan.mcp, null); assert.equal(plan.platformApi, null);
  assert.ok(JSON.stringify(plan).includes("/chain-verifier"), "the verifier-only plan routes /chain-verifier");
  for (const k of ["BASE_RPC", "BASE_RPCS"]) assert.equal(plan.env[k], "http://127.0.0.1:9/", `${k} refuses (the verifier is the only chain authority)`);
  const wrong = await MC.planDirectBoot({ cmdline: CMDLINE, fw, reportHostData: "00".repeat(32), paths });
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

test("acceptance: A..D are all required; nothing passes without the rejections and the fail-closed route", () => {
  const M = "ab".repeat(48), rt = { gsupSha256: "1", helperSha256: "2", supervisorSha256: "3" };
  const final = (o = {}) => ({ status: "pending", identity: { measurement: M, controlTlsSpkiSha256: "k" },
    checks: { statement: true, config: true, "endpoint key": true, report: true, supervisor: true, registry: null, ...o } });
  const R = (o = {}, f = final(), x = {}) => ({ expected: { measurement: M, runtime: rt }, evidence: { status: 200 }, final: f, attestedOutcome: AV.attestedOutcome({ ...f, identity: { ...f.identity, controlTlsSpkiSha256: "a".repeat(64) } }),
    statementChecks: { configDigest: true, hostData: true, peerIsControlTls: true, controlTlsSpkiSha256: "k", mode: "snp",
      runtime: { gsupSha256: true, helperSha256: true, supervisorSha256: true }, noMcpOrPlatformApi: true, noNative: true, operatorMatchesConfig: true, ...o }, verdict: hardwareVerdict(f, M),
    offline: { control: { status: "verified" }, reportByte: { status: "rejected" }, statementByte: { status: "rejected" }, otherNonce: { status: "rejected" } },
    liveRejections: { wrongMeasurement: { status: "rejected", checks: { report: false }, hardwareMeasurement: false }, wrongConfig: { status: "rejected", checks: { config: false } } },
    route: { client: { attest: [true], replicaStatus: "attested", read: { ok: false, error: "attested verifier: no attested replica answered (https://127.0.0.1:1: HTTP 502)" } },
      readProbes: [{ status: 502, error: "service_unreachable" }, { status: 502, error: "service_unreachable" }], writeProbe: { status: 403, error: "method_refused" },
      wrongClient: { attest: [false], read: { ok: false } }, signerMismatchRefused: true }, ...x });
  const ok = acceptance(R());
  assert.equal(ok.pass, true, ok.failed.join(", "));
  const r0 = R(); const mut = (f) => { const r = structuredClone(r0); f(r); return r; };
  const bad = {
    "runtime mismatch": R({ runtime: { gsupSha256: true, helperSha256: false, supervisorSha256: true } }), "mcp role present": R({ noMcpOrPlatformApi: false }),
    "native member": R({ noNative: false }), "HOST_DATA mismatch": R({ hostData: false }), "other boot": R({ controlTlsSpkiSha256: "other" }), "dev mode": R({ mode: "dev" }),
    "report false": R({}, final({ report: false })), "wrong measurement verified": R({}, { ...final(), identity: { measurement: "cd".repeat(48), controlTlsSpkiSha256: "k" } }),
    "a registry read happened (verified)": R({}, { ...final({ registry: true }), status: "verified" }), "supervisor unknown": R({}, { ...final({ supervisor: null }), status: "unknown" }),
    "offline control not verified (vacuous tamper tests)": mut((r) => { r.offline.control.status = "rejected"; }),
    "tampered report accepted": mut((r) => { r.offline.reportByte.status = "verified"; }), "tampered statement accepted": mut((r) => { r.offline.statementByte.status = "verified"; }),
    "replay accepted": mut((r) => { r.offline.otherNonce.status = "verified"; }), "offline section absent": mut((r) => { delete r.offline; }),
    "wrong measurement not rejected at the report": mut((r) => { r.liveRejections.wrongMeasurement.hardwareMeasurement = "absent"; }),
    "wrong measurement unknown": mut((r) => { r.liveRejections.wrongMeasurement.status = "unknown"; }),
    "wrong config accepted": mut((r) => { r.liveRejections.wrongConfig.status = "pending"; }),
    "route answered 200 (backend reachable!)": mut((r) => { r.route.readProbes[1] = { status: 200, error: null }; }),
    "one read probe only": mut((r) => { r.route.readProbes.pop(); }), "client read succeeded": mut((r) => { r.route.client.read = { ok: true }; }),
    "client never attested": mut((r) => { r.route.client.attest = [false]; }), "write method not refused": mut((r) => { r.route.writeProbe = { status: 502, error: "service_unreachable" }; }),
    "wrong-measurement client attested": mut((r) => { r.route.wrongClient.attest = [true]; }), "signer mismatch accepted": mut((r) => { r.route.signerMismatchRefused = false; }),
    "route absent": mut((r) => { delete r.route; }),
  };
  for (const [name, r] of Object.entries(bad)) assert.equal(acceptance(r).pass, false, name);
  assert.equal(acceptance(R({ operatorMatchesConfig: false })).pass, true, "the operator label is diagnostic");
});

test("tamper helpers change exactly one bound byte; offlineReport never verifies garbage", async () => {
  const report = Buffer.alloc(0x4a0, 7).toString("base64");
  const t = Buffer.from(tamperReport({ report }).report, "base64"), o = Buffer.from(report, "base64");
  assert.equal(t.length, o.length); assert.equal([...t].filter((b, i) => b !== o[i]).length, 1); assert.notEqual(t[0x90], o[0x90]);
  assert.equal(flipHex("0a"), "1a"); assert.equal(flipHex("ab"), "0b");
  const r = await offlineReport({ report, statement: "{}" }, { nonce: Buffer.alloc(32), peerSpki: Buffer.alloc(1), measurement: "ab".repeat(48), hostData: "00".repeat(32), collateral: null });
  assert.notEqual(r.status, "verified");
});

test("owner config is verifier-only, not selling, Base backend unready by construction, never production guestd", () => {
  const a = buildOwnerConfig({ managerPort: 40961, dataPort: 40962, proofPort: 40963 });
  assert.equal(a.config.identity.publicUrl, "https://snp-verifier-canary.invalid");
  assert.deepEqual(a.config.selling, { cpuPrice6: null, payout: null });
  for (const k of ["mcp", "platformApi", "platformPolicyCarriers", "leaseGas", "ownerNomination", "nativeControl"]) assert.ok(!(k in a.config), k);
  assert.equal(a.config.chainVerifier.expose, "attested"); assert.ok(!("txBackend" in a.config.chainVerifier));
  assert.deepEqual(a.config.chainVerifier.proofSources, ["http://10.0.2.2:40963/"]);
  assert.equal(a.config.chainVerifier.unsafeSigner, "0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a");
  assert.equal(a.hostData, MC.hostDataHex(MC.configDigest(a.config)));
  const w = buildOwnerConfig({ managerPort: 40961, dataPort: 40962, proofPort: 40963, variant: "wrong-config" });
  assert.notEqual(w.digest, a.digest); assert.notEqual(w.hostData, a.hostData);
  // the production client accepts exactly this replica shape for the documented sequencer pin, and refuses another pin
  const rep = [{ url: "https://127.0.0.1:40960", config: a.config, measurements: ["ab".repeat(48)], minTcb: { Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } } }];
  assert.equal(AV.checkAttestedReplicas(rep, { unsafeSigner: CANARY.unsafeSigner })[0].digest, a.digest);
  assert.throws(() => AV.checkAttestedReplicas(rep, { unsafeSigner: "0x" + "11".repeat(20) }), /pins sequencer/);
  assert.throws(() => buildOwnerConfig({ managerPort: 8095, dataPort: 40962, proofPort: 40963 }), /production guestd/);
  assert.throws(() => buildOwnerConfig({ managerPort: 40961, dataPort: 8096, proofPort: 40963 }), /production guestd/);
  assert.throws(() => buildOwnerConfig({ managerPort: 40961, dataPort: 40962, proofPort: 40961 }), /must differ/);
});

test("the published launcher refuses a host-level chainVerifier in direct mode before any QEMU", () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "cv-refuse-")), priv = path.join(tmp, "p"); fs.mkdirSync(priv, { mode: 0o700 });
  const oc = buildOwnerConfig({ managerPort: 40961, dataPort: 40962, proofPort: 40963 });
  fs.writeFileSync(path.join(priv, "owner-config.json"), oc.text, { mode: 0o600 }); fs.writeFileSync(path.join(priv, "pairing.key"), "ab".repeat(32) + "\n", { mode: 0o600 });
  const host = { mode: "snp", name: "c", cpus: 4, memMiB: 2048, dist: IMAGE, ovmf: "/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd", qemu: "/bin/false",
    sevDevice: "/dev/sev", control: "direct", direct: path.join(priv, "owner-config.json"), chainVerifier: oc.config.chainVerifier,
    isolation: { backend: "snp-guest-per-app", pairingKeyFile: path.join(priv, "pairing.key"), managerUrl: "http://10.0.2.2:40961", dataAddr: "10.0.2.2:40962" },
    hostfwd: [{ host: 40960, guest: 8444 }], measureGflops: false };
  fs.writeFileSync(path.join(priv, "host-config.json"), JSON.stringify(host), { mode: 0o600 });
  const r = spawnSync(process.execPath, [path.join(TREE, "metal/enclave-metal.mjs"), "--config", path.join(priv, "host-config.json")],
    { env: { PATH: `${D}/bin:/usr/bin:/bin`, HOME: process.env.HOME, TMPDIR: priv }, cwd: priv, encoding: "utf8", timeout: 30000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /takes chainVerifier only inside the bound direct config/);
});
