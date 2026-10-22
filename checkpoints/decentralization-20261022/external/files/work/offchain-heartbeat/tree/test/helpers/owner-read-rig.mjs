// TEST SUPPORT: custody v2 owner read against a REAL chain and REAL custodians, on loopback.
//   - anvil (chain 8453, interval-mined): the REAL EnclaveSecretVaultV2 and EnclaveHostOwnership (the independent rig's
//     cached compile), ledger and registry stand-ins, and an ERC-1271 contract owner (test/helpers/erc1271-owner.mjs);
//   - an INDEPENDENT committee: 3 hosts with distinct non-Enclave owners, genesis signed by every machine. Its key is
//     f(x) = a0 + a1 x; each machine's custodian is the REAL createCustodianV2 holding share f(i) behind the REAL router
//     (custody/v2/http.mjs);
//   - an Enclave-founded committee (one seat on an Enclave-owned host), for mixed-committee cases;
//   - three JSON-RPC proxies (ok | lie | down) for the CLI's real QuorumChain and quorum writer.
// Synthetic: custodians run in-process with no SEV-SNP hardware, and no guest is involved.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toBytes, stringToHex, parseEther, bytesToHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as hpke from "../../custody/hpke.mjs";
import * as D from "../../custody/v2/digests.mjs";
import { VAULT_V2_ABI, createChainReaderV2 } from "../../custody/v2/chain.mjs";
import { createCustodianV2 } from "../../custody/v2/custodian.mjs";
import { createCustodyRouter } from "../../custody/v2/http.mjs";
import { QuorumChain, quorumWriter } from "../../cli/independent.mjs";
import { erc1271Artifact } from "./erc1271-owner.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(import.meta.url);
export const CHAIN = 8453;
export const haveAnvil = (() => { try { require("node:child_process").execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const N = secp256k1.CURVE.n;
const mod = (x) => ((x % N) + N) % N;

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
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

export async function ownerReadWorld() {
  const C = compiled(), signer1271 = erc1271Artifact();
  const servers = [], children = [];
  const port = await freePort();
  const p = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(CHAIN)], { stdio: "ignore" });
  children.push(p);
  const url = `http://127.0.0.1:${port}`, chain = { ...foundry, id: CHAIN };
  const pub = createPublicClient({ chain, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const fund = async (a) => pub.request({ method: "anvil_setBalance", params: [a.address, "0x" + parseEther("100").toString(16)] });
  const acct = async () => { const k = generatePrivateKey(), a = privateKeyToAccount(k); a.privateKeyHex = k; await fund(a); return a; };
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
  // the independent committee, with a key the test knows and HPKE keys its custodians hold
  const a0 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey()), a1 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey());
  const f = (k) => mod(a0 + a1 * BigInt(k));
  const commitments = Buffer.concat([secp256k1.ProjectivePoint.BASE.multiply(a0).toRawBytes(true), secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true)]);
  const codeSet = ["0x" + "6d".repeat(32)], salt = bytesToHex(randomBytes(32));
  const members = [];
  for (let i = 0; i < 3; i++) {
    const h = await host(`ind-${i}`, await acct()), identity = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair();
    members.push({ h, identity, kp, m: { identity: identity.address, encKey: bytesToHex(kp.publicKey), endpoint: `https://custody-${i}.test`,
                                         chipId: bytesToHex(randomBytes(32)), registryId: h.registryId, measurement: codeSet[0] } });
  }
  const indCid = D.committeeIdOf({ chainId: CHAIN, vault, salt, Y: commitments.subarray(0, 33) }).toLowerCase();
  const gd = D.independentGenesisDigest({ chainId: CHAIN, vault, committeeId: indCid, commitments, machines: members.map((x) => x.m), codeSet });
  await send(deployer, vault, VAULT_V2_ABI, "createIndependentCommittee", [salt, members.map((x) => x.m), bytesToHex(commitments), codeSet,
    await Promise.all(members.map((x) => D.signDigest(x.identity, gd))), await Promise.all(members.map((x) => D.signDigest(x.h.op, D.hostDigest({ chainId: CHAIN, vault, machine: x.m }))))]);
  // an Enclave-founded committee (another committee, another key)
  const eh = await host("enclave-0", enclaveWallet), eId = privateKeyToAccount(generatePrivateKey()), eKp = hpke.generateKeyPair();
  const em = { identity: eId.address, encKey: bytesToHex(eKp.publicKey), endpoint: "https://custody-e.test", chipId: bytesToHex(randomBytes(32)), registryId: eh.registryId, measurement: codeSet[0] };
  const eY = secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true), eSalt = bytesToHex(randomBytes(32));
  const encCid = D.committeeIdOf({ chainId: CHAIN, vault, salt: eSalt, Y: eY }).toLowerCase();
  await send(deployer, vault, VAULT_V2_ABI, "createCommittee", [eSalt, em, bytesToHex(eY), codeSet,
    await D.signDigest(eId, D.genesisDigest({ chainId: CHAIN, vault, committeeId: encCid, Y: eY, machine: em, codeSet })), await D.signDigest(eh.op, D.hostDigest({ chainId: CHAIN, vault, machine: em }))]);
  await pub.request({ method: "evm_setAutomine", params: [false] });
  await pub.request({ method: "evm_setIntervalMining", params: [1] });
  const codeHash = keccak256(await pub.getCode({ address: vault }));
  const dep = async (owner) => { const id = bytesToHex(randomBytes(32)); await send(deployer, ledger, C.ledger.abi, "set", [id, owner.address ?? owner, "0x" + "00".repeat(32), deployer.address, 0n]); return id; };
  const setLedgerOwner = (id, owner) => send(deployer, ledger, C.ledger.abi, "set", [id, owner, "0x" + "00".repeat(32), deployer.address, 0n]);
  const contractOwner = async (signer) => deploy(deployer, signer1271, [signer.address]);

  // ---- the custodians: real createCustodianV2 behind the real router, each on its own loopback port --------------------
  const clock = { skew: 0 }, now = () => Date.now() + clock.skew;
  const custodians = [];
  for (const [i, x] of members.entries()) {
    const reader = createChainReaderV2({ clients: [pub], vault, chainId: CHAIN, minAgree: 1, maxAgeSec: 3600 });
    const k = i + 1;
    const custodian = createCustodianV2({ chainId: CHAIN, vault, encPrivateKey: x.kp.privateKey, chain: reader, verifiers: {}, now, log: () => {},
      shares: { get: (cid, epoch) => (cid === indCid && epoch === 1 ? [{ k, x: f(k) }] : null) } });
    const member = { info: (c) => ({ v: 2, committeeId: c }) };
    const srv = http.createServer(createCustodyRouter({ custodian, member, runIndependent: async () => ({}), servedCommittee: () => indCid, chainId: CHAIN, vault,
                                                        trustedProxies: ["127.0.0.1"] }));
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    servers.push(srv);
    custodians.push({ endpoint: x.m.endpoint, url: `http://127.0.0.1:${srv.address().port}`, custodian, srv, up: true });
  }
  // the transport the client gets: an on-chain https endpoint is routed to its local custodian (or refused when "down")
  const post = async (u, body) => {
    const c = custodians.find((x) => u.startsWith(x.endpoint + "/"));
    if (!c) throw new Error(`no custodian at ${u}`);
    if (!c.up) throw new Error(`${c.endpoint} is unreachable`);
    const r = await fetch(c.url + u.slice(c.endpoint.length), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.1" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(`${j.error}: ${j.message}`), { code: j.error, status: r.status });
    return j;
  };
  // ---- the CLI's real quorum machinery over proxies -----------------------------------------------------------------
  async function proxy(mode) {
    const srv = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      if (mode.value === "down") { res.writeHead(503); return res.end(); }
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { "content-type": "application/json", "content-length": out.length }); res.end(out);
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    servers.push(srv);
    return `http://127.0.0.1:${srv.address().port}`;
  }
  async function quorum(modes = ["ok", "ok", "ok"]) {
    const ms = modes.map((m) => ({ value: m }));
    const rpcs = await Promise.all(ms.map((m) => proxy(m)));
    const qc = new QuorumChain({ rpcs, quorum: 2, confirmations: 1, maxBlockAgeMs: 600000, chainId: CHAIN, timeoutMs: 10000 });
    const trust = { pins: { secretVaultV2: vault, deployments: ledger, registry, sessionVaultFactory: "0x" + "00".repeat(20) },
                    profile: { contracts: { secretVaultV2: { address: vault, codeHash, immutable: { deploymentLedger: ledger, hostRegistry: registry, enclaveOwner: enclaveWallet.address.toLowerCase() } } } },
                    quorum: 2, confirmations: 1, maxBlockAgeMs: 600000 };
    return { chain: qc, trust, send: quorumWriter(qc, { maxFeeGwei: 1000 }), modes: ms,
             reader: createChainReaderV2({ clients: qc.peers.map((x) => x.client), vault, chainId: CHAIN, minAgree: 2, confirmations: 1, maxAgeSec: 600 }) };
  }
  const stop = () => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } for (const c of children) try { c.kill("SIGKILL"); } catch {} };
  return { C, url, pub, send, acct, fund, deployer, enclaveWallet, book, ledger, registry, ownership, vault, codeHash, indCid, encCid, a0, f, commitments,
           members, custodians, post, clock, now, dep, setLedgerOwner, contractOwner, signer1271, quorum, stop };
}
