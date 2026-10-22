// The fixtures behind test/site-default-independence.test.mjs. Everything here is LOCAL and labelled:
//   - an anvil fork of Base (read-only upstream): the REAL pinned contracts, the REAL service index and its real ad, the
//     real ledger records and relay-era vaults; block time moved to now once so freshness rules apply;
//   - three loopback JSON-RPC proxies on the fixed ports the provisional profile names, each switchable to: honest, down,
//     wrong-chain, or lying (corrupting eth_getCode / eth_call answers for chosen addresses);
//   - FIXTURE actors with anvil's public dev keys: a service operator that publishes a directory ad, a host operator that
//     registers a fixture host and signs real capacity records, and a host owner that accepts a real (Enclave-operated)
//     host's ownership on the fork and commits a deny policy. Real operators are only IMPERSONATED on this fork to
//     heartbeat and nominate; no real key is used anywhere;
//   - the real public directory server (network/directory-server.mjs) and a host-capacity directory on loopback, plus
//     storage adapters and a host-policy mirror as handlers; the browser reaches them at public-looking names through
//     Playwright routing, and every other off-machine request is refused and recorded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PROXY_PORTS, FIXTURE_STORAGE, POLICY_MIRROR } from "./default-site-fixture.mjs";
import { SERVICE_INDEX_ABI } from "../../network/service-index.mjs";
import { buildHostCapacityRecord, signHostCapacity, hostIdOf } from "../../network/host-capacity.mjs";
import { hostAdmissionPolicyHash } from "../../network/host-admission-policy.mjs";
import { artifactIdentity } from "../../sdk/storage/unixfs.mjs";
import { uploadMessage } from "../../site/js/core/upload-auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FORK_BLOCK = 52836800n;
export const CHAIN = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
export const LIVE = {
  ledger: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b", registry: "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac", catalog: "0x18419ca2b502d423a8de6269aeee171a378626e3",
  serviceIndex: "0x54decb43de6f9cc953ba582b190b56c5a60b5941", hostOwnership: "0xf5e9e6c02449001f6e8e95e5d87413f2cb6790ea",
  legacyFactory: "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c",
  // a real existing owner on Base: 15 records held by the wallet, 4 by its relay-era vault (read 2026-10-19)
  existingOwner: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", existingLegacyVault: "0xb794c4dd0e1c5e6b72281799f282bfde7654345d",
  // real registry hosts: metal0 is Enclave-operated (its operator also signed the live directory ad); kryptos has another operator
  metal0: { endpoint: "https://api.enclave.host/t/metal0", operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab" },
  kryptos: { endpoint: "https://kryptos.enclave.containers.Cloud Provider.dev", operator: "0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1" },
};
// anvil's PUBLIC dev keys (never funds or authority anywhere but a local chain)
export const DEV = {
  serviceOperator: privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
  hostOperator: privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"),
  hostOwner: privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"),
  wallet: privateKeyToAccount("0x<REDACTED:unverified-test-key>"),
};
export const FIXTURE_HOST = "https://host-b.operator-b.net";
export const FIXTURE_DIRECTORY = "https://dir.operator-b.net";

export const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const portFree = (port) => new Promise((ok) => { const s = net.createServer(); s.once("error", () => ok(false)); s.listen(port, "127.0.0.1", () => s.close(() => ok(true))); });

/* A JSON-RPC proxy in front of anvil whose answers the test can corrupt. */
async function rpcProxy(port, upstream){
  const p = { mode: "honest", lieCode: new Map(), lieCall: new Map(), hits: 0 };
  p.server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS"){ res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" }); return res.end(); }
    let body = ""; for await (const c of req) body += c;
    p.hits++;
    if (p.mode === "down"){ req.socket.destroy(); return; }
    const q = JSON.parse(body), items = Array.isArray(q) ? q : [q], out = [];
    for (const it of items){
      if (p.mode === "wrong-chain" && it.method === "eth_chainId"){ out.push({ jsonrpc: "2.0", id: it.id, result: "0x7a69" }); continue; }
      const r = await (await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(it) })).json();
      if (it.method === "eth_getCode" && p.lieCode.has(String(it.params[0]).toLowerCase())) r.result = p.lieCode.get(String(it.params[0]).toLowerCase());
      if (it.method === "eth_call" && p.lieCall.has(String(it.params[0].to).toLowerCase())) r.result = p.lieCall.get(String(it.params[0].to).toLowerCase())(r.result, it.params[0].data);
      out.push(r);
    }
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(Array.isArray(q) ? out : out[0]));
  });
  await new Promise((ok, bad) => { p.server.once("error", bad); p.server.listen(port, "127.0.0.1", ok); });
  p.url = "http://127.0.0.1:" + port;
  p.reset = () => { p.mode = "honest"; p.lieCode.clear(); p.lieCall.clear(); };
  return p;
}

export async function startForkRig({ log = () => {} } = {}){
  const cleanups = [], tmp = fs.mkdtempSync(path.join(os.tmpdir(), "default-rig-"));
  const stop = async () => { while (cleanups.length){ try { await cleanups.pop()(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); };
  try {
    for (const p of PROXY_PORTS) if (!(await portFree(p))) throw new Error("fixed proxy port " + p + " is in use (the provisional profile names it)");
    const port = await freePort(), rpcUrl = "http://127.0.0.1:" + port;
    const anvil = spawn("anvil", ["--port", String(port), "--fork-url", process.env.BASE_FORK_RPC || "https://mainnet.base.org", "--fork-block-number", String(FORK_BLOCK),
      // the upstream (Base's public archive endpoint) rate-limits bursts: anvil paces and retries its own lazy state fetches;
      // 128 blocks of state so an agreed block is not pruned while a check reads at it
      "--optimism", "--silent", "--base-fee", "0", "--prune-history", "128", "--transaction-block-keeper", "128",
      "--compute-units-per-second", "250", "--retries", "12", "--fork-retry-backoff", "1500", "--timeout", "45000"], { stdio: "ignore" });
    // a clean exit lets anvil keep its fork cache (~/.foundry/cache/rpc/base/<block>) for the next run
    cleanups.push(() => new Promise((ok) => { const t = setTimeout(() => { anvil.kill("SIGKILL"); ok(); }, 8000); anvil.once("exit", () => { clearTimeout(t); ok(); }); anvil.kill("SIGTERM"); }));
    const rpc = async (method, params) => { const r = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(method + ": " + r.error.message); return r.result; };
    for (let i = 0; i < 160; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    // the fork's blocks carry historical time: move the chain to now once (agreed blocks must be fresh)
    await rpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]); await rpc("evm_mine", []);
    const pc = viem.createPublicClient({ chain: CHAIN, transport: viem.http(rpcUrl) });
    // pre-warm, serially through ONE client, every fact the page's reviewed-authority check reads (network/authority-profile.mjs
    // profileRead), so the page's three proxied copies of each read hit anvil's cache instead of bursting the upstream
    {
      const { profileRead } = await import("../../network/authority-profile.mjs");
      const authority = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/network-profile-base.json"), "utf8"));
      // a long per-request timeout: anvil may be fetching many slots from the paced upstream for one call
      // bounded per request, retried: a lost answer costs one minute, not the run
      const warm = viem.createPublicClient({ chain: CHAIN, transport: viem.http(rpcUrl, { timeout: 60000, retryCount: 3, retryDelay: 1000 }) });
      const t0 = Date.now(), note = (m) => process.stderr.write("[rig] " + Math.round((Date.now() - t0) / 1000) + "s " + m + "\n");
      note("pre-warm: reviewed authority facts");
      await profileRead(authority, { concurrency: 1, minIntervalMs: 0 })(warm, await warm.getBlockNumber());
      note("pre-warm: catalog");
      // the catalog the store page renders (every app's version pages and config CIDs), and the service index pages
      const catAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/EnclaveAppCatalog.abi.json"), "utf8"));
      const n = await warm.readContract({ address: LIVE.catalog, abi: catAbi, functionName: "appCount" });
      const apps = [];
      for (let i = 0n; i < n; i += 6n) apps.push(...await warm.readContract({ address: LIVE.catalog, abi: catAbi, functionName: "getAppsPage", args: [i, 6n] }));
      await warm.readContract({ address: LIVE.catalog, abi: catAbi, functionName: "getAppsPage", args: [0n, n] });
      for (const a of apps){
        await warm.readContract({ address: LIVE.catalog, abi: catAbi, functionName: "getVersionsPage", args: [a.appId, 0n, 100n] }).catch(() => null);
        await warm.readContract({ address: LIVE.catalog, abi: catAbi, functionName: "versionConfigCids", args: [a.appId] }).catch(() => null);
      }
      note("pre-warm: catalog " + apps.length + " apps done; service index");
      for (const kind of [1, 3, 5]) await warm.readContract({ address: LIVE.serviceIndex, abi: SERVICE_INDEX_ABI, functionName: "page", args: [kind, 0n, 64n] }).catch(() => null);
    }
    const wcOf = (account) => viem.createWalletClient({ chain: CHAIN, account, transport: viem.http(rpcUrl) });
    for (const a of Object.values(DEV)) await rpc("anvil_setBalance", [a.address, "0x56bc75e2d63100000"]);
    const send = async (account, to, abi, functionName, args) => {
      const hash = await wcOf(account).writeContract({ address: to, abi, functionName, args, gas: 3_000_000n });
      const r = await pc.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error(functionName + " reverted"); return r;
    };
    const asImpersonated = async (addr, to, abi, functionName, args) => {
      await rpc("anvil_impersonateAccount", [addr]); await rpc("anvil_setBalance", [addr, "0x56bc75e2d63100000"]);
      const hash = await wcOf(addr).writeContract({ address: to, abi, functionName, args, gas: 3_000_000n, account: addr });
      const r = await pc.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error(functionName + " reverted");
      await rpc("anvil_stopImpersonatingAccount", [addr]); return r;
    };
    const proxies = [];
    for (const p of PROXY_PORTS){ const x = await rpcProxy(p, rpcUrl); proxies.push(x); cleanups.push(() => new Promise((ok) => { x.server.closeAllConnections?.(); x.server.close(() => ok()); })); }

    // ---- registry: the fixture host (permissionless register), live hosts made live on the fork ----
    const REG = viem.parseAbi(["function register(string,string,bytes32,uint64,uint64,address) returns (bytes32)", "function heartbeat(bytes32)"]);
    await send(DEV.hostOperator, LIVE.registry, REG, "register", [FIXTURE_HOST, "fixture/host-b", "0x" + "00".repeat(32), 900n, 0n, "0x0000000000000000000000000000000000000000"]);
    await asImpersonated(LIVE.metal0.operator, LIVE.registry, REG, "heartbeat", [hostIdOf(LIVE.metal0.endpoint)]);
    await asImpersonated(LIVE.kryptos.operator, LIVE.registry, REG, "heartbeat", [hostIdOf(LIVE.kryptos.endpoint)]);

    // ---- the service index: a fixture operator's directory ad (the real Enclave ad is already on the fork) ----
    const publishAd = async ({ slot = 0, endpoints, ttlSec = 86400 * 30 } = {}) => {
      const seq = await pc.readContract({ address: LIVE.serviceIndex, abi: SERVICE_INDEX_ABI, functionName: "sequenceOf", args: [DEV.serviceOperator.address, slot] });
      const now = (await pc.getBlock()).timestamp;
      return send(DEV.serviceOperator, LIVE.serviceIndex, SERVICE_INDEX_ABI, "publish", [slot, 1, 1, seq + 1n, now + BigInt(ttlSec), "0x" + "00".repeat(32), endpoints]);
    };
    await publishAd({ slot: 0, endpoints: [FIXTURE_DIRECTORY + "/"] });
    // a real operator's NEXT ad, published on this fork only by impersonation (e.g. the prepared, unsigned sequence-2 ad of
    // directory47485: the same operator and slot with HTTPS endpoints). Never sent to Base.
    const publishAsOperator = async (operator, { slot = 0, endpoints, ttlSec = 2592000 }) => {
      const seq = await pc.readContract({ address: LIVE.serviceIndex, abi: SERVICE_INDEX_ABI, functionName: "sequenceOf", args: [operator, slot] });
      const now = (await pc.getBlock()).timestamp;
      return asImpersonated(operator, LIVE.serviceIndex, SERVICE_INDEX_ABI, "publish", [slot, 1, 1, seq + 1n, now + BigInt(ttlSec), "0x" + "00".repeat(32), endpoints]);
    };

    // ---- the public directory (real server) and a capacity directory, on loopback ----
    const { PublicDirectory } = await import("../../network/public-directory.mjs");
    const { createDirectoryServer } = await import("../../network/directory-server.mjs");
    const ledgerAbi = viem.parseAbi(["function get(bytes32) view returns ((bytes32 id,address owner,string appRef,string ports,string configCid,uint16 gpuMilli,uint16 cpuMilli,uint32 appPort,bool isPublic,bool active,uint64 createdAt,uint256 rate,uint256 balance6,uint256 spent6,bytes32 runner,address runnerOperator,uint64 leaseUntil))"]);
    const directory = new PublicDirectory({ directory: path.join(tmp, "directory"), checkers: ["0x" + "03".repeat(20)], now: () => Date.now(),
      hostOperator: async () => DEV.hostOperator.address,
      leaseOf: async (id) => { const d = await pc.readContract({ address: LIVE.ledger, abi: ledgerAbi, functionName: "get", args: [id] });
        return { id, owner: d.owner, runner: d.runner, chainId: 8453, deployments: LIVE.ledger, runnerOperator: d.runnerOperator, active: d.active, isPublic: d.isPublic,
          leaseUntil: Number(d.leaseUntil) * 1000, validUntil: Date.now() + 90000 }; } });
    const dsrv = createDirectoryServer(directory), dport = await freePort();
    await new Promise((ok) => dsrv.listen(dport, "127.0.0.1", ok)); cleanups.push(() => new Promise((ok) => { dsrv.closeAllConnections?.(); dsrv.close(() => ok()); }));
    const capacity = { records: [] };   // what the fixture directory serves at /v1/host-capacity
    const signCapacity = async (availability, { endpoint = FIXTURE_HOST, operator = DEV.hostOperator, now = Date.now() } = {}) =>
      signHostCapacity(operator, buildHostCapacityRecord({ availability, chainId: 8453, registry: LIVE.registry, endpoint, operator: operator.address, now }));

    // ---- host-owner veto: the Enclave-operated metal0 host gets a fixture owner whose policy declines one app ----
    const OWN = viem.parseAbi(["function proposeOwner(bytes32,address)", "function acceptOwner(bytes32)", "function setPolicy(bytes32,bytes32)"]);
    const policies = new Map();   // hash -> document, served by the policy mirror handler
    const vetoHost = async (hostEndpoint, operator, denyAppRefs) => {
      const hostId = hostIdOf(hostEndpoint);
      await asImpersonated(operator, LIVE.hostOwnership, OWN, "proposeOwner", [hostId, DEV.hostOwner.address]);
      await send(DEV.hostOwner, LIVE.hostOwnership, OWN, "acceptOwner", [hostId]);
      const policy = { version: 1, chainId: 8453, ownershipContract: LIVE.hostOwnership, hostId, requireCatalogApproval: false, denyDeployments: [], denyAppRefs };
      const hash = hostAdmissionPolicyHash(policy); policies.set(hash, policy);
      await send(DEV.hostOwner, LIVE.hostOwnership, OWN, "setPolicy", [hostId, hash]);
      return { hostId, hash, policy };
    };

    // ---- storage stand-ins (they verify the wallet's EIP-191 signature exactly as the real adapter's v1 check) ----
    const storage = { held: FIXTURE_STORAGE.replicas.map(() => new Map()), modes: {}, uploads: [] };
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, range, cache-control, x-upload-address, x-upload-expiry, x-upload-sha256, x-upload-signature, x-upload-scheme, x-upload-nonce",
      "access-control-expose-headers": "content-range, content-length" };
    async function storageHandler(i, route){
      const req = route.request(), u = new URL(req.url());
      const fulfill = (status, body, headers = {}) => route.fulfill({ status, headers: { ...cors, ...headers }, body });
      if (req.method() === "OPTIONS") return fulfill(204, "");
      if (storage.modes[i] === "down") return route.abort("connectionrefused");
      if (req.method() === "POST" && u.pathname === "/add-json"){
        const bytes = req.postDataBuffer() || Buffer.alloc(0), h = req.headers();
        const sha = createHash("sha256").update(bytes).digest("hex");
        try {
          if (h["x-upload-sha256"] !== sha || Number(h["x-upload-expiry"]) < Date.now() / 1000) throw new Error("scope");
          const msg = uploadMessage({ audience: FIXTURE_STORAGE.replicas[i].audience, path: u.pathname, address: h["x-upload-address"], hash: sha, size: bytes.length, expiry: Number(h["x-upload-expiry"]) });
          if ((await viem.recoverMessageAddress({ message: msg, signature: h["x-upload-signature"] })).toLowerCase() !== h["x-upload-address"]) throw new Error("signer");
        } catch (e){ return fulfill(401, JSON.stringify({ error: "upload authorization refused: " + e.message }), { "content-type": "application/json" }); }
        const { cid } = artifactIdentity(new Uint8Array(bytes));
        storage.held[i].set(cid, bytes); storage.uploads.push({ adapter: i, cid, signer: h["x-upload-address"] });
        return fulfill(200, JSON.stringify({ cid }), { "content-type": "application/json" });
      }
      const m = /^\/ipfs\/([a-z0-9]+)$/.exec(u.pathname);
      if (req.method() === "GET" && m){
        const b = storage.held[i].get(m[1]); if (!b) return fulfill(404, "not held");
        const r = /^bytes=(\d+)-(\d+)$/.exec(req.headers().range || "");
        if (!r) return fulfill(200, b, { "content-type": "application/octet-stream", "content-length": String(b.length) });
        const s = Number(r[1]), e = Math.min(Number(r[2]), b.length - 1);
        return fulfill(206, b.subarray(s, e + 1), { "content-range": `bytes ${s}-${e}/${b.length}`, "content-length": String(e - s + 1) });
      }
      return fulfill(404, "no");
    }

    /* Routing for a Playwright context: fixture names go to their handlers or loopback servers; every other request that
       leaves this machine is refused and recorded. Loopback (the site, the RPC proxies, the bundler) passes. */
    const contacted = [], refused = [];
    const forward = async (route, base) => {
      const req = route.request(), u = new URL(req.url());
      const r = await fetch(base + u.pathname + u.search, { method: req.method(), headers: { "content-type": req.headers()["content-type"] || "application/json" },
        body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() });
      const body = Buffer.from(await r.arrayBuffer());
      return route.fulfill({ status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" }, body });
    };
    const fixtureHosts = {
      "dir.operator-b.net": async (route) => {
        const u = new URL(route.request().url());
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" } });
        if (u.pathname === "/v1/host-capacity") return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ records: capacity.records }) });
        return forward(route, "http://127.0.0.1:" + dport);
      },
      "host-b.operator-b.net": async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === "/v1/host/capacity" && capacity.hostRecord) return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(capacity.hostRecord) });
        return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "no" });
      },
      "policies.operator-c.net": async (route) => {
        const m = /^\/(0x[0-9a-f]{64})\.json$/.exec(new URL(route.request().url()).pathname);
        const doc = m && policies.get(m[1]);
        return route.fulfill({ status: doc ? 200 : 404, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: doc ? JSON.stringify(doc) : "{}" });
      },
      "s1.storage-a.net": (route) => storageHandler(0, route),
      "s2.storage-b.net": (route) => storageHandler(1, route),
    };
    const routeContext = async (context) => {
      await context.route((u) => !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname), async (route) => {
        const u = new URL(route.request().url());
        const h = fixtureHosts[u.hostname];
        if (h){ contacted.push(u.origin + u.pathname); return h(route); }
        refused.push(route.request().method() + " " + u.origin + u.pathname);
        return route.abort("blockedbyclient");
      });
    };
    return { stop, rpc, rpcUrl, pc, send, asImpersonated, proxies, publishAd, publishAsOperator, capacity, signCapacity, vetoHost, policies, storage, routeContext, contacted, refused,
      directory, directoryUrl: "http://127.0.0.1:" + dport, tmp };
  } catch (e){ await stop(); throw e; }
}

/* An EIP-6963 wallet in the page that proxies to anvil: dev accounts sign; an impersonated real owner can only send
   transactions (anvil never signs messages for it). */
export function walletScript({ rpc, address }){
  return `(() => {
    let id = 0;
    const call = async (method, params) => {
      const r = await fetch(${JSON.stringify(rpc)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result;
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
