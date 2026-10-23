// HOST LEASE-SIGNING POLICY with an OPT-IN forced-inclusion route. Pure ESM on viem only: the same module serves the
// Linux and Windows hosts (no platform code). It produces the SAME request shape the existing executor client signs
// (client/lease-executor-client.mjs: want = {id, kind, enclaveId, nonce, deadline, maxChargeWei}, plus the relay's
// payee) and the EIP-712 typed data for it; it never signs and never changes any on-chain configuration.
//
//   route 'relay' (default, unchanged): deadline = head + 300 s, exactly today's ttlSec. Passing forced-inclusion
//     options with this route is refused, so a long deadline can never be produced silently.
//   route 'l1-deposit' (explicit opt-in): one named operation, one inclusion window the host chose, one owner budget.
//     The deadline is head + that window, bounded by the protocol's worst case (the sequencing window plus a margin);
//     the charge never exceeds the owner's per-operation cap; a renew is refused when the owner's renewWindow, or the
//     lease time left, is shorter than the window (the policy never proposes changing it); release only where the
//     owner sponsors it. The result says plainly whether lease CONTINUITY can be guaranteed: it cannot when the
//     protocol's worst-case inclusion time exceeds the lease the ledger grants.
import { getAddress, isAddress } from 'viem';
import { BASE_MAINNET, ForcedInclusionTracker, LEASE_KIND, RESERVE_STATUS, refuse } from './forced-inclusion.mjs';

export const NORMAL_TTL_SEC = 300;                        // client/lease-executor-client.mjs ttlSec
const L1_BLOCK_SEC = 12;
export const RESERVE_POLICY_ABI = [
  { type: 'function', name: 'reserveOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'tuple', components: [
    { name: 'balanceWei', type: 'uint128' }, { name: 'maxPerOpWei', type: 'uint64' }, { name: 'epochCapWei', type: 'uint64' }, { name: 'enabled', type: 'bool' }, { name: 'claimPolicy', type: 'uint8' },
    { name: 'sponsorRelease', type: 'bool' }, { name: 'renewWindow', type: 'uint32' }, { name: 'minExtension', type: 'uint32' }, { name: 'claimCooldown', type: 'uint32' }, { name: 'epochSec', type: 'uint32' },
    { name: 'maxGasPrice', type: 'uint64' }, { name: 'maxClaimsPerEpoch', type: 'uint8' }, { name: 'epochIndex', type: 'uint32' }, { name: 'epochSpentWei', type: 'uint96' }, { name: 'epochClaims', type: 'uint8' },
    { name: 'lastClaimAt', type: 'uint64' }, { name: 'lastClaimOperator', type: 'address' }] }] },
  { type: 'function', name: 'statusOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'address' }],
    outputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
];
const LEDGER_ABI = [
  { type: 'function', name: 'leaseSec', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'id', type: 'bytes32' }, { name: 'owner', type: 'address' }, { name: 'appRef', type: 'string' }, { name: 'ports', type: 'string' }, { name: 'configCid', type: 'string' },
    { name: 'gpuMilli', type: 'uint16' }, { name: 'cpuMilli', type: 'uint16' }, { name: 'appPort', type: 'uint32' }, { name: 'isPublic', type: 'bool' }, { name: 'active', type: 'bool' },
    { name: 'createdAt', type: 'uint64' }, { name: 'rate', type: 'uint256' }, { name: 'balance6', type: 'uint256' }, { name: 'spent6', type: 'uint256' }, { name: 'runner', type: 'bytes32' },
    { name: 'runnerOperator', type: 'address' }, { name: 'leaseUntil', type: 'uint64' }] }] },
];
const NONCE_ABI = [{ type: 'function', name: 'nonceOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint64' }] }];

/** Protocol worst case for a deposit to land: the sequencing window, in seconds (Base: 3600 L1 blocks ~ 12 h). */
export const protocolMaxInclusionSec = (network = BASE_MAINNET) => network.seqWindowL1Blocks * L1_BLOCK_SEC;

/** The facts the policy needs, pinned to ONE verified head (EIP-1898) through a VERIFYING client. */
export async function readSigningContext({ client, head, pins, id, kind, enclaveId, operator }) {
  const at = { blockHash: head.hash };
  const r = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, ...at });
  const row = await r(pins.ledger, LEDGER_ABI, 'get', [id]);
  const [reserve, status, leaseSec, nonce] = await Promise.all([r(pins.reserve, RESERVE_POLICY_ABI, 'reserveOf', [id, row.owner]),
    r(pins.reserve, RESERVE_POLICY_ABI, 'statusOf', [id, kind, enclaveId, operator]), r(pins.ledger, LEDGER_ABI, 'leaseSec'), r(operator, NONCE_ABI, 'nonceOf', [id]).catch(() => 0n)]);
  return { head, id, owner: row.owner, leaseUntil: row.leaseUntil, leaseSec, reserve, status: status[0], executorNonce: nonce };
}

/**
 * -> {route, want: {id, kind, enclaveId, nonce, deadline, maxChargeWei}, payee, typedData, continuity, disclosure}
 * operation: 'claim' | 'renew' | 'release'. forced (route 'l1-deposit' only): {optIn: true, operation, inclusionWindowSec,
 * portal, maxChargeWei}. context: readSigningContext(). tracker: the host's ForcedInclusionTracker (no second open lease).
 */
export function leaseSigningIntent({ network = BASE_MAINNET, route = 'relay', operation, operator, enclaveId = '0x' + '00'.repeat(32), payee, maxChargeWei,
  context, pins, forced, tracker, policy = {} }) {
  const p = { minInclusionSec: 900, maxInclusionMarginSec: 600, ...policy };
  const kind = LEASE_KIND[operation];
  if (!kind) refuse('unsupported-operation', String(operation));
  if (!isAddress(operator || '') || !isAddress(payee || '') || !isAddress(pins?.reserve || '')) refuse('bad-input', 'operator/payee/pins');
  const c = context;
  if (!c?.head || !['signed-head', 'ancestor'].includes(c.head.verifiedBy)) refuse('unverified-head');
  const typed = (want) => ({ domain: { name: 'EnclaveLeaseExecutor', version: '1', chainId: network.l2ChainId, verifyingContract: getAddress(operator) },
    types: { Lease: [{ name: 'reserve', type: 'address' }, { name: 'id', type: 'bytes32' }, { name: 'kind', type: 'uint8' }, { name: 'enclaveId', type: 'bytes32' },
      { name: 'nonce', type: 'uint64' }, { name: 'deadline', type: 'uint64' }, { name: 'payee', type: 'address' }, { name: 'maxChargeWei', type: 'uint256' }] },
    primaryType: 'Lease', message: { reserve: getAddress(pins.reserve), ...want, payee: getAddress(payee) } });
  const base = { id: c.id, kind, enclaveId: kind === 1 ? enclaveId : '0x' + '00'.repeat(32), nonce: BigInt(c.executorNonce) };
  if (route === 'relay') {
    if (forced !== undefined) refuse('forced-options-without-forced-route', 'a long-lived authorization needs the explicit l1-deposit route');
    const want = { ...base, deadline: BigInt(c.head.timestamp + NORMAL_TTL_SEC), maxChargeWei: BigInt(maxChargeWei) };
    return { route, want, payee: getAddress(payee), typedData: typed(want), continuity: null, disclosure: 'unchanged relay path: the lease expires 300 s after the head' };
  }
  if (route !== 'l1-deposit') refuse('unsupported-route', String(route));
  if (!forced || forced.optIn !== true) refuse('not-opted-in', 'the forced route needs an explicit opt-in');
  if (forced.operation !== operation) refuse('operation-mismatch', 'the opt-in names a different operation');
  if (!isAddress(forced.portal || '') || getAddress(forced.portal) !== network.portal) refuse('route-mismatch', 'not the pinned portal');
  const window = Number(forced.inclusionWindowSec), maxWindow = protocolMaxInclusionSec(network) + p.maxInclusionMarginSec;
  if (!Number.isInteger(window) || window < p.minInclusionSec || window > maxWindow) refuse('inclusion-window-out-of-range', `${forced.inclusionWindowSec} s (allowed ${p.minInclusionSec}..${maxWindow})`);
  const r = c.reserve;
  if (!r?.enabled) refuse('reserve-disabled', 'the owner has not enabled sponsorship');
  const budget = BigInt(forced.maxChargeWei);
  if (budget > BigInt(r.maxPerOpWei)) refuse('over-owner-budget', `maxChargeWei ${budget} > the owner's per-operation cap ${r.maxPerOpWei}`);
  if (RESERVE_STATUS[Number(c.status)] !== 'Ready') refuse('reserve-refuses', RESERVE_STATUS[Number(c.status)]);
  if (operation === 'release' && !r.sponsorRelease) refuse('release-not-sponsored');
  if (operation === 'renew') {
    if (Number(r.renewWindow) < window) refuse('renew-window-too-short', `the owner's renewWindow is ${r.renewWindow} s, the inclusion window ${window} s (the policy does not change it)`);
    const left = Number(c.leaseUntil) - c.head.timestamp;
    if (left < window) refuse('lease-ends-before-inclusion', `${left} s left on the lease, inclusion window ${window} s`);
  }
  const key = `lease:${network.l2ChainId}:${getAddress(operator).toLowerCase()}:${String(c.id).toLowerCase()}`;
  if (tracker && ForcedInclusionTracker.open(tracker.get(key))) refuse('ambiguous-duplicate', 'an earlier lease authorization for this deployment is unresolved');
  const want = { ...base, deadline: BigInt(c.head.timestamp + window), maxChargeWei: budget };
  const worst = protocolMaxInclusionSec(network);
  const continuity = {
    guaranteed: false,
    leaseSec: Number(c.leaseSec), protocolMaxInclusionSec: worst, inclusionWindowSec: window,
    reason: worst > Number(c.leaseSec)
      ? `the protocol may delay a deposit up to ${worst} s, longer than the ${c.leaseSec}-s lease the ledger grants: a withholding sequencer can let the lease lapse before the renew lands`
      : window < worst ? `the chosen window (${window} s) is below the protocol worst case (${worst} s): a later inclusion fails as Expired and the lease must be re-claimed`
        : 'inclusion within the window is protocol-guaranteed only if the L1 transaction itself lands at once',
  };
  return { route, want, payee: getAddress(payee), typedData: typed(want), continuity,
    disclosure: `OPT-IN forced inclusion of ONE ${operation}: valid until ${want.deadline} (head + ${window} s), at most ${budget} wei from the app's reserve; single-use executor nonce ${want.nonce}; outstanding until that nonce is used or the deadline passes` };
}
