// SessionVault owner-signed and session-key operations, and USDC EIP-3009 authorizations, forced in through the
// PRODUCTION portal bytecode on a local L1 (test/support/l1-portal.mjs) into REAL compiled contracts on a local L2:
//   SessionVault + SessionVaultLib + SessionVaultFactory (source keccak 0xa2a0…6ec8 = the production legacy vault's
//   source), EnclaveAddressBook, the live ledger rev 16d and registry schema 4. USDC is the repo's MockUSDC3009 TEST
//   MOCK (FiatTokenV2_2's receiveWithAuthorization rules); the ERC-1271 owner is the repo's Mock1271Owner. Session
//   keys are P-256 TEST keys (node:crypto). The local L1 is labelled `test-anvil-l1`, never an L1 light client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign, randomBytes } from 'node:crypto';
import * as viem from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as F from '../src/forced-inclusion.mjs';
import * as V from '../src/vault-deposit.mjs';
import { startL1 } from './support/l1-portal.mjs';
import { startL2, forceInclude, ART, SRC } from './support/l2-world.mjs';

const ZERO32 = '0x' + '00'.repeat(32);
const b32 = (s) => viem.toHex(viem.toBytes(s, { size: 32 }));
const T = { timeout: 180000 };
let l1, l2, A = {}, addr = {}, alice, relayer, l1Key, l1Sender, sk, sid, id, id2;
const rnd32 = () => '0x' + randomBytes(32).toString('hex');

/** A P-256 session key: {x, y} and a signer over sha256(digest) in r||s form (exactly what the vault verifies). */
function p256Key() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = viem.toHex(Buffer.from(jwk.x, 'base64url')), y = viem.toHex(Buffer.from(jwk.y, 'base64url'));
  return { x, y, keyHash: viem.keccak256(viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(x), BigInt(y)])),
    sign: (digest) => { const sig = nodeSign('sha256', Buffer.from(viem.toBytes(digest)), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return { x, y, r: viem.toHex(sig.subarray(0, 32)), s: viem.toHex(sig.subarray(32)) }; } };
}
const pins = () => ({ factory: addr.factory, implementation: addr.impl, usdc: addr.usdc });
const snap = async (o = {}) => V.readVaultSnapshot({ client: l2.pc, head: await l2.headNow(), pins: pins(), vault: addr.vault, ...o });
const now = async () => (await l2.headNow()).timestamp + 5;
const domain = () => V.vaultDomain(F.BASE_MAINNET, addr.vault);
const signOwner = (op, message, key = alice.key) => privateKeyToAccount(key).signTypedData({ domain: domain(), types: V.OWNER_TYPES[op], primaryType: Object.keys(V.OWNER_TYPES[op])[0], message });
const sessionOf = async (s = sid) => (await l2.read(addr.vault, V.VAULT_ABI, 'sessionOf', [s]))[0];
const force = (plan, o = {}) => forceInclude(F, l1, l2, plan, { key: l1Key, relayerKey: relayer, ...o });

test.before(async () => {
  [l1, l2] = [await startL1(), await startL2()];
  for (const n of ['SessionVault', 'SessionVaultLib', 'SessionVaultFactory', 'EnclaveAddressBook', 'MockUSDC3009', 'Mock1271Owner', 'EnclaveDeployments', 'EnclaveLedgerBandwidth', 'EnclaveRegistry', 'MockFeed']) A[n] = ART(n);
  alice = { key: generatePrivateKey() }; alice.address = privateKeyToAccount(alice.key).address;
  relayer = generatePrivateKey(); l1Key = generatePrivateKey(); l1Sender = privateKeyToAccount(l1Key).address;
  for (const a of [alice.address, privateKeyToAccount(relayer).address]) await l2.fund(a);
  addr.usdc = await l2.deploy(A.MockUSDC3009);
  addr.feed = await l2.deploy(A.MockFeed);
  await l2.write(l2.DEV, addr.feed, A.MockFeed.abi, 'set', [300000000000n, (await l2.pc.getBlock()).timestamp]);
  addr.registry = await l2.deploy(A.EnclaveRegistry);
  addr.lib = await l2.deploy(A.EnclaveLedgerBandwidth);
  addr.ledger = await l2.deploy(A.EnclaveDeployments, [addr.usdc, privateKeyToAccount(generatePrivateKey()).address, addr.registry, addr.feed], { 'src/live/EnclaveDeployments.sol:EnclaveLedgerBandwidth': addr.lib });
  addr.book = await l2.deploy(A.EnclaveAddressBook);
  addr.svlib = await l2.deploy(A.SessionVaultLib);
  addr.factory = await l2.deploy(A.SessionVaultFactory, [addr.usdc, addr.book, viem.getAddress('0x' + 'fe'.repeat(20)), viem.zeroAddress, 250_000_000n], { 'contracts/SessionVault.sol:SessionVaultLib': addr.svlib });
  addr.impl = await l2.read(addr.factory, V.FACTORY_ABI, 'implementation');
  await l2.write(l2.DEV, addr.book, A.EnclaveAddressBook.abi, 'set', [b32('deployments'), addr.ledger]);
  await l2.write(l2.DEV, addr.book, A.EnclaveAddressBook.abi, 'set', [b32('sessionVaultFactory'), addr.factory]);
  await l2.write(l2.DEV, addr.factory, A.SessionVaultFactory.abi, 'createVault', [alice.address]);
  addr.vault = await l2.read(addr.factory, V.FACTORY_ABI, 'vaultFor', [alice.address]);
  // a deployment the VAULT owns (created through the owner's direct ownerCall) and adopts as staging (owner direct)
  const create = viem.encodeFunctionData({ abi: A.EnclaveDeployments.abi, functionName: 'create', args: ['catalog://app/0', 0, 500, 8080, '', true, '', viem.zeroAddress, 0n, 1000n] });
  for (const which of ['id', 'id2']) {
    const sim = await l2.pc.simulateContract({ account: alice.address, address: addr.vault, abi: V.VAULT_ABI.concat(viem.parseAbi(['function ownerCall(address,bytes) returns (bytes)'])), functionName: 'ownerCall', args: [addr.ledger, create] });
    const created = viem.decodeAbiParameters([{ type: 'bytes32' }], sim.result)[0];
    await l2.write(alice.key, addr.vault, viem.parseAbi(['function ownerCall(address,bytes) returns (bytes)']), 'ownerCall', [addr.ledger, create]);
    if (which === 'id') id = created; else id2 = created;
  }
  await l2.write(alice.key, addr.vault, V.VAULT_ABI, 'adopt', [id, 'staging', rnd32(), 0n, '0x']);   // owner direct: no signature needed
  // money: the vault's free balance, and alice's wallet for the 3009 paths
  await l2.write(l2.DEV, addr.usdc, viem.parseAbi(['function mint(address,uint256)']), 'mint', [addr.vault, 50_000_000n]);
  await l2.write(l2.DEV, addr.usdc, viem.parseAbi(['function mint(address,uint256)']), 'mint', [alice.address, 50_000_000n]);
  // a session: setActive + fund on staging, any app, budget 5 USDC, no fees
  sk = p256Key();
  const h = await l2.headNow();
  const grant = { label: 'agent', preset: 'test', sessionKey: sk.keyHash, actions: ['deploy.setActive', 'deploy.fund'], apps: ['*'], environments: ['staging'], budget: 5_000_000n,
    spendPerPeriod: 5_000_000n, periodSeconds: 3600, opsPerPeriod: 0, maxFeePerOp: 0n, maxAppFeePerHour: 0n, maxRatePerHour: 10n ** 12n, expiresAt: BigInt(h.timestamp + 3 * 86400),
    measurement: ZERO32, grantNonce: rnd32(), signBefore: BigInt(h.timestamp + 3600) };
  const openAbi = viem.parseAbi(['struct Grant { string label; string preset; bytes32 sessionKey; string[] actions; string[] apps; string[] environments; uint256 budget; uint256 spendPerPeriod; uint32 periodSeconds; uint32 opsPerPeriod; uint256 maxFeePerOp; uint256 maxAppFeePerHour; uint256 maxRatePerHour; uint64 expiresAt; bytes32 measurement; bytes32 grantNonce; uint64 signBefore; }', 'function open(Grant g, bytes ownerSig) returns (bytes32)']);
  await l2.write(alice.key, addr.vault, openAbi, 'open', [grant, '0x']);
  sid = viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [addr.vault, sk.keyHash, grant.grantNonce]));
});
test.after(() => { l1?.stop(); l2?.stop(); });

test('provenance: the vault, library and factory are the compiled production source; the vault is the pinned clone of an EOA owner', T, async () => {
  for (const [a, s] of [['SessionVault', 'SessionVault.sol'], ['SessionVaultFactory', 'SessionVault.sol'], ['EnclaveAddressBook', 'EnclaveAddressBook.sol'], ['MockUSDC3009', 'SessionMocks.sol']]) {
    const m = ART(a).metadata.sources; const k = Object.keys(m).find((x) => x.endsWith(s));
    assert.equal(m[k].keccak256, viem.keccak256(SRC(s)), a);
  }
  assert.equal(ART('SessionVault').metadata.sources['contracts/SessionVault.sol'].keccak256, '0xa2a0324aefc95ab08ffd997a06f632018ac794ae350fd3cb5048aa00966b6ec8');
  const s = await snap({ sid });
  assert.equal(s.code.toLowerCase(), V.cloneRuntime(addr.impl));
  assert.equal(s.isVault, true);
  assert.equal(s.sessionLive, true);
});

test('owner-signed TopUp by deposit (any L1 sender): the session is credited once; the same signed TopUp relayed on L2 afterwards reverts NonceUsed', T, async () => {
  const opNonce = rnd32(), h = await l2.headNow();
  const message = { sessionId: sid, amount: 1_000_000n, opNonce, signBefore: BigInt(h.timestamp + 6 * 3600) };
  const sig = await signOwner('topUp', message);
  const before = (await sessionOf()).balance6;
  const { plan } = await V.planVaultOwnerOp({ pins: pins(), op: 'topUp', message, signature: sig, snapshot: await snap({ sid, opNonce }), l1Sender, l2GasLimit: 600_000n, now: await now() });
  assert.equal(plan.l1Transaction.to, F.BASE_MAINNET.portal);
  const { receipt } = await force(plan);
  assert.equal(receipt.status, 'success');
  assert.equal((await sessionOf()).balance6, before + 1_000_000n);
  // the ORDINARY L2 path with the same signature (a relayer's normal transaction) after the deposit landed: refused by the vault
  const rc = await l2.write(relayer, addr.vault, V.VAULT_ABI, 'topUp', [sid, 1_000_000n, opNonce, message.signBefore, sig], 0n, { allowRevert: true });
  assert.equal(rc.status, 'reverted');
  assert.equal((await sessionOf()).balance6, before + 1_000_000n, 'credited exactly once');
  await assert.rejects(V.planVaultOwnerOp({ pins: pins(), op: 'topUp', message, signature: sig, snapshot: await snap({ sid, opNonce }), l1Sender, l2GasLimit: 600_000n, now: await now() }),
    (e) => e.code === 'replayed-authorization');
});

test('ordinary L2 attempt FIRST, then the deposit of the same signed Withdraw: one effect; and why the owner\'s own address may never be the deposit sender', T, async () => {
  const h = await l2.headNow();
  const message = { amount: 2_000_000n, opNonce: rnd32(), signBefore: BigInt(h.timestamp + 6 * 3600) };
  const sig = await signOwner('withdraw', message);
  const { plan } = await V.planVaultOwnerOp({ pins: pins(), op: 'withdraw', message, signature: sig, snapshot: await snap({ opNonce: message.opNonce }), l1Sender, l2GasLimit: 600_000n, now: await now() });
  const bal0 = await l2.read(addr.usdc, V.TOKEN_ABI, 'balanceOf', [alice.address]);
  await l2.write(relayer, addr.vault, V.VAULT_ABI, 'withdraw', [message.amount, message.opNonce, message.signBefore, sig]);   // lands first
  const { receipt } = await force(plan);                                                                                     // the deposit arrives later
  assert.equal(receipt.status, 'reverted', 'NonceUsed: a failed deposit');
  assert.equal(await l2.read(addr.usdc, V.TOKEN_ABI, 'balanceOf', [alice.address]), bal0 + 2_000_000n, 'withdrawn exactly once');
  // the hazard: a deposit FROM the owner skips the opNonce entirely (msg.sender == owner), so the same signed
  // withdraw can execute twice. Shown on the real vault: the deposit from alice's own L1 address, then the L2 relay.
  const m2 = { amount: 1_000_000n, opNonce: rnd32(), signBefore: BigInt(h.timestamp + 6 * 3600) };
  const sig2 = await signOwner('withdraw', m2);
  await assert.rejects(V.planVaultOwnerOp({ pins: pins(), op: 'withdraw', message: m2, signature: sig2, snapshot: await snap({ opNonce: m2.opNonce }), l1Sender: alice.address, l2GasLimit: 600_000n, now: await now() }),
    (e) => e.code === 'sender-is-owner');
  const raw = { ...plan, l1Transaction: { ...plan.l1Transaction, data: F.portalCall(addr.vault, 600_000n, viem.encodeFunctionData({ abi: V.VAULT_ABI, functionName: 'withdraw', args: [m2.amount, m2.opNonce, m2.signBefore, sig2] })) } };
  const rc1 = await l1.send(alice.key, raw.l1Transaction);
  const [log] = (await import('viem/op-stack')).extractTransactionDepositedLogs({ logs: rc1.logs });
  assert.equal(viem.getAddress(log.args.from), alice.address);
  const bal1 = await l2.read(addr.usdc, V.TOKEN_ABI, 'balanceOf', [alice.address]);
  assert.equal((await l2.executeLog(log)).receipt.status, 'success');
  assert.equal(await l2.read(addr.vault, V.VAULT_ABI, 'ownerNonceUsed', [m2.opNonce]), false, 'the owner path did NOT consume the opNonce');
  await l2.write(relayer, addr.vault, V.VAULT_ABI, 'withdraw', [m2.amount, m2.opNonce, m2.signBefore, sig2]);
  assert.equal(await l2.read(addr.usdc, V.TOKEN_ABI, 'balanceOf', [alice.address]), bal1 + 2_000_000n, 'the SAME signed withdraw executed twice: the refusal is necessary');
});

test('session-key execute (setActive) by deposit from an ALIASED contract wallet: P-256 call runs once; replay, unauthorized action, unauthorized target, wrong key are refused', T, async () => {
  const wallet = viem.getAddress('0x' + '7c'.repeat(20));
  await l1.makeContract(wallet, F.BASE_MAINNET.portal);
  const h = await l2.headNow(); let NOW = h.timestamp + 5;
  const args = viem.encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [id, false]);
  const call = { sid, nonce: 0n, action: 6, args, fee: 0n, deadline: BigInt(h.timestamp + 6 * 3600) };
  const digest = viem.hashTypedData({ domain: domain(), types: V.CALL_TYPES, primaryType: 'SessionCall', message: { sessionId: sid, nonce: 0n, action: 6, argsHash: viem.keccak256(args), fee: 0n, deadline: call.deadline } });
  const key = sk.sign(digest);
  const s = await snap({ sid, lane: 0n, deployment: id });
  const { plan } = V.planSessionCall({ pins: pins(), call, key, snapshot: s, l1Sender: wallet, l2GasLimit: 800_000n, now: await now() });
  const { receipt, log } = await force(plan, { through: wallet });
  assert.equal(viem.getAddress(log.args.from), F.applyL1ToL2Alias(wallet));
  assert.equal(receipt.status, 'success');
  const row = await l2.read(addr.ledger, A.EnclaveDeployments.abi, 'get', [id]);
  assert.equal(row.active, false, 'the session deactivated its deployment through the vault');
  // the same call again: the lane sequence moved: the planner refuses, and on chain it reverts (BadNonce)
  const sAfter = await snap({ sid, lane: 0n, deployment: id });
  assert.equal(sAfter.seq, 1n);
  NOW = (await l2.headNow()).timestamp + 5;
  assert.throws(() => V.planSessionCall({ pins: pins(), call, key, snapshot: sAfter, l1Sender: wallet, l2GasLimit: 800_000n, now: NOW }), (e) => e.code === 'replayed-authorization');
  assert.equal((await force(plan, { through: wallet })).receipt.status, 'reverted');
  // an action the grant does not allow (refund), a deployment the vault does not hold (id2), a wrong key
  const refundArgs = viem.encodeAbiParameters([{ type: 'bytes32' }], [id]);
  const s1 = await snap({ sid, lane: 0n, deployment: id });
  NOW = (await l2.headNow()).timestamp + 5;
  assert.throws(() => V.planSessionCall({ pins: pins(), call: { ...call, nonce: 1n, action: 7, args: refundArgs }, key, snapshot: s1, l1Sender: wallet, l2GasLimit: 800_000n, now: NOW }), (e) => e.code === 'action-not-permitted');
  const other = viem.encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [id2, false]);
  const d2 = viem.hashTypedData({ domain: domain(), types: V.CALL_TYPES, primaryType: 'SessionCall', message: { sessionId: sid, nonce: 1n, action: 6, argsHash: viem.keccak256(other), fee: 0n, deadline: call.deadline } });
  const s2 = await snap({ sid, lane: 0n, deployment: id2 });
  NOW = (await l2.headNow()).timestamp + 5;
  assert.throws(() => V.planSessionCall({ pins: pins(), call: { ...call, nonce: 1n, args: other }, key: sk.sign(d2), snapshot: s2, l1Sender: wallet, l2GasLimit: 800_000n, now: NOW }), (e) => e.code === 'unauthorized-target');
  // and the vault itself refuses that call on chain (NotHeld): the planner's refusal is the contract's rule, earlier
  const unheld = { ...plan, deposit: { ...plan.deposit, data: viem.encodeFunctionData({ abi: V.VAULT_ABI, functionName: 'execute', args: [sid, 1n, 6, other, 0n, call.deadline, BigInt(sk.x), BigInt(sk.y), sk.sign(d2).r, sk.sign(d2).s] }) } };
  unheld.l1Transaction = { ...plan.l1Transaction, data: F.portalCall(addr.vault, 800_000n, unheld.deposit.data) };
  assert.equal((await force(unheld, { through: wallet })).receipt.status, 'reverted');
  const wrong = p256Key();
  NOW = (await l2.headNow()).timestamp + 5;
  assert.throws(() => V.planSessionCall({ pins: pins(), call: { ...call, nonce: 1n }, key: wrong.sign(digest), snapshot: s1, l1Sender: wallet, l2GasLimit: 800_000n, now: NOW }), (e) => e.code === 'bad-signature');
});

test('owner termination by signed Terminate deposit: the session ends and refunds the owner; afterwards session ops are refused; stale and malformed authorizations are refused', T, async () => {
  const h = await l2.headNow();
  const m = { sessionId: sid, opNonce: rnd32(), signBefore: BigInt(h.timestamp + 6 * 3600) };
  const sig = await signOwner('terminate', m);
  const base = { pins: pins(), op: 'terminate', message: m, signature: sig, l1Sender, l2GasLimit: 600_000n };
  // stale signBefore, wrong signer, high-s, a contract (ERC-1271) owner are refused before anything is sent
  const stale = { ...m, signBefore: BigInt(h.timestamp + 60) };
  await assert.rejects(V.planVaultOwnerOp({ ...base, message: stale, signature: await signOwner('terminate', stale), snapshot: await snap({ sid, opNonce: m.opNonce }), now: await now() }), (e) => e.code === 'deadline-too-close');
  await assert.rejects(V.planVaultOwnerOp({ ...base, signature: await signOwner('terminate', m, generatePrivateKey()), snapshot: await snap({ sid, opNonce: m.opNonce }), now: await now() }), (e) => e.code === 'bad-signature');
  const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const high = viem.concat([viem.slice(sig, 0, 32), viem.pad(viem.toHex(N - viem.hexToBigInt(viem.slice(sig, 32, 64)))), viem.toHex(viem.hexToNumber(viem.slice(sig, 64, 65)) === 27 ? 28 : 27)]);
  await assert.rejects(V.planVaultOwnerOp({ ...base, signature: high, snapshot: await snap({ sid, opNonce: m.opNonce }), now: await now() }), (e) => e.code === 'bad-signature');
  await assert.rejects(V.planVaultOwnerOp({ ...base, op: 'yank', snapshot: await snap({ sid, opNonce: m.opNonce }), now: await now() }), (e) => e.code === 'unsupported-operation');
  const s0 = await snap({ sid, opNonce: m.opNonce });
  await assert.rejects(V.planVaultOwnerOp({ ...base, snapshot: { ...s0, ownerCode: ART('Mock1271Owner').deployedBytecode.object }, now: await now() }), (e) => e.code === 'owner-is-contract');
  await assert.rejects(V.planVaultOwnerOp({ ...base, snapshot: { ...s0, code: '0x6000' }, now: await now() }), (e) => e.code === 'not-a-vault');
  // the owner's termination
  const escrow = (await sessionOf()).balance6, owner0 = await l2.read(addr.usdc, V.TOKEN_ABI, 'balanceOf', [alice.address]);
  const { plan } = await V.planVaultOwnerOp({ ...base, snapshot: s0, now: await now() });
  const { receipt } = await force(plan);
  assert.equal(receipt.status, 'success');
  const sess = await sessionOf();
  assert.equal(sess.state, 2, 'ENDED');
  assert.equal(await l2.read(addr.usdc, V.TOKEN_ABI, 'balanceOf', [alice.address]), owner0 + escrow, 'the session escrow refunded to the owner');
  // after termination: a top-up and a session call are refused
  const t = { sessionId: sid, amount: 1n, opNonce: rnd32(), signBefore: BigInt(h.timestamp + 6 * 3600) };
  await assert.rejects(V.planVaultOwnerOp({ pins: pins(), op: 'topUp', message: t, signature: await signOwner('topUp', t), snapshot: await snap({ sid, opNonce: t.opNonce }), l1Sender, l2GasLimit: 600_000n, now: await now() }), (e) => e.code === 'session-not-live');
  const ended = await snap({ sid, lane: 0n, deployment: id }), NOW2 = await now();
  assert.throws(() => V.planSessionCall({ pins: pins(), call: { sid, nonce: 1n, action: 6, args: viem.encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [id, true]), fee: 0n, deadline: BigInt(h.timestamp + 6 * 3600) }, key: { x: sk.x, y: sk.y, r: ZERO32, s: ZERO32 },
    snapshot: ended, l1Sender, l2GasLimit: 600_000n, now: NOW2 }), (e) => e.code === 'session-not-live');
});

test('release recipient: only the owner, or the owner\'s vault at the book\'s CURRENT factory after an admin migration; any other recipient is refused', T, async () => {
  const h = await l2.headNow();
  const before = await snap({ opNonce: rnd32() });
  assert.equal(before.ownerVaultAtBookFactory, addr.vault, 'same factory: the owner\'s vault IS this vault (the vault refuses itself)');
  // the platform admin migrates the book to a new factory (its existing set right); the owner's NEW vault becomes a
  // valid release target, exactly the vault's own rule
  const factory2 = await l2.deploy(A.SessionVaultFactory, [addr.usdc, addr.book, viem.getAddress('0x' + 'fe'.repeat(20)), viem.zeroAddress, 250_000_000n], { 'contracts/SessionVault.sol:SessionVaultLib': addr.svlib });
  await l2.write(l2.DEV, addr.book, A.EnclaveAddressBook.abi, 'set', [b32('sessionVaultFactory'), factory2]);
  const s = await snap({ opNonce: rnd32() });
  const newVault = await l2.read(factory2, V.FACTORY_ABI, 'vaultFor', [alice.address]);
  assert.equal(s.ownerVaultAtBookFactory, newVault);
  for (const [to, ok] of [[alice.address, true], [newVault, true], [l1Sender, false], [addr.vault, false]]) {
    const m = { deployment: id, to, opNonce: rnd32(), signBefore: BigInt(h.timestamp + 6 * 3600) };
    const p = V.planVaultOwnerOp({ pins: pins(), op: 'release', message: m, signature: await signOwner('release', m), snapshot: { ...s, ownerNonceUsed: false }, l1Sender, l2GasLimit: 600_000n, now: await now() });
    if (ok) assert.ok((await p).plan); else await assert.rejects(p, (e) => e.code === 'release-recipient');
  }
  await l2.write(l2.DEV, addr.book, A.EnclaveAddressBook.abi, 'set', [b32('sessionVaultFactory'), addr.factory]);
});

test('USDC EIP-3009: the owner\'s topUpWithAuthorization and a payer\'s ledger fundWithAuthorization by deposit; replay, unbound nonce, wrong token domain, contract payer refused', T, async () => {
  // a fresh live session to top up
  const sk2 = p256Key(), h = await l2.headNow();
  const grant = { label: 'b', preset: 't', sessionKey: sk2.keyHash, actions: ['deploy.setActive'], apps: ['*'], environments: ['staging'], budget: 0n, spendPerPeriod: 1n, periodSeconds: 3600, opsPerPeriod: 0,
    maxFeePerOp: 0n, maxAppFeePerHour: 0n, maxRatePerHour: 1n, expiresAt: BigInt(h.timestamp + 86400 * 3), measurement: ZERO32, grantNonce: rnd32(), signBefore: BigInt(h.timestamp + 3600) };
  const openAbi = viem.parseAbi(['struct Grant { string label; string preset; bytes32 sessionKey; string[] actions; string[] apps; string[] environments; uint256 budget; uint256 spendPerPeriod; uint32 periodSeconds; uint32 opsPerPeriod; uint256 maxFeePerOp; uint256 maxAppFeePerHour; uint256 maxRatePerHour; uint64 expiresAt; bytes32 measurement; bytes32 grantNonce; uint64 signBefore; }', 'function open(Grant g, bytes ownerSig) returns (bytes32)']);
  await l2.write(alice.key, addr.vault, openAbi, 'open', [grant, '0x']);
  const sid2 = viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [addr.vault, sk2.keyHash, grant.grantNonce]));
  const tok = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: addr.usdc };
  const value = 3_000_000n, opNonce = rnd32(), validAfter = BigInt(h.timestamp - 10), validBefore = BigInt(h.timestamp + 6 * 3600);
  const nonce = viem.hashTypedData({ domain: domain(), types: V.OWNER_TYPES.topUp, primaryType: 'TopUp', message: { sessionId: sid2, amount: value, opNonce, signBefore: validBefore } });
  const sig = await privateKeyToAccount(alice.key).signTypedData({ domain: tok, types: V.RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: alice.address, to: addr.vault, value, validAfter, validBefore, nonce } });
  const auth = { from: alice.address, value, validAfter, validBefore, nonce, signature: sig };
  const tsnap = async () => V.readTokenSnapshot({ client: l2.pc, head: await l2.headNow(), token: addr.usdc, from: alice.address, nonce });
  const vs = await snap({ sid: sid2 });
  const base = { pins: pins(), kind: 'topUpWithAuthorization', auth, sid: sid2, opNonce, snapshot: vs, l1Sender, l2GasLimit: 600_000n };
  await assert.rejects(V.planUsdcAuthorization({ ...base, token: { ...(await tsnap()), separator: ZERO32 }, now: await now() }), (e) => e.code === 'token-domain-mismatch');
  await assert.rejects(V.planUsdcAuthorization({ ...base, opNonce: rnd32(), token: await tsnap(), now: await now() }), (e) => e.code === 'nonce-not-bound');
  const { plan } = await V.planUsdcAuthorization({ ...base, token: await tsnap(), now: await now() });
  const { receipt } = await force(plan);
  assert.equal(receipt.status, 'success');
  assert.equal((await sessionOf(sid2)).balance6, value, 'funded from the owner\'s wallet into the session');
  await assert.rejects(V.planUsdcAuthorization({ ...base, token: await tsnap(), now: await now() }), (e) => e.code === 'replayed-authorization');
  assert.equal((await force(plan)).receipt.status, 'reverted', 'the same authorization again: USDC refuses');
  // a payer funds the ledger deployment id2 (active) with its own 3009 authorization; the nonce must start with id2
  const payerKey = generatePrivateKey(), payer = privateKeyToAccount(payerKey).address;
  await l2.write(l2.DEV, addr.usdc, viem.parseAbi(['function mint(address,uint256)']), 'mint', [payer, 4_000_000n]);
  const fnonce = viem.concat([viem.slice(id2, 0, 16), '0x' + randomBytes(16).toString('hex')]);
  const fsig = await privateKeyToAccount(payerKey).signTypedData({ domain: tok, types: V.RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { from: payer, to: addr.ledger, value: 2_000_000n, validAfter, validBefore, nonce: fnonce } });
  const fauth = { from: payer, value: 2_000_000n, validAfter, validBefore, nonce: fnonce, signature: fsig };
  const fsnap = async (n = fnonce) => V.readTokenSnapshot({ client: l2.pc, head: await l2.headNow(), token: addr.usdc, from: payer, nonce: n, ledger: addr.ledger, deployment: id2 });
  const fbase = { pins: pins(), kind: 'ledger.fundWithAuthorization', auth: fauth, deployment: id2, ledger: addr.ledger, l1Sender, l2GasLimit: 600_000n };
  const bal0 = (await l2.read(addr.ledger, A.EnclaveDeployments.abi, 'get', [id2])).balance6;
  const fp = await V.planUsdcAuthorization({ ...fbase, token: await fsnap(), now: await now() });
  assert.equal((await force(fp.plan)).receipt.status, 'success');
  assert.equal((await l2.read(addr.ledger, A.EnclaveDeployments.abi, 'get', [id2])).balance6, bal0 + 2_000_000n);
  const badNonce = viem.concat([viem.slice(id, 0, 16), '0x' + randomBytes(16).toString('hex')]);
  await assert.rejects(V.planUsdcAuthorization({ ...fbase, auth: { ...fauth, nonce: badNonce }, token: await fsnap(badNonce), now: await now() }), (e) => e.code === 'nonce-not-bound');
  await assert.rejects(V.planUsdcAuthorization({ ...fbase, token: { ...(await fsnap()), authorizationUsed: false, holderCode: ART('Mock1271Owner').deployedBytecode.object }, now: await now() }), (e) => e.code === 'payer-is-contract');
});
