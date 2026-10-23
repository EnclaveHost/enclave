// The operator's owner nomination against the REAL contracts (contracts/EnclaveRegistry.sol and the ORIGINAL
// contracts/EnclaveHostOwnership.sol, compiled here) on a local chain (anvil, chain 8453, 1 s blocks), driven through the
// REAL supervisor (OWNER_NOMINATION_SELFTEST: its nominator, operator key, operator queue _txChain/sendOperatorTx and
// strict state file) with the config's RPC quorum served by three loopback proxies (ok | down | lieA | lieB: a lie
// corrupts the first word of every eth_call answer). Fixture keys only; nothing leaves loopback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import solc from "solc";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toBytes, decodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const exec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const T = { skip: !haveAnvil && "needs anvil", timeout: 240_000 };
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWN_ABI = parseAbi(["function proposeOwner(bytes32 hostId, address next)", "function acceptOwner(bytes32 hostId)",
  "function authority(bytes32) view returns (address owner, address pendingOwner, uint64 revision, bytes32 policyHash)"]);
const lc = (a) => String(a).toLowerCase();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-nomination-chain-"));
let anvil, url, chain, pc, C, registry, ownership, registry2, ownership2, codeHash, codeHash2, opKey, op, start = 0n;
const proxies = [], closers = [];

const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const wallet = (key) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: viemHttp(url) });
const mined = async (hash) => { const r = await pc.waitForTransactionReceipt({ hash }); assert.equal(r.status, "success"); return r; };
const fund = (a) => pc.request({ method: "anvil_setBalance", params: [a, "0x56bc75e2d63100000"] });
async function deploy(name, args = []) {
  const c = C.contracts[name + ".sol"][name];
  return lc((await mined(await wallet(DEPLOYER).deployContract({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, args }))).contractAddress);
}
async function host(tag, key = opKey) {
  const endpoint = `https://api.example.test/t/${tag}`;
  await mined(await wallet(key).writeContract({ address: registry, abi: C.contracts["EnclaveRegistry.sol"].EnclaveRegistry.abi, functionName: "register",
    args: [endpoint, "owner/enclave", "0x" + "1".repeat(64), 1n, 0n, privateKeyToAccount(key).address] }));
  return { endpoint, hostId: lc(keccak256(toBytes(endpoint))) };
}
const authority = async (hostId, at = ownership) => { const [owner, pendingOwner] = await pc.readContract({ address: at, abi: OWN_ABI, functionName: "authority", args: [hostId] }); return { owner: lc(owner), pending: lc(pendingOwner) }; };
/** every transaction the operator sent from block `from`: {nonce, to, fn} */
async function operatorTxs(from) {
  const out = [];
  for (let n = from; n <= await pc.getBlockNumber({ cacheTime: 0 }); n++)
    for (const tx of (await pc.getBlock({ blockNumber: n, includeTransactions: true })).transactions)
      if (lc(tx.from) === op) out.push({ nonce: tx.nonce, to: lc(tx.to), fn: lc(tx.to) === ownership || lc(tx.to) === ownership2 ? decodeFunctionData({ abi: OWN_ABI, data: tx.input }).functionName : "other", hash: tx.hash });
  return out;
}

before(async () => {
  if (!haveAnvil) return;
  const port = await freePort();
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--block-time", "1", "--silent"], { stdio: "ignore" });
  closers.push(() => anvil.kill("SIGKILL"));
  url = `http://127.0.0.1:${port}`;
  chain = { id: 8453, name: "local-8453", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } };
  pc = createPublicClient({ chain, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const sources = Object.fromEntries(["EnclaveRegistry", "EnclaveHostOwnership"].map((n) => [n + ".sol", { content: fs.readFileSync(path.join(REPO, "contracts", n + ".sol"), "utf8") }]));
  C = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  assert.deepEqual((C.errors || []).filter((e) => e.severity === "error"), []);
  registry = await deploy("EnclaveRegistry"); ownership = await deploy("EnclaveHostOwnership", [registry]);
  registry2 = await deploy("EnclaveRegistry"); ownership2 = await deploy("EnclaveHostOwnership", [registry2]);
  codeHash = lc(keccak256(await pc.getCode({ address: ownership }))); codeHash2 = lc(keccak256(await pc.getCode({ address: ownership2 })));
  opKey = generatePrivateKey(); op = lc(privateKeyToAccount(opKey).address); await fund(op);
  for (let i = 0; i < 3; i++) {
    const mode = { m: "ok" };
    const s = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
      if (mode.m === "down") { res.writeHead(503); return res.end("down"); }
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: b });
      let text = await r.text();
      if (mode.m.startsWith("lie")) {
        const j = JSON.parse(b), o = JSON.parse(text), flip = mode.m === "lieA" ? 1 : 2;
        const lie = (q, a) => { if (q.method === "eth_call" && typeof a.result === "string" && a.result.length >= 66)
          a.result = a.result.slice(0, 2) + (parseInt(a.result[2], 16) ^ flip).toString(16) + a.result.slice(3); return a; };
        text = JSON.stringify(Array.isArray(j) ? o.map((a, k) => lie(j[k], a)) : lie(j, o));
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(text); }); });
    await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
    closers.push(() => { s.closeAllConnections(); s.close(); });
    proxies.push({ url: `http://127.0.0.1:${s.address().port}`, mode });
  }
  start = await pc.getBlockNumber();
});
after(() => { for (const c of closers.reverse()) try { c(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

const setModes = (...m) => m.forEach((x, i) => (proxies[i].mode.m = x));
const NOM = (h, o = {}) => ({ format: "enclave-host-owner-nomination/v1", chainId: 8453, ownershipContract: ownership, ownershipCodeHash: codeHash, registry,
  hostId: h.hostId, endpoint: h.endpoint, operator: op, owner: o.owner ?? OWNER, rpcs: proxies.map((p) => p.url), quorum: 2, ...o });
const OWNER_KEY = generatePrivateKey(), OWNER = lc(privateKeyToAccount(OWNER_KEY).address), OTHER = lc(privateKeyToAccount(generatePrivateKey()).address);
/** the REAL supervisor's nominator, one seam run; returns its JSON line */
async function nominate(h, { nom = NOM(h), state = path.join(tmp, `state-${Math.random().toString(16).slice(2)}.json`), key = opKey, selftest = {}, raw = null } = {}) {
  const env = { PATH: process.env.PATH, HOME: tmp, SECRET: "owner-nomination-test", ENABLE_MPS: "0", STATE_FILE: state, CHAIN_ID: "8453",
    BASE_RPC: url, BASE_RPCS: url, REGISTRY_ADDRESS: registry, ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
    REGISTRY_PRIVATE_KEY: key, ENCLAVE_REPO: "owner/enclave", ENCLAVE_PLATFORM_HOST_POLICY: "off", SECRETS_API: "", DOMAINS_API: "", CERTS_API: "",
    DNS_API: "", APP_CERT_DOMAIN: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
    ...(raw !== undefined && (raw ?? nom) ? { ENCLAVE_OWNER_NOMINATION: raw ?? JSON.stringify(nom) } : {}),
    OWNER_NOMINATION_SELFTEST: JSON.stringify({ endpoint: h.endpoint, passes: 15, gapMs: 1000, ...selftest }) };
  const { stdout, stderr } = await exec(process.execPath, ["supervisor.js"], { cwd: REPO, env, timeout: 200_000, maxBuffer: 8 << 20 })
    .catch((e) => { throw new Error((e.stderr || "") + (e.stdout || "") + e.message); });
  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  if (!line) throw new Error("the seam printed no result line. stdout:\n" + stdout.slice(-3000) + "\nstderr:\n" + String(stderr).slice(-2000));
  return { out: JSON.parse(line), state, log: stdout };
}
const proposes = (txs, h) => txs.filter((t) => t.fn === "proposeOwner");

test("0/0: exactly one proposeOwner from the operator; the wallet is pending; a second run is idempotent; after acceptOwner still nothing", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("positive"), from = await pc.getBlockNumber();
  const { out, state } = await nominate(h);
  assert.equal(out.status.status, "done", JSON.stringify(out));
  assert.match(out.status.why, /is nominated; the owner wallet accepts next/);
  assert.deepEqual(await authority(h.hostId), { owner: "0x" + "0".repeat(40), pending: OWNER });
  const txs = await operatorTxs(from);
  assert.equal(proposes(txs).length, 1, JSON.stringify(txs)); assert.equal(txs.length, 1);
  assert.equal(out.status.tx.hash, lc(txs[0].hash)); assert.equal(out.saved.tx.raw, true, "the signed bytes were kept durable");
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).ownerNomination.status, "done");
  // idempotent: a fresh process (and a fresh state file) sends nothing
  const again = await nominate(h);
  assert.equal(again.out.status.status, "done"); assert.equal(again.out.status.tx, null);
  // the owner wallet accepts (its own step): the nomination stays satisfied, nothing is sent
  await fund(OWNER); await mined(await wallet(OWNER_KEY).writeContract({ address: ownership, abi: OWN_ABI, functionName: "acceptOwner", args: [h.hostId] }));
  await new Promise((r) => setTimeout(r, 3000));
  const owned = await nominate(h);
  assert.equal(owned.out.status.status, "done"); assert.match(owned.out.status.why, /already accepted/);
  assert.equal(proposes(await operatorTxs(from)).length, 1, "still exactly one proposeOwner");
});

test("a DIFFERENT pending (or owner) is refused and never replaced", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("conflict");
  await mined(await wallet(opKey).writeContract({ address: ownership, abi: OWN_ABI, functionName: "proposeOwner", args: [h.hostId, OTHER] }));
  await new Promise((r) => setTimeout(r, 3000));
  const from = await pc.getBlockNumber();
  const { out } = await nominate(h);
  assert.equal(out.status.status, "refused"); assert.match(out.status.why, /already has owner .* pending 0x[0-9a-f]+: never replaced/);
  assert.equal((await authority(h.hostId)).pending, OTHER);
  assert.deepEqual(await operatorTxs(from), []);
});

test("wrong operator / wrong contract / unbound registry: refused, nothing sent", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("bindings"), from = await pc.getBlockNumber();
  // the config names another operator than this host's key
  const a = await nominate(h, { nom: NOM(h, { operator: OTHER }) });
  assert.equal(a.out.status.status, "refused"); assert.match(a.out.status.why, /is not this host's operator key/);
  // the registry names another operator for this host (registered by another key; this key nominates for it)
  const k2 = generatePrivateKey(); await fund(privateKeyToAccount(k2).address);
  const h2 = await host("other-operator", k2);
  const b = await nominate(h2);
  assert.equal(b.out.status.status, "refused"); assert.match(b.out.status.why, /registry names operator/);
  // not the reviewed code hash
  const c = await nominate(h, { nom: NOM(h, { ownershipCodeHash: "0x" + "ab".repeat(32) }) });
  assert.equal(c.out.status.status, "refused"); assert.match(c.out.status.why, /is not the reviewed/);
  // a genuine EnclaveHostOwnership, with its own true code hash, bound to ANOTHER registry
  const d = await nominate(h, { nom: NOM(h, { ownershipContract: ownership2, ownershipCodeHash: codeHash2 }) });
  assert.equal(d.out.status.status, "refused"); assert.match(d.out.status.why, /bound to registry/);
  assert.deepEqual(await operatorTxs(from), []);
  assert.deepEqual(await authority(h.hostId), { owner: "0x" + "0".repeat(40), pending: "0x" + "0".repeat(40) });
});

test("RPC disagreement: no quorum, nothing sent, retried later; one liar is outvoted", T, async () => {
  const h = await host("rpc"), from = await pc.getBlockNumber(), state = path.join(tmp, "rpc-state.json");
  setModes("lieA", "lieB", "ok");
  const a = await nominate(h, { state, selftest: { passes: 3 } });
  assert.equal(a.out.terminal, false); assert.equal(a.out.status.status, "pending-check"); assert.match(a.out.status.why, /retry later: .*quorum did not agree/);
  assert.deepEqual(await operatorTxs(from), []);
  setModes("lieA", "ok", "ok");
  const b = await nominate(h, { state });
  assert.equal(b.out.status.status, "done", JSON.stringify(b.out)); assert.equal(proposes(await operatorTxs(from)).length, 1);
  setModes("down", "down", "ok");
  const c = await nominate(await host("rpc-down"), { selftest: { passes: 2 } });
  assert.equal(c.out.status.status, "pending-check"); assert.match(c.out.status.why, /cannot read the configured chain/);
});

test("nonce concurrency: registry heartbeats from the same queue around the nomination all land, nonces contiguous, one proposeOwner", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("concurrency"), from = await pc.getBlockNumber(), n0 = await pc.getTransactionCount({ address: op });
  const { out } = await nominate(h, { selftest: { heartbeats: 3 } });
  assert.equal(out.status.status, "done", JSON.stringify(out));
  assert.equal(out.heartbeats.length, 6); assert.ok(out.heartbeats.every((x) => x.status === "success"), JSON.stringify(out.heartbeats));
  const txs = await operatorTxs(from);
  assert.equal(txs.length, 7); assert.equal(proposes(txs).length, 1);
  assert.deepEqual(txs.map((t) => t.nonce).sort((x, y) => x - y), Array.from({ length: 7 }, (_, i) => n0 + i));
});

test("ambiguous broadcasts: a lost reply, a broadcast that never reached the chain, and one whose nonce another transaction took", T, async () => {
  setModes("ok", "ok", "ok");
  for (const [mode, sends] of [["lost-reply", 1], ["never-sent", 1], ["never-sent-then-other", 2]]) {
    const h = await host("ambiguous-" + mode), from = await pc.getBlockNumber();
    const { out } = await nominate(h, { selftest: { ambiguous: mode } });
    assert.equal(out.status.status, "done", mode + " " + JSON.stringify(out));
    assert.equal(out.status.sends, sends, mode);
    const txs = await operatorTxs(from);
    assert.equal(proposes(txs).length, 1, mode + ": exactly one proposeOwner landed");
    assert.equal(out.status.tx.hash, lc(proposes(txs)[0].hash), mode + ": the recorded transaction is the one that landed");
    if (mode === "never-sent-then-other") { assert.equal(txs.length, 2); assert.ok(out.otherTx?.status === "success"); }
    assert.deepEqual(await authority(h.hostId), { owner: "0x" + "0".repeat(40), pending: OWNER });
  }
});

test("no config: nothing at all; an invalid config: refused before anything", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("absent"), from = await pc.getBlockNumber();
  const none = await nominate(h, { raw: undefined, nom: null });
  assert.match(none.out.error, /not configured/);
  const bad = await nominate(h, { nom: NOM(h, { owner: op }) });
  assert.match(bad.out.error, /other than the operator/);
  assert.equal(bad.out.status.status, "refused");
  assert.deepEqual(await operatorTxs(from), []);
});

// ---- the journal rules in the REAL supervisor (its strict state writer and operator queue), root review 2026-10-21 ------
test("a state file that cannot be written: nothing is broadcast; writable again: the nomination goes out once", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("journal-readonly"), from = await pc.getBlockNumber();
  // unwritable for ANY user: the state path's parent is a regular file (ENOTDIR). A 0500 directory is not enough where
  // the suite runs as root (a user namespace, as the queued runner does): root writes into it, and the case passed vacuously
  // nowhere but failed there - the same on the baseline (673601e54) as here
  const ro = path.join(tmp, "readonly"); fs.writeFileSync(ro, "not a directory");
  const a = await nominate(h, { state: path.join(ro, "state.json"), selftest: { passes: 3, gapMs: 500 } });
  assert.equal(a.out.status.status, "pending-check", JSON.stringify(a.out)); assert.match(a.out.status.why, /could not be made durable: dropped, nothing broadcast/);
  assert.equal(a.out.status.sends, 0); assert.equal(a.out.status.tx, null);
  assert.deepEqual(await operatorTxs(from), [], "no transaction reached the chain");
  fs.rmSync(ro); fs.mkdirSync(ro);   // writable again
  const b = await nominate(h, { state: path.join(ro, "state.json") });
  assert.equal(b.out.status.status, "done", JSON.stringify(b.out)); assert.equal(proposes(await operatorTxs(from)).length, 1);
});

test("restart with a durable but never-broadcast nomination: exactly those bytes land", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("journal-restart"), from = await pc.getBlockNumber(), state = path.join(tmp, "restart-state.json");
  const a = await nominate(h, { state, selftest: { ambiguous: "never-sent", passes: 1 } });
  assert.equal(a.out.status.status, "sent"); const known = a.out.status.tx.hash;
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).ownerNomination.tx.hash, known, "durable before the (failed) broadcast");
  assert.deepEqual(await operatorTxs(from), []);
  const b = await nominate(h, { state });
  assert.equal(b.out.status.status, "done", JSON.stringify(b.out));
  const txs = proposes(await operatorTxs(from));
  assert.equal(txs.length, 1); assert.equal(lc(txs[0].hash), known, "the restarted process sent the recorded bytes, nothing new");
  assert.equal(b.out.status.sends, 1);
});

test("a changed recipient while the earlier nomination is unresolved: nothing until it settles; the old recipient never lands", T, async () => {
  setModes("ok", "ok", "ok");
  const h = await host("journal-changed"), from = await pc.getBlockNumber(), state = path.join(tmp, "changed-state.json");
  const a = await nominate(h, { state, selftest: { ambiguous: "never-sent", passes: 1 } });
  const oldTx = JSON.parse(fs.readFileSync(state, "utf8")).ownerNomination.tx;
  // the operator's config now names another owner
  const b = await nominate(h, { state, nom: NOM(h, { owner: OTHER }), selftest: { passes: 2, gapMs: 500 } });
  assert.equal(b.out.status.status, "blocked-unresolved", JSON.stringify(b.out));
  assert.deepEqual(await operatorTxs(from), [], "neither the old recipient's nomination nor a new one");
  const kept = JSON.parse(fs.readFileSync(state, "utf8")).ownerNomination;
  assert.equal(kept.unresolved[0].tx.raw, oldTx.raw); assert.equal(kept.unresolved[0].owner, OWNER);
  // another operator transaction takes that nonce (here a plain transfer by the same key): the old one can never land
  await mined(await wallet(opKey).sendTransaction({ to: op, value: 0n }));
  await new Promise((r) => setTimeout(r, 3000));
  const c = await nominate(h, { state, nom: NOM(h, { owner: OTHER }) });
  assert.equal(c.out.status.status, "done", JSON.stringify(c.out));
  assert.deepEqual(await authority(h.hostId), { owner: "0x" + "0".repeat(40), pending: OTHER });
  const ps = proposes(await operatorTxs(from));
  assert.equal(ps.length, 1); assert.notEqual(lc(ps[0].hash), oldTx.hash, "the old recipient's bytes never landed");
  const done = JSON.parse(fs.readFileSync(state, "utf8")).ownerNomination;
  assert.equal(done.history[0].tx.raw, oldTx.raw); assert.equal(done.history[0].tx.state, "dropped");
});
