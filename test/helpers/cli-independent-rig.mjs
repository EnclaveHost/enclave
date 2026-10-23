// A local Base for the CLI's independent mode (test/cli-independent.test.mjs).
//   - anvil on chain id 8453 with the REAL contracts: the schema-16 ledger and its bandwidth library, the catalog, the
//     payment router, the pinned session factory (Foundry build), and the DEPLOYED schema-4 EnclaveRegistry compiled here
//     from the exact historical source (test/fixtures/registry-schema4, commit b17db9a3). HEAD's schema-5 registry is
//     deployed too, only to prove the CLI refuses it.
//   - three JSON-RPC proxies in front of anvil, each scriptable: ok | down | lie | wrongchain | blackhole-send.
//   - a stand-in Enclave API that answers everything and records every hit (the tests require zero).
//   - optionally the owner-management plane: a real public directory holding a real operator-signed management record,
//     the real management gateway (TLS key pinned by that record) and a supervisor stand-in that verifies the same
//     session signatures with windows/node/session-api-auth.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http as viemHttp, encodeDeployData, getAddress, parseUnits, keccak256, toBytes, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { linkBytecode } from "../../site/js/lib/contract-linker.js";
import { artifactIdentity } from "../../sdk/storage/unixfs.mjs";
import { uploadMessage } from "../../sdk/storage/upload-auth.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "contracts", "foundry", "out");
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",   // anvil #0
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",      // anvil #1: the CLI's wallet
  operator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",   // anvil #2: an independent host operator
  other: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",      // anvil #3: another wallet
};
export const chain = { id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
export function haveTools() {
  try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); execFileSync("openssl", ["version"], { stdio: "ignore" }); }
  catch { return "needs Foundry's anvil and openssl"; }
  if (!fs.existsSync(path.join(OUT, "EnclaveDeployments.sol", "EnclaveDeployments.json"))) return "needs the Foundry build (forge build)";
  return null;
}
export const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const body = (req) => new Promise((ok) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => ok(Buffer.concat(c).toString())); });

/** The deployed schema-4 registry, compiled from the exact historical source with the pinned compiler settings. solc-js
 *  runs in a short-lived child process, so the test runner never holds the compiler's memory. */
let _registry4 = null;
export function compileRegistrySchema4() {
  if (_registry4) return _registry4;
  const script = `
    const solc = require(${JSON.stringify(path.join(REPO, "node_modules/solc"))});
    const content = require("fs").readFileSync(${JSON.stringify(path.join(REPO, "test/fixtures/registry-schema4/EnclaveRegistry.sol"))}, "utf8");
    const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "EnclaveRegistry.sol": { content } },
      settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { EnclaveRegistry: ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
    const c = out.contracts["EnclaveRegistry.sol"].EnclaveRegistry;
    process.stdout.write(JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, runtime: "0x" + c.evm.deployedBytecode.object }));`;
  const c = JSON.parse(execFileSync(process.execPath, ["-e", script], { maxBuffer: 16 << 20, timeout: 120000 }).toString());
  _registry4 = { ...c, linkReferences: {} };
  return _registry4;
}

export async function startRig() {
  const stops = [];
  // Each cleanup is registered the moment its resource exists, and each is bounded: a stuck close never holds the run.
  const stop = async () => {
    while (stops.length) {
      const f = stops.pop();
      try { await Promise.race([Promise.resolve().then(f), new Promise((ok) => setTimeout(ok, 3000).unref())]); } catch {}
    }
  };
  const closeServer = (srv) => () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); });
  try {
    const anvilPort = await freePort();
    // RIG_CHAIN_NODE=reth (opt-in): a canonical-trie dev chain instead of anvil (anvil keeps zero-valued storage slots as
    // trie leaves, which a proof verifier rightly refuses). Pinned reth binary RIG_RETH_BIN, chain id 8453 genesis
    // RIG_RETH_GENESIS (forks through Osaka at genesis, the anvil dev accounts funded), one block per RIG_RETH_BLOCK_TIME,
    // datadir under /tmp (RAM); no discovery, loopback only. evm_* calls are then unavailable (mine() ignores that).
    const reth = process.env.RIG_CHAIN_NODE === "reth";
    const rethData = reth ? fs.mkdtempSync(path.join("/tmp", "rig-reth-")) : null;
    if (reth) stops.push(() => fs.rmSync(rethData, { recursive: true, force: true }));
    const anvil = reth
      ? spawn(process.env.RIG_RETH_BIN, ["node", "--dev", "--dev.block-time", process.env.RIG_RETH_BLOCK_TIME || "2s", "--chain", process.env.RIG_RETH_GENESIS,
          "--datadir", rethData, "--http", "--http.addr", "127.0.0.1", "--http.port", String(anvilPort),
          "--http.api", "eth,net,web3,debug", "--disable-discovery", "--ipcdisable", "--port", "0", "--authrpc.port", String(await freePort()),
          // reth serves eth_getProof only at the tip by default (window 0); a verifier reads confirmed blocks behind it
          "--rpc.eth-proof-window", "1024"], { stdio: "ignore" })
      : spawn("anvil", ["--port", String(anvilPort), "--chain-id", "8453", "--silent", "--base-fee", "0", "--gas-price", "0"], { stdio: "ignore" });
    const killAnvil = () => { try { anvil.kill("SIGKILL"); } catch {} };
    process.once("exit", killAnvil);   // even a crashed test process leaves no chain behind
    stops.push(() => { process.removeListener("exit", killAnvil); killAnvil(); });
    const rpc = `http://127.0.0.1:${anvilPort}`;
    const pc = createPublicClient({ chain, transport: viemHttp(rpc) });
    for (let i = 0; i < (reth ? 600 : 100); i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const wc = (key) => createWalletClient({ chain, account: privateKeyToAccount(key), transport: viemHttp(rpc) });
    const dep = wc(KEYS.deployer);
    const deploy = async (a, args = [], libs = {}) => {
      const bytecode = Object.keys(a.linkReferences).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
      const hash = await dep.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }) });
      const rc = await pc.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error("deploy failed");
      return getAddress(rc.contractAddress);
    };
    const write = async (who, address, abi, functionName, args) => {
      const hash = await who.writeContract({ address, abi, functionName, args });
      const rc = await pc.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(functionName + " reverted");
      return rc;
    };
    const A = { usdc: art("SessionMocks.sol", "MockUSDC3009"), registry5: art("EnclaveRegistry.sol", "EnclaveRegistry"), registry4: compileRegistrySchema4(),
      ledger: art("EnclaveDeployments.sol", "EnclaveDeployments"), bandwidth: art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"),
      catalog: art("EnclaveAppCatalog.sol", "EnclaveAppCatalog"), router: art("PaymentRouter.sol", "PaymentRouter"),
      svlib: art("SessionVault.sol", "SessionVaultLib"), factory: art("PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory"),
      vault: art("SessionVault.sol", "SessionVault") };
    const treasury = "0x00000000000000000000000000000000000e2e01";
    const usdc = await deploy(A.usdc);
    const registry = await deploy(A.registry4);
    const registry5 = await deploy(A.registry5);
    const bw = await deploy(A.bandwidth);
    const ledger = await deploy(A.ledger, [usdc, treasury, registry, "0x0000000000000000000000000000000000000000"],
      { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bw });
    await write(dep, ledger, A.ledger.abi, "setProofRequiredFrom", [0n]);
    // ETH funding: a fresh $3000/ETH feed (the Foundry suite's MockFeed), so fundEth is live on this ledger
    const feed = await deploy(art("EnclaveDeployments.multicallValue.t.sol", "MockFeed"));
    await write(dep, ledger, A.ledger.abi, "setEthUsdFeed", [feed]);
    const catalog = await deploy(A.catalog);
    const router = await deploy(A.router, [usdc, treasury]);
    const svlib = await deploy(A.svlib);
    const factory = await deploy(A.factory, [usdc, ledger, catalog, router, "0x0000000000000000000000000000000000000000", parseUnits("1000", 6)],
      { "contracts/SessionVault.sol:SessionVaultLib": svlib });
    const owner = privateKeyToAccount(KEYS.owner).address, operator = privateKeyToAccount(KEYS.operator).address, other = privateKeyToAccount(KEYS.other).address;
    for (const who of [owner, other]) await write(dep, usdc, A.usdc.abi, "mint", [who, parseUnits("100", 6)]);
    // an independent host on the schema-4 registry: open registration, $0.001/s per whole node, no proof key (proofs off)
    const endpoint = "https://host.independent.test";
    await write(wc(KEYS.operator), registry, A.registry4.abi, "register", [endpoint, "independent/host", "0x" + "00".repeat(32), 1000n, 0n,
      "0x0000000000000000000000000000000000000000"]);
    const runner = keccak256(toBytes(endpoint));
    // a catalog app (the catalog owner's own publish is approved on publish)
    await write(dep, catalog, A.catalog.abi, "publishVersion", ["hello", "Hello", "a test app", "1", "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      [0, 0, 64, 1], "http:8080", "{}", 0n]);
    await write(dep, catalog, A.catalog.abi, "publishVersion", ["hello", "Hello", "a test app", "2", "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      [0, 0, 64, 1], "http:8080", "{}", 0n]);
    const appId = await pc.readContract({ address: catalog, abi: A.catalog.abi, functionName: "appIdOf", args: [privateKeyToAccount(KEYS.deployer).address, "hello"] });
    // a Shield app whose catalog CID is the CID of real component bytes (the host derives the partition AppID from them)
    // a wasm COMPONENT preamble (\0asm, layer 1): the Shield derivation refuses core modules
    const component = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]), Buffer.from(" cli-independent shield fixture component")]);
    const componentCid = artifactIdentity(new Uint8Array(component)).cid;
    await write(dep, catalog, A.catalog.abi, "publishVersion", ["shieldapp", "Shield app", "a Shield test app", "1", componentCid,
      [0, 0, 64, 1], "http:8080", "{}", 0n]);
    const shieldAppId = await pc.readContract({ address: catalog, abi: A.catalog.abi, functionName: "appIdOf", args: [privateKeyToAccount(KEYS.deployer).address, "shieldapp"] });
    const appRef = `catalog://${appId}/0`;
    const create = (who, { maxRate = 100000n } = {}) => write(wc(who), ledger, A.ledger.abi, "create",
      [appRef, 0, 100, 8080, "http:8080", true, "", "0x0000000000000000000000000000000000000000", 0n, maxRate]);
    const CREATED = "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239";   // Created(bytes32,address,string,uint16,uint16,uint256)
    const createdId = (rc) => rc.logs.find((l) => l.address.toLowerCase() === ledger.toLowerCase() && l.topics[0] === CREATED).topics[1];

    // ---- three JSON-RPC origins in front of the chain ----
    const rpcModes = {}, rpcLog = [];
    const rpcs = [];
    for (const i of [0, 1, 2]) {
      const port = await freePort();
      const srv = http.createServer(async (req, res) => {
        const mode = rpcModes[i] || "ok";
        if (mode === "down") { res.writeHead(503); return res.end(); }
        const raw = await body(req);
        let q; try { q = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
        for (const m of [q].flat()) rpcLog.push({ i, method: m.method, to: m.params?.[0]?.to?.toLowerCase?.() ?? null });
        if (mode === "blackhole-send" && [q].flat().some((m) => m.method === "eth_sendRawTransaction")) {
          await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: raw });   // it DOES reach the chain…
          res.writeHead(502); return res.end();                                                              // …but the answer is lost
        }
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
        let text = await r.text();
        if (mode === "lie" || mode === "wrongchain") {
          const answers = [JSON.parse(text)].flat(), qs = [q].flat();
          answers.forEach((j, k) => {
            const m = qs[k]?.method;
            if (mode === "lie" && m === "eth_call" && typeof j.result === "string" && j.result.length > 66) j.result = j.result.slice(0, -2) + (j.result.endsWith("00") ? "01" : "00");
            if (mode === "wrongchain" && m === "eth_chainId") j.result = "0x1";
          });
          text = JSON.stringify(Array.isArray(JSON.parse(text)) ? answers : answers[0]);
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end(text);
      });
      stops.push(closeServer(srv));
      await new Promise((ok) => srv.listen(port, "127.0.0.1", ok));
      rpcs.push(`http://127.0.0.1:${port}`);
    }
    // ---- a stand-in Enclave API: it would answer, so any request reaching it is a real call ----
    const apiHits = [];
    const api = http.createServer((req, res) => { apiHits.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    stops.push(closeServer(api));
    const apiPort = await freePort();
    await new Promise((ok) => api.listen(apiPort, "127.0.0.1", ok));
    // anvil mines on demand: keep blocks coming so the agreed block stays recent and confirmations advance
    const rpcCall = (method, params = []) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json()).then((j) => j.result);
    const mine = () => rpcCall("evm_mine").catch(() => {});
    // setMining(false): nothing mines (no automine, no interval blocks) until setMining(true): a release sits in the mempool
    let mining = true;
    const setMining = async (on) => { mining = on; await rpcCall("evm_setAutomine", [on]); if (on) await mine(); };
    const miner = setInterval(() => { if (mining) mine(); }, 500);
    stops.push(() => clearInterval(miner));
    for (let i = 0; i < 4; i++) await mine();
    const pins = { version: 1, chainId: 8453, contracts: { registry: registry.toLowerCase(), deployments: ledger.toLowerCase(), appCatalog: catalog.toLowerCase(),
      proofOfTime: ledger.toLowerCase(), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
      sessionVaultFactory: factory.toLowerCase(), secretVaultV2: "0x" + "00".repeat(20) } };
    return { stop, stops, closeServer, rpc, pc, wc, write, deploy, mine, setMining, rpcCall, A, rpcs, rpcModes, rpcLog, apiHits, apiOrigin: `http://127.0.0.1:${apiPort}`, apiPort,
      addresses: { usdc, registry, registry5, ledger, catalog, router, factory, bw, feed }, owner, operator, other, endpoint, runner, appId, appRef, create, createdId, pins,
      component, componentCid, shieldAppId };
  } catch (e) { await stop(); throw e; }
}

// A public literal address for the signed management record (the convention test/management-plane.test.mjs uses);
// nothing ever connects to it: the network guard maps exactly this address to the loopback gateway or refuses.
export const PUBLIC_MANAGEMENT = Object.freeze({ address: "8.8.4.4", port: 8443 });
/** The owner-management plane for one vault-held, leased deployment: directory + operator-signed record + gateway.
 *  host: which registered host this is (default the rig's runner and its operator key). upstream/upstreamToken: put an
 *  ACTUAL supervisor behind the gateway instead of the stand-in. gateway: extra gateway options (e.g. recheckMs). */
export async function startManagement(r, { id, dir, host = { runner: r.runner, key: KEYS.operator, endpoint: r.endpoint }, address = PUBLIC_MANAGEMENT,
  upstream = null, upstreamToken = null, gateway: gatewayOptions = {} }) {
  const { createManagementGateway } = await import("../../network/management-gateway.mjs");
  const { managementRecord } = await import("../../network/management-host.mjs");
  const { signManagementRecord, managementBase } = await import("../../network/management-record.mjs");
  const { managementRoute } = await import("../../network/management-routes.mjs");
  const { PublicDirectory } = await import("../../network/public-directory.mjs");
  const { createDirectoryServer } = await import("../../network/directory-server.mjs");
  const { LeaseReader } = await import("../../network/lease-reader.mjs");
  const { createSessionApiAuth, apiBases } = await import("../../windows/node/session-api-auth.mjs");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=host-management", "-days", "1",
    "-keyout", dir + "/mkey", "-out", dir + "/mcert"], { stdio: "ignore" });
  const tls = { key: fs.readFileSync(dir + "/mkey"), cert: fs.readFileSync(dir + "/mcert") };
  const pins = { deployments: r.addresses.ledger.toLowerCase(), registry: r.addresses.registry.toLowerCase(), connectivity: "0x" + "00".repeat(20),
    sessionVaultFactory: r.addresses.factory.toLowerCase() };
  // the supervisor stand-in: the same session verifier and owner rule the real supervisor applies
  const hits = [], mode = {}, chainEffects = [];
  let restarts = 0;
  const auth = createSessionApiAuth({ pc: r.pc, authorityPins: { deployments: pins.deployments, sessionVaultFactory: pins.sessionVaultFactory },
    bases: () => apiBases({ hosts: [managementBase(host.runner)], publicUrls: [host.endpoint] }) });
  // the host's own operator transactions, real on the rig's chain (release is runner-only; claim needs this registry entry)
  const operatorTx = async (fn, args) => { const rc = await r.write(r.wc(host.key), r.addresses.ledger, r.A.ledger.abi, fn, args); chainEffects.push(fn); return rc; };
  const supervisor = http.createServer(async (req, res) => {
    hits.push(req.method + " " + req.url);
    const b = Buffer.from(await body(req));
    const route = managementRoute(req.method, req.url);
    const json = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!route) return json(404, { error: "not_found" });
    try {
      const s = await auth.verify({ header: req.headers.authorization, method: req.method, path: req.url, body: b, scope: route.scope, fresh: true });
      const d = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
      const why = await auth.refusal(s, { id, owner: d.owner });
      if (why) return json(403, { code: "not_allowed", message: why });
    } catch (e) { return json(e.status || 401, { code: "unauthorized", message: e.message }); }
    if (route.op === "status") return json(200, { id, status: "running", note: "stand-in supervisor" });
    if (route.op === "attestation") return json(200, { deploymentId: id, cpu: { format: "fixture-not-snp" } });
    if (route.op === "logs") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("# status=running\nline two\n"); }
    if (route.op === "appToken") return json(200, { token: "app-origin-token", tokenType: "Cookie", deployment: id, expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    if (route.op === "cpuProfile") return json(200, { state: "complete", seconds: 5, format: "gperftools", bytes: 4, data: Buffer.from("prof").toString("base64") });
    if (route.op === "gpu") return mode.gpu === "none" ? json(404, { error: "no_gpu", message: "This is a CPU-only enclave: no GPU is attached." })
      : json(200, { role: "host", mpsActive: true, smTotal: 132, capacity: { gpuShareFree: 0.5, vramFreeGb: 40, smFree: 66 },
        tenants: [{ pct: 50, status: "running", smGranted: 66 }] });
    if (route.op === "cpuProfileControl") return json(200, { state: "active", seconds: 5, format: "gperftools", oneCapturePerProcess: true });
    // release: the real runner-only release(), answered only after its receipt ("drop": the answer is lost after it lands;
    // "slow": answered 1.5 s after it lands, while the gateway's re-authorization would already see the lease gone)
    if (route.op === "release") {
      const rc = await operatorTx("release", [route.deploymentId]);
      if (mode.release === "drop") return req.socket.destroy();
      if (mode.release === "slow") await new Promise((ok) => setTimeout(ok, 1500));
      return json(200, { id: route.deploymentId, released: true, status: "released", txHash: rc.transactionHash, standDownSec: 120 });
    }
    // claimHint: the real claim() from this host's operator, or a decline
    if (route.op === "claimHint") {
      if (mode.claim === "decline") return json(200, { accepted: false, reason: "stand-in declines" });
      try { await operatorTx("claim", [route.deploymentId, host.runner]); return json(200, { accepted: true, status: "claiming" }); }
      catch (e) { return json(200, { accepted: false, reason: "claim would revert on-chain: " + String(e.shortMessage || e.message).slice(0, 120) }); }
    }
    restarts++;
    if (mode.restart === "drop") return req.socket.destroy();
    return json(200, { id, status: "running", note: "Restarted in place" });
  });
  r.stops.push(r.closeServer(supervisor));
  if (!upstream) await new Promise((ok) => supervisor.listen(0, "127.0.0.1", ok));
  // network/lease-reader.mjs counts a client by its exposed HTTPS URL; these loopback HTTP peers are distinct origins, handed
  // over as plain delegates (counted by object identity), exactly as cli/independent.mjs leaseReaderClients does
  const viemClients = r.rpcs.map((u) => createPublicClient({ chain, transport: viemHttp(u, { retryCount: 0 }) }))
    .map((c) => Object.fromEntries(["getChainId", "getBlockNumber", "getBlock", "readContract", "getCode", "getStorageAt", "call", "multicall"]
      .map((k) => [k, c[k].bind(c)])));
  const gatewayReader = new LeaseReader({ clients: viemClients, chainId: 8453, addressBook: "0x" + "00".repeat(20), authorityPins: pins, confirmations: 1 });
  const gateway = createManagementGateway({ tls, runner: host.runner, pins, reader: gatewayReader, upstream: upstream || `http://127.0.0.1:${supervisor.address().port}`,
    ...(upstreamToken ? { upstreamToken } : {}), ...gatewayOptions });
  let gatewayRequests = 0;
  gateway.on("request", () => gatewayRequests++);
  r.stops.push(r.closeServer(gateway));
  await new Promise((ok) => gateway.listen(0, "127.0.0.1", ok));
  const operator = privateKeyToAccount(host.key);
  const directory = new PublicDirectory({ directory: dir + "/directory", checkers: ["0x" + "03".repeat(20)],
    hostOperator: async (x) => (x === host.runner ? operator.address : null), leaseOf: async () => null, verifyOwner: async () => false, importManagement: true });
  const directoryServer = createDirectoryServer(directory);
  r.stops.push(r.closeServer(directoryServer));
  await new Promise((ok) => directoryServer.listen(0, "127.0.0.1", ok));
  // The record names a PUBLIC literal address, as production validation requires. Only the CLI process under test maps
  // exactly that address to the local gateway (test/helpers/cli-network-guard.mjs ENCLAVE_TEST_ROUTE).
  const record = managementRecord({ operator: operator.address, runner: host.runner, deployments: pins.deployments, ...address,
    cert: tls.cert, now: Date.now() });
  await directory.accept("management", await signManagementRecord(operator, record));
  return { directoryOrigin: `http://127.0.0.1:${directoryServer.address().port}`, hits, mode, restarts: () => restarts, chainEffects,
    gatewayRequests: () => gatewayRequests, record,
    route: `${address.address}:${address.port}=127.0.0.1:${gateway.address().port}` };
}

/** A SessionVault session opened by the owner on the pinned factory, stored where the CLI keeps sessions. */
export async function openSession(r, { sessionDir, actions = ["api.status", "api.logs", "api.restart", "api.appAccess"] }) {
  const S = await import("../../sdk/sessions/dist/node.mjs");
  const owner = privateKeyToAccount(KEYS.owner);
  const kp = await S.generateKeyPair(true);
  const { x, y } = await S.publicKeyXY(kp.publicKey);
  const keyHash = S.keyHashOf(x, y);
  const grant = S.buildGrant({ label: "cli-test", sessionKey: keyHash, policy: { actions, apps: ["*"], environments: ["staging", "prod"], budget: 0n,
    spendPerPeriod: 0n, periodSeconds: 86400, opsPerPeriod: 0, maxFeePerOp: 0n, maxAppFeePerHour: 0n, maxRatePerHour: 0n, expiresIn: 3600 } });
  const tx = await S.prepareSessionOpen({ publicClient: r.pc, factory: r.addresses.factory, owner, chainId: 8453, grant });
  const rc = await r.pc.waitForTransactionReceipt({ hash: await r.wc(KEYS.owner).sendTransaction({ to: tx.to, data: tx.data }) });
  if (rc.status !== "success") throw new Error("session open reverted");
  const handle = { chainId: 8453, vault: tx.vault, sid: tx.sid, owner: owner.address, relay: "", rpc: r.rpc };
  const store = new S.FileStore(sessionDir);
  await store.save({ v: 1, id: tx.sid, handle, relay: "", chainId: 8453, x: "0x" + x.toString(16), y: "0x" + y.toString(16), keyHash, label: "cli-test",
    grant, createdAt: Date.now(), pkcs8: await S.exportPrivateKey(kp.privateKey) });
  store.setActive(tx.sid);
  const ownerOp = async (op) => {
    const p = await S.prepareOwnerOperation({ publicClient: r.pc, chainId: 8453, vault: tx.vault, op, mode: "direct", owner });
    const c = await r.pc.waitForTransactionReceipt({ hash: await r.wc(KEYS.owner).sendTransaction({ to: p.to, data: p.data }) });
    if (c.status !== "success") throw new Error(op.op + " reverted");
  };
  // a deployment the VAULT holds (created through the owner's direct vault call), adopted into production
  const createViaVault = async () => {
    const data = encodeFunctionData({ abi: r.A.ledger.abi, functionName: "create",
      args: [r.appRef, 0, 100, 8080, "http:8080", false, "", "0x0000000000000000000000000000000000000000", 0n, 100000n] });
    const c = await r.write(r.wc(KEYS.owner), tx.vault, r.A.vault.abi, "ownerCall", [r.addresses.ledger, data]);
    const id = r.createdId(c);
    await ownerOp({ op: "adopt", deployment: id, environment: "prod" });
    return id;
  };
  return { vault: tx.vault, sid: tx.sid, ownerOp, createViaVault };
}

/** Three HTTPS storage adapters (127.0.0.1, localhost, 127.0.0.2) that verify the wallet upload signature as the real
 *  adapter does and serve the bytes back by CID. The CLI trusts their self-signed certificate through NODE_EXTRA_CA_CERTS. */
export async function startStorage(r, { dir }) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-keyout", path.join(dir, "sk.pem"), "-out", path.join(dir, "sc.pem"), "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2"], { stdio: "ignore" });
  const tls = { key: fs.readFileSync(path.join(dir, "sk.pem")), cert: fs.readFileSync(path.join(dir, "sc.pem")) };
  const modes = {}, held = [new Map(), new Map(), new Map()], uploads = [], replicas = [];
  for (const [i, host] of [[0, "127.0.0.1"], [1, "localhost"], [2, "127.0.0.2"]]) {
    const audience = "0x" + String(i + 1).padStart(2, "0").repeat(32);
    const srv = https.createServer(tls, async (req, res) => {
      const send = (status, b, headers = {}) => { res.writeHead(status, headers); res.end(b); };
      const u = new URL(req.url, "https://x");
      if (req.method === "POST" && /^\/add-(wasm|json|image|file)$/.test(u.pathname)) {
        const chunks = []; for await (const c of req) chunks.push(c);
        const bytes = Buffer.concat(chunks);
        if (modes[i] === "refuse") return send(507, '{"error":"storage full"}', { "content-type": "application/json" });
        const h = req.headers, sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
        try {
          if (h["x-upload-sha256"] !== sha || Number(h["x-upload-expiry"]) < Date.now() / 1000) throw new Error("scope");
          const msg = uploadMessage({ audience, path: u.pathname, address: h["x-upload-address"], hash: sha, size: bytes.length, expiry: Number(h["x-upload-expiry"]) });
          if ((await recoverMessageAddress({ message: msg, signature: h["x-upload-signature"] })).toLowerCase() !== h["x-upload-address"]) throw new Error("signer");
        } catch (e) { return send(401, JSON.stringify({ error: "upload authorization refused: " + e.message }), { "content-type": "application/json" }); }
        const { cid } = artifactIdentity(new Uint8Array(bytes));
        held[i].set(cid, bytes); uploads.push({ adapter: i, path: u.pathname, cid, signer: h["x-upload-address"], bytes: bytes.length });
        return send(200, JSON.stringify({ cid }), { "content-type": "application/json" });
      }
      const m = /^\/ipfs\/([a-z0-9]+)$/.exec(u.pathname);
      if (req.method === "GET" && m) {
        if (modes[i] === "down") return send(503, "down");
        const b = held[i].get(m[1]); if (!b) return send(404, "not held");
        const rg = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
        if (!rg) return send(200, b, { "content-type": "application/octet-stream", "content-length": String(b.length) });
        const a = Number(rg[1]), e = Math.min(Number(rg[2]), b.length - 1);
        return send(206, b.subarray(a, e + 1), { "content-range": `bytes ${a}-${e}/${b.length}`, "content-length": String(e - a + 1) });
      }
      send(404, "no");
    });
    r.stops.push(r.closeServer(srv));
    const port = await freePort();
    await new Promise((ok) => srv.listen(port, host === "localhost" ? "127.0.0.1" : host, ok));
    replicas.push({ upload: `https://${host}:${port}/add-json`, audience, gateway: `https://${host}:${port}/ipfs` });
  }
  const plan = { version: 1, minimumCopies: 2, replicas };
  fs.writeFileSync(path.join(dir, "storage-plan.json"), JSON.stringify(plan));
  return { plan, planFile: path.join(dir, "storage-plan.json"), caFile: path.join(dir, "sc.pem"), modes, held, uploads };
}

/** The ACTUAL supervisor.js (unmodified, no self-test seam) as the host that holds `id`'s lease, on the rig's chain:
 *  BASE_RPC is anvil itself, the pins are the rig's contracts, REGISTRY_PRIVATE_KEY is the host's operator key (it signs
 *  the real release), PUBLIC_URL is the registered endpoint (so its management base is this runner's), and the app
 *  manager is a local stub whose DELETE can be told to fail. Every non-loopback fetch is refused (loopback-only-fetch).
 *  Options for the release tests (test/move-release-durable.test.mjs), all off by default:
 *    rpc: BASE_RPC (a test proxy instead of anvil); claim: the real claim loop (registration, a loopback attestation
 *    document whose format names SEV-SNP so teeOk() holds, CLAIM_POLL_SEC 2); env: extra environment; stateFile + seed:
 *    reuse a state file across a restart (seed false keeps it as the previous process left it); script: another
 *    supervisor file (the pre-fix copy for a negative control); appRef: the seeded record's app (default the rig's).
 *    mode.deleteDelayMs slows the manager's DELETE. */
export async function startActualHost(r, { id, owner, dir, token, host = { key: KEYS.operator, endpoint: r.endpoint }, leaseUntil,
  rpc = r.rpc, claim = false, env = {}, stateFile = null, seed = true, script = "supervisor.js", appRef = r.appRef,
  preload = path.join(REPO, "test/helpers/loopback-only-fetch.mjs") }) {
  const effects = [], mode = {}, vmId = "vm-move-1";
  const manager = http.createServer(async (req, res) => {
    const raw = await body(req);
    const json = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const u = new URL(req.url, "http://manager.local");
    if (req.method === "DELETE" && u.pathname.startsWith("/vms/")) {
      if (mode.deleteDelayMs) await new Promise((ok) => setTimeout(ok, mode.deleteDelayMs));
      effects.push({ delete: u.pathname.slice(5), refused: mode.stop === "fail" });
      return mode.stop === "fail" ? json(500, { error: "manager busy" }) : json(200, {});
    }
    if (req.method === "POST" && u.pathname === "/vms") {
      let name = null; try { name = JSON.parse(raw).name || null; } catch {}
      effects.push({ launched: true, name, at: Date.now() });   // name: the deployment id the supervisor launches
      return json(201, { id: vmId, hostPort: 0, status: "running" });
    }
    if (req.method === "GET" && u.pathname === "/vms") return json(200, mode.stop === "fail" ? [{ id: vmId, name: id, status: "running" }] : []);
    if (req.method === "GET" && u.pathname.startsWith("/vms/")) return json(200, { id: vmId, status: "running" });
    return json(200, { ok: true });
  });
  r.stops.push(r.closeServer(manager));
  await new Promise((ok) => manager.listen(0, "127.0.0.1", ok));
  let attestation = "";
  if (claim) {
    // the format is all teeOk() reads; the report bytes are a zero fixture (nothing here verifies them)
    const rad = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ format: "https://Cloud Provider.sh/predicate/sev-snp-guest/v2", body: Buffer.alloc(0x400).toString("base64") })); });
    r.stops.push(r.closeServer(rad));
    await new Promise((ok) => rad.listen(0, "127.0.0.1", ok));
    attestation = `http://127.0.0.1:${rad.address().port}/rad`;
  }
  const pinFile = path.join(dir, "pins.json");
  stateFile = stateFile || path.join(dir, "state.json");
  fs.writeFileSync(pinFile, JSON.stringify(r.pins));
  if (seed) fs.writeFileSync(stateFile, JSON.stringify({ savedAt: Date.now(), deployments: [{ id, owner: getAddress(owner), status: "running", public: false,
    firewall: [], image: { reference: appRef }, command: [], config: "", resources: { cpuShare: 0.1, gpuShare: 0 },
    network: { port: 8080, protocol: "https" }, remainingMs: null, _vmId: vmId, _port: 0, startedAt: Date.now(), createdAt: new Date().toISOString(),
    _onchain: true, _ledger: r.addresses.ledger, _leaseUntil: Number(leaseUntil) }] }));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", preload, script], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: dir, SECRET: "move-fixture-secret", PORT: String(port), ENABLE_MPS: "0", STATE_FILE: stateFile, GPU_COUNT: "0",
      PROVISION_BACKEND: "vm", VMMGR_URL: `http://127.0.0.1:${manager.address().port}`, BASE_RPC: rpc, ENCLAVE_CONTRACT_PINS_FILE: pinFile,
      ADDRESS_BOOK_ADDRESS: "", PUBLIC_URL: host.endpoint, REGISTRY_PRIVATE_KEY: host.key, MANAGEMENT_GATEWAY: "1", MANAGEMENT_GATEWAY_TOKEN: token,
      MOVE_HOLDOFF_SEC: "30", SECRETS_API: "", DOMAINS_API: "", CERTS_API: "", DNS_API: "", APP_CERT_DOMAIN: "",
      ...(claim ? { CLAIM_ENABLED: "1", REGISTRY_ENABLED: "1", ENCLAVE_REPO: "independent/host", CLAIM_POLL_SEC: "2", ATTESTATION_URL: attestation,
        SELL_CPU_PRICE6: "1000", REGISTRY_HEARTBEAT_SEC: "3600", CPU_CLAIM_GRACE_SEC: "0" } : { CLAIM_ENABLED: "", REGISTRY_ENABLED: "" }),
      ...env },
  });
  const kill = () => { try { child.kill("SIGKILL"); } catch {} };
  process.once("exit", kill);
  r.stops.push(() => { process.removeListener("exit", kill); kill(); });
  let out = "";
  child.stdout.on("data", (d) => { out = (out + d).slice(-400000); });
  child.stderr.on("data", (d) => { out = (out + d).slice(-400000); });
  const exited = new Promise((ok) => child.once("exit", ok));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the supervisor did not start:\n" + out.slice(-2000))), 30000);
    const check = () => { if (out.includes(`enclave supervisor on :${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", check); child.stderr.on("data", check);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the supervisor exited ${code}:\n` + out.slice(-2000))); });
  });
  /** resolves when the supervisor's output matches `re` (searching from `from`, an offset of stdout()), or rejects */
  const waitLog = (re, ms = 30000, from = 0) => new Promise((ok, no) => {
    const t0 = Date.now();
    const tick = () => { const m = re.exec(out.slice(from)); if (m) return ok(m);
      if (Date.now() - t0 > ms) return no(new Error(`no ${re} in the supervisor's output within ${ms} ms:\n` + out.slice(-3000)));
      setTimeout(tick, 100); };
    tick();
  });
  return { port, upstream: `http://127.0.0.1:${port}`, effects, mode, stdout: () => out, stateFile, waitLog,
    kill: async () => { kill(); await exited; } };
}
