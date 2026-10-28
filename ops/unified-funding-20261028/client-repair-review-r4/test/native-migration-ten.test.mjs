// ROOT VARIANT: TEST-only wildcard/ten-app fixture derived from the empty/nine-app author fixture below.
// All terms, keys, apps and funds are local test fixtures; no production approval or grant reconstruction.
// client-repair-r4: ONE bounded native MIGRATION flow (successor of client-native-r1/test/migration-native.test.mjs,
// whose first root run FAILED at compareGrantToChain: the real original vault stored apps = [] as anyApp = false and r3
// required true). UNREVIEWED, NOT RUN by its author.
//   (the one labelled mock is already built in client-native-r1/fixture/out by root; nothing is rebuilt here)
//   root fills client-repair-r4/generated/NATIVE-INPUTS.json, then:   node client-repair-r4/test/native-migration.test.mjs
//
// Differences from client-native-r1 (everything else is the same flow and the same assertions):
//   - consumes the client-repair-r4 modules (exact legacy app-scope semantics; relayClient normalises the relay wire);
//   - uses the DEFAULT FC.relayClient(origin) (globalThis.fetch, no wireFetch wrapper), exactly as the site page does;
//   - asserts the ACTUAL scope facts: the original apps = [] session reads back anyApp = false with no ids, and the
//     replacement reproduces exactly that (never a wildcard).
// Real: an OWNED anvil (127.0.0.1 only, chain id 8453, --hardfork osaka, NO code-size override, native P-256 at 0x100 with
// no shim), the root-pinned native-host-r1 staging (ORIGINAL SessionVaultFactory + successor FundingSessionVaultFactory,
// libraries, ledger, book, catalog, PaymentRouter, reserve, adapter), the activation-r1 composed host
// (createSessionsService: ONE real TxQueue, ONE viem wallet for the public Anvil relayer key) served over loopback HTTP,
// the client-repair-r4 modules, the vendored v1 SDK bundle (original grant, legacy key, SDK RelayClient, SDK API
// authorization), WebCrypto non-extractable P-256 session keys, real owner ECDSA signatures by the PUBLIC Anvil owner key,
// real receipts/logs from the node.
// MOCKS (labelled): MockUSDC3009Fiat (client-native-r1/fixture: MockUSDC3009 + FiatTokenV2's AuthorizationUsed event),
// SessionRegistryStub, MockKeyAttestations, MockWETH9, MockV3Factory + pools, MockSwapRouter02, MockQuoterV2, and the
// FIXED-FEE TEST quote policy (NOT the reviewed fee policy). The 29 / 0.9 / 0.1 split and its app partition are TEST
// terms; the termsHash "approval" below is a TEST approval, never a production one. Nothing touches Base or a public RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import net from "node:net";
import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");          // client-repair-r4
const UF = path.resolve(HERE, "..");                                                         // unified-funding-20261028
const NH = path.join(UF, "native-host-r1");
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ---- inputs: native-host-r1's root-pinned staging, activation pins, and this fixture's root-filled hashes -------------
const STAGING = JSON.parse(fs.readFileSync(path.join(NH, "generated", "FIXTURE-STAGING.json"), "utf8"));
for (const [rel, want] of Object.entries({ ...STAGING.relay, ...STAGING.client })) {
  assert.equal(sha(path.join(UF, rel)), want, `${rel} changed since native-host-r1 staged it`);
}
const activationPins = JSON.parse(fs.readFileSync(path.join(UF, "activation-r1", "generated", "PREPARE-MANIFEST.json"), "utf8")).outputs;
for (const [f, h] of Object.entries(activationPins)) assert.equal(sha(path.join(UF, "activation-r1", f)), h, `activation input drift: ${f}`);
const INPUTS = JSON.parse(fs.readFileSync(path.join(HERE, "generated", "NATIVE-INPUTS.json"), "utf8"));
for (const [rel, want] of Object.entries(INPUTS.files)) {
  assert.ok(typeof want === "string" && /^[0-9a-f]{64}$/.test(want), `${rel}: no root-filled sha256 in NATIVE-INPUTS.json (refusing)`);
  assert.equal(sha(path.join(UF, rel)), want, `${rel} differs from its root-filled sha256`);
}

// ---- modules, by explicit staged path (no package resolution for this file) -------------------------------------------
const imp = (p) => import(url.pathToFileURL(p).href);
const VIEM = path.join(STAGING.viem.test, "viem", "_esm");
const { createPublicClient, createWalletClient, defineChain, encodeDeployData, getAddress, http: viemHttp, keccak256,
  toEventSelector, toHex } = await imp(path.join(VIEM, "index.js"));
const { privateKeyToAccount } = await imp(path.join(VIEM, "accounts", "index.js"));
const REL = path.join(UF, "activation-r1", "generated", "relay");
const { createSessionsService } = await imp(path.join(REL, "sessions.mjs"));
const { QUOTE_POLICY_INTERFACE, makeEnvelope, queueGasFor } = await imp(path.join(REL, "fee-policy.mjs"));
const codec = await imp(path.join(UF, "client-r1", "funding-codec.mjs"));
const R4 = path.join(UF, "client-repair-r4", "lib");
const FC = await imp(path.join(R4, "funding-client.mjs"));
const MIG = await imp(path.join(R4, "migration.mjs"));
const CP = await imp(path.join(R4, "chain-proof.mjs"));
const U = await imp(path.join(R4, "util.mjs"));
const V2 = await imp(path.join(R4, "v2-store.mjs"));
const S = await imp(path.join(UF, "..", "source", "sdk", "sessions", "dist", "browser.mjs"));
const MOCK_ARTIFACT = "client-native-r1/fixture/out/MockUSDC3009Fiat.sol/MockUSDC3009Fiat.json";

// the PUBLIC Anvil dev keys (default mnemonic accounts 0, 1, 2) - never anything else
const KEYS = {
  deployer: ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
  owner: ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  relayer: ["0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
};
const TREASURY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";   // public Anvil account 3 (address only)
const PAYOUT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";     // public Anvil account 4 (address only)
const REGISTRY = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";   // public Anvil account 5 (address only)
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"0".repeat(64)}`;
const P256 = "0x0000000000000000000000000000000000000100";
const TIER = 500;
const PRICE6 = 2_400_000_000n;            // the rig's $2400 mock price
const ETH_OUT = 20_000_000_000_000n;      // = the candidate grant's maxEthPerOp (0.00002 ETH): ~0.048 USDC at the mock price
const FEE = 25_000n;                      // TEST policy fixed fee (0.025 USDC)
const GAS_LIMIT = 3_000_000n;
const FEE_CAP = 1_000_000_000n;
const TIP_CAP = 2_000_000n;
const OLD_BUDGET = 30_000_000n;
const ANVIL_ARGS = (port) => ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "osaka",
  "--base-fee", "5000000", "--slots-in-an-epoch", "1", "--silent"];
const OLD_ACTIONS = ["deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig", "deploy.setShares",
  "deploy.setMaxRate", "deploy.setActive", "deploy.refund", "api.status", "api.logs", "api.restart", "api.upload",
  "api.appAccess", "api.placement", "api.account"];
// client-repair-r4 funding-client.mjs LEDGER_ROW (private there): must equal the deployed ledger's get() tuple
const LEDGER_LAYOUT = ["bytes32 id", "address owner", "string appRef", "string ports", "string configCid", "uint16 gpuMilli",
  "uint16 cpuMilli", "uint32 appPort", "bool isPublic", "bool active", "uint64 createdAt", "uint256 rate", "uint256 balance6",
  "uint256 spent6", "bytes32 runner", "address runnerOperator", "uint64 leaseUntil"];

const B = (v) => BigInt(String(v).replace(/n$/, ""));
const j = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const rep = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);
const key32 = (s) => toHex(s, { size: 32 });
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const code = (c) => (e) => e?.code === c;
const status401 = (e) => [e?.status, e?.statusCode, e?.httpStatus].includes(401);

// ---- helpers copied from native-host-r1/test/activation-native.test.mjs (root-run r6), unchanged in behaviour ---------
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
const diskData = (file) => JSON.parse(fs.readFileSync(file, "utf8"), (_k, v) =>
  typeof v === "string" && /^-?[0-9]+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
function loadArtifact(id, rel, want) {
  const p = path.join(UF, rel);
  assert.equal(sha(p), want, `${rel} changed since it was pinned`);
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  return { id, abi: a.abi, bytecode: a.bytecode.object, links: a.bytecode.linkReferences || {} };
}
function link(bytecode, refs, libs) {
  let hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  for (const [file, names] of Object.entries(refs)) for (const [name, spots] of Object.entries(names)) {
    const a = libs[`${file}:${name}`];
    if (!a) throw new Error(`library ${file}:${name} is not deployed`);
    for (const { start, length } of spots) {
      assert.equal(length, 20);
      hex = hex.slice(0, start * 2) + a.slice(2).toLowerCase() + hex.slice((start + length) * 2);
    }
  }
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new Error("bytecode still carries unlinked placeholders");
  return `0x${hex}`;
}
async function rawRpc(rpc, method, params = []) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}
/** Own Anvil; loopback + anvil + chain 8453 + public keys + NATIVE P-256 (no shim) asserted BEFORE any state change. */
async function startAnvil() {
  const port = await freePort();
  const args = ANVIL_ARGS(port);
  assert.ok(!args.some((a) => /code-size|disable-code-size/.test(a)), "no code-size override");
  const proc = spawn("/home/steven/.foundry/bin/anvil", args, { stdio: "ignore" });
  let spawnError = null;
  proc.on("error", (e) => { spawnError = e; });
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (spawnError) throw new Error(`anvil could not start: ${spawnError.message}`);
    try { await rawRpc(rpc, "eth_chainId"); break; } catch (e) {
      if (i > 150) { proc.kill("SIGKILL"); throw new Error(`anvil did not answer on ${rpc}: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
    await exited; clearTimeout(timer);
  };
  try {
    assert.equal(new URL(rpc).hostname, "127.0.0.1", "the RPC must be a loopback literal");
    assert.match(String(await rawRpc(rpc, "web3_clientVersion")), /^anvil\//i, "not anvil");
    assert.equal(await rawRpc(rpc, "eth_chainId"), "0x2105", "chain id must be 8453");
    const accounts = (await rawRpc(rpc, "eth_accounts")).map((a) => getAddress(a));
    for (const [k, [pk, addr]] of Object.entries(KEYS)) {
      assert.equal(privateKeyToAccount(pk).address, addr, `${k} key is not the public Anvil key`);
      assert.ok(accounts.includes(addr), `${k} ${addr} is not an Anvil dev account here`);
    }
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const msg = Buffer.from("client-repair-r4 p256 probe");
    const sig = cryptoSign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
    const jw = publicKey.export({ format: "jwk" });
    const probe = `0x${Buffer.concat([createHash("sha256").update(msg).digest(), sig, Buffer.from(jw.x, "base64url"), Buffer.from(jw.y, "base64url")]).toString("hex")}`;
    const bad = probe.slice(0, 130) + (probe.slice(130, 132) === "00" ? "01" : "00") + probe.slice(132);
    const one = (d) => typeof d === "string" && /^0x0*1$/.test(d);
    assert.ok(one(await rawRpc(rpc, "eth_call", [{ to: P256, data: probe }, "latest"])), "no native P-256 precompile (needs osaka)");
    assert.ok(!one(await rawRpc(rpc, "eth_call", [{ to: P256, data: bad }, "latest"]).catch(() => "0x")), "0x100 accepted a tampered signature");
    assert.equal(await rawRpc(rpc, "eth_getCode", [P256, "latest"]), "0x", "code is etched at 0x100 (a shim)");
  } catch (e) { await stop(); throw e; }
  return { rpc, stop };
}

/** EIP-1193 owner wallet: ONLY eth_signTypedData_v4, by the public Anvil owner key, every prompt counted. */
function ownerProvider(account) {
  const p = { prompts: [], async request({ method, params }) {
    assert.equal(method, "eth_signTypedData_v4", `the client asked the wallet for ${method}`);
    assert.equal(getAddress(params[0]), account.address);
    const td = JSON.parse(params[1]);
    p.prompts.push(td.primaryType);
    const { EIP712Domain, ...types } = td.types;
    const message = { ...td.message };
    for (const f of types[td.primaryType]) if (f.type.startsWith("uint")) message[f.name] = BigInt(message[f.name]);
    return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message });
  } };
  return p;
}

test("native migration (root r4 ten-app): original wildcard preserved; 29 legacy + 0.8 eight apps + 0.2 two apps; all ten funded", { timeout: 300_000 }, async (t) => {
  const { rpc, stop } = await startAnvil();
  t.after(stop);
  const chain8453 = defineChain({ id: 8453, name: "owned anvil (chain id 8453; NOT Base)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } } });
  const pc = createPublicClient({ chain: chain8453, transport: viemHttp(rpc) });
  const wallet = (k) => createWalletClient({ chain: chain8453, account: privateKeyToAccount(KEYS[k][0]), transport: viemHttp(rpc) });
  const dep = wallet("deployer"), ownerW = wallet("owner");
  const owner = ownerW.account.address, relayer = KEYS.relayer[1];

  // ---- artifacts: native-host-r1 staging + the two inputs pinned here -------------------------------------------------
  const A = {};
  for (const [id, e] of Object.entries(STAGING.artifacts)) A[id] = loadArtifact(id, e.path, e.sha256);
  A.fiatUsdc = loadArtifact("fiatUsdc", MOCK_ARTIFACT, INPUTS.files[MOCK_ARTIFACT]);
  A.legacyVault = loadArtifact("legacyVault", "session-r1/out/SessionVault.sol/SessionVault.json",
    INPUTS.files["session-r1/out/SessionVault.sol/SessionVault.json"]);

  // ---- assumption checks against the ACTUAL fixture (before any deployment) ------------------------------------------
  const evOf = (abi, name) => { const e = abi.filter((x) => x.type === "event" && x.name === name); assert.equal(e.length, 1, `one ${name} event`); return toEventSelector(e[0]); };
  for (const [abi, what] of [[A.legacyVault.abi, "original SessionVault"], [A.implementation.abi, "successor FundingSessionVault"]]) {
    assert.equal(evOf(abi, "SessionOpened"), evOf(CP.VAULT_EVENTS, "SessionOpened"), `${what} SessionOpened differs from chain-proof's`);
    assert.equal(evOf(abi, "SessionEnded"), evOf(CP.VAULT_EVENTS, "SessionEnded"), `${what} SessionEnded differs from chain-proof's`);
  }
  assert.equal(A.usdc.abi.filter((x) => x.type === "event" && x.name === "AuthorizationUsed").length, 0,
    "fact: the staged MockUSDC3009 emits NO AuthorizationUsed (the client's open proof would refuse it)");
  assert.equal(evOf(A.fiatUsdc.abi, "AuthorizationUsed"), evOf(CP.USDC_EVENTS, "AuthorizationUsed"));
  assert.equal(evOf(A.fiatUsdc.abi, "Transfer"), evOf(CP.USDC_EVENTS, "Transfer"));
  const outputs = (abi) => JSON.stringify(abi.find((f) => f.type === "function" && f.name === "sessionOf").outputs, ["name", "type", "components"]);
  assert.equal(outputs(S.sessionVaultAbi), outputs(A.legacyVault.abi), "the v1 SDK's sessionOf ABI differs from the deployed original vault");
  assert.deepEqual(A.ledger.abi.find((f) => f.type === "function" && f.name === "get").outputs[0].components.map((c) => `${c.type} ${c.name}`),
    LEDGER_LAYOUT, "client-repair-r4 freshRecoveryScope's ledger row layout differs from the deployed ledger");

  // ---- deploy (native-host-r1 order; USDC = the labelled MockUSDC3009Fiat) ------------------------------------------
  const libs = {};
  const deployTx = {};
  async function mined(hash, what) {
    const rc = await pc.waitForTransactionReceipt({ hash });
    assert.equal(rc.status, "success", `${what} failed (${hash})`);
    return rc;
  }
  async function deployLibs(refs) {
    for (const [file, names] of Object.entries(refs)) for (const name of Object.keys(names)) {
      const k = `${file}:${name}`;
      if (libs[k]) continue;
      const lib = A[STAGING.links[k]];
      if (!lib) throw new Error(`library ${k} is not staged`);
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
  await write(usdc, "fiatUsdc", "mint", [owner, 1_000_000_000n]);
  const implementation = getAddress(await rd(factory, "factory", "implementation"));
  const legacyImplementation = getAddress(await rd(legacyFactory, "legacyFactory", "implementation"));
  const vault = getAddress(await rd(factory, "factory", "vaultFor", [owner]));
  const legacyVault = getAddress(await rd(legacyFactory, "legacyFactory", "vaultFor", [owner]));
  const fundingGasLib = libs["src/FundingGasLib.sol:FundingGasLib"];
  const fundingSessionVaultLib = libs["src/FundingSessionVault.sol:FundingSessionVaultLib"];
  const usdcOf = async (a) => B(await rd(usdc, "fiatUsdc", "balanceOf", [a]));
  const legacySession = async (sid) => { const [s, live, apps] = await rd(legacyVault, "legacyVault", "sessionOf", [sid]); return { ...s, live, apps }; };
  const gasSession = async (sid) => { const [s, live] = await rd(vault, "implementation", "sessionOf", [sid]); return { ...s, live }; };

  // ---- ten wallet-held deployments of ten DISTINCT test catalog apps (8 NucBox + 2 Metal0, TEST ids) ------------
  const APPS = Array.from({ length: 10 }, (_, i) => keccak256(toHex(`client-native-r1 TEST app ${i}`)).toLowerCase());
  const IMAGE = APPS[0];
  const METAL = [APPS[0], APPS[9]].sort();
  const NUC = APPS.slice(1, 9).sort();
  const deps = [];
  for (const app of APPS) {
    const id = String(await write(ledger, "ledger", "create", [`catalog://${app}/1`, 0n, 1000n, 8080n, "", false, "", ZERO, 0n, 1000n], ownerW)).toLowerCase();
    deps.push({ app, id });
  }
  const holderOf = async (id) => getAddress((await rd(ledger, "ledger", "get", [id])).owner);
  for (const d of deps) assert.equal(await holderOf(d.id), owner);

  // ---- activation manifest + TEST policy + the ACTUAL host (native-host-r1 shape) ------------------------------------
  const addresses = { factory, implementation, fundingGasLib, fundingSessionVaultLib, adapter, legacyFactory, legacyImplementation,
    usdc, weth, book, ledger, reserve, swapRouter, dexFactory: v3, quoter };
  const ch = async (a) => keccak256(await pc.getCode({ address: a }));
  const codehashes = {};
  for (const [k, a] of Object.entries(addresses)) codehashes[k] = await ch(a);
  const unix = () => Math.floor(Date.now() / 1000);
  const manifest = { schema: "enclave-funding-activation-r1", chainId: 8453, notAfter: unix() + 3600, maxBlockAgeSec: 600, addresses, codehashes,
    pools: { [TIER]: { address: pools[TIER], codehash: await ch(pools[TIER]) } }, feeTiers: [TIER], maxSlippageBps: 100, deadlineSec: 300 };
  const TEST_POLICY = Object.freeze({
    interface: QUOTE_POLICY_INTERFACE,
    async quote(ctx) { assert.equal(ctx.envelopeEnforced, true); return { fee6: FEE, detail: { note: "TEST policy (client-repair-r4): fixed fee, NOT the reviewed fee policy" } }; },
    async fee() { return FEE; },
    async accept(ctx) { return ctx.phase === "execute" && ctx.fee6 === FEE; },
    async envelope(ctx) {
      const block = BigInt(ctx.block);
      const blk = await pc.getBlock({ blockNumber: block });
      const estimate = await pc.estimateGas({ account: ctx.from, to: ctx.to, data: ctx.data, blockNumber: block });
      if (queueGasFor(estimate) > GAS_LIMIT) throw new Error(`gas ${queueGasFor(estimate)} above the TEST cap ${GAS_LIMIT}`);
      return makeEnvelope({ chainId: 8453n, from: ctx.from.toLowerCase(), to: ctx.to.toLowerCase(), data: ctx.data, gasLimit: GAS_LIMIT,
        maxFeePerGasCap: FEE_CAP, maxPriorityFeePerGasCap: TIP_CAP, maxSignedBytes: 1000, maxAttempts: 3, replacementBumpBps: 2500n,
        notAfter: BigInt(ctx.deadline), fee6: ctx.fee6, costCeilingWei: GAS_LIMIT * FEE_CAP, estimateGas: estimate,
        configHash: `0x${"7e".repeat(32)}`, block, blockHash: blk.hash });
    },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-repair-r4-native-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let store = fileStore(path.join(dataDir, "sessions-index.json"), {});
  let journal = fileStore(path.join(dataDir, "sessions-relayer.json"), { txs: [] });
  const relayerWc = wallet("relayer");
  const logs = [];
  let intakeOn = true;
  const ownerControls = { schema: "enclave-funding-owner-controls-r1", chainId: 8453, maxBlockAgeSec: 600,
    addresses: Object.fromEntries(["factory", "implementation", "fundingGasLib", "fundingSessionVaultLib"].map((k) => [k, addresses[k]])),
    codehashes: Object.fromEntries(["factory", "implementation", "fundingGasLib", "fundingSessionVaultLib"].map((k) => [k, codehashes[k]])) };
  const newService = () => createSessionsService({ pc, wc: relayerWc, account: relayerWc.account, chainId: 8453, factory: legacyFactory, book, usdc,
    router: payRouter, store, journal, log: (...a) => logs.push(a.join(" ")), alert: () => {}, funding: intakeOn ? manifest : null,
    fundingQuotePolicy: intakeOn ? TEST_POLICY : null, fundingOwnerControls: ownerControls });
  let svc = newService();
  assert.ok(logs.some((l) => l.startsWith("funding: intake on")), `funding stayed off: ${logs.join(" | ")}`);

  // loopback front: REAL requests to the REAL service; `drops` loses exactly one REPLY (the work is done, the socket dies)
  const front = { drops: new Set(), dropped: [], count: new Map() };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const k = `${req.method} ${u.pathname}`;
    front.count.set(k, (front.count.get(k) ?? 0) + 1);
    if (front.drops.delete(k)) {
      res.writeHead = () => res; res.setHeader = () => res; res.write = () => true;
      res.end = () => { front.dropped.push(k); req.socket.destroy(); return res; };
    }
    svc.handle(req, res, u, {}).catch((e) => { try { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); } catch { /* dropped */ } });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }));
  assert.equal(server.address().address, "127.0.0.1");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = async (method, p, body) => {                         // test-side raw HTTP (not the client under test)
    const r = await fetch(`${origin}/v1/sessions${p}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(j(body)) } : {}) });
    return { status: r.status, body: U.normalizeWire(await r.json()) };
  };
  const hits = (k) => front.count.get(k) ?? 0;
  const allHits = () => [...front.count.values()].reduce((a, b) => a + b, 0);

  // ---- 1. the ORIGINAL 30 USDC session, opened exactly as the site does (SDK, non-extractable key, HTTP /open) --------
  const legacyStore = new S.MemoryStore();
  const { signer: oldSigner, record } = await S.newSessionKey(legacyStore, { relay: origin, chainId: 8453, label: "client-repair-r4 TEST original", extractable: false });
  assert.equal(record.privateKey.extractable, false);
  const t0 = BigInt((await pc.getBlock({ blockTag: "latest" })).timestamp);
  const oldGrant = { label: "client-repair-r4 TEST original", preset: "browser", sessionKey: oldSigner.keyHash, actions: OLD_ACTIONS, apps: ["*"],
    environments: ["staging", "prod"], budget: OLD_BUDGET, spendPerPeriod: 100_000_000n, periodSeconds: 86_400, opsPerPeriod: 1000,
    maxFeePerOp: 250_000n, maxAppFeePerHour: 0n, maxRatePerHour: 5_000_000n, expiresAt: t0 + 7n * 86_400n, measurement: ZERO32,
    grantNonce: toHex(randomBytes(32)), signBefore: t0 + 900n };
  const sdkRelay = new S.RelayClient(origin);
  const ownerSigner = { address: owner, signTypedData: (td) => ownerW.account.signTypedData(td) };
  const usdcDom = await S.usdcDomain(S.chainClient(8453, rpc), usdc, 8453);
  const ownerStart = await usdcOf(owner);
  await S.openSession({ relay: sdkRelay, owner: ownerSigner, chainId: 8453, vault: legacyVault, grant: oldGrant, usdc: usdcDom });
  const oldRec = await S.completeSession(legacyStore, record, { vault: legacyVault, owner, grant: oldGrant, rpc });
  const oldSid = oldRec.id.toLowerCase();
  assert.equal(await usdcOf(legacyVault), OLD_BUDGET);
  assert.equal(await usdcOf(owner), ownerStart - OLD_BUDGET);
  const s0 = await legacySession(oldSid);
  assert.equal(s0.live, true);
  // This second fixture opens an EXPLICIT wildcard and checks exact preservation.
  assert.equal(s0.anyApp, true, "explicit wildcard must read back as anyApp = true");
  assert.deepEqual([...s0.apps], [], "explicit wildcard stores no finite app ids");

  // ---- 2. wire format: the relay writes bigints as "123n"; the DEFAULT client must normalise them (r4 fix) -------------
  const rawCfg = await (await fetch(`${origin}/v1/sessions/funding/config`)).json();
  assert.match(JSON.stringify(rawCfg), /"\d+n"/, "expected n-suffixed bigints on the relay wire");
  const relay = FC.relayClient(origin);                             // DEFAULT fetch: exactly what the page calls
  const cfgViaClient = await relay("GET", "/funding/config");
  assert.doesNotMatch(JSON.stringify(cfgViaClient), /"\d+n"/, "the default client left n-suffixed bigints in a response");
  assert.equal(BigInt(cfgViaClient.adapterMaxEthOut), B(rawCfg.adapterMaxEthOut));
  const rpcFn = FC.jsonRpc(rpc);

  // ---- 3. client runtime + fresh scope, from deployed code (TEST pins, not production pins) -----------------------------
  const pins = { schema: FC.RUNTIME_SCHEMA, chainId: 8453, factory, implementation, gasAdapter: adapter, legacyFactory, usdc, feeTiers: [TIER],
    codehashes: { factory: codehashes.factory, implementation: codehashes.implementation, gasAdapter: codehashes.adapter },
    source: { kind: "deployed-receipts", deployTxs: [deployTx.factory, deployTx.adapter], reviewedBy: "client-repair-r4 TEST fixture (owned Anvil)" } };
  const runtime = await FC.verifyRuntime({ pins, rpc: rpcFn, relay, owner, now: nowS() });
  assert.equal(runtime.intake?.openEnabled, true, runtime.intakeWhy ?? "");
  assert.equal(runtime.cfg.vault, vault);
  assert.equal(runtime.cfg.legacyVault, legacyVault);
  let scope = await FC.freshRecoveryScope({ rpc: rpcFn, book, owner, legacyVault, deploymentIds: deps.map((d) => d.id), now: nowS() });
  assert.equal(scope.partitionRequired, true);
  assert.deepEqual([...scope.appIds], [...APPS].sort());

  // ---- 4. evidence + explicit TEST partition plan (no wallet) -------------------------------------------------------
  const chain = MIG.legacyChain(rpcFn, S);
  const legacyConfig = await sdkRelay.config();
  const evidence = await MIG.loadLegacyEvidence({ S, legacyStore, sid: oldSid, owner, chain, legacyConfig, runtime, now: nowS() });
  assert.equal(evidence.state.balance6, OLD_BUDGET);
  assert.equal(evidence.state.anyApp, true);
  const gasStore = new V2.MemoryV2Store();
  const split = { legacy6: 29_000_000n, gas: [
    { name: "nucbox", budget6: 800_000n, opsPerPeriod: 16n, appIds: NUC },
    { name: "image", budget6: 200_000n, opsPerPeriod: 4n, appIds: METAL }] };           // TEST terms only
  const plan = await MIG.buildMigrationPlan({ S, evidence, runtime, scope, split, now: nowS(), gasStore, relayBase: origin });
  const FULL = ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:image"];
  assert.deepEqual(plan.terms.order, FULL);
  assert.deepEqual(plan.steps.legacyOpen.review.grant.apps, ["*"], "the replacement keeps the explicit original wildcard");
  const keyHashes = [plan.terms.legacy.keyHash, plan.steps["gasOpen:nucbox"].review.keyHash, plan.steps["gasOpen:image"].review.keyHash];
  assert.equal(new Set(keyHashes).size, 3);
  assert.equal(plan.terms.legacy.keyHash, oldSigner.keyHash.toLowerCase());
  for (const r of await gasStore.listKeys()) assert.equal(r.privateKey.extractable, false);

  // Fixture-only Anvil epoch=1 exposes a non-genesis finalized head after deployment. No RPC proof is stubbed.
  const localFinalized = await rawRpc(rpc, "eth_getBlockByNumber", ["finalized", false]);
  assert.ok(BigInt(localFinalized.number) > 0n && localFinalized.hash !== ZERO32, "local finalized head must be non-genesis");
  // ---- 5. seven owner typed-data signatures (terminate + three grant/deposit pairs), TEST approval --------------------
  const provider = ownerProvider(ownerW.account);
  const approval = { rootReviewed: true, termsHash: plan.termsHash };                 // TEST approval of TEST terms
  const signed = await MIG.signSteps({ S, plan: await gasStore.getJournal(plan.id), steps: FULL, approval, provider, rpc: rpcFn, runtime, now: nowS() });
  assert.deepEqual(provider.prompts, ["Terminate", "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization",
    "SessionGrant", "ReceiveWithAuthorization"]);
  const active = [];
  const ctx = () => ({ S, chain, legacyRelay: new S.RelayClient(origin), relay, runtime, legacyStore, gasStore, now: nowS(),
    setActive: async (sid, from) => { active.push([sid, from]); } });
  const step = async (k) => (await gasStore.getJournal(plan.id)).steps[k];

  // ---- 6. terminate proven; the replacement /open REPLY is lost (the open lands); relay restarts from disk ------------
  front.drops.add("POST /v1/sessions/open");
  await assert.rejects(MIG.runMigration(ctx(), plan.id, signed), (e) => { console.log("root lost-reply phase error:", e.code, e.message); return true; });
  assert.deepEqual(front.dropped, ["POST /v1/sessions/open"]);
  assert.equal((await step("terminate")).status, "proven");
  assert.equal((await legacySession(oldSid)).live, false);
  assert.equal((await step("legacyOpen")).status, "admitted");
  assert.equal((await step("legacyOpen")).txHash, undefined);
  const newSid = (await step("legacyOpen")).review.sid;
  assert.equal((await legacySession(newSid)).live, true, "the request was served although its reply was lost");
  assert.deepEqual(active, []);
  store = fileStore(store.file, diskData(store.file));
  journal = fileStore(journal.file, diskData(journal.file));
  svc = newService();
  const rec1 = await MIG.reconcileMigration(ctx(), plan.id);
  assert.equal(rec1.steps.legacyOpen, "proven");
  assert.equal((await pc.getTransactionReceipt({ hash: (await step("legacyOpen")).txHash })).status, "success");
  assert.deepEqual(active, [[newSid, oldSid]]);
  assert.equal(hits("POST /v1/sessions/open"), 2, "one original open + one replacement open, never resent");
  assert.equal(hits("POST /v1/sessions/owner"), 1);

  // ---- 7. SDK-compatible API use: the replacement record (same CryptoKey) passes the host's real verifier ------------
  const repRec = await legacyStore.load(newSid);
  assert.equal(repRec.privateKey, oldRec.privateKey, "same non-extractable legacy key, by reference");
  assert.equal(repRec.grant.budget, 29_000_000n);
  assert.deepEqual(repRec.grant.apps, ["*"]);
  const apiUrl = "http://127.0.0.1:9/v1/client-repair-r4/api-probe";
  const apiVerify = async (rec) => {
    const header = await (await S.sessionFromRecord(rec)).apiAuthorization("GET", apiUrl);
    return svc.verifyApiRequest({ header, method: "GET", hostPath: "127.0.0.1:9/v1/client-repair-r4/api-probe", scope: "api.status", fresh: true });
  };
  assert.equal(String((await apiVerify(repRec)).sid).toLowerCase(), newSid);
  await assert.rejects(apiVerify(await legacyStore.load(oldSid)), status401);
  const repState = await legacySession(newSid);
  assert.equal(B(repState.actions), MIG.actionsMaskV1(S, OLD_ACTIONS));
  assert.equal(B(repState.maxRateHour6), 5_000_000n);
  assert.equal(repState.anyApp, true, "the replacement preserves the explicit original wildcard");
  assert.deepEqual([...repState.apps], []);

  // ---- 8. first gas part: its REPLY is lost too; reconcile finds the part's own event; nothing resent ----------------
  front.drops.add("POST /v1/sessions/funding/open");
  await assert.rejects(MIG.runMigration(ctx(), plan.id, signed));
  assert.equal((await step("gasOpen:nucbox")).status, "admitted");
  assert.equal((await MIG.reconcileMigration(ctx(), plan.id)).steps["gasOpen:nucbox"], "proven");
  assert.equal((await step("gasOpen:image")).status, "planned");

  // ---- 9. snapshot (for the reorg check at the end), then the second part -------------------------------------------
  const snap = await rawRpc(rpc, "evm_snapshot");
  assert.equal((await MIG.runMigration(ctx(), plan.id, signed)).done, true);
  assert.equal(hits("POST /v1/sessions/funding/open"), 2, "two parts, two submissions, none resent");
  const imageTx = (await step("gasOpen:image")).txHash;
  // money: refund back, 29 + 0.9 + 0.1 out, nothing duplicated, locked <= 30
  assert.equal(await usdcOf(owner), ownerStart - OLD_BUDGET);
  assert.equal(await usdcOf(legacyVault), 29_000_000n);
  assert.equal(await usdcOf(vault), 1_000_000n);
  const nucSid = (await step("gasOpen:nucbox")).review.sid;
  const imgSid = (await step("gasOpen:image")).review.sid;
  assert.equal(B((await gasSession(nucSid)).balance6), 800_000n);
  assert.equal(B((await gasSession(imgSid)).balance6), 200_000n);
  assert.deepEqual((await rd(vault, "implementation", "sessionOf", [nucSid]))[2].map((a) => a.toLowerCase()).sort(), NUC);
  assert.deepEqual((await rd(vault, "implementation", "sessionOf", [imgSid]))[2].map((a) => a.toLowerCase()).sort(), METAL);

  // ---- 10. real P-256 gas.fund through the grant whose scope names each app ---------------------------------------
  scope = await FC.freshRecoveryScope({ rpc: rpcFn, book, owner, legacyVault, deploymentIds: deps.map((d) => d.id), now: nowS() });
  for (const d of deps) {
    const rec = FC.selectGasRecord(await gasStore.listKeys(), scope, d.id);
    assert.ok(rec.grant.apps.includes(d.app));
    const before = B((await gasSession(rec.sid)).balance6);
    const reserveBefore = B((await rd(reserve, "reserve", "reserveOf", [d.id, owner])).balanceWei);
    const review = await FC.quoteGasFund({ runtime, record: rec, relay, scope, deployment: d.id, ethOut: ETH_OUT, feeTier: TIER, now: nowS(),
      journalEntries: await gasStore.listJournal() });
    const out = await FC.confirmGasFund({ runtime, store: gasStore, record: rec, review, relay, rpc: rpcFn, now: nowS() });
    assert.equal(out.pending, false);
    assert.equal(B((await gasSession(rec.sid)).balance6), before - out.settlement.actual.totalDebit6);
    assert.equal(B((await rd(reserve, "reserve", "reserveOf", [d.id, owner])).balanceWei), reserveBefore + ETH_OUT);
  }
  // the NucBox grant can not fund the image app: refused by the client, and by the real vault if asked directly
  const nucRec = FC.selectGasRecord(await gasStore.listKeys(), scope, deps[1].id);
  const imgRec = FC.selectGasRecord(await gasStore.listKeys(), scope, deps[0].id);
  assert.equal(nucRec.sid, nucSid);
  assert.equal(imgRec.sid, imgSid);
  await assert.rejects(FC.quoteGasFund({ runtime, record: nucRec, relay, scope, deployment: deps[0].id, ethOut: ETH_OUT, feeTier: TIER, now: nowS() }),
    code("app_not_granted"));
  const nonce0 = await pc.getTransactionCount({ address: relayer, blockTag: "pending" });
  const xq = await raw("POST", "/funding/quote", { vault, sid: nucRec.sid, deployment: deps[0].id, ethOut: ETH_OUT, feeTier: TIER });
  if (xq.status === 200) {
    const q = xq.body;
    const intent = { payer: q.intent.payer, deployment: q.intent.deployment, expectedOwner: q.intent.expectedOwner, ethOut: q.intent.ethOut,
      maxUsdcIn6: q.intent.maxUsdcIn6, fee: Number(q.intent.fee), deadline: q.intent.deadline };
    const call = codec.buildGasFundCall(runtime.cfg, { domainVersion: "2", now: nowS(), sessionId: nucRec.sid, nonce: q.nonce, action: 10,
      intent, fee: q.fee, deadline: q.deadline });
    const sg = await V2.signerFor(nucRec.privateKey, BigInt(nucRec.x), BigInt(nucRec.y)).signDigest(call.digest);
    const xe = await raw("POST", "/funding/execute", { vault, sid: nucRec.sid, nonce: call.execute.nonce, action: 10, args: call.args,
      fee: call.execute.fee, deadline: call.execute.deadline, x: nucRec.x, y: nucRec.y, ...sg });
    assert.equal(xe.status, 409, JSON.stringify(xe.body));
  } else assert.ok(xq.status >= 400, JSON.stringify(xq.body));
  assert.equal(await pc.getTransactionCount({ address: relayer, blockTag: "pending" }), nonce0, "a cross-app attempt was broadcast");

  // ---- 11. intake OFF: quotes refused; end (session key), terminate (owner), withdraw refusal still work ------------
  intakeOn = false;
  svc = newService();
  const rtOff = await FC.verifyRuntime({ pins, rpc: rpcFn, relay, owner, now: nowS() });
  assert.equal(rtOff.intake, null);
  await assert.rejects(FC.quoteGasFund({ runtime: rtOff, record: imgRec, relay, scope, deployment: deps[0].id, ethOut: ETH_OUT, feeTier: TIER, now: nowS() }),
    code("intake_off"));
  assert.equal((await raw("POST", "/funding/quote", { vault, sid: imgRec.sid, deployment: deps[0].id, ethOut: ETH_OUT, feeTier: TIER })).status, 503);
  const ownerBeforeEnd = await usdcOf(owner);
  const nucLeft = B((await gasSession(nucRec.sid)).balance6);
  const ended = await FC.endGasSession({ record: nucRec, relay, store: gasStore, now: nowS() });
  assert.equal((await gasSession(nucRec.sid)).live, false);
  const endRc = await CP.canonicalReceipt(rpcFn, ended.txHash);
  assert.ok(endRc, "the sign-out receipt is canonical");
  const endEv = CP.eventsOf(endRc, vault, CP.VAULT_EVENTS).filter((e) => e.name === "SessionEnded" && e.args.sid.toLowerCase() === nucRec.sid);
  assert.equal(endEv.length, 1);
  assert.equal(Number(endEv[0].args.reason), 2, "session-key termination reason");
  assert.equal(B(endEv[0].args.refund6), nucLeft, "sign-out refunds the whole remaining part budget");
  assert.equal(B(endEv[0].args.fee6), 0n);
  assert.equal(await usdcOf(owner), ownerBeforeEnd + nucLeft);
  const target = FC.controlsTarget(FC.parseRuntimePins(pins), owner);
  assert.equal(target.vault, vault);
  const ctlProvider = ownerProvider(ownerW.account);
  const imgLeft = B((await gasSession(imgRec.sid)).balance6);
  await FC.ownerControl({ target, provider: ctlProvider, relay, store: gasStore, op: "terminate", sessionId: imgRec.sid, now: nowS() });
  assert.equal((await gasSession(imgRec.sid)).live, false);
  assert.equal(await usdcOf(owner), ownerBeforeEnd + nucLeft + imgLeft);
  assert.equal(await usdcOf(vault), 0n);
  const n1 = await pc.getTransactionCount({ address: relayer, blockTag: "pending" });
  await assert.rejects(FC.ownerControl({ target, provider: ctlProvider, relay, store: gasStore, op: "withdraw", amount: 1n, now: nowS() }));
  assert.equal(await pc.getTransactionCount({ address: relayer, blockTag: "pending" }), n1, "a withdraw beyond free() was broadcast");
  assert.deepEqual(ctlProvider.prompts, ["Terminate", "Withdraw"]);
  // the legacy replacement keeps serving the API with funding intake off; ownership never moved
  assert.equal(String((await apiVerify(repRec)).sid).toLowerCase(), newSid);
  for (const d of deps) assert.equal(await holderOf(d.id), owner);
  assert.equal(getAddress(await rd(book, "book", "addr", [key32("sessionVaultFactory")])), legacyFactory);

  // ---- 12. a REAL reorg of the last part (evm_revert): reconcile keeps the proof, refuses, contacts no relay -------
  assert.equal(await rawRpc(rpc, "evm_revert", [snap]), true);
  assert.equal(await rawRpc(rpc, "eth_getTransactionReceipt", [imageTx]), null);
  const requestsBefore = allHits();
  await assert.rejects(MIG.reconcileMigration(ctx(), plan.id), code("prior_proof_lost"));
  assert.equal((await step("gasOpen:image")).status, "proven");
  assert.equal((await step("gasOpen:image")).recheck.result, "lost");
  assert.equal(allHits(), requestsBefore, "reconcile contacted the relay");
  // no journal entry ever held a signature or key bytes
  const all = JSON.stringify(await gasStore.listJournal());
  for (const k of FULL) {
    const b = signed[k].body;
    for (const sig of [b.sig, b.ownerSig, b.deposit?.sig].filter(Boolean)) assert.equal(all.includes(String(sig).slice(2)), false);
  }
});
