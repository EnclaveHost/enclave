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
import { pvmClaimRefusal, checkHostConfig, spkiOfCsr, parseOptions, substituteSecrets, envBlock, optionsFile, ISOLATION_BACKEND, HOST_CONFIG_FORMAT,
         slotFor, vmMibFor, appMemFor, siblingDigest } from "../shielded/anchor/avf/runner/host-agent.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAddress } from "viem";

const E = "0x" + "c6".repeat(32), NOW = 1_800_000_000;
const row = (over = {}) => ({ id: "0x" + "d1".repeat(32), active: true, isPublic: true, gpuMilli: 0, cpuMilli: 250, configCid: "", runner: "0x" + "00".repeat(32), leaseUntil: 0, ...over });
const version = (over = {}) => ({ cid: "bafy", version: "1.0.0", vramMb: 0, gpuGflops: 0, memMb: 128, cpuGflops: 0, yanked: false, ports: "", approval: 1, config: "", configCid: "", ...over });
const why = (d, v = version()) => pvmClaimRefusal(d, v, { enclaveId: E, maxMemMb: 512, nowSec: NOW });

test("a pVM takes what the CPU hosts take, and says why it takes nothing else", () => {
  assert.equal(why(row()), null);
  assert.equal(why(row({ configCid: JSON.stringify({ network: { transport: "tuna" }, isolation: { require: ISOLATION_BACKEND } }) })), null);
  assert.equal(why(row({ configCid: JSON.stringify({ placement: { hostId: E, allowFallback: false } }) })), null, "pinned to this host");
  assert.equal(why(row({ runner: E, leaseUntil: NOW + 100 })), null, "its own live lease (a restart picks it up)");
  // the options the CPU hosts apply: an app-config override (inline or at a CID), protection rules
  assert.equal(why(row({ configCid: '{"config":{"key":"v"}}' })), null, "a config override");
  assert.equal(why(row({ configCid: '{"configCid":"bafkreigdyrztxyzxyzxyzxyz"}' })), null, "a config override at a CID");
  assert.equal(why(row({ configCid: '{"waf":{"rps":10,"methods":["GET"]}}' })), null, "protection rules");
  // the version's own config is the app's (ENCLAVE_CONFIG), and a 64-bit memory runs (wasmtime's default, in Pulley)
  for (const config of ['{"apiKey":"$API_KEY","endpoint":"$S3_ENDPOINT"}', '{"_media":{"thumbnail":"bafy"}}', '{"mem64":true}', '{"wasi":"0.2"}'])
    assert.equal(why(row(), version({ config })), null, config);
  assert.equal(why(row(), version({ configCid: "bafyconfig" })), null, "a rev-7 config document");
  assert.equal(why(row(), version({ ports: "http:8000" })), null, "a socket server on one http port (the catalog's port-serving apps)");
  // a GPU share runs here (on cores) only when the card is optional
  assert.equal(why(row({ gpuMilli: 250, configCid: '{"gpu":{"optional":true}}' })), null, "the owner's gpu.optional");
  assert.equal(why(row({ gpuMilli: 250 }), version({ vramMb: 4096, config: '{"gpuOptional":true}' })), null, "the publisher's gpuOptional");
  assert.equal(why(row(), version({ vramMb: 4096, config: '{"gpuOptional":true}' })), null, "a GPU-optional app runs on the CPU");
  for (const [d, v, re] of [
    [row({ active: false }), version(), /not active/],
    [row({ isPublic: false }), version(), /private/],
    [row({ gpuMilli: 250 }), version(), /CPU-only/],
    [row({ runner: "0x" + "99".repeat(32), leaseUntil: NOW + 100 }), version(), /another host holds its lease/],
    [row({ configCid: "bafybeigdyrzt" }), version(), /bare CID/],
    [row({ configCid: '{"config":["not","an","object"]}' }), version(), /not a JSON object/],
    [row({ configCid: '{"configCid":"has spaces in it"}' }), version(), /not a bare IPFS CID/],
    [row({ configCid: '{"waf":{"rps":0}}' }), version(), /protection rules are invalid: waf.rps/],
    [row({ configCid: '{"waf":{"geo":["US"]}}' }), version(), /protection rules are invalid: unknown waf option/],
    [row({ configCid: '{"domains":["x.example"]}' }), version(), /does not apply/],
    [row({ configCid: '{"gpu":{"optional":true}}' }), version(), /only to a deployment that bought GPU share/],
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
    [row(), version({ memMb: 128, config: '{"cpuFallback":{"memMb":4096}}' }), /4096 MB \(its cpuFallback\), beyond/],
    [row(), version({ ports: "http:8080,tcp:5432" }), /HTTP on one port only/],
    [row(), version({ ports: "http:8000,http:9000" }), /HTTP on one port only/],
    [row(), version({ ports: "udp:4000" }), /HTTP on one port only/],
    [row(), version({ config: '{"threads":true}' }), /cooperative threads/],
    [row(), version({ config: '{"set":true}' }), /shared-everything threads/],
    [row(), version({ config: '{"wasi":"0.3"}' }), /wasi 0.3/],
    [row(), version({ config: '{"volumes":["qwen"]}' }), /model volume qwen/],
    [row(), version({ config: "not json" }), /not JSON/],
  ]) assert.match(String(why(d, v)), re, JSON.stringify(d).slice(0, 80) + " " + JSON.stringify(v).slice(0, 60));
});

test("the options envelope is read as the CPU host reads it (fail-closed)", () => {
  assert.deepEqual(parseOptions("", 0), {});
  const o = parseOptions('{"config":{"a":1},"waf":{"rps":10},"network":{"transport":"tuna","relay":"us-west"},"gpu":{"optional":true}}', 250);
  assert.deepEqual(o.config, { a: 1 });
  assert.deepEqual(o.waf, { rps: 10, burst: 40 }, "the platform's normalisation (parseWaf): the default burst");
  assert.equal(o.gpuOptional, true);
  assert.throws(() => parseOptions('{"network":{"relay":"Bad Name"}}', 0), /invalid relay/);
});

test("secrets resolve inside the config's strings exactly as the platform runner resolves them", () => {
  const secrets = { S3_ENDPOINT: "https://s3.example", KEY: 'a"quote\\back', EMPTY: "" };
  const cfg = JSON.stringify({ endpoint: "$S3_ENDPOINT", nested: ["${KEY}", "price $$5", "$NOT_A_SECRET", "x$EMPTY"], n: 3, k: { "$S3_ENDPOINT": "$S3_ENDPOINT/b" } });
  assert.deepEqual(JSON.parse(substituteSecrets(cfg, secrets)),
    { endpoint: "https://s3.example", nested: ['a"quote\\back', "price $5", "$NOT_A_SECRET", "x"], n: 3, k: { "$S3_ENDPOINT": "https://s3.example/b" } },
    "string values only (keys untouched), re-serialised, $$ is a dollar, unknown names stay");
  assert.equal(substituteSecrets("not json $S3_ENDPOINT", secrets), "not json $S3_ENDPOINT", "a non-JSON config passes through");
  assert.equal(substituteSecrets(cfg, {}), cfg);
});

test("the launch's options file: the environment block, the rules and the egress token", () => {
  const env = envBlock({ ENCLAVE_CONFIG: '{"a":"b=c"}', ENCLAVE_HOSTS: "0a1b2c3d.app.enclave.host", API_TOKEN: "t" });
  assert.equal(env.toString(), 'ENCLAVE_CONFIG={"a":"b=c"}\0ENCLAVE_HOSTS=0a1b2c3d.app.enclave.host\0API_TOKEN=t\0');
  for (const bad of [{ ENCLAVE_PORTS: "x" }, { ENCLAVE_MEM_MB: "9" }, { "A B": "x" }, { A: "nul\0inside" }]) assert.throws(() => envBlock(bad));
  const f = optionsFile({ env, waf: { rps: 1, burst: 5 }, egress: { port: 18189, token: "ab".repeat(16) } });
  const lines = f.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(Buffer.from(lines[0].slice(4), "hex").toString(), env.toString());
  assert.deepEqual(JSON.parse(Buffer.from(lines[1].slice(4), "hex").toString()), { rps: 1, burst: 5 });
  assert.equal(lines[2], `EGRESS 18189 ${"ab".repeat(16)}`);
  assert.equal(optionsFile({}), null);
});

test("the config is strict: public values only, the owner's price, exactly one build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-host-")), idle = path.join(dir, "idle.wasm");
  fs.writeFileSync(idle, "\0asm");
  const ok = { format: HOST_CONFIG_FORMAT, name: "pixel10-pvm-cpu", relayOrigin: "https://api.enclave.host", chainId: "8453",
    addressBook: "0xab214342d5a490150a4a977063a2f88e21f80907", operator: "0x" + "81".repeat(20), maxFeePerGasWei: "500000000",
    register: { repo: "EnclaveHost/enclave", cpuPricePerSec6: "2" }, payout: { to: "0x" + "0b".repeat(20), minWithdraw6: "1000000" },
    evidence: { allowedCodeHashes: ["51".repeat(32)], allowedAuthorityHashes: ["98".repeat(64)], allowedRuntimeIds: ["d3".repeat(32)], rootPins: ["ce".repeat(32)], instanceIds: ["cd".repeat(32)] },
    device: { adb: "/bin/adb", serial: "X", vmName: "pvmprod1", agentPort: 18187, attachPort: 18188 }, idleApp: idle,
    claim: { enabled: true, maxMemMb: 512, sweepGraceSec: 300 }, slots: { count: 4, poolMemMb: 3072, routerPort: 17780 }, ipfs: { python: "python3", fetchScript: "/x/fetch-cid.py", gateways: ["https://ipfs.enclave.host"], cacheDir: dir } };
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
  assert.equal(checkHostConfig({ ...ok, egress: { port: 18189, routesFile: "/x/egress-routes.json" } }).egress.port, 18189);
  refuse({ egress: { port: 80, routesFile: "/x" } }, /egress must be exactly/);
  refuse({ egress: { port: 18189, routesFile: "relative.json" } }, /egress must be exactly/);
  refuse({ slots: undefined }, /slots must be exactly/);
  refuse({ slots: { ...ok.slots, count: 5 } }, /slots must be exactly/);
  refuse({ slots: { ...ok.slots, poolMemMb: 256 } }, /slots must be exactly/);
  refuse({ slots: { ...ok.slots, extra: 1 } }, /slots must be exactly/);
  refuse({ slots: { ...ok.slots, poolMemMb: 512 } }, /needs a 640 MiB VM, beyond slots.poolMemMb/);
});

test("slots by share: a VM per app sized to it, taken only while the phone's pool and CPU have room", () => {
  // the VM: the app plus the VM's own (128), at least 384, in 64 MiB steps; the app: its version's memory, 256 when unstated
  assert.deepEqual([vmMibFor(64), vmMibFor(256), vmMibFor(300), vmMibFor(1024)], [384, 384, 448, 1152]);
  assert.deepEqual([appMemFor(version({ memMb: 0 })), appMemFor(version({ memMb: 16 })), appMemFor(version({ memMb: 2048 })),
                    appMemFor(version({ memMb: 64, config: JSON.stringify({ cpuFallback: { memMb: 512 } }) }))], [256, 64, 1024, 512]);
  const S = { count: 3, poolMemMb: 1536 };
  assert.deepEqual(slotFor(S, [], { cpuMilli: 125, appMemMb: 64 }), { slot: 1, vmMib: 384, cpus: 1 }, "1/8 of the phone: one vCPU");
  assert.deepEqual(slotFor(S, [], { cpuMilli: 250, appMemMb: 256 }), { slot: 1, vmMib: 384, cpus: 0 }, "more: as many vCPUs as the host");
  const held = [{ slot: 1, vmMib: 384, cpuMilli: 250 }, { slot: 3, vmMib: 640, cpuMilli: 500 }];
  assert.deepEqual(slotFor(S, held, { cpuMilli: 250, appMemMb: 256 }), { slot: 2, vmMib: 384, cpus: 0 }, "the free slot, with what is left");
  assert.match(slotFor(S, held, { cpuMilli: 250, appMemMb: 512 }).why, /needs 640 MiB and 512 MiB of the phone's pool is free/);
  assert.match(slotFor(S, held, { cpuMilli: 300, appMemMb: 64 }).why, /asks cpuMilli 300 and 250 of the phone's CPU share is free/);
  assert.match(slotFor(S, [...held, { slot: 2, vmMib: 384, cpuMilli: 0 }], { cpuMilli: 1, appMemMb: 64 }).why, /all 3 of its slots are in use/);
  // a resize is judged without the app's own holding, in its own slot
  assert.deepEqual(slotFor(S, held, { cpuMilli: 750, appMemMb: 512 }, 3), { slot: 3, vmMib: 640, cpus: 0 });
  assert.match(slotFor(S, held, { cpuMilli: 800, appMemMb: 512 }, 3).why, /asks cpuMilli 800 and 750/);
});

test("the sibling statement recovers to the key that signed it, for exactly its nonce, VM and deployment", async () => {
  const acct = privateKeyToAccount("0x" + "4b".repeat(32));
  const st = { nonce: "11".repeat(32), transportSpki: "302a300506032b6570032100" + "22".repeat(32), instanceId: "33".repeat(32), deployment: "0x" + "44".repeat(32) };
  const sig = await acct.sign({ hash: "0x" + siblingDigest(st).toString("hex") });
  assert.equal(await recoverAddress({ hash: "0x" + siblingDigest(st).toString("hex"), signature: sig }), acct.address);
  for (const k of Object.keys(st)) {
    const other = { ...st, [k]: k === "deployment" ? "0x" + "45".repeat(32) : (k === "transportSpki" ? st[k].slice(0, -2) + "23" : "12".repeat(32)) };
    assert.notEqual(await recoverAddress({ hash: "0x" + siblingDigest(other).toString("hex"), signature: sig }), acct.address, k);
  }
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
