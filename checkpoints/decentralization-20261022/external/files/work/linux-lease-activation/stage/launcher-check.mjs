// launcher-check.mjs RELEASE_DIR: the staged launcher release (a git archive of the commit, NO node_modules, as production
// runs it) started with a lease-gas host config and a fake QEMU; the fw_cfg it hands the guest is then installed by the
// image's conduit bundle and loaded by the supervisor's runtime (from the staged image extract, its own viem).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
import { createHash } from "node:crypto"; import { pathToFileURL } from "node:url";
const rel = path.resolve(process.argv[2]), img = path.resolve(process.argv[3]);
if (fs.existsSync(path.join(rel, "node_modules"))) throw new Error("the release dir must have no node_modules (production layout)");
const t = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-release-check-"));
const RECORD = fs.readFileSync(path.join(rel, "..", "..", "tree", "test", "metal-lease-gas-conduit.test.mjs"), "utf8").match(/const RECORD = Buffer\.from\('([^']+)'\)/)[1];
fs.writeFileSync(path.join(t, "deployment.json"), RECORD);
const digest = "sha256:" + createHash("sha256").update(RECORD).digest("hex");
fs.mkdirSync(path.join(t, "dist")); fs.mkdirSync(path.join(t, "tmp"));
fs.writeFileSync(path.join(t, "dist", "vmlinuz"), "k"); fs.writeFileSync(path.join(t, "dist", "initramfs.cpio.gz"), "i");
fs.writeFileSync(path.join(t, "pair.key"), "ab".repeat(32) + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(t, "fake-qemu"), ["#!/bin/sh", "while [ $# -gt 0 ]; do",
  '  if [ "$1" = -fw_cfg ]; then case "$2" in name=opt/org.enclave.metal,file=*) cp "${2#name=opt/org.enclave.metal,file=}" "$FAKE_QEMU_OUT";; esac; fi', "  shift", "done", "exec sleep 30"].join("\n") + "\n", { mode: 0o755 });
const relays = ["https://relay-a.example.org", "https://relay-b.example.net"], rpcs = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
fs.writeFileSync(path.join(t, "config.json"), JSON.stringify({ mode: "snp", name: "metal0-release-check", cpus: 1, memMiB: 512, measureGflops: false,
  dist: path.join(t, "dist"), ovmf: path.join(t, "ovmf.fd"), qemu: path.join(t, "fake-qemu"), relayUrl: "wss://relay.example.test/v1/fleet-tunnel",
  isolation: { backend: "snp-guest-per-app", managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096", pairingKeyFile: path.join(t, "pair.key") },
  leaseGas: { recordFile: path.join(t, "deployment.json"), digest, rpcs, relays, quorum: 2 } }));
const out = path.join(t, "fw.json");
const p = spawn(process.execPath, ["metal/enclave-metal.mjs", "--config", path.join(t, "config.json")], { cwd: rel, env: { ...process.env, TMPDIR: path.join(t, "tmp"), FAKE_QEMU_OUT: out }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; });
try {
  for (let i = 0; i < 200 && !fs.existsSync(out); i++) { if (p.exitCode !== null) break; await new Promise((r) => setTimeout(r, 50)); }
  if (!fs.existsSync(out)) throw new Error("the release launcher never started QEMU:\n" + log);
  await new Promise((r) => setTimeout(r, 100));
  const fw = JSON.parse(fs.readFileSync(out, "utf8"));
  if (!fw.leaseGas || fw.leaseGas.digest !== digest) throw new Error("fw_cfg carries no leaseGas");
  const B = await import(pathToFileURL(path.join(img, "opt/metal/lease-gas-conduit.bundle.mjs")).href);
  const g = B.leaseGasGuest(fw.leaseGas, { recordFile: path.join(t, "guest-record.json") });
  if (!g.ok) throw new Error("the image's bundle refused: " + g.reason);
  for (const [f, b] of Object.entries(g.files)) fs.writeFileSync(f, b);
  const RT = await import(pathToFileURL(path.join(img, "app/network/lease-gas-runtime.mjs")).href);
  const { base } = await import(pathToFileURL(path.join(img, "app/node_modules/viem/_esm/chains/definitions/base.js")).href).catch(async () => ({ base: (await import(pathToFileURL(path.join(img, "app/node_modules/viem/_esm/chains/index.js")).href)).base }));
  const cfg = RT.loadLeaseGasConfig({ env: g.env, chain: base, ledger: "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B", registry: "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC" });
  console.log(`LAUNCHER-RELEASE-OK ${log.match(/\[enclave-metal\] app-funded lease gas: [^\n]*/)?.[0]}`);
  console.log(`IMAGE-SUPERVISOR-LOADER-OK reserve ${cfg.reserve} relays ${cfg.relays.length} quorum ${cfg.quorum} record ${cfg.deployment.digest.slice(0, 19)}…`);
} finally { p.kill("SIGTERM"); fs.rmSync(t, { recursive: true, force: true }); }
