// The integrated independent CLI (work/cli-combined-integration closure) WITH the measured-control final patch
// (work/measured-control-final-integration/patches/measured-control-final.patch), driven through ONE real cli/enclave.mjs
// (or the built bundle: ENCLAVE_CLI_ENTRY) as a subprocess, on the cli-independent rig (anvil, chain 8453, real
// contracts, three JSON-RPC origins), under the CLI network guard (no non-loopback connection, the Enclave stand-in API
// never hit).
//   * measured mode through `enclave host`: a plan on this host's plain-HTTP loopback RPCs is refused at install (the
//     guest cannot reach them); with https RPCs, init records the control plan; install writes the guest's bound config with
//     the plan's chain policy (quorum, confirmations, maximum block age) and the launcher config; check reports the
//     control attestation as NOT ready (nothing attested is listening), never READY;
//   * host mode: the supervisor environment the CLI installs carries the plan's quorum; the REAL candidate supervisor
//     boots with exactly that file and reads the rig chain through the quorum (its boot fence clears by agreement).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { haveTools, startRig, KEYS } from "./helpers/cli-independent-rig.mjs";
import * as MC from "../metal/guest/measured-control.mjs";

const exec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY ? path.resolve(process.env.ENCLAVE_CLI_ENTRY) : path.join(REPO, "cli", "enclave.mjs");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const skip = haveTools();
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
let r, tmp, pinsFile, netLog;

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-combined-measured-"));
  pinsFile = path.join(tmp, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(r.pins));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const independent = () => ["--independent", "--contract-pins", pinsFile, "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--quorum", "2", "--confirmations", "1"];
async function cli(args, { rpcs = null } = {}) {
  await r.mine(); await r.mine();
  return new Promise((resolve) => {
    const ind = rpcs ? independent().map((a, i, all) => all[i - 1] === "--rpc" ? rpcs.join(",") : a) : independent();
    const p = spawn(process.execPath, [CLI, ...ind, ...args], { cwd: tmp, env: {
      PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_KEY: KEYS.owner, ENCLAVE_API_BASE: r.apiOrigin,
      ENCLAVE_ADDRESS_BOOK: "0x" + "ab".repeat(20), NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort) } });
    let out = "", err = "";
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 180 s]"; p.kill("SIGKILL"); }, 180000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err, all: out + err }); });
  });
}
const noEnclave = () => {
  assert.equal(r.apiHits.length, 0, "the stand-in Enclave API was never called");
  assert.equal(fs.readFileSync(netLog, "utf8").trim(), "", "no non-loopback connection was attempted");
};
const initArgs = (dir, extra = []) => ["host", "init", "--dir", dir, "--public-url", "https://host.example.org", "--repo", "example/enclave", "--release-id", "a".repeat(64),
  "--gateways", "http://203.0.113.5:8189", "--guest-mem-mib", "4096", "--guest-cpus", "2", "--price-cpu", "0.05", ...extra];

test("measured mode through `enclave host`: the guest's config binds the plan's chain policy; check never reports an unattested guest ready", T, async () => {
  const dir = path.join(tmp, "measured"), units = path.join(tmp, "units-m");
  const img = path.join(tmp, "image"); fs.mkdirSync(img); for (const f of ["vmlinuz", "initramfs.cpio.gz"]) fs.writeFileSync(path.join(img, f), f);
  fs.writeFileSync(path.join(tmp, "ovmf.fd"), "firmware"); fs.writeFileSync(path.join(tmp, "floor.json"), JSON.stringify({ Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } }));
  const control = ["--control-image", img, "--control-measurements", "77".repeat(48), "--control-min-tcb", path.join(tmp, "floor.json"),
    "--control-ovmf", path.join(tmp, "ovmf.fd"), "--control-port", "18555"];
  // the rig's plain-HTTP loopback RPCs are THIS host's loopback: inside the control CVM 127.0.0.1 is the guest itself, so
  // a measured plan on them is refused at install, precisely (the guest needs https RPCs it can reach)
  const lo = path.join(tmp, "measured-loopback");
  assert.equal((await cli(initArgs(lo, control))).code, 0);
  fs.writeFileSync(path.join(lo, "pair.key"), "cd".repeat(32) + "\n", { mode: 0o600 });
  const refused = await cli(["host", "install", "--dir", lo, "--unit-dir", path.join(tmp, "units-lo")]);
  assert.notEqual(refused.code, 0); assert.match(refused.all, /rpcs\[0\] must be https \(the control guest has no loopback chain\)/);
  // https RPC origins (distinct loopback hosts nothing listens on: every chain read stays UNKNOWN, nothing leaves the box)
  const RPCS = ["https://127.0.0.2:1", "https://127.0.0.3:1"];
  const i = await cli(initArgs(dir, control), { rpcs: RPCS });
  assert.equal(i.code, 0, i.all);
  fs.writeFileSync(path.join(dir, "pair.key"), "cd".repeat(32) + "\n", { mode: 0o600 });
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "host-plan.json"), "utf8"));
  fs.mkdirSync(plan.guestd.collateralDir, { recursive: true });
  for (const f of ["vcek.der", "cert_chain.pem"]) fs.writeFileSync(path.join(plan.guestd.collateralDir, f), "x");
  const ap = await cli(["host", "install", "--dir", dir, "--unit-dir", units, "--apply"], { rpcs: RPCS });
  assert.equal(ap.code, 0, ap.all);
  const direct = MC.canonicalDirectConfig(JSON.parse(fs.readFileSync(path.join(dir, "direct-control.json"), "utf8")));
  assert.deepEqual(direct.rpcs, RPCS); assert.equal(direct.quorum, 2); assert.equal(direct.confirmations, 1); assert.equal(direct.maxBlockAgeSec, 120);
  assert.equal(direct.hostOwnership, null); assert.equal(direct.hostAdmissionSha256, null);
  assert.ok(fs.existsSync(path.join(units, "enclave-independent-host-control.service")));
  const chk = await cli(["host", "check", "--dir", dir, "--unit-dir", units, "--json"], { rpcs: RPCS });
  assert.notEqual(chk.code, 0);
  const rows = JSON.parse(chk.out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)).rows;
  const ctl = rows.find((x) => x.item === "control attestation");
  assert.ok(ctl && ctl.status !== "ready", JSON.stringify(ctl));
  assert.ok(!rows.some((x) => x.item === "supervisor running"), "no host supervisor is probed for a measured plan");
  noEnclave();
});

test("host mode through `enclave host`: the installed environment carries the plan's quorum, and the REAL supervisor boots on it reading through the quorum", T, async () => {
  const dir = path.join(tmp, "hosted"), units = path.join(tmp, "units-h");
  assert.equal((await cli(initArgs(dir))).code, 0);
  const ap = await cli(["host", "install", "--dir", dir, "--unit-dir", units, "--apply"]);
  assert.equal(ap.code, 0, ap.all);
  const envText = fs.readFileSync(path.join(dir, "supervisor.env"), "utf8");
  const env = Object.fromEntries(envText.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const k = l.slice(0, l.indexOf("=")); let v = l.slice(k.length + 1); if (v.startsWith("'")) v = v.slice(1, -1); return [k, v]; }));
  assert.equal(env.BASE_RPCS, r.rpcs.join(",")); assert.equal(env.CHAIN_QUORUM, "2"); assert.equal(env.CHAIN_CONFIRMATIONS, "1"); assert.equal(env.CHAIN_MAX_BLOCK_AGE_SEC, "120");
  // the real candidate supervisor with exactly that environment (plus a scratch state file), the quorum seam reading the
  // rig chain for its boot fence: the operator key FILE from the plan, agreement across the plan's RPCs
  const seam = { chain: "quorum", hint: true, ids: [], health: {}, appId: "45".repeat(32), bytes: "", enclaveId: r.runner, endpoint: r.endpoint, replicas: {} };
  const { stdout } = await exec(process.execPath, ["supervisor.js"], { cwd: REPO, timeout: 120000, maxBuffer: 8 << 20,
    env: { PATH: process.env.PATH, HOME: tmp, ...env, PORT: "0", STATE_FILE: path.join(tmp, "state-h.json"), SESSION_KEY_DIR: path.join(tmp, "sess-h"),
      DIRECT_CLAIM_SELFTEST: JSON.stringify(seam) } }).catch((x) => { throw new Error((x.stderr || x.message).slice(-3000)); });
  const out = JSON.parse(stdout.trim().split("\n").reverse().find((l) => l.startsWith('{"calls"')));
  assert.equal(out.fence, "clear", "the boot fence was decided by the plan's quorum");
  noEnclave();
});
