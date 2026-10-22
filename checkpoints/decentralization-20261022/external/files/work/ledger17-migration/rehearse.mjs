// rehearse: execute the whole rev-17 cutover on a LOCAL anvil fork of Base at the snapshot block (gate G2), with
// fixture keys and node-local impersonation of the live owners, and check every gate, field, balance and authority.
// Writes rehearsal/<block>.json. Never touches a live endpoint except as the read-only fork source.
import fs from 'node:fs';
import path from 'node:path';
import { encodeFunctionData, encodeAbiParameters, getAddress, keccak256, stringToHex, decodeEventLog, getContractAddress } from 'viem';
import { HERE, REPO, LEDGER_ABI, ERC20, BOOK, PROVER, AUTHORITY, FACTORY, SECRET_V2, REGISTRY4, OWNABLE } from './lib/abis.mjs';
import { ForkNode, refuseLiveWrite } from './lib/fork.mjs';
import { readLedger, planImport, parity, drift, escrowConservation, prefixSlot } from './lib/ledgerstate.mjs';
import { assertCanRetire, assertCanImport, assertCanSeal, assertCanBack } from './lib/gates.mjs';

const lc = (a) => String(a).toLowerCase();
const J = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const B = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'build', n + '.json'), 'utf8'));
const link = (obj, refs, libs) => { let o = obj.replace(/^0x/, ''); for (const libsOf of Object.values(refs || {})) for (const [lib, places] of Object.entries(libsOf))
  for (const { start, length } of places) { if (!libs[lib]) throw Error('no address for library ' + lib); o = o.slice(0, start * 2) + libs[lib].slice(2).toLowerCase() + o.slice((start + length) * 2); }
  if (o.includes('__$')) throw Error('unlinked placeholder'); return '0x' + o; };
const ctorData = (art, bytecodeHex, args) => { const c = art.abi.find((x) => x.type === 'constructor'); return c ? bytecodeHex + encodeAbiParameters(c.inputs, args).slice(2) : bytecodeHex; };

/** Deployed runtime == artifact with links filled and immutables holding exactly `immutables` (id -> address/word). */
function verifyRuntime({ dep, code, libs = {}, immutables = null, self = null }) {
  let exp = link(dep.object, dep.linkReferences, libs).slice(2).toLowerCase(); let act = code.slice(2).toLowerCase();
  if (exp.length !== act.length) throw Error(`runtime length ${act.length / 2} != ${exp.length / 2}`);
  const seen = {};
  for (const [id, refs] of Object.entries(dep.immutableReferences || {})) for (const { start, length } of refs) {
    const v = act.slice(start * 2, (start + length) * 2); (seen[id] ||= new Set()).add(v);
    act = act.slice(0, start * 2) + '00'.repeat(length) + act.slice((start + length) * 2); exp = exp.slice(0, start * 2) + '00'.repeat(length) + exp.slice((start + length) * 2);
  }
  if (act !== exp) throw Error('runtime differs from the verified artifact outside its immutables');
  const values = Object.fromEntries(Object.entries(seen).map(([id, s]) => { if (s.size !== 1) throw Error('immutable occurrences disagree'); return [id, '0x' + [...s][0].slice(-40)]; }));
  if (immutables) for (const [id, want] of Object.entries(immutables)) if (lc(values[id]) !== lc(want)) throw Error(`immutable ${id} = ${values[id]}, expected ${want}`);
  if (self) { for (const v of Object.values(values)) if (lc(v) !== lc(self)) throw Error('library self-address immutable differs'); }
  return { runtimeBytes: code.length / 2 - 1, codeHash: keccak256(code), immutables: values };
}

export async function rehearse({ snapshotFile, log = console.error, clientReadiness = null }) {
  throw Error('legacy admin-removal workflow superseded: use the admin-retaining replay and plan2 commands; historical evidence is preserved');
  const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const block = BigInt(snap.block.number), P = snap.ledger.params, OLD = getAddress(snap.ledger.address);
  const L17 = B('ledger17'), PROOF = B('proofOfTime'), FEESB = B('verificationFees'), CONN = B('connectivity'), PIN = B('pinned'), SEAL = B('governanceSeal');
  const report = { kind: 'enclave.ledger17.rehearsal', snapshot: { file: path.basename(snapshotFile), digest: snap.digest, block: snap.block },
    forkChainId: 31337, steps: [], checks: {}, negative: {} };
  const step = (r, extra = {}) => { report.steps.push(J({ label: r.label, status: r.status, gasUsed: r.gasUsed, to: r.to, contractAddress: r.contractAddress, ...extra })); log(`  ${r.status === 'success' ? '✓' : '✗'} ${r.label} ${r.gasUsed ?? ''}`); return r; };
  // G2 negative, before any node exists: a live endpoint is never a write target
  try { refuseLiveWrite(snap.endpoints.state[0]); report.negative.liveWriteRefused = false; } catch (e) { report.negative.liveWriteRefused = e.message; }

  const node = await ForkNode.start({ block, log, logFile: path.join(HERE, 'rehearsal', `anvil-${snap.block.number}.log`) });
  try {
    const M = node.account(0), ANYONE = node.account(1), NEWBIE = node.account(2);
    await node.raw('anvil_setBalance', [M.address, '0x56BC75E2D63100000']); await node.raw('anvil_setBalance', [ANYONE.address, '0x56BC75E2D63100000']);
    await node.raw('anvil_setBalance', [NEWBIE.address, '0x56BC75E2D63100000']);
    report.fork = { block: String(block), guard: { chainId: 31337, forkBlock: String(node.block), source: new URL(node.forkUrl).host } };
    if (keccak256(await node.pub.getCode({ address: OLD })) !== snap.code.deployments.codeHash) throw Error('fork ledger code differs from the snapshot');
    const GOV = getAddress(P.owner), PAYOUT = getAddress(P.payout), BOOK_ADDR = getAddress(snap.book.address), BOOK_OWNER = getAddress(snap.book.owner);
    const send = async (from, to, abi, fn, args = [], opts = {}) => step(await node.send({ from, to, data: encodeFunctionData({ abi, functionName: fn, args }), label: opts.label || `${fn}`, ...opts }), { to });
    const deploy = async (label, data, from = M) => step(await node.send({ from, data, label, gas: 29_000_000n }));

    // ---------------- 1. prebuild (migrator; reversible: nothing live depends on it) ----------------
    log('1. deploy + verify');
    const BW = getAddress(L17.reuseLiveBandwidthLibrary.address);   // the verified live EnclaveLedgerBandwidth, reused
    const gen = await deploy('deploy EnclaveLeaseGeneration', link(L17.contracts.EnclaveLeaseGeneration.bytecode.object, L17.contracts.EnclaveLeaseGeneration.bytecode.linkReferences, { EnclaveLedgerBandwidth: BW }));
    const libs = { EnclaveLedgerBandwidth: BW, EnclaveLeaseGeneration: gen.contractAddress };
    const ledgerArt = { abi: L17.contracts.EnclaveDeployments.abi };
    const led = await deploy('deploy EnclaveDeployments rev 17', ctorData(ledgerArt, link(L17.contracts.EnclaveDeployments.bytecode.object, L17.contracts.EnclaveDeployments.bytecode.linkReferences, libs),
      [P.usdc, P.payout, P.registry, P.ethUsdFeed]));
    const NEW = getAddress(led.contractAddress);
    const prf = await deploy('deploy EnclaveProofOfTime (verified build)', ctorData(PROOF, '0x' + PROOF.bytecode.object, [NEW, P.registry]));
    // ORDER: the fee router's constructor requires ledger.prover() == its proof (one-shot setProver first)
    await send(M, NEW, LEDGER_ABI, 'setProver', [prf.contractAddress], { label: 'ledger17.setProver(prover17) [one-shot]' });
    const fees = await deploy('deploy EnclaveVerificationFees (verified build)', ctorData(FEESB, '0x' + FEESB.bytecode.object, [NEW, prf.contractAddress]));
    const signers = CONN.proof.liveConstructorArgs[1];
    const conn = await deploy('deploy EnclaveConnectivity (verified build)', ctorData(CONN, '0x' + CONN.bytecode.object, [NEW, signers]));
    const PINLIB = getAddress(PIN.proof.liveRuntimesMatch.SessionVaultLib.address);   // the verified live SessionVaultLib, reused
    const indep = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/deployments/independent-authorities-base.json'), 'utf8')).inputs;
    const fac = await deploy('deploy PinnedSessionVaultFactory (verified source)', ctorData(PIN.contracts.PinnedSessionVaultFactory,
      link(PIN.contracts.PinnedSessionVaultFactory.bytecode.object, PIN.contracts.PinnedSessionVaultFactory.bytecode.linkReferences, { SessionVaultLib: PINLIB }),
      [indep.usdc, NEW, indep.catalog, indep.router, indep.keyAttestations, BigInt(indep.maxVault6)]));
    const AUTH = getContractAddress({ from: fac.contractAddress, nonce: 1n }), IMPL = getContractAddress({ from: fac.contractAddress, nonce: 2n });
    const HOSTOWN = getAddress(snap.dependents.secretVaultV2.hostOwnership);   // KEPT: registry-bound, holds host owners' authority
    const sv2 = await deploy('deploy EnclaveSecretVaultV2 (verified source)', ctorData(PIN.contracts.EnclaveSecretVaultV2, '0x' + PIN.contracts.EnclaveSecretVaultV2.bytecode.object,
      [AUTH, snap.dependents.secretVaultV2.enclaveOwner, HOSTOWN]));
    const addresses = { EnclaveLeaseGeneration: gen.contractAddress, EnclaveLedgerBandwidth: BW, ledger17: NEW, proofOfTime17: prf.contractAddress,
      verificationFees17: fees.contractAddress, connectivity17: conn.contractAddress, pinnedSessionVaultFactory17: fac.contractAddress,
      pinnedSessionAuthority17: AUTH, sessionVaultImplementation17: IMPL, sessionVaultLib: PINLIB, secretVaultV2_17: sv2.contractAddress, hostOwnership: HOSTOWN };
    report.addresses = addresses;
    // exact code verification of everything deployed
    const code = async (a) => node.pub.getCode({ address: a });
    const ids = (art) => Object.fromEntries(Object.entries(art.immutableNames || {}).map(([id, n]) => [n, id]));
    const v = {};
    v.EnclaveLeaseGeneration = verifyRuntime({ dep: L17.contracts.EnclaveLeaseGeneration.deployedBytecode, code: await code(gen.contractAddress), libs, self: gen.contractAddress });
    v.ledger17 = verifyRuntime({ dep: L17.contracts.EnclaveDeployments.deployedBytecode, code: await code(NEW), libs });
    if (!Object.values(v.ledger17.immutables).map(lc).sort().every((x, i, a) => a.length === 2) || !Object.values(v.ledger17.immutables).map(lc).includes(lc(P.usdc)) || !Object.values(v.ledger17.immutables).map(lc).includes(lc(P.registry)))
      throw Error('ledger17 immutables are not exactly usdc + registry');
    const ip = ids(PROOF), ifz = ids(FEESB), ic = ids(CONN);
    v.proofOfTime17 = verifyRuntime({ dep: PROOF.deployedBytecode, code: await code(prf.contractAddress), immutables: { [ip['EnclaveProofOfTime.deployments']]: NEW, [ip['EnclaveProofOfTime.registry']]: P.registry } });
    v.verificationFees17 = verifyRuntime({ dep: FEESB.deployedBytecode, code: await code(fees.contractAddress), immutables: { [ifz['EnclaveVerificationFees.ledger']]: NEW, [ifz['EnclaveVerificationFees.proof']]: prf.contractAddress, [ifz['EnclaveVerificationFees.token']]: P.usdc } });
    v.connectivity17 = verifyRuntime({ dep: CONN.deployedBytecode, code: await code(conn.contractAddress), immutables: { [ic['EnclaveConnectivity.ledger']]: NEW, [ic['EnclaveConnectivity.registry']]: P.registry } });
    const { verifyAuthorityRuntime } = await import(path.join(REPO, 'scripts/independent-authorities.mjs'));
    const plibs = { 'SessionVault.sol:SessionVaultLib': PINLIB };
    for (const [n, a] of [['PinnedSessionVaultFactory', fac.contractAddress], ['PinnedSessionAuthority', AUTH], ['SessionVault', IMPL], ['EnclaveSecretVaultV2', sv2.contractAddress]])
      v[n + '17'] = verifyAuthorityRuntime({ artifact: { evm: { deployedBytecode: PIN.contracts[n].deployedBytecode } }, code: await code(a), address: a, libraries: plibs });
    const bind = {
      authority: { deployments: await node.read(AUTH, AUTHORITY, 'deployments'), appCatalog: await node.read(AUTH, AUTHORITY, 'appCatalog'), sessionVaultFactory: await node.read(AUTH, AUTHORITY, 'sessionVaultFactory') },
      factory: { implementation: await node.read(fac.contractAddress, FACTORY, 'implementation') },
      secretVault: Object.fromEntries(await Promise.all(['book', 'enclaveOwner', 'hostOwnership', 'hostRegistry', 'deploymentLedger', 'sessionVaultFactory'].map(async (g) => [g, await node.read(sv2.contractAddress, SECRET_V2, g)]))),
    };
    const want = { authority: { deployments: NEW, appCatalog: indep.catalog, sessionVaultFactory: fac.contractAddress }, factory: { implementation: IMPL },
      secretVault: { book: AUTH, enclaveOwner: snap.dependents.secretVaultV2.enclaveOwner, hostOwnership: HOSTOWN, hostRegistry: P.registry, deploymentLedger: NEW, sessionVaultFactory: fac.contractAddress } };
    for (const [k, o] of Object.entries(want)) for (const [g, w] of Object.entries(o)) if (lc(bind[k][g]) !== lc(w)) throw Error(`${k}.${g} = ${bind[k][g]}, expected ${w}`);
    report.checks.code = J(v); report.checks.bindings = J(bind);

    // ---------------- 2. owner parameters + one-shot bindings (migrator, before any import) ----------------
    log('2. parameters + bindings');
    for (const [g, s] of [['maxGpuMilli', 'setMaxGpuMilli'], ['maxFeePerSec6', 'setMaxFee'], ['runnerBps', 'setRunnerBps'], ['leaseSec', 'setLeaseSec'], ['proofRequiredFrom', 'setProofRequiredFrom']])
      if (String(await node.read(NEW, LEDGER_ABI, g)) !== String(P[g])) await send(M, NEW, LEDGER_ABI, s, [BigInt(P[g])], { label: `${s}(${P[g]})` });
    if (String(await node.read(NEW, LEDGER_ABI, 'claimBond6')) !== String(P.claimBond6) || String(await node.read(NEW, LEDGER_ABI, 'bondExitDelay')) !== String(P.bondExitDelay))
      await send(M, NEW, LEDGER_ABI, 'setClaimBond', [BigInt(P.claimBond6), BigInt(P.bondExitDelay)]);
    if (String(await node.read(prf.contractAddress, PROVER, 'proofWindowSec')) !== String(snap.dependents.proofOfTime.proofWindowSec))
      await send(M, prf.contractAddress, PROVER, 'setProofWindow', [BigInt(snap.dependents.proofOfTime.proofWindowSec)]);
    if (lc(await node.read(NEW, LEDGER_ABI, 'prover')) !== lc(prf.contractAddress)) throw Error('prover not bound');
    await send(M, NEW, LEDGER_ABI, 'setFeeRouter', [fees.contractAddress]);
    if (snap.dependents.connectivity.boundAsBandwidthRouter) await send(M, NEW, LEDGER_ABI, 'setBandwidthRouter', [conn.contractAddress]);
    const PARAMS = ['payout', 'usdc', 'registry', 'ethUsdFeed', 'leaseSec', 'maxGpuMilli', 'maxFeePerSec6', 'runnerBps', 'claimBond6', 'bondExitDelay', 'proofRequiredFrom'];
    const pdiff = []; for (const g of PARAMS) if (lc(await node.read(NEW, LEDGER_ABI, g)) !== lc(P[g])) pdiff.push(g);
    if (pdiff.length) throw Error('parameters differ from live: ' + pdiff);
    report.checks.parameters = { equalToLive: PARAMS, prover: prf.contractAddress, feeRouter: fees.contractAddress, bandwidthRouter: snap.dependents.connectivity.boundAsBandwidthRouter ? conn.contractAddress : null };

    // ---------------- 3. the pre-retire race: the old ledger keeps changing until retire ----------------
    log('3. pre-retire race on the OLD ledger');
    const before = await readLedger(node, OLD);
    const active = before.find((d) => d.active && lc(d.owner) === lc(GOV));
    if (active) await send(GOV, OLD, LEDGER_ABI, 'setConfig', [active.id, '{"rehearsal":"pre-retire edit"}'], { label: 'owner edits a record on the OLD ledger before retire' });
    const created = await send(NEWBIE, OLD, LEDGER_ABI, 'create', ['catalog://rehearsal/0', 0, 100, 8080, '', true, '', '0x0000000000000000000000000000000000000000', 0n, 500n], { label: 'a new record is created on the OLD ledger before retire' });
    const nowTs = BigInt((await node.pub.getBlock()).timestamp);
    const live = before.filter((d) => BigInt(d.leaseUntil) > nowTs);
    report.checks.preRetire = { records: before.length, liveLeases: live.length, editedRecord: active?.id ?? null };

    // GATE G4: retirement only after every prerequisite is proven (client readiness is an input from its owners)
    const g4 = { codeVerified: true, parametersEqual: true, bindingsSet: true, rehearsalPassed: true, escrowPlan: true, clientReadiness: !!clientReadiness };
    // on Base the rehearsal result and the readiness file are inputs; here the gate is shown refusing without readiness
    try { assertCanRetire(g4); report.checks.retirementGate = { ...g4, verdict: 'would allow' }; }
    catch (e) { report.checks.retirementGate = { ...g4, verdict: e.message }; }
    // ---------------- 4. retire the old ledger (GOVERNANCE, irreversible on Base; impersonated here) ----------------
    log('4. retire');
    // negative first: an import is refused while the source is not retired (records could still change)
    try { assertCanImport({ sourceRetired: await node.read(OLD, LEDGER_ABI, 'retired') }); report.negative.importBeforeRetire = false; }
    catch (e) { report.negative.importBeforeRetire = e.message; }
    await send(GOV, OLD, LEDGER_ABI, 'retire', [], { label: 'OLD.retire() [governance, IRREVERSIBLE]' });
    const retiredAt = (await node.pub.getBlock()).timestamp;
    // what retire really closes: claim/renew/fund refuse; release/settle/owner edits still work
    const leased = live[0];
    if (leased) {
      report.negative.renewAfterRetire = await node.revertReason({ from: leased.runnerOperator, to: OLD, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'renew', args: [leased.id] }) });
    }

    // ---------------- 5. snapshot F + import (migrator), interrupted and resumed ----------------
    log('5. final snapshot F + import');
    assertCanImport({ sourceRetired: await node.read(OLD, LEDGER_ABI, 'retired') });
    const fBlock = await node.pub.getBlockNumber();
    const F = await readLedger(node, OLD, { blockNumber: fBlock });
    report.checks.F = { block: String(fBlock), records: F.length, digest: keccak256(stringToHex(JSON.stringify(J(F)))) };
    const plan1 = planImport(F, await readLedger(node, NEW));
    const cut = Math.max(1, Math.floor(plan1.length / 2));
    for (const t of plan1.slice(0, cut)) step(await node.send({ from: M, to: NEW, data: t.data, label: t.label + ' [first pass]' }), { to: NEW, gasModel: t.gasModel });
    // INTERRUPTED here; a seal attempt now must be refused by the parity gate
    const partial = parity(F, await readLedger(node, NEW));
    try { assertCanSeal(partial); report.negative.sealRefusedOnPartialImport = false; } catch (e) { report.negative.sealRefusedOnPartialImport = e.message; }
    // replay: re-sending a batch that already landed reverts (exists) and changes nothing
    const replay = await node.send({ from: M, to: NEW, data: plan1[0].data, label: 'replay of an already-landed import batch', expectRevert: true });
    report.negative.replayedImport = { status: replay.status, reason: await node.revertReason({ from: M, to: NEW, data: plan1[0].data }) };
    // RESUME: re-plan from the target's actual state
    const plan2 = planImport(F, await readLedger(node, NEW));
    for (const t of plan2) step(await node.send({ from: M, to: NEW, data: t.data, label: t.label + ' [resumed]' }), { to: NEW, gasModel: t.gasModel });
    const target = await readLedger(node, NEW);
    const prefix = {}; for (const d of F) prefix[lc(d.id)] = BigInt(await node.pub.getStorageAt({ address: NEW, slot: prefixSlot(d.id) })) === 1n;
    const par = parity(F, target, prefix);
    report.checks.importParity = { plannedFirst: plan1.length, sentFirst: cut, resumedWith: plan2.length, ...par, prefixReservations: Object.values(prefix).filter(Boolean).length };
    if (par.bad.length) throw Error('import parity failed: ' + JSON.stringify(par.bad.slice(0, 5)));
    if (planImport(F, target).length !== 0) throw Error('a complete import still plans transactions');

    // post-F drift on the old ledger (owner edits after F do not migrate; reported for owners to re-apply)
    const edit = F.find((d) => d.active && lc(d.owner) === lc(GOV) && d.id !== active?.id) || F.find((d) => lc(d.owner) === lc(GOV));
    await send(GOV, OLD, LEDGER_ABI, 'setConfig', [edit.id, '{"rehearsal":"post-F edit"}'], { label: 'owner edits the OLD record after F (drift)' });
    report.checks.driftAfterF = J(drift(F, await readLedger(node, OLD)));

    // ---------------- 6. seal imports + hand ownership to governance ----------------
    log('6. seal imports, handoff');
    assertCanSeal(par);
    await send(M, NEW, LEDGER_ABI, 'sealImports', [], { label: 'sealImports [IRREVERSIBLE]' });
    await send(M, NEW, LEDGER_ABI, 'setOwner', [GOV]);
    await send(M, prf.contractAddress, PROVER, 'transferOwnership', [GOV], { label: 'prover.transferOwnership(governance)' });
    await send(GOV, NEW, LEDGER_ABI, 'acceptOwnership', [], { label: 'governance accepts ledger17' });
    await send(GOV, prf.contractAddress, PROVER, 'acceptOwnership', [], { label: 'governance accepts prover17' });

    // ---------------- 7. book repoint (governance) and what follows it ----------------
    log('7. book repoint');
    const keys = ['deployments', 'proofOfTime', 'verificationFees', 'connectivity'].map((k) => stringToHex(k, { size: 32 }));
    await send(BOOK_OWNER, BOOK_ADDR, BOOK, 'setMany', [keys, [NEW, prf.contractAddress, fees.contractAddress, conn.contractAddress]], { label: 'book.setMany(deployments, proofOfTime, verificationFees, connectivity)' });
    const followers = {};
    for (const e of snap.book.entries.filter((x) => ['reviews', 'hostReviews'].includes(x.key))) followers[e.key] = await node.read(e.value, [{ type: 'function', name: 'ledger', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], 'ledger');
    report.checks.bookFollowers = followers;
    for (const [k, a] of Object.entries(followers)) if (lc(a) !== lc(NEW)) throw Error(`${k} still resolves ${a}`);

    // ---------------- 8. old leases lapse; a pending OLD release lands harmlessly ----------------
    log('8. lapse + old release');
    const maxUntil = F.reduce((m, d) => (BigInt(d.leaseUntil) > m ? BigInt(d.leaseUntil) : m), 0n);
    const window = BigInt(snap.dependents.proofOfTime.proofWindowSec);
    const now0 = (await node.pub.getBlock()).timestamp;
    if (maxUntil + window + 1n > now0) await node.warp(maxUntil + window + 1n - now0);
    const newBefore = JSON.stringify(J(await readLedger(node, NEW)));
    if (leased) {
      await send(leased.runnerOperator, OLD, LEDGER_ABI, 'release', [leased.id], { label: 'a release queued for an OLD lease lands after the cutover' });
      if (JSON.stringify(J(await readLedger(node, NEW))) !== newBefore) throw Error('an old-ledger release changed the new ledger');
      report.checks.oldReleaseIsolated = { id: leased.id, newLedgerUnchanged: true };
    }

    // ---------------- 9. escrow conservation: refunds home, sweeps to payout, re-backing on the new ledger ----------------
    log('9. escrow conservation');
    const holders = snap.ledger.holders.map((h) => getAddress(h.address));
    const parties = [...new Set([OLD, NEW, PAYOUT, GOV, ...F.map((d) => getAddress(d.owner)), ...holders].map((a) => getAddress(a)))];
    const bal = async () => { const o = {}; for (const a of parties) o[a] = await node.read(P.usdc, ERC20, 'balanceOf', [a]); return o; };   // serial: gentle on the fork
    const bal0 = await bal();
    const toSettle = (await readLedger(node, OLD)).filter((d) => BigInt(d.earn.escrow6) > 0n);
    if (toSettle.length) await send(ANYONE, OLD, LEDGER_ABI, 'multicall', [toSettle.map((d) => encodeFunctionData({ abi: LEDGER_ABI, functionName: 'settle', args: [d.id] }))], { label: `settle x${toSettle.length} (permissionless, one multicall)` });
    const post = await readLedger(node, OLD);
    const cons = escrowConservation(post, target);
    const pushes = cons.rows.filter((x) => x.refundToOwner6 > 0n);
    if (pushes.length) await send(ANYONE, OLD, LEDGER_ABI, 'multicall', [pushes.map((r) => encodeFunctionData({ abi: LEDGER_ABI, functionName: 'refund', args: [r.id] }))],
      { label: `refund push x${pushes.length} -> owners ${pushes.reduce((a, r) => a + r.refundToOwner6, 0n)} (permissionless after retire, one multicall)` });
    for (const r of cons.rows.filter((x) => x.sweepToPayout6 > 0n)) await send(GOV, OLD, LEDGER_ABI, 'sweepEscrow', [r.id], { label: `sweepEscrow ${r.id.slice(0, 10)} -> payout ${r.sweepToPayout6}` });
    // the stuck remainder is real: sweepEscrow refuses it ("still fundable")
    const stuckRow = cons.rows.find((x) => x.stuck6 > 0n);
    if (stuckRow) report.negative.stuckEscrowSweep = await node.revertReason({ from: GOV, to: OLD, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'sweepEscrow', args: [stuckRow.id] }) });
    // platform re-backs from exactly what it recovered, only AFTER sealImports (so it is not owner-refundable), only active records
    const targetNow = await readLedger(node, NEW);
    const activeNew = new Set(targetNow.filter((d) => d.active).map((d) => lc(d.id)));
    const backs = cons.rows.filter((r) => r.platformBacks6 > 0n && activeNew.has(lc(r.id)));
    const backTotal = backs.reduce((a, r) => a + r.platformBacks6, 0n);
    assertCanBack({ importsSealed: await node.read(NEW, LEDGER_ABI, 'importsSealed') });
    const ownContribution = {};   // id -> what the record's OWN owner put into its escrow on the new ledger
    const addOwn = (r, from, amt) => { if (lc(from) === lc(r.owner)) ownContribution[lc(r.id)] = (ownContribution[lc(r.id)] || 0n) + amt; };
    if (backTotal > 0n) {
      await send(PAYOUT, P.usdc, ERC20, 'approve', [NEW, backTotal], { label: `payout approves ${backTotal}` });
      for (const r of backs) { await send(PAYOUT, NEW, LEDGER_ABI, 'fundEscrow', [r.id, r.platformBacks6], { label: `payout fundEscrow ${r.id.slice(0, 10)} ${r.platformBacks6} (imports sealed)` }); addOwn(r, PAYOUT, r.platformBacks6); }
    }
    // an EOA owner moves its own refunded escrow onto the new record (credited ownerEscrow6: its refund right moves with it)
    // an EOA owner that received a refund push re-backs one of ITS active records with (part of) it
    const refunded = {}; for (const r of pushes) refunded[lc(r.owner)] = (refunded[lc(r.owner)] || 0n) + r.refundToOwner6;
    let reback = null;
    for (const [o, amt] of Object.entries(refunded)) {
      if (snap.owners.find((x) => x.address === o)?.contract) continue;
      const row = cons.rows.filter((r) => lc(r.owner) === o && activeNew.has(lc(r.id)) && r.newNeeds6 > r.platformBacks6).sort((a, b) => (b.newNeeds6 > a.newNeeds6 ? 1 : -1))[0];
      if (row) { const need = row.newNeeds6 - row.platformBacks6; reback = { ...row, ownerMayReback6: need < amt ? need : amt }; break; }
    }
    if (reback) {
      await send(reback.owner, P.usdc, ERC20, 'approve', [NEW, reback.ownerMayReback6], { label: 'owner approves its re-backing' });
      await send(reback.owner, NEW, LEDGER_ABI, 'fundEscrow', [reback.id, reback.ownerMayReback6], { label: `owner fundEscrow ${reback.id.slice(0, 10)} ${reback.ownerMayReback6}` });
      addOwn(reback, reback.owner, reback.ownerMayReback6);
      report.checks.ownerReback = { id: reback.id, owner: reback.owner, amount6: String(reback.ownerMayReback6), ownerEscrow6OnNew: String(await node.read(NEW, LEDGER_ABI, 'ownerEscrow6', [reback.id])),
        refundableOnNew: String(await node.read(NEW, LEDGER_ABI, 'refundableOf', [reback.id])) };
    }
    // operators withdraw what they earned on the old ledger (it never migrates, so it cannot be paid twice)
    for (const h of holders) { const e = await node.read(OLD, LEDGER_ABI, 'earned6', [h]); if (e > 0n) await send(h, OLD, LEDGER_ABI, 'withdrawEarnings', [h], { label: `operator ${h.slice(0, 8)} withdraws ${e} on the OLD ledger` }); }
    const bal1 = await bal();
    const delta = Object.fromEntries(parties.map((a) => [a, bal1[a] - bal0[a]]));
    const net = Object.values(delta).reduce((a, x) => a + x, 0n);
    const newEarned = await Promise.all(holders.map((h) => node.read(NEW, LEDGER_ABI, 'earned6', [h])));
    report.checks.conservationRows = J(cons.rows.filter((r) => r.escrow6 > 0n || r.newNeeds6 > 0n));
    report.checks.backingSent = J(backs.map((r) => ({ id: r.id, amount6: r.platformBacks6 })));
    report.checks.conservation = J({ netAcrossParties6: net, deltas: delta, plan: cons.totals, platformBacked6: backTotal, oldLedgerLeft6: bal1[OLD], newLedgerHolds6: bal1[NEW],
      operatorEarningsOnNew: newEarned, stuckRows: cons.rows.filter((r) => r.stuck6 > 0n).map((r) => ({ id: r.id, owner: r.owner, stuck6: r.stuck6 })) });
    if (net !== 0n) throw Error('USDC was created or destroyed across the parties: ' + net);
    if (newEarned.some((x) => x > 0n)) throw Error('earnings were duplicated on the new ledger');
    // nothing the owners got back on the old ledger is refundable again on the new one unless they moved it themselves
    // (the payout is also an owner here: when it backs its OWN record the ledger rightly credits it to that owner)
    const entitlement = [];
    for (const r of cons.rows) { const oe = await node.read(NEW, LEDGER_ABI, 'ownerEscrow6', [r.id]); const own = ownContribution[lc(r.id)] || 0n;
      if (oe !== own) throw Error(`double entitlement: ${r.id} has ownerEscrow6 ${oe} on the new ledger but its owner put in ${own}`); if (oe > 0n) entitlement.push({ id: r.id, ownerEscrow6: oe }); }
    report.checks.ownerRefundableOnNew = J(entitlement);

    // ---------------- 10. the new ledger works: an active registry host claims an imported record ----------------
    log('10. new ledger in service');
    const reg = await node.read(P.registry, REGISTRY4, 'getPage', [0n, 200n]);
    const hosts = reg.filter((h) => h.active && h.cpuPricePerSec6 > 0n && h.proofKey !== '0x0000000000000000000000000000000000000000');
    let host = null, hostId = null, cand = null, tried = 0;
    for (const d of targetNow.filter((x) => x.active)) { for (const h of hosts) { tried++; const id = keccak256(stringToHex(h.endpoint));
      if (await node.read(NEW, LEDGER_ABI, 'claimableBy', [d.id, id])) { host = h; hostId = id; cand = d; break; } } if (cand) break; }
    report.checks.claimSearch = { activeRecords: targetNow.filter((x) => x.active).length, activeHostsWithProofKey: hosts.length, pairsTried: tried };
    if (host && cand) {
      const ok = true;
      if (ok) {
        const rc = await send(host.operator, NEW, LEDGER_ABI, 'claim', [cand.id, hostId], { label: 'a registered host claims an imported record on ledger17' });
        const opened = rc.logs.map((l) => { try { return decodeEventLog({ abi: LEDGER_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'LeaseOpened');
        const lease = await node.read(NEW, LEDGER_ABI, 'leaseOf', [cand.id]);
        await send(host.operator, NEW, LEDGER_ABI, 'releaseLease', [cand.id, hostId, lease[3]], { label: 'releaseLease(generation 1)' });
        report.checks.newLedgerService = { id: cand.id, host: host.endpoint, generation: String(opened?.args.generation), released: true };
      } else report.checks.newLedgerService = { id: cand.id, claimableBy: false, note: 'no active host can claim this record at its cap' };
    }

    // ---------------- 11. governance seal: Enclave's admin powers end; owner/operator controls remain ----------------
    log('11. governance seal');
    const getters = ['deploymentsSchema()', 'retired()', 'importsSealed()', 'payout()', 'usdc()', 'registry()', 'ethUsdFeed()', 'leaseSec()', 'maxGpuMilli()', 'maxFeePerSec6()',
      'runnerBps()', 'claimBond6()', 'bondExitDelay()', 'prover()', 'proofRequiredFrom()', 'feeRouter()', 'bandwidthRouter()'].map((s) => keccak256(stringToHex(s)).slice(0, 10));
    const cfg = async (t, sels) => { let h = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }], [31337n, t, keccak256(await code(t))]));
      for (const s of sels) { const r = await node.pub.call({ to: t, data: s }); h = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes4' }, { type: 'bytes32' }], [h, s, keccak256(r.data)])); } return h; };
    const sealL = await deploy('deploy GovernanceSeal(ledger17)', ctorData(SEAL, '0x' + SEAL.bytecode.object, [NEW, getters, await cfg(NEW, getters)]));
    await send(GOV, NEW, LEDGER_ABI, 'setOwner', [sealL.contractAddress], { label: 'governance nominates the seal for ledger17' });
    await send(ANYONE, sealL.contractAddress, SEAL.abi, 'seal', [], { label: 'seal() ledger17 [IRREVERSIBLE]' });
    const pGetters = ['proofWindowSec()', 'deployments()', 'proofSchema()'].map((s) => keccak256(stringToHex(s)).slice(0, 10));
    const sealP = await deploy('deploy GovernanceSeal(prover17)', ctorData(SEAL, '0x' + SEAL.bytecode.object, [prf.contractAddress, pGetters, await cfg(prf.contractAddress, pGetters)]));
    await send(GOV, prf.contractAddress, PROVER, 'transferOwnership', [sealP.contractAddress], { label: 'governance nominates the seal for prover17' });
    await send(ANYONE, sealP.contractAddress, SEAL.abi, 'seal', [], { label: 'seal() prover17 [IRREVERSIBLE]' });
    const own = { ledger: await node.read(NEW, OWNABLE, 'owner'), prover: await node.read(prf.contractAddress, OWNABLE, 'owner') };
    const adminRefused = {
      setLeaseSec: await node.revertReason({ from: GOV, to: NEW, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'setLeaseSec', args: [3600n] }) }),
      retire: await node.revertReason({ from: GOV, to: NEW, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'retire', args: [] }) }),
      setProofWindow: await node.revertReason({ from: GOV, to: prf.contractAddress, data: encodeFunctionData({ abi: PROVER, functionName: 'setProofWindow', args: [600n] }) }) };
    const ownerRec = targetNow.find((d) => d.active && !snap.owners.find((o) => o.address === lc(d.owner))?.contract);
    const ownerStill = ownerRec ? await send(ownerRec.owner, NEW, LEDGER_ABI, 'setConfig', [ownerRec.id, '{"rehearsal":"owner control after seal"}'], { label: 'a deployment owner still controls its record after the seal' }) : null;
    const guard = await send(NEWBIE, NEW, LEDGER_ABI, 'setGuardedReleaseOnly', [true], { label: 'an operator still sets its own guard after the seal' });
    report.checks.seal = { owners: own, adminRefused, ownerControl: ownerStill?.status ?? null, operatorControl: guard.status,
      sealedLedger: lc(own.ledger) === lc(sealL.contractAddress), sealedProver: lc(own.prover) === lc(sealP.contractAddress) };
    if (Object.values(adminRefused).some((x) => x === null)) throw Error('an admin power survived the seal');

    // ---------------- 12. gates on the guard itself ----------------
    report.negative.nodeGuard = await (async () => { try { node.block = node.block + 1n; await node.assertGuarded(); return false; } catch (e) { return e.message; } finally { node.block -= 1n; } })();
    report.result = 'pass';
  } catch (e) {
    report.result = 'fail'; report.error = String(e.stack || e.message).slice(0, 2000);
  } finally {
    await node.stop();
  }
  const file = path.join(HERE, 'rehearsal', `${snap.block.number}.json`);
  fs.writeFileSync(file, JSON.stringify(J(report), null, 1) + '\n');
  return { file, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const i = process.argv.indexOf('--snapshot');
  const snapshotFile = i > 0 ? process.argv[i + 1] : path.join(HERE, 'snapshots', fs.readdirSync(path.join(HERE, 'snapshots')).sort().pop());
  rehearse({ snapshotFile }).then(({ file, report }) => { console.log(JSON.stringify({ file, result: report.result, error: report.error, steps: report.steps.length })); process.exitCode = report.result === 'pass' ? 0 : 1; });
}
