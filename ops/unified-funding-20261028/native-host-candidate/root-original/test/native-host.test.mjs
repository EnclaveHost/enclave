// native-host-r1: ONE native gas.fund flow through the ACTUAL composed host on an OWNED Anvil. Run `python3 prepare.py` first.
//
// Real: anvil (127.0.0.1 only, chain id 8453, --hardfork osaka, NO code-size override), the native P-256 precompile at
// 0x100 (no verifier shim), session-r1/out artifacts (FundingGasLib + FundingSessionVaultLib linked into the successor
// factory/implementation, the ORIGINAL SessionVaultFactory as the standalone legacy factory, ledger, book, catalog,
// PaymentRouter, EnclaveLeaseGasReserve, LeaseGasDexAdapter), createSessionsService from successor-host-r1/generated/relay
// served by its own handle() over loopback HTTP with ONE TxQueue and ONE viem wallet client for the public Anvil relayer
// key, the owner's EIP-712 domain-2 grant signed by the public Anvil owner key, a FRESH Node P-256 session key, the
// client-r1 codec for every digest.
// MOCKS (labelled): MockUSDC3009, SessionRegistryStub, MockKeyAttestations (session mocks); MockWETH9, MockV3Factory and
// pools, MockSwapRouter02 (dex-r1 mocks); MockQuoterV2 (fixture/src, NEW: no quoter mock existed). TEST_POLICY below is a
// FIXED-FEE test quote policy, NOT the reviewed fee policy; its envelope is the actual fee-policy makeEnvelope over the
// route's exact calldata and is enforced by the actual queue on the broadcast. Nothing here touches Base or a public RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import net from "node:net";
import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { concat, createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeDeployData, getAddress,
  hashTypedData, http as viemHttp, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const UF = path.resolve(ROOT, "..");
const STAGING = JSON.parse(fs.readFileSync(path.join(ROOT, "generated", "FIXTURE-STAGING.json"), "utf8"));
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
// fail closed on anything that changed since prepare.py staged it
for (const [rel, want] of Object.entries({ ...STAGING.relay, ...STAGING.client })) {
  assert.equal(sha(path.join(UF, rel)), want, `${rel} changed since prepare.py staged it`);
}
const REL = path.join(UF, "successor-host-r1", "generated", "relay");
const imp = (p) => import(url.pathToFileURL(p).href);
const { createSessionsService } = await imp(path.join(REL, "sessions.mjs"));
const { predictVault } = await imp(path.join(REL, "funding-route.mjs"));
const { QUOTE_POLICY_INTERFACE, makeEnvelope, queueGasFor, checkEnvelopeAttempt } = await imp(path.join(REL, "fee-policy.mjs"));
const codec = await imp(path.join(UF, "client-r1", "funding-codec.mjs"));

// the PUBLIC Anvil dev keys (default mnemonic accounts 0, 1, 2) - never anything else
const KEYS = {
  deployer: ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
  owner: ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  relayer: ["0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
};
const TREASURY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";   // public Anvil account 3 (address only)
const PAYOUT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";     // public Anvil account 4 (address only)
const REGISTRY = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";   // public Anvil account 5 (address only, as makeAddr in the rig)
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"0".repeat(64)}`;
const P256 = "0x0000000000000000000000000000000000000100";
const N256 = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
const TIER = 500;
const PRICE6 = 2_400_000_000n;            // the rig's $2400 mock price
const ETH_OUT = 4_000_000_000_000_000n;   // 0.004 ETH
const FEE = 25_000n;                      // TEST policy fixed fee (0.025 USDC)
const BUDGET = 30_000_000n;
const GAS_LIMIT = 3_000_000n;
const FEE_CAP = 1_000_000_000n;
const TIP_CAP = 2_000_000n;
const ANVIL_ARGS = (port) => ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "osaka",
  "--base-fee", "5000000", "--silent"];

const B = (v) => BigInt(String(v).replace(/n$/, ""));
const j = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const rep = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);
const key32 = (s) => toHex(s, { size: 32 });

function freePort() {
  return new Promise((ok, no) => { const s = net.createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

/** A durable JSON file store (write tmp, fsync, rename) shaped like the host's JsonStore: { data, flush, saveSoon }. */
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

function artifact(id) {
  const e = STAGING.artifacts[id];
  if (!e) throw new Error(`artifact ${id} is not staged (run prepare.py)`);
  const p = path.join(UF, e.path);
  assert.equal(sha(p), e.sha256, `${e.path} changed since prepare.py staged it`);
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

/** Own Anvil; identity asserted BEFORE any state-changing call. */
async function startAnvil() {
  const port = await freePort();
  const args = ANVIL_ARGS(port);
  assert.ok(!args.some((a) => /code-size|disable-code-size/.test(a)), "no code-size override");
  const proc = spawn("anvil", args, { stdio: "ignore" });
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
  const stop = () => proc.kill("SIGKILL");
  try {
    assert.equal(new URL(rpc).hostname, "127.0.0.1", "the RPC must be a loopback literal");
    const version = await rawRpc(rpc, "web3_clientVersion");
    assert.match(String(version), /^anvil\//i, `web3_clientVersion is ${version}, not anvil`);
    assert.equal(await rawRpc(rpc, "eth_chainId"), "0x2105", "chain id must be 8453");
    const accounts = (await rawRpc(rpc, "eth_accounts")).map((a) => getAddress(a));
    for (const [k, [pk, addr]] of Object.entries(KEYS)) {
      assert.equal(privateKeyToAccount(pk).address, addr, `${k} key is not the public Anvil key`);
      assert.ok(accounts.includes(addr), `${k} ${addr} is not an Anvil dev account here`);
    }
    // the NATIVE precompile: a real signature answers 1, a tampered one does not, and nothing is etched at 0x100
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const msg = Buffer.from("native-host-r1 p256 probe");
    const sig = cryptoSign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
    const jw = publicKey.export({ format: "jwk" });
    const probe = `0x${Buffer.concat([createHash("sha256").update(msg).digest(), sig, Buffer.from(jw.x, "base64url"), Buffer.from(jw.y, "base64url")]).toString("hex")}`;
    const bad = probe.slice(0, 130) + (probe.slice(130, 132) === "00" ? "01" : "00") + probe.slice(132);
    const one = (d) => typeof d === "string" && /^0x0*1$/.test(d);
    assert.ok(one(await rawRpc(rpc, "eth_call", [{ to: P256, data: probe }, "latest"])), "no native P-256 precompile (needs osaka)");
    assert.ok(!one(await rawRpc(rpc, "eth_call", [{ to: P256, data: bad }, "latest"]).catch(() => "0x")), "0x100 accepted a tampered signature");
    assert.equal(await rawRpc(rpc, "eth_getCode", [P256, "latest"]), "0x", "code is etched at 0x100 (a shim)");
  } catch (e) { stop(); throw e; }
  return { rpc, stop };
}

test("native P-256 gas.fund through the composed host's HTTP handle on an owned Anvil", { timeout: 240_000 }, async (t) => {
  const { rpc, stop } = await startAnvil();
  t.after(stop);
  const chain = defineChain({ id: 8453, name: "owned anvil (chain id 8453; NOT Base)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } } });
  const pc = createPublicClient({ chain, transport: viemHttp(rpc) });
  const wallet = (k) => createWalletClient({ chain, account: privateKeyToAccount(KEYS[k][0]), transport: viemHttp(rpc) });
  const dep = wallet("deployer"), ownerW = wallet("owner");
  const owner = ownerW.account.address, relayer = KEYS.relayer[1];

  // ---- deploy (FundingRig.setUp order, deployer = Anvil account 0) ----------------------------------------------------
  const A = {};
  for (const id of Object.keys(STAGING.artifacts)) A[id] = artifact(id);
  const libs = {};
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
    return getAddress(rc.contractAddress);
  }
  const rd = (address, id, functionName, args = []) => pc.readContract({ address, abi: A[id].abi, functionName, args });
  async function write(address, id, functionName, args = [], who = dep, value) {
    const { request, result } = await pc.simulateContract({ address, abi: A[id].abi, functionName, args, account: who.account, ...(value ? { value } : {}) });
    await mined(await who.writeContract(request), `${id}.${functionName}`);
    return result;
  }

  const usdc = await deploy("usdc");
  const book = await deploy("book");
  const reg = await deploy("registryStub");
  const ka = await deploy("keyAttestations");
  const ledger = await deploy("ledger", [usdc, PAYOUT, reg, ZERO]);
  await write(ledger, "ledger", "setProofRequiredFrom", [0n]);
  const catalog = await deploy("catalog");
  const payRouter = await deploy("paymentRouter", [usdc, TREASURY]);
  await write(book, "book", "set", [key32("deployments"), ledger]);
  await write(book, "book", "set", [key32("appCatalog"), catalog]);
  // the legacy world: the ORIGINAL factory as the book's factory entry (a standalone input, never altered below)
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
    await write(usdc, "usdc", "mint", [pools[fee], 1_000_000_000_000n]);
  }
  const adapter = await deploy("adapter", [usdc, weth, swapRouter, v3, ledger, reserve, 50_000_000_000_000_000n]);
  const factory = await deploy("factory", [usdc, book, payRouter, ka, 1_000_000_000n, adapter, legacyFactory]);
  const quoter = await deploy("quoter", [swapRouter, usdc]);
  await write(usdc, "usdc", "mint", [owner, 1_000_000_000n]);
  const implementation = getAddress(await rd(factory, "factory", "implementation"));
  const legacyImplementation = getAddress(await rd(legacyFactory, "legacyFactory", "implementation"));
  const vault = predictVault(factory, implementation, owner);
  assert.equal(getAddress(await rd(factory, "factory", "vaultFor", [owner])), vault);
  const legacyVault = getAddress(await rd(legacyFactory, "legacyFactory", "vaultFor", [owner]));
  const implCode = String(await pc.getCode({ address: implementation })).toLowerCase();
  assert.ok(implCode.length > 2 && (implCode.length - 2) / 2 <= 24_576, "implementation deployed within EIP-170");
  const fundingGasLib = libs["src/FundingGasLib.sol:FundingGasLib"];
  const fundingSessionVaultLib = libs["src/FundingSessionVault.sol:FundingSessionVaultLib"];
  assert.ok(fundingGasLib && fundingSessionVaultLib, "both successor libraries were linked and deployed");
  for (const l of [fundingGasLib, fundingSessionVaultLib]) assert.ok(implCode.includes(l.slice(2).toLowerCase()), `implementation links ${l}`);

  // ---- the wallet-held test deployment (owner EOA creates it directly; no vault, no session) ------------------------
  const deployment = String(await write(ledger, "ledger", "create",
    ["fixture://native-host-r1/wallet-held", 0n, 1000n, 8080n, "", false, "", ZERO, 0n, 1000n], ownerW)).toLowerCase();
  const holderOf = async () => getAddress((await rd(ledger, "ledger", "get", [deployment])).owner);
  assert.equal(await holderOf(), owner);
  const legacyBefore = { book: getAddress(await rd(book, "book", "addr", [key32("sessionVaultFactory")])), impl: legacyImplementation,
    code: await pc.getCode({ address: legacyVault }), isVault: await rd(legacyFactory, "legacyFactory", "isVault", [legacyVault]) };
  assert.equal(legacyBefore.book, legacyFactory);

  // ---- activation manifest from the deployed code hashes (test only) --------------------------------------------------
  const addresses = { factory, implementation, fundingGasLib, fundingSessionVaultLib, adapter, legacyFactory, legacyImplementation,
    usdc, weth, book, ledger, reserve, swapRouter, dexFactory: v3, quoter };
  const ch = async (a) => keccak256(await pc.getCode({ address: a }));
  const codehashes = {};
  for (const [k, a] of Object.entries(addresses)) codehashes[k] = await ch(a);
  const now = () => Math.floor(Date.now() / 1000);
  const manifest = { schema: "enclave-funding-activation-r1", chainId: 8453, notAfter: now() + 3600, maxBlockAgeSec: 600, addresses, codehashes,
    pools: { [TIER]: { address: pools[TIER], codehash: await ch(pools[TIER]) } }, feeTiers: [TIER], maxSlippageBps: 100, deadlineSec: 300 };

  // ---- TEST quote policy: fixed fee; the envelope is the actual makeEnvelope at the accepted block -----------------
  const envelopes = [];
  const TEST_POLICY = Object.freeze({
    interface: QUOTE_POLICY_INTERFACE,
    async quote(ctx) {
      assert.equal(ctx.envelopeEnforced, true);
      return { fee6: FEE, detail: { note: "TEST policy (native-host-r1): fixed fee, NOT the reviewed fee policy" } };
    },
    async fee() { return FEE; },
    async accept(ctx) { return ctx.phase === "execute" && ctx.fee6 === FEE; },
    async envelope(ctx) {
      const block = BigInt(ctx.block);
      const blk = await pc.getBlock({ blockNumber: block });
      const estimate = await pc.estimateGas({ account: ctx.from, to: ctx.to, data: ctx.data, blockNumber: block });
      if (queueGasFor(estimate) > GAS_LIMIT) throw new Error(`gas ${queueGasFor(estimate)} above the TEST cap ${GAS_LIMIT}`);
      const e = makeEnvelope({ chainId: 8453n, from: ctx.from.toLowerCase(), to: ctx.to.toLowerCase(), data: ctx.data, gasLimit: GAS_LIMIT,
        maxFeePerGasCap: FEE_CAP, maxPriorityFeePerGasCap: TIP_CAP, maxSignedBytes: 1000, maxAttempts: 3, replacementBumpBps: 2500n,
        notAfter: BigInt(ctx.deadline), fee6: ctx.fee6, costCeilingWei: GAS_LIMIT * FEE_CAP, estimateGas: estimate,
        configHash: `0x${"7e".repeat(32)}`, block, blockHash: blk.hash });
      envelopes.push(e);
      return e;
    },
  });

  // ---- the ACTUAL host: one service, one queue, one wallet client, durable files ------------------------------------
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-host-r1-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = fileStore(path.join(dataDir, "sessions-index.json"), {});
  const journal = fileStore(path.join(dataDir, "sessions-relayer.json"), { txs: [] });
  const relayerWc = wallet("relayer");
  const logs = [];
  const svc = createSessionsService({ pc, wc: relayerWc, account: relayerWc.account, chainId: 8453, factory: legacyFactory, book, usdc,
    router: payRouter, store, journal, log: (...a) => logs.push(a.join(" ")), alert: () => {}, funding: manifest, fundingQuotePolicy: TEST_POLICY });
  assert.ok(logs.some((l) => l.startsWith("funding: on")), `funding stayed off: ${logs.join(" | ")}`);
  const server = http.createServer((req, res) => {
    svc.handle(req, res, new URL(req.url, "http://127.0.0.1"), {}).catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => server.close(ok)));
  assert.equal(server.address().address, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}/v1/sessions`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(j(body)) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const cfgRes = await call("GET", "/funding/config");
  assert.equal(cfgRes.status, 200, JSON.stringify(cfgRes.body));
  assert.equal(cfgRes.body.open.enabled, true);

  // ---- client: codec config, fresh P-256 key, owner's domain-2 grant ------------------------------------------------
  const adapterMaxEthOut = B(await rd(adapter, "adapter", "maxEthOut"));
  const cfg = codec.fundingConfig({ chainId: 8453n, factory, implementation, vault, owner, gasAdapter: adapter, legacyFactory, legacyVault,
    adapterMaxEthOut, adapterFeeTiers: [TIER] });
  const { privateKey: sk, publicKey: pk } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pk.export({ format: "jwk" });
  const X = BigInt(`0x${Buffer.from(jwk.x, "base64url").toString("hex")}`), Y = BigInt(`0x${Buffer.from(jwk.y, "base64url").toString("hex")}`);
  const p256 = async (digest) => {
    const m = Buffer.from(digest.slice(2), "hex");
    const sig = cryptoSign("sha256", m, { key: sk, dsaEncoding: "ieee-p1363" });
    let r = BigInt(`0x${sig.subarray(0, 32).toString("hex")}`), s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
    if (s > N256 / 2n) s = N256 - s;
    const rs = Buffer.from(toHex(r, { size: 32 }).slice(2) + toHex(s, { size: 32 }).slice(2), "hex");
    assert.ok(cryptoVerify("sha256", m, { key: pk, dsaEncoding: "ieee-p1363" }, rs));
    // the same signature through the chain's own precompile: sha256(digest) || r || s || x || y
    const pre = await rawRpc(rpc, "eth_call", [{ to: P256, data: concat([`0x${createHash("sha256").update(m).digest("hex")}`, toHex(r, { size: 32 }),
      toHex(s, { size: 32 }), toHex(X, { size: 32 }), toHex(Y, { size: 32 })]) }, "latest"]);
    assert.match(pre, /^0x0*1$/, "the native precompile rejects the client's own signature");
    return { x: X.toString(), y: Y.toString(), r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }) };
  };
  const chainNow = async () => BigInt((await pc.getBlock({ blockTag: "latest" })).timestamp);
  let ts = await chainNow();
  const grant = { label: "native-host-r1 fixture", preset: "custom", sessionKey: codec.keyHashOf(X, Y), actions: ["gas.fund"], apps: ["*"],
    environments: ["staging", "prod"], budget: BUDGET, spendPerPeriod: BUDGET, periodSeconds: 86_400n, opsPerPeriod: 10n, maxFeePerOp: 50_000n,
    maxAppFeePerHour: 1_000_000n, maxRatePerHour: 10_000_000n, maxGasUsdcPerOp: 20_000_000n, maxUsdcPerEth6: 3_000_000_000n,
    maxEthPerOp: 10_000_000_000_000_000n, expiresAt: ts + 7n * 86_400n, measurement: ZERO32, grantNonce: toHex(randomBytes(32)), signBefore: ts + 600n };
  const built = codec.buildGrantV2(cfg, { domainVersion: "2", now: ts, grant });
  assert.equal(built.typedData.domain.version, "2");
  assert.equal(built.gasFundGranted, true);
  assert.equal(hashTypedData(built.typedData), built.digest);
  const ownerSig = await ownerW.account.signTypedData(built.typedData);
  const RECEIVE = keccak256(toHex("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));
  const validBefore = ts + 3600n;
  const dsep = await rd(usdc, "usdc", "DOMAIN_SEPARATOR");
  const authDigest = keccak256(concat(["0x1901", dsep, keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [RECEIVE, owner, vault, BUDGET, 0n, validBefore, built.digest]))]));
  const depositSig = await ownerW.account.sign({ hash: authDigest });

  // ---- HTTP open with the EIP-3009 deposit ----------------------------------------------------------------------------
  const ownerUsdc0 = B(await rd(usdc, "usdc", "balanceOf", [owner]));
  const opened = await call("POST", "/funding/open", { owner, grant, ownerSig, deposit: { validAfter: 0n, validBefore, sig: depositSig } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const sid = built.sessionId;
  assert.equal(opened.body.sid, sid);
  assert.equal(getAddress(opened.body.vault), vault);
  assert.equal(await rd(factory, "factory", "isVault", [vault]), true);
  assert.equal(getAddress(await rd(vault, "implementation", "owner")), owner);
  assert.equal(B(await rd(usdc, "usdc", "balanceOf", [owner])), ownerUsdc0 - BUDGET);
  assert.equal(B(await rd(usdc, "usdc", "balanceOf", [vault])), BUDGET);

  // ---- HTTP quote ------------------------------------------------------------------------------------------------------
  const quoted = await call("POST", "/funding/quote", { vault, sid, deployment, ethOut: ETH_OUT, feeTier: TIER });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  const q = quoted.body;
  assert.equal(q.holderKind, "wallet");
  assert.equal(getAddress(q.intent.expectedOwner), owner);
  assert.equal(B(q.fee), FEE);
  assert.match(q.feePolicy.note, /TEST policy/);
  const amountIn6 = B(await rd(swapRouter, "swapRouter", "quoteIn", [TIER, ETH_OUT]));
  assert.equal(B(q.quote.amountIn6), amountIn6);
  const maxUsdcIn6 = B(q.intent.maxUsdcIn6);
  assert.ok(maxUsdcIn6 > amountIn6, "a slippage margin leaves something to refund");

  // ---- client builds and signs the gas.fund call with the codec -----------------------------------------------------
  ts = await chainNow();
  const intent = { payer: getAddress(q.intent.payer), deployment: String(q.intent.deployment).toLowerCase(), expectedOwner: getAddress(q.intent.expectedOwner),
    ethOut: B(q.intent.ethOut), maxUsdcIn6, fee: Number(B(q.intent.fee)), deadline: B(q.intent.deadline) };
  const gcall = codec.buildGasFundCall(cfg, { domainVersion: "2", now: ts, sessionId: sid, nonce: B(q.nonce), action: 10, intent, fee: B(q.fee),
    deadline: B(q.deadline) });
  assert.equal(gcall.args, String(q.args).toLowerCase(), "codec args equal the relay's quoted args");
  assert.equal(gcall.argsHash, String(q.argsHash).toLowerCase());
  const execBody = (sig) => ({ vault, sid, nonce: gcall.nonce.value, action: 10, args: gcall.args, fee: B(q.fee), deadline: B(q.deadline), ...sig });
  const goodSig = await p256(gcall.digest);
  const wrongSig = await p256(keccak256(gcall.digest));   // a REAL P-256 signature, over the wrong message

  const snap = async () => ({ block: await pc.getBlockNumber(), nonce: await pc.getTransactionCount({ address: relayer, blockTag: "pending" }),
    txs: journal.data.txs.length, intents: Object.keys(journal.data.intents ?? {}).length, pending: Object.keys(store.data.fundingPending ?? {}).length,
    vaultUsdc: B(await rd(usdc, "usdc", "balanceOf", [vault])), relayerUsdc: B(await rd(usdc, "usdc", "balanceOf", [relayer])),
    poolUsdc: B(await rd(usdc, "usdc", "balanceOf", [pools[TIER]])), reserveEth: await pc.getBalance({ address: reserve }),
    reserveOf: B((await rd(reserve, "reserve", "reserveOf", [deployment, owner])).balanceWei),
    balance6: B((await rd(vault, "implementation", "sessionOf", [sid]))[0].balance6) });

  // ---- invalid signature: refused by the vault in simulation; nothing reserved, journaled or sent --------------------
  const s0 = await snap();
  const refused = await call("POST", "/funding/execute", execBody(wrongSig));
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "revert");
  assert.deepEqual(await snap(), s0, "a refused signature changed chain, queue, journal or index state");
  assert.equal(envelopes.length, 0, "no envelope was built for a refused signature");

  // ---- HTTP execute with the real signature ---------------------------------------------------------------------------
  const done = await call("POST", "/funding/execute", execBody(goodSig));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const txHash = done.body.txHash;
  const st = done.body.settlement;
  const used = B(st.actual.usdcSpent6), refund = B(st.refund6);
  assert.equal(used, amountIn6, "the mock router charged its quote");
  assert.equal(used + refund, maxUsdcIn6, "actual + refund = signed maximum");
  assert.ok(refund > 0n);
  assert.equal(B(st.actual.fee6), FEE);
  const s1 = await snap();
  assert.equal(s1.vaultUsdc, s0.vaultUsdc - used - FEE, "vault debited exactly actual + one fee");
  assert.equal(s1.relayerUsdc, s0.relayerUsdc + FEE, "relayer received exactly one fee");
  assert.equal(s1.poolUsdc, s0.poolUsdc + used, "the pool received the actual input");
  assert.equal(s1.balance6, s0.balance6 - used - FEE, "session balance debited exactly actual + fee (refund kept)");
  assert.equal(s1.reserveEth, s0.reserveEth + ETH_OUT, "reserve holds the ETH out");
  assert.equal(s1.reserveOf, s0.reserveOf + ETH_OUT, "credited to the wallet-held deployment under its owner");
  assert.equal(s1.nonce, s0.nonce + 1, "exactly one relayer transaction");
  // the actual envelope guard bounded the broadcast
  assert.equal(envelopes.length, 1);
  const env = envelopes[0];
  const tx = await pc.getTransaction({ hash: txHash });
  assert.equal(getAddress(tx.from), relayer);
  assert.equal(getAddress(tx.to), vault);
  assert.equal(tx.gas, env.gasLimit);
  assert.ok(tx.maxFeePerGas <= env.maxFeePerGasCap && tx.maxPriorityFeePerGas <= env.maxPriorityFeePerGasCap);
  assert.equal(keccak256(tx.input), env.dataHash);
  assert.equal(checkEnvelopeAttempt(env, { chainId: 8453n, from: relayer.toLowerCase(), to: vault, data: tx.input, value: tx.value, gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, nonce: BigInt(tx.nonce), attempt: 0, nowSec: BigInt(now()) }), true);
  assert.equal(B((await rd(vault, "implementation", "sessionOf", [sid]))[0].balance6), s1.balance6);
  // the durable journal (re-read from disk): exactly one execute intent, done, one record, one hash
  const execKeys = Object.entries(journal.data.intents).filter(([, r]) => r.kind === "execute").map(([k]) => k);
  assert.equal(execKeys.length, 1);
  const iKey = execKeys[0];
  for (const J of [journal.data, JSON.parse(fs.readFileSync(journal.file, "utf8"))]) {
    assert.equal(J.intents[iKey].status, "done");
    assert.equal(String(J.intents[iKey].hash).toLowerCase(), txHash);
    const recs = J.txs.filter((r) => r.intent === iKey);
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0].hashes.map((h) => String(h).toLowerCase()), [txHash]);
    assert.equal(recs[0].envelope?.digest, env.digest);
  }
  assert.equal(store.data.fundingOps[sid].length, 1, "indexed exactly once");
  assert.deepEqual(Object.keys(store.data.fundingPending), []);

  // ---- retry of the same signed intent: answered from the journal, never sent again ---------------------------------
  const again = await call("POST", "/funding/execute", execBody(goodSig));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.already, true);
  assert.equal(again.body.txHash, txHash);
  const s2 = await snap();
  assert.equal(s2.nonce, s1.nonce);
  assert.equal(s2.txs, s1.txs);
  assert.equal(store.data.fundingOps[sid].length, 1);

  // ---- funding changed no ownership: the record stays the owner's wallet's, the legacy world is untouched -----------
  assert.equal(await holderOf(), owner);
  assert.equal(getAddress(await rd(book, "book", "addr", [key32("sessionVaultFactory")])), legacyBefore.book);
  assert.equal(getAddress(await rd(legacyFactory, "legacyFactory", "implementation")), legacyBefore.impl);
  assert.equal(await pc.getCode({ address: legacyVault }), legacyBefore.code);
  assert.equal(await rd(legacyFactory, "legacyFactory", "isVault", [legacyVault]), legacyBefore.isVault);
  assert.equal(await rd(legacyFactory, "legacyFactory", "isVault", [vault]), false);

  // ---- HTTP terminateBySession: the session key's domain-2 sign-out; then revoked on chain and off chain -------------
  ts = await chainNow();
  const se = codec.buildSessionEndV2(cfg, { domainVersion: "2", now: ts, sessionId: sid, deadline: ts + 300n });
  const ended = await call("POST", "/funding/end", { vault, sid, deadline: ts + 300n, ...(await p256(se.digest)) });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  const [, live] = await rd(vault, "implementation", "sessionOf", [sid]);
  assert.equal(live, false, "the vault no longer reports the session live");
  assert.ok(store.data.revoked[sid], "off-chain revocation recorded");
  const endKeys = Object.entries(journal.data.intents).filter(([, r]) => r.kind === "end");
  assert.equal(endKeys.length, 1);
  assert.equal(endKeys[0][1].status, "done");
  const afterEnd = await call("POST", "/funding/quote", { vault, sid, deployment, ethOut: ETH_OUT, feeTier: TIER });
  assert.equal(afterEnd.status, 409, JSON.stringify(afterEnd.body));
  assert.equal(afterEnd.body.code, "not_live");
  assert.equal(await holderOf(), owner);
});
