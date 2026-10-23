// END-TO-END (offline): the pinned maintained verifier (Helios, patched branch enclave-base-compat on 2af9b418) reads
// Enclave contract state through network/op-head-relay.mjs (signed head) and network/witness-gateway.mjs (untrusted
// witnesses), against a local Anvil chain with chain id 8453. Meant to run inside `unshare -r -n` (no external network
// at all, i.e. every external RPC provider is down).
//
// SYNTHETIC: the sequencer key is a TEST key (Helios [base.chain] unsafe_signer override in a private HOME) signing
// Anvil blocks. This proves the verifier and bridge mechanics and the refusal rules, NOT live Base compatibility.
//   env: HELIOS_BIN (patched), HELIOS_STOCK_BIN (stock 0.12.0, optional), ANVIL_BIN, TEST_TMP (disk scratch dir)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createPublicClient, createWalletClient, http as viemHttp, encodeAbiParameters, keccak256, stringToHex, pad, encodeFunctionData, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHeadRelay } from '../network/op-head-relay.mjs';
import { createWitnessGateway, dirWitnessCache } from '../network/witness-gateway.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';

const { HELIOS_BIN, HELIOS_STOCK_BIN, ANVIL_BIN = 'anvil' } = process.env;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'helios-e2e-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const REGISTRY = '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac', DEPLOYMENTS = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';
const artifact = JSON.parse(fs.readFileSync(new URL('../contracts/foundry/out/EnclaveAddressBook.sol/EnclaveAddressBook.json', import.meta.url)));
const chain = defineChain({ id: 8453, name: 'anvil-8453', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const children = new Set(), closers = [];
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), { rpc: j.error });
  return j.result;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`timed out waiting for ${what}${last ? ': ' + last.message : ''}`);
}
function start(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  p.log = ''; const keep = (d) => { p.log = (p.log + d).slice(-20000); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.exited = new Promise((r) => p.on('exit', (code, signal) => { children.delete(p); r({ code, signal }); }));
  children.add(p); return p;
}
async function startHelios(bin, { consensus, execution, tag }) {
  const home = path.join(TMP, 'home-' + tag); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  // TEST-ONLY override of the pinned Base unsafe signer, so Helios accepts commitments signed by the test key
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  const p = start(bin, ['opstack', '--network', 'base', '--consensus-rpc', consensus, '--execution-rpc', execution, '--rpc-port', String(port)],
    { env: { HOME: home, PATH: process.env.PATH, RUST_LOG: 'info' } });
  p.url = `http://127.0.0.1:${port}/`;
  return p;
}
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { p.kill('SIGTERM'); await Promise.race([p.exited, sleep(5000)]); if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); await p.exited; } };
const slotOf = (name, n) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [stringToHex(name, { size: 32 }), n]));
const word = (a) => pad(a.toLowerCase(), { size: 32 });

let anvil, anvilUrl, book, relay, relayUrl, gateway, gatewayUrl, head;
test.before(async () => {
  const port = await freePort();
  anvil = start(ANVIL_BIN, ['--port', String(port), '--chain-id', '8453', '--silent']);
  anvilUrl = `http://127.0.0.1:${port}/`;
  await until(() => rpc(anvilUrl, 'eth_chainId'), 20000, 'anvil');
  const wallet = createWalletClient({ account: DEPLOYER, chain, transport: viemHttp(anvilUrl) });
  const pub = createPublicClient({ chain, transport: viemHttp(anvilUrl) });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  book = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  for (const [k, v] of [['registry', REGISTRY], ['deployments', DEPLOYMENTS]])
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: book, abi: artifact.abi, functionName: 'set', args: [stringToHex(k, { size: 32 }), v] }) });
  // the head Helios will verify against: the latest Anvil block, its raw transactions, signed by the test sequencer key
  const b = await rpc(anvilUrl, 'eth_getBlockByNumber', ['latest', false]);
  const txs = await Promise.all(b.transactions.map((h) => rpc(anvilUrl, 'eth_getRawTransactionByHash', [h])));
  head = { number: BigInt(b.number), hash: b.hash, stateRoot: b.stateRoot, txs };
  relay = createHeadRelay({ chainId: 8453, signer: seqSigner, maxAgeMs: 300000 });
  const offered = await relay.offer(await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs }));
  assert.equal(offered.accepted, true, JSON.stringify(offered));
  relayUrl = await relay.listen(0);
  gateway = createWitnessGateway({ upstreams: [anvilUrl], cache: dirWitnessCache(path.join(TMP, 'witness-cache')) });
  gatewayUrl = await gateway.listen(0);
  closers.push(() => relay.close(), () => gateway.close());
});
test.after(async () => {
  for (const c of closers.reverse()) await c().catch(() => {});
  for (const p of [...children]) await stop(p);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const T = { timeout: 120000 };
test('patched Helios follows the signed head and returns proof-verified Enclave contract state', T, async (t) => {
  assert.ok(HELIOS_BIN, 'HELIOS_BIN required');
  const h = await startHelios(HELIOS_BIN, { consensus: relayUrl, execution: gatewayUrl, tag: 'patched-1' });
  t.after(() => stop(h));
  await until(async () => BigInt(await rpc(h.url, 'eth_blockNumber')) === head.number, 60000, 'Helios to adopt the signed head');
  assert.equal(await rpc(h.url, 'eth_chainId'), '0x2105');
  const blk = await rpc(h.url, 'eth_getBlockByNumber', ['latest', false]);
  assert.equal(blk.hash, head.hash); assert.equal(blk.stateRoot, head.stateRoot);
  // AddressBook addr["registry"] is at mapping slot 3 in the CURRENT source (the deployed book predates pendingOwner: slot 2)
  assert.equal(await rpc(h.url, 'eth_getStorageAt', [book, slotOf('registry', 3n), 'latest']), word(REGISTRY));
  assert.equal(await rpc(h.url, 'eth_getStorageAt', [book, slotOf('registry', 2n), 'latest']), pad('0x0', { size: 32 }));
  assert.equal(await rpc(h.url, 'eth_getCode', [book, 'latest']), await rpc(anvilUrl, 'eth_getCode', [book, 'latest']));
  assert.equal(await rpc(h.url, 'eth_getBalance', [DEPLOYER.address, 'latest']), await rpc(anvilUrl, 'eth_getBalance', [DEPLOYER.address, head.hash ? { blockHash: head.hash } : 'latest']));
  const proof = await rpc(h.url, 'eth_getProof', [book, [slotOf('deployments', 3n)], 'latest']);
  assert.equal(BigInt(proof.storageProof[0].value), BigInt(DEPLOYMENTS));
  // local EVM execution is REFUSED: Base mainnet has run Azul+ (Osaka + Base precompiles) since 1779991200 and the
  // pinned op-revm only implements up to Prague for this chain
  const data = encodeFunctionData({ abi: artifact.abi, functionName: 'addr', args: [stringToHex('registry', { size: 32 })] });
  await assert.rejects(rpc(h.url, 'eth_call', [{ to: book, data }, 'latest']), /local execution refused/);
  assert.equal(h.exitCode, null, 'verifier still running');
});

test('a tampered witness is rejected by the verifier, never returned', T, async (t) => {
  // a proxy between the gateway and Anvil that rewrites every proven storage value
  const tamper = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    const up = await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    const j = await up.json();
    if (j.result?.storageProof) for (const s of j.result.storageProof) s.value = '0x' + 'beef'.padStart(40, '0');
    res.end(JSON.stringify(j));
  }); });
  await new Promise((r) => tamper.listen(0, '127.0.0.1', r));
  const g = createWitnessGateway({ upstreams: [`http://127.0.0.1:${tamper.address().port}/`] });
  const gUrl = await g.listen(0);
  const h = await startHelios(HELIOS_BIN, { consensus: relayUrl, execution: gUrl, tag: 'tamper' });
  t.after(async () => { await stop(h); await g.close(); tamper.close(); });
  await until(async () => BigInt(await rpc(h.url, 'eth_blockNumber')) === head.number, 60000, 'head');
  await assert.rejects(rpc(h.url, 'eth_getStorageAt', [book, slotOf('registry', 3n), 'latest']));
  await assert.rejects(rpc(h.url, 'eth_getProof', [book, [slotOf('registry', 3n)], 'latest']));
});

// A raw consensus stub (no relay rules) to show what the VERIFIER does with heads the relay would never serve.
async function rawConsensus() {
  let body = null;
  const s = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : body)));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/`, set: (b) => { body = b; }, close: () => s.close() };
}
async function nextFields(n, salt) {
  const b = await rpc(anvilUrl, 'eth_getBlockByNumber', ['latest', false]);
  return { ...blockFields(b), number: head.number + BigInt(n), hash: pad(`0x${(0xc0de00 + n + salt).toString(16)}`, { size: 32 }), timestamp: BigInt(Math.floor(Date.now() / 1000)) };
}

test('wrong-signer heads are ignored; a signed head with a 0x79 transaction is refused without killing the patched verifier', T, async (t) => {
  const stub = await rawConsensus();
  const b = await rpc(anvilUrl, 'eth_getBlockByNumber', ['latest', false]);
  stub.set(await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs: head.txs }));
  const h = await startHelios(HELIOS_BIN, { consensus: stub.url, execution: gatewayUrl, tag: 'raw-patched' });
  t.after(async () => { await stop(h); stub.close(); });
  await until(async () => BigInt(await rpc(h.url, 'eth_blockNumber')) === head.number, 60000, 'head');
  stub.set(await makeCommitment(await nextFields(1, 0), { chainId: 8453, privateKey: '0x' + '77'.repeat(32) }));
  await sleep(3500);
  assert.equal(BigInt(await rpc(h.url, 'eth_blockNumber')), head.number, 'a head signed by another key is not adopted');
  stub.set(await makeCommitment(await nextFields(2, 0), { chainId: 8453, privateKey: SEQ_KEY, txs: ['0x79c0'] }));
  await sleep(3500);
  assert.equal(h.exitCode, null, 'patched verifier must survive an undecodable transaction type');
  assert.equal(h.signalCode, null);
  assert.equal(BigInt(await rpc(h.url, 'eth_blockNumber')), head.number, 'the undecodable block is not adopted');
  // This debug build unwinds panics, so an unwrap() panic would only kill the head task, silently and for good. The
  // head loop must still be alive: a valid higher head is adopted.
  stub.set(await makeCommitment(await nextFields(4, 0), { chainId: 8453, privateKey: SEQ_KEY, txs: head.txs }));
  await until(async () => BigInt(await rpc(h.url, 'eth_blockNumber')) === head.number + 4n, 15000, 'the head loop to adopt a valid higher block');
});

test('stock Helios 0.12.0 (comparison only): executes eth_call under the wrong spec and dies on a 0x79 transaction', { ...T, skip: !HELIOS_STOCK_BIN && 'HELIOS_STOCK_BIN not set' }, async (t) => {
  const stub = await rawConsensus();
  const b = await rpc(anvilUrl, 'eth_getBlockByNumber', ['latest', false]);
  stub.set(await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs: head.txs }));
  const h = await startHelios(HELIOS_STOCK_BIN, { consensus: stub.url, execution: gatewayUrl, tag: 'raw-stock' });
  t.after(async () => { await stop(h); stub.close(); });
  await until(async () => BigInt(await rpc(h.url, 'eth_blockNumber')) === head.number, 60000, 'head');
  const data = encodeFunctionData({ abi: artifact.abi, functionName: 'addr', args: [stringToHex('registry', { size: 32 })] });
  const out = await rpc(h.url, 'eth_call', [{ to: book, data }, 'latest']);
  t.diagnostic(`stock eth_call result (Prague rules on a Base Azul+ timestamp): ${out}`);
  stub.set(await makeCommitment(await nextFields(3, 0), { chainId: 8453, privateKey: SEQ_KEY, txs: ['0x79c0'] }));
  const exit = await Promise.race([h.exited, sleep(8000).then(() => null)]);
  t.diagnostic(`stock verifier after a 0x79 head: ${exit ? JSON.stringify(exit) : 'still running'}; log tail: ${h.log.slice(-300).replace(/\s+/g, ' ')}`);
  assert.ok(exit, 'stock 0.12.0 is expected to abort (unwrap with panic=abort)');
});

test('outage of EVERY execution source: a restarted verifier still proves state for the pinned block from the witness cache; anything else and any tx refuse', T, async (t) => {
  // the first test populated the gateway cache with the witnesses Helios fetched for the signed head (by block hash)
  await stop(anvil);                                    // the only execution source is gone; no network exists at all
  const h = await startHelios(HELIOS_BIN, { consensus: relayUrl, execution: gatewayUrl, tag: 'outage' });
  t.after(() => stop(h));
  await until(async () => BigInt(await rpc(h.url, 'eth_blockNumber')) === head.number, 60000, 'head');
  assert.equal(await rpc(h.url, 'eth_getStorageAt', [book, slotOf('registry', 3n), 'latest']), word(REGISTRY));
  assert.ok(gateway.stats().cacheHits >= 1, 'served from the witness cache');
  // a slot never fetched before has no source: refused, not guessed
  await assert.rejects(rpc(h.url, 'eth_getStorageAt', [book, slotOf('featured', 3n), 'latest']));
  await assert.rejects(rpc(h.url, 'eth_sendRawTransaction', ['0x02f86b822105808080809400000000000000000000000000000000000000008080c080a0' + '11'.repeat(32) + 'a0' + '22'.repeat(32)]));
  t.diagnostic(`gateway stats: ${JSON.stringify(gateway.stats())}`);
});
