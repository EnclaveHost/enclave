// Integration test for windows-agent.patch: run it in a tree WITH the patch applied
//   node --test work/host-capacity-integration/windows-capacity.test.mjs
// It boots the real windows/node/agent.mjs (as test/windows-node-retired-engine-agent.test.mjs does: retired engine,
// no relay, its LOCAL_HTTP_PORT loopback surface) against a fake Base RPC whose registry lists this box, and checks that
// GET /v1/host/capacity is the box's own /availability, signed by its operator key for its registered /t/<name>
// endpoint; that a row naming another operator, or no operator key, signs nothing; and that deploy-files ships the
// producer without any package import outside windows/node.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { encodeFunctionResult, decodeFunctionData, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyHostCapacity, hostIdOf } from "../../network/host-capacity.mjs";
import { closure } from "../../windows/node/deploy-files.mjs";

const ROOT = new URL("../../", import.meta.url).pathname, AGENT = path.join(ROOT, "windows/node/agent.mjs");
const KEY = "0x" + "07".repeat(32), operator = privateKeyToAccount(KEY).address.toLowerCase();
const REGISTRY = "0x" + "a1".repeat(20), ENDPOINT = "https://box.independent.example/t/capacity-test";
const pins = { registry: REGISTRY, deployments: "0x" + "a2".repeat(20), appCatalog: "0x" + "a3".repeat(20), proofOfTime: "0x" + "a4".repeat(20), enclavePay: "0x" + "00".repeat(20),
  verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: "0x" + "00".repeat(20) };
const ENCLAVE4 = [["endpoint", "string"], ["repo", "string"], ["measurement", "bytes32"], ["operator", "address"], ["registeredAt", "uint64"], ["lastSeen", "uint64"],
  ["active", "bool"], ["cpuPricePerSec6", "uint64"], ["gpuPricePerSec6", "uint64"], ["proofKey", "address"], ["payoutWallet", "address"]].map(([name, type]) => ({ name, type }));
const GET = [{ type: "function", name: "get", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: ENCLAVE4 }] }];
const freePort = async () => { const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening"); const p = s.address().port; s.close(); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a fake Base RPC: the registry's get(id) answers this box's row; everything else is an RPC error (a failed read)
async function fakeRegistry(t, rowOperator, rowActive = true) {
  const sel = toFunctionSelector("get(bytes32)");
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const one = (m) => {
      if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x2105" };
      if (m.method === "eth_getBalance") return { jsonrpc: "2.0", id: m.id, result: "0x0" };
      if (m.method === "eth_call" && String(m.params[0].to).toLowerCase() === REGISTRY && m.params[0].data.startsWith(sel)) {
        const { args } = decodeFunctionData({ abi: GET, data: m.params[0].data });
        const ours = args[0] === hostIdOf(ENDPOINT);
        return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: GET, functionName: "get", result: { endpoint: ours ? ENDPOINT : "", repo: "independent/host",
          measurement: "0x" + "00".repeat(32), operator: ours ? rowOperator : "0x" + "00".repeat(20), registeredAt: 1n, lastSeen: 2n, active: ours && rowActive, cpuPricePerSec6: 12n,
          gpuPricePerSec6: 0n, proofKey: "0x" + "00".repeat(20), payoutWallet: "0x" + "00".repeat(20) } }) };
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "not served by this fake" } };
    };
    const m = JSON.parse(b); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m)));
  }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function agent(t, { rowOperator = operator, key = KEY, rowActive = true } = {}) {
  const rpc = await fakeRegistry(t, rowOperator, rowActive), httpPort = await freePort();
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-win-")); t.after(() => fs.rmSync(nodeDir, { recursive: true, force: true }));
  const pinsFile = path.join(nodeDir, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify({ version: 1, chainId: 8453, contracts: pins }));
  const env = { PATH: process.env.PATH, NODE_DIR: nodeDir, NODE_NAME: "capacity-test", RELAY_URL: "none", LOCAL_HTTP_PORT: String(httpPort),
    TPMATTEST_EXE: path.join(nodeDir, "no-tpm-tool"), HOST_PORT: String(await freePort()), HOST_EXE: path.join(nodeDir, "no-ee-host"), ENCLAVE_ENGINE: "",
    HOSTING_ADMIN_PORT: "0", APPS: "1", PUBLIC_URL: ENDPOINT, BASE_RPCS: rpc, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ...(key ? { NODE_OPERATOR_KEY: key } : {}) };
  const child = spawn(process.execPath, [AGENT], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  t.after(() => { child.kill(); });
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${httpPort}${p}`); return { status: r.status, body: await r.json() }; };
  for (let i = 0; i < 100; i++) { await sleep(200); if (await get("/v1/health").catch(() => null)) break; }
  return { get, log: () => out };
}

test("the Windows node serves its /availability signed by its registry operator for its /t/<name> endpoint", { timeout: 60_000 }, async (t) => {
  const a = await agent(t);
  let c = null;
  for (let i = 0; i < 50; i++) { c = await a.get("/v1/host/capacity"); if (c.status === 200) break; await sleep(200); }
  assert.equal(c.status, 200, `${JSON.stringify(c.body)}\n${a.log().slice(-2000)}`);
  const v = await verifyHostCapacity(c.body, { pins: { chainId: 8453, registry: REGISTRY }, entry: { endpoint: ENDPOINT, operator, active: true } });
  assert.equal(v.record.endpoint, ENDPOINT); assert.equal(v.record.operator, operator);
  const av = await a.get("/availability");
  assert.deepEqual(Object.keys(v.availability).sort(), Object.keys(av.body).sort());
  for (const k of ["role", "name", "gpu", "teeCpu", "tier", "claimEnabled", "fullService", "isolation"]) assert.deepEqual(v.availability[k], av.body[k], k);
});

test("a row naming another operator, or no operator key, signs nothing; deploy-files ships the producer", { timeout: 90_000 }, async (t) => {
  let a = await agent(t, { rowOperator: "0x" + "99".repeat(20) });
  for (let i = 0; i < 100 && !/belongs to operator 0x9999/i.test(a.log()); i++) await sleep(100);
  assert.match(a.log(), /belongs to operator 0x9999/i, "the agent read the registry row first");
  let c = await a.get("/v1/host/capacity");
  assert.equal(c.status, 503); assert.match(c.body.error, /not registered yet/);
  a = await agent(t, { key: null });
  await sleep(1500);
  c = await a.get("/v1/host/capacity");
  assert.equal(c.status, 503); assert.equal(c.body.error, "capacity_not_signed");
  const { files, problems } = closure();
  assert.deepEqual(problems, []);
  for (const f of ["network/host-capacity-producer.mjs", "network/host-capacity-record.mjs", "network/canonical.mjs"]) assert.ok(files.includes(f), f);
  assert.ok(!files.includes("network/host-capacity.mjs") && !files.includes("network/host-capacity-http.mjs"), "the reader half is not shipped to a host");
});

test("a deactivated registry row for this box and key signs nothing", { timeout: 60_000 }, async (t) => {
  const a = await agent(t, { rowActive: false });
  for (let i = 0; i < 100 && !/registry: listed as/.test(a.log()); i++) await sleep(100);
  assert.match(a.log(), /registry: listed as/, "the agent read its row first");
  const c = await a.get("/v1/host/capacity");
  assert.equal(c.status, 503); assert.match(c.body.error, /not registered yet/);
});
