// Local rig for the independent dashboard browser test (test/site-independent-browser.test.mjs):
//   anvil on Base's chain id with the REAL ledger (contracts/EnclaveDeployments.sol, schema 16), registry, catalog,
//   payment router and pinned session factory from the Foundry build; three CORS JSON-RPC proxies to it (one can be
//   told to lie or to go down); three HTTPS storage adapters that verify the deployment-bound wallet signature exactly
//   as the real adapter does and serve byte ranges back (one can refuse); a REAL public network directory; and a
//   static server for the unbundled site. Nothing here is an Enclave service, and the test refuses every
//   *.enclave.host request in the browser.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createPublicClient, createWalletClient, http as viemHttp, encodeDeployData, getAddress, parseUnits, recoverMessageAddress, hashMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { linkBytecode } from "../../site/js/lib/contract-linker.js";
import { artifactIdentity } from "../../sdk/storage/unixfs.mjs";
import { uploadMessage, accountUploadMessage, ACCOUNT_UPLOAD_SCHEME } from "../../site/js/core/upload-auth.js";
import { PublicDirectory } from "../../network/public-directory.mjs";
import solc from "solc";

// A Chainlink-shaped ETH/USD feed for the local chain (test-only source compiled here, never a repository contract):
// 8 decimals like the live feed, with a setter so tests can make it stale, unfinished or mis-scaled.
const FEED_SOURCE = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract TestEthUsdFeed {
  uint8 public decimals = 8; int256 public answer = 2400e8; uint256 public updatedAt; uint80 public roundId = 7; uint80 public answeredInRound = 7;
  constructor() { updatedAt = block.timestamp; }
  function set(int256 a, uint256 u, uint80 r, uint80 ar, uint8 d) external { answer = a; updatedAt = u; roundId = r; answeredInRound = ar; decimals = d; }
  function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (roundId, answer, updatedAt, updatedAt, answeredInRound); }
}`;
function feedArtifact(){
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "Feed.sol": { content: FEED_SOURCE } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["Feed.sol"].TestEthUsdFeed;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, linkReferences: {} };
}
import { createDirectoryServer } from "../../network/directory-server.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const OUT = path.join(REPO, "contracts", "foundry", "out");
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",   // anvil #0
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",      // anvil #1: the browser wallet
  operator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",   // anvil #2: an independent host operator
  operator2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",  // anvil #4: a second host operator
};
export const chain = { id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };

export function haveTools(){
  try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); execFileSync("openssl", ["version"], { stdio: "ignore" }); }
  catch { return "needs Foundry's anvil and openssl"; }
  if (!fs.existsSync(path.join(OUT, "EnclaveDeployments.sol", "EnclaveDeployments.json"))) return "needs the Foundry build (forge build)";
  return null;
}
export const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, range, cache-control, x-upload-address, x-upload-expiry, x-upload-sha256, x-upload-signature, x-upload-scheme, x-upload-nonce",
  "access-control-expose-headers": "content-range, content-length" };

export async function startRig({ log = () => {}, legacySessionFactory = false } = {}){
  const stops = [];
  const stop = async () => { for (const f of stops.reverse()) { try { await f(); } catch {} } };
  try {
    // ---- chain + contracts ----
    const anvilPort = await freePort();
    const anvil = spawn("anvil", ["--port", String(anvilPort), "--chain-id", "8453", "--silent", "--base-fee", "0", "--gas-price", "0"], { stdio: "ignore" });
    stops.push(() => anvil.kill("SIGKILL"));
    const rpc = `http://127.0.0.1:${anvilPort}`;
    const pc = createPublicClient({ chain, transport: viemHttp(rpc) });
    for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
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
    const A = { usdc: art("SessionMocks.sol", "MockUSDC3009"), registry: art("EnclaveRegistry.sol", "EnclaveRegistry"),
      ledger: art("EnclaveDeployments.sol", "EnclaveDeployments"), bandwidth: art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"),
      catalog: art("EnclaveAppCatalog.sol", "EnclaveAppCatalog"), router: art("PaymentRouter.sol", "PaymentRouter"),
      svlib: art("SessionVault.sol", "SessionVaultLib"), factory: art("PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory") };
    const treasury = "0x00000000000000000000000000000000000e2e01";
    const usdc = await deploy(A.usdc);
    const registry = await deploy(A.registry);
    const bw = await deploy(A.bandwidth);
    A.feed = feedArtifact();
    const feed = await deploy(A.feed);
    const ledger = await deploy(A.ledger, [usdc, treasury, registry, feed],
      { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bw });
    await write(dep, ledger, A.ledger.abi, "setProofRequiredFrom", [0n]);
    const catalog = await deploy(A.catalog);
    const router = await deploy(A.router, [usdc, treasury]);
    const svlib = await deploy(A.svlib);
    let book = null;
    if (legacySessionFactory) {
      A.book = art("EnclaveAddressBook.sol", "EnclaveAddressBook");
      book = await deploy(A.book);
      for (const [key,value] of [["registry",registry],["deployments",ledger],["appCatalog",catalog]])
        await write(dep, book, A.book.abi, "set", ["0x"+Buffer.from(key).toString("hex").padEnd(64,"0"),value]);
      A.factory = art("SessionVault.sol", "SessionVaultFactory");
    }
    const factory = await deploy(A.factory, legacySessionFactory
      ? [usdc, book, router, "0x0000000000000000000000000000000000000000", parseUnits("1000", 6)]
      : [usdc, ledger, catalog, router, "0x0000000000000000000000000000000000000000", parseUnits("1000", 6)],
      { "contracts/SessionVault.sol:SessionVaultLib": svlib });
    const owner = privateKeyToAccount(KEYS.owner).address, operator = privateKeyToAccount(KEYS.operator).address;
    await write(dep, usdc, A.usdc.abi, "mint", [owner, parseUnits("100", 6)]);
    // an independent host: open registration, its own price ($0.001/s for a whole node), no proof key (proofs off)
    const endpoint = "https://host.independent.test";
    await write(wc(KEYS.operator), registry, A.registry.abi, "register", [endpoint, "independent/host", "0x" + "00".repeat(32), 1000n, 0n,
      "0x0000000000000000000000000000000000000000"]);
    // a second, dearer independent host (anvil #4) for explicit host selection
    const endpoint2 = "https://host-b.independent.test";
    await write(wc(KEYS.operator2), registry, A.registry.abi, "register", [endpoint2, "independent/host-b", "0x" + "00".repeat(32), 3000n, 0n,
      "0x0000000000000000000000000000000000000000"]);

    // ---- three JSON-RPC origins in front of the chain ----
    const rpcModes = {};
    const rpcs = [];
    for (const [i, host] of [[0, "127.0.0.1"], [1, "localhost"], [2, "127.0.0.1"]]){
      const port = await freePort();
      const srv = http.createServer(async (req, res) => {
        if (req.method === "OPTIONS"){ res.writeHead(204, cors); return res.end(); }
        const mode = rpcModes[i] || "ok";
        if (mode === "down"){ res.writeHead(503, cors); return res.end(); }
        const body = await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
        let text = await r.text();
        if (mode === "lie"){
          const j = JSON.parse(text), q = JSON.parse(body);
          if (q.method === "eth_call" && typeof j.result === "string" && j.result.length > 66) j.result = j.result.slice(0, -2) + (j.result.endsWith("00") ? "01" : "00");
          text = JSON.stringify(j);
        }
        res.writeHead(200, { ...cors, "content-type": "application/json" }); res.end(text);
      });
      await new Promise((ok) => srv.listen(port, host === "localhost" ? "127.0.0.1" : host, ok));
      stops.push(() => new Promise((ok) => srv.close(ok)));
      rpcs.push(`http://${host}:${port}`);
    }

    // ---- three HTTPS storage adapters ----
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ind-rig-"));
    stops.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
      "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"), "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2"], { stdio: "ignore" });
    const tls = { key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")) };
    const adapterModes = {}, held = [new Map(), new Map(), new Map()], uploads = [], usedNonces = new Set();
    const replicas = [];
    for (const [i, host] of [[0, "127.0.0.1"], [1, "localhost"], [2, "127.0.0.2"]]){
      const port = await freePort();
      const audience = "0x" + String(i + 1).padStart(2, "0").repeat(32);
      const srv = https.createServer(tls, async (req, res) => {
        const send = (status, body, headers = {}) => { res.writeHead(status, { ...cors, ...headers }); res.end(body); };
        if (req.method === "OPTIONS") return send(204);
        const u = new URL(req.url, "https://x");
        if (req.method === "POST" && /^\/add-(wasm|json|image|file)$/.test(u.pathname)){
          const chunks = []; for await (const c of req) chunks.push(c);
          const bytes = Buffer.concat(chunks);
          if (adapterModes[i] === "refuse") return send(507, '{"error":"storage full"}', { "content-type": "application/json" });
          const h = req.headers, sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
          try {
            if (h["x-upload-sha256"] !== sha || Number(h["x-upload-expiry"]) < Date.now() / 1000) throw new Error("scope");
            if (h["x-upload-scheme"] === ACCOUNT_UPLOAD_SCHEME){
              // a smart account (upload v2): the rig asks the account's own contract, as the real adapter does through its
              // pinned readers (s3-ipfs-adapter src/account_upload.rs; test/site-independent-account-upload-adapter.test.mjs)
              if (usedNonces.has(h["x-upload-address"] + ":" + h["x-upload-nonce"])) throw new Error("replayed");
              const msg = accountUploadMessage({ chainId: 8453, audience, path: u.pathname, account: h["x-upload-address"], hash: sha, size: bytes.length, nonce: h["x-upload-nonce"], expiry: Number(h["x-upload-expiry"]) });
              const ok = await pc.readContract({ address: h["x-upload-address"], abi: [{ type: "function", name: "isValidSignature", stateMutability: "view",
                inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] }], functionName: "isValidSignature", args: [hashMessage(msg), h["x-upload-signature"]] }).catch(() => null);
              if (ok !== "0x1626ba7e") throw new Error("account signature");
              usedNonces.add(h["x-upload-address"] + ":" + h["x-upload-nonce"]);
            } else {
              const msg = uploadMessage({ audience, path: u.pathname, address: h["x-upload-address"], hash: sha, size: bytes.length, expiry: Number(h["x-upload-expiry"]) });
              const who = (await recoverMessageAddress({ message: msg, signature: h["x-upload-signature"] })).toLowerCase();
              if (who !== h["x-upload-address"]) throw new Error("signer");
            }
          } catch (e){ return send(401, JSON.stringify({ error: "upload authorization refused: " + e.message }), { "content-type": "application/json" }); }
          const { cid } = artifactIdentity(new Uint8Array(bytes));
          held[i].set(cid, bytes); uploads.push({ adapter: i, path: u.pathname, cid, signer: h["x-upload-address"], scheme: h["x-upload-scheme"] || "v1", bytes: bytes.length });
          return send(200, JSON.stringify({ cid }), { "content-type": "application/json" });
        }
        const m = /^\/ipfs\/([a-z0-9]+)$/.exec(u.pathname);
        if (req.method === "GET" && m){
          const b = held[i].get(m[1]); if (!b) return send(404, "not held");
          const r = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
          if (!r) return send(200, b, { "content-type": "application/octet-stream", "content-length": String(b.length) });
          const s = Number(r[1]), e = Math.min(Number(r[2]), b.length - 1);
          return send(206, b.subarray(s, e + 1), { "content-range": `bytes ${s}-${e}/${b.length}`, "content-length": String(e - s + 1) });
        }
        send(404, "no");
      });
      await new Promise((ok) => srv.listen(port, host === "localhost" ? "127.0.0.1" : host, ok));
      stops.push(() => new Promise((ok) => srv.close(ok)));
      replicas.push({ upload: `https://${host}:${port}/add-json`, audience, gateway: `https://${host}:${port}/ipfs` });
    }

    // ---- a real public network directory (owner-signature checked against the chain) ----
    const ledgerAbi = A.ledger.abi;
    const dirPath = path.join(tmp, "directory");
    const directory = new PublicDirectory({ directory: dirPath, checkers: ["0x" + "03".repeat(20)], now: () => Date.now(),
      hostOperator: async () => operator,
      leaseOf: async (id) => {
        const d = await pc.readContract({ address: ledger, abi: ledgerAbi, functionName: "get", args: [id] });
        return { id, owner: d.owner, runner: d.runner, chainId: 8453, deployments: ledger, runnerOperator: d.runnerOperator, active: d.active,
          isPublic: d.isPublic, leaseUntil: Number(d.leaseUntil) * 1000, validUntil: Date.now() + 90000 };
      } });
    const dsrv = createDirectoryServer(directory);
    const dport = await freePort();
    await new Promise((ok) => dsrv.listen(dport, "127.0.0.1", ok));
    stops.push(() => new Promise((ok) => dsrv.close(ok)));

    // ---- the unbundled site (plus /network/* for the Network tab's shared policy code, as the bundler resolves it) ----
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
    const PRETTY = { "/": "/index.html", "/apps": "/apps.html", "/dashboard": "/dashboard.html", "/apps/publish": "/apps.html" };
    const site = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); p = PRETTY[p] || p;
      const root = p.startsWith("/network/") ? REPO : path.join(REPO, "site");
      const file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()){ res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    const sport = await freePort();
    await new Promise((ok) => site.listen(sport, "127.0.0.1", ok));
    stops.push(() => new Promise((ok) => site.close(ok)));

    const profile = {
      format: "enclave-browser-profile", version: 1, name: "local independent test network", chainId: 8453,
      rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 86400,
      contractPins: { version: 1, chainId: 8453, contracts: { registry: registry.toLowerCase(), deployments: ledger.toLowerCase(), appCatalog: catalog.toLowerCase(),
        proofOfTime: ledger.toLowerCase(), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
        sessionVaultFactory: factory.toLowerCase(), secretVaultV2: "0x" + "00".repeat(20) } },
      usdc: usdc.toLowerCase(), ethUsdFeed: feed.toLowerCase(), storage: { version: 1, minimumCopies: 2, replicas }, directories: [`http://127.0.0.1:${dport}`],
    };
    // anvil mines on demand: keep blocks coming so the agreed block stays recent and confirmations advance
    const miner = setInterval(() => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }) }).catch(() => {}), 1000);
    stops.push(() => clearInterval(miner));
    // a replacement ledger the book can select (the original ledger stays deployed with its records)
    const deployLedger = async () => {
      const next = await deploy(A.ledger, [usdc, treasury, registry, feed], { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bw });
      await write(dep, next, A.ledger.abi, "setProofRequiredFrom", [0n]);
      return next;
    };
    // an administrator's ledger migration (the platform's procedure): a replacement ledger with every record imported
    // verbatim (ids included) and each record's runner rate (importEarn), so fundings there escrow as on the original
    const migrateLedger = async (from) => {
      const next = await deployLedger();
      const n = await pc.readContract({ address: from, abi: A.ledger.abi, functionName: "count" });
      const records = n ? await pc.readContract({ address: from, abi: A.ledger.abi, functionName: "getPage", args: [0n, n] }) : [];
      if (!records.length) return next;
      await write(dep, next, A.ledger.abi, "importDeployments", [records]);
      const rates = await Promise.all(records.map((r) => pc.readContract({ address: from, abi: A.ledger.abi, functionName: "earnOf", args: [r.id] }).then((e) => e[0])));
      await write(dep, next, A.ledger.abi, "importEarn", [records.map((r) => r.id), rates]);
      return next;
    };
    return { stop, rpc, pc, wc, write, deployCatalog: () => deploy(A.catalog), deployLedger, migrateLedger,
      abi: { ledger: ledgerAbi, registry: A.registry.abi, catalog: A.catalog.abi, usdc: A.usdc.abi, factory: A.factory.abi, feed: A.feed.abi, book: A.book?.abi },
      addresses: { usdc, registry, ledger, catalog, router, factory, feed, book }, owner, operator, endpoint, endpoint2,
      site: `http://localhost:${sport}`, profile, rpcModes, adapterModes, held, uploads, directory, directoryUrl: `http://127.0.0.1:${dport}` };
  } catch (e){ await stop(); throw e; }
}

/* An EIP-6963 wallet in the page that proxies to anvil (anvil signs for its unlocked dev account). */
export function walletScript({ rpc, address }){
  return `(() => {
    let id = 0;
    const call = async (method, params) => {
      const r = await fetch(${JSON.stringify(rpc)}, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
      return j.result;
    };
    const address = ${JSON.stringify(address)};
    const provider = { request: async ({ method, params }) => {
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [address];
        case "eth_chainId": return "0x2105";
        case "wallet_switchEthereumChain": return null;
        case "eth_signTypedData_v4": { const [from, typed] = params; return call("eth_signTypedData_v4", [from, typeof typed === "string" ? JSON.parse(typed) : typed]); }
        default: return call(method, params);
      } }, on: () => {}, removeListener: () => {} };
    const detail = Object.freeze({ info: { uuid: "local-wallet", name: "Local Wallet", rdns: "test.local.wallet", icon: null }, provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  })();`;
}
