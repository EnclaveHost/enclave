// READ-ONLY check of the independent dashboard's chain reads against the contracts actually deployed on Base, using
// the reviewed authority profile's pins (contracts/deployments/network-profile-base.json) and public RPCs. It proves
// the reads work on the deployed runtimes (registry schema 4 without caps/registerRelay, ledger rev 16d), not on HEAD
// source. No transaction, signature or private input. Skipped unless ENCLAVE_LIVE_READS=1 (it needs the network).
//   run: ENCLAVE_LIVE_READS=1 node --test test/site-independent-live-reads.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.env.ENCLAVE_LIVE_READS === "1" ? false : "set ENCLAVE_LIVE_READS=1 (read-only public Base RPC access)";
const authority = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/deployments/network-profile-base.json"), "utf8"));
const C = authority.contracts;
const profile = {
  format: "enclave-browser-profile", version: 1, name: "live read check", chainId: 8453,
  rpcs: (process.env.ENCLAVE_LIVE_RPCS || "https://base-rpc.publicnode.com,https://mainnet.base.org,https://base.drpc.org").split(","),
  quorum: 2, confirmations: 2, maxBlockAgeSeconds: 600,
  contractPins: { version: 1, chainId: 8453, contracts: { registry: C.registry.address, deployments: C.deployments.address, appCatalog: C.appCatalog.address,
    proofOfTime: C.proofOfTime.address, enclavePay: C.enclavePay.address, verificationFees: C.verificationFees.address,
    sessionVaultFactory: C.sessionVaultFactory.address, secretVaultV2: C.secretVaultV2.address } },
  usdc: C.usdc.address, ethUsdFeed: C.deployments.reviewedState.ethUsdFeed,
};
let IC;
test.before(async () => {
  if (skip) return;
  const text = JSON.stringify(profile), mem = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
  globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
  globalThis.location = { hostname: "localhost" };
  IC = await import(pathToFileURL(path.join(REPO, "site/js/core/independent-chain.js")).href);
});

test("deployed registry (schema 4): agreed host list and posted prices", { skip, timeout: 120000 }, async () => {
  const { snap, schema, hosts } = await IC.registryHosts();
  assert.equal(schema, 4, "the live registry reports schema 4");
  assert.ok(hosts.length > 0 && hosts.every((h) => !("caps" in h)), "schema-4 rows carry no capability field");
  const a = await IC.independentAvailability();
  assert.ok(a.registeredHosts >= hosts.filter((h) => h.active).length);
  console.log(JSON.stringify({ block: snap.number, registered: hosts.length, active: hosts.filter((h) => h.active).length, live: a.liveHosts,
    cheapestCpuPricePerSec6: a.cheapestCpuPricePerSec6 ?? null, cheapestGpuPricePerSec6: a.cheapestGpuPricePerSec6 ?? null }));
});

test("deployed ledger (rev 16d): count/getPage/get decode at one agreed block", { skip, timeout: 180000 }, async () => {
  const owner = C.deployments.reviewedState.owner;
  const { snap, rev, rows } = await IC.ownedDeployments([owner]);
  assert.equal(rev, 16);
  for (const d of rows.slice(0, 3)){
    const one = await IC.deploymentAt(d.id);
    assert.equal(one.row.owner.toLowerCase(), d.owner.toLowerCase());
  }
  console.log(JSON.stringify({ block: snap.number, ownerRows: rows.length }));
});

test("ETH funding quote: the ledger's own feed, reviewed address, 8 decimals, fresh finalized round", { skip, timeout: 120000 }, async () => {
  const q = await IC.ethFundingQuote();
  assert.equal(q.feed, C.deployments.reviewedState.ethUsdFeed.toLowerCase());
  assert.equal(q.decimals, 8);
  assert.ok(q.ethUsd > 100 && q.ethUsd < 100000, "a plausible ETH/USD price");
  console.log(JSON.stringify({ block: q.block, feed: q.feed, ethUsd: q.ethUsd, ageSeconds: q.ageSeconds, round: String(q.roundId) }));
});

test("token domain and pinned session factory reads", { skip, timeout: 120000 }, async () => {
  const d = await IC.tokenDomain(C.usdc.address);
  assert.equal(d.name, "USD Coin"); assert.equal(d.version, "2");
  const vault = await IC.agreedVaultFor(C.sessionVaultFactory.address, C.deployments.reviewedState.owner);
  assert.match(vault, /^0x[0-9a-f]{40}$/);
});

test("unsupported methods are refused precisely: the deployed registry has no registerRelay or setCaps", { skip, timeout: 120000 }, async () => {
  const snap = await IC.reader().snapshot();
  await IC.assertImplements(snap, C.registry.address, "the pinned registry", ["register(string,string,bytes32,uint64,uint64,address)", "getPage(uint256,uint256)"]);
  await assert.rejects(IC.assertImplements(snap, C.registry.address, "the pinned registry", ["registerRelay(string,string,uint64)", "setCaps(bytes32,uint64,string)"]),
    /does not implement registerRelay\(string,string,uint64\), setCaps/);
});

test("every selector the dashboard sends exists in the deployed ledger, catalog, factory and vault implementation", { skip, timeout: 180000 }, async () => {
  const { DEP_SEL, CAT_SEL } = await import(pathToFileURL(path.join(REPO, "site/js/core/chain.js")).href);
  const snap = await IC.reader().snapshot();
  // rev-16 ledger surface (older-revision create shapes are not expected on the live ledger)
  const ledger = ["create", "fund", "fundAuth", "fundEth", "get", "setActive", "setAppRef", "maxGpuMilli", "feeOf", "setShares", "setConfig",
    "setMaxRate", "capOf", "refund", "refundableOf", "ownerEscrow6", "earnOf", "transferDeployment", "multicall", "deploymentsSchema"].map((k) => DEP_SEL[k]);
  await IC.assertImplements(snap, C.deployments.address, "the deployed ledger", ledger);
  for (const legacy of [DEP_SEL.createV4, DEP_SEL.createV3, DEP_SEL.createV1])
    await assert.rejects(IC.assertImplements(snap, C.deployments.address, "the deployed ledger", [legacy]), /does not implement/);
  const catalog = ["appCount", "getAppsPage", "getVersionsPage", "owner", "publishVersion", "versionFee", "publishVersionCfg", "versionConfigCid",
    "versionConfigCids", "maxFeePerSec6", "catalogSchema", "setActive", "yankVersion"].map((k) => CAT_SEL[k]);
  await IC.assertImplements(snap, C.appCatalog.address, "the deployed catalog", catalog);
  // the factory functions the SDK encodes, with their selectors computed from the SDK's own ABI
  const { toFunctionSelector } = await import("viem");
  const { sessionVaultFactoryAbi } = await import(pathToFileURL(path.join(REPO, "sdk/sessions/dist/node.mjs")).href);
  const fsel = (name) => toFunctionSelector(sessionVaultFactoryAbi.find((x) => x.type === "function" && x.name === name)).slice(2);
  await IC.assertImplements(snap, C.sessionVaultFactory.address, "the pinned session factory", [fsel("vaultFor"), fsel("openFor"), fsel("openWithDepositFor")]);
  await IC.assertImplements(snap, C.sessionVaultImplementation.address, "the pinned vault implementation",
    ["topUpWithAuthorization(bytes32,uint256,bytes32,uint256,uint64,bytes)", "extend(bytes32,uint64,bytes32,uint64,bytes)", "terminate(bytes32,bytes32,uint64,bytes)",
     "revokeAll(bool,bytes32,uint64,bytes)", "withdraw(uint256,bytes32,uint64,bytes)",
     "promote(bytes32,string,address,string,string,string,bool,bytes32,uint64,bytes)", "adopt(bytes32,string,bytes32,uint64,bytes)",
     "setEnvironment(bytes32,string,bytes32,uint64,bytes)", "release(bytes32,address,bytes32,uint64,bytes)", "held(bytes32)",
     "execute(bytes32,uint256,uint8,bytes,uint256,uint64,uint256,uint256,bytes32,bytes32)", "terminateBySession(bytes32,uint64,uint256,uint256,bytes32,bytes32)"]);
});
