// TEST SUPPORT for the REAL CLI (a subprocess) against custody v2 owner reads: the same world as owner-read-rig.mjs (the
// REAL EnclaveSecretVaultV2 and EnclaveHostOwnership on anvil, an INDEPENDENT committee whose key the test knows, REAL
// createCustodianV2 instances behind the REAL router), except that each custodian is served over HTTPS on loopback at
// the endpoint the committee names on chain (https://localhost:PORT). The CLI then reaches them with its own
// custodianPost, unmodified; its certificate is trusted through NODE_EXTRA_CA_CERTS (caFile). JSON-RPC proxies in front
// of anvil can be ok | down | delay-send (eth_sendRawTransaction held for `delayMs`, then forwarded) for a CLI process.
// Synthetic: no SEV-SNP hardware; custodians run in this test process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toBytes, stringToHex, parseEther, bytesToHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as hpke from "../../custody/hpke.mjs";
import * as D from "../../custody/v2/digests.mjs";
import { VAULT_V2_ABI, createChainReaderV2 } from "../../custody/v2/chain.mjs";
import { createCustodianV2 } from "../../custody/v2/custodian.mjs";
import { createCustodyRouter } from "../../custody/v2/http.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(import.meta.url);
export const CHAIN = 8453;
export const haveTools = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const N = secp256k1.CURVE.n;
const mod = (x) => ((x % N) + N) % N;
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

// the custody rig's compile cache (test/helpers/independent-custody-rig.mjs), identical key
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

export async function ownerReadCliWorld() {
  const C = compiled(), servers = [], children = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-read-cli-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-keyout", path.join(dir, "k.pem"),
    "-out", path.join(dir, "c.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const tlsOpts = { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) };
  const port = await freePort();
  children.push(spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(CHAIN)], { stdio: "ignore" }));
  const url = `http://127.0.0.1:${port}`, chain = { ...foundry, id: CHAIN };
  const pub = createPublicClient({ chain, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const fund = async (address) => pub.request({ method: "anvil_setBalance", params: [address, "0x" + parseEther("100").toString(16)] });
  const acct = async () => { const k = generatePrivateKey(), a = privateKeyToAccount(k); a.key = k; await fund(a.address); return a; };
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
  // three independent hosts (distinct non-Enclave owners); each machine's endpoint is a loopback HTTPS port
  const a0 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey()), a1 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey());
  const f = (k) => mod(a0 + a1 * BigInt(k));
  const commitments = Buffer.concat([secp256k1.ProjectivePoint.BASE.multiply(a0).toRawBytes(true), secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true)]);
  const codeSet = ["0x" + "6d".repeat(32)], salt = bytesToHex(randomBytes(32));
  const members = [];
  for (let i = 0; i < 3; i++) {
    const op = await acct(), owner = await acct(), hostEndpoint = `https://ind-${i}.host.test`, registryId = keccak256(toBytes(hostEndpoint));
    await send(deployer, registry, C.registry.abi, "set", [hostEndpoint, op.address, true, owner.address]);
    await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]);
    await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]);
    const identity = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair(), p = await freePort();
    members.push({ op, identity, kp, port: p, m: { identity: identity.address, encKey: bytesToHex(kp.publicKey), endpoint: `https://localhost:${p}`,
      chipId: bytesToHex(randomBytes(32)), registryId, measurement: codeSet[0] } });
  }
  const indCid = D.committeeIdOf({ chainId: CHAIN, vault, salt, Y: commitments.subarray(0, 33) }).toLowerCase();
  const gd = D.independentGenesisDigest({ chainId: CHAIN, vault, committeeId: indCid, commitments, machines: members.map((x) => x.m), codeSet });
  await send(deployer, vault, VAULT_V2_ABI, "createIndependentCommittee", [salt, members.map((x) => x.m), bytesToHex(commitments), codeSet,
    await Promise.all(members.map((x) => D.signDigest(x.identity, gd))), await Promise.all(members.map((x) => D.signDigest(x.op, D.hostDigest({ chainId: CHAIN, vault, machine: x.m }))))]);
  await pub.request({ method: "evm_setAutomine", params: [false] });
  await pub.request({ method: "evm_setIntervalMining", params: [1] });
  const codeHash = keccak256(await pub.getCode({ address: vault }));
  const dep = async (owner) => { const id = bytesToHex(randomBytes(32)); await send(deployer, ledger, C.ledger.abi, "set", [id, owner, "0x" + "00".repeat(32), deployer.address, 0n]); return id; };
  const setLedgerOwner = (id, owner) => send(deployer, ledger, C.ledger.abi, "set", [id, owner, "0x" + "00".repeat(32), deployer.address, 0n]);
  // the custodians: the REAL createCustodianV2 behind the REAL router, served over HTTPS where the chain says they are
  const custodians = [];
  for (const [i, x] of members.entries()) {
    const reader = createChainReaderV2({ clients: [pub], vault, chainId: CHAIN, minAgree: 1, maxAgeSec: 3600 });
    const k = i + 1;
    const custodian = createCustodianV2({ chainId: CHAIN, vault, encPrivateKey: x.kp.privateKey, chain: reader, verifiers: {}, now: () => Date.now(), log: () => {},
      shares: { get: (cid, epoch) => (cid === indCid && epoch === 1 ? [{ k, x: f(k) }] : null) } });
    const router = createCustodyRouter({ custodian, member: { info: (c) => ({ v: 2, committeeId: c }) }, runIndependent: async () => ({}),
      servedCommittee: () => indCid, chainId: CHAIN, vault, trustedProxies: [] });
    const c = { endpoint: x.m.endpoint, up: true, hits: 0 };
    const srv = https.createServer(tlsOpts, (req, res) => {
      c.hits++;
      if (!c.up) { req.socket.destroy(); return; }
      router(req, res);
    });
    await new Promise((ok) => srv.listen(x.port, "127.0.0.1", ok));
    servers.push(srv);
    custodians.push(c);
  }
  // JSON-RPC origins for CLI processes: ok | down | delay-send
  const rpcs = [], modes = [];
  for (let i = 0; i < 3; i++) {
    const m = { value: "ok", delayMs: 0, held: 0 };
    const srv = http.createServer(async (req, res) => {
      const chunks = []; for await (const ch of req) chunks.push(ch);
      if (m.value === "down") { res.writeHead(503); return res.end(); }
      const body = Buffer.concat(chunks).toString();
      if (m.value === "delay-send" && /eth_sendRawTransaction/.test(body)) { m.held++; await new Promise((ok) => setTimeout(ok, m.delayMs)); }
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      const out = Buffer.from(await r.text());
      res.writeHead(200, { "content-type": "application/json", "content-length": out.length }); res.end(out);
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    servers.push(srv);
    rpcs.push(`http://127.0.0.1:${srv.address().port}`); modes.push(m);
  }
  const pins = path.join(dir, "pins.json");
  fs.writeFileSync(pins, JSON.stringify({ version: 1, chainId: CHAIN, contracts: { registry, deployments: ledger, appCatalog: "0x" + "c1".repeat(20),
    proofOfTime: "0x" + "c2".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: vault } }));
  const stop = () => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } for (const ch of children) try { ch.kill("SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); };
  return { C, url, pub, send, acct, fund, deployer, ledger, registry, vault, codeHash, indCid, a0, members, custodians, dep, setLedgerOwner,
    rpcs, modes, pins, caFile: path.join(dir, "c.pem"), dir, stop };
}
