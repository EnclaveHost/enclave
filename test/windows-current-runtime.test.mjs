// The real Windows chain.mjs (windows/node/chain.mjs), which keeps the shared off-chain heartbeat host source.
// Only test transports (loopback) and the EVM's warped clock are adapted; no simulated lease sender or receipt.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil } from "./helpers/lease-gas-world.mjs";

const hostUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-lease-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(hostUrl) && specifier === "./lease-gas-runtime.bundle.mjs")
      return { url: fixtureUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const T = { skip: !haveAnvil && "needs anvil", timeout: 120_000 };
let W, relay, op, owner, chain, env, dir;
const savedEnv = { ...process.env };
let serial = 0;
async function loadHost(settings) {
  for (const key of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_/.test(key)) delete process.env[key];
  Object.assign(process.env, settings, { BASE_RPCS: W.rpcUrl, NODE_OPERATOR_KEY: op.key });
  const c = await import(hostUrl + "?fixture=" + ++serial);
  c.loadOperator();
  c.setLeaseJournal(path.join(dir, `lease-release-journal-${serial}.json`));   // a host passes <dir>/lease-release-journal.json
  c.addresses.deployments = W.addr.ledger;
  c.addresses.registry = W.addr.registry;
  return c;
}
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-lease-runtime-"));
  const key = generatePrivateKey(); await W.fund(privateKeyToAccount(key).address);
  relay = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(key), deployment: { chainId: 8453, ...W.addr },
    allowLoopbackHttp: true, now: () => Date.now() + (globalThis.leaseGasFixtureClockOffset || 0) });
  op = await W.operator("https://windows-runtime.test");
  owner = await W.owner();
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
  const record = { format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((k) => [k, W.addr[k]])) };
  const bytes = Buffer.from(JSON.stringify(record));
  const file = path.join(dir, "reviewed.json");
  fs.writeFileSync(file, bytes);
  env = { ENCLAVE_LEASE_GAS_FILE: file, ENCLAVE_LEASE_GAS_DIGEST: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    ENCLAVE_LEASE_GAS_RPCS: W.rpcUrl, ENCLAVE_LEASE_GAS_RELAYS: relay.url };
  chain = await loadHost(env);
});
after(async () => {
  await relay?.close(); W?.stop(); hooks.deregister();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  delete globalThis.leaseGasFixtureClockOffset;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("Windows actual chain module claims, renews and releases a self-hosted app using its reserve and zero operator ETH", T, async () => {
  const id = await W.create(owner, { fund6: 0n });
  await assert.rejects(chain.claimDeployment(id, op.enclaveId), (e) => e.code === "Disabled");
  await W.enable(owner, id, { p: { claimPolicy: 1 } });
  const balance = (await W.reserveOf(id, owner.address)).balanceWei;
  await chain.claimDeployment(id, op.enclaveId);
  let row = await W.row(id);
  assert.equal(row.rate, 0n);
  assert.equal(row.runnerOperator, op.address);
  assert.equal(await chain.renewLeadMs(id, 900000), 285000);
  await assert.rejects(chain.renewDeployment(id), (e) => e.code === "NotInRenewWindow");
  await W.warpTo(row.leaseUntil - 200n);
  globalThis.leaseGasFixtureClockOffset = Number((await W.pc.getBlock()).timestamp) * 1000 - Date.now();
  await chain.renewDeployment(id);
  assert.ok((await W.row(id)).leaseUntil > row.leaseUntil);
  await chain.releaseDeployment(id);
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
  assert.ok((await W.reserveOf(id, owner.address)).balanceWei < balance);
});

test("partial Windows sponsorship configuration refuses even when the host wallet could pay", T, async () => {
  const id = await W.create(owner, { fund6: 0n });
  await W.fund(op.address);
  const balance = await W.pc.getBalance({ address: op.address });
  const nonce = await W.pc.getTransactionCount({ address: op.address });
  for (const missing of Object.keys(env)) {
    const partial = { ...env }; delete partial[missing];
    const c = await loadHost(partial);
    for (const send of [() => c.claimDeployment(id, op.enclaveId), () => c.renewDeployment(id), () => c.releaseDeployment(id)])
      await assert.rejects(send(), /require.*LEASE_GAS_/);
  }
  assert.equal(await W.pc.getBalance({ address: op.address }), balance);
  assert.equal(await W.pc.getTransactionCount({ address: op.address }), nonce);
  await W.fund(op.address, 0n);
});

test("Windows respects an admin contract migration and refuses stale gas configuration without spending", T, async () => {
  const id = await W.create(owner, { fund6: 0n });
  chain.addresses.deployments = "0x9999999999999999999999999999999999999999";
  for (const send of [() => chain.claimDeployment(id, op.enclaveId), () => chain.renewDeployment(id), () => chain.releaseDeployment(id)])
    await assert.rejects(send(), /current ledger or registry/);
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});
