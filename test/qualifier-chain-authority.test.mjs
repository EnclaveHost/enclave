// The qualification checker's chain authority (network/qualifier-chain.mjs, used by scripts/network/wg-qualify.mjs):
// without --chain-authority nothing changes; an EXPLICIT host-local verifier is the only source of every chain read
// (through the reviewed network/chain-authority.mjs client), mixed selections refuse, and verifier outage / proof failure /
// another chain / a stale head fail the read: nothing is asked of any provider. The verifier is a loopback JSON-RPC
// stand-in that answers like the patched Helios; a decoy "public RPC" counts every request it would get (must stay 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeFunctionResult, decodeFunctionData, parseAbi, pad, toHex, stringToHex } from 'viem';
import { qualifierChainAuthority } from '../network/qualifier-chain.mjs';
import { connectivityAddress } from '../network/onchain-qualification.mjs';
import { hostABI } from '../network/registry-abi.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907', REGISTRY = '0x' + 'ee'.repeat(20), CONN = '0x' + 'cc'.repeat(20);
const HOST = '0x' + 'ab'.repeat(32), OWNER = '0x' + '44'.repeat(20);
const bookABI = parseAbi(['function addr(bytes32) view returns (address)']);
const servers = [];
test.after(() => { for (const s of servers) s.close(); });
const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); servers.push(s); s.listen(0, '127.0.0.1', () => ok(s)); });

async function verifierStandIn() {
  const st = { head: 1000n, mode: {}, calls: [] };
  const s = await listen((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const { id, method, params } = JSON.parse(body); st.calls.push(method);
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, ...o })); };
      if (st.mode.down) { res.writeHead(502); res.end(); return; }
      if (method === 'eth_chainId') return send({ result: toHex(st.mode.wrongChain ? 10 : 8453) });
      if (method === 'eth_blockNumber') return send({ result: toHex(st.head) });
      if (method === 'eth_getBlockByNumber') return send({ result: { number: params[0], hash: pad(toHex(BigInt(params[0])), { size: 32 }), gasLimit: '0x1c9c380',
        timestamp: toHex(Math.floor(Date.now() / 1000) - (st.mode.stale ? 600 : 1)) } });
      if (method === 'eth_call') {
        if (st.mode.proofFail) return send({ error: { code: -32000, message: 'invalid account proof for address ' + params[0].to } });
        const to = params[0].to.toLowerCase();
        if (to === BOOK) { const d = decodeFunctionData({ abi: bookABI, data: params[0].data });
          const name = d.args[0] === stringToHex('registry', { size: 32 }) ? REGISTRY : d.args[0] === stringToHex('connectivity', { size: 32 }) ? CONN : '0x' + '00'.repeat(20);
          return send({ result: encodeFunctionResult({ abi: bookABI, functionName: 'addr', result: name }) }); }
        if (to === REGISTRY) { const d = decodeFunctionData({ abi: hostABI, data: params[0].data }); assert.equal(d.args[0], HOST);
          return send({ result: encodeFunctionResult({ abi: hostABI, functionName: 'get', result: { endpoint: 'https://h', repo: 'r', measurement: pad('0x01', { size: 32 }),
            operator: OWNER, registeredAt: 1n, lastSeen: 2n, active: true, cpuPricePerSec6: 0n, gpuPricePerSec6: 0n, proofKey: OWNER, payoutWallet: OWNER } }) }); }
        return send({ error: { code: 3, message: 'execution reverted' } });
      }
      return send({ error: { code: -32601, message: 'method not supported' } });
    });
  });
  return { st, url: `http://127.0.0.1:${s.address().port}/` };
}
async function decoyPublicRpc() {
  const hits = { n: 0 };
  const s = await listen((req, res) => { hits.n++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":"0x2105"}'); });
  return { hits, url: `http://127.0.0.1:${s.address().port}/` };
}
// what the checker reads (wg-qualify.mjs hostOperator + connectivityAddress), through the selected `chain`
const hostOperator = async (chain) => {
  const registry = await chain.readContract({ address: BOOK, abi: bookABI, functionName: 'addr', args: [stringToHex('registry', { size: 32 })] });
  const h = await chain.readContract({ address: registry, abi: hostABI, functionName: 'get', args: [HOST] });
  return h.active ? h.operator.toLowerCase() : null;
};
const T = { timeout: 30000 };

test('legacy selection is unchanged: no --chain-authority (or quorum) returns null; a verifier without the mode refuses', () => {
  assert.equal(qualifierChainAuthority({}), null);
  assert.equal(qualifierChainAuthority({ authority: 'quorum', rpc: ['https://base-rpc.publicnode.com'] }), null);
  assert.throws(() => qualifierChainAuthority({ verifier: 'http://127.0.0.1:1/' }), /not verifier/);
  assert.throws(() => qualifierChainAuthority({ authority: 'helios' }), /quorum or verifier/);
});

test('explicit verifier: mixed selections and non-local verifiers refuse before any request', async () => {
  const decoy = await decoyPublicRpc();
  assert.throws(() => qualifierChainAuthority({ authority: 'verifier', verifier: 'http://127.0.0.1:1/', rpc: [decoy.url] }), /--rpc is not used/);
  assert.throws(() => qualifierChainAuthority({ authority: 'verifier', verifier: 'http://127.0.0.1:1/', independent: true }), /--independent/);
  assert.throws(() => qualifierChainAuthority({ authority: 'verifier' }), /needs --chain-verifier/);
  assert.throws(() => qualifierChainAuthority({ authority: 'verifier', verifier: 'https://rpc.example.org/' }), /loopback|local/);
  assert.throws(() => qualifierChainAuthority({ authority: 'verifier', verifier: 'http://127.0.0.1:1/', chainId: 1 }), /Base \(8453\) only/);
  assert.equal(decoy.hits.n, 0);
});

test('explicit verifier: the registry operator and connectivity address are read through the local verifier only', T, async () => {
  const v = await verifierStandIn();
  const chain = qualifierChainAuthority({ authority: 'verifier', verifier: v.url });
  const d = chain.describe();
  assert.equal(d.authority, 'local-verifier'); assert.equal(d.tier, 'unsafe'); assert.equal(d.attested, false, 'the host-local helper is never labelled attested');
  assert.equal(await hostOperator(chain), OWNER);
  assert.equal((await connectivityAddress(chain, BOOK)).toLowerCase(), CONN);
  assert.ok(v.st.calls.filter((m) => m === 'eth_call').length >= 3);
  assert.ok(v.st.calls.includes('eth_chainId') && v.st.calls.includes('eth_blockNumber'), 'chain and head freshness checked before reads');
});

test('verifier down, stale, on another chain, or failing a proof: every read throws, no provider is asked', T, async () => {
  for (const [mode, why] of [['down', /verifier|502|cannot answer/i], ['stale', /stale|old/], ['wrongChain', /follows chain 10/], ['proofFail', /proof/]]) {
    const v = await verifierStandIn(); v.st.mode[mode] = true;
    const decoy = await decoyPublicRpc();
    const chain = qualifierChainAuthority({ authority: 'verifier', verifier: v.url });
    await assert.rejects(hostOperator(chain), why, mode);
    await assert.rejects(connectivityAddress(chain, BOOK), why, mode);
    assert.equal(decoy.hits.n, 0, mode);
  }
});

// the real script: legacy behaviour still runs; the explicit verifier is wired and refuses a mixed selection
const run = (args) => new Promise((resolve) => execFile(process.execPath, [path.join(REPO, 'scripts/network/wg-qualify.mjs'), ...args], { cwd: REPO, timeout: 60000 },
  (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: so + se })));
test('wg-qualify.mjs: legacy run unchanged; --chain-authority verifier logs the local authority; --rpc with it refuses', T, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qualify-'));
  try {
    const key = path.join(dir, 'k'); fs.writeFileSync(key, '0x' + randomBytes(32).toString('hex'));   // throwaway test key
    const recs = path.join(dir, 'r.json'); fs.writeFileSync(recs, '[]');
    const legacy = await run(['--key-file', key, '--wg', '/bin/false', '--records', recs, '--out', path.join(dir, 'o1.json')]);
    assert.equal(legacy.code, 0, legacy.out); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'o1.json'), 'utf8')), []);
    assert.doesNotMatch(legacy.out, /chain reads:/);
    const v = await verifierStandIn();
    const ok = await run(['--key-file', key, '--wg', '/bin/false', '--records', recs, '--out', path.join(dir, 'o2.json'), '--chain-authority', 'verifier', '--chain-verifier', v.url]);
    assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /chain reads: .*"authority":"local-verifier".*"attested":false/);
    const decoy = await decoyPublicRpc();
    const mixed = await run(['--key-file', key, '--wg', '/bin/false', '--records', recs, '--chain-authority', 'verifier', '--chain-verifier', v.url, '--rpc', decoy.url]);
    assert.notEqual(mixed.code, 0); assert.match(mixed.out, /--rpc is not used with --chain-authority verifier/); assert.equal(decoy.hits.n, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
