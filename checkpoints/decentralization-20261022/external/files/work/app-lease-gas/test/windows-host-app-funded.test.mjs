// The REAL Windows Host class (shadow-win/windows/node/host.mjs, rebased from current main) with app-funded leases and a
// ZERO-ETH operator key: its own gas runway must no longer take the box out of the market or availability, and its
// low-gas warning must not tell the operator that apps stop renewing (root review 14:45Z). Registry price writes still
// need the key's ETH and stay gated. CONTROL: main's unpatched Host with the same zero-ETH key does refuse claims.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil } from "./helpers/b-world.mjs";

const chainUrl = new URL("../shadow-win/windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(chainUrl) && specifier === "./lease-gas-runtime.bundle.mjs") return { url: fixtureUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const T = { skip: !haveAnvil && "needs anvil", timeout: 120_000 };
let W, relay, op, dir, chain, Host, mainChain, MainHost;
const saved = { ...process.env };
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-host-app-funded-"));
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address);
  relay = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(k), deployment: { chainId: 8453, ...W.addr }, allowLoopbackHttp: true });
  op = await W.operator("https://windows-host-app-funded.test");          // registered, then 0 ETH
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((x) => [x, W.addr[x]])) }));
  fs.writeFileSync(path.join(dir, "record.json"), bytes);
  Object.assign(process.env, { BASE_RPCS: W.rpcUrl, ENCLAVE_LEASE_GAS_FILE: path.join(dir, "record.json"),
    ENCLAVE_LEASE_GAS_DIGEST: "sha256:" + createHash("sha256").update(bytes).digest("hex"), ENCLAVE_LEASE_GAS_RPCS: W.rpcUrl, ENCLAVE_LEASE_GAS_RELAYS: relay.url });
  fs.writeFileSync(path.join(dir, "operator.key"), op.key + "\n", { mode: 0o600 });
  chain = await import(chainUrl);
  ({ Host } = await import(new URL("../shadow-win/windows/node/host.mjs", import.meta.url).href));
  chain.loadOperator(path.join(dir, "operator.key"));
  // the control: main BEFORE root's lease-gas integration (control-win: those two files from
  // work/windows-lease-source-integration/main-before, everything else current main), which reads no LEASE_GAS_* setting
  mainChain = await import(new URL("../control-win/windows/node/chain.mjs", import.meta.url).href);
  ({ Host: MainHost } = await import(new URL("../control-win/windows/node/host.mjs", import.meta.url).href));
  mainChain.loadOperator(path.join(dir, "operator.key"));
});
after(async () => {
  await relay?.close(); W?.stop(); hooks.deregister();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
const newHost = (H, name) => {
  const logs = [], d = fs.mkdtempSync(path.join(dir, name + "-"));
  const h = new H({ dir: d, endpoint: "https://windows-host-app-funded.test", name, appsEnabled: true, cpuPricePerSec6: 1000, claimScope: "market", log: (m) => logs.push(m) });
  h.chainReady = true; h.relayAttached = true;
  h.registered = { active: true, operator: op.address, cpuPricePerSec6: 1000n, gpuPricePerSec6: 0n };
  return { h, logs };
};

test("app-funded Windows host with a zero-ETH key: still in the market, honest status, no 'apps stop renewing' advice", T, async () => {
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
  assert.equal(chain.leaseGasActive(), true);
  const { h, logs } = newHost(Host, "funded");
  await h.warnLowGas();
  const warning = logs.find((m) => /operator gas is low/.test(m));
  assert.ok(warning, logs.join("\n"));
  assert.match(warning, /paid by each app's own reserve \(app-funded leases\), so apps keep renewing/);
  assert.doesNotMatch(warning, /Top up .* or apps stop renewing/);
  assert.notEqual(h.marketStatus().why, "the operator key has no gas left for claims");
  const view = h.hostingView().gas;
  assert.deepEqual({ leases: view.leases, low: view.low, registryEthLow: view.registryEthLow, renewalsLeft: view.renewalsLeft },
    { leases: "app-funded", low: false, registryEthLow: true, renewalsLeft: null });
  const a = h.availability();
  assert.equal(a.leaseGas, "app-funded"); assert.equal(a.gasRenewalsLeft, null);
});

test("CONTROL: main's pre-integration Host with the same zero-ETH key refuses claims and tells the operator to top up", T, async () => {
  const { h, logs } = newHost(MainHost, "main");
  await h.warnLowGas();
  assert.match(logs.find((m) => /operator gas is low/.test(m)) || "", /Top up .* or apps stop renewing/);
  assert.equal(h.marketStatus().why, "the operator key has no gas left for claims");
  assert.equal(h.availability().gasRenewalsLeft, 0);
});
