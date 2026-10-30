// host-registry r2 owned-Anvil world (TEST ONLY). ACTUAL contracts: the reviewed EnclaveHostLifecycleRegistry Forge artifact (e8690734,
// source 68310acc) deployed with its normal no-argument creation code, and the schema-3 bundle (library, linked ledger, emergency
// controller, identity, prover) exactly as schema3-world.mjs deploys them -- but every immutable registry/hostOwnership dependency
// (ledger.registry, prover.registry, connectivity.registry, secretVaultV2.hostRegistry/hostOwnership) is bound to THIS new registry.
// No TestRegistry/TestHostOwnership, vm.etch, code-size override or signature shim. The host is enrolled only through the registry's
// own qualified path: payer reserveBootstrap -> operator + accepted-owner consent -> fixture verifier quorum receipt.
// Repair r1: r5 account() funds every key with 10 ETH, so the operator and the accepted owner are explicitly set to 0 wei BEFORE
// enrollment and asserted to still hold 0 wei AFTER it (w.zeroEth). Only then is the owner funded, separately, for its later owner
// transactions; a test that needs operator transactions funds the operator itself (fund()).
// Still labelled r5 TEST doubles: USDC, catalog, L1 oracle, legacy-ledger stand-in, R4 closure contracts, finality authority, receipts.
// The fixture verifiers/reporters/payer are generated public TEST keys; the anchor is NOT a qualification service and the 10^15-wei
// protected reserve is NOT a production-admissible sponsorship (no L1 fee, no affordability or funded-sender proof).
import { encodeDeployData, getAddress, keccak256, toBytes } from 'viem';
import { S, rpc, account, send, dep, tx, codeHash, read, anvilReceipts, testAuthority, chainNow, HOST, MEAS, ZERO, ZERO32, MAX_T, RESERVE, MAX_GAS,
  CAP6 } from './r5-world.mjs';
import { ART3, L3, deployLibrary, deployLedger, deployController, deployProver, MAX_WINDOW } from './schema3-world.mjs';
import { createLifecycleChainAdapter } from '../../network/deployment-chain-adapter.mjs';
import { loadHostRegistryArtifact, HOST_REGISTRY_PROFILE, HOST_REGISTRY_ARTIFACT_SHA256 } from '../../network/lifecycle-host-registry-profile.mjs';

export const REG = loadHostRegistryArtifact();
export const RA = REG.abi;
export const ENDPOINT = 'host-a';                        // registry hostId = keccak256(endpoint) == r5 HOST
if (keccak256(toBytes(ENDPOINT)) !== HOST) throw Error('fixture: endpoint does not derive the r5 HOST id');
const K32 = s => keccak256(toBytes(`TEST ${s}`));
export const HW = K32('hardware-1'), ATT = K32('attestation-1'), ATT2 = K32('attestation-2'), RES = K32('resource-1');
export const PROTECTED = 10n ** 15n;
const deployRaw = async (from, abi, bytecode, args = [], gas = 5_000_000n) => (await send(from, { gas, data: encodeDeployData({ abi, bytecode, args }) })).contractAddress;
export const deployRegistry = from => deployRaw(from, RA, REG.creation, [], 12_000_000n);
const W = a => `${'0'.repeat(24)}${a.slice(2).toLowerCase()}`, U = n => n.toString(16).padStart(64, '0');
const asc = xs => xs.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const latest = async () => (await S.pub.getBlock({ blockTag: 'latest' })).timestamp;
export const balance = a => S.pub.getBalance({ address: a.address });
export const fund = a => rpc('anvil_setBalance', [a.address, '0x8ac7230489e80000']);   // separately, AFTER the zero-ETH enrollment

// identical derivation to schema3-world.mjs (not exported there): each immutable id holds exactly one expected concrete value
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

export const reg = (w, fn, args = []) => read(w.contracts.registry, RA, fn, args);

/** Qualified enrollment of ENDPOINT through the actual registry; operator and owner hold (and keep) 0 wei throughout. */
async function enroll(w) {
  const R = w.contracts.registry, now = await latest();
  await rpc('anvil_setBalance', [w.operator.address, '0x0']); await rpc('anvil_setBalance', [w.hostOwner.address, '0x0']);
  const before = { operator: await balance(w.operator), owner: await balance(w.hostOwner) };
  if (before.operator !== 0n || before.owner !== 0n) throw Error('fixture: operator/owner not at 0 wei before enrollment');
  const anchorArgs = [w.verifiers.map(v => v.address), 2, 1, 86400n, K32('fixture verifier quorum: NOT a qualification service')];
  const { result: anchorId } = await S.pub.simulateContract({ account: w.anchorPublisher, address: R, abi: RA, functionName: 'publishTrustAnchor', args: anchorArgs });
  await tx(w.anchorPublisher, R, RA, 'publishTrustAnchor', anchorArgs);
  await tx(w.payer, R, RA, 'depositSponsorFunds', [], PROTECTED);
  const s = { hostId: HOST, hardwareId: HW, jobId: K32('sponsor job'), payer: w.payer.address, trustAnchorId: anchorId, source: 1,
    sourceEvidence: K32('paid-work host receipt digest'), protectedAmount: PROTECTED, listingGasCap: 0n, perTransitionCap: PROTECTED,
    l1FeeAllowance: 0n, maxGasPrice: MAX_GAS, submitter: ZERO, nonce: 1n, deadline: now + 3600n };
  const reservationId = await reg(w, 'hashReservation', [s]);
  await tx(w.payer, R, RA, 'reserveBootstrap', [s, '0x']);                 // the payer itself (empty authorization = msg.sender)
  const listing = { endpoint: ENDPOINT, repo: 'r', measurement: MEAS, cpuPricePerSec6: 10n, gpuPricePerSec6: 0n, proofKey: w.operator.address,
    caps: 0n, region: 'test' };
  const policy = w.policy(w.reporters);
  const e = { listing, operator: w.operator.address, owner: w.hostOwner.address, ownerPolicyHash: ZERO32, hardwareId: HW, attestationDigest: ATT,
    resourceDigest: RES, trustAnchorId: anchorId, reporterPolicyHash: await reg(w, 'hashReporterPolicy', [policy]), reservationId,
    protectedAmount: PROTECTED, nonce: 1n, deadline: now + 3600n };
  const digest = await reg(w, 'hashEnrollment', [e]);
  const q = { trustAnchorId: anchorId, hostId: HOST, hardwareId: HW, descriptorDigest: await reg(w, 'descriptorOf', ['r', MEAS]), attestationDigest: ATT,
    resourceDigest: RES, testDigest: K32('enrollment work nonce/result'), intentDigest: digest, generation: 1n, issuedAt: now, expiresAt: now + 3600n };
  const qd = await reg(w, 'hashReceipt', [q]);
  const sigs = await Promise.all(w.verifiers.map(v => v.sign({ hash: qd })));   // strictly ascending verifier addresses
  await tx(w.submitter, R, RA, 'registerQualifiedHost', [e, policy, q, await w.operator.sign({ hash: digest }), await w.hostOwner.sign({ hash: digest }), sigs]);
  const after = { operator: await balance(w.operator), owner: await balance(w.hostOwner) };
  if (after.operator !== 0n || after.owner !== 0n) throw Error('fixture: operator/owner balance changed during enrollment');
  w.zeroEth = Object.freeze({ before, after });
  await fund(w.hostOwner);                                                  // separately, for the owner's LATER transactions only
  return { anchorId, reservationId, enrollmentDigest: digest, qualificationDigest: qd };
}

// opts: payout 'owner' | 'other', deposit
export async function worldHR(opts = {}) {
  const o = { payout: 'owner', isPublic: false, approval: 1, appVersion: '0', deposit: true, ...opts }, K = S.K;
  const [admin, human, operator, hostOwner, nextOwner, payer, submitter, relay, other, anchorPublisher] =
    await Promise.all(Array.from({ length: 10 }, () => account()));
  const witnesses = asc(await Promise.all([account(), account(), account()]));
  const reporters = asc(await Promise.all([account(), account(), account()]));
  const reporters2 = asc(await Promise.all([account(), account(), account()]));
  const verifiers = asc(await Promise.all([account(), account()]));
  const ext = { keyAttestations: (await account()).address, router: (await account()).address, enclaveOwner: (await account()).address };
  const beforeRegistry = await S.pub.getBlockNumber();
  const usdc = await dep(admin, 'TestUSDC'), catalog = await dep(admin, 'TestCatalog'), l1Oracle = await dep(admin, 'TestL1Oracle');
  const legacyLedger = await dep(admin, 'LegacyLedgerStandIn');
  const registry = await deployRegistry(admin);                                   // ACTUAL, normal constructor (none)
  const accountingLibrary = await deployLibrary(admin);
  const ledger = await deployLedger(admin, accountingLibrary, usdc, admin.address, registry);
  const lifecycle = await deployController(admin, ledger, l1Oracle);
  const impl = await dep(admin, 'R4SessionVaultImplementation', [ext.keyAttestations, ext.router, usdc]);
  const psa = await dep(admin, 'R4PinnedSessionAuthority', [catalog, ledger]);
  const factory = await dep(admin, 'R4VaultFactory', [[legacyLedger, catalog, psa], impl]);
  await tx(admin, psa, K.R4PinnedSessionAuthority.abi, 'init', [factory]);
  await tx(admin, impl, K.R4SessionVaultImplementation.abi, 'init', [psa, factory]);
  const identity = await deployRaw(admin, L3.IDENTITY, ART3.identity.creationTemplate, [[{ factory, codeHash: await codeHash(factory) }]]);
  await tx(admin, ledger, L3.LEDGER, 'bindLifecycle', [lifecycle, identity]);
  const proofOfTime = await deployProver(admin, ledger, registry);
  await tx(admin, ledger, L3.LEDGER, 'setProver', [proofOfTime]);
  const contracts = { lifecycle, ledger, identity, registry, hostOwnership: registry, l1Oracle, catalog, usdc, legacyLedger, accountingLibrary,
    connectivity: await dep(admin, 'R4Connectivity', [ledger, registry]), pinnedSessionAuthority: psa, proofOfTime,
    secretVaultV2: await dep(admin, 'R4SecretVaultV2', [psa, ledger, ext.enclaveOwner, registry, registry, factory]),
    sessionVaultFactory: factory, sessionVaultImplementation: impl, verificationFees: await dep(admin, 'R4VerificationFees', [ledger, proofOfTime, usdc]) };
  const w = { admin, human, operator, hostOwner, nextOwner, owner: hostOwner, payer, submitter, relay, other, anchorPublisher, witnesses, reporters,
    reporters2, verifiers, ext, contracts, beforeRegistry, sent: [], mined: [], hooks: {}, auth: { pin: null, tier: 'l1-finalized-derived', proof: true },
    policy: rs => ({ reporters: rs.map(x => x.address), threshold: 2 }) };
  w.enrollment = await enroll(w);
  await tx(o.payout === 'owner' ? human : other, registry, RA, 'setPayoutWallet', [HOST]);   // payout declaration (pricing routing only)
  await tx(admin, factory, K.R4VaultFactory.abi, 'make', [human.address]);
  const appId = keccak256(toBytes(`apphr-${Date.now()}-${Math.random()}`));
  await tx(admin, catalog, K.TestCatalog.abi, 'set', [
    { appId, publisher: admin.address, slug: 's', name: 'n', description: 'd', versionCount: 1, createdAt: 1n, updatedAt: 1n, active: true },
    { cid: 'c', version: '1', vramMb: 0, gpuGflops: 0, memMb: 1, cpuGflops: 1, createdAt: 1n, verified: true, yanked: false, ports: '', approval: o.approval, config: '' }]);
  const appRef = `catalog://${appId}/${o.appVersion}`, createArgs = [appRef, 0, 1000, 8080, '', o.isPublic, '', ZERO, 0n, CAP6];
  const { result: id } = await S.pub.simulateContract({ account: human, address: ledger, abi: L3.LEDGER, functionName: 'create', args: createArgs });
  await tx(human, ledger, L3.LEDGER, 'create', createArgs);
  await tx(human, lifecycle, L3.LIFECYCLE, 'configure', [id, witnesses.map(x => x.address), 3, MAX_T, RESERVE, MAX_GAS]);
  if (o.deposit) await tx(human, lifecycle, L3.LIFECYCLE, 'deposit', [id], 10n ** 18n);
  w.id = id; w.appRef = appRef;
  const immutables = {
    ledger: await immutablesOf('ledger', ledger, { usdc: W(usdc), registry: W(registry) }),
    lifecycle: await immutablesOf('lifecycle', lifecycle, { ledger: W(ledger), l1Oracle: W(l1Oracle) }),
    proofOfTime: await immutablesOf('proofOfTime', proofOfTime, { ledger: W(ledger), registry: W(registry), lifecycle: W(lifecycle), [`uint64:${MAX_WINDOW}`]: U(MAX_WINDOW) }),
    identity: {}, accountingLibrary: {} };
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
  w.pins = { chainId: 8453, host: HOST, payee: relay.address, maxChargeWei: MAX_T.toString(), maxGasPriceWei: MAX_GAS.toString(), allowedMeasurements: [MEAS],
    externals: ext, identityFactories: [{ factory, codeHash: await codeHash(factory) }], preservedFactories: ['sessionVaultFactory'],
    profile: HOST_REGISTRY_PROFILE, contracts: pinned, hostRegistry: { artifactSha256: HOST_REGISTRY_ARTIFACT_SHA256 },
    admins: { ledgerOwner: [admin.address], ledgerPendingOwner: [ZERO], proofOfTimeOwner: [admin.address], proofOfTimePendingOwner: [ZERO] },
    schema3: { immutables } };
  w.receipts = anvilReceipts(w.hooks);
  const virtualAuthority = kind => { const base = testAuthority(w.auth, kind);
    return { ...base, snapshot: async fn => ({ ...await base.snapshot(fn), observedAt: chainNow() }) }; };
  w.adapter = (over = {}) => createLifecycleChainAdapter({ pins: over.pins || w.pins, authority: virtualAuthority(over.kind || 'derived'),
    receipts: w.receipts, hostPolicy: { load: async () => { throw Error('TEST: no committed host policy document (policyHash is zero)'); } },
    generation: null, now: chainNow,
    actorSigner: async ({ target, typedData }) => { const a = target === 'running' ? operator : human; return { address: a.address, signature: await a.signTypedData(typedData) }; },
    approvals: async ({ typedData }) => Promise.all(witnesses.map(x => x.signTypedData(typedData))),
    relay: { address: relay.address, send: async t => { w.sent.push(t);
      w.mined.push(await send(relay, { to: t.to, data: t.data, maxFeePerGas: t.maxFeePerGasWei, maxPriorityFeePerGas: 1n }));
      if (w.loseResponse) throw Error('response lost'); } } });
  w.assignment = () => read(lifecycle, L3.LIFECYCLE, 'assignments', [id]);
  return w;
}

/** HostOffline intent for the CURRENT generation/operator/revision (or overridden fields). */
export async function offlineIntent(w, over = {}) {
  const st = await reg(w, 'hostState', [HOST]), a = await reg(w, 'authority', [HOST]), row = await reg(w, 'get', [HOST]);
  return { hostId: HOST, generation: st[0], operator: row.operator, authorityRevision: a[2], targetStatus: 2, evidenceDigest: K32('offline evidence'),
    deadline: (await latest()) + 600n, payee: ZERO, maxCharge: 0n, ...over };
}
/** Graceful Offline by the accepted owner (or `from`) as msg.sender: the operator takes no part. */
export const ownerOffline = async (w, from = w.owner, over = {}) => tx(from, w.contracts.registry, RA, 'deactivateHost', [await offlineIntent(w, over)]);
/** Reporter-quorum Offline submitted by an unrelated TEST account. */
export async function quorumOffline(w, signers = w.reporters.slice(0, 2), over = {}) {
  const o = await offlineIntent(w, over), d = await reg(w, 'hashOffline', [o]);
  return tx(w.other, w.contracts.registry, RA, 'recordHostOffline', [o, await Promise.all(signers.map(s => s.sign({ hash: d })))]);
}
/** A strictly newer qualified generation after a recorded Offline (no new reservation: the payer's prior anchor). */
export async function recoverHost(w) {
  const st = await reg(w, 'hostState', [HOST]), a = await reg(w, 'authority', [HOST]), now = await latest();
  const v = { hostId: HOST, priorGeneration: st[0], priorOfflineDigest: st[9], authorityRevision: a[2], operator: w.operator.address, owner: a[0],
    repo: 'r', measurement: MEAS, proofKey: w.operator.address, hardwareId: HW, attestationDigest: ATT2, resourceDigest: RES, trustAnchorId: st[8],
    reservationId: ZERO32, protectedAmount: PROTECTED, nonce: 2n, deadline: now + 3600n };
  const digest = await reg(w, 'hashRecovery', [v]);
  const q = { trustAnchorId: st[8], hostId: HOST, hardwareId: HW, descriptorDigest: await reg(w, 'descriptorOf', ['r', MEAS]), attestationDigest: ATT2,
    resourceDigest: RES, testDigest: K32('recovery work nonce/result'), intentDigest: digest, generation: st[0] + 1n, issuedAt: now, expiresAt: now + 3600n };
  const qd = await reg(w, 'hashReceipt', [q]);
  if (getAddress(a[0]) !== getAddress(w.owner.address)) throw Error('fixture: w.owner is not the accepted owner');
  return tx(w.submitter, w.contracts.registry, RA, 'recoverQualifiedHost', [v, q, await w.operator.sign({ hash: digest }), await w.owner.sign({ hash: digest }),
    await Promise.all(w.verifiers.map(x => x.sign({ hash: qd })))]);
}
