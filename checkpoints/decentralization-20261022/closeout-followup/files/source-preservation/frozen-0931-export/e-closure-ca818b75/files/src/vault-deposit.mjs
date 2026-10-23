// FORCED-INCLUSION PLANS for the SIGNATURE-AUTHORIZED SessionVault and USDC (EIP-3009) operations: STRICT, UNSIGNED.
// Same shape as the host's lease (src/forced-inclusion.mjs): the operation's own signed payload carries a single-use
// nonce and an expiry, the contract never reads the outer sender for it, so ANY funded L1 account may submit it as an
// OptimismPortal deposit and the authorization is exactly the signer's. Sources: contracts/SessionVault.sol (the
// production legacy vault's source, keccak 0xa2a0…6ec8) and the live ledger rev 16d fundWithAuthorization.
//
// What is checked at ONE verified Base head (readVaultSnapshot) before anything is planned:
//   * the vault is an EIP-1167 clone of the pinned implementation, minted by the pinned factory (isVault);
//   * its owner is a PLAIN EOA (or a 7702-delegated EOA: the vault tries ECDSA first). A contract owner (Safe) signs
//     through ERC-1271, which this module cannot check offline: refused, never a transparent fallback;
//   * the EIP-712 domain is exactly {Enclave Sessions, 1, 8453, vault}; the owner signature recovers to the owner with
//     the vault's own rules (low s, v 27/28 only); the session-key P-256 signature verifies (node:crypto) over
//     sha256(digest) for the key whose keccak256(x, y) is the session's keyHash;
//   * single use: ownerNonceUsed[opNonce] false; seqOf[sid][lane] = the nonce's sequence; authorizationState false;
//   * expiry: signBefore / deadline / validBefore leave the inclusion margin, validAfter has passed, the session is live
//     long enough, the action is in the session's bitmask, fee <= maxFee6, amount + fee within its budget;
//   * recipients: release only to the owner or the owner's vault at the book's CURRENT factory (the vault's own rule);
//     USDC moves only from the owner (topUp) or the payer (fund) to the contract itself.
// One hazard specific to the vault: `_ownerAuth` and `_checkGrantAuth` return early when msg.sender == owner, WITHOUT
// consuming opNonce. A deposit whose L2 sender is the owner would therefore execute as a direct owner call (no nonce,
// no expiry) and could duplicate the same signed operation sent through the ordinary L2 path. Plans refuse an L1
// sender that is (or aliases to) the owner.
import { createPublicKey, verify as p256verify } from 'node:crypto';
import {
  concat, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, hexToBigInt, isAddress, isHex, keccak256, parseAbi,
  recoverTypedDataAddress, size, slice, toBytes, zeroAddress,
} from 'viem';
import { BASE_MAINNET, ForcedInclusionTracker, applyL1ToL2Alias, checkGas, checkHead, portalCall, refuse } from './forced-inclusion.mjs';

const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
const HASH = /^0x[0-9a-f]{64}$/i;
const lower = (a) => getAddress(a).toLowerCase();
const u = (v, n) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { return refuse('bad-input', n); } };

export const VAULT_ABI = parseAbi([
  'struct Session { bytes32 keyHash; bytes32 measurement; uint256 actions; uint64 expiresAt; uint64 epoch; uint8 envs; uint8 state; bool anyApp; uint128 balance6; uint128 spent6; uint128 perPeriod6; uint128 maxFee6; uint128 maxAppFeeHour6; uint128 maxRateHour6; uint64 periodStart; uint32 period; uint32 opsPerPeriod; uint128 periodSpent6; uint32 periodOps; }',
  'function owner() view returns (address)', 'function epoch() view returns (uint64)', 'function free() view returns (uint256)',
  'function factory() view returns (address)', 'function book() view returns (address)', 'function usdc() view returns (address)', 'function maxVault6() view returns (uint256)',
  'function ownerNonceUsed(bytes32) view returns (bool)', 'function seqOf(bytes32, uint192) view returns (uint64)',
  'function held(bytes32) view returns (uint8 env, bytes32 promoted, bytes32 createdBy)',
  'function sessionOf(bytes32 sid) view returns (Session s, bool live, bytes32[] apps)',
  'function topUp(bytes32 sid, uint256 amount, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function topUpWithAuthorization(bytes32 sid, uint256 amount, bytes32 opNonce, uint256 validAfter, uint64 validBefore, bytes authSig)',
  'function extend(bytes32 sid, uint64 expiresAt, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function terminate(bytes32 sid, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function revokeAll(bool alsoWithdraw, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function withdraw(uint256 amount, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function adopt(bytes32 id, string environment, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function setEnvironment(bytes32 id, string environment, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function release(bytes32 id, address to, bytes32 opNonce, uint64 signBefore, bytes sig)',
  'function execute(bytes32 sid, uint256 nonce, uint8 action, bytes args, uint256 fee, uint64 deadline, uint256 x, uint256 y, bytes32 r, bytes32 sv) returns (bytes)',
  'function terminateBySession(bytes32 sid, uint64 deadline, uint256 x, uint256 y, bytes32 r, bytes32 sv)',
]);
export const FACTORY_ABI = parseAbi(['function implementation() view returns (address)', 'function isVault(address) view returns (bool)', 'function vaultFor(address) view returns (address)']);
export const BOOK_ABI = parseAbi(['function addr(bytes32) view returns (address)']);
export const TOKEN_ABI = parseAbi(['function name() view returns (string)', 'function version() view returns (string)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address, bytes32) view returns (bool)', 'function balanceOf(address) view returns (uint256)']);
export const LEDGER_FUND_ABI = parseAbi(['function fundWithAuthorization(bytes32 id, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)']);

/** EIP-712 types, field for field from SessionVault's *_TYPEHASH constants. */
export const OWNER_TYPES = {
  topUp: { TopUp: [{ name: 'sessionId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
  extend: { Extend: [{ name: 'sessionId', type: 'bytes32' }, { name: 'expiresAt', type: 'uint64' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
  terminate: { Terminate: [{ name: 'sessionId', type: 'bytes32' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
  revokeAll: { RevokeAll: [{ name: 'withdraw', type: 'bool' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
  withdraw: { Withdraw: [{ name: 'amount', type: 'uint256' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
  adopt: { Adopt: [{ name: 'deployment', type: 'bytes32' }, { name: 'environment', type: 'string' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
  setEnvironment: { SetEnvironment: [{ name: 'deployment', type: 'bytes32' }, { name: 'environment', type: 'string' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
  release: { Release: [{ name: 'deployment', type: 'bytes32' }, { name: 'to', type: 'address' }, { name: 'opNonce', type: 'bytes32' }, { name: 'signBefore', type: 'uint64' }] },
};
export const CALL_TYPES = { SessionCall: [{ name: 'sessionId', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'action', type: 'uint8' }, { name: 'argsHash', type: 'bytes32' },
  { name: 'fee', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] };
export const END_TYPES = { SessionEnd: [{ name: 'sessionId', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }] };
export const RECEIVE_TYPES = { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
const ACT_LAST = 8, ACT_CREATE = 0, ACT_FUND = 1;
export const vaultDomain = (network, vault) => ({ name: 'Enclave Sessions', version: '1', chainId: network.l2ChainId, verifyingContract: getAddress(vault) });
/** EIP-1167 runtime the factory deploys (SessionVaultFactory._cloneCode minus its 10-byte constructor). */
export const cloneRuntime = (impl) => concat(['0x363d3d373d3d3d363d73', getAddress(impl), '0x5af43d82803e903d91602b57fd5bf3']).toLowerCase();
const isPlainOrDelegatedEoa = (code) => { code = (code || '0x').toLowerCase(); return code === '0x' || (size(code) === 23 && code.startsWith('0xef0100')); };

/**
 * Everything a vault plan reads, pinned to ONE verified head (EIP-1898) through a VERIFYING client (Helios).
 * opt: {sid, opNonce, lane, deployment, token} (only what the operation needs).
 */
export async function readVaultSnapshot({ client, head, pins, vault, sid, opNonce, lane, deployment, l1Sender }) {
  const at = { blockHash: head.hash };
  const r = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, ...at });
  const [code, owner, epoch, free, factory, book, usdc, maxVault6, isVault, impl] = await Promise.all([
    client.getCode({ address: vault, ...at }), r(vault, VAULT_ABI, 'owner'), r(vault, VAULT_ABI, 'epoch'), r(vault, VAULT_ABI, 'free'), r(vault, VAULT_ABI, 'factory'),
    r(vault, VAULT_ABI, 'book'), r(vault, VAULT_ABI, 'usdc'), r(vault, VAULT_ABI, 'maxVault6'), r(pins.factory, FACTORY_ABI, 'isVault', [vault]), r(pins.factory, FACTORY_ABI, 'implementation')]);
  const out = { head, vault: getAddress(vault), code: code ?? '0x', owner, ownerCode: (await client.getCode({ address: owner, ...at })) ?? '0x', epoch, free, factory, book, usdc, maxVault6, isVault, factoryImplementation: impl };
  if (sid) { const [s, live] = await r(vault, VAULT_ABI, 'sessionOf', [sid]); out.session = s; out.sessionLive = live; }
  if (opNonce) out.ownerNonceUsed = await r(vault, VAULT_ABI, 'ownerNonceUsed', [opNonce]);
  if (sid && lane !== undefined) out.seq = await r(vault, VAULT_ABI, 'seqOf', [sid, lane]);
  if (deployment) { const h = await r(vault, VAULT_ABI, 'held', [deployment]); out.held = { env: h[0] }; out.heldId = deployment; }
  const bookFactory = await r(book, BOOK_ABI, 'addr', ['0x' + Buffer.from('sessionVaultFactory').toString('hex').padEnd(64, '0')]);
  out.bookFactory = bookFactory;
  out.ownerVaultAtBookFactory = bookFactory === zeroAddress ? zeroAddress : await r(bookFactory, FACTORY_ABI, 'vaultFor', [owner]);
  out.vaultUsdcBalance = await client.readContract({ address: usdc, abi: TOKEN_ABI, functionName: 'balanceOf', args: [vault], ...at });
  out.ownerAccountNonce = BigInt(await client.request({ method: 'eth_getTransactionCount', params: [owner, { blockHash: head.hash }] }));
  if (l1Sender) out.l1Sender = l1Sender;
  return out;
}
/** The token facts a 3009 plan needs, at the same verified head: domain, (from, nonce) state, the payer's balance and
 *  code, and for a ledger funding whether the deployment is active. */
export async function readTokenSnapshot({ client, head, token, from, nonce, ledger, deployment }) {
  const at = { blockHash: head.hash };
  const r = (functionName, args = []) => client.readContract({ address: token, abi: TOKEN_ABI, functionName, args, ...at });
  const [name, version, separator, holderBalance, authorizationUsed, holderCode] = await Promise.all([r('name'), r('version'), r('DOMAIN_SEPARATOR'),
    r('balanceOf', [from]), r('authorizationState', [from, nonce]), client.getCode({ address: from, ...at })]);
  const out = { head, address: getAddress(token), name, version, separator, holderBalance, authorizationUsed, holderCode: holderCode ?? '0x' };
  if (ledger && deployment) {
    const row = await client.readContract({ address: ledger, abi: parseAbi(['struct D { bytes32 id; address owner; string appRef; string ports; string configCid; uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt; uint256 rate; uint256 balance6; uint256 spent6; bytes32 runner; address runnerOperator; uint64 leaseUntil; }',
      'function get(bytes32 id) view returns (D)']), functionName: 'get', args: [deployment], ...at });
    out.deploymentActive = row.active === true && row.id.toLowerCase() === deployment.toLowerCase();
  }
  return out;
}

function checkVault(s, pins, network, now, p) {
  checkHead(s?.head, now, p.maxHeadAgeSec);
  if (!isAddress(pins?.factory || '') || !isAddress(pins?.implementation || '')) refuse('no-pins');
  if (lower(s.factoryImplementation) !== lower(pins.implementation)) refuse('pin-mismatch', 'factory implementation');
  if (s.code.toLowerCase() !== cloneRuntime(pins.implementation)) refuse('not-a-vault', 'code is not the pinned clone');
  if (!s.isVault || lower(s.factory) !== lower(pins.factory)) refuse('not-a-vault', 'not minted by the pinned factory');
  if (!isPlainOrDelegatedEoa(s.ownerCode)) refuse('owner-is-contract', 'an ERC-1271 owner (Safe) is not checkable offline: not a transparent fallback');
}
/** _ownerAuth / _checkGrantAuth skip the nonce for msg.sender == owner: the deposit must not come from the owner. */
function checkNotOwnerSender(l1Sender, owner) {
  if (!isAddress(l1Sender || '')) refuse('bad-input', 'l1Sender');
  if (lower(l1Sender) === lower(owner) || lower(applyL1ToL2Alias(l1Sender)) === lower(owner))
    refuse('sender-is-owner', 'a deposit from the owner runs as a DIRECT owner call: no opNonce, no expiry, duplicable');
}
function checkEcdsaRules(sig) {
  if (!isHex(sig) || size(sig) !== 65) refuse('bad-signature', 'not 65 bytes');
  const v = Number(hexToBigInt(slice(sig, 64, 65))), s = hexToBigInt(slice(sig, 32, 64));
  if (![27, 28].includes(v) || s > HALF_N) refuse('bad-signature', 'the vault accepts only low-s, v 27/28');
}
function finish({ network, target, data, l1Sender, l2GasLimit, tracker, key, p, op, binding, authorization, duplicates }) {
  const gasLimit = checkGas(l2GasLimit, data, p);
  const commitment = keccak256(data);
  const { replay, entry } = (tracker ?? new ForcedInclusionTracker()).admit(key, commitment, { op });
  return { replay, entry, plan: {
    format: 'enclave-forced-inclusion/v1', operation: op, key, commitment,
    l1Transaction: { chainId: network.l1ChainId, from: getAddress(l1Sender), to: network.portal, value: 0n, data: portalCall(getAddress(target), gasLimit, data) },
    deposit: { to: getAddress(target), value: 0n, mint: 0n, gasLimit, isCreation: false, data, acceptableFrom: [getAddress(l1Sender), applyL1ToL2Alias(l1Sender)] },
    binding: { l2ChainId: network.l2ChainId, portal: network.portal, ...binding },
    authorization: [...authorization, `L1: ONE new transaction on chain ${network.l1ChainId} from ${getAddress(l1Sender)} (any funded L1 account other than the owner; it gains no authority)`],
    funding: ['L1 ETH paid by the L1 sender: depositTransaction gas plus the portal\'s resource burn (gas limit x its resource base fee); NOT reimbursed by any existing contract', 'no L2 fee (gas price 0); value 0'],
    duplicates, inclusion: `sequencer adoption of the deposit's L1 origin, or forced within ${network.seqWindowL1Blocks} L1 blocks`,
  } };
}

const OWNER_FN = { topUp: (m, sig) => [m.sessionId, m.amount, m.opNonce, m.signBefore, sig], extend: (m, sig) => [m.sessionId, m.expiresAt, m.opNonce, m.signBefore, sig],
  terminate: (m, sig) => [m.sessionId, m.opNonce, m.signBefore, sig], revokeAll: (m, sig) => [m.withdraw, m.opNonce, m.signBefore, sig],
  withdraw: (m, sig) => [m.amount, m.opNonce, m.signBefore, sig], adopt: (m, sig) => [m.deployment, m.environment, m.opNonce, m.signBefore, sig],
  setEnvironment: (m, sig) => [m.deployment, m.environment, m.opNonce, m.signBefore, sig], release: (m, sig) => [m.deployment, m.to, m.opNonce, m.signBefore, sig] };

/**
 * An owner-SIGNED vault operation (topUp, extend, terminate, revokeAll, withdraw, adopt, setEnvironment, release).
 * message: the typed message exactly as signed (sessionId/amount/expiresAt/withdraw/deployment/environment/to,
 * opNonce, signBefore). -> {plan, replay} or throws Refused.
 */
export async function planVaultOwnerOp({ network = BASE_MAINNET, pins, op, message, signature, snapshot, l1Sender, l2GasLimit, tracker,
  priorDirectAttempts = [], now = Math.floor(Date.now() / 1000), policy = {} }) {
  const p = { maxHeadAgeSec: 120, minDeadlineMarginSec: 3600, minL2Gas: 150_000, maxL2Gas: 1_500_000, ...policy };
  if (!OWNER_TYPES[op]) refuse('unsupported-operation', `${op} is not a reviewed owner-signed vault operation`);
  const s = snapshot;
  checkVault(s, pins, network, now, p);
  checkNotOwnerSender(l1Sender, s.owner);
  checkEcdsaRules(signature);
  const m = { ...message };
  if (!HASH.test(m.opNonce || '')) refuse('bad-input', 'opNonce');
  const signBefore = u(m.signBefore, 'signBefore');
  const [primaryType] = Object.keys(OWNER_TYPES[op]);
  const signer = await recoverTypedDataAddress({ domain: vaultDomain(network, s.vault), types: OWNER_TYPES[op], primaryType, message: m, signature });
  if (lower(signer) !== lower(s.owner)) refuse('bad-signature', `recovers ${signer}, not the vault owner`);
  if (s.ownerNonceUsed !== false) refuse('replayed-authorization', 'opNonce already used (or unread)');
  if (signBefore < BigInt(s.head.timestamp + p.minDeadlineMarginSec)) refuse('deadline-too-close', `signBefore ${signBefore} < head + ${p.minDeadlineMarginSec}`);
  // the operation's own preconditions at the head (a revert later is harmless, but never plan a known failure)
  const live = s.sessionLive === true, sess = s.session;
  if (['topUp', 'extend'].includes(op) && !live) refuse('session-not-live');
  if (op === 'terminate' && !(sess && sess.state === 1 && sess.epoch === s.epoch)) refuse('session-not-live', 'already ended or revoked');
  if (op === 'topUp' && u(m.amount, 'amount') > s.free) refuse('over-budget', `amount > the vault's free balance ${s.free}`);
  if (op === 'withdraw' && u(m.amount, 'amount') > s.free) refuse('over-budget', `amount > the vault's free balance ${s.free}`);
  if (op === 'extend' && u(m.expiresAt, 'expiresAt') <= BigInt(s.head.timestamp + p.minDeadlineMarginSec)) refuse('deadline-too-close', 'the new expiry would pass before the deposit lands');
  if (['adopt', 'setEnvironment'].includes(op) && !['staging', 'prod'].includes(m.environment)) refuse('bad-input', 'environment');
  if (op === 'adopt' && s.held?.env !== 0) refuse('precondition', 'already held');
  if (op === 'setEnvironment' && !s.held?.env) refuse('precondition', 'not held');
  if (op === 'release' && lower(m.to) !== lower(s.owner) && !(s.ownerVaultAtBookFactory !== zeroAddress && lower(m.to) === lower(s.ownerVaultAtBookFactory) && lower(m.to) !== lower(s.vault)))
    refuse('release-recipient', 'only the owner or the owner\'s vault at the book\'s current factory');
  // an owner DIRECT call for the same intent (no nonce) that could still land makes the outcome ambiguous
  for (const a of priorDirectAttempts) if (s.ownerAccountNonce === undefined || BigInt(s.ownerAccountNonce) <= BigInt(a.nonce))
    refuse('ambiguous-duplicate', `owner direct transaction ${String(a.hash).slice(0, 18)}… (nonce ${a.nonce}) could still land`);
  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: op, args: OWNER_FN[op](m, signature) });
  return finish({ network, target: s.vault, data, l1Sender, l2GasLimit, tracker, p, op: `sessionVault.${op}`,
    key: `vault-owner:${network.l2ChainId}:${lower(s.vault)}:${m.opNonce.toLowerCase()}`,
    binding: { vault: s.vault, owner: getAddress(s.owner), op, message: JSON.parse(JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v))), head: s.head },
    authorization: [`L2: the vault owner's existing EIP-712 ${primaryType} signature (domain Enclave Sessions/1/${network.l2ChainId}/${s.vault}), single-use opNonce`],
    duplicates: 'the opNonce is single-use: whichever copy (ordinary L2 relay or this deposit) executes first consumes it; the other reverts NonceUsed. Never from the owner\'s own address (that path skips the nonce).' });
}

/** sha256(digest) checked against a P-256 key (x, y), exactly the vault's P256VERIFY call, with node:crypto. */
function p256Valid(digest, { x, y, r, s }) {
  const b64u = (v) => Buffer.from(toBytes(v, { size: 32 })).toString('base64url');
  let key;
  try { key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' }); } catch { return false; }
  return p256verify('sha256', Buffer.from(toBytes(digest)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.concat([Buffer.from(toBytes(r, { size: 32 })), Buffer.from(toBytes(s, { size: 32 }))]));
}
const keyHashOf = ({ x, y }) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(x), BigInt(y)]));

/**
 * A SESSION-KEY operation: execute(sid, nonce, action, args, fee, deadline, x, y, r, s) or terminateBySession.
 * call: {sid, nonce, action, args, fee, deadline} (or {sid, deadline, end: true}); key: {x, y, r, s}.
 */
export function planSessionCall({ network = BASE_MAINNET, pins, call, key, snapshot, l1Sender, l2GasLimit, tracker, now = Math.floor(Date.now() / 1000), policy = {} }) {
  const p = { maxHeadAgeSec: 120, minDeadlineMarginSec: 3600, minL2Gas: 150_000, maxL2Gas: 3_000_000, ...policy };
  const s = snapshot;
  checkVault(s, pins, network, now, p);
  if (!isAddress(l1Sender || '')) refuse('bad-input', 'l1Sender');
  const sess = s.session;
  if (!s.sessionLive || !sess) refuse('session-not-live');
  if (sess.epoch !== s.epoch) refuse('session-not-live', 'revoked (stale epoch)');
  const deadline = u(call.deadline, 'deadline');
  if (deadline < BigInt(s.head.timestamp + p.minDeadlineMarginSec)) refuse('deadline-too-close');
  if (BigInt(sess.expiresAt) < BigInt(s.head.timestamp + p.minDeadlineMarginSec)) refuse('session-expires-first', `the session ends at ${sess.expiresAt}`);
  if (keyHashOf(key).toLowerCase() !== sess.keyHash.toLowerCase()) refuse('bad-signature', 'not this session\'s key');
  const domain = vaultDomain(network, s.vault);
  if (call.end) {
    const digest = hashTypedData({ domain, types: END_TYPES, primaryType: 'SessionEnd', message: { sessionId: call.sid, deadline } });
    if (!p256Valid(digest, key)) refuse('bad-signature', 'P-256');
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'terminateBySession', args: [call.sid, deadline, BigInt(key.x), BigInt(key.y), key.r, key.s] });
    return finish({ network, target: s.vault, data, l1Sender, l2GasLimit, tracker, p, op: 'sessionVault.terminateBySession', key: `vault-session:${network.l2ChainId}:${lower(s.vault)}:${call.sid}:end`,
      binding: { vault: s.vault, sid: call.sid, deadline: deadline.toString(), head: s.head }, authorization: ['L2: the session key\'s P-256 SessionEnd signature'],
      duplicates: 'one effect: the first ends the session, any copy then reverts NotLive' });
  }
  const nonce = u(call.nonce, 'nonce'), action = Number(call.action), fee = u(call.fee, 'fee');
  if (!Number.isInteger(action) || action < 0 || action > ACT_LAST) refuse('unsupported-action', String(call.action));
  if (((BigInt(sess.actions) >> BigInt(action)) & 1n) !== 1n) refuse('action-not-permitted', `action ${action} is not in the session's grant`);
  if (s.seq === undefined || BigInt(s.seq) !== (nonce & ((1n << 64n) - 1n))) refuse('replayed-authorization', `lane sequence is ${s.seq}, call has ${nonce & ((1n << 64n) - 1n)}`);
  if (fee > BigInt(sess.maxFee6)) refuse('fee-too-high');
  if (!isHex(call.args)) refuse('bad-input', 'args');
  let amount = 0n;
  if (action === ACT_FUND) amount = BigInt(decodeArgs(['bytes32', 'uint256'], call.args)[1]);
  if (action === ACT_CREATE || action === 8) refuse('unsupported-action', 'create/publish: their args (catalog, fees, rate caps) are not reviewed here');
  // every other action names a deployment first: it must be held by THIS vault, in an environment the grant allows
  const target = slice(call.args, 0, 32).toLowerCase();
  if (!s.held || String(s.heldId).toLowerCase() !== target) refuse('unauthorized-target', 'the snapshot does not cover the deployment the call names');
  if (!s.held.env || (Number(sess.envs) & Number(s.held.env)) === 0) refuse('unauthorized-target', `deployment ${target.slice(0, 18)}… is not held in an environment this session may touch`);
  if (amount + fee > BigInt(sess.balance6)) refuse('over-budget', `amount + fee > session balance ${sess.balance6}`);
  const digest = hashTypedData({ domain, types: CALL_TYPES, primaryType: 'SessionCall', message: { sessionId: call.sid, nonce, action, argsHash: keccak256(call.args), fee, deadline } });
  if (!p256Valid(digest, key)) refuse('bad-signature', 'P-256');
  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'execute', args: [call.sid, nonce, action, call.args, fee, deadline, BigInt(key.x), BigInt(key.y), key.r, key.s] });
  return finish({ network, target: s.vault, data, l1Sender, l2GasLimit, tracker, p, op: 'sessionVault.execute', key: `vault-session:${network.l2ChainId}:${lower(s.vault)}:${call.sid}:${nonce}`,
    binding: { vault: s.vault, sid: call.sid, nonce: nonce.toString(), action, argsHash: keccak256(call.args), fee: fee.toString(), deadline: deadline.toString(), head: s.head },
    authorization: ['L2: the session key\'s existing P-256 SessionCall signature (the grant\'s action, app, environment, budget and period limits apply on chain)'],
    duplicates: 'the (lane, sequence) nonce is single-use: any other copy reverts BadNonce' });
}
function decodeArgs(types, data) {
  const words = []; for (let i = 0; i < types.length; i++) words.push(slice(data, i * 32, i * 32 + 32));
  return words;
}

/**
 * USDC EIP-3009 authorizations whose payee is the contract itself (FiatTokenV2_2: to == msg.sender):
 *   kind 'topUpWithAuthorization': the vault owner funds a live session; nonce = the TopUp digest (validBefore as
 *     signBefore) so the authorization funds that top-up only;
 *   kind 'ledger.fundWithAuthorization': a payer funds a deployment on the live ledger rev 16d; bytes16(nonce) == id.
 * auth: {from, value, validAfter, validBefore, nonce, signature}; tokenSnapshot: {head, address, name, version,
 * separator, authorizationUsed, holderBalance}; plus the vault snapshot for the top-up.
 */
export async function planUsdcAuthorization({ network = BASE_MAINNET, pins, kind, auth, sid, opNonce, deployment, ledger, snapshot, token, l1Sender, l2GasLimit, tracker,
  now = Math.floor(Date.now() / 1000), policy = {} }) {
  const p = { maxHeadAgeSec: 120, minDeadlineMarginSec: 3600, minL2Gas: 150_000, maxL2Gas: 1_500_000, ...policy };
  checkHead(token?.head, now, p.maxHeadAgeSec);
  if (!isAddress(l1Sender || '') || !isAddress(auth?.from || '')) refuse('bad-input', 'l1Sender/from');
  const tokDomain = { name: token.name, version: token.version, chainId: network.l2ChainId, verifyingContract: getAddress(token.address) };
  const sep = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toBytes(token.name)), keccak256(toBytes(token.version)), BigInt(network.l2ChainId), getAddress(token.address)]));
  if (sep.toLowerCase() !== String(token.separator).toLowerCase()) refuse('token-domain-mismatch', 'DOMAIN_SEPARATOR is not {name, version, chainId, token}');
  if (pins?.usdc && lower(pins.usdc) !== lower(token.address)) refuse('pin-mismatch', 'token');
  const value = u(auth.value, 'value'), validAfter = u(auth.validAfter, 'validAfter'), validBefore = u(auth.validBefore, 'validBefore');
  if (value === 0n) refuse('bad-input', 'value 0');
  if (validAfter >= BigInt(token.head.timestamp)) refuse('not-yet-valid', 'validAfter must have passed (exclusive)');
  if (validBefore < BigInt(token.head.timestamp + p.minDeadlineMarginSec)) refuse('deadline-too-close');
  if (token.authorizationUsed !== false) refuse('replayed-authorization', 'authorizationState(from, nonce) is set (or unread)');
  if (BigInt(token.holderBalance) < value) refuse('over-budget', 'the payer\'s USDC balance is short');
  checkEcdsaRules(auth.signature);
  let to, data, binding, key;
  if (kind === 'topUpWithAuthorization') {
    const s = snapshot;
    checkVault(s, pins, network, now, p);
    if (lower(auth.from) !== lower(s.owner)) refuse('sender-mismatch', 'the vault pulls only from its owner');
    if (!s.sessionLive) refuse('session-not-live');
    if (s.vaultUsdcBalance === undefined || BigInt(s.vaultUsdcBalance) + value > BigInt(s.maxVault6)) refuse('over-cap', 'the vault\'s beta cap');
    const topUp = hashTypedData({ domain: vaultDomain(network, s.vault), types: OWNER_TYPES.topUp, primaryType: 'TopUp', message: { sessionId: sid, amount: value, opNonce, signBefore: validBefore } });
    if (String(auth.nonce).toLowerCase() !== topUp.toLowerCase()) refuse('nonce-not-bound', 'the 3009 nonce must be the TopUp digest');
    to = s.vault;
    data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'topUpWithAuthorization', args: [sid, value, opNonce, validAfter, validBefore, auth.signature] });
    binding = { vault: s.vault, sid, amount: value.toString(), opNonce, head: s.head };
    key = `usdc-3009:${network.l2ChainId}:${lower(auth.from)}:${auth.nonce.toLowerCase()}`;
  } else if (kind === 'ledger.fundWithAuthorization') {
    if (!isAddress(ledger || '') || !HASH.test(deployment || '')) refuse('bad-input', 'ledger/deployment');
    if (slice(auth.nonce, 0, 16).toLowerCase() !== slice(deployment, 0, 16).toLowerCase()) refuse('nonce-not-bound', 'bytes16(nonce) must be the deployment id');
    if (!token.deploymentActive) refuse('precondition', 'the deployment is not active at the head');
    if (!isPlainOrDelegatedEoa(token.holderCode)) refuse('payer-is-contract', 'USDC checks a code-bearing payer through ERC-1271');
    to = ledger;
    data = encodeFunctionData({ abi: LEDGER_FUND_ABI, functionName: 'fundWithAuthorization', args: [deployment, auth.from, value, validAfter, validBefore, auth.nonce, auth.signature] });
    binding = { ledger: getAddress(ledger), deployment, payer: getAddress(auth.from), value: value.toString(), head: token.head };
    key = `usdc-3009:${network.l2ChainId}:${lower(auth.from)}:${auth.nonce.toLowerCase()}`;
  } else refuse('unsupported-operation', kind);
  const recipient = getAddress(to);
  const signer = await recoverTypedDataAddress({ domain: tokDomain, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization',
    message: { from: getAddress(auth.from), to: recipient, value, validAfter, validBefore, nonce: auth.nonce }, signature: auth.signature });
  if (lower(signer) !== lower(auth.from)) refuse('bad-signature', 'the 3009 authorization does not recover to its payer');
  return finish({ network, target: to, data, l1Sender, l2GasLimit, tracker, p, op: kind === 'topUpWithAuthorization' ? 'sessionVault.topUpWithAuthorization' : kind, key, binding,
    authorization: [`L2: the payer's existing EIP-3009 ReceiveWithAuthorization (token domain ${token.name}/${token.version}), payee = the contract itself`],
    duplicates: 'USDC marks (from, nonce) used: any other copy reverts' });
}
