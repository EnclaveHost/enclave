// client-browser-migration-r1 harness server. UNREVIEWED, NOT RUN by its author. TEST ONLY.
//   node client-browser-migration-r1/harness/server.mjs [port=0] [maxSeconds=600]
//
// ONE loopback origin per run, owned end to end by this process:
//   - an OWNED anvil (127.0.0.1, chain id 8453, osaka, --slots-in-an-epoch 1, NO code-size override, native P-256 at 0x100
//     and no shim), identity asserted BEFORE any state change (same checks as client-repair-r4 native-migration-ten);
//   - the root-reviewed ten-app rig deployed from native-host-r1's root-pinned staging (ORIGINAL SessionVaultFactory +
//     successor FundingSessionVaultFactory, ledger, book, catalog, PaymentRouter, reserve, adapter) and the labelled mocks
//     (MockUSDC3009Fiat, SessionRegistryStub, MockKeyAttestations, DEX mocks, MockQuoterV2, fixed TEST fee policy);
//   - the activation-r1 composed host (createSessionsService: ONE TxQueue, ONE wallet for the public Anvil relayer key)
//     answering /v1/sessions/* on this origin;
//   - the page (index.html) and its root-pinned bundle (dist/harness.js) built from page/harness.mjs, which runs the
//     UNCHANGED client-repair-r4 modules in the browser on REAL IndexedDB with non-extractable WebCrypto keys.
// Fixed test-only routes (no other path exists; no URL is ever taken from the browser):
//   GET  /test/fixture/config        public fixture identities (addresses, TEST pins, deployments, TEST split)
//   GET  /test/fixture/status        counters: owner-signature prompts, relay route hits, dropped replies
//   GET  /test/fixture/gas-session/<sid>   read-only successor sessionOf (anyApp, apps, balance6, live)
//   POST /test/fixture/tick          evm_mine ONE empty block on the owned anvil (keeps the pinned block fresh)
//   POST /test/owner-sign            EIP-712 signature by the PUBLIC Anvil owner key, ONLY for chain 8453 and the
//                                    owned fixture's vault / successor vault / mock USDC domains and allowlisted types
//   POST /test/verify-api            the composed host's real verifyApiRequest on ONE fixed probe URL (api.status)
//   POST /test/record-dbs            logs the page's random TEST database names (recorded, never opened here)
//   POST /rpc                        JSON-RPC to the OWNED anvil, read-only allowlisted methods, single requests only
// Fault injected (deterministic, labelled): the REPLY of the FIRST POST /v1/sessions/funding/open is lost after the real
// service handled it (the open lands; the browser sees a dropped connection) - the interrupted step.
// Shutdown (SIGINT/SIGTERM/maxSeconds/fatal error): close the server, stop ONLY the anvil this process spawned, remove
// its temp dir. Nothing else is touched. No Base, no public RPC, no production key, URL or database.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");         // client-browser-migration-r1
const UF = path.resolve(HERE, "..");                                                        // unified-funding-20261028
const NH = path.join(UF, "native-host-r1");
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const fail = (m) => { throw new Error(m); };

// ---- hash gates: root-pinned staging, activation pins, r4 native inputs (root-filled), this harness's own inputs --------
const STAGING = JSON.parse(fs.readFileSync(path.join(NH, "generated", "FIXTURE-STAGING.json"), "utf8"));
for (const [rel, want] of Object.entries({ ...STAGING.relay, ...STAGING.client })) {
  if (sha(path.join(UF, rel)) !== want) fail(`${rel} changed since native-host-r1 staged it`);
}
const activationPins = JSON.parse(fs.readFileSync(path.join(UF, "activation-r1", "generated", "PREPARE-MANIFEST.json"), "utf8")).outputs;
for (const [f, h] of Object.entries(activationPins)) if (sha(path.join(UF, "activation-r1", f)) !== h) fail(`activation input drift: ${f}`);
const R4_INPUTS = JSON.parse(fs.readFileSync(path.join(UF, "client-repair-r4", "generated", "NATIVE-INPUTS.json"), "utf8"));
const OWN_INPUTS = JSON.parse(fs.readFileSync(path.join(HERE, "generated", "HARNESS-INPUTS.json"), "utf8"));
for (const [rel, want] of Object.entries({ ...R4_INPUTS.files, ...OWN_INPUTS.files })) {
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) fail(`${rel}: no root-filled sha256 (refusing)`);
  if (sha(path.join(UF, rel)) !== want) fail(`${rel} differs from its root-filled sha256`);
}
const PAGE = fs.readFileSync(path.join(HERE, "page", "index.html"));
const BUNDLE = fs.readFileSync(path.join(HERE, "page", "dist", "harness.js"));   // hash-gated above via HARNESS-INPUTS

// ---- modules by explicit staged path ------------------------------------------------------------------------------------
const imp = (p) => import(url.pathToFileURL(p).href);
const VIEM = path.join(STAGING.viem.test, "viem", "_esm");
const { createPublicClient, createWalletClient, defineChain, encodeDeployData, getAddress, http: viemHttp, keccak256, toHex } =
  await imp(path.join(VIEM, "index.js"));
const { privateKeyToAccount } = await imp(path.join(VIEM, "accounts", "index.js"));
const REL = path.join(UF, "activation-r1", "generated", "relay");
const { createSessionsService } = await imp(path.join(REL, "sessions.mjs"));
const { QUOTE_POLICY_INTERFACE, makeEnvelope, queueGasFor } = await imp(path.join(REL, "fee-policy.mjs"));
const MOCK_ARTIFACT = "client-native-r1/fixture/out/MockUSDC3009Fiat.sol/MockUSDC3009Fiat.json";
const LEGACY_VAULT_ARTIFACT = "session-r1/out/SessionVault.sol/SessionVault.json";

// ---- the PUBLIC Anvil dev keys (default mnemonic accounts 0, 1, 2) - never anything else ---------------------------------
const KEYS = {
  deployer: ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
  owner: ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  relayer: ["0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
};
const TREASURY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const PAYOUT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const REGISTRY = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const ZERO = "0x0000000000000000000000000000000000000000";
const P256 = "0x0000000000000000000000000000000000000100";
const TIER = 500;
const PRICE6 = 2_400_000_000n;
const ETH_OUT = 20_000_000_000_000n;
const FEE = 25_000n;                       // TEST policy fixed fee
const GAS_LIMIT = 3_000_000n;
const FEE_CAP = 1_000_000_000n;
const TIP_CAP = 2_000_000n;
const ANVIL_ARGS = (port) => ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "osaka",
  "--base-fee", "5000000", "--slots-in-an-epoch", "1", "--silent"];
const API_PROBE = { url: "http://127.0.0.1:9/v1/client-browser-migration-r1/api-probe", hostPath: "127.0.0.1:9/v1/client-browser-migration-r1/api-probe" };
const RPC_ALLOW = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call",
  "eth_getCode", "eth_getLogs"]);
const SIGN_TYPES = new Set(["SessionGrant", "ReceiveWithAuthorization", "Terminate", "Withdraw"]);
const MAX_PROMPTS = 12;                    // bound: 2 original + 7 migration + headroom; never unbounded
const MAX_TICKS = 50;
const MAX_BODY = 64 * 1024;

const rep = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);
const dec = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const key32 = (s) => toHex(s, { size: 32 });

// ---- helpers copied from client-repair-r4/test/native-migration-ten.test.mjs (root-run), unchanged in behaviour -------
function freePort() {
  return new Promise((ok, no) => { const s = net.createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}
function fileStore(file, init) {
  const s = {
    file, data: structuredClone(init), flushes: 0,
    flush() {
      const tmp = `${file}.tmp`;
      const fd = fs.openSync(tmp, "w");
      fs.writeSync(fd, JSON.stringify(s.data, rep));
      fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, file); s.flushes++;
    },
    saveSoon() { s.flush(); },
  };
  return s;
}
function loadArtifact(id, rel, want) {
  const p = path.join(UF, rel);
  if (sha(p) !== want) fail(`${rel} changed since it was pinned`);
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  return { id, abi: a.abi, bytecode: a.bytecode.object, links: a.bytecode.linkReferences || {} };
}
function link(bytecode, refs, libs) {
  let hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  for (const [file, names] of Object.entries(refs)) for (const [name, spots] of Object.entries(names)) {
    const a = libs[`${file}:${name}`];
    if (!a) fail(`library ${file}:${name} is not deployed`);
    for (const { start, length } of spots) {
      if (length !== 20) fail("bad link length");
      hex = hex.slice(0, start * 2) + a.slice(2).toLowerCase() + hex.slice((start + length) * 2);
    }
  }
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) fail("bytecode still carries unlinked placeholders");
  return `0x${hex}`;
}
async function rawRpc(rpc, method, params = []) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}
async function startAnvil() {
  const port = await freePort();
  const args = ANVIL_ARGS(port);
  if (args.some((a) => /code-size|disable-code-size/.test(a))) fail("no code-size override");
  const proc = spawn("/home/steven/.foundry/bin/anvil", args, { stdio: "ignore" });
  let spawnError = null;
  proc.on("error", (e) => { spawnError = e; });
  const rpc = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
    await exited; clearTimeout(timer);
  };
  try {
    for (let i = 0; ; i++) {
      if (spawnError) fail(`anvil could not start: ${spawnError.message}`);
      try { await rawRpc(rpc, "eth_chainId"); break; } catch (e) {
        if (i > 150) fail(`anvil did not answer on ${rpc}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (new URL(rpc).hostname !== "127.0.0.1") fail("the RPC must be a loopback literal");
    if (!/^anvil\//i.test(String(await rawRpc(rpc, "web3_clientVersion")))) fail("not anvil");
    if (await rawRpc(rpc, "eth_chainId") !== "0x2105") fail("chain id must be 8453");
    const accounts = (await rawRpc(rpc, "eth_accounts")).map((a) => getAddress(a));
    for (const [k, [pk, addr]] of Object.entries(KEYS)) {
      if (privateKeyToAccount(pk).address !== addr) fail(`${k} key is not the public Anvil key`);
      if (!accounts.includes(addr)) fail(`${k} ${addr} is not an Anvil dev account here`);
    }
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const msg = Buffer.from("client-browser-migration-r1 p256 probe");
    const sig = cryptoSign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
    const jw = publicKey.export({ format: "jwk" });
    const probe = `0x${Buffer.concat([createHash("sha256").update(msg).digest(), sig, Buffer.from(jw.x, "base64url"), Buffer.from(jw.y, "base64url")]).toString("hex")}`;
    const bad = probe.slice(0, 130) + (probe.slice(130, 132) === "00" ? "01" : "00") + probe.slice(132);
    const one = (d) => typeof d === "string" && /^0x0*1$/.test(d);
    if (!one(await rawRpc(rpc, "eth_call", [{ to: P256, data: probe }, "latest"]))) fail("no native P-256 precompile (needs osaka)");
    if (one(await rawRpc(rpc, "eth_call", [{ to: P256, data: bad }, "latest"]).catch(() => "0x"))) fail("0x100 accepted a tampered signature");
    if (await rawRpc(rpc, "eth_getCode", [P256, "latest"]) !== "0x") fail("code is etched at 0x100 (a shim)");
  } catch (e) { await stop(); throw e; }
  return { rpc, stop };
}

// =====================================================================================================================
// lifecycle: everything this process owns is registered here and torn down exactly once
// =====================================================================================================================
const owned = { anvil: null, server: null, dataDir: null, timer: null, stopping: false };
async function shutdown(code, why) {
  if (owned.stopping) return;
  owned.stopping = true;
  console.log(`harness: stopping (${why})`);
  if (owned.timer) clearTimeout(owned.timer);
  try { if (owned.server) { owned.server.closeAllConnections?.(); await new Promise((ok) => owned.server.close(ok)); } } catch { /* already closed */ }
  try { if (owned.anvil) await owned.anvil.stop(); } catch (e) { console.error(`harness: anvil stop: ${e.message}`); }
  try { if (owned.dataDir) fs.rmSync(owned.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0, "SIGINT"));
process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
process.on("uncaughtException", (e) => { console.error(e); shutdown(1, "uncaught exception"); });
process.on("unhandledRejection", (e) => { console.error(e); shutdown(1, "unhandled rejection"); });

const port = Number(process.argv[2] ?? 0);
const maxSeconds = Number(process.argv[3] ?? 600);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail("bad port");
if (!Number.isInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 1800) fail("maxSeconds must be 30..1800");

// =====================================================================================================================
// the owned chain + the ten-app rig (deploy order of native-host-r1 / native-migration-ten)
// =====================================================================================================================
owned.anvil = await startAnvil();
owned.timer = setTimeout(() => shutdown(0, `maxSeconds ${maxSeconds} reached`), maxSeconds * 1000);
const rpc = owned.anvil.rpc;
const chain8453 = defineChain({ id: 8453, name: "owned anvil (chain id 8453; NOT Base)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } } });
const pc = createPublicClient({ chain: chain8453, transport: viemHttp(rpc) });
const wallet = (k) => createWalletClient({ chain: chain8453, account: privateKeyToAccount(KEYS[k][0]), transport: viemHttp(rpc) });
const dep = wallet("deployer"), ownerW = wallet("owner");
const owner = ownerW.account.address;

const A = {};
for (const [id, e] of Object.entries(STAGING.artifacts)) A[id] = loadArtifact(id, e.path, e.sha256);
A.fiatUsdc = loadArtifact("fiatUsdc", MOCK_ARTIFACT, R4_INPUTS.files[MOCK_ARTIFACT]);
A.legacyVault = loadArtifact("legacyVault", LEGACY_VAULT_ARTIFACT, R4_INPUTS.files[LEGACY_VAULT_ARTIFACT]);
const libs = {};
const deployTx = {};
async function mined(hash, what) {
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") fail(`${what} failed (${hash})`);
  return rc;
}
async function deployLibs(refs) {
  for (const [file, names] of Object.entries(refs)) for (const name of Object.keys(names)) {
    const k = `${file}:${name}`;
    if (libs[k]) continue;
    const lib = A[STAGING.links[k]];
    if (!lib) fail(`library ${k} is not staged`);
    await deployLibs(lib.links);
    const rc = await mined(await dep.sendTransaction({ data: link(lib.bytecode, lib.links, libs) }), `deploy ${k}`);
    libs[k] = getAddress(rc.contractAddress);
  }
}
async function deploy(id, args = []) {
  const a = A[id];
  await deployLibs(a.links);
  const rc = await mined(await dep.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode: link(a.bytecode, a.links, libs), args }) }), `deploy ${id}`);
  deployTx[id] = rc.transactionHash;
  return getAddress(rc.contractAddress);
}
const rd = (address, id, functionName, args = []) => pc.readContract({ address, abi: A[id].abi, functionName, args });
async function write(address, id, functionName, args = [], who = dep, value) {
  const { request, result } = await pc.simulateContract({ address, abi: A[id].abi, functionName, args, account: who.account, ...(value ? { value } : {}) });
  await mined(await who.writeContract(request), `${id}.${functionName}`);
  return result;
}
const usdc = await deploy("fiatUsdc");
const book = await deploy("book");
const reg = await deploy("registryStub");
const ka = await deploy("keyAttestations");
const ledger = await deploy("ledger", [usdc, PAYOUT, reg, ZERO]);
await write(ledger, "ledger", "setProofRequiredFrom", [0n]);
const catalog = await deploy("catalog");
const payRouter = await deploy("paymentRouter", [usdc, TREASURY]);
await write(book, "book", "set", [key32("deployments"), ledger]);
await write(book, "book", "set", [key32("appCatalog"), catalog]);
const legacyFactory = await deploy("legacyFactory", [usdc, book, payRouter, ka, 1_000_000_000n]);
await write(book, "book", "set", [key32("sessionVaultFactory"), legacyFactory]);
const reserve = await deploy("reserve", [ledger, REGISTRY, ZERO, { maxGasPriceCeiling: 1_000_000_000n, overheadClaimGas: 0n,
  overheadRenewGas: 0n, overheadReleaseGas: 0n, minClaimInterval: 0n, l1Bps: 0n }]);
const weth = await deploy("weth");
const v3 = await deploy("dexFactory");
const swapRouter = await deploy("swapRouter", [v3, weth]);
await write(v3, "dexFactory", "setRouter", [swapRouter]);
const pools = {};
for (const fee of [100, 500, 3000]) {
  pools[fee] = getAddress(await write(v3, "dexFactory", "createPool", [usdc, weth, fee]));
  await write(swapRouter, "swapRouter", "setPrice", [fee, PRICE6]);
  await write(weth, "weth", "deposit", [], dep, 20n * 10n ** 18n);
  await write(weth, "weth", "transfer", [pools[fee], 20n * 10n ** 18n]);
  await write(usdc, "fiatUsdc", "mint", [pools[fee], 1_000_000_000_000n]);
}
const adapter = await deploy("adapter", [usdc, weth, swapRouter, v3, ledger, reserve, 50_000_000_000_000_000n]);
const factory = await deploy("factory", [usdc, book, payRouter, ka, 1_000_000_000n, adapter, legacyFactory]);
const quoter = await deploy("quoter", [swapRouter, usdc]);
await write(usdc, "fiatUsdc", "mint", [owner, 1_000_000_000n]);                 // mock funds only
const implementation = getAddress(await rd(factory, "factory", "implementation"));
const legacyImplementation = getAddress(await rd(legacyFactory, "legacyFactory", "implementation"));
const vault = getAddress(await rd(factory, "factory", "vaultFor", [owner]));
const legacyVault = getAddress(await rd(legacyFactory, "legacyFactory", "vaultFor", [owner]));
const fundingGasLib = libs["src/FundingGasLib.sol:FundingGasLib"];
const fundingSessionVaultLib = libs["src/FundingSessionVault.sol:FundingSessionVaultLib"];

// ten wallet-held deployments of ten DISTINCT test catalog apps (8 "nucbox" + 2 "metal"), exactly root's ten-app fixture
const APPS = Array.from({ length: 10 }, (_, i) => keccak256(toHex(`client-native-r1 TEST app ${i}`)).toLowerCase());
const METAL = [APPS[0], APPS[9]].sort();
const NUC = APPS.slice(1, 9).sort();
const deployments = [];
for (const app of APPS) {
  const id = String(await write(ledger, "ledger", "create", [`catalog://${app}/1`, 0n, 1000n, 8080n, "", false, "", ZERO, 0n, 1000n], ownerW)).toLowerCase();
  deployments.push({ app, id });
}

// activation manifest + TEST policy + the ACTUAL host
const addresses = { factory, implementation, fundingGasLib, fundingSessionVaultLib, adapter, legacyFactory, legacyImplementation,
  usdc, weth, book, ledger, reserve, swapRouter, dexFactory: v3, quoter };
const ch = async (a) => keccak256(await pc.getCode({ address: a }));
const codehashes = {};
for (const [k, a] of Object.entries(addresses)) codehashes[k] = await ch(a);
const unix = () => Math.floor(Date.now() / 1000);
const manifest = { schema: "enclave-funding-activation-r1", chainId: 8453, notAfter: unix() + maxSeconds + 600, maxBlockAgeSec: 600, addresses,
  codehashes, pools: { [TIER]: { address: pools[TIER], codehash: await ch(pools[TIER]) } }, feeTiers: [TIER], maxSlippageBps: 100, deadlineSec: 300 };
const TEST_POLICY = Object.freeze({
  interface: QUOTE_POLICY_INTERFACE,
  async quote(ctx) { if (ctx.envelopeEnforced !== true) fail("envelope not enforced"); return { fee6: FEE, detail: { note: "TEST policy (client-browser-migration-r1): fixed fee, NOT the reviewed fee policy" } }; },
  async fee() { return FEE; },
  async accept(ctx) { return ctx.phase === "execute" && ctx.fee6 === FEE; },
  async envelope(ctx) {
    const block = BigInt(ctx.block);
    const blk = await pc.getBlock({ blockNumber: block });
    const estimate = await pc.estimateGas({ account: ctx.from, to: ctx.to, data: ctx.data, blockNumber: block });
    if (queueGasFor(estimate) > GAS_LIMIT) fail(`gas ${queueGasFor(estimate)} above the TEST cap ${GAS_LIMIT}`);
    return makeEnvelope({ chainId: 8453n, from: ctx.from.toLowerCase(), to: ctx.to.toLowerCase(), data: ctx.data, gasLimit: GAS_LIMIT,
      maxFeePerGasCap: FEE_CAP, maxPriorityFeePerGasCap: TIP_CAP, maxSignedBytes: 1000, maxAttempts: 3, replacementBumpBps: 2500n,
      notAfter: BigInt(ctx.deadline), fee6: ctx.fee6, costCeilingWei: GAS_LIMIT * FEE_CAP, estimateGas: estimate,
      configHash: `0x${"7e".repeat(32)}`, block, blockHash: blk.hash });
  },
});
owned.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-browser-migration-r1-"));
const store = fileStore(path.join(owned.dataDir, "sessions-index.json"), {});
const journal = fileStore(path.join(owned.dataDir, "sessions-relayer.json"), { txs: [] });
const relayerWc = wallet("relayer");
const logs = [];
const ownerControls = { schema: "enclave-funding-owner-controls-r1", chainId: 8453, maxBlockAgeSec: 600,
  addresses: Object.fromEntries(["factory", "implementation", "fundingGasLib", "fundingSessionVaultLib"].map((k) => [k, addresses[k]])),
  codehashes: Object.fromEntries(["factory", "implementation", "fundingGasLib", "fundingSessionVaultLib"].map((k) => [k, codehashes[k]])) };
const svc = createSessionsService({ pc, wc: relayerWc, account: relayerWc.account, chainId: 8453, factory: legacyFactory, book, usdc,
  router: payRouter, store, journal, log: (...a) => logs.push(a.join(" ")), alert: () => {}, funding: manifest,
  fundingQuotePolicy: TEST_POLICY, fundingOwnerControls: ownerControls });
if (!logs.some((l) => l.startsWith("funding: intake on"))) fail(`funding stayed off: ${logs.join(" | ")}`);

// ---- public fixture description served to the page (identities and TEST terms only; no key, no secret) ---------------
const pins = { schema: "enclave-funding-browser-runtime-r1", chainId: 8453, factory, implementation, gasAdapter: adapter, legacyFactory, usdc,
  feeTiers: [TIER], codehashes: { factory: codehashes.factory, implementation: codehashes.implementation, gasAdapter: codehashes.adapter },
  source: { kind: "deployed-receipts", deployTxs: [deployTx.factory, deployTx.adapter], reviewedBy: "client-browser-migration-r1 TEST fixture (owned Anvil)" } };
const fixture = Object.freeze({
  note: "TEST FIXTURE: owned loopback anvil (chain id 8453, NOT Base), public Anvil keys, mock USDC, fixed TEST fee policy",
  chainId: 8453, owner, legacyFactory, legacyVault, factory, implementation, vault, adapter, usdc, book, pins,
  deployments, partition: { nucbox: NUC, metal: METAL },
  split: { legacy6: "29000000", nucbox6: "800000", nucboxOps: "16", metal6: "200000", metalOps: "4" },
  ethOut: ETH_OUT.toString(), feeTier: TIER, apiProbeUrl: API_PROBE.url,
});

// =====================================================================================================================
// HTTP: one loopback origin, exact routes
// =====================================================================================================================
const counters = { prompts: [], hits: {}, dropped: [], ticks: 0, dbs: [] };
let dropFirstFundingOpen = true;
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'none'; style-src 'none'; frame-src 'none'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = { "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin" };
const allowedVerifying = new Map([
  [legacyVault, { name: "Enclave Sessions", version: "1", types: new Set(["SessionGrant", "Terminate"]) }],
  [vault, { name: "Enclave Sessions", version: "2", types: new Set(["SessionGrant", "Terminate", "Withdraw"]) }],
  [usdc, { name: "USD Coin", version: "2", types: new Set(["ReceiveWithAuthorization"]) }],
]);

function send(res, status, obj, type = "application/json") {
  res.writeHead(status, { ...HEADERS, "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(obj, dec) : obj);
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { bad(new Error("body too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", bad);
  });
}

/** TEST-ONLY public-fixture signer. Refuses anything that is not the owned fixture's chain-8453 domain + allowlisted type. */
async function ownerSign(body) {
  if (counters.prompts.length >= MAX_PROMPTS) fail("prompt budget exhausted");
  if (getAddress(body.address) !== owner) fail("only the fixture owner signs here");
  const td = JSON.parse(String(body.payload));
  const { EIP712Domain, ...types } = td.types ?? {};
  if (!SIGN_TYPES.has(td.primaryType) || Object.keys(types).length !== 1 || !Array.isArray(types[td.primaryType])) fail("type not allowed");
  if (Number(td.domain?.chainId) !== 8453) fail("chain id must be 8453");
  const vc = getAddress(td.domain.verifyingContract);
  const allowed = allowedVerifying.get(vc);
  if (!allowed || td.domain.name !== allowed.name || String(td.domain.version) !== allowed.version || !allowed.types.has(td.primaryType)) {
    fail(`domain ${vc}/${td.domain.name}/${td.domain.version}/${td.primaryType} is not the owned fixture's`);
  }
  if (await rawRpc(rpc, "eth_chainId") !== "0x2105") fail("owned chain identity changed");
  const message = { ...td.message };
  for (const f of types[td.primaryType]) if (f.type.startsWith("uint")) message[f.name] = BigInt(message[f.name]);
  const sig = await ownerW.account.signTypedData({ domain: { ...td.domain, chainId: 8453 }, types, primaryType: td.primaryType, message });
  counters.prompts.push({ primaryType: td.primaryType, verifyingContract: vc });
  console.log(`harness: TEST owner signature #${counters.prompts.length} ${td.primaryType} @ ${vc}`);
  return { sig };
}

async function route(req, res, u) {
  const p = u.pathname;
  if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (req.method === "GET" && p === "/dist/harness.js") return send(res, 200, BUNDLE, "text/javascript; charset=utf-8");
  if (req.method === "GET" && p === "/test/fixture/config") return send(res, 200, fixture);
  if (req.method === "GET" && p === "/test/fixture/status") return send(res, 200, counters);
  let m;
  if (req.method === "GET" && (m = /^\/test\/fixture\/gas-session\/(0x[0-9a-f]{64})$/.exec(p))) {
    const [s, live, apps] = await rd(vault, "implementation", "sessionOf", [m[1]]);
    return send(res, 200, { live, anyApp: s.anyApp, balance6: s.balance6, apps: apps.map((a) => a.toLowerCase()) });
  }
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (!/^application\/json\b/.test(String(req.headers["content-type"] ?? ""))) return send(res, 415, { error: "json only" });
  const text = await readBody(req);
  const body = text ? JSON.parse(text) : {};
  if (p === "/rpc") {
    if (Array.isArray(body) || body?.jsonrpc !== "2.0" || !RPC_ALLOW.has(body.method) || !Array.isArray(body.params ?? [])) {
      return send(res, 403, { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "method not allowed by the harness" } });
    }
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: body.id, method: body.method, params: body.params ?? [] }) });
    return send(res, 200, await r.json());
  }
  if (p === "/test/fixture/tick") {
    if (++counters.ticks > MAX_TICKS) return send(res, 429, { error: "tick budget exhausted" });
    await rawRpc(rpc, "evm_mine");
    return send(res, 200, { block: await rawRpc(rpc, "eth_blockNumber") });
  }
  if (p === "/test/owner-sign") {
    try { return send(res, 200, await ownerSign(body)); } catch (e) { return send(res, 403, { error: e.message }); }
  }
  if (p === "/test/verify-api") {
    if (typeof body.header !== "string" || body.header.length > 2048) return send(res, 400, { error: "header" });
    try {
      const v = await svc.verifyApiRequest({ header: body.header, method: "GET", hostPath: API_PROBE.hostPath, scope: "api.status", fresh: true });
      return send(res, 200, { sid: String(v.sid).toLowerCase(), vault: v.vault, anyApp: v.anyApp });
    } catch (e) { return send(res, e?.status ?? 401, { code: e?.code ?? "refused", error: e?.message ?? String(e) }); }
  }
  if (p === "/test/record-dbs") {
    const names = Array.isArray(body.names) ? body.names : [];
    if (names.length !== 2 || names.some((n) => typeof n !== "string" || !/^client-browser-migration-r1-TEST-(legacy|v2)-[0-9a-f]{16}$/.test(n))) {
      return send(res, 400, { error: "names" });
    }
    counters.dbs.push(...names);
    console.log(`harness: page TEST databases: ${names.join(", ")}`);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "not found" });
}

owned.server = http.createServer((req, res) => {
  const here = `127.0.0.1:${owned.server.address().port}`;
  if (req.headers.host !== here) { res.writeHead(421, HEADERS); return res.end("wrong host"); }
  const u = new URL(req.url, `http://${here}`);
  if (u.pathname.startsWith("/v1/sessions/")) {
    const k = `${req.method} ${u.pathname}`;
    counters.hits[k] = (counters.hits[k] ?? 0) + 1;
    if (k === "POST /v1/sessions/funding/open" && dropFirstFundingOpen) {
      dropFirstFundingOpen = false;      // REAL request, REAL processing; only this one reply is lost
      // Root: drop AFTER response headers/body start. Chromium may transparently retry a socket
      // closed before any response, which made the author's raw disconnect test non-deterministic.
      const begin = res.writeHead.bind(res), part = res.write.bind(res);
      res.writeHead = () => res; res.setHeader = () => res; res.write = () => true;
      res.end = () => {
        counters.dropped.push(k);
        begin(200, { ...HEADERS, "content-type": "application/json", "content-length": "1024" });
        res.flushHeaders(); part('{"interrupted":');
        setTimeout(() => req.socket.destroy(), 100);
        return res;
      };
    }
    return svc.handle(req, res, u, {}).catch((e) => { try { res.writeHead(500, HEADERS); res.end(JSON.stringify({ error: String(e) })); } catch { /* dropped */ } });
  }
  route(req, res, u).catch((e) => { try { send(res, 500, { error: e.message }); } catch { /* closed */ } });
});
await new Promise((ok) => owned.server.listen(port, "127.0.0.1", ok));
if (owned.server.address().address !== "127.0.0.1") await shutdown(1, "not bound to loopback");
console.log(`harness: TEST ONLY http://127.0.0.1:${owned.server.address().port}/  (owned anvil ${rpc}; stops after ${maxSeconds}s or Ctrl-C)`);
