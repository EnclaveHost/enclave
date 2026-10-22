// Fixture test of audit-paid-leases.mjs (no production RPC, no keys): three loopback JSON-RPC providers serve a scripted
// chain whose reserve/executor code, lease() calls, receipts, LeaseGasPaid logs, ledger and nonces are REAL ABI encodings,
// so the audit's pinned verifiedLeaseAuthority + verifyLeaseReceipt run unmodified. Each case runs the audit itself.
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { createHash } from 'node:crypto';
import * as V from '../enclave/node_modules/viem/_esm/index.js';
import { EXECUTOR_ABI, RESERVE_ABI } from '../enclave/client/lease-executor-client.mjs';
const exec = promisify(execFile), here = path.dirname(new URL(import.meta.url).pathname);
const A = (n) => V.getAddress('0x' + n.repeat(40).slice(0, 40)), B32 = (n) => '0x' + n.repeat(64).slice(0, 64);
const RESERVE = A('a1'), EXECUTOR = A('a2'), LEDGER = A('a3'), REGISTRY = A('a4'), OPERATOR = A('c9'), PAYEE = A('5e'), OTHER_PAYEE = A('6f'), OWNER = A('0b');
const RES_CODE = '0x6001600101', EX_CODE = '0x6002600202', DESIGNATOR = ('0xef0100' + EXECUTOR.slice(2)).toLowerCase();
const APP1 = B32('da'), APP2 = B32('9e'), ENCLAVE = B32('4d'), HEAD = 1000n, PRE = 900n;
const LEDGER_ABI = [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
  { name: 'id', type: 'bytes32' }, { name: 'owner', type: 'address' }, { name: 'appRef', type: 'string' }, { name: 'ports', type: 'string' },
  { name: 'configCid', type: 'string' }, { name: 'gpuMilli', type: 'uint16' }, { name: 'cpuMilli', type: 'uint16' }, { name: 'appPort', type: 'uint32' },
  { name: 'isPublic', type: 'bool' }, { name: 'active', type: 'bool' }, { name: 'createdAt', type: 'uint64' }, { name: 'rate', type: 'uint256' },
  { name: 'balance6', type: 'uint256' }, { name: 'spent6', type: 'uint256' }, { name: 'runner', type: 'bytes32' }, { name: 'runnerOperator', type: 'address' },
  { name: 'leaseUntil', type: 'uint64' }] }] }];
const AUTH_ABI = V.parseAbi(['function executor() view returns (address)', 'function reserve() view returns (address)', 'function ledger() view returns (address)',
  'function registry() view returns (address)', 'function delegationCodeHash() view returns (bytes32)']);
const CALL_ABI = [...AUTH_ABI, ...EXECUTOR_ABI.filter((x) => x.name === 'nonceOf'), ...LEDGER_ABI];
const hex = (n) => '0x' + BigInt(n).toString(16);
const now = () => BigInt(Math.floor(Date.now() / 1000));
const blockHash = (n) => V.keccak256(V.toHex('block-' + n));
const block = (n) => ({ number: hex(n), hash: blockHash(n), parentHash: blockHash(n - 1n), timestamp: hex(now() - (HEAD - n) * 2n), baseFeePerGas: '0x1',
  gasLimit: '0x1c9c380', gasUsed: '0x0', miner: A('00'), extraData: '0x', difficulty: '0x0', totalDifficulty: '0x0', logsBloom: '0x' + '00'.repeat(256),
  nonce: '0x0000000000000000', mixHash: B32('00'), receiptsRoot: B32('00'), sha3Uncles: B32('00'), stateRoot: B32('00'), transactionsRoot: B32('00'),
  size: '0x1', transactions: [], uncles: [] });
// one landed lease: tx + receipt + its ledger/nonce state
function lease({ id, kind = 2, n = 950n, payee = PAYEE, from = payee, charged = 12345n, status = '0x1', enclave = ENCLAVE, to = OPERATOR }) {
  const l = { id, kind, enclaveId: enclave, nonce: 7n, deadline: 99999999999n, payee, maxChargeWei: 10n ** 15n };
  const input = V.encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'lease', args: [l, '0x' + '44'.repeat(65)] });
  const hash = V.keccak256(V.toHex(JSON.stringify([id, kind, String(n), payee, String(charged), status, enclave])));
  const topics = V.encodeEventTopics({ abi: RESERVE_ABI, eventName: 'LeaseGasPaid', args: { id, owner: OWNER, operator: OPERATOR } });
  const data = V.encodeAbiParameters([{ type: 'address' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [payee, kind, 100000n, 1n, 0n, charged]);
  const at = { blockHash: blockHash(n), blockNumber: hex(n), transactionHash: hash, transactionIndex: '0x0' };
  return { hash, n, id,
    tx: { hash, from, to, input, value: '0x0', chainId: '0x2105', ...at, nonce: '0x1', gas: '0x60000', gasPrice: '0x1', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1',
          type: '0x2', accessList: [], v: '0x0', r: B32('01'), s: B32('02'), yParity: '0x0' },
    rc: { ...at, from, to, status, gasUsed: '0x186a0', cumulativeGasUsed: '0x186a0', effectiveGasPrice: '0x1', contractAddress: null, type: '0x2',
          logsBloom: '0x' + '00'.repeat(256), logs: [{ address: RESERVE, topics, data, ...at, logIndex: '0x0', removed: false }] } };
}
let chain = {}, ledgerRunner = {};   // hash -> landed lease; deployment id -> the ledger's current runnerOperator (per deployment, not per tx)
const servers = [], modes = [];
function rpcAnswer(i, m, p) {
  const mode = modes[i];
  switch (m) {
    case 'eth_chainId': return '0x2105';
    case 'eth_blockNumber': return hex(HEAD);
    case 'eth_getBlockByNumber': return block(BigInt(p[0]));
    case 'eth_getBlockByHash': { for (let n = HEAD; n > 0n; n--) if (blockHash(n) === p[0]) return block(n); return null; }
    case 'eth_getCode': { const a = V.getAddress(p[0]); return a === RESERVE ? RES_CODE : a === EXECUTOR ? EX_CODE : a === OPERATOR ? DESIGNATOR : '0x'; }
    case 'eth_getTransactionByHash': return mode === 'notfound' ? null : chain[p[0]]?.tx ?? null;
    case 'eth_getTransactionReceipt': { if (mode === 'notfound') return null; const r = chain[p[0]]?.rc; return r && mode === 'lie' ? { ...r, status: '0x0' } : r ?? null; }
    case 'eth_call': {
      const { to, data } = p[0], f = V.decodeFunctionData({ abi: CALL_ABI, data });
      const out = (name, v) => V.encodeFunctionResult({ abi: CALL_ABI, functionName: name, result: v });
      if (f.functionName === 'executor') return out('executor', EXECUTOR);
      if (f.functionName === 'ledger') return out('ledger', LEDGER);
      if (f.functionName === 'registry') return out('registry', REGISTRY);
      if (f.functionName === 'reserve') return out('reserve', RESERVE);
      if (f.functionName === 'delegationCodeHash') return out('delegationCodeHash', V.keccak256(DESIGNATOR));
      if (f.functionName === 'nonceOf') return out('nonceOf', 8n);
      if (f.functionName === 'get') {
        return out('get', { id: f.args[0], owner: OWNER, appRef: '', ports: '', configCid: '', gpuMilli: 0, cpuMilli: 0, appPort: 0, isPublic: true, active: true,
          createdAt: 1n, rate: 1n, balance6: 1n, spent6: 0n, runner: ENCLAVE, runnerOperator: ledgerRunner[f.args[0]] ?? OPERATOR, leaseUntil: 2n ** 40n }); }
      throw new Error('unscripted call');
    }
  }
  throw new Error('unscripted ' + m);
}
for (let i = 0; i < 3; i++) {
  modes.push('ok');
  const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (modes[i] === 'down') { res.writeHead(503); return res.end('down'); }
    const j = JSON.parse(b), one = (q) => { try { return { jsonrpc: '2.0', id: q.id, result: rpcAnswer(i, q.method, q.params) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j))); }); });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok)); servers.push(s);
}
const rpcs = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixture-'));
const record = JSON.stringify({ format: 'enclave-lease-gas-deployment/v1', chainId: 8453, reserve: RESERVE, executor: EXECUTOR, ledger: LEDGER, registry: REGISTRY,
  reserveCodeHash: V.keccak256(RES_CODE), executorCodeHash: V.keccak256(EX_CODE) });
fs.writeFileSync(path.join(dir, 'record.json'), record);
const digest = 'sha256:' + createHash('sha256').update(record).digest('hex');
let fails = 0;
async function run(name, { renewals, provisional = 'provisional', planDigest = digest, startedAt = new Date(Date.now() - 3600e3).toISOString(), mode = ['ok', 'ok', 'ok'], ledger = {} }, want, reason) {
  modes.splice(0, 3, ...mode); ledgerRunner = ledger;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ productionActivated: provisional, state: provisional === 'provisional' ? 'PROVISIONAL' : 'gate running', startedAt, measurement: 'm', renewals }));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ apps: { [APP1]: 'https://a/', [APP2]: 'https://b/ping' }, leaseGas: { digest: planDigest, relays: ['https://relay.fixture'], rpcs } }));
  fs.writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ block: { number: String(PRE) }, rows: [{ id: APP1, runner: ENCLAVE }, { id: APP2, runner: ENCLAVE }] }));
  const out = path.join(dir, 'out.json');
  const r = await exec(process.execPath, [path.join(here, 'audit-paid-leases.mjs'), '--fixture-loopback', '--result', path.join(dir, 'result.json'), '--plan', path.join(dir, 'plan.json'),
    '--preflight', path.join(dir, 'preflight.json'), '--record', path.join(dir, 'record.json'), '--out', out, '--rpcs', JSON.stringify(rpcs),
    '--record-digest', digest, '--operator', OPERATOR, '--relay-payees', JSON.stringify({ 'https://relay.fixture': PAYEE })], { timeout: 120000 }).then((x) => ({ code: 0, ...x }), (e) => e);
  const o = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : { status: 'NO-OUTPUT', reason: String(r.stderr).slice(-300) };
  const text = JSON.stringify(o.apps?.map((a) => [a.status, a.reason]) ?? o.reason);
  const ok = o.status === want && (!reason || reason.test(JSON.stringify(o)));
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'NOT AS EXPECTED'} ${name}: ${o.status} (exit ${r.code}) ${String(o.reason ?? '').slice(0, 120)} ${text.slice(0, 260)}`);
  fs.rmSync(out, { force: true });
  return o;
}
const L1 = lease({ id: APP1 }), L2 = lease({ id: APP2, n: 960n });
chain = { [L1.hash]: L1, [L2.hash]: L2 };
const both = { [APP1]: L1.hash, [APP2]: L2.hash };
const o = await run('both renewals valid', { renewals: both }, 'PASS');
if (o.status === 'PASS' && !(o.apps.every((a) => a.kind === 2 && BigInt(a.chargedWei) > 0n && a.payee === PAYEE.toLowerCase()))) { fails++; console.log('NOT AS EXPECTED: PASS evidence fields'); }
await run('one provider down (2 of 3 agree)', { renewals: both, mode: ['down', 'ok', 'ok'] }, 'PASS');
await run('one provider lies (reverted)', { renewals: both, mode: ['lie', 'ok', 'ok'] }, 'PASS');
await run('two providers down', { renewals: both, mode: ['down', 'down', 'ok'] }, 'PENDING', /quorum/);
await run('not visible yet on any provider', { renewals: both, mode: ['notfound', 'notfound', 'notfound'] }, 'PENDING', /no RPC quorum on the renewal transaction/);
await run('activation not provisional', { renewals: both, provisional: false }, 'PENDING', /not provisional/);
await run('only one app recorded', { renewals: { [APP1]: L1.hash } }, 'FAIL', /exactly one/);
await run('plan digest not the reviewed record', { renewals: both, planDigest: 'sha256:' + '00'.repeat(32) }, 'FAIL', /not the reviewed/);
const claim = lease({ id: APP2, kind: 1, n: 961n }), wrongApp = lease({ id: B32('77'), n: 962n }), badPayee = lease({ id: APP2, n: 963n, payee: OTHER_PAYEE }),
  reverted = lease({ id: APP2, n: 964n, status: '0x0' }), early = lease({ id: APP2, n: 850n }), fresh = lease({ id: APP2, n: 999n }),
  zero = lease({ id: APP2, n: 965n, charged: 0n }), otherEnclave = lease({ id: APP2, n: 966n, enclave: B32('ee') }), lost = lease({ id: APP2, n: 967n });
for (const x of [claim, wrongApp, badPayee, reverted, early, fresh, zero, otherEnclave, lost]) chain[x.hash] = x;
await run('a claim recorded as renewal', { renewals: { [APP1]: L1.hash, [APP2]: claim.hash } }, 'FAIL', /not a renewal/);
await run('another app\'s renewal', { renewals: { [APP1]: L1.hash, [APP2]: wrongApp.hash } }, 'FAIL', /not this app/);
await run('payee not a configured relay', { renewals: { [APP1]: L1.hash, [APP2]: badPayee.hash } }, 'FAIL', /configured relay payee/);
await run('reverted on every provider', { renewals: { [APP1]: L1.hash, [APP2]: reverted.hash } }, 'FAIL', /reverted/);
await run('mined before the preflight block', { renewals: { [APP1]: L1.hash, [APP2]: early.hash } }, 'FAIL', /not after the preflight block/);
await run('not 2 confirmations deep yet', { renewals: { [APP1]: L1.hash, [APP2]: fresh.hash } }, 'PENDING', /agreed \(2-confirmation\) head/);
await run('zero app-reserve charge', { renewals: { [APP1]: L1.hash, [APP2]: zero.hash } }, 'FAIL', /positive charge/);
await run('another enclave', { renewals: { [APP1]: L1.hash, [APP2]: otherEnclave.hash } }, 'FAIL', /preflight runner/);
await run('ledger no longer shows this operator', { renewals: { [APP1]: L1.hash, [APP2]: lost.hash }, ledger: { [APP2]: A('99') } }, 'FAIL', /ledger does not show this renewal/);
await run('activation before the receipt? no: receipt before activation start', { renewals: both, startedAt: new Date(Date.now() + 3600e3).toISOString() }, 'FAIL', /before the activation started/);
for (const s of servers) s.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('TEST-AUDIT', fails ? `FAIL (${fails})` : 'PASS'); process.exit(fails ? 1 : 0);
