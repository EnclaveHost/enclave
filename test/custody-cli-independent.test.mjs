// Independent custody v2 CLI (cli/custody-independent.mjs) against a REAL chain: anvil with the REAL EnclaveSecretVaultV2
// and EnclaveHostOwnership (test/helpers/independent-custody-rig.mjs's compile, reused from its cache), minimal ledger and
// registry stand-ins, a REAL independent committee (three hosts with distinct non-Enclave owners, genesis signed by every
// machine) whose key the test knows, and an Enclave-founded committee. The command runs in-process with the CLI's REAL
// independent machinery: cli/independent.mjs QuorumChain over three JSON-RPC proxies (ok | lie | down), its quorum writer
// (sign once, broadcast, confirm by quorum) and custody/v2's agreed reader. Nothing reaches an Enclave API or relay.
// Synthetic: no custodian runs and no guest is released; a bundle is opened with the committee's known secret instead.
//   run: node --test --test-concurrency=1 test/custody-cli-independent.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, toBytes, stringToHex, parseEther, bytesToHex, hexToBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as v2 from "../custody/v2/protocol.mjs";
import * as D from "../custody/v2/digests.mjs";
import { VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { UPDATE_V2_ABI } from "../custody/v2/owner.mjs";
import { configSha256 } from "../custody/protocol.mjs";
import { canonicalRules } from "../custody/rules.mjs";
import { SHIELD_RULES_FORMAT, SHIELD_TIER_ACK, canonicalShieldRules } from "../custody/v2/shield-rules.mjs";
import { QuorumChain, quorumWriter } from "../cli/independent.mjs";
import { cmdCustodyIndependent, describeRules, sealExport, openExport } from "../cli/custody-independent.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const haveAnvil = (() => { try { require("node:child_process").execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const options = { skip: !haveAnvil && "needs Foundry's anvil", timeout: 240000 };
const CHAIN = 8453;

// ---- the rig's own compiled contracts (the same cache key as test/helpers/independent-custody-rig.mjs) -----------------
function compiled() {
  const rig = fs.readFileSync(path.join(ROOT, "test/helpers/independent-custody-rig.mjs"), "utf8");
  const MOCKS = /const MOCKS = `([\s\S]*?)`;/.exec(rig)[1];
  const src = fs.readFileSync(path.join(ROOT, "contracts/variants/EnclaveSecretVaultV2PinnedAuthorities.sol"), "utf8"), own = fs.readFileSync(path.join(ROOT, "contracts/EnclaveHostOwnership.sol"), "utf8");
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

// ---- the world ----------------------------------------------------------------------------------------------------------
let W;                                         // set up once: anvil, contracts, committees
const children = [], servers = [];
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
/** a JSON-RPC proxy in front of anvil: ok | lie (a changed eth_call answer) | down */
async function proxy(upstream, mode) {
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (mode.value === "down") { res.writeHead(503); return res.end(); }
    const body = Buffer.concat(chunks).toString();
    const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
    let j = await r.json();
    if (mode.value === "lie") {
      const asked = [JSON.parse(body)].flat(), answers = [j].flat();
      answers.forEach((a, i) => {
        if (asked[i]?.method === "eth_call" && typeof a.result === "string" && a.result.length >= 66) {
          const k = 2 + 60;                                                   // a byte inside the FIRST word: a changed value
          a.result = a.result.slice(0, k) + (a.result[k] === "0" ? "1" : "0") + a.result.slice(k + 1);
        }
      });
      j = Array.isArray(j) ? answers : answers[0];
    }
    const out = Buffer.from(JSON.stringify(j));
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
  const p = require("node:child_process").spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(CHAIN)], { stdio: "ignore" });
  children.push(p);
  const url = `http://127.0.0.1:${port}`, chain = { ...foundry, id: CHAIN };
  const pub = createPublicClient({ chain, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const fund = async (a, eth = "100") => pub.request({ method: "anvil_setBalance", params: [a.address, "0x" + parseEther(eth).toString(16)] });
  const acct = async (eth) => { const a = privateKeyToAccount(generatePrivateKey()); if (eth !== "0") await fund(a, eth); return a; };
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
  // a host: registry entry + accepted owner
  const host = async (name, owner) => {
    const op = await acct(), endpoint = `https://${name}.host.test`, registryId = keccak256(toBytes(endpoint));
    await send(deployer, registry, C.registry.abi, "set", [endpoint, op.address, true, owner.address]);
    await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]);
    await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]);
    return { op, registryId };
  };
  const machineFor = (h, i) => { const identity = privateKeyToAccount(generatePrivateKey());
    return { identity, m: { identity: identity.address, encKey: bytesToHex(randomBytes(32)), endpoint: `https://custody-${i}.test`, chipId: bytesToHex(randomBytes(32)),
                            registryId: h.registryId, measurement: "0x" + "6d".repeat(32) } }; };
  // an INDEPENDENT committee (3 seats, t = 2) with a key the test knows: f(x) = a0 + a1 x, Y = a0 G
  const a0 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey()), a1 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey());
  const commitments = Buffer.concat([secp256k1.ProjectivePoint.BASE.multiply(a0).toRawBytes(true), secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true)]);
  const hosts = [];
  for (let i = 0; i < 3; i++) hosts.push(await host(`ind-${i}`, await acct()));
  const ms = hosts.map((h, i) => machineFor(h, i)), codeSet = ["0x" + "6d".repeat(32)], salt = bytesToHex(randomBytes(32));
  const indCid = D.committeeIdOf({ chainId: CHAIN, vault, salt, Y: commitments.subarray(0, 33) }).toLowerCase();
  const gd = D.independentGenesisDigest({ chainId: CHAIN, vault, committeeId: indCid, commitments, machines: ms.map((x) => x.m), codeSet });
  await send(deployer, vault, VAULT_V2_ABI, "createIndependentCommittee", [salt, ms.map((x) => x.m), bytesToHex(commitments), codeSet,
    await Promise.all(ms.map((x) => D.signDigest(x.identity, gd))),
    await Promise.all(ms.map((x, i) => D.signDigest(hosts[i].op, D.hostDigest({ chainId: CHAIN, vault, machine: x.m }))))]);
  // an ENCLAVE-founded committee: one seat on a host the Enclave wallet owns
  const eh = await host("enclave-0", enclaveWallet), em = machineFor(eh, 9), eY = secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true), eSalt = bytesToHex(randomBytes(32));
  const encCid = D.committeeIdOf({ chainId: CHAIN, vault, salt: eSalt, Y: eY }).toLowerCase();
  await send(deployer, vault, VAULT_V2_ABI, "createCommittee", [eSalt, em.m, bytesToHex(eY), codeSet,
    await D.signDigest(em.identity, D.genesisDigest({ chainId: CHAIN, vault, committeeId: encCid, Y: eY, machine: em.m, codeSet })),
    await D.signDigest(eh.op, D.hostDigest({ chainId: CHAIN, vault, machine: em.m }))]);
  // keep blocks coming in real time (freshness and confirmations are real)
  await pub.request({ method: "evm_setAutomine", params: [false] });
  await pub.request({ method: "evm_setIntervalMining", params: [1] });
  const codeHash = keccak256(await pub.getCode({ address: vault }));
  const dep = async (owner) => { const id = bytesToHex(randomBytes(32)); await send(deployer, ledger, C.ledger.abi, "set", [id, owner.address, "0x" + "00".repeat(32), deployer.address, 0n]); return id; };
  W = { C, url, pub, send, acct, fund, deployer, enclaveWallet, book, ledger, registry, ownership, vault, codeHash, indCid, encCid, a0, dep };
});
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } for (const c of children) try { c.kill("SIGKILL"); } catch {} });

// ---- the CLI's handles, as cli/enclave.mjs passes them (work/custody-cli-interface.txt) --------------------------------
function flags(rest, { bool = [], val = [] }) {
  const f = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (bool.includes(a)) f[a.slice(2)] = true;
    else if (val.includes(a)) f[a.slice(2)] = rest[++i];
    else if (a.startsWith("--")) f[a.slice(2)] = true;              // unknown flags are visible to the command (refused there)
    else f._.push(a);
  }
  return f;
}
const kv = (pairs, file) => { const set = {}; const add = (l) => { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l); if (!m) throw new Error(`not KEY=VALUE: ${l}`); set[m[1]] = m[2]; };
  for (const p of pairs) add(p); if (file) for (const l of fs.readFileSync(file, "utf8").split("\n")) if (l.trim() && !l.startsWith("#")) add(l.trim()); return set; };
async function cliOver(modes, { quorum = 2, profile = undefined, pins = {} } = {}) {
  const ms = modes.map((m) => ({ value: m }));
  const rpcs = await Promise.all(ms.map((m) => proxy(W.url, m)));
  const chain = new QuorumChain({ rpcs, quorum, confirmations: 1, maxBlockAgeMs: 600000, chainId: CHAIN, timeoutMs: 10000 });
  const trust = { pins: { secretVaultV2: W.vault, deployments: W.ledger, registry: W.registry, sessionVaultFactory: "0x" + "00".repeat(20), ...pins },
                  profile: profile === undefined ? { contracts: { secretVaultV2: { address: W.vault, codeHash: W.codeHash,
                    immutable: { book: W.book, enclaveOwner: W.enclaveWallet.address.toLowerCase(), hostOwnership: W.ownership, hostRegistry: W.registry,
                                 deploymentLedger: W.ledger, sessionVaultFactory: "0x" + "00".repeat(20) } } } } : profile,
                  quorum, confirmations: 1, maxBlockAgeMs: 600000 };
  const lines = [];
  const run = async (key, args, { send, json = false } = {}) => {
    lines.length = 0;
    const out = { json: null };
    await cmdCustodyIndependent([...args], { flags, say: (m) => lines.push(m), jout: (o) => { out.json = o; }, json, short: (x) => x.slice(0, 10), warn: () => {},
      readFile: (p) => fs.readFileSync(p, "utf8"), env: {}, loadKey: () => key, secretsKv: kv, chain, trust,
      send: send || quorumWriter(chain, { maxFeeGwei: 1000 }) });
    return { lines: [...lines], json: out.json };
  };
  return { run, chain, modes: ms };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "custody-cli-ind-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const file = (name, content, mode = 0o600) => { const p = path.join(tmp, name); fs.writeFileSync(p, content, { mode }); return p; };
const SNP = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
              minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
const SHIELD = { format: SHIELD_RULES_FORMAT, acceptTier: SHIELD_TIER_ACK, appId: "a8".repeat(32), images: [{ measurement: "6a".repeat(32), runtimeId: "cd".repeat(32) }], platforms: "attested" };
const vaultState = async (id) => {
  const [owner, policyRev, secretRev, committeeId, paused, rules] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "policyOf", args: [id] });
  const [, , data] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [id] });
  return { owner: owner.toLowerCase(), policyRev, secretRev, committeeId, paused, rules, data };
};
/** open the stored bundle with the committee's known secret: S = a0 · R */
const openStored = (id, secretRev, data) => {
  const R = v2.parseBundle(hexToBytes(data)).Rp;
  return v2.decryptBundle({ S: R.multiply(W.a0), label: v2.labelOf({ chainId: CHAIN, vault: W.vault, id, secretRev, committeeId: W.indCid }), bundle: hexToBytes(data) });
};

// ---- the tests ----------------------------------------------------------------------------------------------------------
test("set: SNP rules and the whole set to an INDEPENDENT committee, read back exactly; the bundle opens only to these values and this config", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), cli = await cliOver(["ok", "ok", "ok"]);
  const before = await cli.run(owner, ["status", id], { json: true });
  assert.equal(before.json.policyRev, "0"); assert.equal(before.json.note, "no custody v2 policy for this deployment in this vault"); assert.equal(before.json.codeReviewed, true);
  const cfg = file("cfg.json", JSON.stringify({ api: "https://api.example" }));
  const r = await cli.run(owner, ["set", id, "API_KEY=s3cret", "DB_URL=postgres://x", "--rules", file("snp.json", JSON.stringify(SNP)), "--committee", W.indCid, "--config-file", cfg]);
  assert.ok(r.lines.some((l) => /no Enclave seat/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /read back at agreed block/.test(l)));
  assert.ok(!r.lines.join("\n").includes("s3cret"), "no value is ever printed");
  const s = await vaultState(id);
  assert.deepEqual([s.owner, s.policyRev, s.secretRev, s.committeeId.toLowerCase(), s.paused], [owner.address.toLowerCase(), 1n, 1n, W.indCid, false]);
  assert.equal(s.rules, bytesToHex(canonicalRules(SNP)));
  const opened = openStored(id, 1n, s.data);
  assert.deepEqual(opened.env, { API_KEY: "s3cret", DB_URL: "postgres://x" });
  assert.equal(opened.configSha256, configSha256(JSON.stringify({ api: "https://api.example" })));
  const st = await cli.run(owner, ["status", id], { json: true });
  assert.equal(st.json.tier, "sev-snp (custody rules v1)"); assert.equal(st.json.claimNeeded, false); assert.equal(st.json.threshold, "2 of 3 shares");
  assert.equal(st.json.custodians.some((c) => /Enclave seat/.test(c)), false);
  // a second set needs no --rules or --committee: the policy's own (rules bytes verbatim), and replaces the whole set
  await cli.run(owner, ["set", id, "ONLY=one", "--no-config"]);
  const s2 = await vaultState(id);
  assert.equal(s2.rules, s.rules, "rules re-written byte for byte"); assert.equal(s2.secretRev, 2n);
  assert.deepEqual(openStored(id, 2n, s2.data).env, { ONLY: "one" }, "the WHOLE set is replaced");
});

test("a separate gas payer: the owner (no ETH at all) signs the vault's EIP-712 update; the payer only pays", options, async () => {
  const ownerKey = generatePrivateKey(), owner = privateKeyToAccount(ownerKey), payerKey = generatePrivateKey(), payer = privateKeyToAccount(payerKey);
  await W.fund(payer);
  const id = await W.dep(owner), cli = await cliOver(["ok", "ok", "ok"]);
  assert.equal(await W.pub.getBalance({ address: owner.address }), 0n);
  const r = await cli.run(owner, ["set", id, "K=v", "--rules", file("snp2.json", JSON.stringify(SNP)), "--committee", W.indCid, "--no-config", "--payer-key", file("payer.key", payerKey)]);
  assert.ok(r.lines.some((l) => l.includes(`gas paid by ${payer.address}`)), r.lines.join("\n"));
  const s = await vaultState(id);
  assert.equal(s.owner, owner.address.toLowerCase(), "the policy is the OWNER's, not the payer's");
  assert.equal(await W.pub.getBalance({ address: owner.address }), 0n, "the owner paid nothing");
  // the pause path by signature too; a payer key file that is not private is refused
  await cli.run(owner, ["pause", id, "--payer-key", file("payer2.key", payerKey)]);
  assert.equal((await vaultState(id)).paused, true);
  await assert.rejects(cli.run(owner, ["resume", id, "--payer-key", file("payer3.key", payerKey, 0o644)]), /must be private/);
  await assert.rejects(cli.run(owner, ["resume", id, "--payer-key", file("owner-as-payer.key", ownerKey)]), /the owner's own key/);
});

test("Enclave Shield rules: the T0-hv tier is stated, never relabelled; pause and resume re-write the exact rule bytes", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), cli = await cliOver(["ok", "ok", "ok"]);
  await cli.run(owner, ["set", id, "TOKEN=t", "--rules", file("shield.json", JSON.stringify(SHIELD)), "--committee", W.indCid, "--no-config"]);
  const s = await vaultState(id);
  assert.equal(s.rules, bytesToHex(canonicalShieldRules(SHIELD)));
  assert.equal(describeRules(s.rules).kind, "shield");
  const st = await cli.run(owner, ["status", id], { json: true });
  assert.equal(st.json.tier, `${SHIELD_TIER_ACK} (Enclave Shield rules)`);
  await cli.run(owner, ["pause", id]);
  const p = await vaultState(id);
  assert.deepEqual([p.paused, p.rules, p.data, p.secretRev], [true, s.rules, s.data, s.secretRev], "pause changes only the pause flag");
  await cli.run(owner, ["resume", id]);
  const q = await vaultState(id);
  assert.deepEqual([q.paused, q.rules, q.data], [false, s.rules, s.data]);
  // an SNP rules file stays SNP: the two formats never stand in for each other
  await assert.rejects(cli.run(owner, ["set", id, "X=y", "--rules", file("bad-shield.json", JSON.stringify({ ...SHIELD, acceptTier: "hv-node" }))]), /acceptTier/);
});

test("refused before anything is signed: no rules, no committee, unknown or Enclave-seated committee, another owner, relay flags", options, async () => {
  const owner = await W.acct(), stranger = await W.acct(), id = await W.dep(owner), cli = await cliOver(["ok", "ok", "ok"]);
  let sent = 0;
  const counting = (inner) => async (...a) => { sent++; return inner(...a); };
  const send = counting(quorumWriter(cli.chain, { maxFeeGwei: 1000 }));
  const rules = file("snp3.json", JSON.stringify(SNP));
  await assert.rejects(cli.run(owner, ["set", id, "K=v", "--committee", W.indCid], { send }), /no rules yet/);
  await assert.rejects(cli.run(owner, ["set", id, "K=v", "--rules", rules], { send }), /no committee: pass --committee 0x… \(independent custody has no platform default\)/);
  await assert.rejects(cli.run(owner, ["set", id, "K=v", "--rules", rules, "--committee", "0x" + "ab".repeat(32)], { send }), /no committee 0xabab/);
  await assert.rejects(cli.run(owner, ["set", id, "K=v", "--rules", rules, "--committee", W.encCid, "--no-config"], { send }), /Enclave-operated seat .* --allow-enclave-seat/);
  await assert.rejects(cli.run(stranger, ["set", id, "K=v", "--rules", rules, "--committee", W.indCid], { send }), /this deployment's owner is 0x[0-9a-f]{40}; this wallet is/);
  await assert.rejects(cli.run(owner, ["set", id, "K=v", "--rules-from-relay", "--admit"], { send }), /not part of independent custody/);
  await assert.rejects(cli.run(owner, ["set", id.slice(0, 20), "K=v"], { send }), /full bytes32 deployment id/);
  assert.equal(sent, 0, "nothing was signed or sent for any refusal");
  // the explicit opt-in admits the Enclave-seated committee, and says so
  const r = await cli.run(owner, ["set", id, "K=v", "--rules", rules, "--committee", W.encCid, "--no-config", "--allow-enclave-seat"]);
  assert.ok(r.lines.some((l) => /WITH an Enclave seat/.test(l)));
  // a policy owner's write by another wallet: refused before signing
  await assert.rejects(cli.run(stranger, ["pause", id], { send }), /belongs to 0x[0-9a-f]{40}; this wallet is/);
  assert.equal(sent, 0);
});

test("stale state: another update lands between the read and the send: the vault's revision guard refuses it, nothing is written", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), cli = await cliOver(["ok", "ok", "ok"]);
  await cli.run(owner, ["set", id, "A=1", "--rules", file("snp4.json", JSON.stringify(SNP)), "--committee", W.indCid, "--no-config"]);
  const before = await vaultState(id);
  const inner = quorumWriter(cli.chain, { maxFeeGwei: 1000 });
  // between the CLI's agreed read and its send, the owner's other session pauses the policy (revision + 1)
  const raced = async (acct, call) => { await W.send(owner, W.vault, UPDATE_V2_ABI, "update", [id, { expectPolicyRev: before.policyRev, setPolicy: true, committeeId: W.indCid, paused: true,
    rules: before.rules, setBundle: false, bundle: "0x", clear: false }]); return inner(acct, call); };
  await assert.rejects(cli.run(owner, ["set", id, "B=2", "--no-config"], { send: raced }), /would revert/);
  const after = await vaultState(id);
  assert.deepEqual([after.policyRev, after.secretRev, after.data, after.paused], [before.policyRev + 1n, before.secretRev, before.data, true], "only the racing pause landed");
});

test("the vault itself: a wrong code hash, a wrong immutable binding, or a pin outside the profile is refused before any read of the deployment", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner);
  const good = { contracts: { secretVaultV2: { address: W.vault, codeHash: W.codeHash, immutable: { deploymentLedger: W.ledger } } } };
  let cli = await cliOver(["ok", "ok", "ok"], { profile: { contracts: { secretVaultV2: { ...good.contracts.secretVaultV2, codeHash: "0x" + "11".repeat(32) } } } });
  await assert.rejects(cli.run(owner, ["status", id]), /does not carry the reviewed code/);
  cli = await cliOver(["ok", "ok", "ok"], { profile: { contracts: { secretVaultV2: { ...good.contracts.secretVaultV2, immutable: { deploymentLedger: W.registry } } } } });
  await assert.rejects(cli.run(owner, ["status", id]), /deploymentLedger is .*not the reviewed/);
  cli = await cliOver(["ok", "ok", "ok"], { profile: null, pins: { deployments: W.registry } });
  await assert.rejects(cli.run(owner, ["status", id]), /deploymentLedger is .*not the reviewed/);
  cli = await cliOver(["ok", "ok", "ok"], { profile: null });
  assert.equal((await cli.run(owner, ["status", id], { json: true })).json.codeReviewed, false, "pins-only: bindings checked, code not reviewed (stated)");
  cli = await cliOver(["ok", "ok", "ok"], { profile: null, pins: { secretVaultV2: "0x" + "00".repeat(20) } });
  await assert.rejects(cli.run(owner, ["status", id]), /needs a pinned EnclaveSecretVaultV2/);
});

test("ownership moves on the ledger: neither old nor new owner may write until the new owner claims (the old bundle is destroyed)", options, async () => {
  const owner = await W.acct(), next = await W.acct(), id = await W.dep(owner), cli = await cliOver(["ok", "ok", "ok"]);
  const rules = file("snp5.json", JSON.stringify(SNP));
  await cli.run(owner, ["set", id, "OLD=secret", "--rules", rules, "--committee", W.indCid, "--no-config"]);
  await W.send(W.deployer, W.ledger, W.C.ledger.abi, "set", [id, next.address, "0x" + "00".repeat(32), W.deployer.address, 0n]);
  assert.equal((await cli.run(next, ["status", id], { json: true })).json.claimNeeded, true);
  await assert.rejects(cli.run(owner, ["set", id, "OLD=again"]), /the ledger moved this deployment .*custody claim/);
  await assert.rejects(cli.run(next, ["set", id, "NEW=v"]), /the ledger moved this deployment/);
  await assert.rejects(cli.run(owner, ["claim", id]), /only the ledger's current owner/);
  const r = await cli.run(next, ["claim", id]);
  assert.ok(r.lines.some((l) => /claimed: .* paused, with no bundle/.test(l)), r.lines.join("\n"));
  const s = await vaultState(id);
  assert.deepEqual([s.owner, s.paused, s.data], [next.address.toLowerCase(), true, "0x"]);
  await cli.run(next, ["set", id, "NEW=v", "--rules", rules, "--no-config"]);
  assert.deepEqual(openStored(id, s.secretRev + 1n, (await vaultState(id)).data).env, { NEW: "v" });
});

test("migrate from the owner's own export, plaintext or sealed (bound to this deployment); clear --yes destroys the bundle", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), other = bytesToHex(randomBytes(32)), cli = await cliOver(["ok", "ok", "ok"]);
  const rules = file("snp6.json", JSON.stringify(SNP)), pass = file("pass.txt", "correct horse battery staple\n");
  // the hosted CLI's `secrets ls --show --json` shape, saved by the owner
  const plain = file("relay.json", JSON.stringify({ names: ["A", "B"], env: { A: "1", B: "2" }, rev: 7 }));
  await cli.run(owner, ["migrate", id, "--from", plain, "--rules", rules, "--committee", W.indCid, "--no-config"]);
  assert.deepEqual(openStored(id, 1n, (await vaultState(id)).data).env, { A: "1", B: "2" });
  // sealed locally (no network), then migrated
  const sealed = path.join(tmp, "values.enc");
  await cli.run(owner, ["seal-export", "--id", id, "--in", file("values.env", "C=3\nD=4\n"), "--out", sealed, "--passphrase-file", pass]);
  assert.equal(fs.statSync(sealed).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(sealed, "utf8").includes("C=3"));
  await assert.rejects(cli.run(owner, ["migrate", id, "--from", sealed, "--no-config"]), /needs --passphrase-file/);
  await assert.rejects(cli.run(owner, ["migrate", id, "--from", sealed, "--no-config", "--passphrase-file", file("wrong.txt", "not the passphrase at all\n")]), /does not open/);
  await assert.rejects(Promise.resolve().then(() => openExport(fs.readFileSync(sealed, "utf8"), { id: other, passphrase: "correct horse battery staple" })), /sealed for/);
  await cli.run(owner, ["migrate", id, "--from", sealed, "--no-config", "--passphrase-file", pass]);
  assert.deepEqual(openStored(id, 2n, (await vaultState(id)).data).env, { C: "3", D: "4" });
  assert.throws(() => sealExport({ id: "0x12", env: {}, passphrase: "x".repeat(12) }), /bytes32/);
  // clear: explicit, and the bundle is gone (secrets revision moves on, the rules stay)
  await assert.rejects(cli.run(owner, ["clear", id]), /re-run with --yes/);
  const before = await vaultState(id);
  await cli.run(owner, ["clear", id, "--yes"]);
  const s = await vaultState(id);
  assert.deepEqual([s.data, s.secretRev, s.rules], ["0x", before.secretRev + 1n, before.rules]);
});

test("a lying RPC is outvoted with three; with two it can only veto (a refusal), never decide a value", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner);
  let cli = await cliOver(["ok", "lie", "ok"]);
  await cli.run(owner, ["set", id, "K=v", "--rules", file("snp7.json", JSON.stringify(SNP)), "--committee", W.indCid, "--no-config"]);
  assert.deepEqual(openStored(id, 1n, (await vaultState(id)).data).env, { K: "v" }, "the committee key used is the agreed one");
  const st = await cli.run(owner, ["status", id], { json: true });
  assert.equal(st.json.owner, owner.address.toLowerCase());
  cli = await cliOver(["ok", "lie"]);
  await assert.rejects(cli.run(owner, ["status", id]), /disagree|agree|quorum/i);
  cli = await cliOver(["ok", "down"]);
  await assert.rejects(cli.run(owner, ["set", id, "K=w"]), /quorum|answered|RPCs/i);
  assert.equal((await vaultState(id)).secretRev, 1n, "nothing was written without a quorum");
});

test("the independent path has no Enclave or relay route, and no platform committee default", () => {
  const src = fs.readFileSync(path.join(ROOT, "cli/custody-independent.mjs"), "utf8");
  for (const bad of [/\bh\.api\b/, /relayRead/, /relayClear/, /\bfetch\(/, /pubEach/, /PLATFORM_COMMITTEE/, /expected-guest/, /api\.enclave/])
    assert.doesNotMatch(src, bad, String(bad));
});

test("the readback is exact: a writer that reports a receipt but wrote nothing (or something else) is caught, never reported as done", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), cli = await cliOver(["ok", "ok", "ok"]);
  const rules = file("snp8.json", JSON.stringify(SNP));
  // a receipt for the current block, with nothing written
  const nothing = async () => ({ status: "success", blockNumber: await W.pub.getBlockNumber() });
  await assert.rejects(cli.run(owner, ["set", id, "K=v", "--rules", rules, "--committee", W.indCid, "--no-config"], { send: nothing }),
    /does not show exactly this write \(policy revision 0, expected 1/);
  // a write of OTHER values than the command built (another bundle under the same revision): caught by the bundle bytes
  const inner = quorumWriter(cli.chain, { maxFeeGwei: 1000 });
  const swapped = async (acct, call) => {
    const u = call.args[1];
    const other = { ...u, bundle: bytesToHex(v2.encryptBundle({ Y: hexToBytes((await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "committeeOf", args: [W.indCid] }))[0]),
      label: v2.labelOf({ chainId: CHAIN, vault: W.vault, id, secretRev: 1n, committeeId: W.indCid }), env: { K: "attacker" }, configSha256: configSha256("") })) };
    return inner(acct, { ...call, args: [id, other] });
  };
  await assert.rejects(cli.run(owner, ["set", id, "K=v", "--rules", rules, "--committee", W.indCid, "--no-config"], { send: swapped }), /does not show exactly this write \(bundle/);
});

// ---- the real entry point, once work/custody-cli-interface.txt is applied (CUSTODY_GLUE_CLI=cli/enclave.mjs) ------------
// A subprocess of cli/enclave.mjs with --independent, explicit --contract-pins and --rpc, an isolated HOME/XDG config dir
// (no real key or config is ever read), the owner key in ENCLAVE_KEY.
const GLUE = process.env.CUSTODY_GLUE_CLI ? path.resolve(process.env.CUSTODY_GLUE_CLI) : null;
test("the CLI entry point: --independent custody status / set through cli/enclave.mjs; secrets is routed to the owner read, refused without the ownerRead opt-in", { ...options,
  skip: options.skip || (!GLUE && "set CUSTODY_GLUE_CLI to a cli/enclave.mjs with the custody glue applied") }, async () => {
  const { spawn } = await import("node:child_process");
  const ownerKey = generatePrivateKey(), owner = privateKeyToAccount(ownerKey);
  await W.fund(owner);
  const id = await W.dep(owner), home = fs.mkdtempSync(path.join(tmp, "home-"));
  const pins = file("pins.json", JSON.stringify({ version: 1, chainId: CHAIN, contracts: { registry: W.registry, deployments: W.ledger, appCatalog: "0x" + "c1".repeat(20),
    proofOfTime: "0x" + "c2".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: W.vault } }));
  const rpcs = await Promise.all([0, 1, 2].map(() => proxy(W.url, { value: "ok" })));
  const cli = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [GLUE, "--independent", "--contract-pins", pins, "--usdc-token", "0x" + "c3".repeat(20), "--rpc", rpcs.join(","),
      "--confirmations", "1", "--max-block-age", "600", "--max-fee-gwei", "1000", ...args],
      { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ENCLAVE_KEY: ownerKey }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => p.kill("SIGKILL"), 150000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
  let r = await cli(["--json", "custody", "status", id]);
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).policyRev, "0"); assert.equal(JSON.parse(r.out).codeReviewed, false);
  r = await cli(["custody", "set", id, "API_KEY=s3cret", "--rules", file("snp-glue.json", JSON.stringify(SNP)), "--committee", W.indCid, "--no-config"]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /read back at agreed block/); assert.ok(!(r.out + r.err).includes("s3cret"));
  assert.deepEqual(openStored(id, 1n, (await vaultState(id)).data).env, { API_KEY: "s3cret" });
  // the glue (work/owner-secrets-logs/glue/glue.patch) routes secrets to cmdSecretsIndependent: this policy did not opt in
  r = await cli(["secrets", "ls", id]);
  assert.notEqual(r.code, 0); assert.match(r.err + r.out, /do not allow an owner read/); assert.ok(!(r.out + r.err).includes("s3cret"));
  r = await cli(["--json", "custody", "status", id]);
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).ownerRead, false);
  // a real deployment of this owner with NO custody v2 policy: the exact missing-policy refusal, before any custodian request
  const bare = await W.dep(owner);
  r = await cli(["secrets", "ls", bare]);
  assert.notEqual(r.code, 0); assert.match(r.err + r.out, /no custody v2 policy for \S+: create one with `custody set \S+ … --rules … --committee … --owner-read on`/);
  assert.ok(!(r.out + r.err).includes("s3cret"));
});
