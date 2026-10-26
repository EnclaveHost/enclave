// No periodic liveness transaction from any host agent (docs/network/host-liveness.md), on a REAL chain (anvil, chain
// 8453, the cli-independent rig's real schema-4 registry), counted from the chain itself (registry event logs):
//   - the REAL supervisor.js, registered and running over three reconcile periods: zero registry writes and zero Heartbeat
//     events; a real configuration drift (its price changed on chain) is corrected by exactly one setPrices; an operator
//     deregistration is reported, NOT silently undone (the old heartbeat re-activated the row every 15 minutes);
//   - negative control: the pre-change supervisor (the patch's base) on the same rig DOES send heartbeats, so the count
//     above can see them;
//   - the REAL Windows node (windows/node/host.mjs + chain.mjs) for a dialed AND a tunnelled endpoint over several
//     timer periods: zero transactions reach the RPC; its real status write (re-registering a deactivated row) and a real
//     price write still go out, through the same counting RPC (the positive control for the counter).
// Only anvil's published dev keys are used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { haveTools, startRig, startActualHost, KEYS } from "./helpers/cli-independent-rig.mjs";
import { verifyHostCapacity } from "../network/host-capacity.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_SUPERVISOR = process.env.OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR || "";   // the patch's base supervisor.js, for the negative control
const skip = haveTools();
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const HEARTBEAT = parseAbiItem("event Heartbeat(bytes32 indexed id, uint64 at)");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "offchain-heartbeat-"));

/** every registry event since `from`, by name (each registry write emits one) */
async function registryWrites(r, from) {
  const logs = await r.pc.getLogs({ address: r.addresses.registry, fromBlock: from, toBlock: "latest" });
  const names = { [keccak256(toBytes("Heartbeat(bytes32,uint64)"))]: "Heartbeat", [keccak256(toBytes("PricesSet(bytes32,uint64,uint64)"))]: "PricesSet",
    [keccak256(toBytes("Deregistered(bytes32)"))]: "Deregistered", [keccak256(toBytes("Updated(bytes32,string,bytes32)"))]: "Updated",
    [keccak256(toBytes("ProofKeySet(bytes32,address)"))]: "ProofKeySet", [keccak256(toBytes("Registered(bytes32,address,string,string)"))]: "Registered" };
  return logs.map((l) => ({ name: names[l.topics[0]] || l.topics[0], block: l.blockNumber, tx: l.transactionHash }));
}
const heartbeats = async (r) => (await r.pc.getLogs({ address: r.addresses.registry, event: HEARTBEAT, fromBlock: 0n, toBlock: "latest" })).length;
const entry = (r) => r.pc.readContract({ address: r.addresses.registry, abi: r.A.registry4.abi, functionName: "get", args: [r.runner] });

test("the REAL supervisor sends no periodic registry transaction; real drift is corrected once; a deregistration is not undone",
  skip ? { skip } : { timeout: 900000 }, async (t) => {
  const r = await startRig(); t.after(() => r.stop());
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = await startActualHost(r, { id: "0x" + "00".repeat(32), owner: r.owner, dir, token: "t".repeat(40), leaseUntil: 0, claim: true, seed: false,
    env: { REGISTRY_RECONCILE_SEC: "60" } });
  // The rig registers this endpoint with the operator key before the host boots (cli-independent-rig.mjs: register(...,
  // proofKey 0)), so the REAL supervisor adopts that row with setProofKey (supervisor.js bootRegistration: only the per-boot
  // proof key differs) instead of a full register(). Either reviewed boot path is accepted, ONLY for the rig's own endpoint
  // and row id; the chain row is then bound explicitly (endpoint, operator, active) before any write is measured.
  const boot = await host.waitLog(/\[registry\] (?:registered https:\/\/host\.independent\.test repo=\S+|adopted the existing registration of https:\/\/host\.independent\.test) id=(0x[0-9a-f]{64})/, 60000);
  assert.equal(boot[1], r.runner, "the boot registration is the rig's own row");
  const bound = await entry(r);
  assert.equal(bound.endpoint, "https://host.independent.test", "the row advertises the expected endpoint");
  assert.equal(bound.operator.toLowerCase(), privateKeyToAccount(KEYS.operator).address.toLowerCase(), "the row is held by the operator key");
  assert.equal(bound.active, true, "the row is active before writes are measured");
  await sleep(10000);                                         // boot-time syncs (proof key) settle
  const b0 = await r.pc.getBlockNumber();
  await sleep(3 * 60_000 + 15_000);                           // three reconcile periods
  assert.deepEqual(await registryWrites(r, b0 + 1n), [], "three reconcile periods, no registry write");
  assert.equal(await heartbeats(r), 0, "no Heartbeat event over the whole run");
  assert.equal((await entry(r)).active, true);
  // its off-chain liveness: the signed record at /v1/host/capacity, readable from any origin, verified against the row
  const capacity = () => fetch(host.upstream + "/v1/host/capacity", { headers: { origin: "https://dashboard.elsewhere.example" } });
  let cr = await capacity();
  assert.equal(cr.status, 200, await cr.clone().text());
  assert.equal(cr.headers.get("access-control-allow-origin"), "*"); assert.equal(cr.headers.get("access-control-allow-credentials"), null);
  const row = await entry(r), signed = await verifyHostCapacity(await cr.json(), { pins: { chainId: 8453, registry: r.addresses.registry },
    entry: { endpoint: row.endpoint, operator: row.operator, active: row.active } });
  assert.equal(signed.signer, row.operator.toLowerCase(), "signed by the row's operator for the registered endpoint");
  // a real configuration drift: the price on chain no longer matches the host's -> exactly one corrective setPrices
  const op = r.wc(KEYS.operator);
  await r.write(op, r.addresses.registry, r.A.registry4.abi, "setPrices", [r.runner, 2000n, 0n]);
  const b1 = await r.pc.getBlockNumber();
  await host.waitLog(/\[registry\] price published: 1000\/sec node/, 90000);
  await sleep(3000);
  const fix = await registryWrites(r, b1 + 1n);
  assert.deepEqual(fix.map((w) => w.name), ["PricesSet"], JSON.stringify(fix, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.equal((await entry(r)).cpuPricePerSec6, 1000n);
  // the operator deregisters: the host reports it and does not re-activate the row on a timer
  await r.write(op, r.addresses.registry, r.A.registry4.abi, "deregister", [r.runner]);
  const b2 = await r.pc.getBlockNumber();
  await host.waitLog(/INACTIVE on chain \(deregistered by the operator key\)/, 90000);
  await sleep(65000);
  assert.deepEqual(await registryWrites(r, b2 + 1n), [], "no write after the deregistration");
  assert.equal((await entry(r)).active, false, "the operator's deregistration stands");
  cr = await capacity();
  assert.equal(cr.status, 503, "no signed liveness for a row it saw deregistered (as on Windows): " + await cr.text());
  assert.equal(await heartbeats(r), 0);
  assert.doesNotMatch(host.stdout(), /\[registry\] heartbeat/);
});

test("negative control: the base supervisor DOES heartbeat on the same rig (the counter sees it)",
  skip || !BASE_SUPERVISOR ? { skip: skip || "set OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR to the base supervisor.js (a file in the repository root)" } : { timeout: 300000 }, async (t) => {
  const r = await startRig(); t.after(() => r.stop());
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = await startActualHost(r, { id: "0x" + "00".repeat(32), owner: r.owner, dir, token: "t".repeat(40), leaseUntil: 0, claim: true, seed: false,
    script: BASE_SUPERVISOR, env: { REGISTRY_HEARTBEAT_SEC: "60" } });
  await host.waitLog(/\[registry\] registered/, 60000);
  await host.waitLog(/\[registry\] heartbeat tx=/, 90000);
  await sleep(3000);
  assert.ok(await heartbeats(r) >= 1, "the base supervisor's heartbeat is a Heartbeat event on the registry");
});

test("the REAL Windows node sends no transaction from its timers, dialed or tunnelled; its tick does not undo a deregistration; deliberate status and price writes still go out",
  skip ? { skip } : { timeout: 300000 }, async (t) => {
  const r = await startRig(); t.after(() => r.stop());
  // a counting RPC in front of anvil: every method the node's chain module calls
  const seen = [];
  const proxy = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    for (const m of [JSON.parse(b)].flat()) seen.push(m.method);
    const up = await fetch(r.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(200, { "content-type": "application/json" }); res.end(await up.text());
  });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => { proxy.closeAllConnections(); proxy.close(ok); }));
  process.env.BASE_RPCS = `http://127.0.0.1:${proxy.address().port}`;
  const chain = await import("../windows/node/chain.mjs");
  assert.deepEqual(chain.rpcUrls(), [process.env.BASE_RPCS], "the node's chain module reads ONLY the counting local RPC (never a public one)");
  const { Host } = await import("../windows/node/host.mjs");
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "operator.key"), KEYS.operator + "\n", { mode: 0o600 });
  chain.loadOperator(path.join(dir, "operator.key"));
  chain.addresses.registry = r.addresses.registry;
  const sends = () => seen.filter((m) => m === "eth_sendRawTransaction").length;
  // OFFCHAIN_HEARTBEAT_SKIP_TIMER=1: a negative-control run against the base node skips to the tick section
  for (const endpoint of process.env.OFFCHAIN_HEARTBEAT_SKIP_TIMER === "1" ? [] : [r.endpoint, "https://api.enclave.host/t/box-b"]) {
    const logs = [];
    const h = new Host({ dir, endpoint, name: "b", appsEnabled: true, cpuPricePerSec6: 1000, log: (m) => logs.push(m) });
    h.chainReady = true; h.registered = { active: true, operator: privateKeyToAccount(KEYS.operator).address };
    const before = seen.length;
    for (let i = 0; i < 4; i++) await h.heartbeat();          // four timer periods
    assert.equal(sends(), 0, `${endpoint}: no transaction from the timer`);
    assert.ok(seen.slice(before).includes("eth_getBalance"), `${endpoint}: the timer still reads the gas runway`);
    assert.ok(!logs.some((m) => /heartbeat/i.test(m)), logs.join("\n"));
  }
  assert.equal(await heartbeats(r), 0);
  // a REAL status change, observed by the routine pass: the row is active when the node starts, then its operator
  // deregisters it. The node READS that (its 10-minute pass) and its actual tick() neither re-registers nor re-prices the
  // row (network/registry-reconcile.mjs, the rule the Linux supervisor follows); only a deliberate act (boot) re-registers.
  chain.addresses.deployments = r.addresses.ledger; chain.addresses.appCatalog = r.addresses.catalog;
  const logs = [];
  const h = new Host({ dir, endpoint: r.endpoint, name: "b", appsEnabled: true, cpuPricePerSec6: 1000, repo: "independent/host", log: (m) => logs.push(m) });
  h.chainReady = true; h.bookCheckedAt = Date.now();          // the address book is not re-read here (the rig pins the contracts)
  await h.refreshRegistration();
  assert.equal(h.registered.active, true);
  await r.write(r.wc(KEYS.operator), r.addresses.registry, r.A.registry4.abi, "deregister", [r.runner]);
  await h.heartbeat();                                         // the routine read
  assert.equal(h.registered.active, false, "the routine pass saw the deregistration");
  assert.ok(logs.some((m) => /is now INACTIVE/.test(m)), logs.join("\n"));
  const sentBefore = sends();
  for (let i = 0; i < 3; i++) await h.tick();                  // three actual ticks
  assert.equal(sends(), sentBefore, "no tick re-registered or re-priced the deregistered row: " + logs.slice(-5).join(" | "));
  assert.equal((await entry(r)).active, false, "the operator's deregistration stands");
  assert.ok(logs.some((m) => /a routine pass does not re-activate it/.test(m)));
  await h.ensureRegistered({ phase: "boot" });                 // a deliberate act: the box starting again
  assert.equal(sends(), sentBefore + 1, logs.join("\n"));
  assert.equal((await entry(r)).active, true, "re-registered by a deliberate (boot) registration");
  // and a real price write goes out through the same counting RPC (the counter's positive control)
  await chain.setPrices(r.runner, 1500, 0);
  assert.equal(sends(), sentBefore + 2);
  assert.equal((await entry(r)).cpuPricePerSec6, 1500n);
  assert.equal(await heartbeats(r), 0, "no Heartbeat event at any point");
});
