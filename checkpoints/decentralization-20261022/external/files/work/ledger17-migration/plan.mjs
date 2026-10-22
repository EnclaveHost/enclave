// plan: the UNSIGNED rev-17 cutover for later owner signing on Base (chain 8453). Nothing is signed or sent.
// Inputs: a live snapshot, the builds, the passing rehearsal of the same block, and the migrator address the owners
// choose (its live nonce at the snapshot block predicts every new contract address, as independent-authorities.mjs does).
// Output: plans/<block>.plan.json, with every tx's signer role, to, data, value, chainId, the target's expected code
// hash, preconditions, irreversible flag, rehearsal gas, and the ETH cost at the snapshot base fee plus the L1 data-fee
// upper bound read from Base's GasPriceOracle. USDC amounts come from the snapshot (forked in the rehearsal).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeFunctionData, encodeAbiParameters, getContractAddress, getAddress, keccak256, stringToHex, parseAbi, decodeFunctionResult } from 'viem';
import { HERE, LEDGER_ABI, ERC20, BOOK, PROVER } from './lib/abis.mjs';
import { agree } from './lib/live.mjs';
import { planImport } from './lib/ledgerstate.mjs';

const B = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'build', n + '.json'), 'utf8'));
const J = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const lc = (a) => String(a).toLowerCase();
const link = (obj, refs, libs) => { let o = obj.replace(/^0x/, ''); for (const l of Object.values(refs || {})) for (const [lib, places] of Object.entries(l))
  for (const { start, length } of places) o = o.slice(0, start * 2) + libs[lib].slice(2).toLowerCase() + o.slice((start + length) * 2); return '0x' + o; };
const ctor = (abi, bytecode, args) => { const c = abi.find((x) => x.type === 'constructor'); return c ? bytecode + encodeAbiParameters(c.inputs, args).slice(2) : bytecode; };
const ORACLE = '0x420000000000000000000000000000000000000F';
const ORACLE_ABI = parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)']);
const PRIORITY_WEI = 1_000_000n;   // 0.001 gwei tip, Base's typical floor; stated, not hidden

export async function makePlan({ snapshotFile, rehearsalFile, migrator }) {
  throw Error('legacy admin-removal workflow superseded: use the admin-retaining replay and plan2 commands; historical evidence is preserved');
  const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')), reh = JSON.parse(fs.readFileSync(rehearsalFile, 'utf8'));
  if (reh.result !== 'pass') throw Error('plan refused: the rehearsal of this block did not pass');
  if (reh.snapshot.digest !== snap.digest) throw Error('plan refused: the rehearsal was run on another snapshot');
  const blockTag = '0x' + BigInt(snap.block.number).toString(16);
  const P = snap.ledger.params, OLD = getAddress(snap.ledger.address), GOV = getAddress(P.owner), PAYOUT = getAddress(P.payout);
  const BOOK_ADDR = getAddress(snap.book.address), BOOK_OWNER = getAddress(snap.book.owner);
  const M = getAddress(migrator);
  const nonce = Number(await agree('eth_getTransactionCount', [M, blockTag]));
  const L17 = B('ledger17'), PROOF = B('proofOfTime'), FEESB = B('verificationFees'), CONN = B('connectivity'), PIN = B('pinned'), SEAL = B('governanceSeal');
  const gasOf = (re) => { const s = reh.steps.find((x) => re.test(x.label)); return s ? BigInt(s.gasUsed) : null; };
  const txs = [];
  let n = nonce;
  const add = (t) => { txs.push({ chainId: 8453, value: '0', ...t }); return t; };
  const create = (label, data, gasRe) => { const address = getContractAddress({ from: M, nonce: BigInt(n) });
    add({ phase: 'P prebuild', signer: { role: 'migrator', address: M, nonce: n++ }, to: null, data, creates: address, label, irreversible: false, gasRehearsal: gasOf(gasRe) }); return address; };
  const call = (phase, signerRole, signer, to, abi, fn, args, extra = {}) => add({ phase, signer: { role: signerRole, address: signer, ...(signerRole === 'migrator' ? { nonce: n++ } : {}) }, to,
    data: encodeFunctionData({ abi, functionName: fn, args }), label: extra.label || fn, irreversible: !!extra.irreversible, gasRehearsal: extra.gas ?? null, ...extra });

  // ---- P: prebuild (migrator). Reversible: nothing live points at any of it until the book and pins change. ----
  const BW = getAddress(L17.reuseLiveBandwidthLibrary.address), PINLIB = getAddress(PIN.proof.liveRuntimesMatch.SessionVaultLib.address);
  const GEN = create('deploy EnclaveLeaseGeneration (linked: live EnclaveLedgerBandwidth)', link(L17.contracts.EnclaveLeaseGeneration.bytecode.object, L17.contracts.EnclaveLeaseGeneration.bytecode.linkReferences, { EnclaveLedgerBandwidth: BW }), /deploy EnclaveLeaseGeneration/);
  const NEW = create('deploy EnclaveDeployments rev 17', ctor(L17.contracts.EnclaveDeployments.abi, link(L17.contracts.EnclaveDeployments.bytecode.object, L17.contracts.EnclaveDeployments.bytecode.linkReferences,
    { EnclaveLedgerBandwidth: BW, EnclaveLeaseGeneration: GEN }), [P.usdc, P.payout, P.registry, P.ethUsdFeed]), /deploy EnclaveDeployments rev 17/);
  const PRF = create('deploy EnclaveProofOfTime (verified build proof-of-time)', ctor(PROOF.abi, '0x' + PROOF.bytecode.object, [NEW, P.registry]), /deploy EnclaveProofOfTime/);
  call('P prebuild', 'migrator', M, NEW, LEDGER_ABI, 'setProver', [PRF], { label: 'ledger17.setProver (one-shot; before the fee router, whose constructor checks it)', gas: gasOf(/setProver/) });
  const FEES = create('deploy EnclaveVerificationFees (verified build verification-fees)', ctor(FEESB.abi, '0x' + FEESB.bytecode.object, [NEW, PRF]), /deploy EnclaveVerificationFees/);
  call('P prebuild', 'migrator', M, NEW, LEDGER_ABI, 'setFeeRouter', [FEES], { label: 'ledger17.setFeeRouter (one-shot)', gas: gasOf(/setFeeRouter/) });
  const CONNA = create('deploy EnclaveConnectivity (verified build connectivity; live bootstrap signers)', ctor(CONN.abi, '0x' + CONN.bytecode.object, [NEW, CONN.proof.liveConstructorArgs[1]]), /deploy EnclaveConnectivity/);
  if (snap.dependents.connectivity.boundAsBandwidthRouter)
    call('P prebuild', 'migrator', M, NEW, LEDGER_ABI, 'setBandwidthRouter', [CONNA], { label: 'ledger17.setBandwidthRouter (one-shot; live has bandwidth billing bound)', gas: gasOf(/setBandwidthRouter/) });
  const indep = JSON.parse(fs.readFileSync(path.join(HERE, '../enclave/contracts/deployments/independent-authorities-base.json'), 'utf8')).inputs;
  const FAC = create('deploy PinnedSessionVaultFactory (verified source; linked: live SessionVaultLib)', ctor(PIN.contracts.PinnedSessionVaultFactory.abi,
    link(PIN.contracts.PinnedSessionVaultFactory.bytecode.object, PIN.contracts.PinnedSessionVaultFactory.bytecode.linkReferences, { SessionVaultLib: PINLIB }),
    [indep.usdc, NEW, indep.catalog, indep.router, indep.keyAttestations, BigInt(indep.maxVault6)]), /deploy PinnedSessionVaultFactory/);
  const AUTH = getContractAddress({ from: FAC, nonce: 1n }), IMPL = getContractAddress({ from: FAC, nonce: 2n });
  const SV2 = create('deploy EnclaveSecretVaultV2 (verified source; book = new PinnedSessionAuthority; hostOwnership KEPT)', ctor(PIN.contracts.EnclaveSecretVaultV2.abi,
    '0x' + PIN.contracts.EnclaveSecretVaultV2.bytecode.object, [AUTH, snap.dependents.secretVaultV2.enclaveOwner, snap.dependents.secretVaultV2.hostOwnership]), /deploy EnclaveSecretVaultV2/);
  // owner parameters that differ from the constructor defaults (the rehearsal recorded which setters it needed)
  for (const s of reh.steps.filter((x) => /^(setMaxGpuMilli|setMaxFee|setRunnerBps|setLeaseSec|setProofRequiredFrom|setClaimBond|setProofWindow)/.test(x.label))) {
    const [fn, arg] = [s.label.split('(')[0], s.label.match(/\((.*)\)/)?.[1]];
    if (fn === 'setProofWindow') call('P prebuild', 'migrator', M, PRF, PROVER, fn, [BigInt(arg)], { label: s.label, gas: BigInt(s.gasUsed) });
    else if (fn === 'setClaimBond') call('P prebuild', 'migrator', M, NEW, LEDGER_ABI, fn, [BigInt(P.claimBond6), BigInt(P.bondExitDelay)], { label: s.label, gas: BigInt(s.gasUsed) });
    else call('P prebuild', 'migrator', M, NEW, LEDGER_ABI, fn, [BigInt(arg)], { label: `${fn}(${arg}) = live value`, gas: BigInt(s.gasUsed) });
  }

  // ---- G1: governance retires the old ledger. IRREVERSIBLE. Gate G4 must hold. ----
  call('G1 retire', 'governance (old ledger owner)', GOV, OLD, LEDGER_ABI, 'retire', [], { irreversible: true, gas: gasOf(/OLD\.retire/),
    preconditions: ['G4: every P transaction landed and `migrate-ledger-17 verify` reports code == verified builds and bindings set',
      'a rehearsal of a snapshot taken AFTER P landed passes', 'client readiness attested (supervisor follows the book and reads rev 17; CLI pins updated)',
      'payout holds the USDC for phase B (below) or accepts that records stay under-backed until it does'],
    effect: 'claim, renew and every funding on the OLD ledger refuse; release, settle, owner edits and (now permissionless) refund still work there' });

  // ---- I: the final import from snapshot F (taken after G1). Calldata is regenerated at F; shown here from this snapshot. ----
  const imports = planImport(snap.ledger.records, []);
  for (const t of imports) add({ phase: 'I import', signer: { role: 'migrator', address: M, nonce: n++ }, to: NEW, data: t.data, label: t.label + ' (TEMPLATE from this snapshot: regenerated from snapshot F after G1)',
    irreversible: false, template: true, gasRehearsal: BigInt(t.gasModel), preconditions: ['old.retired() == true (assertCanImport)', 'snapshot F taken after G1; calldata regenerated from it'] });
  call('I import', 'migrator', M, NEW, LEDGER_ABI, 'sealImports', [], { irreversible: true, gas: gasOf(/sealImports/), preconditions: ['parity(F, ledger17) has zero differences (assertCanSeal)'] });
  call('I import', 'migrator', M, NEW, LEDGER_ABI, 'setOwner', [GOV], { gas: gasOf(/^setOwner/) });
  call('I import', 'migrator', M, PRF, PROVER, 'transferOwnership', [GOV], { gas: gasOf(/prover\.transferOwnership/) });

  // ---- G2: governance accepts and repoints the book ----
  call('G2 handoff+repoint', 'governance', GOV, NEW, LEDGER_ABI, 'acceptOwnership', [], { gas: gasOf(/governance accepts ledger17/) });
  call('G2 handoff+repoint', 'governance', GOV, PRF, PROVER, 'acceptOwnership', [], { gas: gasOf(/governance accepts prover17/) });
  const keys = ['deployments', 'proofOfTime', 'verificationFees', 'connectivity'].map((k) => stringToHex(k, { size: 32 }));
  call('G2 handoff+repoint', 'book owner', BOOK_OWNER, BOOK_ADDR, BOOK, 'setMany', [keys, [NEW, PRF, FEES, CONNA]], { gas: gasOf(/book\.setMany/),
    effect: 'reviews/hostReviews/credit vaults/legacy session vaults/book-bound secret vault resolve ledger17; independent clients move only by their own reviewed pin change' });

  const rows = reh.checks.conservationRows || [];
  // ---- advisory before G1: escrow that retirement would strand (non-owner escrow behind a still-fundable balance) ----
  const stuck = rows.filter((r) => BigInt(r.stuck6) > 0n);
  for (const r of stuck) { const d = snap.ledger.records.find((x) => lc(x.id) === lc(r.id)); const r6 = BigInt(d?.earn.rate6 || 0);
    add({ phase: 'A advisory (before G1)', signer: { role: 'none: an operational choice' }, to: null, label: `record ${r.id.slice(0, 10)}: ${r.stuck6} escrow becomes unrecoverable at retirement`,
      irreversible: false, advisory: true, usdc6: r.stuck6, owner: r.owner,
      options: [`serve it out on the OLD ledger before G1: about ${r6 > 0n ? (BigInt(r.stuck6) / r6).toString() : '?'} s of runtime at its runner rate converts it into earned runner payment`,
        'or accept it as a platform loss (it is the platform deployer\'s own non-refundable fundEscrow; no third party loses)'] }); }

  // ---- R/S/B: escrow conservation (amounts from the snapshot, forked and lapsed in the rehearsal) ----
  const maxUntil = snap.ledger.records.reduce((m, d) => (BigInt(d.leaseUntil) > m ? BigInt(d.leaseUntil) : m), 0n);
  const notBefore = `max(retire time, ${maxUntil}) + leaseSec(${P.leaseSec}) + proofWindow(${snap.dependents.proofOfTime.proofWindowSec}) - every old lease lapsed and provable time passed`;
  const settleIds = rows.filter((x) => BigInt(x.escrow6) > 0n).map((r) => r.id), pushRows = rows.filter((x) => BigInt(x.refundToOwner6) > 0n);
  if (settleIds.length) call('R old settle', 'anyone', 'any account', OLD, LEDGER_ABI, 'multicall', [settleIds.map((id) => encodeFunctionData({ abi: LEDGER_ABI, functionName: 'settle', args: [id] }))],
    { label: `settle x${settleIds.length} (one multicall)`, notBefore, gas: gasOf(/^settle x/) });
  if (pushRows.length) call('R old refund push', 'anyone (each refund is paid to its record owner)', 'any account', OLD, LEDGER_ABI, 'multicall', [pushRows.map((r) => encodeFunctionData({ abi: LEDGER_ABI, functionName: 'refund', args: [r.id] }))],
    { label: `refund push x${pushRows.length} (one multicall)`, notBefore, gas: gasOf(/^refund push x/), usdc6: pushRows.reduce((a, r) => a + BigInt(r.refundToOwner6), 0n),
      payees: pushRows.map((r) => ({ id: r.id, owner: r.owner, usdc6: r.refundToOwner6 })), note: 'amounts = refundableOf at execution; the rehearsal values of this snapshot are shown' });
  for (const r of rows.filter((x) => BigInt(x.sweepToPayout6) > 0n)) call('S old sweep', 'governance (old ledger owner)', GOV, OLD, LEDGER_ABI, 'sweepEscrow', [r.id],
    { notBefore, usdc6: r.sweepToPayout6, payee: PAYOUT, gas: gasOf(/sweepEscrow/) });
  const backs = reh.checks.backingSent || [];
  const backTotal = backs.reduce((a, r) => a + BigInt(r.amount6), 0n);
  if (backTotal > 0n) {
    call('B new backing', 'payout', PAYOUT, P.usdc, ERC20, 'approve', [NEW, backTotal], { usdc6: backTotal, preconditions: ['ledger17.importsSealed() == true (assertCanBack)'] });
    for (const r of backs) call('B new backing', 'payout', PAYOUT, NEW, LEDGER_ABI, 'fundEscrow', [r.id, BigInt(r.amount6)], { usdc6: r.amount6, gas: gasOf(/payout fundEscrow/) });
  }

  // ---- W: wallet actions (each party's own wallet; none needs Enclave; amounts from the snapshot) ----
  const FEE_ABI = parseAbi(['function revoke(bytes32 source)']);
  const feeCheck = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'rehearsal', `fee-wallets-${snap.block.number}.json`), 'utf8')); } catch { return null; } })();
  for (const w of snap.feeWallets) call('W wallet actions', 'fee payer (its own wallet)', getAddress(w.payer), snap.dependents.verificationFees.address, FEE_ABI, 'revoke', [w.source],
    { label: `old fee router revoke(${w.source.slice(0, 10)}): wallet ${w.wallet} returns ${w.usdc6} to the ledger payout`, usdc6: w.usdc6, payee: PAYOUT,
      gas: feeCheck ? BigInt(feeCheck.wallets.find((x) => x.wallet === w.wallet)?.gasUsed || 0) || null : null, note: 'fork-checked: test/fork-fee-wallets.mjs (also after retire)' });
  for (const h of snap.ledger.holders.filter((x) => BigInt(x.earned6) > 0n)) call('W wallet actions', 'operator (its own wallet)', getAddress(h.address), OLD, LEDGER_ABI, 'withdrawEarnings', [getAddress(h.address)],
    { label: `withdraw ${h.earned6}+ earned on the OLD ledger (anytime; never migrates, so never paid twice)`, usdc6: h.earned6, gas: gasOf(/withdraws .* on the OLD ledger/) });
  for (const r of rows.filter((x) => BigInt(x.refundToOwner6) > 0n)) {
    const o = snap.owners.find((x) => x.address === lc(r.owner));
    if (o?.contract) add({ phase: 'W wallet actions', signer: { role: `${o.kind} owner (its own signature)`, address: o.ownerOf || null }, to: r.owner,
      label: `${o.kind} ${r.owner}: the refund push paid it ${r.refundToOwner6}; its owner withdraws through the vault's own signed operation (withdraw(amount, opNonce, signBefore, sig))`, irreversible: false, usdc6: r.refundToOwner6 });
    else add({ phase: 'W wallet actions', signer: { role: 'record owner (optional)', address: getAddress(r.owner) }, to: P.usdc + ' then ' + NEW,
      label: `optional: approve + fundEscrow on ledger17 up to the ${r.refundToOwner6} refunded, onto an active record of this owner (credited as its own refundable escrow)`, irreversible: false, usdc6: r.refundToOwner6,
      note: 'rehearsed: checks.ownerReback' });
  }

  // ---- X: optional, IRREVERSIBLE governance seal of ledger17 and prover17 (Enclave admin powers end) ----
  add({ phase: 'X seal (optional)', signer: { role: 'anyone' }, to: null, label: 'deploy GovernanceSeal(ledger17, full getter set, configuration hash at sealing time) - built from main contracts/GovernanceSeal.sol',
    irreversible: false, gasRehearsal: gasOf(/deploy GovernanceSeal\(ledger17\)/), dataNote: 'computed at sealing time (the hash commits to the then-current getters)' });
  add({ phase: 'X seal (optional)', signer: { role: 'governance', address: GOV }, to: NEW, label: 'ledger17.setOwner(<seal address>) - calldata generated at sealing time', irreversible: false, template: true, gasRehearsal: gasOf(/nominates the seal for ledger17/) });
  add({ phase: 'X seal (optional)', signer: { role: 'anyone' }, to: '<seal>', label: 'seal() [IRREVERSIBLE]: leaseSec, fees caps, runnerBps, bond, ETH feed, payout, retire, sweep, slash all end', irreversible: true, gasRehearsal: gasOf(/seal\(\) ledger17/) });

  // ---- costs: rehearsal gas x snapshot base fee + L1 data upper bound ----
  const base = BigInt(snap.block.baseFeePerGas);
  for (const t of txs) {
    const gas = t.gasRehearsal != null ? BigInt(t.gasRehearsal) : null;
    const size = t.data ? (t.data.length - 2) / 2 + 120 : 200;
    const l1 = BigInt(await agree('eth_call', [{ to: ORACLE, data: encodeFunctionData({ abi: ORACLE_ABI, functionName: 'getL1FeeUpperBound', args: [BigInt(size)] }) }, blockTag]));
    t.gasLimit = gas ? (gas * 13n) / 10n : null;
    t.ethCostUpperWei = gas ? gas * (base + PRIORITY_WEI) * 13n / 10n + l1 : null;
    if (t.to && lc(t.to) === lc(OLD)) t.targetCodeHash = snap.code.deployments.codeHash;
    if (t.to && lc(t.to) === lc(BOOK_ADDR)) t.targetCodeHash = snap.code.addressBook.codeHash;
    if (t.to && lc(t.to) === lc(P.usdc)) t.targetCodeHash = snap.code.usdc.codeHash;
    if (t.creates || (t.to && [NEW, PRF, FEES, CONNA].map(lc).includes(lc(t.to)))) t.targetCodeHash = 'the verified build with the addresses above (migrate-ledger-17 verify)';
  }
  const bySigner = {};
  for (const t of txs) { const k = t.signer.role + ' ' + (t.signer.address || ''); const s = (bySigner[k] ||= { txs: 0, ethUpperWei: 0n, usdc6: 0n, irreversible: 0 });
    s.txs++; s.ethUpperWei += BigInt(t.ethCostUpperWei || 0); if (/approve/.test(t.label)) s.usdc6 += BigInt(t.usdc6 || 0); if (t.irreversible) s.irreversible++; }
  const plan = J({ kind: 'enclave.ledger17.unsigned-plan', version: 1, chainId: 8453, network: 'base', signedHere: false, sentHere: false,
    snapshot: { file: path.basename(snapshotFile), digest: snap.digest, block: snap.block }, rehearsal: { file: path.basename(rehearsalFile), result: reh.result },
    migrator: { address: M, nonceAtSnapshot: nonce, note: 'any account the owners choose; every predicted address below depends on it and this nonce' },
    addresses: { EnclaveLedgerBandwidth: BW + ' (live, reused)', EnclaveLeaseGeneration: GEN, ledger17: NEW, proofOfTime17: PRF, verificationFees17: FEES, connectivity17: CONNA,
      pinnedSessionVaultFactory17: FAC, pinnedSessionAuthority17: AUTH, sessionVaultImplementation17: IMPL, sessionVaultLib: PINLIB + ' (live, reused)', secretVaultV2_17: SV2,
      hostOwnership: snap.dependents.secretVaultV2.hostOwnership + ' (live, kept)' },
    fees: { baseFeePerGasAtSnapshot: base, priorityWei: PRIORITY_WEI, l1: 'GasPriceOracle.getL1FeeUpperBound at the snapshot block', margin: '1.3x gas' },
    totalsBySigner: bySigner, usdc: { platformBacking6: backTotal, refundsToOwners6: rows.reduce((a, r) => a + BigInt(r.refundToOwner6), 0n),
      sweptToPayout6: rows.reduce((a, r) => a + BigInt(r.sweepToPayout6), 0n), stuckOnOld6: rows.reduce((a, r) => a + BigInt(r.stuck6), 0n),
      newLedgerNeedsForFullBacking6: rows.reduce((a, r) => a + BigInt(r.newNeeds6), 0n) },
    transactions: txs });
  const text = JSON.stringify(plan, null, 1) + '\n';
  const file = path.join(HERE, 'plans', `${snap.block.number}.plan.json`);
  fs.writeFileSync(file, text);
  return { file, sha256: createHash('sha256').update(text).digest('hex'), plan };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  makePlan({ snapshotFile: arg('--snapshot'), rehearsalFile: arg('--rehearsal'), migrator: arg('--migrator') })
    .then(({ file, sha256, plan }) => console.log(JSON.stringify({ file, sha256, txs: plan.transactions.length, totalsBySigner: plan.totalsBySigner, usdc: plan.usdc }, null, 1)),
      (e) => { console.error('plan refused: ' + e.message); process.exitCode = 1; });
}
