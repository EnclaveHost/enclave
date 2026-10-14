// test/helpers/custody-rig.mjs: a REAL chain (anvil) carrying the REAL EnclaveSecretVault, compiled here with the repo's
// solc-js, beside minimal stand-ins for the address book, the ledger and the registry (their read surface only, byte-for-byte
// the live tuples). Custodians are real HTTP servers reading that chain. Attestation is SIMULATED: a synthetic AMD-shaped chain
// (test/helpers/snp-synth.mjs) signs the reports, and the REAL verifier judges them with that chain's root swapped in for
// AMD's. Nothing here proves anything about AMD hardware; test/custody-hardware.test.mjs is the hardware-backed part.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { synthChain, synthReport } from "./snp-synth.mjs";
import { memoryCollateral } from "../../verifier/index.mjs";
import * as hpke from "../../custody/hpke.mjs";
import { snpVerifier, SNP_GUEST_FORMAT } from "../../custody/verifiers.mjs";
import { createChainReader } from "../../custody/chain.mjs";
import { createCustodian, serveCustodian } from "../../custody/custodian.mjs";
import { UPDATE_ABI } from "../../custody/owner.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(import.meta.url);

const MOCKS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract RigBook { mapping(bytes32 => address) public addr; function set(bytes32 k, address v) external { addr[k] = v; } }
contract RigLedger {
  struct Deployment { bytes32 id; address owner; string appRef; string ports; string configCid; uint16 gpuMilli; uint16 cpuMilli; uint32 appPort;
    bool isPublic; bool active; uint64 createdAt; uint256 rate; uint256 balance6; uint256 spent6; bytes32 runner; address runnerOperator; uint64 leaseUntil; }
  mapping(bytes32 => Deployment) private d;
  function set(bytes32 id, address owner, bytes32 runner, address runnerOperator, uint64 leaseUntil) external {
    Deployment storage x = d[id]; x.id = id; x.owner = owner; x.runner = runner; x.runnerOperator = runnerOperator; x.leaseUntil = leaseUntil; x.active = true; }
  function get(bytes32 id) external view returns (Deployment memory) { return d[id]; }
}
contract RigRegistry {
  struct Enclave { string endpoint; string repo; bytes32 measurement; address operator; uint64 registeredAt; uint64 lastSeen; bool active;
    uint64 cpuPricePerSec6; uint64 gpuPricePerSec6; address proofKey; address payoutWallet; uint64 caps; string region; }
  mapping(bytes32 => Enclave) private e;
  function set(string calldata endpoint, address operator, bool active) external {
    Enclave storage x = e[keccak256(bytes(endpoint))]; x.endpoint = endpoint; x.operator = operator; x.active = active; }
  function get(bytes32 id) external view returns (Enclave memory) { return e[id]; }
}
`;

export function compileContracts() {
  const vaultSrc = fs.readFileSync(path.join(ROOT, "contracts/EnclaveSecretVault.sol"), "utf8");
  const key = createHash("sha256").update(vaultSrc).update(MOCKS).digest("hex").slice(0, 16);
  const cache = path.join(os.tmpdir(), `enclave-custody-rig-${key}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const solc = require("solc");
  const input = { language: "Solidity", sources: { "EnclaveSecretVault.sol": { content: vaultSrc }, "Rig.sol": { content: MOCKS } },
    settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bytecode: "0x" + out.contracts[file][name].evm.bytecode.object });
  const res = { vault: pick("EnclaveSecretVault.sol", "EnclaveSecretVault"), book: pick("Rig.sol", "RigBook"), ledger: pick("Rig.sol", "RigLedger"), registry: pick("Rig.sol", "RigRegistry") };
  fs.writeFileSync(cache, JSON.stringify(res));
  return res;
}

export const anvilAvailable = () => spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

export async function startAnvil({ chainId = 31337 } = {}) {
  const port = await freePort();
  const p = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(chainId)], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const chain = { ...foundry, id: chainId };
  const client = createPublicClient({ chain, transport: http(url) });
  for (let i = 0; i < 100; i++) {
    try { await client.getChainId(); return { url, client, chain, stop: () => p.kill("SIGTERM") }; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  p.kill("SIGKILL");
  throw new Error("anvil did not start");
}

const bookKey = (s) => "0x" + Buffer.from(s, "ascii").toString("hex").padEnd(64, "0");
export const RUNTIME = { name: "wasmtime", version: "40.0.0", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "baseline", wx: "enforced", cache: "none" };
export const MEASUREMENT = "77".repeat(48);   // what synthReport writes
export const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };

// a synthetic report with any field changed, re-signed by the synthetic VCEK
export function resign(S, report, { measurement, debug, vmpl, signingKey } = {}) {
  const r = Buffer.from(report);
  if (measurement) Buffer.from(measurement, "hex").copy(r, 0x90);
  if (debug) r.writeBigUInt64LE(r.readBigUInt64LE(0x08) | (1n << 19n), 0x08);
  if (vmpl !== undefined) r.writeUInt32LE(vmpl, 0x30);
  if (signingKey) r.writeUInt32LE((r.readUInt32LE(0x48) & ~0x1c) | (signingKey << 2), 0x48);
  const sig = cryptoSign("sha384", r.subarray(0, 0x2a0), { key: S.vcekKey, dsaEncoding: "ieee-p1363" });
  r.fill(0, 0x2a0, 0x2a0 + 0x90);
  Buffer.from(sig.subarray(0, 48)).reverse().copy(r, 0x2a0); Buffer.from(sig.subarray(48, 96)).reverse().copy(r, 0x2a0 + 0x48);
  return r;
}

// the trusted front, simulated: it writes report_data = binding ‖ appId and HOST_DATA = the deployment it was launched for
export function snpAttester(S, { appId, hostData, runtime = RUNTIME, tamper = null }) {
  const transportSpki = new Uint8Array(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }));
  return {
    runtime, transportSpki,
    calls: 0,
    async evidence(binding) {
      this.calls++;
      let report = synthReport(S, { reportData: Buffer.concat([Buffer.from(binding), Buffer.from(appId)]), hostData: Buffer.from(hostData) });
      if (tamper) report = tamper(report);
      return { format: SNP_GUEST_FORMAT, abi: "enclave-domain-abi/2", runtime, transportKey: Buffer.from(transportSpki).toString("base64"), report: report.toString("base64") };
    },
  };
}

export async function custodyRig({ n = 5, t = 3, chainId = 31337 } = {}) {
  const C = compileContracts();
  const anvil = await startAnvil({ chainId });
  const pub = anvil.client;
  const fund = async (addr) => pub.request({ method: "anvil_setBalance", params: [addr, "0x" + parseEther("100").toString(16)] });
  const account = async () => { const a = privateKeyToAccount(generatePrivateKey()); await fund(a.address); return a; };
  const wallet = (acct) => createWalletClient({ account: acct, chain: anvil.chain, transport: http(anvil.url) });
  const send = async (acct, address, abi, functionName, args) => {
    const hash = await wallet(acct).writeContract({ address, abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  const deploy = async (acct, c, args = []) => {
    const hash = await wallet(acct).deployContract({ abi: c.abi, bytecode: c.bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const deployer = await account();
  const book = await deploy(deployer, C.book), ledger = await deploy(deployer, C.ledger), registry = await deploy(deployer, C.registry);
  await send(deployer, book, C.book.abi, "set", [bookKey("deployments"), ledger]);
  await send(deployer, book, C.book.abi, "set", [bookKey("registry"), registry]);
  const vault = (await deploy(deployer, C.vault, [book])).toLowerCase();
  if (await pub.getChainId() !== chainId) throw new Error("anvil runs another chain id");

  const S = synthChain();
  const collateral = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
  const verifiers = Object.freeze({ [SNP_GUEST_FORMAT]: snpVerifier({ collateral, roots: new Map([["Genoa", S.arkFp]]) }) });

  const logs = [];
  const log = (l) => logs.push(l);
  const members = [];
  for (let i = 0; i < n; i++) {
    const op = await account();
    const key = hpke.generateKeyPair();
    members.push({ op, encPrivateKey: key.privateKey, encKey: key.publicKey, endpoint: null, server: null, custodian: null });
  }
  const startCustodian = async (m, { reader = null } = {}) => {
    const chain = reader || createChainReader({ rpcs: [anvil.url], vault, minAgree: 1 });
    m.custodian = createCustodian({ chainId, vault, encPrivateKey: m.encPrivateKey, chain, verifiers, log });
    const opts = { rate: () => true };   // every test request comes from 127.0.0.1; the limiter has its own test
    m.server = await serveCustodian(m.custodian, opts);
    if (m.port && m.server.address().port !== m.port) { m.server.close(); m.server = await serveCustodian(m.custodian, { ...opts, port: m.port }); }
    m.port = m.server.address().port;
    m.endpoint = `http://127.0.0.1:${m.port}`;
    return m;
  };
  const stopCustodian = (m) => new Promise((r) => { m.server.closeAllConnections?.(); m.server.close(() => r()); });
  for (const m of members) await startCustodian(m);

  const vaultAbi = [...C.vault.abi];
  const committeeMembers = (ms) => ms.map((m) => ({ operator: m.op.address, encKey: "0x" + Buffer.from(m.encKey).toString("hex"), endpoint: m.endpoint }));
  const creator = await account();
  const salt = "0x" + randomBytes(32).toString("hex");
  const rc = await send(creator, vault, UPDATE_ABI, "createCommittee", [salt, t, committeeMembers(members)]);
  const committeeId = keccak256(new Uint8Array([...Buffer.from("00".repeat(12) + creator.address.slice(2).toLowerCase(), "hex"), ...Buffer.from(salt.slice(2), "hex")]));
  void rc;

  const post = async (url, body) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(`${j.error}: ${j.message}`), { status: r.status, code: j.error });
    return j;
  };
  const endpointId = (ep) => keccak256(toBytes(ep));
  const now = async () => Number((await pub.getBlock()).timestamp);

  return {
    anvil, pub, C, chainId, vault, vaultAbi, book, ledger, registry, deployer, S, collateral, verifiers, members, committeeId, logs,
    account, wallet, send, post, endpointId, now, startCustodian, stopCustodian, committeeMembers,
    reader: (opts = {}) => createChainReader({ rpcs: [anvil.url], vault, minAgree: 1, ...opts }),
    setDeployment: async (id, { owner, endpoint = null, operator = null, leaseFor = 3600 }) => {
      const runner = endpoint ? endpointId(endpoint) : "0x" + "00".repeat(32);
      await send(deployer, ledger, C.ledger.abi, "set", [id, owner, runner, operator || "0x" + "00".repeat(20), BigInt((await now()) + leaseFor)]);
    },
    registerHost: (endpoint, operator, active = true) => send(deployer, registry, C.registry.abi, "set", [endpoint, operator, active]),
    warp: async (sec) => { await pub.request({ method: "evm_increaseTime", params: [sec] }); await pub.request({ method: "evm_mine", params: [] }); },
    async stop() { for (const m of members) if (m.server) await stopCustodian(m).catch(() => {}); anvil.stop(); },
  };
}
