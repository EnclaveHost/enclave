// plan v2: the complete, reviewable, UNSIGNED rev-17 activation for chain 8453, built to be replayed byte for byte on an
// impersonation-only fork (replay.mjs). Differences from plan v1 (plans/52842154.plan.json, kept as evidence):
//   - the admin wallet retains ownership of the prover and ledger, including future version migration;
//   - stranded escrow is tracked as a continuity stage (serve-out before retirement), never silently accepted;
//   - owner carries are exact transactions for each owner's real execution method; unsupported cases are listed;
//   - every cost comes from the replay; anything not executed there is reported UNKNOWN, never counted as zero.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeFunctionData, encodeAbiParameters, getContractAddress, getAddress, keccak256, stringToHex, parseAbi, toFunctionSelector } from 'viem';
import { HERE, REPO, LEDGER_ABI, BOOK, PROVER, OWNABLE } from './lib/abis.mjs';
import { planImport } from './lib/ledgerstate.mjs';
import { predictRuntime, escrowStages, strandedAtRetire } from './lib/stages.mjs';

const B = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'build', n + '.json'), 'utf8'));
const J = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const lc = (a) => String(a).toLowerCase();
const link = (obj, refs, libs) => { let o = obj.replace(/^0x/, ''); for (const l of Object.values(refs || {})) for (const [lib, places] of Object.entries(l))
  for (const { start, length } of places) o = o.slice(0, start * 2) + libs[lib].slice(2).toLowerCase() + o.slice((start + length) * 2); return '0x' + o; };
const ctor = (abi, bytecode, args) => { const c = abi.find((x) => x.type === 'constructor'); return c ? bytecode + encodeAbiParameters(c.inputs, args).slice(2) : bytecode; };
/** Static, exact phases (P, G1, I-tail, G2) and the predicted world. migrator nonce is an input (live read by the CLI). */
export function staticPlan({ snap, migrator, nonce }) {
  const P = snap.ledger.params, OLD = getAddress(snap.ledger.address), GOV = getAddress(P.owner), BOOK_ADDR = getAddress(snap.book.address);
  const L17 = B('ledger17'), PROOF = B('proofOfTime'), FEESB = B('verificationFees'), CONN = B('connectivity'), PIN = B('pinned');
  const v1 = JSON.parse(fs.readFileSync(path.join(HERE, 'rehearsal', '52842154.json'), 'utf8'));   // the ledger17 immutable-id map, proven there
  const M = getAddress(migrator);
  const txs = []; let n = nonce;
  const add = (t) => { txs.push({ chainId: 8453, value: '0', irreversible: false, ...t }); return t; };
  const create = (phase, label, data) => { const address = getContractAddress({ from: M, nonce: BigInt(n) }); add({ phase, signer: { role: 'migrator', address: M, nonce: n++ }, to: null, data, creates: address, label }); return address; };
  const call = (phase, role, from, to, abi, fn, args, extra = {}) => add({ phase, signer: { role, address: from, ...(role === 'migrator' ? { nonce: n++ } : {}) }, to, data: encodeFunctionData({ abi, functionName: fn, args }), label: extra.label || fn, ...extra });

  const BW = getAddress(L17.reuseLiveBandwidthLibrary.address), PINLIB = getAddress(PIN.proof.liveRuntimesMatch.SessionVaultLib.address);
  const GEN = create('P', 'deploy EnclaveLeaseGeneration (linked: live EnclaveLedgerBandwidth)', link(L17.contracts.EnclaveLeaseGeneration.bytecode.object, L17.contracts.EnclaveLeaseGeneration.bytecode.linkReferences, { EnclaveLedgerBandwidth: BW }));
  const libs = { EnclaveLedgerBandwidth: BW, EnclaveLeaseGeneration: GEN };
  const NEW = create('P', 'deploy EnclaveDeployments rev 17', ctor(L17.contracts.EnclaveDeployments.abi, link(L17.contracts.EnclaveDeployments.bytecode.object, L17.contracts.EnclaveDeployments.bytecode.linkReferences, libs),
    [P.usdc, P.payout, P.registry, P.ethUsdFeed]));
  const PRF = create('P', 'deploy EnclaveProofOfTime (verified build)', ctor(PROOF.abi, '0x' + PROOF.bytecode.object, [NEW, P.registry]));
  call('P', 'migrator', M, NEW, LEDGER_ABI, 'setProver', [PRF], { label: 'ledger17.setProver (one-shot; before the fee router)' });
  const FEES = create('P', 'deploy EnclaveVerificationFees (verified build)', ctor(FEESB.abi, '0x' + FEESB.bytecode.object, [NEW, PRF]));
  call('P', 'migrator', M, NEW, LEDGER_ABI, 'setFeeRouter', [FEES], { label: 'ledger17.setFeeRouter (one-shot)' });
  const CONNA = create('P', 'deploy EnclaveConnectivity (verified build; live bootstrap signers)', ctor(CONN.abi, '0x' + CONN.bytecode.object, [NEW, CONN.proof.liveConstructorArgs[1]]));
  const bw = snap.dependents.connectivity.boundAsBandwidthRouter ? CONNA : '0x0000000000000000000000000000000000000000';
  if (snap.dependents.connectivity.boundAsBandwidthRouter) call('P', 'migrator', M, NEW, LEDGER_ABI, 'setBandwidthRouter', [CONNA], { label: 'ledger17.setBandwidthRouter (one-shot; live bandwidth billing is bound)' });
  const indep = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/deployments/independent-authorities-base.json'), 'utf8')).inputs;
  const FAC = create('P', 'deploy PinnedSessionVaultFactory (verified source; linked: live SessionVaultLib)', ctor(PIN.contracts.PinnedSessionVaultFactory.abi,
    link(PIN.contracts.PinnedSessionVaultFactory.bytecode.object, PIN.contracts.PinnedSessionVaultFactory.bytecode.linkReferences, { SessionVaultLib: PINLIB }),
    [indep.usdc, NEW, indep.catalog, indep.router, indep.keyAttestations, BigInt(indep.maxVault6)]));
  const AUTH = getContractAddress({ from: FAC, nonce: 1n }), IMPL = getContractAddress({ from: FAC, nonce: 2n });
  const SV2 = create('P', 'deploy EnclaveSecretVaultV2 (verified source; hostOwnership KEPT)', ctor(PIN.contracts.EnclaveSecretVaultV2.abi, '0x' + PIN.contracts.EnclaveSecretVaultV2.bytecode.object,
    [AUTH, snap.dependents.secretVaultV2.enclaveOwner, snap.dependents.secretVaultV2.hostOwnership]));
  // owner parameters that differ from the constructor defaults (constructor: leaseSec 1800, maxGpuMilli 1000, maxFee 1389,
  // runnerBps 8000, claimBond 0 / 1 day, proofRequiredFrom = deploy time + 14 days; prover window 900)
  const DEF = { maxGpuMilli: 1000n, maxFeePerSec6: 1389n, runnerBps: 8000n, leaseSec: 1800n };
  for (const [g, s] of [['maxGpuMilli', 'setMaxGpuMilli'], ['maxFeePerSec6', 'setMaxFee'], ['runnerBps', 'setRunnerBps'], ['leaseSec', 'setLeaseSec']])
    if (BigInt(P[g]) !== DEF[g]) call('P', 'migrator', M, NEW, LEDGER_ABI, s, [BigInt(P[g])], { label: `${s}(${P[g]}) = live value` });
  call('P', 'migrator', M, NEW, LEDGER_ABI, 'setProofRequiredFrom', [BigInt(P.proofRequiredFrom)], { label: `setProofRequiredFrom(${P.proofRequiredFrom}) = live value` });
  if (BigInt(P.claimBond6) !== 0n || BigInt(P.bondExitDelay) !== 86400n) call('P', 'migrator', M, NEW, LEDGER_ABI, 'setClaimBond', [BigInt(P.claimBond6), BigInt(P.bondExitDelay)]);
  if (BigInt(snap.dependents.proofOfTime.proofWindowSec) !== 900n) call('P', 'migrator', M, PRF, PROVER, 'setProofWindow', [BigInt(snap.dependents.proofOfTime.proofWindowSec)]);

  // G1 retire (REQUIRED gates listed; G4 in lib/gates.mjs)
  call('G1', 'governance (old ledger owner)', GOV, OLD, LEDGER_ABI, 'retire', [], { irreversible: true, targetCodeHash: snap.code.deployments.codeHash,
    preconditions: ['P landed and `verify` shows code == predicted runtimes', 'a replay of a snapshot taken after P passes',
      'continuity gate: every stranded-escrow record is served out (stage C) or its loss is an explicit reviewed choice',
      'client readiness attested by the CLI and supervisor owners', 'the reviewed replay proves admin ownership and administrative operations remain available'] });
  // I tail (the import batches themselves are generated from snapshot F after G1: stage I in replay.mjs / the CLI)
  const iTail = [];
  iTail.push(() => call('I', 'migrator', M, NEW, LEDGER_ABI, 'sealImports', [], { irreversible: true, preconditions: ['parity(F, ledger17) has zero differences'] }));
  iTail.push(() => call('I', 'migrator', M, NEW, LEDGER_ABI, 'setOwner', [GOV]));
  iTail.push(() => call('I', 'migrator', M, PRF, PROVER, 'transferOwnership', [GOV]));
  const g2 = [() => call('G2', 'governance', GOV, NEW, LEDGER_ABI, 'acceptOwnership', []), () => call('G2', 'governance', GOV, PRF, PROVER, 'acceptOwnership', []),
    () => call('G2', 'book owner', getAddress(snap.book.owner), BOOK_ADDR, BOOK, 'setMany', [['deployments', 'proofOfTime', 'verificationFees', 'connectivity'].map((k) => stringToHex(k, { size: 32 })), [NEW, PRF, FEES, CONNA]])];

  // Predict reviewed runtime hashes. Governance remains with GOV after G2; no ownership sink is installed.
  const imm = v1.checks.code.ledger17.immutables, immById = Object.fromEntries(Object.entries(imm).map(([id, v]) => [id, lc(v) === lc(P.usdc) ? P.usdc : P.registry]));
  const ledgerRuntime = predictRuntime(L17.contracts.EnclaveDeployments.deployedBytecode, libs, immById);
  const pn = Object.fromEntries(Object.entries(PROOF.immutableNames).map(([id, name]) => [id, name === 'EnclaveProofOfTime.deployments' ? NEW : P.registry]));
  const proverRuntime = predictRuntime(PROOF.deployedBytecode, {}, pn);
  return { txs, iTail, g2, nextNonce: () => n, setNonce: (v) => { n = v; }, M, GOV, OLD, BOOK_ADDR,
    addresses: { EnclaveLedgerBandwidth: BW, EnclaveLeaseGeneration: GEN, ledger17: NEW, proofOfTime17: PRF, verificationFees17: FEES, connectivity17: CONNA,
      pinnedSessionVaultFactory17: FAC, pinnedSessionAuthority17: AUTH, sessionVaultImplementation17: IMPL, sessionVaultLib: PINLIB, secretVaultV2_17: SV2,
      hostOwnership: getAddress(snap.dependents.secretVaultV2.hostOwnership) },
    predicted: { ledgerRuntimeCodeHash: keccak256(ledgerRuntime), proverRuntimeCodeHash: keccak256(proverRuntime) },
    governancePolicy: 'enclave-admin-retained/v1' };
}

export { escrowStages, strandedAtRetire, planImport };

// ---- the written plan: static phases + the replay's actual dynamic stages and gas ----
const ORACLE = '0x420000000000000000000000000000000000000F';
const ORACLE_ABI = parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)']);
export function assertAdminRetainedReplay(rep, expectedAdmin) {
  if (rep.result !== 'pass' || rep.governancePolicy !== 'enclave-admin-retained/v1' || rep.checks?.adminRetained?.verified !== true)
    throw Error('a successful admin-retaining replay is required; old governance-seal reports are superseded');
  const proof=rep.checks.adminRetained;
  if (!/^0x[0-9a-f]{40}$/i.test(expectedAdmin || '') || /^0x0{40}$/i.test(expectedAdmin)) throw Error('expected admin required');
  for(const key of ['ledgerOwner','proverOwner']) if(lc(proof[key])!==lc(expectedAdmin))throw Error('admin ownership mismatch');
  for(const key of ['ledgerPendingOwner','proverPendingOwner']) if(!/^0x0{40}$/i.test(proof[key]||''))throw Error('pending admin removal');
  for(const key of ['ledger.setLeaseSec','ledger.setPayout','ledger.retire (simulation only)','prover.setProofWindow'])
    if(proof.operations?.[key]?.adminAccepted!==true || proof.operations?.[key]?.outsiderRejected!==true)throw Error('missing admin operation proof: '+key);
  if (!Array.isArray(rep.executed) || !rep.executed.length || rep.executed.some(t => t.phase === 'X' || /GovernanceSeal|seal\(\)|ownership.*sink/i.test(t.label || '')))
    throw Error('admin-removal transactions are forbidden in the migration plan');
  const transfers=['setOwner(address)','transferOwnership(address)'].map(toFunctionSelector);
  const accept=toFunctionSelector('acceptOwnership()'), renounce=toFunctionSelector('renounceOwnership()');
  const targets=[rep.addresses?.ledger17,rep.addresses?.proofOfTime17];
  for(const target of targets) {
    if(!/^0x[0-9a-f]{40}$/i.test(target||''))throw Error('missing migration target');
    if(!rep.executed.some(t=>lc(t.to)===lc(target)&&lc(t.data)===accept&&lc(t.signer?.address)===lc(expectedAdmin)))
      throw Error('admin ownership acceptance missing');
  }
  for(const tx of rep.executed){
    if(!tx.to)continue; // constructor bytes are not function calls
    const data=lc(tx.data), selector=data.slice(0,10);
    if(selector===renounce)throw Error('ownership renunciation forbidden');
    if(transfers.includes(selector) && (data.length!==74 || data.slice(10,34)!=='0'.repeat(24) || '0x'+data.slice(34)!==lc(expectedAdmin)))
      throw Error('ownership transfer must retain the admin wallet');
    if(targets.some(a=>lc(a)===lc(tx.to))&&selector===accept&&lc(tx.signer?.address)!==lc(expectedAdmin))
      throw Error('only the admin wallet may accept ownership');
  }
}

export async function writePlan2({ snapshotFile, replayFile }) {
  const scopeReview = JSON.parse(fs.readFileSync(path.join(HERE, 'scope-review.json'), 'utf8'));
  if (scopeReview.walletPlanGenerationAllowed !== true || scopeReview.status !== 'reviewed-separate-contract-change') {
    throw Error('Contract scope review: ledger17 is not a Nan-retirement prerequisite; wallet plan generation is disabled pending a separately justified contract change.');
  }
  const { agree } = await import('./lib/live.mjs');
  const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')), rep = JSON.parse(fs.readFileSync(replayFile, 'utf8'));
  assertAdminRetainedReplay(rep, snap.ledger.params.owner);
  if (rep.snapshot.digest !== snap.digest) throw Error('the replay ran on another snapshot');
  const blockTag = '0x' + BigInt(snap.block.number).toString(16), base = BigInt(snap.block.baseFeePerGas), tip = 1_000_000n;
  const txs = rep.executed.map((t) => ({ ...t }));
  for (const t of txs) {
    const size = t.data ? (t.data.length - 2) / 2 + 120 : null;
    t.l1FeeUpperWei = size ? BigInt(await agree('eth_call', [{ to: ORACLE, data: encodeFunctionData({ abi: ORACLE_ABI, functionName: 'getL1FeeUpperBound', args: [BigInt(size)] }) }, blockTag])).toString() : null;
    t.gasLimit = t.gasUsed ? (BigInt(t.gasUsed) * 13n / 10n).toString() : null;
    t.ethUpperWei = t.gasUsed && t.l1FeeUpperWei ? (BigInt(t.gasUsed) * 13n / 10n * (base + tip) + BigInt(t.l1FeeUpperWei)).toString() : null;
  }
  const bySigner = {};
  for (const t of txs) { const k = `${t.signer.role} ${t.signer.address || ''}`.trim(); const s = (bySigner[k] ||= { txs: 0, ethUpperWei: 0n, unknownCost: 0, usdc6: 0n, irreversible: 0 });
    s.txs++; if (t.ethUpperWei) s.ethUpperWei += BigInt(t.ethUpperWei); else s.unknownCost++; if (/approve/.test(t.label)) s.usdc6 += BigInt(t.usdc6 || 0); if (t.irreversible) s.irreversible++; }
  const plan = J({ kind: 'enclave.ledger17.unsigned-plan', version: 3, governancePolicy: 'enclave-admin-retained/v1', chainId: 8453, signedHere: false, sentHere: false,
    snapshot: { file: path.basename(snapshotFile), digest: snap.digest, block: snap.block }, replay: { file: path.basename(replayFile), result: rep.result }, admin: snap.ledger.params.owner, adminControls: rep.checks.adminRetained,
    migrator: rep.migrator, addresses: rep.addresses, predicted: rep.predicted,
    costModel: { baseFeePerGasAtSnapshot: base, tipWei: tip, l1: 'GasPriceOracle.getL1FeeUpperBound at the snapshot block', gasLimit: '1.3x the replay gasUsed',
      note: 'every transaction below was EXECUTED in the replay; its gas is measured. Import batches and escrow stages are regenerated from chain state at execution (snapshot F / post-lapse); their replay values are shown.' },
    totalsBySigner: bySigner, completeness: { decentralizationComplete: false, migrationComplete: false, why: rep.completion },
    continuity: rep.continuity, stranded: rep.stranded, ownerCarry: { unsupported: rep.ownerCarryUnsupported, notes: rep.ownerCarryNotes }, globalPowers: rep.globalPowers,
    transactions: txs });
  const text = JSON.stringify(plan, null, 1) + '\n';
  const file = path.join(HERE, 'plans', `${snap.block.number}.plan2.json`);
  fs.writeFileSync(file, text);
  return { file, sha256: createHash('sha256').update(text).digest('hex'), plan };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  writePlan2({ snapshotFile: arg('--snapshot'), replayFile: arg('--replay') }).then(({ file, sha256, plan }) =>
    console.log(JSON.stringify({ file, sha256, txs: plan.transactions.length, totalsBySigner: plan.totalsBySigner }, null, 1)), (e) => { console.error('plan2 refused: ' + e.message); process.exitCode = 1; });
}
