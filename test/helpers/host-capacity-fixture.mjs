// Shared fixtures for the host capacity tests (test/host-capacity.test.mjs, work/host-capacity-integration/*.test.mjs):
// host documents shaped like the supervisor's and the Windows node's /availability, a schema-4 registry behind two real
// local JSON-RPC servers read by the committed quorum reader, and HTTPS hosts on loopback under a test CA. All synthetic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { keccak256, toBytes, createPublicClient, http as transport, encodeFunctionResult, toFunctionSelector, decodeFunctionData } from "viem";
import { base } from "viem/chains";
import { quorumReader } from "../../windows/node/host-identity.mjs";
import { encodeProfile, profileDigest, parseProfile } from "../../network/authority-profile.mjs";
import { capacityRegistryBinding, publicJsonFetch, HOST_CAPACITY_PATH } from "../../network/host-capacity-http.mjs";

export const PROFILE_FILE = new URL("../../contracts/deployments/network-profile-base.json", import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "host-capacity-"));

// ---- the host documents: shaped exactly like the supervisor's and the Windows node's /availability --------------------
export const iso = (t) => new Date(t).toISOString();
export const gpuDoc = (t) => ({ gpu: true, type: "gpu", teeCpu: "amd-sev-snp", gpuShareFree: 0.625, cpuShareFree: 0.4, usedGpuShare: 0.375, usedCpuShare: 0.6, maxShare: 0.625,
  vcpusFree: 12.8, ramGbFree: 51.2, cpuGflopsFree: 800, nodeVcpus: 32, nodeRamGb: 128, nodeGflops: 2000, smFree: 82, smTotal: 132, vramFreeGb: 50,
  gpuTflopsFree: 615.6, cardVramGb: 80, cardTflops: 989.4, cards: 1, cardVramSource: "nvidia-smi", networkOptions: true, waf: true, configOverride: true,
  configEdit: true, shareResize: true, gpuOptional: true, secrets: true, customDomains: false, devDeploy: true, rateCap: true, selfHostFree: true,
  payoutWallet: null, proofOfTime: true, askCpuPricePerSec6: 200, askGpuPricePerSec6: 1500, claimEnabled: true,
  instanceSweep: { lastRunAt: iso(t), reclaimed: 0 }, ramBudgetMb: 122880, ramCommittedMb: 73728, ramFreeMb: 49152, source: "vm", updatedAt: iso(t) });
export const shieldDoc = (t) => ({ ok: true, role: "windows-hv-node", name: "box-b", gpu: false, maxShare: 0.5, gpuShareFree: 0.3, cpuShareFree: 0.5, nodeVcpus: 16,
  nodeRamGb: 24, machineRamGb: 64, nodeGflops: 1000, computeMeasure: { source: "measured", gflops: 1000 }, teeCpu: null, tier: "hv-node",
  shielded: { vramGb: 24, model: "card", tflops: 82 }, vcpusFree: 8, ramGbFree: 12, claimEnabled: true, updatedAt: iso(t) });

// ---- the chain fixture: a schema-4 registry behind two real JSON-RPC servers --------------------------------------------
const ENCLAVE4 = [["endpoint", "string"], ["repo", "string"], ["measurement", "bytes32"], ["operator", "address"], ["registeredAt", "uint64"],
  ["lastSeen", "uint64"], ["active", "bool"], ["cpuPricePerSec6", "uint64"], ["gpuPricePerSec6", "uint64"], ["proofKey", "address"], ["payoutWallet", "address"]]
  .map(([name, type]) => ({ name, type }));
const REG = [
  { type: "function", name: "registrySchema", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "count", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "get", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: ENCLAVE4 }] },
  { type: "function", name: "getPage", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: ENCLAVE4 }] }];
const Z32 = "0x" + "00".repeat(32), Z20 = "0x" + "00".repeat(20);
const entryOf = (h) => ({ endpoint: h.endpoint, repo: "EnclaveHost/enclave", measurement: Z32, operator: h.operator, registeredAt: 1n, lastSeen: BigInt(h.lastSeen),
  active: h.active, cpuPricePerSec6: BigInt(h.cpu ?? 100), gpuPricePerSec6: BigInt(h.gpu ?? 0), proofKey: Z20, payoutWallet: Z20 });

export async function chainFixture(t) {
  const code = "0x" + randomBytes(5892).toString("hex");
  const state = { hosts: [], code, schema: 4n, down: [false, false], lie: [null, null] }, blockTime = Math.floor(Date.now() / 1000);
  const sel = Object.fromEntries(["registrySchema()", "count()", "get(bytes32)", "getPage(uint256,uint256)"].map((s) => [toFunctionSelector(s), s.split("(")[0]]));
  const servers = [];
  for (const peer of [0, 1]) {
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        if (state.down[peer]) { res.destroy(); return; }
        const one = (m) => {
          const r = (result) => ({ jsonrpc: "2.0", id: m.id, result }), hosts = state.lie[peer] || state.hosts;
          if (m.method === "eth_chainId") return r("0x2105");
          if (m.method === "eth_blockNumber") return r("0x3e8");
          if (m.method === "eth_getBlockByNumber") {
            const n = Number(BigInt(m.params[0]));
            return r({ number: "0x" + n.toString(16), hash: "0x" + n.toString(16).padStart(64, "0"), parentHash: Z32, timestamp: "0x" + blockTime.toString(16), nonce: "0x0000000000000000",
              difficulty: "0x0", gasLimit: "0x1", gasUsed: "0x0", miner: Z20, extraData: "0x", size: "0x1", logsBloom: "0x" + "00".repeat(256), transactionsRoot: Z32,
              stateRoot: Z32, receiptsRoot: Z32, sha3Uncles: Z32, mixHash: Z32, totalDifficulty: "0x0", baseFeePerGas: "0x1", transactions: [], uncles: [] });
          }
          if (m.method === "eth_getCode") return r(state.code);
          if (m.method === "eth_call") {
            const data = m.params[0].data, fn = sel[data.slice(0, 10)];
            const enc = (result) => r(encodeFunctionResult({ abi: REG, functionName: fn, result }));
            if (fn === "registrySchema") return enc(state.schema);
            if (fn === "count") return enc(BigInt(hosts.length));
            if (fn === "get") {
              const { args } = decodeFunctionData({ abi: REG, data }), h = hosts.find((x) => keccak256(toBytes(x.endpoint)) === args[0]);
              return enc(h ? entryOf(h) : { ...entryOf({ endpoint: "", operator: Z20, lastSeen: 0, active: false, cpu: 0 }) });
            }
            if (fn === "getPage") { const { args } = decodeFunctionData({ abi: REG, data }); return enc(hosts.slice(Number(args[0]), Number(args[0] + args[1])).map(entryOf)); }
          }
          return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
        };
        const m = JSON.parse(b); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m)));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
  }
  t.after(() => Promise.all(servers.map((s) => { s.closeAllConnections(); return new Promise((r) => s.close(r)); })));
  const clients = servers.map((s) => createPublicClient({ chain: base, transport: transport(`http://127.0.0.1:${s.address().port}`, { retryCount: 0, timeout: 4000 }) }));
  const reader = quorumReader({ clients, localFixture: true, deadlineMs: 4000 });
  const real = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
  real.contracts.registry = { ...real.contracts.registry, codeHash: keccak256(code), runtimeBytes: 5892 };
  const bytes = encodeProfile(real), digest = profileDigest(bytes), dir = tmp();
  fs.writeFileSync(path.join(dir, "profile.json"), bytes);
  const binding = capacityRegistryBinding(parseProfile(bytes, { expectedDigest: digest }).profile);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { state, reader, binding, digest, profileFile: path.join(dir, "profile.json"), blockTime: blockTime * 1000, dir,
           rpcOrigins: servers.map((s) => `http://127.0.0.1:${s.address().port}`) };
}

// ---- HTTPS hosts on loopback: a test CA, names resolved by an injected lookup -----------------------------------------
let PKI = null;
export function pki() {
  if (PKI) return PKI;
  const dir = tmp(), run = (a) => execFileSync("openssl", a, { stdio: "ignore" });
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=capacity test ca", "-days", "1", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"),
       "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
  run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=hosts", "-keyout", path.join(dir, "h.key"), "-out", path.join(dir, "h.csr")]);
  fs.writeFileSync(path.join(dir, "ext"), "subjectAltName=DNS:host-a.example.org,DNS:host-b.example.org,DNS:host-c.example.org,DNS:fake.example.org\nextendedKeyUsage=serverAuth\n");
  run(["x509", "-req", "-in", path.join(dir, "h.csr"), "-CA", path.join(dir, "ca.pem"), "-CAkey", path.join(dir, "ca.key"), "-set_serial", "9", "-days", "1", "-extfile", path.join(dir, "ext"), "-out", path.join(dir, "h.pem")]);
  PKI = { ca: fs.readFileSync(path.join(dir, "ca.pem")), key: fs.readFileSync(path.join(dir, "h.key")), cert: fs.readFileSync(path.join(dir, "h.pem")), dir };
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return PKI;
}
// one HTTPS listener per host name; the registered endpoint is https://<name>:<port>
export async function hostServer(t, name, handler, prefix = "") {
  const p = pki(), server = https.createServer({ key: p.key, cert: p.cert }, (req, res) => (new URL(req.url, "http://x").pathname === prefix + HOST_CAPACITY_PATH ? handler(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return `https://${name}:${server.address().port}${prefix}`;
}
// the reader's host fetch: the REAL guarded fetch, with test seams only for the fixture's private loopback address and CA
export const loopbackFetch = () => publicJsonFetch({ lookup: async () => [{ address: "127.0.0.1", family: 4 }], allowAddress: (a) => a === "127.0.0.1", ca: pki().ca, timeoutMs: 3000 });
