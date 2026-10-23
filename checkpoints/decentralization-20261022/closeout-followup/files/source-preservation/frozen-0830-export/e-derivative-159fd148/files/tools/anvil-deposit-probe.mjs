// PROBE (not a test): does anvil --network optimism execute a raw 0x7E deposit (viem serializer), with what `from`,
// what GASPRICE, and is its tx hash keccak(serialized)? Offline, loopback only.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createPublicClient, http, keccak256, encodeFunctionData } from 'viem';
import { serializeTransaction } from 'viem/op-stack';
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await free();
const args = ['--network', 'optimism', '--chain-id', '8453', '--port', String(port), '--host', '127.0.0.1', ...process.argv.slice(2)];
const a = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; a.stdout.on('data', (d) => { log += d; }); a.stderr.on('data', (d) => { log += d; });
const url = `http://127.0.0.1:${port}`;
const rpc = async (method, params = []) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return r.json(); };
for (let i = 0; i < 100; i++) { try { if ((await rpc('eth_chainId')).result) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
try {
  console.log('args', args.join(' '));
  console.log('chainId', (await rpc('eth_chainId')).result);
  // a contract that stores GASPRICE, CALLER and ORIGIN: runtime 3a600055 33600155 32600255 00
  const runtime = '0x3a600055336001553260025500';
  const init = '0x6d' + runtime.slice(2).padEnd(28, '0') + '6000526' + '00e' + '6012' + 'f3';
  const dev = (await rpc('eth_accounts')).result[0];
  const dep = await rpc('eth_sendTransaction', [{ from: dev, data: '0x6c' + runtime.slice(2) + '60005260' + (13).toString(16).padStart(2, '0') + '6013f3' }]);
  const rc = (await rpc('eth_getTransactionReceipt', [dep.result])).result;
  const target = rc.contractAddress;
  console.log('target', target, 'code', (await rpc('eth_getCode', [target, 'latest'])).result);
  const from = '0x1234567890123456789012345678901234567890';
  const tx = { type: 'deposit', sourceHash: keccak256('0x01'), from, to: target, mint: 0n, value: 0n, gas: 200000n, isSystemTx: false, data: '0x' };
  const raw = serializeTransaction(tx);
  const sent = await rpc('eth_sendRawTransaction', [raw]);
  console.log('sendRaw', JSON.stringify(sent), 'keccak(serialized)', keccak256(raw));
  if (sent.result) {
    const r2 = (await rpc('eth_getTransactionReceipt', [sent.result])).result;
    console.log('receipt', JSON.stringify(r2));
    const t2 = (await rpc('eth_getTransactionByHash', [sent.result])).result;
    console.log('tx', JSON.stringify(t2));
    for (const s of [0, 1, 2]) console.log('slot', s, (await rpc('eth_getStorageAt', [target, '0x' + s.toString(16), 'latest'])).result);
  }
} catch (e) { console.log('ERR', e.message); }
a.kill('SIGKILL');
console.log('anvil log tail:', log.split('\n').slice(-8).join(' | ').slice(0, 1500));
