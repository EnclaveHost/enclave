// Shared rig for the credit-vault independence tests (test/credit-vault-independent.test.mjs, test/credit-vault-browser
// .test.mjs): anvil with RIP-7212 (--network optimism), two loopback RPC origins in front of it, the PRODUCTION credit-vault
// factory bytecode (test/fixtures/credit-vault-d36100ae.json) deployed twice (an older and the book's current factory),
// the live rev-16d ledger + schema-4 registry + the real address book (test/fixtures/credit-vault-independence-chain.json),
// and a P-256 "passkey" that answers navigator.credentials.get exactly as an authenticator does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http as viemHttp, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CV = await import(path.join(REPO, "site/js/core/credit-vault-independent.js"));
export const VAULT_FX = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/credit-vault-d36100ae.json"), "utf8"));
export const CHAIN_FX = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/credit-vault-independence-chain.json"), "utf8"));
export const ORIGIN = "https://enclave.host", RPID = "enclave.host";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const lc = (a) => String(a).toLowerCase();
export const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
export const b64u = (b) => Buffer.from(b).toString("base64url");
const realFetch = globalThis.fetch;

/* ---- anvil keys (the well-known test mnemonic): admin/deployer, the owner's payer wallet, a relay operator ---- */
export const KEYS = { admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", payer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  relay: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", other: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" };
export const ACCT = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]));
export const TREASURY = "0x000000000000000000000000000000000000beef", PAYOUT = "0x000000000000000000000000000000000000fee5";

/* ---- a P-256 "passkey" that answers navigator.credentials.get exactly as an authenticator does ---- */
export function passkey(origin = ORIGIN, rpId = RPID){
  const priv = p256.utils.randomPrivateKey();
  const P = p256.ProjectivePoint.fromPrivateKey(priv).toAffine();
  const k = { priv, credentialId: b64u(crypto.randomBytes(20)), x: "0x" + P.x.toString(16).padStart(64, "0"), y: "0x" + P.y.toString(16).padStart(64, "0"), calls: 0, counter: 1 };
  k.getFn = (o = {}) => async (opts) => {
    k.calls++;
    const pk = opts.publicKey;
    const cdj = JSON.stringify({ type: "webauthn.get", challenge: b64u(Buffer.from(pk.challenge)), origin: o.origin || origin, crossOrigin: false });
    const ad = Buffer.concat([Buffer.from(sha256(Buffer.from(pk.rpId || rpId))), Buffer.from([o.flags ?? 0x05]), Buffer.from([0, 0, 0, k.counter++])]);
    const msg = sha256(Buffer.concat([ad, Buffer.from(sha256(Buffer.from(cdj)))]));
    const sig = p256.sign(msg, priv, { prehash: false, lowS: false });
    const c = Buffer.from(cdj);
    return { id: k.credentialId, type: "public-key", response: { clientDataJSON: c.buffer.slice(c.byteOffset, c.byteOffset + c.length), authenticatorData: new Uint8Array(ad).buffer, signature: sig.toDERRawBytes().buffer } };
  };
  return k;
}
/** a raw assertion (what a page would get) over `challenge` at `origin`, as {authenticatorData, clientDataJSON, r, s} */
export async function rawAssertion(k, challenge, origin = ORIGIN, rpId = RPID){
  const cred = await k.getFn({ origin })({ publicKey: { challenge: Buffer.from(challenge.slice(2), "hex"), rpId } });
  const s = p256.Signature.fromDER(new Uint8Array(cred.response.signature));
  return { authenticatorData: "0x" + Buffer.from(cred.response.authenticatorData).toString("hex"), clientDataJSON: Buffer.from(cred.response.clientDataJSON).toString(), r: s.r, s: s.s };
}

/* ---- the chain ---- */
export async function rpcProxy(target){
  // CORS like a public RPC endpoint: the /credit/ page calls it cross-origin from the browser
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" };
  const srv = http.createServer((req, res) => {
    if (req.method === "OPTIONS"){ res.writeHead(204, cors); return res.end(); }
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", async () => {
      try { const r = await realFetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
        res.writeHead(r.status, { ...cors, "content-type": "application/json" }); res.end(Buffer.from(await r.arrayBuffer())); }
      catch (e){ res.writeHead(502, cors); res.end(); }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
export async function startChain(chainId, stops){
  const port = await freePort();
  const anvil = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--network", "optimism", "--silent", "--code-size-limit", "30000"], { stdio: "ignore" });
  stops.push(() => anvil.kill("SIGKILL"));
  const url = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ transport: viemHttp(url) });
  for (let i = 0; ; i++){ try { await pub.getChainId(); break; } catch { if (i > 150) throw new Error("anvil did not start"); await sleep(100); } }
  const proxies = [await rpcProxy(url), await rpcProxy(url)];
  stops.push(() => proxies.forEach((p) => p.close()));
  const wallet = (k) => createWalletClient({ account: ACCT[k], transport: viemHttp(url), chain: { id: chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } } });
  const raw = async (method, params = []) => { const r = await realFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
  return { chainId, url, pub, wallet, raw, rpcs: proxies.map((p) => p.url) };
}
export async function deploy(c, who, abi, bytecode, args = []){
  const hash = await c.wallet(who).deployContract({ abi, bytecode, args });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success"); return lc(r.contractAddress);
}
export async function send(c, who, to, abi, functionName, args){
  const hash = await c.wallet(who).writeContract({ address: to, abi, functionName, args });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", functionName); return r;
}
export const bookKey = (s) => toHex(s, { size: 32 });
/** the live ledger links EnclaveLedgerBandwidth: deploy the library, then the ledger with its address in place */
export async function deployLedger(c, args){
  const X = CHAIN_FX, libAddr = await deploy(c, "admin", X.EnclaveLedgerBandwidth.abi, X.EnclaveLedgerBandwidth.bytecode);
  return deploy(c, "admin", X.EnclaveDeployments.abi, X.EnclaveDeployments.bytecode.split(X.EnclaveDeployments.libraryPlaceholder).join(libAddr.slice(2)), args);
}
/** identical deployment order on every chain (so the same addresses), the PRODUCTION factory twice: an older one and the
 *  book's current one */
export async function deployStack(c, { origin = ORIGIN } = {}){
  const X = CHAIN_FX;
  const usdc = await deploy(c, "admin", X.MockUSDC.abi, X.MockUSDC.bytecode);
  const feed = await deploy(c, "admin", X.FeedMock.abi, X.FeedMock.bytecode);
  const registry = await deploy(c, "admin", X.EnclaveRegistry.abi, X.EnclaveRegistry.bytecode);
  const ledger = await deployLedger(c, [usdc, PAYOUT, registry, feed]);
  const book = await deploy(c, "admin", X.EnclaveAddressBook.abi, X.EnclaveAddressBook.bytecode);
  const fargs = [usdc, book, TREASURY, origin, ""];
  const older = await deploy(c, "admin", VAULT_FX.factory.abi, VAULT_FX.factory.bytecode, fargs);
  const current = await deploy(c, "admin", VAULT_FX.factory.abi, VAULT_FX.factory.bytecode, fargs);
  await send(c, "admin", book, X.EnclaveAddressBook.abi, "set", [bookKey("deployments"), ledger]);
  await send(c, "admin", book, X.EnclaveAddressBook.abi, "set", [bookKey("vaultFactory"), current]);
  const impl = async (f) => lc(await c.pub.readContract({ address: f, abi: VAULT_FX.factory.abi, functionName: "implementation" }));
  return { usdc, feed, registry, ledger, book, older: { address: older, implementation: await impl(older), label: "older factory" },
    current: { address: current, implementation: await impl(current), label: "current factory" } };
}
export const usdcOf = (c, S, a) => c.pub.readContract({ address: S.usdc, abi: CHAIN_FX.MockUSDC.abi, functionName: "balanceOf", args: [a] });
export const recordOf = (c, ledger, id) => c.pub.readContract({ address: ledger, abi: CHAIN_FX.EnclaveDeployments.abi, functionName: "get", args: [id] });
export const nonceOf = (c, v) => c.pub.readContract({ address: v, abi: CV.ABI.vault, functionName: "nonce" });
/** the owner's wallet as an EIP-1193 provider (anvil holds the payer key unlocked): the explicit payer */
export const eip1193 = (c) => ({ request: ({ method, params }) => c.raw(method, params) });
export function memJournal(){ const m = new Map(); return { m, get: async (v) => m.get(lc(v)) || null, put: async (e) => { m.set(lc(e.request.vault), JSON.parse(JSON.stringify(e))); }, clear: async (v) => { m.delete(lc(v)); } }; }

