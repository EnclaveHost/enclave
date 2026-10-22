// The REAL Windows Host class (windows/node/host.mjs) with app-funded leases and a ZERO-ETH operator key: its own gas
// runway must no longer take the box out of the market or availability, and its low-gas warning must not tell the
// operator that apps stop renewing (root review 14:45Z). Registry price writes still need the key's ETH and stay gated.
// CONTROL: the same modules with app-funded leases NOT configured (the operator-paid path every box without the setting
// runs; imported separately, before any LEASE_GAS_* variable exists) and the same zero-ETH key do refuse claims.
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

const chainUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-lease-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(chainUrl) && specifier === "./lease-gas-runtime.bundle.mjs") return { url: fixtureUrl, shortCircuit: true };
    // the operator-paid control: its own instances of the repository modules (their configuration is read at import)
    if (context.parentURL?.endsWith("?operator-paid") && /^\.\.?\//.test(specifier)) {
      const r = nextResolve(specifier, context);
      return { ...r, url: r.url.split("?")[0] + "?operator-paid", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const T = { skip: !haveAnvil && "needs anvil", timeout: 120_000 };
let W, relay, op, dir, chain, Host, mainChain, MainHost, hostModule, mainHostModule;
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
  process.env.BASE_RPCS = W.rpcUrl;
  // the control first: the repository's modules as a box WITHOUT app-funded leases configured imports them
  mainChain = await import(new URL("../windows/node/chain.mjs?operator-paid", import.meta.url).href);
  mainHostModule = await import(new URL("../windows/node/host.mjs?operator-paid", import.meta.url).href);
  ({ Host: MainHost } = mainHostModule);
  assert.equal(mainChain.leaseGasActive(), false, "the control is the operator-paid configuration");
  Object.assign(process.env, { BASE_RPCS: W.rpcUrl, ENCLAVE_LEASE_GAS_FILE: path.join(dir, "record.json"),
    ENCLAVE_LEASE_GAS_DIGEST: "sha256:" + createHash("sha256").update(bytes).digest("hex"), ENCLAVE_LEASE_GAS_RPCS: W.rpcUrl, ENCLAVE_LEASE_GAS_RELAYS: relay.url });
  fs.writeFileSync(path.join(dir, "operator.key"), op.key + "\n", { mode: 0o600 });
  chain = await import(chainUrl);
  hostModule = await import(new URL("../windows/node/host.mjs", import.meta.url).href);
  ({ Host } = hostModule);
  chain.loadOperator(path.join(dir, "operator.key"));
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

test("CONTROL: the same Host with app-funded leases unconfigured and the same zero-ETH key refuses claims and tells the operator to top up", T, async () => {
  const { h, logs } = newHost(MainHost, "main");
  await h.warnLowGas();
  assert.match(logs.find((m) => /operator gas is low/.test(m)) || "", /Top up .* or apps stop renewing/);
  assert.equal(h.marketStatus().why, "the operator key has no gas left for claims");
  assert.equal(h.availability().gasRenewalsLeft, 0);
});

test("the startup line for a zero-ETH key says what THIS configuration pays from it", T, () => {
  // configured: claims/renewals/releases go to the apps' reserves (chain.mjs leaseSend); registry and proof writes do not
  const funded = hostModule.noGasMessage(chain.leaseGasActive());
  assert.match(funded, /lease claims, renewals and releases are paid by each app's own reserve \(app-funded leases are configured; this key's ETH is never used for them\)/);
  assert.match(funded, /registry status, price and proof-key writes and paid apps' proof checkpoints need this key's ETH/);
  assert.doesNotMatch(funded, /cannot (register, )?claim, renew/);
  // operator-paid: unchanged
  assert.equal(mainHostModule.noGasMessage(mainChain.leaseGasActive()), "operator has no gas: it can read the ledger but cannot register, claim, renew or prove");
});
