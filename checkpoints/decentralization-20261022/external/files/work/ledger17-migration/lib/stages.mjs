// Shared stage generators for plan v2 and its fork replay. Each produces EXACT calldata from the state it is given:
// the planner gives it the live snapshot (projection), the replay gives it fork state at execution time (actual).
import { encodeFunctionData, encodeAbiParameters, keccak256, stringToHex, getContractAddress, concat, pad, toHex, parseAbi } from 'viem';
import { LEDGER_ABI, ERC20 } from './abis.mjs';
import { escrowConservation } from './ledgerstate.mjs';

export const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';   // deterministic-deployment proxy; on Base (69 B)
export const CREATE2_PROXY_CODEHASH = '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989';
const lc = (a) => String(a).toLowerCase();

// ---- seals: the complete admin-mutable configuration each seal commits to (owner/pendingOwner excluded by design) ----
export const LEDGER_SEAL_GETTERS = ['deploymentsSchema()', 'retired()', 'importsSealed()', 'payout()', 'usdc()', 'registry()', 'ethUsdFeed()',
  'leaseSec()', 'maxGpuMilli()', 'maxFeePerSec6()', 'runnerBps()', 'claimBond6()', 'bondExitDelay()', 'prover()', 'proofRequiredFrom()',
  'feeRouter()', 'bandwidthRouter()'];
export const PROVER_SEAL_GETTERS = ['proofWindowSec()', 'deployments()', 'proofSchema()'];
export const sel = (sig) => keccak256(stringToHex(sig)).slice(0, 10);
const word = (type, v) => encodeAbiParameters([{ type }], [v]);

/** What each ledger17 getter will return once phases P..G2 are done (all values fixed by the plan). */
export function expectedLedgerGetters({ P, prover, feeRouter, bandwidthRouter }) {
  return { 'deploymentsSchema()': word('uint256', 17n), 'retired()': word('bool', false), 'importsSealed()': word('bool', true),
    'payout()': word('address', P.payout), 'usdc()': word('address', P.usdc), 'registry()': word('address', P.registry), 'ethUsdFeed()': word('address', P.ethUsdFeed),
    'leaseSec()': word('uint64', BigInt(P.leaseSec)), 'maxGpuMilli()': word('uint16', Number(P.maxGpuMilli)), 'maxFeePerSec6()': word('uint256', BigInt(P.maxFeePerSec6)),
    'runnerBps()': word('uint16', Number(P.runnerBps)), 'claimBond6()': word('uint256', BigInt(P.claimBond6)), 'bondExitDelay()': word('uint64', BigInt(P.bondExitDelay)),
    'prover()': word('address', prover), 'proofRequiredFrom()': word('uint64', BigInt(P.proofRequiredFrom)), 'feeRouter()': word('address', feeRouter),
    'bandwidthRouter()': word('address', bandwidthRouter) };
}
export function expectedProverGetters({ proofWindowSec, ledger, proofSchema }) {
  return { 'proofWindowSec()': word('uint64', BigInt(proofWindowSec)), 'deployments()': word('address', ledger), 'proofSchema()': word('uint256', BigInt(proofSchema)) };
}
/** GovernanceSeal.currentConfigurationHash, computed off-chain: keccak(abi.encode(chainid, target, codehash)), then per getter. */
export function configHash({ chainId, target, codeHash, getters, values }) {
  let h = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }], [BigInt(chainId), target, codeHash]));
  for (const g of getters) h = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes4' }, { type: 'bytes32' }], [h, sel(g), keccak256(values[g])]));
  return h;
}
export function sealDeployment({ SEAL, target, getters, hash, saltLabel }) {
  const ctor = SEAL.abi.find((x) => x.type === 'constructor');
  const initcode = '0x' + SEAL.bytecode.object + encodeAbiParameters(ctor.inputs, [target, getters.map(sel), hash]).slice(2);
  const salt = keccak256(stringToHex(saltLabel));
  const address = getContractAddress({ opcode: 'CREATE2', from: CREATE2_PROXY, salt, bytecode: initcode });
  return { address, salt, initcode, data: concat([salt, initcode]) };   // the proxy takes salt ++ initcode
}

/** A runtime with library links and immutables filled: what the chain will hold at the predicted address. */
export function predictRuntime(dep, libs, immutablesById) {
  let o = dep.object.replace(/^0x/, '');
  for (const l of Object.values(dep.linkReferences || {})) for (const [lib, places] of Object.entries(l))
    for (const { start, length } of places) o = o.slice(0, start * 2) + libs[lib].slice(2).toLowerCase() + o.slice((start + length) * 2);
  for (const [id, refs] of Object.entries(dep.immutableReferences || {})) for (const { start, length } of refs) {
    const v = immutablesById[id]; if (!v) throw Error('no value for immutable ' + id);
    o = o.slice(0, start * 2) + v.replace(/^0x/, '').toLowerCase().padStart(64, '0').slice(-length * 2) + o.slice((start + length) * 2);
  }
  return '0x' + o;
}

// ---- owners: what each can actually execute ----
export function ownerKind(o) {
  if (!o.contract) return 'eoa';
  const code = o.code || '';
  if (/^0xef0100/i.test(code)) return 'eip7702-eoa';
  if (o.kind?.startsWith('verification-fee wallet')) return 'fee-wallet';
  if (o.kind === 'session vault') return 'legacy-session-vault';
  if (o.kind?.startsWith('credit vault')) return 'credit-vault';
  return 'contract-unknown';
}
const VAULT_ABI = parseAbi(['function withdraw(uint256 amount, bytes32 opNonce, uint64 signBefore, bytes sig)']);
const FEE_ABI = parseAbi(['function revoke(bytes32 source)']);

/** Escrow stages after retire + lapse: settle, refund push, sweep, payout carry, owner carry - exact calldata.
 *  postOld: old-ledger records after every lease lapsed; imported: ledger17 records; owners: snapshot owner info. */
export function escrowStages({ postOld, imported, owners, OLD, NEW, USDC, PAYOUT, feeWallets, feeRouter }) {
  const cons = escrowConservation(postOld, imported);
  const activeNew = new Set(imported.filter((d) => d.active).map((d) => lc(d.id)));
  const ownerOf = (a) => owners.find((x) => x.address === lc(a)) || { address: lc(a), contract: false };
  const txs = [];
  const settle = postOld.filter((d) => BigInt(d.earn.escrow6) > 0n).map((d) => d.id);
  if (settle.length) txs.push({ phase: 'R', signer: { role: 'anyone' }, to: OLD, label: `settle x${settle.length}`, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'multicall',
    args: [settle.map((id) => encodeFunctionData({ abi: LEDGER_ABI, functionName: 'settle', args: [id] }))] }) });
  const pushes = cons.rows.filter((r) => r.refundToOwner6 > 0n);
  if (pushes.length) txs.push({ phase: 'R', signer: { role: 'anyone' }, to: OLD, label: `refund push x${pushes.length} (each paid to its record owner)`, usdc6: pushes.reduce((a, r) => a + r.refundToOwner6, 0n),
    data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'multicall', args: [pushes.map((r) => encodeFunctionData({ abi: LEDGER_ABI, functionName: 'refund', args: [r.id] }))] }) });
  for (const r of cons.rows.filter((x) => x.sweepToPayout6 > 0n))
    txs.push({ phase: 'S', signer: { role: 'governance' }, to: OLD, label: `sweepEscrow ${r.id.slice(0, 10)} -> payout ${r.sweepToPayout6}`, usdc6: r.sweepToPayout6, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'sweepEscrow', args: [r.id] }) });
  // payout carries back exactly what it recovered, onto the SAME record, if that record is active on ledger17
  const backs = cons.rows.filter((r) => r.platformBacks6 > 0n && activeNew.has(lc(r.id)));
  const backTotal = backs.reduce((a, r) => a + r.platformBacks6, 0n);
  if (backTotal > 0n) {
    txs.push({ phase: 'B', signer: { role: 'payout', address: PAYOUT }, to: USDC, label: `approve ledger17 ${backTotal}`, usdc6: backTotal, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [NEW, backTotal] }) });
    for (const r of backs) txs.push({ phase: 'B', signer: { role: 'payout', address: PAYOUT }, to: NEW, label: `fundEscrow ${r.id.slice(0, 10)} ${r.platformBacks6} (recovered sweep, same record)`, usdc6: r.platformBacks6,
      data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'fundEscrow', args: [r.id, r.platformBacks6] }) });
  }
  // owner carry: each owner's refunded escrow back onto the SAME active record, by the method its account can execute
  const carry = [], unsupported = [];
  const byOwner = {};
  for (const r of pushes) (byOwner[lc(r.owner)] ||= []).push(r);
  for (const [o, rs] of Object.entries(byOwner)) {
    const info = ownerOf(o), kind = ownerKind(info);
    const act = rs.filter((r) => activeNew.has(lc(r.id))).map((r) => ({ ...r, amount: (r.newNeeds6 - r.platformBacks6) < r.refundToOwner6 ? r.newNeeds6 - r.platformBacks6 : r.refundToOwner6 })).filter((r) => r.amount > 0n);
    const inactive = rs.filter((r) => !activeNew.has(lc(r.id)));
    for (const r of inactive) carry.push({ owner: o, kind, id: r.id, note: `record inactive on ledger17: no service to continue; the owner keeps its refund ${r.refundToOwner6}` });
    if (!act.length) continue;
    const total = act.reduce((a, r) => a + r.amount, 0n);
    if (kind === 'eoa' || kind === 'eip7702-eoa') {
      txs.push({ phase: 'O', signer: { role: `record owner (${kind}; signs with its own key)`, address: o }, to: USDC, label: `approve ledger17 ${total}`, usdc6: total, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [NEW, total] }) });
      for (const r of act) txs.push({ phase: 'O', signer: { role: `record owner (${kind})`, address: o }, to: NEW, label: `fundEscrow ${r.id.slice(0, 10)} ${r.amount} (its own refund, back onto its own record; credited as its refundable escrow)`, usdc6: r.amount,
        data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'fundEscrow', args: [r.id, r.amount] }) });
    } else if (kind === 'legacy-session-vault' && info.ownerOf) {
      // the vault's owner calls it DIRECTLY (owner bypasses the signed-op check); the vault cannot approve USDC itself
      // (ownerCall refuses the USDC target), so the owner carries from its own wallet: backing restored, but the escrow
      // is credited as non-owner backing because the record's owner is the vault (stated, not hidden)
      const vaultTotal = rs.reduce((a, r) => a + r.refundToOwner6, 0n);
      txs.push({ phase: 'O', signer: { role: 'vault owner (direct call, no signature needed)', address: info.ownerOf }, to: info.address, label: `vault.withdraw(${vaultTotal}) -> vault owner`, usdc6: vaultTotal,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdraw', args: [vaultTotal, '0x' + '0'.repeat(64), 0n, '0x'] }) });
      txs.push({ phase: 'O', signer: { role: 'vault owner', address: info.ownerOf }, to: USDC, label: `approve ledger17 ${total}`, usdc6: total, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [NEW, total] }) });
      for (const r of act) txs.push({ phase: 'O', signer: { role: 'vault owner', address: info.ownerOf }, to: NEW, label: `fundEscrow ${r.id.slice(0, 10)} ${r.amount} (vault refund, carried by its owner; NOT owner-refundable on ledger17)`, usdc6: r.amount,
        data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'fundEscrow', args: [r.id, r.amount] }) });
    } else unsupported.push({ owner: o, kind, records: act.map((r) => ({ id: r.id, amount6: r.amount })),
      why: kind === 'credit-vault' ? 'credit vaults can only fund/refund/control (no fundEscrow); a carry would re-buy runtime instead' : kind === 'fee-wallet' ? 'fee wallets act only through their controller' : 'no verified execution path' });
  }
  // fee wallets: their payer returns each wallet's USDC (incl. any refund pushed to it) to the ledger payout
  for (const w of feeWallets || []) txs.push({ phase: 'O', signer: { role: 'fee payer (its own key)', address: w.payer }, to: feeRouter, label: `old fee router revoke(${w.source.slice(0, 10)}): wallet ${w.wallet} -> payout`,
    data: encodeFunctionData({ abi: FEE_ABI, functionName: 'revoke', args: [w.source] }) });
  return { txs, cons, carry, unsupported, backTotal };
}

/** Records that retirement would strand (non-owner escrow behind a still-fundable balance) and what serving them out takes. */
export function strandedAtRetire(records) {
  const out = [];
  for (const d of records) {
    const E = BigInt(d.earn.escrow6), R = BigInt(d.refundable6), r6 = BigInt(d.earn.rate6), rate = BigInt(d.rate), B = BigInt(d.balance6);
    if (E - R > 0n && R === 0n && rate > 0n && B >= rate) out.push({ id: d.id, owner: d.owner, active: d.active, stranded6: E - R, rate, rate6: r6, balance6: B,
      serveOutSeconds: r6 > 0n ? (E - R) / r6 : null, balanceSeconds: B / rate });
  }
  return out;
}

/** Per-deployment service metrics: what an enclave would be paid and for how long, and who can claim it. */
export function serviceMetrics(d, claimableHosts) {
  const B = BigInt(d.balance6), rate = BigInt(d.rate), r6 = BigInt(d.earn.rate6), E = BigInt(d.earn.escrow6);
  return { id: d.id, owner: d.owner, active: d.active, rate: String(rate), balance6: String(B), fundableSeconds: rate === 0n ? 'free' : String(B / rate),
    escrow6: String(E), runnerRate6: String(r6), paidSeconds: r6 === 0n ? (rate === 0n ? 'free' : 'no runner share') : String(E / r6 < (rate === 0n ? 0n : B / rate) ? E / r6 : B / rate),
    claimableHosts: claimableHosts.length, claimableBy: claimableHosts };
}
