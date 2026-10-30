// relay/host-sponsor.mjs on the relay's VERIFIER authority, end to end on an isolated offline chain: reth --dev (chain 8453,
// Prague) with the canonical Base EntryPoint v0.8 / SenderCreator / Simple7702Account code (test/fixtures/base-code) in a
// derived genesis, the platform's own EnclaveRegistry and EnclaveHostPaymaster deployed from the Foundry build, the REAL
// verifier runtime (the pinned Helios, test/helpers/verifier-runtime.mjs) as the relay's only read authority and reth as its
// own transaction backend (both behind loopback recorders), and the REAL box client (windows/node/sponsor.mjs).
//   * success: a fresh key with no ETH registers through the paymaster; the chain's receipt and the registry say so; the one
//     broadcast went to the own backend only, after a verified simulation;
//   * refused BEFORE broadcast: an authorization for another account nonce (409), one signed by another key (400), an invalid
//     paymaster voucher (handleOps would revert: 422), an invalid operation signature (422), an unsupported operation shape
//     (initCode set: 403), and the same machine again (sponsored already: 403).
// All keys are generated here or reth's well-known dev keys; the chain exists only for this test.
// Needs RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS (test-control.sh) and contracts/foundry/out (jobs/forge-prebuild-sponsor.sh);
// with REQUIRE_VERIFIER_E2E=1 anything missing FAILS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createPublicClient, createWalletClient, http as viemHttp, parseEther, getAddress, parseTransaction, parseEventLogs, parseAbi, keccak256 } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { launchVerifierRuntime, startProofSource } from './helpers/verifier-runtime.mjs';
import { createChainAuthority } from '../network/chain-authority.mjs';
import { hostSponsor, hostSponsorRouter, ENTRYPOINT_08, SIMPLE_7702 } from '../relay/host-sponsor.mjs';
import { sponsoredRegister, sponsorMessage } from '../windows/node/sponsor.mjs';

const { RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS } = process.env;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'contracts/foundry/out');
const art = (f, n) => { const p = path.join(OUT, f, `${n}.json`); if (!fs.existsSync(p)) return null; const j = JSON.parse(fs.readFileSync(p, 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
const missing = (!RUNTIME_BIN_DIR && 'RUNTIME_BIN_DIR not set') || (!RIG_RETH_BIN && 'RIG_RETH_BIN not set') || (!RIG_RETH_GENESIS && 'RIG_RETH_GENESIS not set')
  || (!art('EnclaveRegistry.sol', 'EnclaveRegistry') && 'contracts/foundry/out lacks EnclaveRegistry (jobs/forge-prebuild-sponsor.sh)')
  || (!art('EnclaveHostPaymaster.sol', 'EnclaveHostPaymaster') && 'contracts/foundry/out lacks EnclaveHostPaymaster (jobs/forge-prebuild-sponsor.sh)');
const T = { timeout: 600_000, skip: !process.env.REQUIRE_VERIFIER_E2E && missing };
if (process.env.REQUIRE_VERIFIER_E2E && missing) test('required artifacts', () => assert.fail(missing));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'sponsor-verifier-'));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AA = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/base-code/aa-code-base.json'), 'utf8'));
const DEV_KEYS = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'];
const REGISTERED = parseAbi(['event Registered(bytes32 indexed id, address indexed operator, string endpoint, string repo)']);
const USEROP = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']);

let reth, rethUrl, oracle, proof, rt, authority, router, relayBase, registry, paymaster, sponsor;
const servers = [];
const vCalls = [], bCalls = [], raws = [];
// a loopback recorder in front of `target`: every JSON-RPC method (and every raw transaction) it forwards
async function recorder(target, calls, onRaw) {
  const s = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', async () => {
    const body = Buffer.concat(c).toString(); let q = null; try { q = JSON.parse(body); } catch {}
    for (const m of Array.isArray(q) ? q : [q]) { calls.push(m?.method); if (m?.method === 'eth_sendRawTransaction' && onRaw) onRaw(m.params[0]); }
    try { const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); }
    catch (e) { res.writeHead(502); res.end(String(e.message)); }
  }); });
  servers.push(s); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}/`;
}
const hub = new Map();
function box(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const operator = privateKeyToAccount(generatePrivateKey());
  const ek = createHash('sha256').update('ek of ' + name + Math.random()).digest('hex');
  hub.set(name, { name, mode: 'hv-node', spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), hvNode: { boot: { ekCertSha256: ek } }, claimant: operator.address });
  return { name, transportKey: privateKey, operator, ek };
}
const args = (name) => ({ endpoint: `https://api.enclave.host/t/${name}`, repo: 'EnclaveHost/enclave', measurement: '0x' + '00'.repeat(32), cpuPricePerSec6: 12, gpuPricePerSec6: 0,
  proofKey: '0x0000000000000000000000000000000000000000' });
// the real box client; `mutate(kind, body, b)` may rewrite a request body (re-signing it with the box's transport key as the box would)
const register = (b, mutate = null) => sponsoredRegister({ relayBase, name: b.name, transportKey: b.transportKey, operator: b.operator, client: oracle, registry, args: args(b.name),
  fetchImpl: async (url, init) => {
    if (!mutate) return fetch(url, init);
    const kind = String(url).split('/').pop(), body = JSON.parse(init.body);
    await mutate(kind, body, b);
    body.sig = cryptoSign(null, Buffer.from(sponsorMessage(kind, b.name, body.op, body.nonce)), b.transportKey).toString('hex');
    return fetch(url, { ...init, body: JSON.stringify(body) });
  } });
const EP_HASH_ABI = parseAbi(['function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)']);
const reSignOp = async (op, b) => {                         // what the box itself would do for the operation it now sends
  const h = await oracle.readContract({ address: ENTRYPOINT_08, abi: EP_HASH_ABI, functionName: 'getUserOpHash',
    args: [{ ...op, nonce: BigInt(op.nonce), preVerificationGas: BigInt(op.preVerificationGas), signature: '0x' }] });
  op.signature = await b.operator.sign({ hash: h });
};

test.before(async () => {
  if (T.skip) return;
  const g = JSON.parse(fs.readFileSync(RIG_RETH_GENESIS, 'utf8'));
  for (const c of Object.values(AA.contracts)) g.alloc[c.address.toLowerCase()] = { balance: '0x0', nonce: '0x1', code: c.code };
  // Base-like fees (~0.01 gwei): the dev genesis starts at 1 gwei, where the box's 2 x base fee + tip exceeds the sponsor's
  // unchanged 1 gwei cap (relay/host-sponsor.mjs LIMITS.maxFeePerGas) and every voucher is (rightly) refused
  g.baseFeePerGas = '0x989680';
  const genesis = path.join(TMP, 'genesis-aa.json'); fs.writeFileSync(genesis, JSON.stringify(g));
  const port = await freePort();
  reth = spawn(RIG_RETH_BIN, ['node', '--dev', '--dev.block-time', '2s', '--chain', genesis, '--datadir', path.join(TMP, 'reth'), '--http', '--http.addr', '127.0.0.1',
    '--http.port', String(port), '--http.api', 'eth,net,web3', '--disable-discovery', '--ipcdisable', '--port', '0', '--authrpc.port', String(await freePort()),
    '--rpc.eth-proof-window', '1024'], { stdio: 'ignore' });
  rethUrl = `http://127.0.0.1:${port}`;
  oracle = createPublicClient({ chain: base, transport: viemHttp(rethUrl) });
  for (let i = 0; i < 600; i++) { try { await oracle.getBlockNumber(); break; } catch { await sleep(200); } }
  const alloc = Object.keys(g.alloc).map((x) => x.toLowerCase());
  const dev = privateKeyToAccount(DEV_KEYS.find((k) => alloc.includes(privateKeyToAccount(k).address.toLowerCase())));
  const owner = createWalletClient({ chain: base, account: dev, transport: viemHttp(rethUrl) });
  const deploy = async (a, ctorArgs = []) => (await oracle.waitForTransactionReceipt({ hash: await owner.deployContract({ abi: a.abi, bytecode: a.bytecode, args: ctorArgs }) })).contractAddress;
  const verifierKey = generatePrivateKey(), bundlerKey = generatePrivateKey();
  registry = await deploy(art('EnclaveRegistry.sol', 'EnclaveRegistry'));
  const PM = art('EnclaveHostPaymaster.sol', 'EnclaveHostPaymaster');
  paymaster = await deploy(PM, [ENTRYPOINT_08, registry, privateKeyToAccount(verifierKey).address, parseEther('0.001')]);
  await oracle.waitForTransactionReceipt({ hash: await owner.writeContract({ address: paymaster, abi: PM.abi, functionName: 'deposit', value: parseEther('0.05') }) });
  await oracle.waitForTransactionReceipt({ hash: await owner.sendTransaction({ to: privateKeyToAccount(bundlerKey).address, value: parseEther('1') }) });
  // the relay's authority: the REAL verifier runtime (reads, simulation, receipts) and reth as its own backend (sends only)
  proof = await startProofSource(rethUrl);
  rt = launchVerifierRuntime({ chainRpc: rethUrl, proofSources: [proof.url], port: await freePort(), dir: path.join(TMP, 'runtime') });
  await rt.ready();
  const vUrl = await recorder(rt.url, vCalls), bUrl = await recorder(rethUrl, bCalls, (raw) => raws.push(raw));
  authority = createChainAuthority({ verifier: vUrl, backend: bUrl, chain: base });
  for (let i = 0; i < 300; i++) { try { const c = await authority.client.getCode({ address: paymaster }); if (c && c !== '0x') break; } catch {} await sleep(500); }
  sponsor = hostSponsor({ hub: { info: (n) => hub.get(n) || null }, endpointOf: (n) => `https://api.enclave.host/t/${n}`, ownerOf: async () => '',
    verifierKey, bundlerKey, paymaster, registry, rpc: 'http://127.0.0.1:1/never-used', authority, log: () => {} });
  router = hostSponsorRouter({ sponsor, json: (res, s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); },
    readBody: (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); }) });
  const srv = http.createServer(async (req, res) => { if (!(await router(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end(); } });
  servers.push(srv); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  relayBase = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {}
  try { rt?.stop(); } catch {}
  try { proof?.close?.(); proof?.server?.close?.(); } catch {}
  if (reth && reth.exitCode === null) { reth.kill('SIGTERM'); await Promise.race([new Promise((r) => reth.once('exit', r)), sleep(15000)]); try { reth.kill('SIGKILL'); } catch {} }
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) { try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(TMP)) process.kill(Number(pid), 'SIGKILL'); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('success: a fresh key with NO ETH registers through the paymaster; receipt + registry; ONE broadcast, to the own backend only', T, async () => {
  const b = box('sv-ok-' + Date.now());
  assert.equal(await oracle.getBalance({ address: b.operator.address }), 0n);
  const before = raws.length;
  const r = await register(b);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(raws.length, before + 1, 'exactly one broadcast');
  const tx = parseTransaction(raws.at(-1));
  assert.equal(tx.type, 'eip7702'); assert.equal(getAddress(tx.to), getAddress(ENTRYPOINT_08)); assert.equal(getAddress(tx.authorizationList[0].address), getAddress(SIMPLE_7702));
  assert.equal(keccak256(raws.at(-1)), r.tx);
  assert.ok(!vCalls.includes('eth_sendRawTransaction'), 'the verifier is never sent a transaction');
  for (const m of ['eth_call', 'eth_estimateGas', 'eth_getCode', 'eth_getTransactionReceipt']) assert.ok(!bCalls.includes(m), `${m} is never asked of the own backend`);
  const rc = await oracle.getTransactionReceipt({ hash: r.tx });
  assert.equal(rc.status, 'success');
  const ev = parseEventLogs({ abi: USEROP, logs: rc.logs }).find((l) => getAddress(l.address) === getAddress(ENTRYPOINT_08));
  assert.ok(ev && ev.args.success === true && getAddress(ev.args.paymaster) === getAddress(paymaster), 'the EntryPoint ran the operation, paid by the paymaster');
  const reg = parseEventLogs({ abi: REGISTERED, logs: rc.logs }).find((l) => getAddress(l.address) === getAddress(registry));
  assert.ok(reg, 'the registry emitted Registered'); assert.equal(getAddress(reg.args.operator), getAddress(b.operator.address)); assert.equal(reg.args.endpoint, args(b.name).endpoint);
  assert.equal(await oracle.getBalance({ address: b.operator.address }), 0n, 'and the key still holds no ETH');
  // the same machine again: refused at the voucher, before anything is simulated or sent
  const n = raws.length;
  const again = box('sv-again-' + Date.now()); hub.get(again.name).hvNode.boot.ekCertSha256 = b.ek;
  await assert.rejects(register(again), /HTTP 403.*sponsored already/);
  assert.equal(raws.length, n, 'nothing broadcast');
});

test('refused before broadcast: authorization for another account nonce (409) and one signed by another key (400)', T, async () => {
  const n = raws.length;
  const b = box('sv-nonce-' + Date.now());
  await assert.rejects(register(b, async (kind, body, bx) => {
    if (kind !== 'submit') return;
    const nonce = await oracle.getTransactionCount({ address: bx.operator.address });
    const a = await bx.operator.signAuthorization({ contractAddress: SIMPLE_7702, address: SIMPLE_7702, chainId: 8453, nonce: nonce + 1 });
    body.authorization = { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity };
  }), /HTTP 409.*proven nonce is 0/);
  const c = box('sv-otherkey-' + Date.now()), other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(register(c, async (kind, body) => {
    if (kind !== 'submit') return;
    const a = await other.signAuthorization({ contractAddress: SIMPLE_7702, address: SIMPLE_7702, chainId: 8453, nonce: 0 });
    body.authorization = { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity };
  }), /HTTP 400.*not signed by the operator key/);
  assert.equal(raws.length, n, 'nothing broadcast');
});

test('refused before broadcast: an invalid voucher and an invalid operation signature (handleOps would revert: 422), an unsupported op shape (403)', T, async () => {
  const n = raws.length;
  const v = box('sv-voucher-' + Date.now());
  await assert.rejects(register(v, async (kind, body, bx) => {
    if (kind !== 'submit') return;
    const p = body.op.paymasterAndData;                      // flip the voucher signature's last byte, re-sign the op over it
    body.op.paymasterAndData = p.slice(0, -2) + (p.slice(-2) === '00' ? '01' : '00');
    await reSignOp(body.op, bx);
  }), /HTTP 422.*would fail/);
  const s = box('sv-opsig-' + Date.now());
  await assert.rejects(register(s, async (kind, body, bx) => {
    if (kind !== 'submit') return;
    body.op.signature = await bx.operator.sign({ hash: keccak256('0x1234') });   // the box's key over the wrong hash
  }), /HTTP 422.*would fail/);
  const u = box('sv-shape-' + Date.now());
  await assert.rejects(register(u, async (kind, body) => { if (kind === 'voucher') body.op.initCode = '0x01'; }), /HTTP 403.*initCode must be empty/);
  assert.equal(raws.length, n, 'nothing broadcast');
  assert.ok(!vCalls.includes('eth_sendRawTransaction'));
});
