// The pVM host agent's own rules (shielded/anchor/avf/runner/host-agent.mjs; PVM-CPU.md "Serving buyers"), without a chain or a
// phone: which deployments a pVM takes (and why not), the strict config, and the CSR's key. The lifecycle underneath is the
// runner agent's (test/pvm-runner-agent.test.mjs); the whole cycle runs on the device (results/pvm-cpu-market-*).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pvmClaimRefusal, checkHostConfig, spkiOfCsr, ISOLATION_BACKEND, HOST_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/host-agent.mjs";

const E = "0x" + "c6".repeat(32), NOW = 1_800_000_000;
const row = (over = {}) => ({ id: "0x" + "d1".repeat(32), active: true, isPublic: true, gpuMilli: 0, cpuMilli: 250, configCid: "", runner: "0x" + "00".repeat(32), leaseUntil: 0, ...over });
const version = (over = {}) => ({ cid: "bafy", version: "1.0.0", vramMb: 0, gpuGflops: 0, memMb: 128, cpuGflops: 0, yanked: false, ports: "", approval: 1, config: "", configCid: "", ...over });
const why = (d, v = version()) => pvmClaimRefusal(d, v, { enclaveId: E, maxMemMb: 512, nowSec: NOW });

test("a pVM takes a public, CPU-only, unconfigured wasi:http app that fits, and says why it takes nothing else", () => {
  assert.equal(why(row()), null);
  assert.equal(why(row({ configCid: JSON.stringify({ network: { transport: "tuna" }, isolation: { require: ISOLATION_BACKEND }, gpu: { optional: true } }) })), null);
  assert.equal(why(row({ configCid: JSON.stringify({ placement: { hostId: E, allowFallback: false } }) })), null, "pinned to this host");
  assert.equal(why(row({ runner: E, leaseUntil: NOW + 100 })), null, "its own live lease (a restart picks it up)");
  for (const [d, v, re] of [
    [row({ active: false }), version(), /not active/],
    [row({ isPublic: false }), version(), /private/],
    [row({ gpuMilli: 250 }), version(), /CPU-only/],
    [row({ runner: "0x" + "99".repeat(32), leaseUntil: NOW + 100 }), version(), /another host holds its lease/],
    [row({ configCid: "bafybeigdyrzt" }), version(), /bare CID/],
    [row({ configCid: '{"config":{"key":"v"}}' }), version(), /configuration, secrets and protection rules/],
    [row({ configCid: '{"waf":{"rps":10}}' }), version(), /does not apply/],
    [row({ configCid: '{"isolation":{"cpuTee":true}}' }), version(), /confidential-computing/],
    [row({ configCid: '{"isolation":{"require":"snp-guest-per-app"}}' }), version(), /requires isolation backend/],
    [row({ configCid: '{"network":{"transport":"relay"}}' }), version(), /other than TUNA/],
    [row({ configCid: JSON.stringify({ placement: { hostId: "0x" + "77".repeat(32), allowFallback: false } }) }), version(), /pinned to another host/],
    [row(), null, /could not be read/],
    [row(), version({ yanked: true }), /yanked/],
    [row(), version({ approval: 0 }), /not approved/],
    [row(), version({ approval: 2 }), /not approved/],
    [row(), version({ vramMb: 4096 }), /needs a GPU/],
    [row(), version({ memMb: 2048 }), /beyond this VM's 512 MB/],
    [row(), version({ ports: "http:8080,tcp:5432" }), /wasi:http only/],
    [row(), version({ config: '{"threads":true}' }), /threads/],
    [row(), version({ config: '{"volumes":["qwen"]}' }), /model volume/],
    [row(), version({ config: '{"apiKey":"x"}' }), /app configuration/],
    [row(), version({ configCid: "bafyconfig" }), /configuration document/],
  ]) assert.match(String(why(d, v)), re, JSON.stringify(d).slice(0, 80) + " " + JSON.stringify(v).slice(0, 60));
  assert.equal(why(row(), version({ vramMb: 4096, config: '{"gpuOptional":true}' })), null, "a GPU-optional app runs on the CPU");
  assert.equal(why(row(), version({ config: '{"_media":{"thumbnail":"bafy"}}' })), null, "display metadata is not app configuration");
});

test("the config is strict: public values only, the owner's price, exactly one build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-host-")), idle = path.join(dir, "idle.wasm");
  fs.writeFileSync(idle, "\0asm");
  const ok = { format: HOST_CONFIG_FORMAT, name: "pixel10-pvm-cpu", relayOrigin: "https://api.enclave.host", chainId: "8453",
    addressBook: "0xab214342d5a490150a4a977063a2f88e21f80907", operator: "0x" + "81".repeat(20), maxFeePerGasWei: "500000000",
    register: { repo: "EnclaveHost/enclave", cpuPricePerSec6: "2" }, payout: { to: "0x" + "0b".repeat(20), minWithdraw6: "1000000" },
    evidence: { allowedCodeHashes: ["51".repeat(32)], allowedAuthorityHashes: ["98".repeat(64)], allowedRuntimeIds: ["d3".repeat(32)], rootPins: ["ce".repeat(32)], instanceIds: ["cd".repeat(32)] },
    device: { adb: "/bin/adb", serial: "X", vmName: "pvmprod1", agentPort: 18187, attachPort: 18188 }, idleApp: idle,
    claim: { enabled: true, maxMemMb: 512, sweepGraceSec: 300 }, ipfs: { python: "python3", fetchScript: "/x/fetch-cid.py", gateways: ["https://ipfs.enclave.host"], cacheDir: dir } };
  const c = checkHostConfig(ok);
  assert.equal(c.endpoint, "https://api.enclave.host/t/pixel10-pvm-cpu");
  assert.match(c.enclaveId, /^0x[0-9a-f]{64}$/);
  const refuse = (over, re) => assert.throws(() => checkHostConfig({ ...ok, ...over }), re);
  refuse({ privateKey: "0x" + "11".repeat(32) }, /unknown key "privateKey"/);
  refuse({ register: { repo: "x", cpuPricePerSec6: "0" } }, /price, > 0/);
  refuse({ register: { repo: "x", cpuPricePerSec6: "2", measurement: "0x" } }, /exactly \{ repo, cpuPricePerSec6 \}/);
  refuse({ evidence: { ...ok.evidence, allowedCodeHashes: ["51".repeat(32), "52".repeat(32)] } }, /exactly the build this host runs/);
  refuse({ claim: { ...ok.claim, maxMemMb: 4096 } }, /maxMemMb/);
  refuse({ relayOrigin: "http://api.enclave.host" }, /relayOrigin/);
  refuse({ payout: { to: "0x" + "0b".repeat(20) } }, /payout must be exactly/);
});

test("the CSR's key is read from the request itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-csr-"));
  try { execFileSync("openssl", ["version"], { stdio: "pipe" }); } catch { return; }
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.writeFileSync(path.join(dir, "k.pem"), k.privateKey.export({ format: "pem", type: "pkcs8" }));
  execFileSync("openssl", ["req", "-new", "-key", "k.pem", "-subj", "/CN=0a1b2c3d.app.enclave.host", "-addext", "subjectAltName=DNS:0a1b2c3d.app.enclave.host", "-outform", "DER", "-out", "r.der"], { cwd: dir, stdio: "pipe" });
  const der = fs.readFileSync(path.join(dir, "r.der"));
  assert.deepEqual(spkiOfCsr(der), k.publicKey.export({ format: "der", type: "spki" }));
});
