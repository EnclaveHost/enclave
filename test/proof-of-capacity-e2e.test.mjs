// Proof of capacity end to end on a LOCAL anvil (chain id 8453, Prague, no fork): the repository's own ledger and
// registry, EnclaveProofOfCapacity as the ledger's prover, EnclaveHostExecutor as the delegate of each host's operator
// key, and three hosts running the real host code (network/proof-of-capacity-host.mjs: the agent, the checker and the
// responder over real HTTP; network/host-carry.mjs: the order and the carrier). Real type-4 transactions; every number
// comes from receipts and from the chain.
//
//   epoch 0  three new hosts: each proves capacity for itself and is credited, in one carried transaction
//   epoch 1  on the roster, not yet checked: their own proof once more; then they check each other over HTTP and report.
//            Host C answers its checks with the digest of less work: A and B report it failed.
//   epoch 2  A and B are in standing with no proof of their own. C failed twice: its order would revert, no carrier
//            sends it, it is not credited. C then stops answering: A and B report it unreachable (duty done).
//   epoch 3  the roster is A and B, one checker each. C is back and honest, but it checked nobody in epoch 2: not yet.
//   epoch 4  C is a new host again: its own proof, credited.
//
// The operator keys hold NO ETH whenever an order is carried: the carrier pays the gas and is paid in USDC out of what
// the order unlocked. They are given ETH only for the paths this test is not about (registering, and claiming or
// renewing the lease, which in production are the paymaster's and the app's lease-gas reserve's), and it is taken back.
// Needs anvil and the forge build of contracts/ (contracts/foundry/out); skipped without them.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as viem from 'viem';
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {capacityReader, createCapacityResponder, createCapacityChecker, createCapacityAgent, selfCapacityRecord,
  capacityWork, POC_ABI, CAPACITY_CHECK_PATH} from '../network/proof-of-capacity-host.mjs';
import {proofMessage} from '../network/proof-of-capacity.mjs';
import {signCarry, carryOrder, CARRY_ABI} from '../network/host-carry.mjs';
import {linkBytecode} from '../site/js/lib/contract-linker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = path.join(ROOT, 'contracts/foundry/out');
const have = cmd => { try { execFileSync(cmd, ['--version'], {stdio: 'ignore'}); return true; } catch { return false; } };
const built = ['EnclaveDeployments.sol/EnclaveDeployments', 'EnclaveProofOfCapacity.sol/EnclaveProofOfCapacity', 'EnclaveHostExecutor.sol/EnclaveHostExecutor',
  'EnclaveHostExecutor.t.sol/ReserveStub', 'EnclaveRegistry.sol/EnclaveRegistry', 'MockUSDC.sol/MockUSDC'].every(f => fs.existsSync(path.join(OUT, f + '.json')));
const T = {skip: !have('anvil') ? 'needs anvil' : !built ? 'needs the forge build of contracts/ (forge build --offline)' : false, timeout: 300_000};
const DEV = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'];
const KEY = {deployer: DEV[0], payer: DEV[1], carrier: DEV[2]};
const EPOCH = 3600, FEE6 = 20_000n, WORK = {rounds: 400, memoryMiB: 2}, eth = viem;
const CHECKPOINT_ABI = viem.parseAbi(['function checkpoint(bytes32 id, bytes32 enclaveId, uint64 upto, uint64 anchorBlock, bytes32 anchorHash, bytes sig)']);
const recover = (typedData, signature) => viem.recoverTypedDataAddress({...typedData, signature});

let anvil, rpcUrl, pc, chain, A = {}, addr = {}, hosts = [], carrier, epoch0;
const log = [];
const freePort = () => new Promise(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params = []) => {
  const r = await fetch(rpcUrl, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
};
const art = f => { const j = JSON.parse(fs.readFileSync(path.join(OUT, f + '.json'), 'utf8')); return {abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences || {}}; };
const wc = key => viem.createWalletClient({chain, account: privateKeyToAccount(key), transport: viem.http(rpcUrl)});
async function send(key, tx) { const h = await wc(key).sendTransaction({gas: 12_000_000n, ...tx}); const rc = await pc.waitForTransactionReceipt({hash: h});
  if (rc.status !== 'success') throw new Error('reverted: ' + (tx.label || 'deploy')); return rc; }
const deploy = async (a, args = [], libs = {}) => (await send(KEY.deployer, {data: viem.encodeDeployData({abi: a.abi, bytecode: Object.keys(a.links).length ? linkBytecode(a.bytecode, a.links, libs) : a.bytecode, args})})).contractAddress;
const write = (key, address, abi, functionName, args = []) => send(key, {to: address, data: viem.encodeFunctionData({abi, functionName, args}), label: functionName});
const read = (address, abi, functionName, args = []) => pc.readContract({address, abi, functionName, args});
const chainNow = async () => Number((await pc.getBlock()).timestamp);
const warpTo = async ts => { await rpc('evm_setNextBlockTimestamp', [Number(ts)]); await rpc('evm_mine'); };
const usdcOf = a => read(addr.usdc, A.usdc.abi, 'balanceOf', [a]);
const earned = h => read(addr.ledger, A.ledger.abi, 'earned6', [h.op.address]);
// an operator key gets ETH only for what this test is not about, and gives it back
async function funded(h, fn) { await rpc('anvil_setBalance', [h.op.address, '0xde0b6b3a7640000']); try { return await fn(); } finally { await rpc('anvil_setBalance', [h.op.address, '0x0']); } }
async function lease(h) {
  const d = await read(addr.ledger, A.ledger.abi, 'get', [h.app]), now = await chainNow();
  await funded(h, () => /^0x0+$/.test(d.runner) || Number(d.leaseUntil) < now
    ? write(h.opKey, addr.ledger, A.ledger.abi, 'claim', [h.app, h.id]) : write(h.opKey, addr.ledger, A.ledger.abi, 'renew', [h.app]));
}

async function addHost(name) {
  const h = {name, opKey: generatePrivateKey(), proofKey: generatePrivateKey(), payout: privateKeyToAccount(generatePrivateKey()).address, cheat: false, logs: []};
  h.op = privateKeyToAccount(h.opKey); h.proof = privateKeyToAccount(h.proofKey);
  h.server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', async () => {
      if (req.method !== 'POST' || req.url !== CAPACITY_CHECK_PATH) { res.writeHead(404); return res.end(); }
      let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const r = await h.answer(body).catch(e => ({status: 503, body: {error: String(e.message)}}));
      res.writeHead(r.status, {'content-type': 'application/json'}); res.end(JSON.stringify(r.body));
    });
  });
  await new Promise(ok => h.server.listen(0, '127.0.0.1', ok));
  h.endpoint = `http://127.0.0.1:${h.server.address().port}`; h.id = viem.keccak256(viem.toBytes(h.endpoint));
  await funded(h, () => write(h.opKey, addr.registry, A.registry.abi, 'register', [h.endpoint, 'repo', viem.zeroHash, 10000n, 10000n, h.proof.address]));
  const args = [`catalog://app/${name}`, 0, 1000, 8000, '', true, '', viem.zeroAddress, 0, 10000];
  h.app = (await pc.simulateContract({address: addr.ledger, abi: A.ledger.abi, functionName: 'create', args, account: privateKeyToAccount(KEY.payer)})).result;
  await write(KEY.payer, addr.ledger, A.ledger.abi, 'create', args);
  await write(KEY.payer, addr.ledger, A.ledger.abi, 'fund', [h.app, 1000_000000n]);
  const domain = {chainId: 8453, contract: addr.poc}, reader = capacityReader(pc, addr.poc), sign = m => h.proof.signTypedData(m);
  const row = id => read(addr.registry, A.registry.abi, 'get', [id]).catch(() => null);
  const proofKeyOf = async id => { const e = await row(id); return e && !/^0x0+$/.test(e.proofKey) ? e.proofKey : null; };
  // a host that cheats answers with the digest of one round of the work it was asked for
  h.answer = createCapacityResponder({hostId: h.id, domain, reader, proofKeyOf, sign, recover, work: c => capacityWork(h.cheat ? {...c, rounds: 1} : c)});
  h.calls = [];
  h.agent = createCapacityAgent({host: h.id, domain, reader, sign, log: m => h.logs.push(m),
    send: async (functionName, args) => { h.calls.push({abi: POC_ABI, functionName, args}); },   // collected: the operator key sends nothing itself
    check: createCapacityChecker({host: h.id, domain, sign, recover, ...WORK, timeoutMs: 10000,
      targetOf: async id => { const e = await row(id); return e && e.active ? {endpoint: e.endpoint, proofKey: e.proofKey} : null; }}),
    selfCheck: selfCapacityRecord(h.id, WORK)});
  hosts.push(h); return h;
}

/** One round of a host: what its agent says is due, then its checkpoint, as ONE order; a carrier decides. */
async function round(h) {
  assert.equal(await pc.getBalance({address: h.op.address}), 0n, `${h.name}'s operator key holds no ETH`);
  h.calls = []; h.logs = [];
  const tick = await h.agent.tick();
  const head = await pc.getBlock(), anchor = await pc.getBlock({blockNumber: head.number - 1n}), now = Number(head.timestamp);
  const msg = proofMessage({chainId: 8453, contract: addr.poc}, {id: h.app, enclaveId: h.id, operator: h.op.address, upto: now, anchorBlock: anchor.number, anchorHash: anchor.hash});
  h.calls.push({abi: CHECKPOINT_ABI, functionName: 'checkpoint', args: [h.app, h.id, BigInt(now), anchor.number, anchor.hash, await h.proof.signTypedData(msg)]});
  const delegated = ((await pc.getCode({address: h.op.address})) || '0x') !== '0x';
  const order = await signCarry({eth, chainId: 8453, operator: h.op.address, ledger: addr.ledger, target: addr.poc, calls: h.calls,
    nonce: delegated ? await read(h.op.address, CARRY_ABI, 'carryNonce') : 0n, fee6: FEE6, payee: carrier.address, payout: h.payout,
    sign: m => h.op.signTypedData(m), now: () => now * 1000,
    authorization: delegated ? null : await h.op.signAuthorization({contractAddress: addr.executor, chainId: 8453, nonce: await pc.getTransactionCount({address: h.op.address})})});
  const before = {carrier: await usdcOf(carrier.address), payout: await usdcOf(h.payout)};
  const r = await carryOrder({order, client: pc, wallet: wc(KEY.carrier), account: carrier, minFee6: FEE6, now: () => now * 1000});
  const out = {host: h.name, tick, calls: h.calls.map(c => c.functionName), ...r};
  if (r.sent) {
    const rc = await pc.waitForTransactionReceipt({hash: r.sent}); assert.equal(rc.status, 'success');
    Object.assign(out, {gasUsed: rc.gasUsed, costWei: rc.gasUsed * rc.effectiveGasPrice, auth: !delegated,
      fee: (await usdcOf(carrier.address)) - before.carrier, paidOut: (await usdcOf(h.payout)) - before.payout});
    assert.equal(out.fee, FEE6, 'the carrier is paid the fee the host signed');
    assert.equal(await earned(h), 0n, 'everything the key earned left the ledger');
    assert.equal(await usdcOf(h.op.address), 0n, 'and none of it stayed on the operator key');
    assert.equal(await pc.getBalance({address: h.op.address}), 0n);
  }
  log.push(out); return out;
}
const epochAt = async n => { const start = (epoch0 + n) * EPOCH; await warpTo(start + 60); return epoch0 + n; };
const standing = async (h, e) => read(addr.poc, POC_ABI, 'standing', [h.id, BigInt(e)]);
const roster = async e => (await read(addr.poc, A.poc.abi, 'rosterOf', [BigInt(e)])).map(id => hosts.find(h => h.id === id)?.name).sort().join('');
const verdict = async (e, c, t) => Number(await read(addr.poc, POC_ABI, 'verdictOf', [BigInt(e), c.id, t.id]));

before(async () => {
  if (T.skip) return;
  const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
  chain = viem.defineChain({id: 8453, name: 'local-8453', nativeCurrency: {name: 'ETH', symbol: 'ETH', decimals: 18}, rpcUrls: {default: {http: [rpcUrl]}}});
  anvil = spawn('anvil', ['--port', String(port), '--chain-id', '8453', '--hardfork', 'prague', '--base-fee', '10000000', '--silent'], {stdio: 'ignore'});
  for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
  pc = viem.createPublicClient({chain, transport: viem.http(rpcUrl)});
  carrier = privateKeyToAccount(KEY.carrier);
  A = {usdc: art('MockUSDC.sol/MockUSDC'), registry: art('EnclaveRegistry.sol/EnclaveRegistry'), lib: art('EnclaveDeployments.sol/EnclaveLedgerBandwidth'),
    ledger: art('EnclaveDeployments.sol/EnclaveDeployments'), poc: art('EnclaveProofOfCapacity.sol/EnclaveProofOfCapacity'),
    stub: art('EnclaveHostExecutor.t.sol/ReserveStub'), executor: art('EnclaveHostExecutor.sol/EnclaveHostExecutor')};
  addr.usdc = await deploy(A.usdc); addr.registry = await deploy(A.registry); addr.lib = await deploy(A.lib);
  addr.ledger = await deploy(A.ledger, [addr.usdc, privateKeyToAccount(generatePrivateKey()).address, addr.registry, viem.zeroAddress],
    {[`${Object.keys(A.ledger.links)[0]}:EnclaveLedgerBandwidth`]: addr.lib});
  // a whole epoch boundary a little ahead, so the chain's clock and the contract's epochs line up
  epoch0 = Math.floor((await chainNow()) / EPOCH) + 2; await warpTo(epoch0 * EPOCH - 600);
  addr.poc = await deploy(A.poc, [addr.ledger, addr.registry, 900n, BigInt(EPOCH), 600n, 2]);
  await write(KEY.deployer, addr.ledger, A.ledger.abi, 'setProver', [addr.poc]);
  await write(KEY.deployer, addr.ledger, A.ledger.abi, 'setProofRequiredFrom', [BigInt(await chainNow())]);
  addr.executor = await deploy(A.executor, [await deploy(A.stub, [addr.ledger])]);
  await write(KEY.deployer, addr.usdc, A.usdc.abi, 'mint', [privateKeyToAccount(KEY.payer).address, 100_000_000000n]);
  await write(KEY.payer, addr.usdc, A.usdc.abi, 'approve', [addr.ledger, viem.maxUint256]);
  for (const name of ['A', 'B', 'C']) await addHost(name);
});
after(async () => { for (const h of hosts) h.server?.close(); anvil?.kill(); });

test('three hosts with empty operator keys: checked by each other, credited through a carrier, a cheat and a dead host unpaid', T, async () => {
  const [a, b, c] = hosts;
  // ---- epoch 0: new hosts, each its own proof, each credited in one carried transaction ------------------------------------
  let e = await epochAt(0);
  for (const h of hosts) await lease(h);
  await warpTo((e * EPOCH) + 600);
  for (const h of hosts) {
    const r = await round(h);
    assert.ok(r.sent, `${h.name}: ${r.refused}`); assert.equal(r.auth, true);
    assert.deepEqual(r.calls.filter(x => x !== 'touch'), ['proveSelf', 'checkpoint']);
    assert.ok(r.paidOut > 0n);
    assert.match(await pc.getCode({address: h.op.address}), /^0xef0100/, 'the key now runs the executor (EIP-7702)');
  }
  assert.equal(await roster(e + 1), 'ABC');

  // ---- epoch 1: on the roster, not yet checked: own proof; then the checks over HTTP --------------------------------------
  e = await epochAt(1);
  for (const h of hosts) await lease(h);
  await warpTo((e * EPOCH) + 600);
  c.cheat = true;
  const reports = {A: 0, B: 0, C: 0};
  for (const h of hosts) {
    const r = await round(h); assert.ok(r.sent, `${h.name}: ${r.refused}`); assert.equal(r.auth, false); assert.ok(r.calls.includes('proveSelf'));
    reports[h.name] += r.calls.filter(x => x === 'report').length;
  }
  // the epoch's first order fixed the seed, so its sender could not yet know whom to check: it does so on its next round;
  // the hosts after it checked at once, in the same order as their own proof and checkpoint
  assert.deepEqual(reports, {A: 0, B: 2, C: 2});
  await warpTo((e * EPOCH) + 1200);
  for (const h of hosts) {
    const r = await round(h);
    assert.ok(r.sent, `${h.name}: ${r.refused}`);
    reports[h.name] += r.calls.filter(x => x === 'report').length;
  }
  assert.deepEqual(reports, {A: 2, B: 2, C: 2}, 'every host reported on the two it was assigned, with a checkpoint');
  assert.deepEqual([await verdict(e, a, b), await verdict(e, b, a), await verdict(e, c, a), await verdict(e, c, b)], [1, 1, 1, 1]);
  assert.deepEqual([await verdict(e, a, c), await verdict(e, b, c)], [2, 2], 'the digest of less work is a fail, from both');

  // ---- epoch 2: A and B in standing with no proof of their own; C failed twice: not carried, not credited -------------------
  e = await epochAt(2);
  for (const h of hosts) await lease(h);
  await warpTo((e * EPOCH) + 600);
  // C stops answering from here on; A and B still owe a report on it (it is on this epoch's roster) and on each other
  await new Promise(ok => c.server.close(ok)); c.server = null;
  for (const h of [a, b]) {
    assert.deepEqual(await standing(h, e), [true, '']);
    const r = await round(h); assert.ok(r.sent, `${h.name}: ${r.refused}`); assert.ok(!r.calls.includes('proveSelf'));
  }
  assert.deepEqual(await standing(c, e), [false, 'failed its capacity checks']);
  const before = await usdcOf(c.payout);
  const refusedC = await round(c);
  assert.match(refusedC.refused, /would revert/); assert.ok(!refusedC.calls.includes('proveSelf'), 'its own word is not offered against two checkers');
  assert.equal(await usdcOf(c.payout), before); assert.equal(await earned(c), 0n);
  await warpTo((e * EPOCH) + 1200);
  for (const h of [a, b]) { const r = await round(h); assert.ok(r.sent, `${h.name}: ${r.refused}`); }
  assert.deepEqual([await verdict(e, a, b), await verdict(e, b, a)], [1, 1]);
  assert.deepEqual([await verdict(e, a, c), await verdict(e, b, c)], [3, 3], 'unreachable: duty done');
  assert.equal(await roster(e + 1), 'AB', 'a host that was not credited is off the next roster with no transaction from anyone');

  // ---- epoch 3: two hosts, one checker each; C is back but checked nobody in epoch 2 --------------------------------------
  e = await epochAt(3);
  c.cheat = false; c.server = http.createServer(); // (it only needs to exist again for after(); nobody is assigned to it this epoch)
  for (const h of hosts) await lease(h);
  await warpTo((e * EPOCH) + 600);
  for (const h of [a, b]) { assert.deepEqual(await standing(h, e), [true, '']); const r = await round(h); assert.ok(r.sent, `${h.name}: ${r.refused}`); }
  assert.deepEqual(await standing(c, e), [false, 'did not check the hosts it was assigned']);
  assert.match((await round(c)).refused, /would revert/);
  await warpTo((e * EPOCH) + 1200);
  for (const h of [a, b]) { const r = await round(h); assert.ok(r.sent, `${h.name}: ${r.refused}`); }
  assert.deepEqual([await verdict(e, a, b), await verdict(e, b, a)], [1, 1], 'two hosts: one checker each');

  // ---- epoch 4: C is a new host again -----------------------------------------------------------------------------------
  e = await epochAt(4);
  await lease(c);
  await warpTo((e * EPOCH) + 600);
  const back = await round(c);
  assert.ok(back.sent, `C: ${back.refused}`); assert.ok(back.calls.includes('proveSelf')); assert.ok(back.paidOut > 0n);

  // ---- what it cost and who got what ------------------------------------------------------------------------------------
  const sent = log.filter(x => x.sent), first = sent.filter(x => x.auth), later = sent.filter(x => !x.auth);
  const avg = xs => xs.length ? Number(xs.reduce((s, x) => s + x.gasUsed, 0n) / BigInt(xs.length)) : 0;
  console.log(`# carried ${sent.length} orders (${log.length - sent.length} not carried): gas ${avg(first)} with the key's first delegation, ${avg(later)} after; ` +
    `carrier paid ${Number(sent.reduce((s, x) => s + x.fee, 0n)) / 1e6} USDC; hosts paid out ${Number(sent.reduce((s, x) => s + x.paidOut, 0n)) / 1e6} USDC`);
  assert.equal(await usdcOf(carrier.address), FEE6 * BigInt(sent.length));
  for (const h of hosts) assert.equal(await pc.getBalance({address: h.op.address}), 0n);
});
