// scripts/make-deployment-record.mjs: the reviewed record is generated FROM THE CHAIN (agreeing providers, one anchor two
// blocks deep and still canonical after the reads), only when each deployed runtime is EXACTLY the reviewed artifact
// with every immutable at its expected value. Local anvil; the two "providers" are an explicit FIXTURE injection (the
// same local node through a pass-through proxy), never counted as independent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as viem from "viem";
import { makeRecord, reviewed } from "../scripts/make-deployment-record.mjs";
import { parseDeploymentRecord } from "../network/lease-gas-owner.mjs";
import { leaseDeploymentPins } from "../client/lease-executor-authority.mjs";
import { startWorld, haveAnvil, DEPLOYER } from "./helpers/lease-gas-world.mjs";
import { REPO, leaseGasForgeOut } from "./helpers/lease-gas-forge.mjs";
const BUILD = () => ({ artifacts: leaseGasForgeOut(), sources: path.join(REPO, "contracts") });

const T = { skip: !haveAnvil && "needs anvil", timeout: 120_000 };
let W, proxy, clients, dir;
const mine = async (n = 3) => { for (let i = 0; i < n; i++) await W.rpc("evm_mine", []); };
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  // a second fixture origin: passes everything through, unless told to rewrite one answer (proxy.mutate)
  proxy = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    const r = await fetch(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    let text = await r.text();
    if (proxy.mutate) { try { const j = JSON.parse(b), out = JSON.parse(text); const m = proxy.mutate(j, out); if (m) text = JSON.stringify(m); } catch {} }
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(text); }); });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  clients = [W.pc, viem.createPublicClient({ chain: W.chain, transport: viem.http(`http://127.0.0.1:${proxy.address().port}`) })];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-"));
  await mine();   // the generator reads two blocks below the head: mine past bindExecutor (finality is not weakened)
});
after(() => { proxy?.close(); W?.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const pins = () => ({ deployments: W.addr.ledger, registry: W.addr.registry });
const base = (o = {}) => ({ ...BUILD(), fixtureClients: clients, reserve: W.addr.reserve, pins: pins(), l1Oracle: viem.zeroAddress, ...o });

test("the exact reviewed runtimes (every immutable at its expected value) yield the record the runtime pins accept", T, async () => {
  const { record, bytes, digest, evidence } = await makeRecord(base());
  assert.equal(record.executor, W.addr.executor);
  assert.equal(record.reserveCodeHash, W.addr.reserveCodeHash); assert.equal(record.executorCodeHash, W.addr.executorCodeHash);
  assert.deepEqual(evidence.immutables, { reserve: ["ledger", "registry", "l1Oracle"], executor: ["reserve", "ledger", "SELF"] });
  assert.equal(evidence.fixture, true);
  const parsed = parseDeploymentRecord(bytes, { expectedDigest: digest });
  assert.equal(leaseDeploymentPins(parsed).reserve, W.addr.reserve);
});

test("refused: an executor whose ledger immutable or SELF is not the expected one (same code otherwise)", T, async () => {
  const code = await W.pc.getCode({ address: W.addr.executor });
  const R = reviewed("executor", BUILD());
  const patched = (name, value) => { const b = Buffer.from(code.slice(2), "hex"); const w = Buffer.from(value.slice(2).padStart(64, "0"), "hex");
    for (const { start } of R.refs[name]) w.copy(b, start); return "0x" + b.toString("hex"); };
  try {
    await W.rpc("anvil_setCode", [W.addr.executor, patched("ledger", W.addr.usdc)]); await mine();
    await assert.rejects(makeRecord(base()), /executor's runtime is not the reviewed artifact with its expected immutables/);
    await W.rpc("anvil_setCode", [W.addr.executor, patched("SELF", W.addr.registry)]); await mine();
    await assert.rejects(makeRecord(base()), /executor's runtime is not the reviewed artifact/);
  } finally { await W.rpc("anvil_setCode", [W.addr.executor, code]); await mine(); }
  await makeRecord(base());   // restored: accepted again
});

test("refused: other pinned authorities, an unexpected L1 oracle, an unbound executor", T, async () => {
  await assert.rejects(makeRecord(base({ pins: { ...pins(), registry: W.addr.usdc } })), /another ledger or registry than the pinned/);
  await assert.rejects(makeRecord(base({ l1Oracle: W.addr.usdc })), /L1 oracle .* is not the expected/);
  const fresh = await W.deploy(W.A.reserve, [W.addr.ledger, W.addr.registry, viem.zeroAddress,
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 0, overheadRenewGas: 0, overheadReleaseGas: 0, minClaimInterval: 60, l1Bps: 0 }]);
  await mine();
  await assert.rejects(makeRecord(base({ reserve: fresh })), /no executor bound/);
});

test("refused: the anchor block replaced during the reads (reorg), RPCs that disagree", T, async () => {
  let n = 0;
  proxy.mutate = (req, out) => (req.method === "eth_getBlockByNumber" && ++n === 2 && out.result ? { ...out, result: { ...out.result, hash: "0x" + "ab".repeat(32) } } : null);
  try { await assert.rejects(makeRecord(base()), /replaced during the reads \(reorg\)/); } finally { proxy.mutate = null; }
  proxy.mutate = (req, out) => (req.method === "eth_getCode" ? { ...out, result: "0x00" } : null);
  try { await assert.rejects(makeRecord(base()), /disagree/); } finally { proxy.mutate = null; }
});

test("refused before any read: one provider named twice, a loopback RPC for a record to publish", T, async () => {
  const prod = (rpcs) => makeRecord({ rpcs, reserve: W.addr.reserve, pins: pins() });
  await assert.rejects(prod(["https://rpc.provider-a.example/key1", "https://rpc.provider-a.example/key2"]), /are one provider/);
  await assert.rejects(prod([W.rpcUrl, `http://127.0.0.1:${proxy.address().port}`]), /loopback RPC is a local fixture/);
});
