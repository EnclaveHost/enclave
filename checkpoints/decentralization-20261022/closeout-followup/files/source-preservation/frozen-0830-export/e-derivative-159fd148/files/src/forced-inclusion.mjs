// L1 FORCED-INCLUSION PLANS for Enclave operations on Base (OP Stack): STRICT, UNSIGNED, OPERATION-SPECIFIC.
//
// What this is. When every public Base RPC (and the hosted sequencer endpoint) refuses a transaction, an L1 deposit
// through Base's OptimismPortal is the protocol's own way in: the portal emits TransactionDeposited, every Base node
// derives a deposit transaction (type 0x7E) from it, and the sequencer must include it within the sequencing window
// (Base mainnet: 3600 L1 blocks, base/base v1.5.1 crates/common/chains/src/config.rs). This module builds the UNSIGNED
// L1 transaction for that, for the reviewed Enclave operations only, and checks inclusion afterwards. It never signs,
// never sends, never holds a key, never reuses a wallet session; a caller with root's approval does that.
//
// What a deposit changes (all from primary source, see RESULT.md):
//   * it is a NEW transaction: a new L1 signature on chain 1, L1 ETH for L1 gas and the portal's resource-metering
//     burn; the Base EOA signature of an L2 transaction CANNOT be carried. The deposit's L2 `from` is the L1 sender if
//     the portal sees an EOA (msg.sender == tx.origin, or a 7702-delegated EOA in OptimismPortal2 7.0.0), otherwise
//     the sender's ALIAS (+0x1111000000000000000000000000000000001111): a contract (a Safe) on L1 never becomes the
//     same msg.sender on L2;
//   * it ignores the sender's L2 nonce (only bumps it), executes at gas price 0 (base_common_consensus
//     FromRecoveredTx<TxDeposit> for TxEnv), pays no L2 fee, and if it fails every effect is undone except the nonce
//     bump and the mint (crates/common/evm/src/handler.rs catch_error);
//   * it cannot carry an EIP-7702 authorization list.
// So only two shapes keep the operation's authorization exactly:
//   A. SIGNATURE-AUTHORIZED, SENDER-AGNOSTIC calls whose own signed payload carries a single-use nonce and deadline:
//      the host's signed Lease through EnclaveLeaseExecutor (the code runs AS the operator; the outer sender is never
//      read). Any funded L1 account may submit; a copy that lands twice reverts BadNonce the second time.
//   B. msg.sender-AUTHORIZED calls whose authorized address is a plain (or 7702-delegated) EOA that signs a direct L1
//      transaction itself. Deposits have NO nonce protection, so a plan is refused while an L2-signed transaction for
//      the same intent could still land, unless the operation is a reviewed state-setter.
// Everything else (contract owners, generic calls, value transfers, host operator keys that hold no ETH, first
// delegations) is REFUSED with the reason.
import {
  concat, decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, hexToBigInt, isAddress, isHex, keccak256,
  parseAbi, recoverTypedDataAddress, size, slice, zeroAddress,
} from 'viem';
import { base } from 'viem/chains';
import { extractTransactionDepositedLogs, getL2TransactionHash, opaqueDataToDepositData } from 'viem/op-stack';

// ---- pinned protocol facts ------------------------------------------------------------------------------------------
export const BASE_MAINNET = Object.freeze({
  l2ChainId: 8453,
  l1ChainId: 1,
  portal: getAddress(base.contracts.portal[1].address),   // = base/base deposit_contract_address 0x4904…e97e
  seqWindowL1Blocks: 3600,
});
/** OptimismPortal2 (ethereum-optimism/optimism develop, 7.0.0) signatures; the same as viem's internal portal ABI and
 *  Base's derivation (crates/consensus/protocol/src/deposits.rs EVENT_ABI). */
export const PORTAL_ABI = parseAbi([
  'function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable',
  'event TransactionDeposited(address indexed from, address indexed to, uint256 indexed version, bytes opaqueData)',
]);
/** OptimismPortal2.minimumGasLimit(byteCount) = byteCount * 40 + 21000. */
export const portalMinimumGasLimit = (byteCount) => BigInt(byteCount) * 40n + 21000n;
export const PORTAL_MAX_DATA_BYTES = 120_000;
/** AddressAliasHelper.applyL1ToL2Alias: uint160(l1Address) + 0x1111000000000000000000000000000000001111 (mod 2^160). */
export const L1_TO_L2_ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;
export function applyL1ToL2Alias(address) {
  const v = (hexToBigInt(getAddress(address)) + L1_TO_L2_ALIAS_OFFSET) % (1n << 160n);
  return getAddress('0x' + v.toString(16).padStart(40, '0'));
}

// ---- Enclave contracts (contracts/EnclaveLeaseExecutor.sol, EnclaveLeaseGasReserve.sol at checkpoint 8ac1aa51c) -------
export const EXECUTOR_ABI = parseAbi([
  'struct Lease { bytes32 id; uint8 kind; bytes32 enclaveId; uint64 nonce; uint64 deadline; address payee; uint256 maxChargeWei; }',
  'function lease(Lease l, bytes signature)',
  'function nonceOf(bytes32 id) view returns (uint64)',
  'function reserve() view returns (address)',
  'function ledger() view returns (address)',
]);
export const RESERVE_ABI = parseAbi([
  'function statusOf(bytes32 id, uint8 kind, bytes32 enclaveId, address operator) view returns (uint8 status, uint256 availableWei, uint256 epochLeftWei, uint256 maxPerOpWei)',
  'function delegationCodeHash() view returns (bytes32)',
  'function executor() view returns (address)',
  'function ledger() view returns (address)',
  'event LeaseGasPaid(bytes32 indexed id, address indexed owner, address indexed operator, address payee, uint8 kind, uint256 gas, uint256 gasPrice, uint256 l1FeeWei, uint256 chargedWei)',
]);
export const RESERVE_STATUS = ['Ready', 'Paused', 'Blocked', 'Unknown', 'Retired', 'Disabled', 'Inactive', 'LeaseLive', 'LeaseExpired', 'NotRunner',
  'NotOperator', 'ClaimantNotAllowed', 'ClaimCooldown', 'ClaimLimitReached', 'NotInRenewWindow', 'OverRateCap', 'ExtensionTooShort',
  'ReleaseNotSponsored', 'EmptyReserve', 'EpochCapReached', 'BadKind', 'ProofKeyMissing', 'BondRequired'];
export const LEASE_KIND = Object.freeze({ claim: 1, renew: 2, release: 3 });
/** EnclaveLeaseExecutor.CANONICAL_LENGTH: selector + 7 static words + signature offset + length + 65 bytes padded to 96. */
export const EXECUTOR_CANONICAL_LENGTH = 4 + 7 * 32 + 32 + 32 + 96;
const LEASE_TYPES = { Lease: [
  { name: 'reserve', type: 'address' }, { name: 'id', type: 'bytes32' }, { name: 'kind', type: 'uint8' }, { name: 'enclaveId', type: 'bytes32' },
  { name: 'nonce', type: 'uint64' }, { name: 'deadline', type: 'uint64' }, { name: 'payee', type: 'address' }, { name: 'maxChargeWei', type: 'uint256' }] };
const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
const ZERO32 = '0x' + '00'.repeat(32);
const HASH = /^0x[0-9a-f]{64}$/i;

export class Refused extends Error {
  constructor(code, detail) { super(`${code}${detail ? ': ' + detail : ''}`); this.code = code; }
}
const refuse = (code, detail) => { throw new Refused(code, detail); };
const lower = (a) => getAddress(a).toLowerCase();
const u = (v, name) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { return refuse('bad-input', name); } };

/** Every plan rests on ONE verified head (a Base block whose hash the caller's verifier bound: P's root store/Helios). */
function checkHead(head, now, maxHeadAgeSec) {
  if (!head || !HASH.test(head.hash || '') || !Number.isSafeInteger(head.number) || !Number.isSafeInteger(head.timestamp)) refuse('no-verified-head');
  if (head.verifiedBy !== 'signed-head' && head.verifiedBy !== 'ancestor') refuse('unverified-head', String(head.verifiedBy));
  const age = now - head.timestamp;
  if (age > maxHeadAgeSec) refuse('stale-head', `head ${head.number} is ${age} s old (max ${maxHeadAgeSec})`);
  if (age < -30) refuse('head-from-the-future', `${-age} s ahead of local time`);
  return age;
}
function checkGas(gasLimit, data, { minL2Gas, maxL2Gas }) {
  const g = u(gasLimit, 'l2GasLimit');
  const floor = portalMinimumGasLimit(size(data));
  if (g < floor) refuse('gas-below-portal-floor', `${g} < ${floor}`);
  if (g < BigInt(minL2Gas)) refuse('gas-below-reviewed-minimum', `${g} < ${minL2Gas}`);
  if (g > BigInt(maxL2Gas)) refuse('gas-above-reviewed-maximum', `${g} > ${maxL2Gas}`);
  if (size(data) > PORTAL_MAX_DATA_BYTES) refuse('calldata-too-large');
  return g;
}
const portalCall = (to, gasLimit, data) => encodeFunctionData({ abi: PORTAL_ABI, functionName: 'depositTransaction', args: [to, 0n, gasLimit, false, data] });

// =====================================================================================================================
// Duplicate-execution guard. A deposit on L1 WILL execute on L2 eventually (protocol rule); a plan is therefore a
// commitment, never something to "retry". The tracker is the caller's durable record (serialize with toJSON).
// =====================================================================================================================
export class ForcedInclusionTracker {
  constructor(entries = []) { this.entries = new Map(entries.map((e) => [e.key, { ...e }])); }
  toJSON() { return [...this.entries.values()]; }
  get(key) { return this.entries.get(key) || null; }
  /** Unresolved = could still execute on L2 (planned, sent, on L1, or L2-unsafe and not yet past every doubt). */
  static open(e) { return e && !['l2-included', 'l2-failed', 'dead'].includes(e.state); }
  /** Record a new plan, or return the existing record for the SAME commitment (no new L1 transaction implied). */
  admit(key, commitment, info) {
    const e = this.entries.get(key);
    if (e && e.commitment === commitment) return { replay: true, entry: e };
    if (ForcedInclusionTracker.open(e)) refuse('ambiguous-duplicate', `${key} has an unresolved commitment ${e.commitment.slice(0, 18)}… (${e.state})`);
    const entry = { key, commitment, state: 'planned', ...info };
    this.entries.set(key, entry);
    return { replay: false, entry };
  }
  /** A lease commitment is DEAD only when a verified head is past its deadline and the executor nonce was never
   *  consumed: then (and only then) a new Lease at the same nonce may be signed. */
  resolveExpiredLease(key, snapshot) {
    const e = this.entries.get(key);
    if (!e || !ForcedInclusionTracker.open(e)) refuse('unknown-commitment', key);
    if (!snapshot?.head || !['signed-head', 'ancestor'].includes(snapshot.head.verifiedBy)) refuse('unverified-head');
    if (BigInt(snapshot.head.timestamp) <= BigInt(e.deadline)) refuse('not-expired', `head ${snapshot.head.timestamp} <= deadline ${e.deadline}`);
    if (BigInt(snapshot.executorNonce) !== BigInt(e.nonce)) refuse('nonce-consumed', 'the lease (or another at that nonce) executed: resolve it from its receipt');
    return this.mark(key, 'dead', { deadAt: snapshot.head.hash });
  }
  /** Before (re)broadcasting the L1 transaction: a resend must reuse the SAME L1 nonce (a replacement can then land
   *  at most once); a new L1 nonce for an open commitment could put TWO deposits on L1. */
  checkL1Send(key, l1Nonce) {
    const e = this.entries.get(key);
    if (!e || !ForcedInclusionTracker.open(e)) refuse('unknown-commitment', key);
    if (e.l1Nonce !== undefined && String(e.l1Nonce) !== String(l1Nonce)) refuse('l1-nonce-change', `committed at L1 nonce ${e.l1Nonce}`);
    if (e.state === 'l1-included') refuse('already-on-l1', 'the deposit exists; wait for its L2 outcome');
    return this.mark(key, 'l1-sent', { l1Nonce: String(l1Nonce) });
  }
  /** A VERIFIED failed L1 receipt of the recorded transaction: no TransactionDeposited, no L2 effect, the slot frees. */
  resolveFailedL1(key, l1Receipt, l1Proof) {
    const e = this.entries.get(key);
    if (!e || !ForcedInclusionTracker.open(e)) refuse('unknown-commitment', key);
    if (!l1Proof || !['l1-light-client', 'l1-execution-proof'].includes(l1Proof.verifiedBy)) refuse('l1-receipt-unverified');
    if (l1Receipt?.status !== 'reverted' || l1Receipt.blockHash?.toLowerCase() !== l1Proof.headerHash?.toLowerCase()) refuse('not-failed');
    if (e.l1Nonce === undefined || String(l1Receipt.nonce) !== String(e.l1Nonce)) refuse('l1-receipt-mismatch', 'not the recorded L1 nonce');
    return this.mark(key, 'dead', { l1Failed: l1Receipt.transactionHash });
  }
  mark(key, state, evidence) {
    const e = this.entries.get(key);
    if (!e) refuse('unknown-commitment', key);
    const order = ['planned', 'l1-sent', 'l1-included', 'l2-included', 'l2-failed', 'dead'];
    if (order.indexOf(state) < order.indexOf(e.state)) refuse('state-regression', `${e.state} -> ${state}`);
    Object.assign(e, { state, ...evidence });
    return e;
  }
}

// =====================================================================================================================
// A. The host's signed Lease (claim / renew / release) through EnclaveLeaseExecutor, as an L1 deposit
// =====================================================================================================================
/**
 * pins: the reviewed deployment record {executor, reserve, ledger} (the reserve's executor binding is checked again
 *   at the verified head). operator: the host's operator key (an EOA delegated to the executor).
 * lease: {id, kind, enclaveId, nonce, deadline, payee, maxChargeWei}; signature: the operator's 65-byte EIP-712
 *   signature over it (domain EnclaveLeaseExecutor/1/8453/operator), exactly what the relay path sends.
 * snapshot: readLeaseSnapshot() at ONE verified head. l1Sender: the L1 account that will sign and fund the L1 tx.
 * -> {plan, replay} or throws Refused.
 */
export async function planLeaseDeposit({ network = BASE_MAINNET, pins, operator, lease, signature, snapshot, l1Sender, l2GasLimit,
  tracker, now = Math.floor(Date.now() / 1000), policy = {} }) {
  const p = { maxHeadAgeSec: 120, minDeadlineMarginSec: 3600, minL2Gas: 300_000, maxL2Gas: 1_500_000, minRenewHeadroomSec: 600, ...policy };
  if (!pins || !isAddress(pins.executor || '') || !isAddress(pins.reserve || '') || !isAddress(pins.ledger || '')) refuse('no-pins');
  if (!isAddress(operator || '') || !isAddress(l1Sender || '')) refuse('bad-input', 'operator/l1Sender');
  const s = snapshot;
  const headAge = checkHead(s?.head, now, p.maxHeadAgeSec);
  // the reviewed executor/reserve/ledger, bound to each other at the verified head
  if (lower(s.reserveExecutor) !== lower(pins.executor) || lower(s.executorReserve) !== lower(pins.reserve)
      || lower(s.executorLedger) !== lower(pins.ledger) || lower(s.reserveLedger) !== lower(pins.ledger)) refuse('pin-mismatch', 'executor/reserve/ledger binding at the verified head');
  const designator = concat(['0xef0100', getAddress(pins.executor)]).toLowerCase();
  if (s.delegationCodeHash?.toLowerCase() !== keccak256(designator)) refuse('pin-mismatch', 'reserve delegationCodeHash');
  // the first lease carries the operator's EIP-7702 authorization; a deposit has no authorization list
  if ((s.operatorCode || '0x').toLowerCase() !== designator) refuse('operator-not-delegated', 'the key must already run the executor (its first lease needs a type-4 transaction, not a deposit)');
  // the lease itself
  if (!HASH.test(lease?.id || '') || String(s.id).toLowerCase() !== lease.id.toLowerCase()) refuse('bad-input', 'lease.id differs from the snapshot\'s deployment');
  const l = {
    id: lease.id, kind: Number(lease.kind), enclaveId: lease.enclaveId ?? ZERO32, nonce: u(lease.nonce, 'nonce'), deadline: u(lease.deadline, 'deadline'),
    payee: lease.payee, maxChargeWei: u(lease.maxChargeWei, 'maxChargeWei'),
  };
  if (![1, 2, 3].includes(l.kind)) refuse('unsupported-kind', String(lease.kind));
  if (!HASH.test(l.enclaveId) || (l.kind !== 1 && l.enclaveId !== ZERO32)) refuse('bad-input', 'enclaveId (claim only)');
  if (!isAddress(l.payee || '') || lower(l.payee) === zeroAddress) refuse('bad-input', 'payee');
  if (!isHex(signature) || size(signature) !== 65) refuse('bad-signature', 'not 65 bytes');
  const sv = Number(hexToBigInt(slice(signature, 64, 65))), ss = hexToBigInt(slice(signature, 32, 64));
  if (![0, 1, 27, 28].includes(sv) || ss > HALF_N) refuse('bad-signature', 'v/s not accepted by the executor');
  const domain = { name: 'EnclaveLeaseExecutor', version: '1', chainId: network.l2ChainId, verifyingContract: getAddress(operator) };
  const message = { reserve: getAddress(pins.reserve), ...l };
  const signer = await recoverTypedDataAddress({ domain, types: LEASE_TYPES, primaryType: 'Lease', message, signature });
  if (lower(signer) !== lower(operator)) refuse('bad-signature', `recovers ${signer}, not the operator`);
  // single use, in time, admitted by the app's reserve: all at the verified head
  if (u(s.executorNonce, 'executorNonce') !== l.nonce) refuse('stale-nonce', `executor nonce is ${s.executorNonce}, lease has ${l.nonce}`);
  if (l.deadline < BigInt(s.head.timestamp + p.minDeadlineMarginSec))
    refuse('deadline-too-close', `a deposit may take up to the sequencing window to land; deadline ${l.deadline} < head + ${p.minDeadlineMarginSec}`);
  const status = RESERVE_STATUS[Number(s.status)] ?? 'unknown';
  if (status !== 'Ready') refuse('reserve-refuses', status);
  if (l.kind === 2) {
    // a renew must land inside [leaseUntil - renewWindow, leaseUntil]; a deposit's latency is not under the host's control
    const headroom = Number(s.leaseUntil) - s.head.timestamp;
    if (headroom < p.minRenewHeadroomSec) refuse('renew-window-too-short', `${headroom} s left on the lease, need ${p.minRenewHeadroomSec}`);
  }
  const data = encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'lease', args: [l, signature] });
  if (size(data) !== EXECUTOR_CANONICAL_LENGTH) refuse('not-canonical', `${size(data)} bytes`);
  const gasLimit = checkGas(l2GasLimit, data, p);
  // idempotency: the commitment is the lease digest; one executor nonce per (operator, deployment)
  const key = `lease:${network.l2ChainId}:${lower(operator)}:${l.id.toLowerCase()}`;
  const commitment = keccak256(data);
  const { replay, entry } = (tracker ?? new ForcedInclusionTracker()).admit(key, commitment, { nonce: l.nonce.toString(), deadline: l.deadline.toString() });
  const plan = {
    format: 'enclave-forced-inclusion/v1', operation: 'lease.' + ['', 'claim', 'renew', 'release'][l.kind], key, commitment,
    l1Transaction: { chainId: network.l1ChainId, from: getAddress(l1Sender), to: network.portal, value: 0n, data: portalCall(getAddress(operator), gasLimit, data) },
    deposit: { to: getAddress(operator), value: 0n, mint: 0n, gasLimit, isCreation: false, data,
      // the executor never reads the outer sender: either derivation of `from` is acceptable for THIS operation
      acceptableFrom: [getAddress(l1Sender), applyL1ToL2Alias(l1Sender)] },
    binding: { l2ChainId: network.l2ChainId, portal: network.portal, executor: getAddress(pins.executor), reserve: getAddress(pins.reserve), ledger: getAddress(pins.ledger),
      operator: getAddress(operator), lease: { ...l, nonce: l.nonce.toString(), deadline: l.deadline.toString(), maxChargeWei: l.maxChargeWei.toString() },
      head: { number: s.head.number, hash: s.head.hash, timestamp: s.head.timestamp, verifiedBy: s.head.verifiedBy, ageSec: headAge } },
    authorization: [
      'L2: the operator\'s existing EIP-712 Lease signature, unchanged (the executor recovers it against the operator itself)',
      `L1: ONE new transaction on chain ${network.l1ChainId} from ${getAddress(l1Sender)} to the portal (any funded L1 account; it gains no authority over the lease)`,
    ],
    funding: [
      'L1 ETH, paid by the L1 sender and NOT reimbursed on L1: the depositTransaction execution gas plus the portal\'s resource-metering burn for the L2 gas limit',
      'L2: a deposit runs at gas price 0, so the reserve charges no L2 gas; it pays `payee` only its L1-fee-upper-bound share (limits.l1Bps), bounded by maxChargeWei and the owner\'s caps',
      'the deposit\'s L2 sender pays nothing on L2 and needs no L2 balance (mint 0, value 0)',
    ],
    duplicates: 'one signed Lease = one executor nonce: whichever copy (sequencer, relay, deposit) executes first consumes it; every other copy reverts BadNonce (a failed deposit leaves only its sender\'s nonce bump). Never sign a second Lease for this deployment before this one is resolved (included, failed, or dead past its deadline at a verified head).',
    inclusion: `L2 inclusion when the sequencer adopts the L1 origin holding the deposit; if the sequencer withholds it, derivation forces it within the sequencing window (${network.seqWindowL1Blocks} L1 blocks, about ${Math.round(network.seqWindowL1Blocks * 12 / 3600)} h). Deadline margin required: ${p.minDeadlineMarginSec} s.`,
  };
  return { plan, replay, entry };
}

/**
 * The state a lease plan needs, read with eth_call/eth_getCode PINNED to one verified head through a VERIFYING client
 * (Helios's RPC, or the witness gateway behind it: every answer checked against that head's state root).
 * client: a viem public client on that verifier; head: {number, hash, timestamp, verifiedBy}.
 */
export async function readLeaseSnapshot({ client, head, pins, operator, id, kind, enclaveId = ZERO32 }) {
  const at = { blockHash: head.hash };
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, ...at });
  const ledgerAbi = parseAbi(['struct D { bytes32 id; address owner; string appRef; string ports; string configCid; uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt; uint256 rate; uint256 balance6; uint256 spent6; bytes32 runner; address runnerOperator; uint64 leaseUntil; }',
    'function get(bytes32 id) view returns (D)']);
  const [st, dch, rex, rled, eres, eled, code, nonce, row] = await Promise.all([
    read(pins.reserve, RESERVE_ABI, 'statusOf', [id, kind, enclaveId, operator]), read(pins.reserve, RESERVE_ABI, 'delegationCodeHash'),
    read(pins.reserve, RESERVE_ABI, 'executor'), read(pins.reserve, RESERVE_ABI, 'ledger'),
    read(pins.executor, EXECUTOR_ABI, 'reserve'), read(pins.executor, EXECUTOR_ABI, 'ledger'),
    client.getCode({ address: operator, ...at }), read(operator, EXECUTOR_ABI, 'nonceOf', [id]).catch(() => null),
    read(pins.ledger, ledgerAbi, 'get', [id]),
  ]);
  return { head, id, status: st[0], availableWei: st[1], delegationCodeHash: dch, reserveExecutor: rex, reserveLedger: rled, executorReserve: eres,
    executorLedger: eled, operatorCode: code ?? '0x', executorNonce: nonce ?? 0n, leaseUntil: row.leaseUntil, runnerOperator: row.runnerOperator, active: row.active };
}

// =====================================================================================================================
// B. Reviewed msg.sender-authorized operations, as a deposit from the SAME EOA
// =====================================================================================================================
/** Each entry was read in the contract source (checkpoint 8ac1aa51c); `authorized` names the one address the contract
 *  compares msg.sender with, `stateSetter` = executing it twice leaves the same state (the second is redundant). */
export const REVIEWED_DIRECT = Object.freeze({
  'ledger.setActive': { abi: parseAbi(['function setActive(bytes32 id, bool active)']), fn: 'setActive', authorized: 'deployment owner (EnclaveDeployments._requireOwned: d.owner == msg.sender)', stateSetter: true },
  'catalog.setApproval': { abi: parseAbi(['function setApproval(bytes32 appId, uint256 index, uint8 status)']), fn: 'setApproval', authorized: 'catalog owner (msg.sender == owner)', stateSetter: true },
  'catalog.setVerified': { abi: parseAbi(['function setVerified(bytes32 appId, uint256 index, bool v)']), fn: 'setVerified', authorized: 'catalog owner (msg.sender == owner)', stateSetter: true },
  'sessionVault.ownerCall': { abi: parseAbi(['function ownerCall(address target, bytes data) returns (bytes)']), fn: 'ownerCall', authorized: 'vault owner (SessionVault.ownerCall: msg.sender == owner, direct only)', stateSetter: false },
});
/**
 * op: a REVIEWED_DIRECT name; target: the contract; data: its calldata (decoded and re-checked against the entry);
 * snapshot: { head, authorizedAddress (read at the head: the owner the contract compares with), authorizedCode
 *   (eth_getCode of it at the head), accountNonce (its L2 nonce at the head), included: [hashes of prior attempts
 *   proven included] }; priorL2Attempts: [{hash, nonce}] L2-signed transactions for this same intent that were ever
 *   handed to any endpoint. from: the EOA that will sign the L1 transaction itself.
 */
export function planDirectDeposit({ network = BASE_MAINNET, op, target, data, from, snapshot, priorL2Attempts = [], l2GasLimit, tracker,
  now = Math.floor(Date.now() / 1000), policy = {} }) {
  const p = { maxHeadAgeSec: 120, minL2Gas: 100_000, maxL2Gas: 1_000_000, ...policy };
  const entry = REVIEWED_DIRECT[op];
  if (!entry) refuse('unsupported-operation', `${op} is not a reviewed operation (no generic fallback)`);
  if (!isAddress(target || '') || !isAddress(from || '')) refuse('bad-input', 'target/from');
  let decoded;
  try { decoded = decodeFunctionData({ abi: entry.abi, data }); } catch { refuse('calldata-mismatch', `not ${entry.fn}(…)`); }
  if (decoded.functionName !== entry.fn) refuse('calldata-mismatch', decoded.functionName);
  const s = snapshot;
  checkHead(s?.head, now, p.maxHeadAgeSec);
  if (lower(s.authorizedAddress) !== lower(from)) refuse('sender-mismatch', `the contract authorizes ${s.authorizedAddress}, the L1 signer would be ${from}`);
  // a contract (Safe, smart wallet) on L1 is aliased: the deposit could never come from this address on L2
  const code = (s.authorizedCode || '0x').toLowerCase();
  if (code !== '0x' && !(size(code) === 23 && code.startsWith('0xef0100'))) refuse('sender-is-contract', 'its L1 deposit would arrive from its alias, not from it');
  // deposits do not check the L2 nonce: an L2-signed transaction for the same intent must be provably resolved first
  for (const a of priorL2Attempts) {
    if (s.included?.map((h) => h.toLowerCase()).includes(String(a.hash).toLowerCase())) refuse('already-included', a.hash);
    if (BigInt(s.accountNonce) <= BigInt(a.nonce) && !entry.stateSetter)
      refuse('ambiguous-duplicate', `L2 transaction ${String(a.hash).slice(0, 18)}… (nonce ${a.nonce}) could still land: account nonce ${s.accountNonce} at the verified head`);
  }
  if (op === 'sessionVault.ownerCall') {
    const [inner, innerData] = decoded.args;
    if (size(innerData) >= 4 && slice(innerData, 0, 4) === '0xac9650d8') refuse('calldata-mismatch', 'ownerCall refuses multicall');
    if (!isAddress(inner)) refuse('calldata-mismatch', 'ownerCall target');
  }
  const gasLimit = checkGas(l2GasLimit, data, p);
  const key = `direct:${network.l2ChainId}:${lower(from)}:${keccak256(concat([getAddress(target), data]))}`;
  const commitment = keccak256(concat([getAddress(target), data]));
  const ambiguousOk = entry.stateSetter && priorL2Attempts.some((a) => BigInt(s.accountNonce) <= BigInt(a.nonce));
  const { replay, entry: rec } = (tracker ?? new ForcedInclusionTracker()).admit(key, commitment, { op });
  return {
    replay, entry: rec,
    plan: {
      format: 'enclave-forced-inclusion/v1', operation: op, key, commitment,
      l1Transaction: { chainId: network.l1ChainId, from: getAddress(from), to: network.portal, value: 0n, data: portalCall(getAddress(target), gasLimit, data) },
      deposit: { to: getAddress(target), value: 0n, mint: 0n, gasLimit, isCreation: false, data, acceptableFrom: [getAddress(from)] },
      binding: { l2ChainId: network.l2ChainId, portal: network.portal, authorized: entry.authorized, head: s.head },
      authorization: [`L1: ONE new transaction on chain ${network.l1ChainId} signed by ${getAddress(from)} itself, sent DIRECTLY to the portal (no relayer, no contract wallet: either would alias the sender). The original Base signature is not used.`],
      funding: ['L1 ETH on that same key: depositTransaction gas plus the portal\'s resource-metering burn for the L2 gas limit', 'no L2 fee (gas price 0); value 0'],
      duplicates: ambiguousOk
        ? 'a reviewed state-setter: an earlier L2-signed attempt may ALSO land; both leave the same state, the second is redundant (events emitted twice)'
        : 'no earlier L2-signed attempt can still land (proven at the verified head); the deposit bumps the account nonce, which also invalidates any copy signed later at that nonce',
      inclusion: `as for every deposit: sequencer adoption of its L1 origin, or forced within ${network.seqWindowL1Blocks} L1 blocks`,
    },
  };
}

/** Operations this module refuses on purpose, with the reason (also what RESULT.md's matrix lists). */
export const UNSUPPORTED = Object.freeze({
  'first-lease (EIP-7702 authorization)': 'a deposit carries no authorization list; the key\'s first lease needs a type-4 transaction on L2',
  'host operator direct calls (registry heartbeat/setPrices/...)': 'the operator key would need L1 ETH (hosts hold none by design)',
  'contract-owned admin (Safe / smart wallet)': 'the portal aliases a contract sender: msg.sender on L2 would not be the owner',
  'value-bearing calls (fundEth, ...)': 'value needs a mint and an L2 balance model; not reviewed',
  'arbitrary user transactions': 'no generic fallback: semantics (nonce, sender, fees) change per contract',
  'host registration (ERC-4337 handleOps)': 'EntryPoint semantics under a deposit not reviewed',
});

// =====================================================================================================================
// Inclusion: the L1 deposit event, then the derived L2 transaction, each from a VERIFIER, never the submitting endpoint
// =====================================================================================================================
/**
 * l1Receipt: the L1 receipt of the plan's L1 transaction, verified by an L1 verifier against an L1 header it bound
 * (l1Proof = {verifiedBy, headerHash}). Exactly one TransactionDeposited log of the portal must match the plan.
 * -> {l2TransactionHash, from, sourceLog}
 */
export function matchDepositEvent(plan, l1Receipt, l1Proof) {
  if (!l1Proof || !['l1-light-client', 'l1-execution-proof'].includes(l1Proof.verifiedBy)) refuse('l1-receipt-unverified');
  if (!l1Receipt || l1Receipt.status !== 'success') refuse('l1-transaction-failed');
  if (lower(l1Receipt.to) !== lower(plan.l1Transaction.to)) refuse('l1-receipt-mismatch', 'to');
  if (l1Receipt.blockHash?.toLowerCase() !== l1Proof.headerHash?.toLowerCase()) refuse('l1-receipt-mismatch', 'block hash vs verified header');
  const logs = extractTransactionDepositedLogs({ logs: l1Receipt.logs.filter((g) => lower(g.address) === lower(plan.l1Transaction.to)) });
  const hits = logs.filter((g) => {
    const d = opaqueDataToDepositData(g.args.opaqueData);
    return lower(g.args.to) === lower(plan.deposit.to) && g.args.version === 0n && d.mint === plan.deposit.mint && d.value === plan.deposit.value
      && d.gas === plan.deposit.gasLimit && d.isCreation === false && d.data.toLowerCase() === plan.deposit.data.toLowerCase()
      && plan.deposit.acceptableFrom.some((f) => lower(f) === lower(g.args.from));
  });
  if (hits.length !== 1) refuse('l1-receipt-mismatch', `${hits.length} matching deposits`);
  return { l2TransactionHash: getL2TransactionHash({ log: hits[0] }), from: getAddress(hits[0].args.from), sourceLog: { blockHash: hits[0].blockHash, logIndex: hits[0].logIndex } };
}

/**
 * The L2 outcome, from a receipt that a VERIFYING client returned (Helios: receipts root of an authenticated block,
 * core/src/execution/providers/rpc.rs get_receipt -> verify_authenticated_block_receipts). The submission endpoint is
 * never asked. -> {state: 'l2-included'|'l2-failed'|'pending', level, receipt}
 *   level 'unsafe': the block is under a sequencer-signed head (the same operator that sequences: not yet L1-derived).
 */
export function classifyL2Outcome({ plan, l2TransactionHash, receipt, head, source, now = Math.floor(Date.now() / 1000), maxHeadAgeSec = 120, reserve,
  verifiers = ['helios'] }) {
  if (!source || !verifiers.includes(source.verifier) || !source.endpoint) refuse('receipt-unverified', 'a receipt counts only from the local verifier');
  if (source.submittedVia && source.submittedVia === source.endpoint) refuse('receipt-not-independent', 'the verifier\'s data endpoint is the submission endpoint');
  checkHead(head, now, maxHeadAgeSec);
  if (!receipt) return { state: 'pending', level: null };
  if (receipt.transactionHash?.toLowerCase() !== l2TransactionHash.toLowerCase()) refuse('receipt-mismatch', 'transaction hash');
  if (receipt.type !== 'deposit' && receipt.type !== '0x7e' && receipt.type !== '0x7E') refuse('receipt-mismatch', `type ${receipt.type}`);
  if (BigInt(receipt.blockNumber) > BigInt(head.number)) refuse('receipt-above-verified-head');
  if (receipt.status !== 'success') return { state: 'l2-failed', level: 'unsafe', receipt };
  if (plan.operation.startsWith('lease.')) {
    const b = plan.binding, kind = Number(b.lease.kind);
    const paid = receipt.logs.filter((g) => lower(g.address) === lower(reserve ?? b.reserve)).map((g) => {
      try { return decodeEventLog({ abi: RESERVE_ABI, data: g.data, topics: g.topics }); } catch { return null; }
    }).filter((e) => e?.eventName === 'LeaseGasPaid');
    if (paid.length !== 1 || paid[0].args.id.toLowerCase() !== b.lease.id.toLowerCase() || lower(paid[0].args.operator) !== lower(b.operator)
        || lower(paid[0].args.payee) !== lower(b.lease.payee) || Number(paid[0].args.kind) !== kind) refuse('receipt-mismatch', 'LeaseGasPaid event');
    return { state: 'l2-included', level: 'unsafe', receipt, charged: paid[0].args };
  }
  return { state: 'l2-included', level: 'unsafe', receipt };
}
