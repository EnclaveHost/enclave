// Smart-account (ERC-1271) uploads against the REAL storage adapter: work/enclave-apps/s3-ipfs-adapter built for
// wasm32-wasip2, run under wasmtime exactly as the e2e does, with minio for S3, its contract-wallet readers pointed at
// three loopback JSON-RPC proxies in front of an anvil fork of Base (block 52,836,800, --optimism; read-only upstream).
// The account is a Safe v1.4.1 whose built-in (shared-signer) owner is a passkey from a software authenticator; it signs
// the v2 upload message through its own contract. Covered: v2 accepted and stored byte-exact; replay; expiry; wrong
// method/path, body, account, chain and service (deployment); an undeployed account (plain and ERC-6492); a reader that
// lies, readers that split, too few readers; an invalid signature - and the unchanged v1 wallet and legacy relay-token
// paths. Needs: anvil, minio, wasmtime, curl, and the adapter built (cargo build --release --target wasm32-wasip2).
//   node test/helpers/memory-guard.mjs --max-rss-mib 1024 --floor-available-mib 16384 -- node --test test/site-independent-account-upload-adapter.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { WebAuthnP256 } from "ox";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { softwareAuthenticator } from "./helpers/software-authenticator.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = process.env.S3IPFS_WASM || path.resolve(REPO, "../enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm");
const have = (cmd, args) => { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } };
const skip = (!have("anvil", ["--version"]) && "needs anvil") || (!have("minio", ["--version"]) && "needs minio") || (!have("wasmtime", ["--version"]) && "needs wasmtime")
  || (!fs.existsSync(ADAPTER) && "needs the adapter built for wasm32-wasip2");
const FORK_BLOCK = 52836800n, CHAIN = 8453;
const SHARED = "0x94a4f6affbd8975951142c3999aeab7ecee555c2";
const AUD_A = "0x" + "a1".repeat(32), AUD_B = "0x" + "b2".repeat(32);
const LEGACY_KEY = "legacy-relay-upload-key-for-this-test";
const chain = { id: CHAIN, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };

let rpcUrl, pc, wc, PA, UA, auth, reader, adapterA, adapterB, safe, profile, signer, undeployed, setupError = null;
const proxies = [], cleanups = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params) => { const r = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };

/* A JSON-RPC reader in front of anvil whose answers this test can corrupt: "honest", "down" (no answer), or "lie-valid"
   (every eth_call answers the ERC-1271 magic value: the dangerous lie). */
async function readerProxy(){
  const p = { mode: "honest", hits: 0 };
  p.server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    p.hits++;
    if (p.mode === "down"){ req.socket.destroy(); return; }
    const q = JSON.parse(body);
    const items = Array.isArray(q) ? q : [q];
    const out = [];
    for (const it of items){
      const r = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(it) })).json();
      if (p.mode === "lie-valid" && it.method === "eth_call") out.push({ jsonrpc: "2.0", id: it.id, result: "0x1626ba7e" + "0".repeat(56) });
      else out.push(r);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(q) ? out : out[0]));
  });
  await new Promise((r) => p.server.listen(0, "127.0.0.1", r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  cleanups.push(() => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); }));
  return p;
}

async function startAdapter(name, audience, s3, extra = {}){
  const port = await freePort();
  const config = { endpoint: s3.url, region: "us-east-1", bucket: s3.bucket, prefix: name + "/", credentials: { accessKeyId: s3.ak, secretAccessKey: s3.sk }, refreshSecs: 0,
    upload: { walletAudience: audience, allowOrigins: [], maxJsonBytes: 65536,
      contractWallets: { chainId: CHAIN, rpcs: proxies.map((p) => p.url), quorum: 2, confirmations: 0, max_age_secs: 600, timeout_secs: 5 }, ...extra } };
  const proc = spawn("wasmtime", ["run", "-Scli", "-Stcp", "-Sinherit-network", "-Sallow-ip-name-lookup", "--env", `ENCLAVE_PORTS=http:8000=${port}`,
    "--env", "ENCLAVE_CONFIG=" + JSON.stringify(config), ADAPTER], { stdio: ["ignore", "ignore", "pipe"] });
  let log = ""; proc.stderr.on("data", (d) => { log = (log + d).slice(-4000); });
  cleanups.push(() => proc.kill("SIGKILL"));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++){ try { if ((await fetch(base + "/ping")).ok) return { base, audience, log: () => log }; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(name + " did not start: " + log);
}

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("account-upload-adapter: watchdog"); cleanup().finally(() => process.exit(1)); }, 10 * 60 * 1000); watchdog.unref();
  try {
    const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", ["--port", String(port), "--fork-url", process.env.BASE_FORK_RPC || "https://mainnet.base.org", "--fork-block-number", String(FORK_BLOCK), "--optimism",
      "--silent", "--base-fee", "0", "--prune-history", "4", "--transaction-block-keeper", "16"], { stdio: "ignore" });
    cleanups.push(() => anvil.kill("SIGKILL"));
    for (let i = 0; i < 120; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    // the fork's blocks carry the fork block's (historical) time; the adapter rightly refuses blocks older than its
    // max_age_secs, so this local chain is moved to the present once, and later blocks follow the wall clock
    await rpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]); await rpc("evm_mine", []);
    globalThis.localStorage = { m: new Map(), getItem(k){ return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v){ this.m.set(k, String(v)); }, removeItem(k){ this.m.delete(k); } };
    globalThis.sessionStorage = globalThis.localStorage; globalThis.location = { hostname: "localhost" };
    PA = await import(pathToFileURL(path.join(REPO, "site/js/core/passkey-account.js")).href);
    UA = await import(pathToFileURL(path.join(REPO, "site/js/core/upload-auth.js")).href);
    const { createQuorumReader } = await import(pathToFileURL(path.join(REPO, "site/js/core/quorum.js")).href);
    PA._useLibForTests({ ...viem, WebAuthnP256 });
    reader = createQuorumReader({ rpcs: [rpcUrl, rpcUrl.replace("127.0.0.1", "localhost")], quorum: 2, confirmations: 0, maxBlockAgeSeconds: 10 ** 9, chainId: CHAIN });
    pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
    const driver = privateKeyToAccount(generatePrivateKey());
    wc = viem.createWalletClient({ chain, account: driver, transport: viem.http(rpcUrl) });
    await rpc("anvil_setBalance", [driver.address, "0x56bc75e2d63100000"]);
    auth = softwareAuthenticator();
    // the account: a Safe whose built-in (shared-signer) owner is a passkey, deployed by its normal creation call
    const P = await PA.createPasskey({ rpId: "dash.example", rpName: "Dashboard", userName: "owner", createFn: auth.createFn });
    const owner = (k, label) => ({ kind: "passkey", signer: SHARED, shared: true, x: k.x, y: k.y, verifiers: String(PA.VERIFIERS_PRECOMPILE), credentialId: k.credentialId, rpId: k.rpId, label });
    const base = { v: 1, provider: "safe-passkey", chainId: CHAIN, safe: "0x" + "00".repeat(19) + "01", saltNonce: "4242", threshold: 1, transport: null, owners: [owner(P, "laptop")] };
    const pred = await PA.prepareSafeCreation(PA.creationOf(base), { reader });
    profile = { ...base, safe: pred.safe };
    const h = await wc.sendTransaction({ to: pred.create.to, data: pred.create.data, gas: 3_000_000n });
    assert.equal((await pc.waitForTransactionReceipt({ hash: h })).status, "success");
    safe = pred.safe;
    signer = PA.accountUploadSigner({ profile, passkeys: [P.credentialId], getFn: auth.getFn });
    // another account, NOT deployed: its address has no code
    const X = await PA.createPasskey({ rpId: "dash.example", rpName: "Dashboard", userName: "later", createFn: auth.createFn });
    const xb = { ...base, saltNonce: "4343", owners: [owner(X, "later")] };
    const xp = await PA.prepareSafeCreation(PA.creationOf(xb), { reader });
    undeployed = { profile: { ...xb, safe: xp.safe }, create: xp.create, signer: PA.accountUploadSigner({ profile: { ...xb, safe: xp.safe }, passkeys: [X.credentialId], getFn: auth.getFn }) };
    // the chain readers the operator pins (three loopback ports = three readers)
    for (let i = 0; i < 3; i++) proxies.push(await readerProxy());
    // minio
    const s3 = { url: `http://127.0.0.1:${await freePort()}`, bucket: "uploads", ak: "testkey", sk: "testsecret12345" };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-upload-minio-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const minio = spawn("minio", ["server", "--address", s3.url.replace("http://", ""), dir], { stdio: "ignore", env: { ...process.env, MINIO_ROOT_USER: s3.ak, MINIO_ROOT_PASSWORD: s3.sk, MINIO_BROWSER: "off" } });
    cleanups.push(() => minio.kill("SIGKILL"));
    for (let i = 0; i < 100; i++){ try { if ((await fetch(s3.url + "/minio/health/ready")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    execFileSync("curl", ["-sf", "-X", "PUT", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${s3.ak}:${s3.sk}`, `${s3.url}/${s3.bucket}/`]);
    adapterA = await startAdapter("a", AUD_A, s3, { uploadKey: LEGACY_KEY });
    adapterB = await startAdapter("b", AUD_B, s3);
  } catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);

/* One smart-account upload: headers for (signedFor) and sent as (sentAs). */
async function accountUpload(adapter, body, { by = signer, account = safe, path: sendPath = "/add-json", signPath = sendPath, method = "POST", chainId = CHAIN, audience = adapter.audience,
  expiry = Math.floor(Date.now() / 1000) + 300, nonce = crypto.randomBytes(16).toString("hex"), sendBody = body, wrap = null, headers: replay = null } = {}){
  await rpc("evm_mine", []);
  let h = replay;
  if (!h){
    const hash = sha(body);
    const message = UA.accountUploadMessage({ chainId, audience, path: signPath, account, hash, size: body.length, nonce, expiry });
    let signature = await by.sign(message);
    if (wrap) signature = wrap(signature);
    h = { "x-upload-scheme": UA.ACCOUNT_UPLOAD_SCHEME, "x-upload-address": account, "x-upload-expiry": String(expiry), "x-upload-sha256": hash, "x-upload-nonce": nonce, "x-upload-signature": signature };
  }
  const r = await fetch(adapter.base + sendPath, { method, headers: { "content-type": "application/json", ...h }, body: sendBody });
  return { status: r.status, text: await r.text(), headers: h };
}
const body = (s) => Buffer.from(JSON.stringify({ startup: s }));

test("a deployed passkey account uploads by its own ERC-1271 signature; stored byte-exact; single use", { skip, timeout: 300000 }, async () => {
  ready();
  const b = body("one");
  const r = await accountUpload(adapterA, b);
  assert.equal(r.status, 200, r.text);
  const { cid } = JSON.parse(r.text);
  const back = await fetch(adapterA.base + "/ipfs/" + cid);
  assert.equal(back.status, 200); assert.deepEqual(Buffer.from(await back.arrayBuffer()), b);
  // every reader was asked (the check is the readers', never the client's)
  assert.ok(proxies.every((p) => p.hits > 0));
  // the same authorization again: refused
  const again = await accountUpload(adapterA, b, { headers: r.headers });
  assert.equal(again.status, 409, again.text);
});

test("refused: expired, wrong path, other bytes, other account, other chain, other service (deployment), invalid signature", { skip, timeout: 300000 }, async () => {
  ready();
  const b = body("two");
  assert.equal((await accountUpload(adapterA, b, { expiry: Math.floor(Date.now() / 1000) - 5 })).status, 401, "expired");
  assert.equal((await accountUpload(adapterA, b, { expiry: Math.floor(Date.now() / 1000) + 5000 })).status, 401, "too far ahead");
  assert.equal((await accountUpload(adapterA, b, { signPath: "/add-image", path: "/add-json" })).status, 403, "signed for another path");
  const other = await accountUpload(adapterA, b, { sendBody: body("swapped") });
  assert.ok(other.status === 403 || other.status === 401, "other bytes than signed: " + other.status + " " + other.text);
  assert.equal((await accountUpload(adapterA, b, { account: undeployed.profile.safe })).status, 403, "another account named");
  assert.equal((await accountUpload(adapterA, b, { chainId: 1 })).status, 403, "signed for another chain");
  assert.equal((await accountUpload(adapterB, b, { audience: AUD_A })).status, 403, "signed for another adapter's deployment");
  assert.equal((await accountUpload(adapterA, b, { by: { sign: async () => "0x" + "11".repeat(400) } })).status, 403, "garbage signature");
  const wrongMethod = await accountUpload(adapterA, b, { method: "PUT" });
  assert.ok(wrongMethod.status >= 400, "PUT is not an upload: " + wrongMethod.status);
  // and the right one still works afterwards (no nonce was burnt by the refusals)
  assert.equal((await accountUpload(adapterA, b)).status, 200);
});

test("an account that is not deployed yet: refused (plain, and ERC-6492-wrapped) - deploy first", { skip, timeout: 300000 }, async () => {
  ready();
  const b = body("three");
  assert.equal((await accountUpload(adapterA, b, { by: undeployed.signer, account: undeployed.profile.safe })).status, 403, "no code: the contract cannot answer");
  const wrap = (sig) => viem.concat([viem.encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], [undeployed.create.to, undeployed.create.data, sig]),
    "0x6492649264926492649264926492649264926492649264926492649264926492"]);
  const w = await accountUpload(adapterA, b, { by: undeployed.signer, account: undeployed.profile.safe, wrap });
  assert.equal(w.status, 401); assert.match(w.text, /deploy the account first/);
  // after its normal deployment, the same account uploads
  const h = await wc.sendTransaction({ to: undeployed.create.to, data: undeployed.create.data, gas: 3_000_000n });
  assert.equal((await pc.waitForTransactionReceipt({ hash: h })).status, "success");
  assert.equal((await accountUpload(adapterA, b, { by: undeployed.signer, account: undeployed.profile.safe })).status, 200);
});

test("readers: one lying reader cannot approve; a split or too few readers refuse; an honest quorum still decides", { skip, timeout: 300000 }, async () => {
  ready();
  const b = body("four");
  const bad = { by: { sign: async () => "0x" + "22".repeat(300) } };
  try {
    proxies[0].mode = "lie-valid";                                  // claims every signature valid
    assert.equal((await accountUpload(adapterA, b, bad)).status, 403, "a lone lying 'valid' is outvoted");
    assert.equal((await accountUpload(adapterA, b)).status, 200, "the honest two still approve a real signature");
    proxies[2].mode = "down";                                       // liar + one honest: a split, no quorum either way
    const split = await accountUpload(adapterA, b, bad);
    assert.equal(split.status, 403); assert.match(split.text, /did not agree|split/);
    proxies[0].mode = "down";                                       // one reader left: too few
    const few = await accountUpload(adapterA, b);
    assert.equal(few.status, 403); assert.match(few.text, /too few chain readers/);
  } finally { for (const p of proxies) p.mode = "honest"; }
});

test("unchanged: a wallet key's v1 signature, and the legacy relay token, still upload", { skip, timeout: 120000 }, async () => {
  ready();
  const key = privateKeyToAccount(generatePrivateKey()), addr = key.address.toLowerCase();
  const b = body("eoa"), hash = sha(b), expiry = Math.floor(Date.now() / 1000) + 300;
  const msg = UA.uploadMessage({ audience: AUD_A, path: "/add-json", address: addr, hash, size: b.length, expiry });
  const sig = await key.signMessage({ message: msg });
  const r = await fetch(adapterA.base + "/add-json", { method: "POST", headers: { "content-type": "application/json", "x-upload-address": addr, "x-upload-expiry": String(expiry),
    "x-upload-sha256": hash, "x-upload-signature": sig }, body: b });
  assert.equal(r.status, 200, await r.text());
  const lb = body("legacy"), lhash = sha(lb);
  const token = crypto.createHmac("sha256", LEGACY_KEY).update(`${addr}:${lhash}:${expiry}`).digest("hex");
  const l = await fetch(adapterA.base + "/add-json", { method: "POST", headers: { "content-type": "application/json", "x-upload-address": addr, "x-upload-expiry": String(expiry), "x-upload-token": token }, body: lb });
  assert.equal(l.status, 200, await l.text());
  // a scheme-declared upload never falls back to the token path
  const mixed = await fetch(adapterA.base + "/add-json", { method: "POST", headers: { "content-type": "application/json", "x-upload-scheme": "erc1271-v2", "x-upload-address": addr,
    "x-upload-expiry": String(expiry), "x-upload-token": token }, body: lb });
  assert.equal(mixed.status, 401);
});
