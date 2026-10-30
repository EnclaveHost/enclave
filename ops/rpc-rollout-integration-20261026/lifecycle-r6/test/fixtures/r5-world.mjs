// r5 shared test world (r4 world with ACTUAL-ABI doubles; optional SessionVault-owned deployment): the REAL candidate ledger (deploy/lifecycle/artifacts/EnclaveDeployments.json), controller and identity on a
// loopback anvil (chain-id 8453, prague), wired to the LifecycleR4Doubles.sol surfaces. TEST DOUBLES (labelled): `testAuthority`
// (labels ONE uncached anvil block as the authority's block), `anvilReceipts` (the untrusted location/header/block source) and the
// host-policy document store. Nothing here is evidence; the adapter checks everything it is given.
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import solc from 'solc';
import { createPublicClient, createWalletClient, decodeFunctionResult, encodeDeployData, encodeEventTopics, encodeFunctionData, getAddress, http, keccak256,
  parseEther, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createLifecycleChainAdapter } from '../../network/deployment-chain-adapter.mjs';
import { DeploymentLifecycleRunner } from '../../network/deployment-lifecycle-runner.mjs';
import { openLifecycleJournal } from '../../network/deployment-lifecycle-journal.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const ART = n => JSON.parse(fs.readFileSync(path.join(ROOT, `deploy/lifecycle/artifacts/${n}.json`), 'utf8'));
export const LIFECYCLE = ART('EnclaveDeploymentLifecycle'), IDENTITY = ART('EnclaveSelfHostingIdentity'), LEDGER = ART('EnclaveDeployments');
export const HOST = keccak256(toBytes('host-a')), MEAS = keccak256(toBytes('measurement-1')), ZERO = `0x${'0'.repeat(40)}`, ZERO32 = `0x${'0'.repeat(64)}`;
export const MAX_T = 10n ** 15n, RESERVE = 10n ** 15n, MAX_GAS = 100n * 10n ** 9n, CAP6 = 100n, PAID6 = 10n;
export const S = { pub: null, wallet: null, K: null, skewMs: 0 };
let anvil, idn = 0;
export const rpc = (m, p = []) => S.pub.request({ method: m, params: p });
export const hex = n => `0x${BigInt(n).toString(16)}`;
export const mine = () => rpc('evm_mine');
export const chainNow = () => Date.now() + S.skewMs;
export async function warp(sec) { S.skewMs += sec * 1000; await rpc('evm_increaseTime', [sec]); await mine(); }
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

export function useAnvil() {
  test.before(async () => {
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    anvil = spawn(process.env.ANVIL || path.join(os.homedir(), '.foundry/bin/anvil'),
      ['--port', String(port), '--host', '127.0.0.1', '--chain-id', '8453', '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
    // r6: LOCAL-ANVIL harness only: a receipt missed by viem's single immediate check (anvil seals asynchronously) waits 25 ms, not the
    // 4000 ms default poll (root 1386 latency diagnosis). No assertion, authority, freshness or timeout changes.
    S.pub = createPublicClient({ cacheTime: 0, pollingInterval: 25, transport: http(url, { retryCount: 0 }) }); S.wallet = createWalletClient({ transport: http(url, { retryCount: 0 }) });
    for (let i = 0; ; ++i) { try { if (await S.pub.getChainId() === 8453) break; } catch { if (i > 100) throw Error('anvil did not start'); } await new Promise(r => setTimeout(r, 100)); }
    const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
      sources: { 'D.sol': { content: fs.readFileSync(new URL('./LifecycleR5Doubles.sol', import.meta.url), 'utf8') } },
      settings: { evmVersion: 'prague', outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } } })));
    if (out.errors?.some(e => e.severity === 'error')) throw Error(JSON.stringify(out.errors));
    S.K = out.contracts['D.sol'];
  });
  test.after(() => anvil?.kill('SIGKILL'));
}

export async function account() { const a = privateKeyToAccount(generatePrivateKey()); await rpc('anvil_setBalance', [a.address, '0x8ac7230489e80000']); return a; }
export async function send(from, args) { const hash = await S.wallet.sendTransaction({ account: from, chain: null, gas: 5_000_000n, ...args });
  const r = await S.pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw Error('tx reverted'); return r; }
const deployRaw = async (from, abi, bytecode, args = [], gas = 5_000_000n) => (await send(from, { gas, data: encodeDeployData({ abi, bytecode, args }) })).contractAddress;
export const dep = (from, name, args = []) => deployRaw(from, S.K[name].abi, `0x${S.K[name].evm.bytecode.object}`, args);
export const tx = (from, to, abi, functionName, args = [], value) => send(from, { to, data: encodeFunctionData({ abi, functionName, args }), ...(value ? { value } : {}) });
export const codeHash = async a => keccak256(await S.pub.getCode({ address: a }));
export const read = (address, abi, functionName, args = []) => S.pub.readContract({ address, abi, functionName, args });

// TEST DOUBLE of the untrusted history source (r3): WHERE (TransitionPaid log query) + raw headers, raw signed transactions, receipts.
export function anvilReceipts(hooks) {
  const base = {
    locate: async ({ id, digest, controller }) => {
      const logs = await rpc('eth_getLogs', [{ address: controller, fromBlock: '0x0', toBlock: 'latest',
        topics: encodeEventTopics({ abi: LIFECYCLE.abi, eventName: 'TransitionPaid', args: { id, intent: digest } }) }]);
      const l = logs.at(-1); return l ? { blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash } : null; },
    header: async n => rpc('eth_getBlockByNumber', [hex(n), false]),
    block: async n => { const b = await rpc('eth_getBlockByNumber', [hex(n), true]);
      return { header: b, transactions: await Promise.all(b.transactions.map(t => rpc('eth_getRawTransactionByHash', [t.hash]))),
        receipts: await rpc('eth_getBlockReceipts', [hex(n)]) }; },
  };
  return { base,
    locate: q => (hooks.locate ?? base.locate)(q),
    header: async n => (hooks.header ?? (x => x))(structuredClone(await base.header(n)), n),
    block: async n => (hooks.block ?? (x => x))(structuredClone(await base.block(n)), n) };
}
// TEST DOUBLE of createLifecycleFinalitySnapshot's capability: ONE uncached block object (auth.pin or latest), labelled.
export function testAuthority(auth, kind) {
  return { kind, snapshot: async readFn => {
    const header = auth.pin != null ? await S.pub.getBlock({ blockNumber: auth.pin }) : await S.pub.getBlock({ blockTag: 'latest' });
    return { blockNumber: header.number, blockHash: header.hash, timestamp: Number(header.timestamp) * 1000, observedAt: Date.now(),
      value: await readFn(S.pub, header.number, header), evidence: { tier: auth.tier, proofVerified: auth.proof } }; } };
}

// opts: payout 'owner' (self-hosted, rate 0) | 'vault' (owner's SessionVault: sameOwner, rate 0) | 'other' (paid at PAID6/s);
//       isPublic, approval, appVersion (string, e.g. '0' or '007'), fund6 (USDC funded right after create, while d.rate is the cap),
//       ownedBy 'eoa' (the human creates) | 'vault' (the human's SessionVault creates: ledger owner = vault, owner authority = human)
export async function world(opts = {}) {
  const o = { payout: 'owner', isPublic: false, approval: 1, appVersion: '0', fund6: 0n, ownedBy: 'eoa', staleDep: null, deposit: true, ...opts }, K = S.K;
  // staleDep: one primary dependency deliberately bound to the LEGACY ledger (the pins still say THIS ledger) -> must refuse at runtime
  const [admin, human, operator, relay, other, ...ws] = await Promise.all([account(), account(), account(), account(), account(), account(), account(), account()]);
  const witnesses = ws.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const ext = { keyAttestations: (await account()).address, router: (await account()).address, enclaveOwner: (await account()).address };
  const usdc = await dep(admin, 'TestUSDC'), registry = await dep(admin, 'TestRegistry'), catalog = await dep(admin, 'TestCatalog');
  const addressBook = await dep(admin, 'TestAddressBook', [admin.address]), l1Oracle = await dep(admin, 'TestL1Oracle');
  const hostOwnership = await dep(admin, 'TestHostOwnership'), legacyLedger = await dep(admin, 'LegacyLedgerStandIn');
  const ledger = await deployRaw(admin, LEDGER.abi, LEDGER.bytecode, [usdc, admin.address, registry, ZERO], 25_000_000n);
  const lifecycle = await deployRaw(admin, LIFECYCLE.abi, LIFECYCLE.bytecode, [ledger, l1Oracle]);
  const impl = await dep(admin, 'R4SessionVaultImplementation', [ext.keyAttestations, ext.router, usdc]);
  const L = k => (o.staleDep === k ? legacyLedger : ledger);
  const psa = await dep(admin, 'R4PinnedSessionAuthority', [catalog, L('pinnedSessionAuthority')]);
  const factory = await dep(admin, 'R4VaultFactory', [[legacyLedger, catalog, psa], impl]);
  await tx(admin, psa, K.R4PinnedSessionAuthority.abi, 'init', [factory]);
  await tx(admin, impl, K.R4SessionVaultImplementation.abi, 'init', [psa, factory]);
  const identity = await deployRaw(admin, IDENTITY.abi, IDENTITY.bytecode, [[{ factory, codeHash: await codeHash(factory) }]]);
  await tx(admin, ledger, LEDGER.abi, 'bindLifecycle', [lifecycle, identity]);
  const proofOfTime = await dep(admin, 'R4ProofOfTime', [L('proofOfTime'), registry, admin.address]);
  const contracts = { lifecycle, ledger, identity, registry, l1Oracle, catalog, addressBook, hostOwnership, usdc, legacyLedger,
    connectivity: await dep(admin, 'R4Connectivity', [L('connectivity'), registry]), pinnedSessionAuthority: psa, proofOfTime,
    secretVaultV2: await dep(admin, 'R4SecretVaultV2', [psa, L('secretVaultV2'), ext.enclaveOwner, hostOwnership, registry, factory]),
    sessionVaultFactory: factory, sessionVaultImplementation: impl, verificationFees: await dep(admin, 'R4VerificationFees', [L('verificationFees'), proofOfTime, usdc]) };
  for (const [k, a] of Object.entries(contracts)) if (k !== 'addressBook') await tx(admin, addressBook, K.TestAddressBook.abi, 'put', [keccak256(toBytes(k)), a]);
  await tx(admin, factory, K.R4VaultFactory.abi, 'make', [human.address]);
  const vault = getAddress(await read(factory, K.R4VaultFactory.abi, 'vaultFor', [human.address]));
  const payoutOf = p => (p === 'owner' ? human.address : p === 'vault' ? vault : other.address);
  const enclave = e => ({ endpoint: 'https://h', repo: 'r', measurement: MEAS, operator: operator.address, registeredAt: 1n, lastSeen: 1n, active: true,
    cpuPricePerSec6: PAID6, gpuPricePerSec6: 0n, proofKey: operator.address, payoutWallet: payoutOf(o.payout), caps: 0n, region: 'test', ...e });
  await tx(admin, registry, K.TestRegistry.abi, 'set', [HOST, enclave({})]);
  await tx(admin, hostOwnership, K.TestHostOwnership.abi, 'set', [HOST, operator.address, 1n, ZERO32]);   // host owner: no policy (allow)
  const appId = keccak256(toBytes(`app-${idn}`)), app = a => ({ appId, publisher: admin.address, slug: 's', name: 'n', description: 'd', versionCount: 1, createdAt: 1n, updatedAt: 1n, active: true, ...a });
  const ver = v => ({ cid: 'c', version: '1', vramMb: 0, gpuGflops: 0, memMb: 1, cpuGflops: 1, createdAt: 1n, verified: true, yanked: false, ports: '', approval: o.approval, config: '', ...v });
  await tx(admin, catalog, K.TestCatalog.abi, 'set', [app({}), ver({})]);
  // the deployment: created by the owner on the REAL ledger (working rate = the cap until a start prices it)
  const appRef = `catalog://${appId}/${o.appVersion}`;
  const createArgs = [appRef, 0, 1000, 8080, '', o.isPublic, '', ZERO, 0n, CAP6];
  let id;
  if (o.ownedBy === 'vault') {                                                    // the SessionVault is the ledger owner (exec by its owner)
    const data = encodeFunctionData({ abi: LEDGER.abi, functionName: 'create', args: createArgs });
    const { result } = await S.pub.simulateContract({ account: human, address: vault, abi: K.R4Vault.abi, functionName: 'exec', args: [ledger, data] });
    id = decodeFunctionResult({ abi: LEDGER.abi, functionName: 'create', data: result });
    await tx(human, vault, K.R4Vault.abi, 'exec', [ledger, data]);
  } else {
    ({ result: id } = await S.pub.simulateContract({ account: human, address: ledger, abi: LEDGER.abi, functionName: 'create', args: createArgs }));
    await tx(human, ledger, LEDGER.abi, 'create', createArgs);
  }
  idn++;
  if (o.fund6 > 0n) { await tx(admin, usdc, K.TestUSDC.abi, 'mint', [human.address, o.fund6]); await tx(human, usdc, K.TestUSDC.abi, 'approve', [ledger, o.fund6]);
    await tx(human, ledger, LEDGER.abi, 'fund', [id, o.fund6]); }
  const configureTx = await tx(human, lifecycle, LIFECYCLE.abi, 'configure', [id, witnesses.map(w => w.address), 3, MAX_T, RESERVE, MAX_GAS]);
  if (o.deposit) await tx(human, lifecycle, LIFECYCLE.abi, 'deposit', [id], parseEther('1'));
  const w = { admin, human, operator, relay, other, witnesses, vault, ext, id, appId, appRef, app, ver, enclave, payoutOf, contracts, configureTx,
    sent: [], mined: [], hooks: {}, policyDocs: new Map(), auth: { pin: null, tier: 'l1-finalized-derived', proof: true } };
  w.receipts = anvilReceipts(w.hooks);
  const B = (abi, bindings) => ({ abi, bindings });
  const closure = {
    connectivity: B('connectivity', { ledger: 'ledger', registry: 'registry' }),
    pinnedSessionAuthority: B('pinnedSessionAuthority', { appCatalog: 'catalog', deployments: 'ledger', sessionVaultFactory: 'sessionVaultFactory' }),
    proofOfTime: B('proofOfTime', { deployments: 'ledger', owner: 'admin:proofOfTimeOwner', pendingOwner: 'admin:proofOfTimePendingOwner', registry: 'registry' }),
    secretVaultV2: B('secretVaultV2', { book: 'pinnedSessionAuthority', deploymentLedger: 'ledger', enclaveOwner: 'external:enclaveOwner',
      hostOwnership: 'hostOwnership', hostRegistry: 'registry', sessionVaultFactory: 'sessionVaultFactory' }),
    sessionVaultFactory: B('sessionVaultFactory', { 'authorityPins.ledger': 'legacyLedger', 'authorityPins.catalog': 'catalog', 'authorityPins.authority': 'pinnedSessionAuthority',
      implementation: 'sessionVaultImplementation' }),
    sessionVaultImplementation: B('sessionVaultImplementation', { book: 'pinnedSessionAuthority', factory: 'sessionVaultFactory',
      keyAttestations: 'external:keyAttestations', owner: 'zero', router: 'external:router', usdc: 'usdc' }),
    verificationFees: B('verificationFees', { ledger: 'ledger', proof: 'proofOfTime', token: 'usdc' }) };
  w.pins = { chainId: 8453, host: HOST, payee: relay.address, maxChargeWei: MAX_T.toString(), maxGasPriceWei: MAX_GAS.toString(), allowedMeasurements: [MEAS],
    contracts: Object.fromEntries(await Promise.all(Object.entries(contracts).map(async ([k, a]) => [k, { address: a, codeHash: await codeHash(a), ...(closure[k] ?? {}) }]))),
    externals: ext,
    addressBook: Object.fromEntries(Object.entries(contracts).filter(([k]) => k !== 'addressBook').map(([k, a]) => [keccak256(toBytes(k)), a])),
    bookKeys: Object.fromEntries(Object.keys(contracts).filter(k => k !== 'addressBook').map(k => [k, keccak256(toBytes(k))])),
    identityFactories: [{ factory, codeHash: await codeHash(factory) }], preservedFactories: ['sessionVaultFactory'],
    admins: { ledgerOwner: [admin.address], ledgerPendingOwner: [ZERO], addressBookOwner: [admin.address], addressBookPendingOwner: [ZERO],
      proofOfTimeOwner: [admin.address], proofOfTimePendingOwner: [ZERO] } };
  w.adapter = (over = {}) => createLifecycleChainAdapter({ pins: over.pins || w.pins, authority: testAuthority(w.auth, over.kind || 'derived'),
    receipts: w.receipts, hostPolicy: { load: async h => { if (!w.policyDocs.has(h)) throw Error('policy document unavailable'); return structuredClone(w.policyDocs.get(h)); } },
    generation: over.generation || null, now: chainNow, maxAncestry: over.maxAncestry,
    actorSigner: async ({ target, typedData }) => { const a = target === 'running' ? operator : human; return { address: a.address, signature: await a.signTypedData(typedData) }; },
    approvals: async ({ typedData }) => Promise.all(witnesses.map(x => x.signTypedData(typedData))),
    relay: { address: relay.address, send: async t => { w.sent.push(t);
      w.mined.push(await send(relay, { to: t.to, data: t.data, maxFeePerGas: t.maxFeePerGasWei, maxPriorityFeePerGas: 1n }));
      if (w.loseResponse) throw Error('response lost'); } } });
  w.setPayout = p => tx(admin, registry, K.TestRegistry.abi, 'set', [HOST, enclave({ payoutWallet: payoutOf(p) })]);
  w.ledgerGet = () => read(ledger, LEDGER.abi, 'get', [id]);
  return w;
}
export async function step(w, target, reason) { const a = w.adapter(), intent = await a.prepare(w.id, await a.read(w.id), target, reason); await a.submit(w.id, intent); return intent; }
export function runnerFor(w, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-runner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = openLifecycleJournal(path.join(dir, 'j.json')), calls = [];
  const runtime = { fence: async () => calls.push('fence'), stop: async () => { calls.push('stop'); return true; },
    health: async () => ({ ready: true, ended: false, instance: 'i' }), serve: async () => calls.push('serve'),
    ensureStaged: async () => { calls.push('stage'); return { ready: true, ended: false, instance: 's' }; } };
  return { runner: new DeploymentLifecycleRunner({ chain: w.adapter(), runtime, journal, now: chainNow, random: () => 0 }), journal, calls };
}
