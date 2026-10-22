// Independent custody through the REAL combined cli/enclave.mjs (or the built bundle: ENCLAVE_CLI_ENTRY) as a subprocess:
// create, rotate, pause/resume, recover after a ledger transfer, migrate from a sealed export, and clear. The world is
// test/custody-cli-independent.test.mjs's: anvil with the REAL EnclaveSecretVaultV2 and EnclaveHostOwnership (the rig's
// compile cache), ledger and registry stand-ins, and a REAL independent committee (3 hosts, distinct non-Enclave owners)
// whose key the test knows. That suite drives the command in-process. This one drives the dispatch: the custody glue,
// and the flags custody shares with enclave's global ones (`migrate --from FILE`, `clear --yes`), which the global parser
// takes out of argv. Synthetic: no custodian runs; a stored bundle is opened with the committee's known secret.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toBytes, stringToHex, parseEther, bytesToHex, hexToBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as v2 from "../custody/v2/protocol.mjs";
import * as D from "../custody/v2/digests.mjs";
import { VAULT_V2_ABI } from "../custody/v2/chain.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY ? path.resolve(process.env.ENCLAVE_CLI_ENTRY) : path.join(ROOT, "cli", "enclave.mjs");
const require = createRequire(import.meta.url);
const haveAnvil = (() => { try { require("node:child_process").execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const options = { skip: !haveAnvil && "needs Foundry's anvil", timeout: 300000 };
const CHAIN = 8453;

// the same compile cache key as test/custody-cli-independent.test.mjs and test/helpers/independent-custody-rig.mjs
function compiled() {
  const rig = fs.readFileSync(path.join(ROOT, "test/helpers/independent-custody-rig.mjs"), "utf8");
  const MOCKS = /const MOCKS = `([\s\S]*?)`;/.exec(rig)[1];
  const src = fs.readFileSync(path.join(ROOT, "contracts/EnclaveSecretVaultV2.sol"), "utf8"), own = fs.readFileSync(path.join(ROOT, "contracts/EnclaveHostOwnership.sol"), "utf8");
  const key = createHash("sha256").update(src).update(own).update(MOCKS).digest("hex").slice(0, 16);
  const cache = path.join(process.env.TMPDIR || "/tmp", `enclave-custody-v2-independent-rig-${key}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const out = JSON.parse(require("solc").compile(JSON.stringify({ language: "Solidity", sources: { "V.sol": { content: src }, "Rig.sol": { content: MOCKS }, "Ownership.sol": { content: own } },
    settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const pick = (f, n) => ({ abi: out.contracts[f][n].abi, bytecode: "0x" + out.contracts[f][n].evm.bytecode.object });
  const r = { ownership: pick("Ownership.sol", "EnclaveHostOwnership"), vault: pick("V.sol", "EnclaveSecretVaultV2"), book: pick("Rig.sol", "RigBook"),
              ledger: pick("Rig.sol", "RigLedger"), registry: pick("Rig.sol", "RigRegistry") };
  fs.writeFileSync(cache, JSON.stringify(r));
  return r;
}

let W;
const children = [], servers = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-combined-custody-"));
const file = (name, content, mode = 0o600) => { const p = path.join(tmp, name); fs.writeFileSync(p, content, { mode }); return p; };
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function forwarder(upstream) {
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
    const out = Buffer.from(await r.text());
    res.writeHead(200, { "content-type": "application/json", "content-length": out.length }); res.end(out);
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

before(async () => {
  if (!haveAnvil) return;
  const C = compiled();
  const port = await freePort();
  children.push(require("node:child_process").spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(CHAIN)], { stdio: "ignore" }));
  const url = `http://127.0.0.1:${port}`, chain = { ...foundry, id: CHAIN };
  const pub = createPublicClient({ chain, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const fund = async (a, eth = "100") => pub.request({ method: "anvil_setBalance", params: [a.address, "0x" + parseEther(eth).toString(16)] });
  const acct = async () => { const k = generatePrivateKey(), a = privateKeyToAccount(k); await fund(a); return Object.assign(a, { key: k }); };
  const wallet = (a) => createWalletClient({ account: a, chain, transport: viemHttp(url) });
  const send = async (a, address, abi, functionName, args) => {
    const r = await pub.waitForTransactionReceipt({ hash: await wallet(a).writeContract({ address, abi, functionName, args }) });
    if (r.status !== "success") throw new Error(`${functionName} reverted`); return r;
  };
  const deploy = async (a, c, args = []) => (await pub.waitForTransactionReceipt({ hash: await wallet(a).deployContract({ abi: c.abi, bytecode: c.bytecode, args }) })).contractAddress.toLowerCase();
  const deployer = await acct(), enclaveWallet = await acct();
  const book = await deploy(deployer, C.book), ledger = await deploy(deployer, C.ledger), registry = await deploy(deployer, C.registry);
  await send(deployer, book, C.book.abi, "set", [stringToHex("deployments", { size: 32 }), ledger]);
  await send(deployer, book, C.book.abi, "set", [stringToHex("registry", { size: 32 }), registry]);
  const ownership = await deploy(deployer, C.ownership, [registry]);
  const vault = await deploy(deployer, C.vault, [book, enclaveWallet.address, ownership]);
  const host = async (name, owner) => {
    const op = await acct(), endpoint = `https://${name}.host.test`, registryId = keccak256(toBytes(endpoint));
    await send(deployer, registry, C.registry.abi, "set", [endpoint, op.address, true, owner.address]);
    await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]);
    await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]);
    return { op, registryId };
  };
  // an INDEPENDENT committee (3 seats, t = 2) with a key the test knows: f(x) = a0 + a1 x
  const a0 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey()), a1 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey());
  const commitments = Buffer.concat([secp256k1.ProjectivePoint.BASE.multiply(a0).toRawBytes(true), secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true)]);
  const hosts = [];
  for (let i = 0; i < 3; i++) hosts.push(await host(`ind-${i}`, await acct()));
  const ms = hosts.map((h, i) => { const identity = privateKeyToAccount(generatePrivateKey());
    return { identity, m: { identity: identity.address, encKey: bytesToHex(randomBytes(32)), endpoint: `https://custody-${i}.test`, chipId: bytesToHex(randomBytes(32)),
                            registryId: h.registryId, measurement: "0x" + "6d".repeat(32) } }; });
  const codeSet = ["0x" + "6d".repeat(32)], salt = bytesToHex(randomBytes(32));
  const indCid = D.committeeIdOf({ chainId: CHAIN, vault, salt, Y: commitments.subarray(0, 33) }).toLowerCase();
  const gd = D.independentGenesisDigest({ chainId: CHAIN, vault, committeeId: indCid, commitments, machines: ms.map((x) => x.m), codeSet });
  await send(deployer, vault, VAULT_V2_ABI, "createIndependentCommittee", [salt, ms.map((x) => x.m), bytesToHex(commitments), codeSet,
    await Promise.all(ms.map((x) => D.signDigest(x.identity, gd))),
    await Promise.all(ms.map((x, i) => D.signDigest(hosts[i].op, D.hostDigest({ chainId: CHAIN, vault, machine: x.m }))))]);
  await pub.request({ method: "evm_setAutomine", params: [false] });
  await pub.request({ method: "evm_setIntervalMining", params: [1] });
  const dep = async (owner) => { const id = bytesToHex(randomBytes(32)); await send(deployer, ledger, C.ledger.abi, "set", [id, owner.address, "0x" + "00".repeat(32), deployer.address, 0n]); return id; };
  const rpcs = await Promise.all([0, 1, 2].map(() => forwarder(url)));
  const pins = file("pins.json", JSON.stringify({ version: 1, chainId: CHAIN, contracts: { registry, deployments: ledger, appCatalog: "0x" + "c1".repeat(20),
    proofOfTime: "0x" + "c2".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: vault } }));
  W = { C, pub, send, acct, deployer, ledger, vault, indCid, a0, dep, rpcs, pins };
});
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } for (const c of children) try { c.kill("SIGKILL"); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

function cli(key, args) {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "--independent", "--contract-pins", W.pins, "--usdc-token", "0x" + "c3".repeat(20), "--rpc", W.rpcs.join(","),
      "--confirmations", "1", "--max-block-age", "600", "--max-fee-gwei", "1000", ...args],
      { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ENCLAVE_KEY: key }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => p.kill("SIGKILL"), 200000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err, all: out + err }); });
  });
}
const SNP = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
              minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
const state = async (id) => {
  const [owner, policyRev, secretRev, committeeId, paused, rules] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "policyOf", args: [id] });
  const [, , data] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [id] });
  return { owner: owner.toLowerCase(), policyRev, secretRev, committeeId, paused, rules, data };
};
const opened = (id, s) => v2.decryptBundle({ S: v2.parseBundle(hexToBytes(s.data)).Rp.multiply(W.a0),
  label: v2.labelOf({ chainId: CHAIN, vault: W.vault, id, secretRev: s.secretRev, committeeId: W.indCid }), bundle: hexToBytes(s.data) }).env;
const ok = (r) => assert.equal(r.code, 0, r.all);

test("create, rotate, pause/resume through the real CLI: values never printed, rule bytes kept verbatim, every write read back", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), rules = file("snp.json", JSON.stringify(SNP));
  let r = await cli(owner.key, ["custody", "set", id, "API_KEY=s3cret-one", "--rules", rules, "--committee", W.indCid, "--no-config"]);
  ok(r); assert.match(r.out, /read back at agreed block/); assert.ok(!r.all.includes("s3cret-one"));
  const s1 = await state(id);
  assert.deepEqual(opened(id, s1), { API_KEY: "s3cret-one" });
  // rotate: the whole map is replaced, the rules are rewritten verbatim
  r = await cli(owner.key, ["custody", "set", id, "API_KEY=s3cret-two", "DB_URL=postgres://x", "--no-config"]);
  ok(r); assert.ok(!r.all.includes("s3cret-two"));
  const s2 = await state(id);
  assert.equal(s2.secretRev, s1.secretRev + 1n); assert.equal(s2.rules, s1.rules, "rule bytes kept verbatim");
  assert.deepEqual(opened(id, s2), { API_KEY: "s3cret-two", DB_URL: "postgres://x" });
  ok(await cli(owner.key, ["custody", "pause", id]));
  assert.equal((await state(id)).paused, true);
  r = await cli(owner.key, ["--json", "custody", "status", id]);
  ok(r); assert.equal(JSON.parse(r.out).paused, true);
  ok(await cli(owner.key, ["custody", "resume", id]));
  const s3 = await state(id);
  assert.deepEqual([s3.paused, s3.rules, s3.data], [false, s1.rules, s2.data], "pause/resume change only the flag");
});

test("recover after a ledger transfer: the old owner is refused, the new owner claims (old bundle destroyed) and sets", options, async () => {
  const owner = await W.acct(), next = await W.acct(), id = await W.dep(owner), rules = file("snp2.json", JSON.stringify(SNP));
  ok(await cli(owner.key, ["custody", "set", id, "OLD=secret", "--rules", rules, "--committee", W.indCid, "--no-config"]));
  await W.send(W.deployer, W.ledger, W.C.ledger.abi, "set", [id, next.address, "0x" + "00".repeat(32), W.deployer.address, 0n]);
  let r = await cli(owner.key, ["custody", "set", id, "OLD=again", "--no-config"]);
  assert.notEqual(r.code, 0); assert.match(r.all, /the ledger moved this deployment .*custody claim/);
  r = await cli(next.key, ["custody", "claim", id]);
  ok(r); assert.match(r.out, /claimed: .* paused, with no bundle/);
  const c = await state(id);
  assert.deepEqual([c.owner, c.paused, c.data], [next.address.toLowerCase(), true, "0x"]);
  ok(await cli(next.key, ["custody", "set", id, "NEW=value", "--rules", rules, "--no-config"]));
  assert.deepEqual(opened(id, await state(id)), { NEW: "value" });
});

test("migrate --from a sealed export and clear --yes: the flags custody shares with enclave's global ones reach custody", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), rules = file("snp3.json", JSON.stringify(SNP));
  const pass = file("pass.txt", "correct horse battery staple\n"), sealed = path.join(tmp, "values.enc");
  let r = await cli(owner.key, ["custody", "seal-export", "--id", id, "--in", file("values.env", "C=3\nD=4\n"), "--out", sealed, "--passphrase-file", pass]);
  ok(r); assert.ok(!fs.readFileSync(sealed, "utf8").includes("C=3"));
  r = await cli(owner.key, ["custody", "migrate", id, "--from", sealed, "--passphrase-file", pass, "--rules", rules, "--committee", W.indCid, "--no-config"]);
  ok(r); assert.match(r.all, /relay's copy .* is NOT touched/);
  const s = await state(id);
  assert.deepEqual(opened(id, s), { C: "3", D: "4" });
  r = await cli(owner.key, ["custody", "clear", id]);
  assert.notEqual(r.code, 0); assert.match(r.all, /re-run with --yes/);
  ok(await cli(owner.key, ["custody", "clear", id, "--yes"]));
  const c = await state(id);
  assert.deepEqual([c.data, c.secretRev, c.rules], ["0x", s.secretRev + 1n, s.rules]);
});
