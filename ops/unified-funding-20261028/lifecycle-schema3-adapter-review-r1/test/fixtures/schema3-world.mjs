// schema3 r1 owned-Anvil world (TEST ONLY). The ACTUAL schema-3 contracts from the reviewed precompiled bundle
// (deploy/lifecycle/schema3/bundle.json, sources c720f1bf/946f0b90/ac4023b9/f8dae9ab): EnclaveLifecycleAccounting library deployed
// normally, EnclaveDeployments creation code linked to it with the pure linkTemplate, EnclaveDeploymentLifecycleEmergency,
// EnclaveSelfHostingIdentity and EnclaveProofOfTime. No compiler, no vm.etch, no code-size override (Anvil default EIP-170).
// Registry/catalog/USDC/host-ownership/closure contracts and the authority/receipt sources are the SAME labelled r5 TEST doubles
// (r5-world.mjs, precompiled by the root precompile step). Public generated TEST keys only; no production RPC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, getAddress, hashTypedData, keccak256, parseEther, toBytes } from 'viem';
import { S, account, send, dep, tx, codeHash, read, anvilReceipts, testAuthority, chainNow, HOST, MEAS, ZERO, ZERO32, MAX_T, RESERVE, MAX_GAS,
  CAP6, PAID6 } from './r5-world.mjs';
import { createLifecycleChainAdapter } from '../../network/deployment-chain-adapter.mjs';
import { DeploymentLifecycleRunner } from '../../network/deployment-lifecycle-runner.mjs';
import { openLifecycleJournal } from '../../network/deployment-lifecycle-journal.mjs';
import { linkTemplate } from '../../network/lifecycle-linked-artifacts.mjs';
import { SCHEMA3_ROLES, SCHEMA3_PROFILE } from '../../network/lifecycle-schema3-profile.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
export const BUNDLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/lifecycle/schema3/bundle.json'), 'utf8'));
export const ART3 = Object.fromEntries(Object.entries(SCHEMA3_ROLES).map(([role, key]) => [role, BUNDLE.contracts[key]]));
export const L3 = { LEDGER: ART3.ledger.abi, LIFECYCLE: ART3.lifecycle.abi, PROVER: ART3.proofOfTime.abi, IDENTITY: ART3.identity.abi, LIBRARY: ART3.accountingLibrary.abi };
export const WINDOW = 600n, MAX_WINDOW = 3600n;
const deployRaw = async (from, abi, bytecode, args = [], gas = 5_000_000n) => (await send(from, { gas, data: encodeDeployData({ abi, bytecode, args }) })).contractAddress;
export const deployLibrary = from => deployRaw(from, L3.LIBRARY, ART3.accountingLibrary.creationTemplate, [], 8_000_000n);
export const deployLedger = (from, library, usdc, payout, registry) => deployRaw(from, L3.LEDGER,
  linkTemplate(ART3.ledger.creationTemplate, ART3.ledger.creationLinks, { [SCHEMA3_ROLES.accountingLibrary]: library }), [usdc, payout, registry, ZERO], 28_000_000n);
export const deployController = (from, ledger, l1Oracle) => deployRaw(from, L3.LIFECYCLE, ART3.lifecycle.creationTemplate, [ledger, l1Oracle], 12_000_000n);
export const deployProver = (from, ledger, registry) => deployRaw(from, L3.PROVER, ART3.proofOfTime.creationTemplate, [ledger, registry, WINDOW, MAX_WINDOW], 8_000_000n);
const W = a => `${'0'.repeat(24)}${a.slice(2).toLowerCase()}`, U = n => n.toString(16).padStart(64, '0');

// Fixture-side derivation ONLY: each compiler immutable id must hold exactly one expected concrete value (bijection). The adapter
// independently re-resolves the whole runtime from these targets and the template, and compares the code hash.
async function immutablesOf(role, address, candidates) {
  const art = ART3[role], code = (await S.pub.getCode({ address })).slice(2), out = {}, used = new Set();
  for (const [id, slots] of Object.entries(art.immutableReferences ?? {})) {
    if (id === 'library_deploy_address') continue;
    const vals = new Set(slots.map(s => code.slice(s.start * 2, (s.start + 32) * 2)));
    const hit = vals.size === 1 ? Object.entries(candidates).find(([, w]) => w === [...vals][0]) : null;
    if (!hit || used.has(hit[0])) throw Error(`fixture: ${role} immutable ${id} is not exactly one expected concrete value`);
    used.add(hit[0]); out[id] = hit[0];
  }
  if (used.size !== Object.keys(candidates).length) throw Error(`fixture: ${role} immutables do not cover every expected value`);
  return out;
}

// opts as r5 world(): payout 'owner' | 'vault' | 'other', isPublic, approval, appVersion, fund6, deposit, staleDep (one closure
// dependency bound to the legacy ledger stand-in while the pins still say THIS ledger)
export async function world3(opts = {}) {
  const o = { payout: 'owner', isPublic: false, approval: 1, appVersion: '0', fund6: 0n, staleDep: null, deposit: true, ...opts }, K = S.K;
  const [admin, human, operator, relay, other, ...ws] = await Promise.all([account(), account(), account(), account(), account(), account(), account(), account()]);
  const witnesses = ws.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const ext = { keyAttestations: (await account()).address, router: (await account()).address, enclaveOwner: (await account()).address };
  const usdc = await dep(admin, 'TestUSDC'), registry = await dep(admin, 'TestRegistry'), catalog = await dep(admin, 'TestCatalog');
  const addressBook = await dep(admin, 'TestAddressBook', [admin.address]), l1Oracle = await dep(admin, 'TestL1Oracle');
  const hostOwnership = await dep(admin, 'TestHostOwnership'), legacyLedger = await dep(admin, 'LegacyLedgerStandIn');
  const accountingLibrary = await deployLibrary(admin);
  const ledger = await deployLedger(admin, accountingLibrary, usdc, admin.address, registry);
  const lifecycle = await deployController(admin, ledger, l1Oracle);
  const impl = await dep(admin, 'R4SessionVaultImplementation', [ext.keyAttestations, ext.router, usdc]);
  const L = k => (o.staleDep === k ? legacyLedger : ledger);
  const psa = await dep(admin, 'R4PinnedSessionAuthority', [catalog, L('pinnedSessionAuthority')]);
  const factory = await dep(admin, 'R4VaultFactory', [[legacyLedger, catalog, psa], impl]);
  await tx(admin, psa, K.R4PinnedSessionAuthority.abi, 'init', [factory]);
  await tx(admin, impl, K.R4SessionVaultImplementation.abi, 'init', [psa, factory]);
  const identity = await deployRaw(admin, L3.IDENTITY, ART3.identity.creationTemplate, [[{ factory, codeHash: await codeHash(factory) }]]);
  await tx(admin, ledger, L3.LEDGER, 'bindLifecycle', [lifecycle, identity]);
  const proofOfTime = await deployProver(admin, ledger, registry);                    // actual prover: requires the bound schema-3 pair
  await tx(admin, ledger, L3.LEDGER, 'setProver', [proofOfTime]);
  const contracts = { lifecycle, ledger, identity, registry, l1Oracle, catalog, addressBook, hostOwnership, usdc, legacyLedger, accountingLibrary,
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
  await tx(admin, hostOwnership, K.TestHostOwnership.abi, 'set', [HOST, operator.address, 1n, ZERO32]);
  const appId = keccak256(toBytes(`app3-${Date.now()}-${Math.random()}`));
  const app = a => ({ appId, publisher: admin.address, slug: 's', name: 'n', description: 'd', versionCount: 1, createdAt: 1n, updatedAt: 1n, active: true, ...a });
  const ver = v => ({ cid: 'c', version: '1', vramMb: 0, gpuGflops: 0, memMb: 1, cpuGflops: 1, createdAt: 1n, verified: true, yanked: false, ports: '', approval: o.approval, config: '', ...v });
  await tx(admin, catalog, K.TestCatalog.abi, 'set', [app({}), ver({})]);
  const appRef = `catalog://${appId}/${o.appVersion}`, createArgs = [appRef, 0, 1000, 8080, '', o.isPublic, '', ZERO, 0n, CAP6];
  const { result: id } = await S.pub.simulateContract({ account: human, address: ledger, abi: L3.LEDGER, functionName: 'create', args: createArgs });
  await tx(human, ledger, L3.LEDGER, 'create', createArgs);
  if (o.fund6 > 0n) { await tx(admin, usdc, K.TestUSDC.abi, 'mint', [human.address, o.fund6]); await tx(human, usdc, K.TestUSDC.abi, 'approve', [ledger, o.fund6]);
    await tx(human, ledger, L3.LEDGER, 'fund', [id, o.fund6]); }
  const configureTx = await tx(human, lifecycle, L3.LIFECYCLE, 'configure', [id, witnesses.map(x => x.address), 3, MAX_T, RESERVE, MAX_GAS]);
  if (o.deposit) await tx(human, lifecycle, L3.LIFECYCLE, 'deposit', [id], parseEther('1'));
  const immutables = {
    ledger: await immutablesOf('ledger', ledger, { usdc: W(usdc), registry: W(registry) }),
    lifecycle: await immutablesOf('lifecycle', lifecycle, { ledger: W(ledger), l1Oracle: W(l1Oracle) }),
    proofOfTime: await immutablesOf('proofOfTime', proofOfTime, { ledger: W(ledger), registry: W(registry), lifecycle: W(lifecycle), [`uint64:${MAX_WINDOW}`]: U(MAX_WINDOW) }),
    identity: {}, accountingLibrary: {} };
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
  const pinned = Object.fromEntries(await Promise.all(Object.entries(contracts).map(async ([k, a]) => [k, { address: a, codeHash: await codeHash(a), ...(closure[k] ?? {}) }])));
  const common = { chainId: 8453, host: HOST, payee: relay.address, maxChargeWei: MAX_T.toString(), maxGasPriceWei: MAX_GAS.toString(), allowedMeasurements: [MEAS],
    externals: ext, identityFactories: [{ factory, codeHash: await codeHash(factory) }], preservedFactories: ['sessionVaultFactory'] };
  const { addressBook: _book, ...independentContracts } = pinned;
  w.pins = { ...common, profile: SCHEMA3_PROFILE, contracts: independentContracts, discovery: { addressBook },
    admins: { ledgerOwner: [admin.address], ledgerPendingOwner: [ZERO], proofOfTimeOwner: [admin.address], proofOfTimePendingOwner: [ZERO] },
    schema3: { immutables } };
  // the legacy default profile's complete pins over the SAME world (must refuse: it pins schema 2)
  w.legacyPins = { ...common, contracts: pinned,
    addressBook: Object.fromEntries(Object.entries(contracts).filter(([k]) => k !== 'addressBook').map(([k, a]) => [keccak256(toBytes(k)), a])),
    bookKeys: Object.fromEntries(Object.keys(contracts).filter(k => k !== 'addressBook').map(k => [k, keccak256(toBytes(k))])),
    admins: { ledgerOwner: [admin.address], ledgerPendingOwner: [ZERO], addressBookOwner: [admin.address], addressBookPendingOwner: [ZERO],
      proofOfTimeOwner: [admin.address], proofOfTimePendingOwner: [ZERO] } };
  // TEST-only virtual clock: warp() advances the Anvil clock and runner's chainNow;
  // observation time must use that same controlled clock, not unwarped wall time.
  const virtualAuthority = kind => {
    const base = testAuthority(w.auth, kind);
    return { ...base, snapshot: async fn => ({ ...await base.snapshot(fn), observedAt: chainNow() }) };
  };
  w.adapter = (over = {}) => createLifecycleChainAdapter({ pins: over.pins || w.pins, authority: virtualAuthority(over.kind || 'derived'),
    receipts: w.receipts, hostPolicy: { load: async h => { if (!w.policyDocs.has(h)) throw Error('policy document unavailable'); return structuredClone(w.policyDocs.get(h)); } },
    generation: over.generation || null, now: chainNow, maxAncestry: over.maxAncestry,
    actorSigner: async ({ target, typedData }) => { const a = target === 'running' ? operator : human; return { address: a.address, signature: await a.signTypedData(typedData) }; },
    approvals: async ({ typedData }) => Promise.all(witnesses.map(x => x.signTypedData(typedData))),
    relay: { address: relay.address, send: async t => { w.sent.push(t);
      w.mined.push(await send(relay, { to: t.to, data: t.data, maxFeePerGas: t.maxFeePerGasWei, maxPriorityFeePerGas: 1n }));
      if (w.loseResponse) throw Error('response lost'); } } });
  w.ledgerGet = () => read(ledger, L3.LEDGER, 'get', [id]);
  w.assignment = () => read(lifecycle, L3.LIFECYCLE, 'assignments', [id]);
  return w;
}

// the quorum-only per-deployment emergencyOffline, signed by THIS deployment's TEST witnesses, submitted by a TEST account
export async function emergency3(w, { target = 'queued', submitter = w.other } = {}) {
  const a = await w.assignment(), b = await S.pub.getBlock({ blockTag: 'latest' });
  const x = { id: w.id, generation: a[2], revision: a[3], fromState: 2, host: a[4], operator: a[5], target: target === 'stopped' ? 3 : 1,
    deadline: b.timestamp + 60n, payee: ZERO, maxReimburseWei: 0n };
  const typedData = { domain: { name: 'EnclaveDeploymentLifecycle.EmergencyOffline', version: '1', chainId: 8453, verifyingContract: w.contracts.lifecycle },
    types: { EmergencyOffline: [{ name: 'id', type: 'bytes32' }, { name: 'generation', type: 'uint64' }, { name: 'revision', type: 'uint64' },
      { name: 'fromState', type: 'uint8' }, { name: 'host', type: 'bytes32' }, { name: 'operator', type: 'address' }, { name: 'target', type: 'uint8' },
      { name: 'deadline', type: 'uint64' }, { name: 'payee', type: 'address' }, { name: 'maxReimburseWei', type: 'uint128' }] },
    primaryType: 'EmergencyOffline', message: x };
  const digest = hashTypedData(typedData);
  if (digest !== await read(w.contracts.lifecycle, L3.LIFECYCLE, 'emergencyDigest', [x])) throw Error('fixture: emergency typed data differs from the controller');
  const sigs = await Promise.all(w.witnesses.map(s => s.signTypedData(typedData)));
  const receipt = await tx(submitter, w.contracts.lifecycle, L3.LIFECYCLE, 'emergencyOffline', [x, sigs]);
  return { receipt, digest, x, cutoff: Number((await S.pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp) };
}
export const reconcile3 = (w, from = w.other) => tx(from, w.contracts.lifecycle, L3.LIFECYCLE, 'reconcileOffline', [w.id]);

export function runner3(w, t, { generation = null, pins = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-runner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = openLifecycleJournal(path.join(dir, 'j.json')), calls = [];
  const runtime = { fence: async () => calls.push('fence'), stop: async () => { calls.push('stop'); return true; },
    health: async () => ({ ready: true, ended: false, instance: 'i' }), serve: async () => calls.push('serve'),
    ensureStaged: async () => { calls.push('stage'); return { ready: true, ended: false, instance: 's' }; } };
  return { runner: new DeploymentLifecycleRunner({ chain: w.adapter({ generation }), runtime, journal, pins, now: chainNow, random: () => 0 }), journal, calls };
}
export { encodeFunctionData, decodeFunctionResult };
