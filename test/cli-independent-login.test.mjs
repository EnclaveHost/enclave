// cli/independent-login.mjs on a real local chain: anvil, the PINNED session factory and its vaults from the Foundry
// build (no solc-js), a contract-wallet owner (ERC-1271, the way a passkey Safe signs), the real sessions SDK (P-256 keys,
// EIP-712 grants), the CLI's QuorumChain over two clients, and a FileStore in a temporary directory. The owner's side is
// what the /grant page does: prepareSessionOpen with the owner's signer, submitted by a SEPARATE gas wallet.
//
//   run: node --test --test-concurrency=1 test/cli-independent-login.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, encodeDeployData, getAddress, hashTypedData, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { linkBytecode } from "../site/js/lib/contract-linker.js";
import * as S from "../sdk/sessions/dist/node.mjs";
import { QuorumChain, quorumPublicClient, sessionSnapshot } from "../cli/independent.mjs";
import { createIndependentLogin, frontendOrigin, LoginError } from "../cli/independent-login.mjs";
import { independentLoginCommand } from "../cli/independent-login-cli.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "contracts", "foundry", "out");
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  gas: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",       // the gas payer: never the account
  attacker: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  safeSigner: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",  // approves for the contract account
};
const FRONTEND = "https://owner-reviewed.example";
const tools = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); } catch { return "needs Foundry's anvil"; }
  return fs.existsSync(path.join(OUT, "PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory.json")) ? null : "needs the Foundry build (forge build)"; })();
const T = tools ? { skip: tools } : { timeout: 120000 };

let proc, rpc, pc, chain, qpc, factory, account1271, tmp, clock = 0;
const nowMs = () => Date.now() + clock * 1000;
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences }; };
const wallet = (key) => createWalletClient({ chain: foundry, account: privateKeyToAccount(key), transport: http(rpc) });
async function send(key, to, data) {
  const hash = await wallet(key).sendTransaction({ to, data });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("transaction reverted");
  return rc;
}
async function warp(seconds) {
  await pc.request({ method: "evm_increaseTime", params: [toHex(seconds)] });
  await pc.request({ method: "evm_mine", params: [] });
  clock += seconds;
}

before(async () => {
  if (tools) return;
  const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
  proc = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--silent", "--base-fee", "5000000"], { stdio: "ignore" });
  rpc = `http://127.0.0.1:${port}`;
  pc = createPublicClient({ chain: foundry, transport: http(rpc) });
  for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const dep = wallet(KEYS.deployer);
  const deploy = async (a, args = [], libs = {}) => {
    const bytecode = Object.keys(a.linkReferences || {}).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
    const rc = await pc.waitForTransactionReceipt({ hash: await dep.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }) }) });
    if (rc.status !== "success") throw new Error("deploy failed");
    return getAddress(rc.contractAddress);
  };
  const usdc = await deploy(art("SessionMocks.sol", "MockUSDC3009"));
  const registry = await deploy(art("SessionMocks.sol", "SessionRegistryStub"));
  const bw = await deploy(art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"));
  const ledger = await deploy(art("EnclaveDeployments.sol", "EnclaveDeployments"), [usdc, "0x00000000000000000000000000000000000e2e01", registry, "0x" + "00".repeat(20)],
    { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bw });
  const catalog = await deploy(art("EnclaveAppCatalog.sol", "EnclaveAppCatalog"));
  const router = await deploy(art("PaymentRouter.sol", "PaymentRouter"), [usdc, "0x00000000000000000000000000000000000e2e01"]);
  const svlib = await deploy(art("SessionVault.sol", "SessionVaultLib"));
  factory = await deploy(art("PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory"),
    [usdc, ledger, catalog, router, "0x" + "00".repeat(20), parseUnits("1000", 6)], { "contracts/SessionVault.sol:SessionVaultLib": svlib });
  // the contract account (stand-in for a passkey Safe): it validates its approver's signature over the EIP-712 digest
  account1271 = await deploy(art("SessionMocks.sol", "Mock1271Owner"), [privateKeyToAccount(KEYS.safeSigner).address]);
  // the CLI's own quorum view: two clients (distinct objects) at one agreed block, the chain clock following the warps
  const c = () => createPublicClient({ chain: foundry, transport: http(rpc) });
  chain = new QuorumChain({ clients: [{ origin: rpc + "/a", client: c() }, { origin: rpc + "/b", client: c() }], quorum: 2, confirmations: 0,
    maxBlockAgeMs: 600000, chainId: 31337, now: nowMs });
  qpc = quorumPublicClient(chain);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ind-login-"));
});
after(() => { proc?.kill("SIGKILL"); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
function cli(extra = {}) {
  const dir = extra.dir || path.join(tmp, `cli-${++n}`);
  const store = new S.FileStore(path.join(dir, "sessions"));
  return { dir, store, login: createIndependentLogin({ S, chain, pc: qpc, sessionSnapshot, store, stateDir: path.join(dir, "sessions", "login"),
    factory, chainId: 31337, frontend: FRONTEND, now: nowMs, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))), ...extra.deps }) };
}
// what the owner's frontend does with the link: decode, check the key against the grant, sign as the account, and have a
// gas payer submit the factory's openFor
function ownerFromLink(link) {
  const r = S.decodeGrantRequest(link.split("#")[1]);
  assert.equal(S.keyHashOf(BigInt(r.x), BigInt(r.y)).toLowerCase(), String(r.grant.sessionKey).toLowerCase(), "the link's key is the grant's key");
  return r;
}
const eoaOwner = (key) => privateKeyToAccount(key);
const contractOwner = () => ({ address: account1271, signTypedData: async (td) => privateKeyToAccount(KEYS.safeSigner).sign({ hash: hashTypedData(td) }) });
// poll until the chain decides (the agreed block may trail a just-mined transaction by a poll), bounded
async function decided(login, id, opts = {}) {
  for (let i = 0; i < 40; i++) {
    const r = await login.poll(id, opts);
    if (r.state !== "waiting") return r;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  return { state: "waiting" };
}
async function openAs(owner, grant, payer = KEYS.gas) {
  const prep = await S.prepareSessionOpen({ publicClient: qpc, factory, owner, chainId: 31337, grant });
  await send(payer, prep.to, prep.data);
  return prep;
}

test("a bound sign-in: the link carries no secret, the wallet owner approves, the CLI adopts exactly that session", T, async () => {
  const { login, store, dir } = cli();
  const owner = eoaOwner(KEYS.owner);
  const b = await login.begin({ preset: "auth-only", owner: owner.address, days: 1 });
  assert.match(b.link, /^https:\/\/owner-reviewed\.example\/grant#/);
  assert.match(b.checkCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  const rec = await store.load(b.id);
  assert.ok(rec.pkcs8 && !b.link.includes(rec.pkcs8), "the private key never leaves the store");
  for (const f of fs.readdirSync(path.join(dir, "sessions", "login"))) assert.ok(!fs.readFileSync(path.join(dir, "sessions", "login", f), "utf8").includes(rec.pkcs8));
  assert.equal((await login.poll(b.id)).state, "waiting");
  const r = ownerFromLink(b.link);
  assert.equal(r.owner.toLowerCase(), owner.address.toLowerCase());
  const prep = await openAs(owner, r.grant);
  assert.equal(prep.sid.toLowerCase(), b.sid);
  const got = await login.wait(b.id, { timeoutMs: 20000, pollMs: 10 });
  assert.deepEqual([got.state, got.sid, got.owner], ["open", b.sid, owner.address.toLowerCase()]);
  assert.equal(store.activeId(), b.sid);
  const open = await store.load(b.sid);
  assert.equal(open.handle.vault.toLowerCase(), b.vault);
  assert.equal(login.identity().owner, owner.address.toLowerCase(), "the account is pinned for later sign-ins");
  assert.equal((await login.poll(b.id)).state, "open", "polling again is idempotent");
});

test("a contract account (ERC-1271, like a passkey Safe) signs only; the CLI verifies the signature on chain before a separate gas wallet submits", T, async () => {
  const { login, store } = cli();
  const b = await login.begin({ preset: "auth-only" });                       // the owner is left to the person approving
  const r = ownerFromLink(b.link);
  assert.equal(r.owner, undefined);
  const vault = await S.vaultAddress(qpc, factory, account1271);
  const sig = await contractOwner().signTypedData(S.grantTypedData(31337, vault, r.grant));
  // a wrong signature is refused by the pinned factory's own check, at an agreed block; nothing comes back to send
  const bad = await privateKeyToAccount(KEYS.attacker).sign({ hash: hashTypedData(S.grantTypedData(31337, vault, r.grant)) });
  await assert.rejects(login.signedOpen(b.id, bad, { owner: account1271 }), (e) => e instanceof LoginError && /refuses this signature/.test(e.message));
  const tx = await login.signedOpen(b.id, sig, { owner: account1271 });
  assert.equal(tx.vault, vault.toLowerCase());
  await send(KEYS.gas, tx.to, tx.data);                                        // the gas wallet is not the account
  const got = await login.wait(b.id, { timeoutMs: 20000, pollMs: 10 });
  assert.deepEqual([got.state, got.owner], ["open", account1271.toLowerCase()]);
  assert.equal(store.activeId(), tx.sid);
});

test("a key opened in someone else's vault is never adopted silently; the pinned or confirmed account is", T, async () => {
  const { login } = cli();
  const owner = eoaOwner(KEYS.owner), attacker = eoaOwner(KEYS.attacker);
  // no account pinned yet, owner left open: the attacker, who saw the link, opens it in THEIR vault
  const b = await login.begin({ preset: "auth-only" });
  await openAs(attacker, ownerFromLink(b.link).grant);
  const c = await decided(login, b.id);
  assert.equal(c.state, "confirm-owner");
  assert.deepEqual(c.candidates.map((x) => x.owner), [attacker.address.toLowerCase()]);
  assert.equal(login.identity(), null, "nothing was adopted or pinned");
  // the person at the terminal names their own account: still not the attacker's
  assert.equal((await decided(login, b.id, { acceptOwner: owner.address })).state, "confirm-owner");
  // the real owner opens it too; confirming that account adopts it, and the other opener is reported
  await openAs(owner, ownerFromLink(b.link).grant);
  // the owner's open may trail the attacker's by a poll: wait until both are seen before confirming
  let got;
  for (let i = 0; i < 40 && !got?.alsoOpenedBy; i++) {
    got = await login.poll(b.id, { acceptOwner: owner.address });
    if (got.state === "open") break;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  assert.equal(got.state, "open"); assert.equal(got.owner, owner.address.toLowerCase());
  assert.deepEqual(got.alsoOpenedBy, [attacker.address.toLowerCase()]);
  // later sign-ins: the pinned account is adopted without a prompt, any other needs an explicit switch
  const b2 = await login.begin({ preset: "auth-only" });
  await openAs(attacker, ownerFromLink(b2.link).grant);
  assert.equal((await decided(login, b2.id)).state, "confirm-owner", "a different account than the pinned one is not followed");
  await assert.rejects(login.begin({ preset: "auth-only", owner: attacker.address }), (e) => e.code === "identity-switch");
});

test("only the exact grant is adopted: the same key and nonce opened with another policy is refused", T, async () => {
  const { login } = cli();
  const owner = eoaOwner(KEYS.owner);
  const b = await login.begin({ preset: "auth-only", owner: owner.address });
  const g = ownerFromLink(b.link).grant;
  const wider = { ...g, actions: [...g.actions, "deploy.fund"] };              // same sessionKey and grantNonce, so the same sid
  await openAs(owner, wider);
  const r = await decided(login, b.id);
  assert.equal(r.state, "refused"); assert.match(r.reason, /actions/);
});

test("an interrupted sign-in resumes from its saved state; logout keeps the session and says how to end it; top-up stays owner-controlled", T, async () => {
  const first = cli(), owner = eoaOwner(KEYS.owner);
  const b = await first.login.begin({ preset: "auth-only" });
  await first.login.poll(b.id, {});                                            // some of the window scanned, then the process dies
  // a new process over the same files: the pending login is listed and resumes from where the scan stopped
  const second = cli({ dir: first.dir });
  const p = second.login.pending();
  assert.deepEqual(p.map((x) => x.id), [b.id]);
  assert.ok(p[0].scannedTo >= p[0].startBlock - 1n);
  await openAs(owner, ownerFromLink(b.link).grant);
  const got = await second.login.wait(b.id, { timeoutMs: 20000, pollMs: 10, acceptOwner: owner.address });
  assert.equal(got.state, "open");
  assert.deepEqual(second.login.pending(), []);
  // a CLI with other trust (another factory) neither adopts nor discards it
  const other = cli({ dir: first.dir, deps: { factory: "0x" + "12".repeat(20) } });
  await assert.rejects(other.login.poll(b.id), (e) => e.code === "binding");
  // top-up: a link to the owner's frontend; the owner signs the USDC authorization there
  const t = await second.login.topUpLink({ amountUsd: 2.5 });
  assert.equal(t.link, `${FRONTEND}/sessions#topup=${getAddress(got.vault)}:${got.sid}:2500000`);
  // logout: the pointer goes, the session does not, and the key stays so the session can still end itself
  await assert.rejects(second.login.logout({ forgetKey: true }), (e) => e.code === "live");
  const out = await second.login.logout();
  assert.deepEqual([out.cleared, out.live, out.keyKept], [true, true, true]);
  assert.match(out.endWith, /session terminate/);
  assert.equal(second.store.activeId(), null);
  assert.ok(await second.store.load(got.sid), "the key is kept");
  const snap = await sessionSnapshot(chain, { factory, vault: got.vault, sid: got.sid });
  assert.equal(snap.live, true, "logout claimed nothing on chain");
});

test("frontends are exact owner-chosen origins", () => {
  assert.equal(frontendOrigin("https://Dash.Example."), "https://dash.example");
  assert.equal(frontendOrigin("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  for (const bad of ["http://dash.example", "https://dash.example/grant", "https://dash.example/?x=1", "https://u:p@dash.example", "https://dash.example/#a", "ftp://dash.example", "nope"])
    assert.throws(() => frontendOrigin(bad), LoginError, bad);
});

test("the commands: login prints a link and resumes, account and top-up-link report, logout sets aside; a handed-back signature is submitted by a gas key", T, async () => {
  const dir = path.join(tmp, `cmd-${++n}`), lines = [];
  const store = new S.FileStore(path.join(dir, "sessions"));
  const flagsOf = (rest, { bool = [], val = [] }) => {                          // cli/enclave.mjs flags(), same contract
    const o = { _: [] };
    for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (bool.includes(a)) o[a.slice(2)] = true; else if (val.includes(a)) o[a.slice(2)] = rest[++i]; else if (a.startsWith("-")) throw new Error("unknown flag " + a); else o._.push(a); }
    return o;
  };
  const sent = [];
  const ctx = { S, chain, pc: qpc, sessionSnapshot, store, stateDir: path.join(dir, "sessions", "login"), factory, chainId: 31337, profileDigest: null,
    env: { ENCLAVE_FRONTEND: FRONTEND }, flags: flagsOf, numFlag: (v) => Number(v), say: (t) => lines.push(String(t)), jout: (o) => lines.push(JSON.stringify(o, (k, v) => typeof v === "bigint" ? String(v) : v)),
    json: false, confirm: async () => true, interactive: false, now: nowMs, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))),
    gasKey: () => privateKeyToAccount(KEYS.gas), sendTx: async (acct, { to, data }) => { sent.push(acct.address); return send(KEYS.gas, to, data); } };
  const owner = eoaOwner(KEYS.owner);
  await independentLoginCommand("login", ["--owner", owner.address, "--no-wait"], ctx);
  const link = lines.join("\n").match(/https:\/\/owner-reviewed\.example\/grant#\S+/)[0];
  assert.match(lines.join("\n"), /check code [0-9A-F]{4}-[0-9A-F]{4}/);
  assert.match(lines.join("\n"), /nothing is opened for you/);
  await openAs(owner, ownerFromLink(link).grant);
  lines.length = 0;
  await independentLoginCommand("login", ["--resume", "--wait-minutes", "1"], ctx);
  assert.match(lines.join("\n"), /signed in: session 0x[0-9a-f]{64} of 0x/);
  lines.length = 0;
  await independentLoginCommand("account", [], ctx);
  assert.match(lines.join("\n"), new RegExp("account: " + owner.address.toLowerCase()));
  assert.match(lines.join("\n"), /\(live\)/);
  lines.length = 0;
  await independentLoginCommand("session top-up-link", ["--amount", "3"], ctx);
  assert.match(lines.join("\n"), /\/sessions#topup=0x[0-9a-fA-F]{40}:0x[0-9a-f]{64}:3000000/);
  lines.length = 0;
  await independentLoginCommand("logout", [], ctx);
  assert.match(lines.join("\n"), /STILL LIVE on chain: .*session terminate/);
  // the hand-back route for a contract account: the CLI checks the signature on chain, and a gas key that is not the
  // account submits it
  lines.length = 0;
  await independentLoginCommand("login", ["--owner", account1271, "--no-wait", "--switch-account"], ctx);
  const r = ownerFromLink(lines.join("\n").match(/https:\/\/owner-reviewed\.example\/grant#\S+/)[0]);
  const vault = await S.vaultAddress(qpc, factory, account1271);
  const sig = await contractOwner().signTypedData(S.grantTypedData(31337, vault, r.grant));
  lines.length = 0;
  await independentLoginCommand("login", ["--owner-signature", sig, "--wait-minutes", "1"], ctx);
  assert.deepEqual(sent, [privateKeyToAccount(KEYS.gas).address]);
  assert.match(lines.join("\n"), new RegExp("signed in: session 0x[0-9a-f]{64} of " + account1271.toLowerCase()));
  await assert.rejects(independentLoginCommand("login", ["--owner", owner.address, "--no-wait"], { ...ctx, env: {} }), /--frontend/);
});

test("a sign-in nobody approved expires at the agreed chain time and its key is deleted", T, async () => {
  const { login, store } = cli();
  const b = await login.begin({ preset: "auth-only", owner: eoaOwner(KEYS.owner).address, signWithinSec: 60 });
  assert.equal((await login.poll(b.id)).state, "waiting");
  await warp(120);                                                             // last: later grants would be built in the past
  assert.equal((await login.poll(b.id)).state, "expired");
  assert.equal(await store.load(b.id), null);
});
