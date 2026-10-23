// END-TO-END: the independent CLI (cli/enclave.mjs as a process, behind the network guard) and the independent MCP
// authority (mcp/independent.mjs Authority + Scope) with --chain-verifier / profile chainVerifier, against REAL contracts on
// a CANONICAL-trie chain (the cli-independent rig on pinned reth --dev) through the patched Helios. The rig's three logged
// RPC fronts stand for providers: with no --rpc the CLI contacts none; with ONE explicit --rpc (the self-hosted transaction
// transport) a write is simulated by the verifier and only nonce/fees/broadcast/receipt touch that front, never a state read.
// TEST-SIGNED HEAD (local sequencer key in helios.toml), not real Base.
//   env: RIG_CHAIN_NODE=reth (+ RIG_RETH_*), HELIOS_BASE_BIN, TEST_TMP. Run inside `unshare -r -n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';
import { loadConfig, Authority, Scope, VAULT_ABI } from '../mcp/independent.mjs';
import { independentChain, sendQuorumTx } from '../cli/independent.mjs';
import { encodeFunctionData } from 'viem';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'cli', 'enclave.mjs');
const GUARD = pathToFileURL(path.join(REPO, 'test/helpers/cli-network-guard.mjs')).href;
const { HELIOS_BASE_BIN } = process.env;
const skip = haveTools() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'cli-mcp-verifier-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rig, helios, heliosUrl, feed, proxy, gateway, pinsFile, netLog;
const proxyMode = { value: 'ok' };

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function untilHelios(n, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (BigInt(await rpc(heliosUrl, 'eth_blockNumber')) >= BigInt(n)) return; } catch {} await sleep(300); }
  throw new Error(`helios did not reach block ${n}`);
}
const settled = (rc) => untilHelios(rc.blockNumber + 2n);
function startFeed() {
  let served = 0n, current = null, frozen = false;
  const srv = http.createServer(async (q, res) => {
    if (q.url === '/chain_id') return res.end('8453');
    try {
      const latest = BigInt(await rig.rpcCall('eth_blockNumber'));
      if (served === 0n && latest > 3n) served = latest - 3n;
      if (!frozen && served < latest) {
        const n = served + 1n;
        const b = await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false]);
        const txs = await Promise.all(b.transactions.map((h) => rig.rpcCall('eth_getRawTransactionByHash', [h])));
        current = await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs });
        served = n;
      }
    } catch {}
    res.end(JSON.stringify(current));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/`, freeze: (v) => { frozen = v; } })));
}
function startProxy() {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    if (proxyMode.value === 'down') { res.writeHead(503); return res.end(); }
    const j = await (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).json();
    if (proxyMode.value === 'tamper') for (const x of [j].flat()) if (x?.result?.storageProof) for (const s of x.result.storageProof) s.value = '0x' + 'beef'.padStart(40, '1');
    res.end(JSON.stringify(j));
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
// the CLI with --chain-verifier; `tx` adds ONE explicit transaction transport (a rig front); confirmations 1 like cli-independent
function cli(args, { tx = null } = {}) {
  const base = ['--independent', '--contract-pins', pinsFile, '--usdc-token', rig.addresses.usdc, '--confirmations', '1', '--yes', '--chain-verifier', heliosUrl, ...(tx ? ['--rpc', tx] : [])];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, ...base], { cwd: TMP, env: { PATH: process.env.PATH, HOME: TMP, XDG_CONFIG_HOME: path.join(TMP, 'conf'),
      ENCLAVE_SESSION_DIR: path.join(TMP, 'sessions'), ENCLAVE_KEY: KEYS.owner, ENCLAVE_API_BASE: rig.apiOrigin, NODE_OPTIONS: `--import=${GUARD}`,
      ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(rig.apiPort) } });
    let out = '', err = '';
    const killer = setTimeout(() => { err += '\n[test: CLI killed after 150 s]'; p.kill('SIGKILL'); }, 150000);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }); });
  });
}
const frontCalls = () => rig.rpcLog.length;
const ledgerGet = (id) => rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.A.ledger.abi, functionName: 'get', args: [id] });
const noEnclave = () => { assert.deepEqual(rig.apiHits, []); assert.equal(fs.readFileSync(netLog, 'utf8'), '', 'no non-loopback or Enclave connection'); };

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  pinsFile = path.join(TMP, 'pins.json'); fs.writeFileSync(pinsFile, JSON.stringify(rig.pins));
  netLog = path.join(TMP, 'net.log'); fs.writeFileSync(netLog, '');
  await rig.create(KEYS.owner); const last = await rig.create(KEYS.owner);
  feed = await startFeed(); proxy = await startProxy();
  gateway = createWitnessGateway({ upstreams: [proxy.url] }); const gUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  await settled(last);
});
test.after(async () => {
  helios?.kill('SIGKILL');
  await gateway?.close(); feed?.srv.close(); proxy?.srv.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 600000 };

test('CLI reads (ls, hosts, status) come from the verifier with no RPC list at all; no provider front is contacted', T, async () => {
  const f0 = frontCalls();
  const ls = await cli(['ls', '--json']);
  assert.equal(ls.code, 0, ls.err + ls.out);
  assert.match(ls.err, /state from the local verifier .* \(unsafe tier\); transactions via no transport/);
  const owner = privateKeyToAccount(KEYS.owner).address.toLowerCase();
  const ids = ls.json.deployments.map((d) => d.id.toLowerCase()).sort();
  assert.ok(ids.length >= 2);
  for (const id of ids) assert.equal(String((await ledgerGet(id)).owner).toLowerCase(), owner);
  const h = await cli(['hosts', '--all', '--json']);                  // --all: every registered host, live or not
  assert.equal(h.code, 0, h.err); assert.equal(h.json.registrySchema, 4);
  assert.ok(h.json.hosts.some((x) => x.id === rig.runner && x.endpoint === rig.endpoint), 'the schema-4 registry host is read through the verifier');
  const st = await cli(['status', ids[0], '--json']);
  assert.equal(st.code, 0, st.err); assert.ok(JSON.stringify(st.json).toLowerCase().includes(ids[0]), 'status names the deployment');
  assert.equal(frontCalls(), f0, 'no provider front was contacted');
  noEnclave();
});

test('CLI writes: without a transport they refuse by name after a verified simulation; a verified revert refuses before any transport use; with ONE explicit transport the send succeeds and only transaction methods touch it', T, async () => {
  const id = (await cli(['ls', '--json'])).json.deployments[0].id;
  const f0 = frontCalls();
  const noTx = await cli(['stop', id]);
  assert.notEqual(noTx.code, 0); assert.match(noTx.err + noTx.out, /explicit transaction\/history transport/);
  assert.equal((await ledgerGet(id)).active, true); assert.equal(frontCalls(), f0);
  const front = rig.rpcs[0];
  // the library path every independent write takes: a non-owner's setActive is reverted by the REAL ledger in the verified
  // simulation, before the transport is used at all
  const chain = independentChain({ chainVerifier: heliosUrl, rpcs: [front], confirmations: 1 });
  await assert.rejects(sendQuorumTx(chain, { account: privateKeyToAccount(KEYS.other), to: rig.addresses.ledger,
    data: encodeFunctionData({ abi: rig.A.ledger.abi, functionName: 'setActive', args: [id, false] }) }), /would revert at agreed block/);
  assert.equal(frontCalls(), f0, 'a verified revert stops the write before the transport is used');
  const stop = await cli(['stop', id, '--json'], { tx: front });
  assert.equal(stop.code, 0, stop.err + stop.out);
  assert.equal((await ledgerGet(id)).active, false, 'the transaction landed');
  const used = rig.rpcLog.slice(f0);
  assert.ok(used.length > 0 && used.every((x) => x.i === 0), 'only the explicit front was used');
  assert.ok(used.some((x) => x.method === 'eth_sendRawTransaction'));
  assert.deepEqual(used.filter((x) => x.method === 'eth_call'), [], 'the transport never answered a state read or the simulation');
  const back = await cli(['resume', id], { tx: front });
  assert.equal(back.code, 0, back.err); assert.equal((await ledgerGet(id)).active, true);
  noEnclave();
});

test('MCP authority with a chainVerifier profile: bindings and reads at ONE verified block, no RPC list', T, async () => {
  const cfgFile = path.join(TMP, 'mcp.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ format: 'enclave-mcp-independent/v1', profiles: { p: { contractPins: pinsFile, usdc: rig.addresses.usdc, rpcs: [], stateDir: path.join(TMP, 'mcp-state'), chainVerifier: heliosUrl, confirmations: 1 } } }));
  const authority = await new Authority(loadConfig(cfgFile).profiles.get('p')).ready();
  assert.equal(authority.chain.authority, 'local-verifier'); assert.deepEqual(authority.chain.peers, []);
  const f0 = frontCalls();
  const s = new Scope(authority);
  const b = await s.bindings();
  assert.equal(b.deployments.toLowerCase(), rig.addresses.ledger.toLowerCase());
  assert.equal(b.factory.toLowerCase(), rig.addresses.factory.toLowerCase());
  const count = await s.read(rig.addresses.ledger, rig.A.ledger.abi, 'count');
  assert.equal(count, await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.A.ledger.abi, functionName: 'count', blockNumber: s.block.number }));
  assert.equal(s.summary().authority, 'local-verifier');
  // session revocation: a real session reads live at a verified block; once the owner terminates it a new call reads it ended
  const S = await import('../sdk/sessions/dist/node.mjs');
  const owner = privateKeyToAccount(KEYS.owner);
  const kp = await S.generateKeyPair(true); const { x, y } = await S.publicKeyXY(kp.publicKey);
  const grant = S.buildGrant({ label: 'mcp-test', sessionKey: S.keyHashOf(x, y), policy: { actions: ['api.status'], apps: ['*'], environments: ['prod'], budget: 0n,
    spendPerPeriod: 0n, periodSeconds: 86400, opsPerPeriod: 0, maxFeePerOp: 0n, maxAppFeePerHour: 0n, maxRatePerHour: 0n, expiresIn: 3600 } });
  const tx = await S.prepareSessionOpen({ publicClient: rig.pc, factory: rig.addresses.factory, owner, chainId: 8453, grant });
  await settled(await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.owner).sendTransaction({ to: tx.to, data: tx.data }) }));
  const live = async () => (await new Scope(authority).read(tx.vault, VAULT_ABI, 'sessionOf', [tx.sid]))[1];
  assert.equal(await live(), true);
  const op = await S.prepareOwnerOperation({ publicClient: rig.pc, chainId: 8453, vault: tx.vault, op: { op: 'terminate', sessionId: tx.sid }, mode: 'direct', owner });
  await settled(await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.owner).sendTransaction({ to: op.to, data: op.data }) }));
  assert.equal(await live(), false, 'the terminated session reads ended through the verifier');
  assert.equal(frontCalls(), f0);
});

test('tampered or missing witnesses and a stale head refuse CLI reads; nothing falls back to the transport', T, async () => {
  const front = rig.rpcs[0];
  for (const mode of ['tamper', 'down']) {
    proxyMode.value = mode;
    try {
      await untilHelios(BigInt(await rpc(heliosUrl, 'eth_blockNumber')) + 2n);
      const f0 = frontCalls();
      const x = await cli(['ls', '--json'], { tx: front });
      assert.notEqual(x.code, 0, mode); assert.equal(frontCalls(), f0, `${mode}: no fallback to the transport`);
    } finally { proxyMode.value = 'ok'; }
  }
  feed.freeze(true);
  try { await sleep(130000); const x = await cli(['ls', '--json']); assert.notEqual(x.code, 0); assert.match(x.err, /stale|older than|out of sync|behind/i); }
  finally { feed.freeze(false); }
  // let the verifier catch up before anything else reads (Helios refuses while out of sync)
  await untilHelios(BigInt(await rig.rpcCall('eth_blockNumber')) - 2n, 300000);
  for (let i = 0; i < 60; i++) { if ((await cli(['ls', '--json'])).code === 0) break; await sleep(2000); }
});
