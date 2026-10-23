// READ-ONLY live fixture recorder (rpc-priority worker). No transaction, no write to any chain.
//  1. picks a recent REAL Base mainnet block that two distinct public providers report identically (hash + stateRoot);
//  2. signs a commitment for it with a TEST sequencer key (Helios [base.chain] unsafe_signer override) - the head is
//     synthetic in authority only; its state root is the real one both providers reported;
//  3. runs the patched Helios (Base EVM backend) with execution witnesses fetched through the witness gateway from ONE
//     provider and recorded into a block-hash-pinned cache (eth_createAccessList refused so fetches are exactly what
//     execution touches);
//  4. for each call: Helios's proof-backed result vs both providers' eth_call at the same block hash.
// usage: node record-base-calls.mjs <repo> <helios-bin> <outdir>
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
const [repo, heliosBin, out] = process.argv.slice(2);
const imp = (p) => import(path.resolve(repo, p));
const { createWitnessGateway, dirWitnessCache, WITNESS_METHODS } = await imp('network/witness-gateway.mjs');
const { makeCommitment, blockFields } = await imp('test/fixtures/op-commitment.mjs');
const { privateKeyToAccount } = await imp('node_modules/viem/_esm/accounts/index.js');
const { encodeFunctionData, stringToHex } = await imp('node_modules/viem/_esm/index.js');
fs.mkdirSync(out, { recursive: true });
const P1 = 'https://mainnet.base.org', P2 = 'https://base.gateway.tenderly.co';
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, method, params, ms = 20000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (j.error) return { error: j.error };
  return { result: j.result };
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// 1. a block both providers agree on
const head = Number((await rpc(P1, 'eth_blockNumber', [])).result);
const num = '0x' + (head - 4).toString(16);
const b1 = (await rpc(P1, 'eth_getBlockByNumber', [num, false])).result;
const b2 = (await rpc(P2, 'eth_getBlockByNumber', [num, false])).result;
if (!b1 || !b2 || b1.hash !== b2.hash || b1.stateRoot !== b2.stateRoot) throw new Error('providers disagree or failed: ' + JSON.stringify([b1?.hash, b2?.hash]));
const block = { number: Number(b1.number), hash: b1.hash, stateRoot: b1.stateRoot, timestamp: Number(b1.timestamp) };
const commitment = await makeCommitment(blockFields(b1), { chainId: 8453, privateKey: SEQ_KEY, txs: [] });

// 2. consensus stub + recording gateway + Helios
const http = await import('node:http');
const cons = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : commitment)));
await new Promise((r) => cons.listen(0, '127.0.0.1', r));
const gw = createWitnessGateway({ upstreams: [P1], cache: dirWitnessCache(path.join(out, 'cache')), methods: WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList') });
const gwUrl = await gw.listen(0);
const home = path.join(out, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n\n[base.chain.forks]\nexecution_unsupported_from_timestamp = 9223372036854775807\n`);
const port = await freePort();
const h = spawn(heliosBin, ['opstack', '--network', 'base', '--consensus-rpc', `http://127.0.0.1:${cons.address().port}/`, '--execution-rpc', gwUrl, '--rpc-port', String(port)],
  { env: { HOME: home, PATH: process.env.PATH, RUST_LOG: 'info,helios=debug,helios_opstack=debug,helios_core=debug' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; h.stdout.on('data', (d) => { log = (log + d).slice(-30000); }); h.stderr.on('data', (d) => { log = (log + d).slice(-30000); });
const HL = `http://127.0.0.1:${port}/`;
try {
  for (let i = 0; i < 120; i++) { const r = await rpc(HL, 'eth_blockNumber', []).catch(() => ({})); if (r.result && Number(r.result) === block.number) break; await sleep(500); }
  const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
  const bookAbi = [{ type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'all', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32[]' }, { type: 'address[]' }] }];
  const calls = [
    { name: 'EnclaveAddressBook.addr("registry")', tx: { to: BOOK, data: encodeFunctionData({ abi: bookAbi, functionName: 'addr', args: [stringToHex('registry', { size: 32 })] }) } },
    { name: 'EnclaveAddressBook.all()', tx: { to: BOOK, data: encodeFunctionData({ abi: bookAbi, functionName: 'all' }) } },
    { name: 'Base ActivationRegistry.admin() (Beryl/Cobalt state-backed precompile 0x8453..01)', tx: { to: '0x8453000000000000000000000000000000000001', data: '0xf851a440' } },
    { name: 'Osaka CLZ in a creation call (initcode returns clz(1) word)', tx: { data: '0x60011e60005260206000f3' } },
    { name: 'P256VERIFY (0x100) revm-precompile vector ok_1', tx: { to: '0x0000000000000000000000000000000000000100', data: '0x4cee90eb86eaa050036147a12d49004b6b9c72bd725d39d4785011fe190f0b4da73bd4903f0ce3b639bbbf6e8e80d16931ff4bcf5993d58468e8fb19086e8cac36dbcd03009df8c59286b162af3bd7fcc0450c9aa81be5d10d312af6c66b1d604aebd3099c618202fcfe16ae7770b0c49ab5eadf74b754204a3bb6060e44eff37618b065f9832de4ca6ca971a7a1adc826d0f7c00181a5fb2ddf79ae00b4e10e' } },
  ];
  for (const c of calls) {
    c.p1 = await rpc(P1, 'eth_call', [c.tx, { blockHash: block.hash }]); await sleep(300);
    c.p2 = await rpc(P2, 'eth_call', [c.tx, { blockHash: block.hash }]); await sleep(300);
    const t0 = Date.now();
    c.helios = await rpc(HL, 'eth_call', [c.tx, 'latest'], 240000).catch((e) => ({ error: { message: String(e?.message || e) } }));
    c.heliosMs = Date.now() - t0;
    console.log(c.name, c.heliosMs + 'ms', JSON.stringify(gw.stats()));
    c.agree = c.p1.result !== undefined && c.p1.result === c.p2.result && c.helios.result === c.p1.result;
  }
  const fixture = { format: 'enclave-base-call-fixture/v1', recordedAt: new Date().toISOString(), providers: [P1, P2], block, testSequencerSigner: seqSigner,
    commitment, calls, gatewayStats: gw.stats(), note: 'Head signature is a TEST key over a real block both providers reported; proofs recorded from P1 only, verified by Helios against that state root.' };
  fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(fixture, null, 1) + '\n');
  console.log(JSON.stringify({ block, calls: calls.map((c) => ({ name: c.name, agree: c.agree, p1: c.p1.result ?? c.p1.error, helios: c.helios.result ?? c.helios.error })), stats: gw.stats() }, null, 1));
} finally {
  console.log('gateway stats at exit', JSON.stringify(gw.stats()));
  h.kill('SIGTERM'); await gw.close(); cons.close();
  fs.writeFileSync(path.join(out, 'helios.log'), log);
}
