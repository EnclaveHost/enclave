// END-TO-END: the remaining independent consumers under the local verifier, against REAL contracts on a CANONICAL-trie chain
// (the cli-independent rig on pinned reth --dev) through the patched Helios. The rig's three logged RPC fronts stand for
// providers; a consumer is given at most ONE of them as its explicit transaction/history transport.
//   * custody v2 CLI (cli/custody-independent.mjs, in-process with the CLI's real handles) on the REAL
//     EnclaveSecretVaultV2PinnedAuthorities + EnclaveHostOwnership and a real independent committee: status with no
//     transport; a write whose simulation and EXACT read-back are verified state; a lying writer caught by the read-back;
//     another wallet, pause/resume, a ledger ownership move (revocation of the old owner) and claim;
//   * MCP secrets (mcp/server.mjs as a process, a chainVerifier profile, no RPC list) on the ORIGINAL book-bound vault and a
//     book-bound production SessionVaultFactory: owner read through the committee, merge, pause, transfer guard, and an
//     admin migration of the book that the verified reads follow (never frozen);
//   * credit-vault CLI (cli/credit-vault.mjs main) on the production factory fixture: discover/status with no transport,
//     mint with the effect verified, a passkey-signed deploy submitted through the one transport with exact funds, and the
//     book's admin repointing followed;
//   * external signer (cli/independent-signer.mjs) with a JSON-RPC wallet that only signs: journal "nonce-consumed" vs
//     "confirmed" (effect verified), and lying transports (fabricated receipt, fabricated revert, a used nonce) that can never
//     end an intent - recovered by rebroadcasting the SAME bytes;
//   * tampered and missing proofs refuse every one of them, with no fallback to the transport.
// A transport receipt is never treated as proof: the tests assert the UNVERIFIED labels. TEST-SIGNED HEAD (local sequencer
// key in helios.toml), not real Base.
//   env: RIG_CHAIN_NODE=reth (+ RIG_RETH_*), HELIOS_BASE_BIN, TEST_TMP. Run inside `unshare -r -n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, createPrivateKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { toHex, keccak256, toBytes, stringToHex, bytesToHex, hexToBytes, encodeFunctionData, decodeEventLog, parseAbi, createWalletClient, http as viemHttp, parseUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { startRig, haveTools, KEYS, freePort, chain as rigChain } from './helpers/cli-independent-rig.mjs';
import { stdioClient, startCustody } from './helpers/mcp-independent-rig.mjs';
import { originalVaultRig } from './helpers/original-vault-rig.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';
import { independentChain, quorumWriter, receiptLine } from '../cli/independent.mjs';
import { cmdCustodyIndependent } from '../cli/custody-independent.mjs';
import { createExternalSigner, resolveIntent, rebroadcast, attachHash } from '../cli/independent-signer.mjs';
import * as v2 from '../custody/v2/protocol.mjs';
import * as D from '../custody/v2/digests.mjs';
import { VAULT_V2_ABI } from '../custody/v2/chain.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const GUARD = pathToFileURL(path.join(REPO, 'test/helpers/cli-network-guard.mjs')).href;
const { HELIOS_BASE_BIN } = process.env;
const skip = haveTools() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'consumer-closure-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const ZERO = '0x' + '00'.repeat(20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => String(a).toLowerCase();
let rig, helios, heliosUrl, feed, proxy, gateway;
const proxyMode = { value: 'ok' };
const T = { skip, timeout: 900000 };

// ---- the verifier rig (as test/cli-mcp-verifier.e2e.test.mjs) ---------------------------------------------------------
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function untilHelios(n, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (BigInt(await rpc(heliosUrl, 'eth_blockNumber')) >= BigInt(n)) return; } catch {} await sleep(300); }
  throw new Error(`helios did not reach block ${n}`);
}
const settled = (rc) => untilHelios(BigInt(rc.blockNumber) + 2n);
function startFeed() {
  let served = 0n, current = null, frozen = false;
  const srv = http.createServer(async (q, res) => {
    if (q.url === '/chain_id') return res.end('8453');
    try {
      const latest = BigInt(await rig.rpcCall('eth_blockNumber'));
      if (served === 0n && latest > 3n) served = latest - 3n;
      if (!frozen && served < latest) {
        const n = served + 1n;
        const b = await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false]);
        const txs = await Promise.all(b.transactions.map((h) => rig.rpcCall('eth_getRawTransactionByHash', [h])));
        current = await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs });
        served = n;
      }
    } catch {}
    res.end(JSON.stringify(current));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/`, freeze: (v) => { frozen = v; } })));
}
function startProxy() {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    if (proxyMode.value === 'down') { res.writeHead(503); return res.end(); }
    const j = await (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).json();
    if (proxyMode.value === 'tamper') for (const x of [j].flat()) if (x?.result?.storageProof) for (const s of x.result.storageProof) s.value = '0x' + 'beef'.padStart(40, '1');
    res.end(JSON.stringify(j));
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
const frontCalls = () => rig.rpcLog.length;
const STATE_METHODS = ['eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getProof'];
/** only transaction/history methods reached the fronts since `from`, and only front `i` */
function onlyTransport(from, i, what) {
  const used = rig.rpcLog.slice(from);
  assert.ok(used.every((x) => x.i === i), `${what}: only the explicit transport front was contacted`);
  assert.deepEqual(used.filter((x) => STATE_METHODS.includes(x.method)).map((x) => x.method), [], `${what}: the transport never answered a state read`);
  return used;
}
// ETH for fresh accounts, from the rig's funded deployer (reth has no anvil_setBalance); one at a time (one nonce stream)
let funding = Promise.resolve();
const fund = (address, wei = 10n ** 19n) => (funding = funding.then(async () => {
  const rc = await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.deployer).sendTransaction({ to: address, value: wei }) });
  if (rc.status !== 'success') throw new Error('funding failed');
  return rc;
}));
const walletOf = (account) => createWalletClient({ account, chain: rigChain, transport: viemHttp(rig.rpc) });
async function sendAs(account, address, abi, functionName, args) {
  const rc = await rig.pc.waitForTransactionReceipt({ hash: await walletOf(account).writeContract({ address, abi, functionName, args }) });
  if (rc.status !== 'success') throw new Error(`${functionName} reverted`); return rc;
}
async function deployAs(account, c, args = []) {
  const rc = await rig.pc.waitForTransactionReceipt({ hash: await walletOf(account).deployContract({ abi: c.abi, bytecode: c.bytecode, args }) });
  if (rc.status !== 'success') throw new Error('deploy failed'); return rc.contractAddress.toLowerCase();
}
const newAcct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await fund(a.address); return a; };

// ---- the pinned custody vault's build (test/custody-cli-independent.test.mjs's cache key), compiled in a CHILD so solc's
// peak memory is gone before reth and Helios start ------------------------------------------------------------------------
function custodyContracts() {
  const rigSrc = fs.readFileSync(path.join(REPO, 'test/helpers/independent-custody-rig.mjs'), 'utf8');
  const MOCKS = /const MOCKS = `([\s\S]*?)`;/.exec(rigSrc)[1];
  const src = fs.readFileSync(path.join(REPO, 'contracts/variants/EnclaveSecretVaultV2PinnedAuthorities.sol'), 'utf8'), own = fs.readFileSync(path.join(REPO, 'contracts/EnclaveHostOwnership.sol'), 'utf8');
  const key = createHash('sha256').update(src).update(own).update(MOCKS).digest('hex').slice(0, 16);
  const cache = path.join(process.env.TMPDIR || '/tmp', `enclave-custody-v2-independent-rig-${key}.json`);
  if (!fs.existsSync(cache)) {
    const job = `const fs = require('fs'); const solc = require(${JSON.stringify(require.resolve('solc'))}); const [repo, cache] = process.argv.slice(1);
      const rig = fs.readFileSync(repo + '/test/helpers/independent-custody-rig.mjs', 'utf8'); const MOCKS = /const MOCKS = \`([\\s\\S]*?)\`;/.exec(rig)[1];
      const src = fs.readFileSync(repo + '/contracts/variants/EnclaveSecretVaultV2PinnedAuthorities.sol', 'utf8'), own = fs.readFileSync(repo + '/contracts/EnclaveHostOwnership.sol', 'utf8');
      const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'V.sol': { content: src }, 'Rig.sol': { content: MOCKS }, 'Ownership.sol': { content: own } },
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
      const pick = (f, n) => ({ abi: out.contracts[f][n].abi, bytecode: '0x' + out.contracts[f][n].evm.bytecode.object });
      const r = { ownership: pick('Ownership.sol', 'EnclaveHostOwnership'), vault: pick('V.sol', 'EnclaveSecretVaultV2'), book: pick('Rig.sol', 'RigBook'), ledger: pick('Rig.sol', 'RigLedger'), registry: pick('Rig.sol', 'RigRegistry') };
      fs.writeFileSync(cache + '.tmp', JSON.stringify(r)); fs.renameSync(cache + '.tmp', cache);`;
    const r = spawnSync(process.execPath, ['-e', job, REPO, cache], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error(`custody vault compile failed (${r.status ?? r.signal})`);
  }
  return JSON.parse(fs.readFileSync(cache, 'utf8'));
}

test.before(async () => {
  if (skip) return;
  custodyContracts(); originalVaultRig();                          // both builds first (children), then the chain
  rig = await startRig();
  await rig.create(KEYS.owner); const last = await rig.create(KEYS.owner);
  feed = await startFeed(); proxy = await startProxy();
  gateway = createWitnessGateway({ upstreams: [proxy.url] }); const gUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  await settled(last);
});
test.after(async () => {
  try { mcpChild?.kill('SIGKILL'); } catch {}
  helios?.kill('SIGKILL');
  await gateway?.close(); feed?.srv.close(); proxy?.srv.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const verifiedChain = (tx = null) => independentChain({ chainVerifier: heliosUrl, rpcs: tx ? [tx] : [], confirmations: 1, maxBlockAgeMs: 600000 });
const file = (name, content, mode = 0o600) => { const p = path.join(TMP, name); fs.writeFileSync(p, content, { mode }); return p; };

// ============================================================================================================== custody CLI
let W;                                                              // the pinned custody world
async function custodyWorld() {
  if (W) return W;
  const C = custodyContracts(), deployer = privateKeyToAccount(KEYS.deployer), enclaveWallet = await newAcct();
  const book = await deployAs(deployer, C.book), ledger = await deployAs(deployer, C.ledger), registry = await deployAs(deployer, C.registry);
  await sendAs(deployer, book, C.book.abi, 'set', [stringToHex('deployments', { size: 32 }), ledger]);
  await sendAs(deployer, book, C.book.abi, 'set', [stringToHex('registry', { size: 32 }), registry]);
  const ownership = await deployAs(deployer, C.ownership, [registry]);
  const vault = await deployAs(deployer, C.vault, [book, enclaveWallet.address, ownership]);
  const host = async (name, owner) => {
    const op = await newAcct(), endpoint = `https://${name}.host.test`, registryId = keccak256(toBytes(endpoint));
    await sendAs(deployer, registry, C.registry.abi, 'set', [endpoint, op.address, true, owner.address]);
    await sendAs(op, ownership, C.ownership.abi, 'proposeOwner', [registryId, owner.address]);
    await sendAs(owner, ownership, C.ownership.abi, 'acceptOwner', [registryId]);
    return { op, registryId };
  };
  const machineFor = (h, i) => { const identity = privateKeyToAccount(generatePrivateKey());
    return { identity, m: { identity: identity.address, encKey: bytesToHex(randomBytes(32)), endpoint: `https://custody-${i}.test`, chipId: bytesToHex(randomBytes(32)),
                            registryId: h.registryId, measurement: '0x' + '6d'.repeat(32) } }; };
  // an INDEPENDENT committee (3 seats, t = 2) whose key the test knows: f(x) = a0 + a1 x
  const a0 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey()), a1 = secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey());
  const commitments = Buffer.concat([secp256k1.ProjectivePoint.BASE.multiply(a0).toRawBytes(true), secp256k1.ProjectivePoint.BASE.multiply(a1).toRawBytes(true)]);
  const hosts = [];
  for (let i = 0; i < 3; i++) hosts.push(await host(`ind-${i}`, await newAcct()));
  const ms = hosts.map((h, i) => machineFor(h, i)), codeSet = ['0x' + '6d'.repeat(32)], salt = bytesToHex(randomBytes(32));
  const indCid = D.committeeIdOf({ chainId: 8453, vault, salt, Y: commitments.subarray(0, 33) }).toLowerCase();
  const gd = D.independentGenesisDigest({ chainId: 8453, vault, committeeId: indCid, commitments, machines: ms.map((x) => x.m), codeSet });
  await sendAs(deployer, vault, VAULT_V2_ABI, 'createIndependentCommittee', [salt, ms.map((x) => x.m), bytesToHex(commitments), codeSet,
    await Promise.all(ms.map((x) => D.signDigest(x.identity, gd))),
    await Promise.all(ms.map((x, i) => D.signDigest(hosts[i].op, D.hostDigest({ chainId: 8453, vault, machine: x.m }))))]);
  const codeHash = keccak256(await rig.pc.getCode({ address: vault }));
  const dep = async (owner) => { const id = bytesToHex(randomBytes(32)); return { id, rc: await sendAs(deployer, ledger, C.ledger.abi, 'set', [id, owner.address, '0x' + '00'.repeat(32), deployer.address, 0n]) }; };
  W = { C, deployer, enclaveWallet, book, ledger, registry, ownership, vault, codeHash, indCid, a0, dep };
  return W;
}
function flags(rest, { bool = [], val = [] }) {
  const f = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (bool.includes(a)) f[a.slice(2)] = true; else if (val.includes(a)) f[a.slice(2)] = rest[++i]; else if (a.startsWith('--')) f[a.slice(2)] = true; else f._.push(a);
  }
  return f;
}
const kv = (pairs) => { const set = {}; for (const p of pairs) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(p); if (!m) throw new Error(`not KEY=VALUE: ${p}`); set[m[1]] = m[2]; } return set; };
/** the CLI's custody handles (cli/enclave.mjs) with a VerifiedChain: --chain-verifier, and `tx` as the ONE --rpc transport */
function custodyCli(tx = null) {
  const chain = verifiedChain(tx);
  const trust = { pins: { secretVaultV2: W.vault, deployments: W.ledger, registry: W.registry, sessionVaultFactory: ZERO },
    profile: { contracts: { secretVaultV2: { address: W.vault, codeHash: W.codeHash, immutable: { book: W.book, enclaveOwner: lc(W.enclaveWallet.address), hostOwnership: W.ownership,
      hostRegistry: W.registry, deploymentLedger: W.ledger, sessionVaultFactory: ZERO } } } },
    quorum: 1, confirmations: 1, maxBlockAgeMs: 600000, chainVerifier: heliosUrl };
  const lines = [];
  const run = async (key, args, { send, json = false } = {}) => {
    lines.length = 0; const out = { json: null };
    await cmdCustodyIndependent([...args], { flags, say: (m) => lines.push(m), jout: (o) => { out.json = o; }, json, short: (x) => x.slice(0, 10), warn: () => {},
      readFile: (p) => fs.readFileSync(p, 'utf8'), env: {}, loadKey: () => key, secretsKv: kv, chain, trust, send: send || quorumWriter(chain, { maxFeeGwei: 1000 }) });
    return { lines: [...lines], json: out.json };
  };
  return { run, chain };
}
const SNP = { v: 1, appId: 'a7'.repeat(32), images: [{ platform: 'sev-snp', measurement: '77'.repeat(48), runtimeId: 'cd'.repeat(32) }],
              minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
const vaultState = async (id) => {
  const [owner, policyRev, secretRev, committeeId, paused, rules] = await rig.pc.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: 'policyOf', args: [id] });
  const [, , data] = await rig.pc.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: 'bundleOf', args: [id] });
  return { owner: lc(owner), policyRev, secretRev, committeeId, paused, rules, data };
};
const openStored = (id, secretRev, data) => {
  const R = v2.parseBundle(hexToBytes(data)).Rp;
  return v2.decryptBundle({ S: R.multiply(W.a0), label: v2.labelOf({ chainId: 8453, vault: W.vault, id, secretRev, committeeId: W.indCid }), bundle: hexToBytes(data) });
};

test('custody CLI under the verifier: reads with no transport; a write simulated and read back EXACTLY in verified state; a lying writer, another wallet, pause and a ledger move are refused or followed', T, async () => {
  await custodyWorld();
  const owner = await newAcct(), stranger = await newAcct(), next = await newAcct();
  const { id, rc } = await W.dep(owner); await settled(rc);
  const rules = file('snp.json', JSON.stringify(SNP));
  const front = rig.rpcs[0];
  // status: the verifier only (no transport at all), custody's own reader over ONE verifier-backed client
  let f0 = frontCalls();
  const none = custodyCli();
  const st0 = await none.run(owner, ['status', id], { json: true });
  assert.equal(st0.json.policyRev, '0'); assert.equal(st0.json.codeReviewed, true); assert.match(st0.json.agreeing, /local verifier/);
  // a write without a transport: refused by name after the verified simulation; nothing contacted, nothing written
  await assert.rejects(none.run(owner, ['set', id, 'A=1', '--rules', rules, '--committee', W.indCid, '--no-config']), /explicit transaction\/history transport/);
  assert.equal((await vaultState(id)).policyRev, 0n); assert.equal(frontCalls(), f0, 'no provider front was contacted');
  // with ONE explicit transport: sent through it; the outcome is the verified EXACT read-back, not the transport's receipt
  const cli = custodyCli(front);
  f0 = frontCalls();
  const set = await cli.run(owner, ['set', id, 'A=1', 'B=two', '--rules', rules, '--committee', W.indCid, '--no-config']);
  assert.ok(set.lines.some((l) => /policy revision 1, read back exactly in verified state at block \d+/.test(l)), set.lines.join('\n'));
  const used = onlyTransport(f0, 0, 'custody set');
  assert.ok(used.some((x) => x.method === 'eth_sendRawTransaction'));
  let s = await vaultState(id);
  assert.equal(s.policyRev, 1n); assert.deepEqual(openStored(id, s.secretRev, s.data).env, { A: '1', B: 'two' });
  // a writer that sends nothing but claims a receipt: the verified read-back refuses (nothing else is sent)
  const nothing = async () => ({ status: 'success', blockNumber: await rig.pc.getBlockNumber() });
  await assert.rejects(cli.run(owner, ['pause', id], { send: nothing }), /does not show exactly this write \(policy revision 1, expected 2/);
  // another wallet: refused before signing
  let sent = 0; const counting = async () => { sent++; throw new Error('must not send'); };
  await assert.rejects(cli.run(stranger, ['pause', id], { send: counting }), /belongs to 0x[0-9a-f]{40}; this wallet is/); assert.equal(sent, 0);
  // pause and resume: verified read-back each time
  assert.ok((await cli.run(owner, ['pause', id])).lines.some((l) => /^paused: .*read back exactly in verified state/.test(l)));
  assert.equal((await vaultState(id)).paused, true);
  assert.ok((await cli.run(owner, ['resume', id])).lines.some((l) => /^resumed .*read back exactly in verified state/.test(l)));
  // the ledger moves the deployment: the old owner's authority is revoked at once, the new owner claims (old bundle destroyed)
  const mv = await sendAs(W.deployer, W.ledger, W.C.ledger.abi, 'set', [id, next.address, '0x' + '00'.repeat(32), W.deployer.address, 0n]); await settled(mv);
  assert.equal((await none.run(next, ['status', id], { json: true })).json.claimNeeded, true);
  await assert.rejects(cli.run(owner, ['set', id, 'A=again']), /the ledger moved this deployment .*custody claim/);
  await assert.rejects(cli.run(owner, ['claim', id]), /only the ledger's current owner/);
  const cl = await cli.run(next, ['claim', id]);
  assert.ok(cl.lines.some((l) => /claimed: .* paused, with no bundle/.test(l)), cl.lines.join('\n'));
  s = await vaultState(id);
  assert.deepEqual([s.owner, s.paused, s.data], [lc(next.address), true, '0x']);
});

// ============================================================================================================== MCP secrets
let M, mcpChild, mcp, mcpErr = '';
const BOOK_ART = (() => { const j = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/foundry/out/EnclaveAddressBook.sol/EnclaveAddressBook.json'), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: {} }; })();
const FACTORY_ART = (() => { const j = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/foundry/out/SessionVault.sol/SessionVaultFactory.json'), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; })();
const bookKey = (s) => stringToHex(s, { size: 32 });
/** a book-bound world on the rig's chain: an admin AddressBook naming the rig's ledger/catalog/registry, the PRODUCTION
 *  SessionVaultFactory bound to it, and the ORIGINAL book-bound custody vault with its real custodian (startCustody) */
async function mcpWorld() {
  if (M) return M;
  const dep = rig.wc(KEYS.deployer);
  const book = await rig.deploy(BOOK_ART);
  for (const [k, v] of [['deployments', rig.addresses.ledger], ['appCatalog', rig.addresses.catalog], ['registry', rig.addresses.registry]]) await rig.write(dep, book, BOOK_ART.abi, 'set', [bookKey(k), v]);
  const svlib = await rig.deploy(rig.A.svlib);
  const factory = await rig.deploy(FACTORY_ART, [rig.addresses.usdc, book, rig.addresses.router, ZERO, parseUnits('1000', 6)], { 'contracts/SessionVault.sol:SessionVaultLib': svlib });
  await rig.write(dep, book, BOOK_ART.abi, 'set', [bookKey('sessionVaultFactory'), factory]);
  // startCustody funds with anvil_setBalance: on reth the deployer transfers instead
  const r = { ...rig, rpcCall: (m, p) => (m === 'anvil_setBalance' ? fund(p[0]) : rig.rpcCall(m, p)), addresses: { ...rig.addresses, book }, A: { ...rig.A, book: BOOK_ART } };
  const dir = fs.mkdtempSync(path.join(TMP, 'custody-'));
  const custody = await startCustody(r, { dir });
  const pins = { ...rig.pins, contracts: { ...rig.pins.contracts, sessionVaultFactory: lc(factory), secretVaultV2: custody.vault } };
  const pinsFile = file('mcp-pins.json', JSON.stringify(pins));
  const cfgFile = file('mcp.json', JSON.stringify({ format: 'enclave-mcp-independent/v1', profiles: { v: { contractPins: pinsFile, usdc: rig.addresses.usdc, rpcs: [],
    stateDir: path.join(TMP, 'mcp-state'), chainVerifier: heliosUrl, confirmations: 1, maxBlockAgeSec: 600 } } }));
  const netLog = file('mcp-net.log', '');
  mcpChild = spawn(process.execPath, [path.join(REPO, 'mcp/server.mjs'), '--config', cfgFile, '--profile', 'v'], { cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: TMP, NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(rig.apiPort), API_RELAY_PORT: String(rig.apiPort),
    ENCLAVE_TEST_ROUTE: custody.route, NODE_EXTRA_CA_CERTS: custody.caFile } });
  mcpChild.stderr.on('data', (d) => { mcpErr += d; });
  mcp = stdioClient(mcpChild);
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result?.serverInfo?.title, 'Enclave (independent)', JSON.stringify(init) + mcpErr);
  mcp.notify('notifications/initialized');
  M = { book, factory, custody, netLog };
  return M;
}
function typedForWallet(td) {
  const conv = (type, v) => {
    if (/^u?int\d*$/.test(type)) return BigInt(v);
    if (type.endsWith('[]')) return v.map((x) => conv(type.slice(0, -2), x));
    if (td.types[type]) return Object.fromEntries(td.types[type].map((f) => [f.name, conv(f.type, v[f.name])]));
    return v;
  };
  return { domain: { ...td.domain, chainId: Number(td.domain.chainId) }, types: td.types, primaryType: td.primaryType, message: conv(td.primaryType, td.message) };
}

test('MCP secrets with a chainVerifier profile and NO RPC list: owner read through the committee, merge, pause, transfer guard; the book\'s admin migration is followed, never frozen', T, async () => {
  const { custody, book } = await mcpWorld();
  const owner = privateKeyToAccount(KEYS.owner);
  const created = await rig.create(KEYS.owner); const id = rig.createdId(created); await settled(created);
  const f0 = frontCalls();
  const none = await mcp.call('get_secrets', { id });
  assert.equal(none.ok, false, none.text); assert.match(none.text, /no custody v2 policy .* --owner-read on/);
  await settled(await custody.createPolicy(KEYS.owner, id, { env: { A: '1', B: 'two' } }));
  const read = async (key = KEYS.owner) => {
    const p1 = await mcp.call('get_secrets', { id });
    assert.equal(p1.ok, true, p1.text + mcpErr); assert.equal(p1.value.prepared, true); assert.equal(p1.value.owner, owner.address);
    const signature = await privateKeyToAccount(key).signTypedData(typedForWallet(p1.value.typedData));
    return mcp.call('get_secrets', { id, readToken: p1.value.readToken, signature });
  };
  let g = await read();
  assert.equal(g.ok, true, g.text); assert.deepEqual(g.value.env, { A: '1', B: 'two' }); assert.ok(g.value.answered >= 1);
  assert.equal(g.value.authority?.authority, 'local-verifier', 'the answer names the verifier authority');
  const forged = await read(KEYS.other);
  assert.equal(forged.ok, false); assert.match(forged.text, /insufficient custodians|owner/);
  // a merge: read at revision N, edit, the vault update the OWNER sends
  const p1 = await mcp.call('set_secrets', { id, payload: JSON.stringify({ set: { C: '3' } }) });
  assert.equal(p1.ok, true, p1.text);
  const e = await mcp.call('set_secrets', { id, payload: JSON.stringify({ set: { C: '3' } }), readToken: p1.value.readToken, signature: await owner.signTypedData(typedForWallet(p1.value.typedData)) });
  assert.equal(e.ok, true, e.text); assert.deepEqual(e.value.names, ['A', 'B', 'C']);
  const t = e.value.transactions[0];
  await settled(await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.owner).sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) }) }));
  assert.deepEqual((await read()).value.env, { A: '1', B: 'two', C: '3' });
  // ADMIN MIGRATION: the admin repoints the book's "deployments"; the very next verified read follows the book (the profile's
  // reviewed selection no longer matches, so it refuses) - nothing was frozen at an earlier block. Restored, it reads again.
  const dep = rig.wc(KEYS.deployer);
  await settled(await rig.write(dep, book, BOOK_ART.abi, 'set', [bookKey('deployments'), rig.addresses.registry5]));
  const moved = await mcp.call('get_secrets', { id });
  assert.equal(moved.ok, false); assert.match(moved.text, /deployments differs from the reviewed selection|bindings/);
  await settled(await rig.write(dep, book, BOOK_ART.abi, 'set', [bookKey('deployments'), rig.addresses.ledger]));
  assert.equal((await mcp.call('get_secrets', { id })).ok, true, 'the restored book reads again');
  // paused: nothing released, the owner included
  await settled(await custody.setPaused(KEYS.owner, id, true));
  const paused = await mcp.call('get_secrets', { id });
  assert.equal(paused.ok, false); assert.match(paused.text, /paused/);
  // a ledger transfer revokes the previous owner at once
  await settled(await rig.write(rig.wc(KEYS.owner), rig.addresses.ledger, rig.A.ledger.abi, 'transferDeployment', [id, privateKeyToAccount(KEYS.other).address]));
  const gone = await mcp.call('set_secrets', { id, payload: JSON.stringify({ clear: true }) });
  assert.equal(gone.ok, false); assert.match(gone.text, /custody claim/);
  assert.equal(frontCalls(), f0, 'the MCP server contacted no provider front');
  assert.equal(fs.readFileSync(M.netLog, 'utf8'), '', 'no non-loopback or Enclave connection');
});

// ============================================================================================================= credit vault
const F = await import('./credit-vault-fixture.mjs');
const CV = await import('../site/js/core/credit-vault-independent.js');
const CLI = await import('../cli/credit-vault.mjs');
let CVW;
async function creditWorld() {
  if (CVW) return CVW;
  const c = { pub: rig.pc, wallet: (k) => walletOf(F.ACCT[k]) };
  const S = await F.deployStack(c);
  const PINS = CV.validatePins({ chainId: 8453, origin: F.ORIGIN, rpId: F.RPID, usdc: S.usdc, factories: [S.older, S.current] });
  const K1 = F.passkey();
  const dir = fs.mkdtempSync(path.join(TMP, 'cv-'));
  const pinsFile = path.join(dir, 'pins.json'); fs.writeFileSync(pinsFile, JSON.stringify(PINS));
  const keyFile = path.join(dir, 'payer.key'); fs.writeFileSync(keyFile, F.KEYS.payer, { mode: 0o600 });
  CVW = { c, S, PINS, K1, dir, pinsFile, keyFile };
  return CVW;
}
async function cv(args, { tx = null } = {}) {
  let o = '';
  await CLI.main([...args, '--pins', CVW.pinsFile, '--chain-verifier', heliosUrl, '--confirmations', '1', '--max-block-age', '600', '--journal-dir', path.join(CVW.dir, 'j'), '--json',
    ...(tx ? ['--rpc', tx] : [])], { out: (s) => { o += s; }, env: {} });
  return JSON.parse(o);
}

test('credit-vault CLI under the verifier: discover/status with no transport; mint with its effect verified; a passkey-signed deploy through ONE transport, exact funds, outcome labelled; the book\'s admin repointing followed', T, async () => {
  const { c, S, PINS, K1, dir, keyFile } = await creditWorld();
  const vCur = CV.deriveVault(CLI.lib, K1.x, K1.y, S.current);
  await settled(await F.send(c, 'admin', S.usdc, F.CHAIN_FX.MockUSDC.abi, 'mint', [vCur, 100_000000n]));
  const front = rig.rpcs[1];
  let f0 = frontCalls();
  let d = await cv(['discover', '--x', K1.x, '--y', K1.y]);
  assert.equal(d.vaults[1].vault, vCur); assert.equal(d.vaults[1].deployed, false); assert.equal(d.vaults[1].balance6, '100000000');
  assert.equal(frontCalls(), f0, 'discovery read only the verifier');
  await assert.rejects(cv(['mint', '--x', K1.x, '--y', K1.y, '--key-file', keyFile]), /explicit transaction\/history transport/);
  assert.equal(frontCalls(), f0);
  f0 = frontCalls();
  const m = await cv(['mint', '--x', K1.x, '--y', K1.y, '--key-file', keyFile], { tx: front });
  assert.equal(m.vault, vCur);
  assert.equal(m.evidence.stateVerified, true); assert.equal(m.evidence.effect, 'verified'); assert.equal(m.evidence.nonceConsumed, 'verified');
  assert.match(m.evidence.receipt, /unverified/);
  onlyTransport(f0, 1, 'mint');
  d = await cv(['discover', '--x', K1.x, '--y', K1.y]);
  assert.equal(d.vaults[1].deployed, true); assert.equal(d.vaults[1].current, true); assert.equal(d.vaults[1].nonce, '0');
  const profile = CV.makeProfile({ ...d.vaults[1], key: { x: K1.x, y: K1.y } }, { credentialId: K1.credentialId, label: 'laptop' }, PINS);
  const profFile = path.join(dir, 'profile.json'); fs.writeFileSync(profFile, JSON.stringify(profile));
  f0 = frontCalls();
  const st = await cv(['status', '--profile', profFile]);
  assert.equal(st.deployed, true); assert.equal(st.balance6, '100000000'); assert.equal(lc(st.ledger), lc(S.ledger));
  assert.equal(frontCalls(), f0);
  // a passkey-signed deploy, prepared from VERIFIED state, submitted by the owner's payer through the ONE transport
  const reader = CLI.verifiedCreditReader({ verifier: heliosUrl, chainId: 8453, confirmations: 1 });
  const spec = { appRef: 'catalog://app/0', gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: '', isPublic: true, configCid: '', maxRate6: '1000' };
  const intent = { op: 'deploy', params: { spec, fundUsd: '30' } };
  const prepared = await CV.prepareVaultOp(CLI.lib, profile, 'deploy', intent.params, { reader, pins: PINS, journal: F.memJournal() });
  const req = await CV.signPrepared(CLI.lib, prepared, profile, { pins: PINS, origin: F.ORIGIN, getFn: K1.getFn(), intent });
  const reqFile = path.join(dir, 'request.json'); fs.writeFileSync(reqFile, JSON.stringify(req));
  f0 = frontCalls();
  const sub = await cv(['submit', reqFile, '--key-file', keyFile], { tx: front });
  assert.equal(sub.submit, 'broadcast'); assert.equal(sub.outcome.status, 'executed');
  assert.equal(sub.outcome.evidence.nonce, 'verified state'); assert.match(sub.outcome.evidence.execution, /UNVERIFIED/);
  onlyTransport(f0, 1, 'submit');
  const rc = await rig.pc.getTransactionReceipt({ hash: sub.txHash });
  const ev = rc.logs.filter((l) => lc(l.address) === profile.vault).map((l) => { try { return decodeEventLog({ abi: parseAbi(['event Deployed(bytes32 indexed id, uint256 funded6)']), ...l }); } catch { return null; } }).find(Boolean);
  assert.equal((await F.recordOf(c, S.ledger, ev.args.id)).balance6, 30_000000n, 'exactly the signed amount reached the record');
  assert.equal(await F.usdcOf(c, S, profile.vault), 70_000000n, 'and left the vault');
  await settled(rc);
  assert.equal(String((await cv(['status', '--profile', profFile])).nonce), '1', 'the vault nonce advanced in verified state');
  assert.equal((await cv(['reconcile', '--profile', profFile])).status, 'none');
  // ADMIN MIGRATION: the book's "vaultFactory" and "deployments" are followed at the verified block
  await settled(await F.send(c, 'admin', S.book, F.CHAIN_FX.EnclaveAddressBook.abi, 'set', [F.bookKey('vaultFactory'), S.older.address]));
  d = await cv(['discover', '--x', K1.x, '--y', K1.y]);
  assert.equal(d.vaults[1].current, false); assert.equal(lc(d.vaults[1].bookVaultFactory), lc(S.older.address), 'the minted vault reads the book\'s new current factory');
  const ledger2 = await F.deployLedger(c, [S.usdc, F.PAYOUT, S.registry, S.feed]);
  await settled(await F.send(c, 'admin', S.book, F.CHAIN_FX.EnclaveAddressBook.abi, 'set', [F.bookKey('deployments'), ledger2]));
  assert.equal(lc((await cv(['status', '--profile', profFile])).ledger), lc(ledger2), 'the vault now pays the ledger the book names');
  await F.send(c, 'admin', S.book, F.CHAIN_FX.EnclaveAddressBook.abi, 'set', [F.bookKey('deployments'), S.ledger]);
  await settled(await F.send(c, 'admin', S.book, F.CHAIN_FX.EnclaveAddressBook.abi, 'set', [F.bookKey('vaultFactory'), S.current.address]));
});

// =========================================================================================================== external signer
/** a JSON-RPC wallet that only SIGNS (eth_signTransaction) with `account`; it knows nothing about chain state */
async function signingWallet(account) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const ch of req) b += ch;
    const m = JSON.parse(b); calls.push(m.method);
    const answer = async () => {
      if (m.method === 'eth_accounts') return { result: [account.address] };
      if (m.method === 'eth_chainId') return { result: '0x2105' };
      if (m.method === 'eth_signTransaction') { const p = m.params[0];
        return { result: await account.signTransaction({ type: 'eip1559', chainId: Number(p.chainId), nonce: Number(p.nonce), to: p.to, value: BigInt(p.value), data: p.data,
          gas: BigInt(p.gas), maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) }) }; }
      return { error: { code: -32601, message: `the method ${m.method} does not exist/is not available` } };
    };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(await answer()) }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/rpc`, calls, close: () => { srv.closeAllConnections(); srv.close(); } };
}
/** a transport that lies: `mode.value` = 'ok' | 'swallow' (accepts a send without forwarding it and fabricates a mined
 *  receipt, status `mode.status`) | 'old-nonce' (reports pending nonce 0) */
async function lyingTransport(mode) {
  const fake = new Map();
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const ch of req) b += ch;
    const q = JSON.parse(b);
    const one = async (m) => {
      if (mode.value === 'swallow' && m.method === 'eth_sendRawTransaction') {
        const hash = keccak256(m.params[0]);
        const n = BigInt(await rig.rpcCall('eth_blockNumber')) - 2n, blk = await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false]);
        fake.set(hash, { transactionHash: hash, transactionIndex: '0x0', blockHash: blk.hash, blockNumber: blk.number, from: mode.from, to: mode.to, cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), status: mode.status || '0x1', type: '0x2' });
        return { jsonrpc: '2.0', id: m.id, result: hash };
      }
      if (m.method === 'eth_getTransactionReceipt' && fake.has(m.params[0])) return { jsonrpc: '2.0', id: m.id, result: fake.get(m.params[0]) };
      if (mode.value === 'old-nonce' && m.method === 'eth_getTransactionCount' && m.params[1] === 'pending') return { jsonrpc: '2.0', id: m.id, result: '0x0' };
      return (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) })).json();
    };
    const out = Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test('external signer under the verifier: "nonce-consumed" vs "confirmed" (effect verified); fabricated receipts, reverts and used nonces never end an intent; the same bytes recover it', T, async () => {
  const account = await newAcct(), SINK = '0x' + '5a'.repeat(20);
  await settled(await rig.write(rig.wc(KEYS.deployer), rig.addresses.usdc, rig.A.usdc.abi, 'mint', [account.address, 5_000000n]));
  const w = await signingWallet(account);
  const front = rig.rpcs[2], chain = verifiedChain(front);
  const signer = (o = {}) => createExternalSigner({ url: w.url, from: account.address, chainId: 8453, journalDir: fs.mkdtempSync(path.join(TMP, 'journal-')), approvalTimeoutMs: 5000, probeTimeoutMs: 3000, ...o });
  const WAIT = { timeoutMs: 180000, pollMs: 1000 };
  const nonceNow = () => rig.pc.getTransactionCount({ address: account.address });
  // 1. a plain value transfer: the verifier proves the nonce consumed, not inclusion or status -> "nonce-consumed"
  const s1 = signer(), n0 = await nonceNow(), b0 = await rig.pc.getBalance({ address: SINK });
  const r1 = await s1.sendQuorumTx(chain, { to: SINK, data: '0x', value: 3n, ...WAIT });
  assert.equal(r1.evidence.nonceConsumed, 'verified'); assert.equal(r1.evidence.effect, 'not checked'); assert.equal(r1.stateVerified, false);
  assert.match(receiptLine(r1), /receipt is UNVERIFIED/);
  const j1 = s1.journal.get(r1.intent);
  assert.equal(j1.state, 'nonce-consumed'); assert.equal(j1.evidence.stateVerified, false); assert.match(j1.evidence.receipt, /unverified/);
  assert.equal(await nonceNow(), n0 + 1); assert.equal(await rig.pc.getBalance({ address: SINK }), b0 + 3n);
  assert.deepEqual(w.calls.filter((m) => !['account_version', 'eth_accounts', 'eth_chainId', 'eth_signTransaction'].includes(m)), [], 'the wallet is never asked about chain state');
  // 2. with the intended effect checked through verified reads -> "confirmed"
  const before = await chain.read(rig.addresses.usdc, rig.A.usdc.abi, 'balanceOf', [SINK]);
  const s2 = signer();
  const r2 = await s2.sendQuorumTx(chain, { to: rig.addresses.usdc, data: encodeFunctionData({ abi: rig.A.usdc.abi, functionName: 'transfer', args: [SINK, 1n] }), ...WAIT,
    confirm: async (c) => (await c.read(rig.addresses.usdc, rig.A.usdc.abi, 'balanceOf', [SINK])) === before + 1n });
  assert.equal(r2.stateVerified, true); assert.equal(r2.evidence.effect, 'verified'); assert.equal(s2.journal.get(r2.intent).state, 'confirmed');
  // 2b. handoff: the user's own wallet sends the prepared transaction; attach returns only once verified state reached the
  // reported block and shows the nonce consumed, so the very next verified read sees the write (read-your-writes)
  const s6 = signer({ mode: 'handoff' }), usdcAt = () => chain.read(rig.addresses.usdc, rig.A.usdc.abi, 'balanceOf', [SINK]), before6 = await usdcAt();
  const h = await s6.sendQuorumTx(chain, { to: rig.addresses.usdc, data: encodeFunctionData({ abi: rig.A.usdc.abi, functionName: 'transfer', args: [SINK, 2n] }), ...WAIT }).catch((x) => x);
  assert.equal(h.code, 'handoff', String(h?.message)); const p = h.params;
  const own = await walletOf(account).sendTransaction({ to: p.to, data: p.data, value: BigInt(p.value), nonce: Number(p.nonce), gas: BigInt(p.gas),
    maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) });
  const r6 = await attachHash(chain, s6.journal, h.intent, own, WAIT);
  assert.equal(r6.evidence.nonceConsumed, 'verified'); assert.equal(s6.journal.get(h.intent).state, 'nonce-consumed');
  assert.equal(await usdcAt(), before6 + 2n, 'read-your-writes: the next verified read already shows the effect');
  // 3. a transport that swallows the send and fabricates a SUCCESS receipt: the verified nonce is unused -> unknown, never final
  const mode = { value: 'swallow', from: lc(account.address), to: SINK }, liar = await lyingTransport(mode);
  try {
    const n1 = await nonceNow();
    const s3 = signer();
    const e3 = await s3.sendQuorumTx(verifiedChain(liar.url), { to: SINK, value: 1n, timeoutMs: 90000, pollMs: 1000 }).catch((x) => x);
    assert.equal(e3.outcomeUnknown, true, String(e3?.message)); assert.match(String(e3.cause?.message || e3.message), /still unused in verified state/);
    const id3 = e3.intent, j3 = s3.journal.get(id3);
    assert.equal(j3.state, 'unknown', 'never confirmed, nonce-consumed or reverted on a transport\'s word');
    assert.equal(await nonceNow(), n1, 'nothing was mined');
    // a fabricated REVERT is gated the same way: unknown, not "reverted"
    mode.status = '0x0';
    const s4 = signer();
    const e4 = await s4.sendQuorumTx(verifiedChain(liar.url), { to: SINK, value: 1n, timeoutMs: 90000, pollMs: 1000 }).catch((x) => x);
    assert.equal(e4.outcomeUnknown, true, String(e4?.message)); assert.equal(s4.journal.get(e4.intent).state, 'unknown');
    // a transport reporting an already-used pending nonce: refused before the wallet is asked to sign
    mode.value = 'old-nonce';
    const asked = w.calls.length;
    const s5 = signer();
    await assert.rejects(s5.sendQuorumTx(verifiedChain(liar.url), { to: SINK, value: 1n, ...WAIT }), /already used in verified state.*nothing was signed/);
    assert.equal(w.calls.slice(asked).includes('eth_signTransaction'), false); assert.deepEqual(s5.journal.list(), []);
    // recovery of intent 3 through the HONEST transport: still open (verified nonce unused), then the SAME bytes rebroadcast
    const open = await resolveIntent(chain, s3.journal, id3);
    if (open.open !== true) assert.fail(JSON.stringify({ open, verified: await chain.verifiedNonce(account.address), node: await nonceNow(), n1 }, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.match(open.note, /unused/);
    const r3 = await rebroadcast(chain, s3.journal, id3, WAIT);
    assert.equal(r3.evidence.nonceConsumed, 'verified');
    assert.equal(s3.journal.get(id3).state, 'nonce-consumed'); assert.equal(s3.journal.get(id3).hash, j3.hash, 'the same signed bytes, never re-signed');
    assert.equal(await nonceNow(), n1 + 1);
  } finally { liar.close(); w.close(); }
});

// ===================================================================================================== proofs: tamper/missing
test('tampered or missing proofs refuse the custody CLI, the credit-vault CLI and MCP secrets; nothing falls back to the transport', T, async () => {
  await custodyWorld(); await creditWorld(); await mcpWorld();
  const owner = await newAcct(); const { id, rc } = await W.dep(owner); await settled(rc);
  const created = await rig.create(KEYS.owner); const mid = rig.createdId(created); await settled(created);
  for (const mode of ['tamper', 'down']) {
    proxyMode.value = mode;
    try {
      await untilHelios(BigInt(await rpc(heliosUrl, 'eth_blockNumber')) + 2n);
      const f0 = frontCalls();
      await assert.rejects(custodyCli(rig.rpcs[0]).run(owner, ['status', id], { json: true }), undefined, `${mode}: custody`);
      await assert.rejects(cv(['discover', '--x', CVW.K1.x, '--y', CVW.K1.y], { tx: rig.rpcs[1] }), undefined, `${mode}: credit vault`);
      const g = await mcp.call('get_secrets', { id: mid });
      assert.equal(g.ok, false, `${mode}: MCP`);
      assert.equal(frontCalls(), f0, `${mode}: no fallback to the transport`);
    } finally { proxyMode.value = 'ok'; }
  }
  await untilHelios(BigInt(await rig.rpcCall('eth_blockNumber')) - 2n, 300000);
  for (let i = 0; i < 60; i++) { try { await custodyCli().run(owner, ['status', id], { json: true }); break; } catch { await sleep(2000); } }
});
