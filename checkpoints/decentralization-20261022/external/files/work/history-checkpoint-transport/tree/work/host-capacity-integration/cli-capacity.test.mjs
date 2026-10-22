// Integration test for cli-enclave.patch: run it in a tree WITH the patch applied
//   HC_PRISTINE_ROOT=/path/to/unpatched/tree node --test work/host-capacity-integration/cli-capacity.test.mjs
// The real `enclave` binary (cli/enclave.mjs) in independent mode reads hosts' signed capacity records from two capacity
// directories, verifies them through cli/independent.mjs's QuorumChain against a schema-4 registry behind two local
// JSON-RPC servers, and prints the aggregate with each host counted once. Every CLI process runs under
// test/helpers/cli-network-guard.mjs: any non-loopback connection, and any request to the stand-in Enclave API, is
// logged, and the log must stay empty. Without --independent the command must answer exactly as the unpatched CLI does
// (HC_PRISTINE_ROOT names that tree; without it the comparison is skipped and only the patched output is checked).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { buildHostCapacityRecord, signHostCapacity, hostIdOf } from "../../network/host-capacity.mjs";
import { gpuDoc, shieldDoc, chainFixture } from "../../test/helpers/host-capacity-fixture.mjs";
import { parseProfile, contractPinsFromProfile } from "../../network/authority-profile.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const GUARD = pathToFileURL(path.join(ROOT, "test/helpers/cli-network-guard.mjs")).href;
const opA = privateKeyToAccount("0x" + "a1".repeat(32)), opB = privateKeyToAccount("0x" + "b2".repeat(32));
const A = "https://host-a.example.org", B = "https://host-b.example.org/t/box-b", DOWN = "https://127.0.0.1:1";

async function serve(t, handler) {
  const s = http.createServer(handler); s.listen(0, "127.0.0.1"); await once(s, "listening");
  t.after(() => { s.closeAllConnections(); return new Promise((r) => s.close(r)); });
  return { origin: `http://127.0.0.1:${s.address().port}`, port: s.address().port };
}
function run(root, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, "cli/enclave.mjs"), ...args], { cwd: os.tmpdir(), env });
    let out = "", err = "";
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 60 s]"; p.kill("SIGKILL"); }, 60_000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }); });
  });
}

async function rig(t) {
  const c = await chainFixture(t), lastSeen = Math.floor(c.blockTime / 1000) - 60;
  c.state.hosts.push({ endpoint: A, operator: opA.address, active: true, lastSeen, cpu: 200, gpu: 1500 },
                     { endpoint: B, operator: opB.address, active: true, lastSeen, cpu: 120 },
                     { endpoint: DOWN, operator: opB.address, active: true, lastSeen, cpu: 1 });
  const sign = (op, endpoint, doc) => signHostCapacity(op, buildHostCapacityRecord({ availability: doc(Date.now()), chainId: 8453, registry: c.binding.address, endpoint, operator: op.address }));
  const envA = await sign(opA, A, gpuDoc), envB = await sign(opB, B, shieldDoc);
  // two independent capacity directories, both holding A (one twice) and one holding B: each host must count once
  const d1 = await serve(t, (q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ records: [envA, envB, envA] })); });
  const d2 = await serve(t, (q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ records: [envA] })); });
  const apiHits = [];
  const api = await serve(t, (q, r) => { apiHits.push(q.url); r.setHeader("content-type", "application/json");
    r.end(JSON.stringify(q.url === "/availability" ? { aggregate: true, enclaves: 3, gpuShareFree: 0.5, cpuShareFree: 0.25, gpuEnclaveCpuShareFree: 0.125 } : {})); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-cli-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const netLog = path.join(dir, "net.log"); fs.writeFileSync(netLog, "");
  const env = (deny) => ({ PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "conf"), ENCLAVE_API_BASE: api.origin, ENCLAVE_ADDRESS_BOOK: "0x" + "ab".repeat(20),
    NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ...(deny ? { ENCLAVE_TEST_DENY_PORT: String(api.port) } : {}) });
  const independent = ["--independent", "--profile", c.profileFile, "--profile-digest", c.digest, "--rpc", c.rpcOrigins.join(","), "--confirmations", "1"];
  return { c, d1, d2, api, apiHits, netLog, env, independent };
}

test("independent availability: signed records from two capacity directories, verified at one agreed block, each host once", { timeout: 120_000 }, async (t) => {
  const r = await rig(t);
  const x = await run(ROOT, ["availability", ...r.independent, "--capacity-directories", `${r.d1.origin},${r.d2.origin}`, "--hosts", hostIdOf(DOWN), "--json"], r.env(true));
  assert.equal(x.code, 0, x.err);
  const a = x.json.aggregate;
  assert.equal(a.enclaves, 2); assert.equal(a.claiming, 2); assert.equal(a.unknown, 1, "the named host that could not be read is unknown, not zero");
  assert.deepEqual(a.totals, { vcpusFree: 20.8, ramGbFree: 63.2, vramFreeGb: 50 });
  assert.equal(a.gpuShareFree, 0.625); assert.equal(a.shielded.gpuShareFree, 0.3);
  const hA = x.json.hosts.find((h) => h.endpoint === A), down = x.json.hosts.find((h) => h.endpoint === DOWN);
  assert.deepEqual(hA.capacity.sources.sort(), [r.d1.origin, r.d1.origin, r.d2.origin].sort());
  assert.equal(hA.registry.postedPricesAreNotCapacity, true);
  assert.equal(down.capacity.status, "unreachable"); assert.match(down.capacity.reasons.join(" "), /non-public/);
  assert.equal(x.json.profileDigest, r.c.digest);
  // the human answer, through the same reader
  const y = await run(ROOT, ["availability", ...r.independent, "--capacity-directories", r.d1.origin], r.env(true));
  assert.equal(y.code, 0, y.err);
  assert.match(y.out, /best gpu slice\s+63% of a card/); assert.match(y.out, /enclave shield\s+30% of a card/);
  assert.match(y.out, /self-reported by each host's registry operator/);
  assert.deepEqual(r.apiHits, [], "the stand-in Enclave API was called");
  assert.equal(fs.readFileSync(r.netLog, "utf8"), "", "a non-loopback or Enclave connection was attempted");
});

test("independent availability refuses without a source or a reviewed profile, and when the registry is not the reviewed code", { timeout: 120_000 }, async (t) => {
  const r = await rig(t);
  let x = await run(ROOT, ["availability", ...r.independent], r.env(true));
  assert.equal(x.code, 1); assert.match(x.err, /name a source: there is no default directory/);
  const pins = path.join(path.dirname(r.c.profileFile), "pins.json");
  // the same authorities as explicit --contract-pins (authority-profile.mjs contractPinsFromProfile): addresses, no code hashes
  fs.writeFileSync(pins, JSON.stringify(contractPinsFromProfile(parseProfile(fs.readFileSync(r.c.profileFile), { expectedDigest: r.c.digest }).profile)));
  x = await run(ROOT, ["availability", "--independent", "--contract-pins", pins, "--usdc-token", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "--rpc", r.c.rpcOrigins.join(","),
    "--confirmations", "1", "--cold"], r.env(true));
  assert.equal(x.code, 1); assert.match(x.err, /reviewed registry code: run it with --profile/);
  r.c.state.code = "0x60006000";
  x = await run(ROOT, ["availability", ...r.independent, "--cold"], r.env(true));
  assert.equal(x.code, 1); assert.match(x.err, /does not carry the reviewed code/);
  assert.deepEqual(r.apiHits, []);
});

test("without --independent, availability answers exactly as before the patch", { timeout: 120_000 }, async (t) => {
  const r = await rig(t);
  for (const args of [["availability"], ["availability", "--json"]]) {
    const x = await run(ROOT, args, r.env(false));
    assert.equal(x.code, 0, x.err);
    if (args.includes("--json")) assert.deepEqual(x.json, { aggregate: true, enclaves: 3, gpuShareFree: 0.5, cpuShareFree: 0.25, gpuEnclaveCpuShareFree: 0.125 });
    else assert.match(x.out, /fleet\s+3 live enclave\(s\)/);
    if (process.env.HC_PRISTINE_ROOT) {
      const before = await run(process.env.HC_PRISTINE_ROOT, args, r.env(false));
      assert.equal(x.out, before.out, `${args.join(" ")}: output differs from the unpatched CLI`); assert.equal(x.code, before.code);
    }
  }
  assert.ok(r.apiHits.includes("/availability"));
});
