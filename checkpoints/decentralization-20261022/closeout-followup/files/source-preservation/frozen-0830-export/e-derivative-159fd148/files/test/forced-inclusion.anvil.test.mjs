// Forced inclusion of REAL Enclave operations as OP-Stack deposit transactions, offline (`unshare -r -n`).
//   L2 = anvil 1.7.1 `--network optimism --hardfork isthmus --chain-id 8453`: it executes raw type-0x7E deposits
//        (viem's serializer) with GASPRICE 0 and msg.sender = tx.origin = the deposit's `from`, as Base's EVM does
//        (base/base v1.5.1 FromRecoveredTx<TxDeposit>: gas_price default 0). Contracts are the COMPILED artifacts of
//        the live ledger rev 16d, registry schema 4, EnclaveLeaseGasReserve and EnclaveLeaseExecutor (metadata keccak
//        checked against fixtures/sources); USDC and the price feed are the repo's test mocks.
//   L1 = NOT executed: the TransactionDeposited log is a FIXTURE built exactly as OptimismPortal2 7.0.0 emits it
//        (evidence/op-source, abi.encodePacked(mint, value, gasLimit, isCreation, data)); its L1 block hash is
//        synthetic and the "L1 verifier" is a label. What is real: the deposit tx derived from it by viem
//        (getL2TransactionHash) is the one anvil executes, byte for byte (same hash).
//   "Verified head" = anvil's latest block, labelled; in production it is Helios / P's root store.
//   env: none (anvil on PATH)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import * as viem from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { serializeTransaction, getSourceHash } from 'viem/op-stack';
import * as F from '../src/forced-inclusion.mjs';

const ART = (n) => JSON.parse(fs.readFileSync(new URL(`../fixtures/artifacts/${n}.json`, import.meta.url)));
const SRC = (n) => fs.readFileSync(new URL(`../fixtures/sources/${n}`, import.meta.url));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DEV = generatePrivateKey();   // per-run deployer (funded with anvil_setBalance): no key literal in source
const ZERO32 = '0x' + '00'.repeat(32);
let anvil, url, pc, chain;
const A = {}, addr = {};
const rpc = async (method, params = []) => {
  const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
};
const wc = (key) => viem.createWalletClient({ chain, account: privateKeyToAccount(key), transport: viem.http(url) });
async function send(key, tx) {
  const h = await wc(key).sendTransaction({ gas: 8_000_000n, ...tx });
  const rc = await pc.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error('reverted: ' + (tx.label || '')); return rc;
}
function link(a, libs) {   // replace each 20-byte placeholder at the artifact's linkReferences offsets
  let hex = a.bytecode.object.slice(2);
  for (const [file, names] of Object.entries(a.bytecode.linkReferences || {}))
    for (const [name, refs] of Object.entries(names)) for (const r of refs) hex = hex.slice(0, r.start * 2) + libs[`${file}:${name}`].slice(2).toLowerCase() + hex.slice((r.start + r.length) * 2);
  return '0x' + hex;
}
async function deploy(key, a, args = [], libs = {}) {
  const bytecode = Object.keys(a.bytecode.linkReferences || {}).length ? link(a, libs) : a.bytecode.object;
  return (await send(key, { data: viem.encodeDeployData({ abi: a.abi, bytecode, args }) })).contractAddress;
}
const write = (key, address, abi, functionName, args = [], value = 0n) => send(key, { to: address, data: viem.encodeFunctionData({ abi, functionName, args }), value, label: functionName });
const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
const row = (id) => read(addr.ledger, A.ledger.abi, 'get', [id]);
async function headNow() {
  const b = await pc.getBlock();
  return { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp), verifiedBy: 'signed-head' };   // LABEL: anvil block as the verified head
}
async function warp(ts) { await rpc('evm_setNextBlockTimestamp', [Number(ts)]); await rpc('evm_mine'); }

/** The L1 side, as a FIXTURE: the TransactionDeposited log OptimismPortal2 would emit for this plan and L1 sender. */
let l1Seq = 0;
function l1Fixture(plan, from) {
  const d = viem.decodeFunctionData({ abi: F.PORTAL_ABI, data: plan.l1Transaction.data });
  const [to, value, gasLimit, isCreation, data] = d.args;
  const opaque = viem.encodePacked(['uint256', 'uint256', 'uint64', 'bool', 'bytes'], [plan.l1Transaction.value, value, gasLimit, isCreation, data]);
  const blockHash = viem.keccak256(viem.toHex(`synthetic L1 block ${++l1Seq}`));
  const log = { address: plan.l1Transaction.to, blockHash, logIndex: 3, transactionIndex: 0, blockNumber: 1n, transactionHash: viem.keccak256(viem.toHex(`l1 tx ${l1Seq}`)), removed: false,
    topics: [viem.toEventSelector(F.PORTAL_ABI[1]), viem.pad(from), viem.pad(to), ZERO32], data: viem.encodeAbiParameters([{ type: 'bytes' }], [opaque]) };
  return { receipt: { status: 'success', to: plan.l1Transaction.to, blockHash, logs: [log] }, proof: { verifiedBy: 'l1-light-client', headerHash: blockHash } };
}
/** Execute the deposit the L1 event derives, on the L2: exactly the tx viem derives from the log. */
async function executeDeposit(plan, from) {
  const f = l1Fixture(plan, from);
  const m = F.matchDepositEvent(plan, f.receipt, f.proof);
  const sourceHash = getSourceHash({ domain: 'userDeposit', l1BlockHash: f.receipt.blockHash, l1LogIndex: 3 });
  const raw = serializeTransaction({ type: 'deposit', sourceHash, from: m.from, to: plan.deposit.to, mint: 0n, value: 0n, gas: plan.deposit.gasLimit, isSystemTx: false, data: plan.deposit.data });
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  assert.equal(hash, m.l2TransactionHash, 'anvil executed exactly the deposit viem derives from the L1 log');
  return { hash, receipt: await pc.waitForTransactionReceipt({ hash }) };
}

let alice, operator, opKey, relayer, l1Sender, enclaveId, id, endpoint;
const LEASE_DOMAIN = (op) => ({ name: 'EnclaveLeaseExecutor', version: '1', chainId: 8453, verifyingContract: op });
const LEASE_TYPES = { Lease: [{ name: 'reserve', type: 'address' }, { name: 'id', type: 'bytes32' }, { name: 'kind', type: 'uint8' }, { name: 'enclaveId', type: 'bytes32' },
  { name: 'nonce', type: 'uint64' }, { name: 'deadline', type: 'uint64' }, { name: 'payee', type: 'address' }, { name: 'maxChargeWei', type: 'uint256' }] };
async function signLease(key, l) {
  const a = privateKeyToAccount(key);
  return a.signTypedData({ domain: LEASE_DOMAIN(operator), types: LEASE_TYPES, primaryType: 'Lease', message: { reserve: addr.reserve, ...l } });
}
const pins = () => ({ executor: addr.executor, reserve: addr.reserve, ledger: addr.ledger });
const snap = async (kind, op = operator, enc = ZERO32) => F.readLeaseSnapshot({ client: pc, head: await headNow(), pins: pins(), operator: op, id, kind, enclaveId: enc });

test.before(async () => {
  const port = await free();
  url = `http://127.0.0.1:${port}`;
  chain = viem.defineChain({ id: 8453, name: 'local-8453', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  anvil = spawn('anvil', ['--network', 'optimism', '--hardfork', 'isthmus', '--chain-id', '8453', '--port', String(port), '--host', '127.0.0.1', '--base-fee', '10000000', '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  pc = viem.createPublicClient({ chain, transport: viem.http(url) });
  await rpc('anvil_setBalance', [privateKeyToAccount(DEV).address, '0x56bc75e2d63100000']);
  for (const n of ['EnclaveLeaseExecutor', 'EnclaveLeaseGasReserve', 'EnclaveDeployments', 'EnclaveLedgerBandwidth', 'EnclaveRegistry', 'MockUSDC', 'MockFeed']) A[n] = ART(n);
  A.ledger = A.EnclaveDeployments; A.registry = A.EnclaveRegistry; A.reserve = A.EnclaveLeaseGasReserve; A.executor = A.EnclaveLeaseExecutor;
  addr.usdc = await deploy(DEV, A.MockUSDC);
  addr.feed = await deploy(DEV, A.MockFeed);
  await write(DEV, addr.feed, A.MockFeed.abi, 'set', [300000000000n, (await pc.getBlock()).timestamp]);
  addr.registry = await deploy(DEV, A.registry);
  addr.lib = await deploy(DEV, A.EnclaveLedgerBandwidth);
  addr.ledger = await deploy(DEV, A.ledger, [addr.usdc, privateKeyToAccount(generatePrivateKey()).address, addr.registry, addr.feed],
    { 'src/live/EnclaveDeployments.sol:EnclaveLedgerBandwidth': addr.lib });
  addr.reserve = await deploy(DEV, A.reserve, [addr.ledger, addr.registry, viem.zeroAddress,
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 29500, overheadRenewGas: 24000, overheadReleaseGas: 7000, minClaimInterval: 60, l1Bps: 0 }]);
  addr.executor = await deploy(DEV, A.executor, [addr.reserve]);
  await write(DEV, addr.reserve, A.reserve.abi, 'bindExecutor', [addr.executor]);
  // the host: registered (it pays here only to set up the fixture), then delegated to the executor by a relayer's
  // type-4 transaction, the way its first lease does it; afterwards the key holds no ETH
  opKey = generatePrivateKey(); operator = privateKeyToAccount(opKey).address;
  relayer = generatePrivateKey();
  alice = { key: generatePrivateKey() }; alice.address = privateKeyToAccount(alice.key).address;
  for (const a of [operator, privateKeyToAccount(relayer).address, alice.address]) await rpc('anvil_setBalance', [a, '0xde0b6b3a7640000']);
  endpoint = 'https://api.enclave.host/t/forced-inclusion-host';
  await write(opKey, addr.registry, A.registry.abi, 'register', [endpoint, 'EnclaveHost/enclave', ZERO32, 1000n, 0n, '0x000000000000000000000000000000000000bEEF']);
  enclaveId = viem.keccak256(viem.toBytes(endpoint));
  const auth = await wc(opKey).signAuthorization({ account: privateKeyToAccount(opKey), contractAddress: addr.executor });
  await send(relayer, { authorizationList: [auth], to: privateKeyToAccount(relayer).address, data: '0x' });
  await rpc('anvil_setBalance', [operator, '0x0']);
  // the app: created, funded, its gas reserve funded and enabled by its owner
  const args = ['catalog://app/0', 0, 500, 8080, '', true, '', viem.zeroAddress, 0n, 1000n];
  id = (await pc.simulateContract({ account: alice.address, address: addr.ledger, abi: A.ledger.abi, functionName: 'create', args })).result;
  await write(alice.key, addr.ledger, A.ledger.abi, 'create', args);
  await write(DEV, addr.usdc, viem.parseAbi(['function mint(address,uint256)']), 'mint', [alice.address, 6_000_000n]);
  await write(alice.key, addr.usdc, viem.parseAbi(['function approve(address,uint256) returns (bool)']), 'approve', [addr.ledger, 6_000_000n]);
  await write(alice.key, addr.ledger, A.ledger.abi, 'fund', [id, 6_000_000n]);
  await write(alice.key, addr.reserve, A.reserve.abi, 'deposit', [id], 10n ** 16n);
  await write(alice.key, addr.reserve, A.reserve.abi, 'configure', [id, { enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4,
    maxPerOpWei: 10n ** 15n, epochCapWei: 5n * 10n ** 15n, epochSec: 3600, renewWindow: 600, minExtension: 600, claimCooldown: 1800, maxGasPrice: 100_000_000n }]);
  l1Sender = privateKeyToAccount(generatePrivateKey()).address;
});
test.after(() => { anvil?.kill('SIGKILL'); });
const T = { timeout: 120000 };
const nowOf = async () => (await headNow()).timestamp + 5;

test('provenance: artifacts compiled from the pinned sources; portal ABI, alias offset and gas floor match the fetched OP source and viem', () => {
  const pairs = [['EnclaveLeaseExecutor', 'EnclaveLeaseExecutor.sol'], ['EnclaveLeaseGasReserve', 'EnclaveLeaseGasReserve.sol'],
    ['EnclaveDeployments', 'EnclaveDeployments.live-rev16d.sol'], ['EnclaveRegistry', 'EnclaveRegistry.live-schema4.sol']];
  for (const [a, s] of pairs) {
    const m = ART(a).metadata.sources; const [k] = Object.keys(m).filter((x) => !x.includes('forge-std'));
    assert.equal(m[k].keccak256, viem.keccak256(SRC(s)), `${a} artifact compiled from fixtures/sources/${s}`);
  }
  const portal = fs.readFileSync(new URL('../evidence/op-source/develop@packages_contracts-bedrock_src_L1_OptimismPortal2.sol', import.meta.url), 'utf8');
  const alias = fs.readFileSync(new URL('../evidence/op-source/develop@packages_contracts-bedrock_src_vendor_AddressAliasHelper.sol', import.meta.url), 'utf8');
  assert.match(portal, /function depositTransaction\(\s*address _to,\s*uint256 _value,\s*uint64 _gasLimit,\s*bool _isCreation,\s*bytes memory _data\s*\)/);
  assert.match(portal, /return _byteCount \* 40 \+ 21000;/);
  assert.match(portal, /if \(!EOA\.isSenderEOA\(\)\) \{\s*from = AddressAliasHelper\.applyL1ToL2Alias\(msg\.sender\);/);
  assert.match(alias, /uint160\(0x1111000000000000000000000000000000001111\)/);
  // the alias formula against the OP test vector shape (viem's zksync helper uses the same offset)
  assert.equal(F.applyL1ToL2Alias('0x0000000000000000000000000000000000000000'), viem.getAddress('0x1111000000000000000000000000000000001111'));
  assert.equal(F.applyL1ToL2Alias('0xffffffffffffffffffffffffffffffffffffffff'), viem.getAddress('0x1111000000000000000000000000000000001110'));
  // viem's own (internal) portal ABI has the same depositTransaction selector
  const internal = fs.readFileSync(new URL('../node_modules/viem/_esm/op-stack/abis.js', import.meta.url), 'utf8');
  assert.match(internal, /name: 'depositTransaction'/);
  assert.equal(viem.toFunctionSelector(F.PORTAL_ABI[0]), viem.toFunctionSelector('depositTransaction(address,uint256,uint64,bool,bytes)'));
  assert.equal(viem.toEventSelector(F.PORTAL_ABI[1]), '0xb3813568d9991fc951961fcb4c784893574240a28925604d09fc577c55bb7c32', 'Base derivation EVENT_ABI_HASH');
});

test('CLAIM by L1 deposit: the host\'s signed Lease runs as the operator via the real executor, any L1 sender, no L2 fee; the same plan cannot execute twice', T, async (t) => {
  const tracker = new F.ForcedInclusionTracker();
  const s0 = await snap(1, operator, enclaveId);
  assert.equal(F.RESERVE_STATUS[s0.status], 'Ready');
  const lease = { id, kind: 1, enclaveId, nonce: 0n, deadline: BigInt(s0.head.timestamp + 6 * 3600), payee: privateKeyToAccount(relayer).address, maxChargeWei: 10n ** 15n };
  const signature = await signLease(opKey, lease);
  const { plan, replay } = await F.planLeaseDeposit({ pins: pins(), operator, lease, signature, snapshot: s0, l1Sender, l2GasLimit: 800_000n, tracker, now: await nowOf() });
  assert.equal(replay, false);
  // the unsigned L1 transaction: portal call carrying exactly the executor's canonical calldata
  const d = viem.decodeFunctionData({ abi: F.PORTAL_ABI, data: plan.l1Transaction.data });
  assert.deepEqual([plan.l1Transaction.chainId, plan.l1Transaction.to, plan.l1Transaction.value], [1, F.BASE_MAINNET.portal, 0n]);
  assert.deepEqual(d.args, [viem.getAddress(operator), 0n, 800_000n, false, plan.deposit.data]);
  assert.equal(viem.size(plan.deposit.data), 388);
  assert.equal(plan.l1Transaction.signature, undefined, 'unsigned');
  // L1 sender is an EOA: the deposit comes from it; the executor does not care
  const { receipt } = await executeDeposit(plan, l1Sender);
  assert.equal(receipt.status, 'success');
  const r = await row(id);
  assert.equal(r.runnerOperator, viem.getAddress(operator), 'the ledger saw the OPERATOR as msg.sender');
  assert.equal(r.runner, enclaveId);
  const out = F.classifyL2Outcome({ plan, l2TransactionHash: receipt.transactionHash, receipt, head: await headNow(), now: await nowOf(),
    source: { verifier: 'test-anvil', endpoint: url, submittedVia: 'l1-portal' }, verifiers: ['test-anvil'] });
  assert.equal(out.state, 'l2-included');
  assert.deepEqual([out.charged.gasPrice, out.charged.chargedWei], [0n, 0n], 'a deposit runs at gas price 0: the reserve paid nothing (l1Bps 0 here)');
  t.diagnostic(`claim deposit gasUsed ${receipt.gasUsed} of limit ${plan.deposit.gasLimit}`);
  assert.ok(receipt.gasUsed < plan.deposit.gasLimit);
  tracker.mark(plan.key, 'l2-included', { l2: receipt.transactionHash });
  // the same plan again (someone resubmits the L1 tx): the second deposit FAILS on L2 (BadNonce), no second claim
  const again = await executeDeposit(plan, l1Sender);
  assert.equal(again.receipt.status, 'reverted');
  assert.equal(await read(operator, F.EXECUTOR_ABI, 'nonceOf', [id]), 1n);
  assert.equal(F.classifyL2Outcome({ plan, l2TransactionHash: again.hash, receipt: again.receipt, head: await headNow(), now: await nowOf(),
    source: { verifier: 'test-anvil', endpoint: url }, verifiers: ['test-anvil'] }).state, 'l2-failed');
  // and the planner refuses to plan it again from fresh state
  await assert.rejects(F.planLeaseDeposit({ pins: pins(), operator, lease, signature, snapshot: await snap(1, operator, enclaveId), l1Sender, l2GasLimit: 800_000n, now: await nowOf() }),
    (e) => e.code === 'stale-nonce' || e.code === 'reserve-refuses');
});

test('RENEW by deposit from an ALIASED (contract) L1 sender: still the operator on L2; outside the window or with too little headroom it is refused', T, async () => {
  const r0 = await row(id);
  // too early: the reserve's window (renewWindow 600) is not open yet
  const early = await snap(2);
  const lease = { id, kind: 2, enclaveId: ZERO32, nonce: 1n, deadline: BigInt(early.head.timestamp + 6 * 3600), payee: l1Sender, maxChargeWei: 10n ** 15n };
  const sig = await signLease(opKey, lease);
  await assert.rejects(F.planLeaseDeposit({ pins: pins(), operator, lease, signature: sig, snapshot: early, l1Sender, l2GasLimit: 800_000n, now: await nowOf() }),
    (e) => e.code === 'reserve-refuses' && /NotInRenewWindow/.test(e.message));
  // inside the window but only 550 s left: under the default 600-s headroom a deposit may not land in time
  await warp(r0.leaseUntil - 550n);
  await assert.rejects(F.planLeaseDeposit({ pins: pins(), operator, lease, signature: sig, snapshot: await snap(2), l1Sender, l2GasLimit: 800_000n, now: await nowOf() }),
    (e) => e.code === 'renew-window-too-short');
  // with a reviewed 200-s headroom, from a contract on L1 (aliased sender)
  const tracker = new F.ForcedInclusionTracker();
  const s = await snap(2);
  const { plan } = await F.planLeaseDeposit({ pins: pins(), operator, lease, signature: sig, snapshot: s, l1Sender, l2GasLimit: 800_000n, tracker, now: await nowOf(),
    policy: { minRenewHeadroomSec: 200 } });
  const { receipt } = await executeDeposit(plan, F.applyL1ToL2Alias(l1Sender));
  assert.equal(receipt.status, 'success');
  assert.ok((await row(id)).leaseUntil > r0.leaseUntil, 'renewed');
  assert.equal(viem.getAddress((await pc.getTransaction({ hash: receipt.transactionHash })).from), F.applyL1ToL2Alias(l1Sender));
});

test('negative controls: wrong signer, expired deadline, undelegated key, stale head, pin mismatch, high-s, conflicting lease in flight', T, async () => {
  const s = await snap(3);
  const lease = { id, kind: 3, enclaveId: ZERO32, nonce: 2n, deadline: BigInt(s.head.timestamp + 6 * 3600), payee: l1Sender, maxChargeWei: 10n ** 15n };
  const good = await signLease(opKey, lease);
  const base = { pins: pins(), operator, lease, signature: good, snapshot: s, l1Sender, l2GasLimit: 800_000n, now: await nowOf() };
  // wrong signer: refused by the planner; the same calldata on chain fails as a deposit (no effect)
  const forged = await signLease(generatePrivateKey(), lease);
  await assert.rejects(F.planLeaseDeposit({ ...base, signature: forged }), (e) => e.code === 'bad-signature');
  const forgedPlan = structuredClone((await F.planLeaseDeposit({ ...base })).plan);
  forgedPlan.deposit.data = viem.encodeFunctionData({ abi: F.EXECUTOR_ABI, functionName: 'lease', args: [{ ...lease }, forged] });
  forgedPlan.l1Transaction.data = viem.encodeFunctionData({ abi: F.PORTAL_ABI, functionName: 'depositTransaction', args: [operator, 0n, 800_000n, false, forgedPlan.deposit.data] });
  const fx = await executeDeposit(forgedPlan, l1Sender);
  assert.equal(fx.receipt.status, 'reverted');
  assert.equal(await read(operator, F.EXECUTOR_ABI, 'nonceOf', [id]), 2n, 'nonce untouched');
  // high-s (malleated) signature: the executor would recover nobody
  const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const sigS = viem.hexToBigInt(viem.slice(good, 32, 64)), v = viem.hexToNumber(viem.slice(good, 64, 65));
  const high = viem.concat([viem.slice(good, 0, 32), viem.pad(viem.toHex(n - sigS)), viem.toHex(v === 27 ? 28 : 27)]);
  await assert.rejects(F.planLeaseDeposit({ ...base, signature: high }), (e) => e.code === 'bad-signature');
  // a deadline the deposit may outlive
  const shortLease = { ...lease, deadline: BigInt(s.head.timestamp + 600) };
  await assert.rejects(F.planLeaseDeposit({ ...base, lease: shortLease, signature: await signLease(opKey, shortLease) }), (e) => e.code === 'deadline-too-close');
  // a lease at an already-consumed nonce (the claim used 0, the renew 1): refused before anything is sent
  const used = { ...lease, nonce: 1n };
  await assert.rejects(F.planLeaseDeposit({ ...base, lease: used, signature: await signLease(opKey, used) }), (e) => e.code === 'stale-nonce');
  // stale head, pin mismatch
  await assert.rejects(F.planLeaseDeposit({ ...base, now: s.head.timestamp + 3600 }), (e) => e.code === 'stale-head');
  await assert.rejects(F.planLeaseDeposit({ ...base, pins: { ...pins(), executor: l1Sender } }), (e) => e.code === 'pin-mismatch');
  await assert.rejects(F.planLeaseDeposit({ ...base, snapshot: { ...s, head: { ...s.head, verifiedBy: 'rpc' } } }), (e) => e.code === 'unverified-head');
  // an undelegated key: refused; and a deposit to it would "succeed" doing nothing, which the outcome check refuses
  const bareKey = generatePrivateKey(), bare = privateKeyToAccount(bareKey).address;
  const sb = await snap(3, bare);
  await assert.rejects(F.planLeaseDeposit({ ...base, operator: bare, snapshot: sb, signature: await privateKeyToAccount(bareKey).signTypedData({ domain: LEASE_DOMAIN(bare), types: LEASE_TYPES, primaryType: 'Lease', message: { reserve: addr.reserve, ...lease } }) }),
    (e) => e.code === 'operator-not-delegated');
  const hollow = structuredClone((await F.planLeaseDeposit({ ...base })).plan);
  hollow.deposit.to = bare; hollow.l1Transaction.data = viem.encodeFunctionData({ abi: F.PORTAL_ABI, functionName: 'depositTransaction', args: [bare, 0n, 800_000n, false, hollow.deposit.data] });
  const hx = await executeDeposit(hollow, l1Sender);
  assert.equal(hx.receipt.status, 'success', 'a call to a code-less EOA succeeds with no effect');
  const hh = await headNow();
  assert.throws(() => F.classifyL2Outcome({ plan: hollow, l2TransactionHash: hx.hash, receipt: hx.receipt, head: hh, now: hh.timestamp + 5,
    source: { verifier: 'test-anvil', endpoint: url }, verifiers: ['test-anvil'] }), (e) => e.code === 'receipt-mismatch');
  // tracker: the same commitment is a replay (nothing new to send); a different lease for the same deployment is ambiguous
  const tracker = new F.ForcedInclusionTracker();
  await F.planLeaseDeposit({ ...base, tracker });
  assert.equal((await F.planLeaseDeposit({ ...base, tracker })).replay, true);
  const other = { ...lease, maxChargeWei: 10n ** 14n };
  await assert.rejects(F.planLeaseDeposit({ ...base, tracker, lease: other, signature: await signLease(opKey, other) }), (e) => e.code === 'ambiguous-duplicate');
  // only a verified head past the deadline, with the nonce unconsumed, frees the slot
  const key = (await F.planLeaseDeposit({ ...base, tracker })).plan.key;
  assert.throws(() => tracker.resolveExpiredLease(key, s), (e) => e.code === 'not-expired');
  await warp(lease.deadline + 1n);
  const late = await snap(3);
  tracker.resolveExpiredLease(key, late);
  assert.equal(tracker.get(key).state, 'dead');
  // and on chain an expired lease fails as a deposit
  const ex = await executeDeposit((await F.planLeaseDeposit({ ...base, tracker: new F.ForcedInclusionTracker() })).plan, l1Sender);
  assert.equal(ex.receipt.status, 'reverted');
});

test('DIRECT owner operation (ledger.setActive) from the SAME EOA: works; from an aliased sender the real ledger refuses; unreviewed, contract-owned or ambiguous intents are refused', T, async () => {
  const head = await headNow();
  const data = viem.encodeFunctionData({ abi: A.ledger.abi, functionName: 'setActive', args: [id, false] });
  const ownerSnap = { head, authorizedAddress: (await row(id)).owner, authorizedCode: await pc.getCode({ address: alice.address }) ?? '0x',
    accountNonce: await pc.getTransactionCount({ address: alice.address }), included: [] };
  const base = { op: 'ledger.setActive', target: addr.ledger, data, from: alice.address, snapshot: ownerSnap, l2GasLimit: 200_000n, now: head.timestamp + 5 };
  const { plan } = F.planDirectDeposit(base);
  assert.deepEqual(plan.deposit.acceptableFrom, [viem.getAddress(alice.address)], 'only the owner itself');
  // an aliased L1 sender (alice as a contract on L1): the REAL ledger refuses, as a failed deposit
  const aliased = await executeDepositAs(plan, F.applyL1ToL2Alias(alice.address));
  assert.equal(aliased.status, 'reverted');
  assert.equal((await row(id)).active, true);
  // the matching check refuses that log for this operation
  assert.throws(() => F.matchDepositEvent(plan, l1Fixture(plan, F.applyL1ToL2Alias(alice.address)).receipt, l1Fixture(plan, alice.address).proof), (e) => e.code === 'l1-receipt-mismatch');
  // from alice herself: the owner's call
  const { receipt } = await executeDeposit(plan, alice.address);
  assert.equal(receipt.status, 'success');
  assert.equal((await row(id)).active, false);
  // refusals
  assert.throws(() => F.planDirectDeposit({ ...base, op: 'ledger.fundEth' }), (e) => e.code === 'unsupported-operation');
  assert.throws(() => F.planDirectDeposit({ ...base, from: l1Sender }), (e) => e.code === 'sender-mismatch');
  assert.throws(() => F.planDirectDeposit({ ...base, snapshot: { ...ownerSnap, authorizedCode: A.registry.deployedBytecode.object } }), (e) => e.code === 'sender-is-contract');
  assert.throws(() => F.planDirectDeposit({ ...base, data: viem.encodeFunctionData({ abi: A.ledger.abi, functionName: 'refund', args: [id] }) }), (e) => e.code === 'calldata-mismatch');
  // an L2-signed attempt that could still land: refused for a non-state-setter, disclosed for a reviewed state-setter
  const vaultCall = viem.encodeFunctionData({ abi: F.REVIEWED_DIRECT['sessionVault.ownerCall'].abi, functionName: 'ownerCall', args: [addr.ledger, data] });
  const prior = [{ hash: '0x' + 'ab'.repeat(32), nonce: ownerSnap.accountNonce }];
  assert.throws(() => F.planDirectDeposit({ ...base, op: 'sessionVault.ownerCall', target: addr.registry, data: vaultCall, priorL2Attempts: prior }), (e) => e.code === 'ambiguous-duplicate');
  const ss = F.planDirectDeposit({ ...base, priorL2Attempts: prior, tracker: new F.ForcedInclusionTracker() });
  assert.match(ss.plan.duplicates, /state-setter/);
  assert.throws(() => F.planDirectDeposit({ ...base, snapshot: { ...ownerSnap, included: [prior[0].hash] }, priorL2Attempts: prior }), (e) => e.code === 'already-included');
  assert.throws(() => F.planDirectDeposit({ ...base, l2GasLimit: 30_000n }), (e) => /gas-below/.test(e.code));
});

test('outcome checks fail closed: unverified receipt, same endpoint as submission, stale head, receipt above the head, unverified or mismatching L1 log', T, async () => {
  const h = await headNow();
  const plan = { operation: 'ledger.setActive', deposit: {}, binding: {} };
  const rc = { transactionHash: '0x' + '11'.repeat(32), type: 'deposit', status: 'success', blockNumber: BigInt(h.number), logs: [] };
  const base = { plan, l2TransactionHash: rc.transactionHash, receipt: rc, head: h, now: h.timestamp + 5 };
  assert.throws(() => F.classifyL2Outcome({ ...base, source: { verifier: 'rpc', endpoint: url } }), (e) => e.code === 'receipt-unverified');
  assert.throws(() => F.classifyL2Outcome({ ...base, source: { verifier: 'helios', endpoint: url, submittedVia: url } }), (e) => e.code === 'receipt-not-independent');
  assert.throws(() => F.classifyL2Outcome({ ...base, source: { verifier: 'helios', endpoint: url }, now: h.timestamp + 3600 }), (e) => e.code === 'stale-head');
  assert.throws(() => F.classifyL2Outcome({ ...base, receipt: { ...rc, blockNumber: BigInt(h.number + 5) }, source: { verifier: 'helios', endpoint: url } }), (e) => e.code === 'receipt-above-verified-head');
  assert.equal(F.classifyL2Outcome({ ...base, receipt: null, source: { verifier: 'helios', endpoint: url } }).state, 'pending');
  const s = await snap(3);
  const lease = { id, kind: 3, enclaveId: ZERO32, nonce: 2n, deadline: BigInt(s.head.timestamp + 6 * 3600), payee: l1Sender, maxChargeWei: 10n ** 15n };
  const p = (await F.planLeaseDeposit({ pins: pins(), operator, lease, signature: await signLease(opKey, lease), snapshot: s, l1Sender, l2GasLimit: 800_000n, now: s.head.timestamp + 5 })).plan;
  const f = l1Fixture(p, l1Sender);
  assert.throws(() => F.matchDepositEvent(p, f.receipt, { verifiedBy: 'rpc', headerHash: f.receipt.blockHash }), (e) => e.code === 'l1-receipt-unverified');
  assert.throws(() => F.matchDepositEvent(p, f.receipt, { ...f.proof, headerHash: ZERO32 }), (e) => e.code === 'l1-receipt-mismatch');
  assert.throws(() => F.matchDepositEvent(p, { ...f.receipt, logs: [f.receipt.logs[0], f.receipt.logs[0]] }, f.proof), (e) => /2 matching/.test(e.message));
  const tampered = l1Fixture({ ...p, l1Transaction: { ...p.l1Transaction, data: viem.encodeFunctionData({ abi: F.PORTAL_ABI, functionName: 'depositTransaction', args: [operator, 0n, 700_000n, false, p.deposit.data] }) } }, l1Sender);
  assert.throws(() => F.matchDepositEvent(p, tampered.receipt, tampered.proof), (e) => e.code === 'l1-receipt-mismatch', 'a different gas limit is a different deposit');
});

/** Execute a deposit with an explicit `from` that the plan may not accept (aliasing control): no match check. */
async function executeDepositAs(plan, from) {
  const sourceHash = getSourceHash({ domain: 'userDeposit', l1BlockHash: viem.keccak256(viem.toHex(`synthetic ${++l1Seq}`)), l1LogIndex: 0 });
  const raw = serializeTransaction({ type: 'deposit', sourceHash, from, to: plan.deposit.to, mint: 0n, value: 0n, gas: plan.deposit.gasLimit, isSystemTx: false, data: plan.deposit.data });
  return pc.waitForTransactionReceipt({ hash: await rpc('eth_sendRawTransaction', [raw]) });
}
