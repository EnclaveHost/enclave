// Smart-wallet (contract owner) signature checks of the relay's consumers, through the REAL verifier runtime (the pinned
// Helios behind network/rpc-runtime.mjs, test/helpers/verifier-runtime.mjs) on a reth --dev chain, against reth itself as
// the oracle. Two hand-assembled ERC-1271 wallets: ALWAYS answers the magic value, NEVER answers zero.
//   * addressed ERC-1271 (relay/contract-owner-signature.mjs: the secrets owner gate; network/owner-signature.mjs: the
//     network API's owner check): getCode + isValidSignature AT the wallet;
//   * viem verifyMessage/verifySiweMessage (relay/auth.js smart-wallet sign-in): viem 2.53's verifyHash sends a DEPLOYLESS
//     eth_call (no `to`; the ERC-6492 validator's creation code as data) unless the chain pins an erc6492Verifier address;
//   * the raw deployless call shape itself (creation code run as a call).
// Invariant for every case: the relay's answer through the verifier is NEVER "valid" where the oracle says invalid; where the
// verifier cannot execute a shape it must fail (false / throw), never accept. What the verifier did with each shape is
// printed (OBSERVED ...) and asserted exactly for the cases the relay depends on.
// Needs RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS (test-control.sh); with REQUIRE_VERIFIER_E2E=1 a missing one FAILS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http as viemHttp, hashMessage, encodeFunctionData, parseAbi, concat, numberToHex, getAddress, sliceHex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { launchVerifierRuntime, startProofSource } from './helpers/verifier-runtime.mjs';
import { createChainAuthority } from '../network/chain-authority.mjs';
import { verifyContractOwnerSignature } from '../relay/contract-owner-signature.mjs';
import { verifyOwnerSignature } from '../network/owner-signature.mjs';

const { RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS } = process.env;
const missing = (!RUNTIME_BIN_DIR && 'RUNTIME_BIN_DIR not set') || (!RIG_RETH_BIN && 'RIG_RETH_BIN not set') || (!RIG_RETH_GENESIS && 'RIG_RETH_GENESIS not set');
const T = { timeout: 600_000, skip: !process.env.REQUIRE_VERIFIER_E2E && missing };
if (process.env.REQUIRE_VERIFIER_E2E && missing) test('required artifacts', () => assert.fail(missing));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'sw-verifier-'));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// hardhat/anvil well-known dev keys: the genesis funds some of them
const DEV_KEYS = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'];
// runtime: PUSH4 0x1626ba7e, shl 224, mstore 0, return(0,32) | return(0,32) of zero memory
const ALWAYS_RUNTIME = '0x631626ba7e60e01b60005260206000f3', NEVER_RUNTIME = '0x60206000f3';
const ALWAYS_INIT = '0x6010600c60003960106000f3' + ALWAYS_RUNTIME.slice(2), NEVER_INIT = '0x6005600c60003960056000f3' + NEVER_RUNTIME.slice(2);
const MESSAGE = 'enclave relay smart-wallet check', SIG = '0x' + '12'.repeat(65);
const AA = JSON.parse(fs.readFileSync(new URL('./fixtures/base-code/aa-code-base.json', import.meta.url), 'utf8'));
const ENTRYPOINT_08 = AA.contracts.entryPoint08.address, SIMPLE_7702 = AA.contracts.simple7702Account.address;

let reth, rethUrl, oracle, proof, rt, recorder, recUrl, authority, A = {};
const calls = [];
test.before(async () => {
  if (T.skip) return;
  const port = await freePort(), data = path.join(TMP, 'reth');
  // the pinned dev genesis plus the canonical Base AA contracts at their addresses (test/fixtures/base-code: EntryPoint v0.8,
  // its SenderCreator, Simple7702Account: the code relay/host-sponsor.mjs pins), so the sponsor's verifier mechanism runs on
  // the real contracts
  const g = JSON.parse(fs.readFileSync(RIG_RETH_GENESIS, 'utf8'));
  for (const c of Object.values(AA.contracts)) g.alloc[c.address.toLowerCase()] = { balance: '0x0', nonce: '0x1', code: c.code };
  const genesis = path.join(TMP, 'genesis-aa.json'); fs.writeFileSync(genesis, JSON.stringify(g));
  reth = spawn(RIG_RETH_BIN, ['node', '--dev', '--dev.block-time', '2s', '--chain', genesis, '--datadir', data, '--http', '--http.addr', '127.0.0.1',
    '--http.port', String(port), '--http.api', 'eth,net,web3', '--disable-discovery', '--ipcdisable', '--port', '0', '--authrpc.port', String(await freePort()),
    '--rpc.eth-proof-window', '1024'], { stdio: 'ignore', detached: false });
  rethUrl = `http://127.0.0.1:${port}`;
  oracle = createPublicClient({ chain: base, transport: viemHttp(rethUrl) });
  for (let i = 0; i < 600; i++) { try { await oracle.getBlockNumber(); break; } catch { await sleep(200); } }
  const alloc = Object.keys(JSON.parse(fs.readFileSync(RIG_RETH_GENESIS, 'utf8')).alloc).map((x) => x.toLowerCase());
  const key = DEV_KEYS.find((k) => alloc.includes(privateKeyToAccount(k).address.toLowerCase()));
  assert.ok(key, 'a funded dev key in the genesis');
  const w = createWalletClient({ chain: base, account: privateKeyToAccount(key), transport: viemHttp(rethUrl) });
  for (const [k, init] of [['always', ALWAYS_INIT], ['never', NEVER_INIT]]) {
    const hash = await w.sendTransaction({ data: init });
    A[k] = (await oracle.waitForTransactionReceipt({ hash })).contractAddress;
  }
  proof = await startProofSource(rethUrl);
  rt = launchVerifierRuntime({ chainRpc: rethUrl, proofSources: [proof.url], port: await freePort(), dir: path.join(TMP, 'runtime') });
  await rt.ready();
  // a loopback recorder in front of the verifier: every request's method and whether an eth_call had a `to`
  recorder = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', async () => {
    const body = Buffer.concat(c).toString(); let q = null; try { q = JSON.parse(body); } catch {}
    for (const m of Array.isArray(q) ? q : [q]) calls.push({ method: m?.method, to: m?.params?.[0]?.to ?? null, dataPrefix: String(m?.params?.[0]?.data || m?.params?.[0]?.input || '').slice(0, 10) });
    try { const r = await fetch(rt.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); }
    catch (e) { res.writeHead(502); res.end(String(e.message)); }
  }); });
  await new Promise((r) => recorder.listen(0, '127.0.0.1', r));
  recUrl = `http://127.0.0.1:${recorder.address().port}/`;
  authority = createChainAuthority({ verifier: recUrl, chain: base });
  // the verifier's head must include both deployments (its head chain is the sequencer-signed unsafe tier)
  for (let i = 0; i < 300; i++) { try { if ((await authority.client.getCode({ address: A.never })) === NEVER_RUNTIME) break; } catch {} await sleep(500); }
});
test.after(async () => {
  try { recorder?.close(); } catch {}
  try { rt?.stop(); } catch {}
  try { proof?.close?.(); proof?.server?.close?.(); } catch {}
  if (reth && reth.exitCode === null) { reth.kill('SIGTERM'); await Promise.race([new Promise((r) => reth.once('exit', r)), sleep(15000)]); try { reth.kill('SIGKILL'); } catch {} }
  // the runtime's detached children (Helios, listener) by their command line under TMP
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(TMP)) process.kill(Number(pid), 'SIGKILL'); } catch {}
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});
const observe = (label, v) => console.log(`OBSERVED ${label}: ${v}`);
const outcome = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: String(e?.details || e?.shortMessage || e?.message || e).slice(0, 300) }; } };

test('the verifier serves the deployed wallets\' code exactly as the chain', T, async () => {
  assert.equal(await authority.client.getCode({ address: A.always }), ALWAYS_RUNTIME);
  assert.equal(await authority.client.getCode({ address: A.never }), NEVER_RUNTIME);
});

test('addressed ERC-1271 through the verifier (secrets owner gate, network owner check): equals the chain for valid and invalid wallets', T, async () => {
  for (const [k, want] of [['always', true], ['never', false]]) {
    assert.equal(await verifyContractOwnerSignature({ client: oracle, owner: A[k], message: MESSAGE, signature: SIG }), want, `oracle ${k}`);
    assert.equal(await verifyContractOwnerSignature({ client: authority.client, owner: A[k], message: MESSAGE, signature: SIG }), want, `relay secrets gate via verifier, ${k}`);
    assert.equal(await verifyOwnerSignature({ clients: [authority.client], owner: A[k], message: MESSAGE, signature: SIG }), want, `network owner check via verifier, ${k}`);
  }
  assert.ok(calls.some((c) => c.method === 'eth_call' && c.to && c.to.toLowerCase() === A.always.toLowerCase()), 'an addressed isValidSignature call');
});

test('viem verifyMessage (auth.js smart-wallet sign-in) through the verifier: never accepts what the chain refuses; deployless shape recorded', T, async () => {
  const before = calls.length;
  for (const [k] of [['always'], ['never']]) {
    const o = await outcome(() => oracle.verifyMessage({ address: A[k], message: MESSAGE, signature: SIG }));
    const v = await outcome(() => authority.client.verifyMessage({ address: A[k], message: MESSAGE, signature: SIG }));
    observe(`verifyMessage ${k}`, `oracle ${JSON.stringify(o)} verifier ${JSON.stringify(v)}`);
    assert.equal(o.value, k === 'always', `oracle ${k}`);
    if (k === 'never') assert.notEqual(v.value, true, 'never a false accept through the verifier');
    // observed 2026-10-25 on helios-eeffcc9: the deployless validator runs exactly as on the chain, so the answer is the chain's
    assert.deepEqual(v, o, `${k}: the verifier's answer is the chain's`);
  }
  const shapes = calls.slice(before).filter((c) => c.method === 'eth_call').map((c) => (c.to ? 'addressed' : 'deployless'));
  observe('verifyMessage eth_call shapes', JSON.stringify(shapes));
  assert.ok(shapes.includes('deployless'), 'viem 2.53 verifies a contract signature with a deployless call (no erc6492Verifier pinned for base)');
});

test('the raw deployless call shape (creation code as a call) through the pinned verifier, against the chain', T, async () => {
  const o = await outcome(() => oracle.call({ data: ALWAYS_INIT }));
  const v = await outcome(() => authority.client.call({ data: ALWAYS_INIT }));
  observe('deployless eth_call', `oracle ${JSON.stringify(o)} verifier ${JSON.stringify(v)}`);
  assert.equal(o.value?.data, ALWAYS_RUNTIME, 'the chain answers a deployless call with the constructor\'s return');
  assert.equal(v.value?.data, ALWAYS_RUNTIME, 'the pinned verifier executes the deployless shape exactly as the chain (observed; a refusal would fail here, never pass)');
});

// The sponsor's verifier-mode mechanism (relay/host-sponsor.mjs verifierSimulation) on the REAL pinned runtime and the REAL
// canonical contracts, each step against reth with the same state override as the oracle. (The full submit additionally needs
// the platform paymaster and registry deployed; not built here.)
test('sponsor mechanism on the real verifier: proven AA code; the 7702 designator override runs Simple7702 (and nothing without it); estimate under the override', T, async () => {
  const eoa = privateKeyToAccount('0x' + '5a'.repeat(32)).address;
  for (const c of [AA.contracts.entryPoint08, AA.contracts.simple7702Account])
    assert.equal(String(await authority.client.getCode({ address: c.address })).toLowerCase(), c.code.toLowerCase(), `${c.address}: the verifier proves the canonical code`);
  const override = { [eoa]: { code: concat(['0xef0100', SIMPLE_7702]).toLowerCase(), nonce: numberToHex(1) } };
  const probe = { to: eoa, data: encodeFunctionData({ abi: parseAbi(['function entryPoint() view returns (address)']), functionName: 'entryPoint' }) };
  const ask = (url, method, params) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  const viaV = await authority.client.request({ method: 'eth_call', params: [probe, 'latest', override] });
  const viaO = (await ask(rethUrl, 'eth_call', [probe, 'latest', override])).result;
  observe('sponsor probe with override', `verifier ${viaV} oracle ${viaO}`);
  assert.equal(viaO.length, 66); assert.equal(getAddress(sliceHex(viaO, 12, 32)), getAddress(ENTRYPOINT_08), 'oracle: the delegated key answers its EntryPoint');
  assert.equal(viaV, viaO, 'the verifier executes Simple7702 under the designator override exactly as the chain');
  const bare = await authority.client.request({ method: 'eth_call', params: [probe, 'latest'] });
  observe('sponsor probe WITHOUT override', bare);
  assert.equal(bare, '0x', 'without the override the key has no code: the vacuity probe sees "0x" and the sponsor refuses');
  // execute(target, 0, "") from the EntryPoint: only a delegated key runs Simple7702's execute (msg.sender must be the EntryPoint)
  const exec = { from: ENTRYPOINT_08, to: eoa, data: encodeFunctionData({ abi: parseAbi(['function execute(address target, uint256 value, bytes data)']), functionName: 'execute', args: ['0x000000000000000000000000000000000000dEaD', 0n, '0x'] }) };
  const gas = BigInt(await authority.client.request({ method: 'eth_estimateGas', params: [exec, 'latest', override] }));
  const oracleGas = BigInt((await ask(rethUrl, 'eth_estimateGas', [exec, 'latest', override])).result);
  observe('sponsor estimate under override', `verifier ${gas} oracle ${oracleGas}`);
  // both are searches to within ~1.5% of the least succeeding limit (observed 2026-10-25: verifier 25392, reth 25450), so
  // neither is a floor; what matters is that the CHAIN accepts the verifier's limit (below), and that the two agree closely
  assert.ok(gas > 21_000n, 'the delegated code executed (more than a plain transfer)');
  const diff = gas > oracleGas ? gas - oracleGas : oracleGas - gas;
  assert.ok(diff * 100n <= oracleGas * 2n, `the verifier's limit ${gas} is within 2% of the chain's estimate ${oracleGas}`);
  const atGas = await ask(rethUrl, 'eth_call', [{ ...exec, gas: numberToHex(gas) }, 'latest', override]);
  assert.ok(!atGas.error, `the chain succeeds at the verifier's limit: ${JSON.stringify(atGas.error)}`);
});
