// UNDEPLOYED (counterfactual) smart wallets: ERC-6492-wrapped signatures through the relay's consumers on the REAL verifier
// runtime (the pinned Helios), each answer against reth as the oracle. The wallet is CREATE2-deployed by a factory only inside
// the deployless validator's eth_call (nothing is ever deployed on chain). Two hand-assembled factories: ALWAYS (its wallet
// answers the ERC-1271 magic value) and NEVER (its wallet answers zero).
// What the PRODUCT supports, observed here rather than assumed:
//   * relay/auth.js smart-wallet sign-in (viem verifySiweMessage -> verifyHash): ERC-6492 IS supported (viem unwraps it and
//     runs the factory inside its deployless validator);
//   * the secrets owner gate (relay/contract-owner-signature.mjs) and the network owner check (network/owner-signature.mjs):
//     addressed ERC-1271 only (getCode first) - an undeployed wallet is NOT supported and answers false, by design.
// Needs RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS (test-control.sh); with REQUIRE_VERIFIER_E2E=1 a missing one FAILS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http as viemHttp, getContractAddress, serializeErc6492Signature, keccak256 } from 'viem';
import { createSiweMessage } from 'viem/siwe';
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
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'cf-verifier-'));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEV_KEYS = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'];
// wallet creation code: copy its runtime and return it (ALWAYS: magic value 0x1626ba7e; NEVER: 32 zero bytes)
const ALWAYS_INIT = '0x6010600c60003960106000f3' + '631626ba7e60e01b60005260206000f3', NEVER_INIT = '0x6005600c60003960056000f3' + '60206000f3';
const hex1 = (n) => n.toString(16).padStart(2, '0');
// a factory whose runtime, on ANY call: CODECOPY the wallet's creation code, CREATE2 it with salt 0, return the address
function factoryInit(walletInit) {
  const w = walletInit.slice(2), wl = w.length / 2;
  const runtime = `60${hex1(wl)}6018600039` + `6000${'60' + hex1(wl)}60006000f5` + '600052' + '60206000f3' + w;   // 24-byte prefix + wallet init
  const rl = runtime.length / 2;
  return `0x60${hex1(rl)}600c60003960${hex1(rl)}6000f3` + runtime;
}
const SIG = '0x' + '12'.repeat(65), SALT = '0x' + '00'.repeat(32);

let reth, rethUrl, oracle, proof, rt, authority, F = {}, CF = {};
test.before(async () => {
  if (T.skip) return;
  const port = await freePort();
  reth = spawn(RIG_RETH_BIN, ['node', '--dev', '--dev.block-time', '2s', '--chain', RIG_RETH_GENESIS, '--datadir', path.join(TMP, 'reth'), '--http', '--http.addr', '127.0.0.1',
    '--http.port', String(port), '--http.api', 'eth,net,web3', '--disable-discovery', '--ipcdisable', '--port', '0', '--authrpc.port', String(await freePort()),
    '--rpc.eth-proof-window', '1024'], { stdio: 'ignore' });
  rethUrl = `http://127.0.0.1:${port}`;
  oracle = createPublicClient({ chain: base, transport: viemHttp(rethUrl) });
  for (let i = 0; i < 600; i++) { try { await oracle.getBlockNumber(); break; } catch { await sleep(200); } }
  const alloc = Object.keys(JSON.parse(fs.readFileSync(RIG_RETH_GENESIS, 'utf8')).alloc).map((x) => x.toLowerCase());
  const w = createWalletClient({ chain: base, account: privateKeyToAccount(DEV_KEYS.find((k) => alloc.includes(privateKeyToAccount(k).address.toLowerCase()))), transport: viemHttp(rethUrl) });
  for (const [k, init] of [['always', ALWAYS_INIT], ['never', NEVER_INIT]]) {
    F[k] = (await oracle.waitForTransactionReceipt({ hash: await w.sendTransaction({ data: factoryInit(init) }) })).contractAddress;
    CF[k] = getContractAddress({ opcode: 'CREATE2', from: F[k], salt: SALT, bytecodeHash: keccak256(init) });
  }
  proof = await startProofSource(rethUrl);
  rt = launchVerifierRuntime({ chainRpc: rethUrl, proofSources: [proof.url], port: await freePort(), dir: path.join(TMP, 'runtime') });
  await rt.ready();
  authority = createChainAuthority({ verifier: rt.url, chain: base });
  for (let i = 0; i < 300; i++) { try { const c = await authority.client.getCode({ address: F.never }); if (c && c !== '0x') break; } catch {} await sleep(500); }
});
test.after(async () => {
  try { rt?.stop(); } catch {}
  try { proof?.close?.(); proof?.server?.close?.(); } catch {}
  if (reth && reth.exitCode === null) { reth.kill('SIGTERM'); await Promise.race([new Promise((r) => reth.once('exit', r)), sleep(15000)]); try { reth.kill('SIGKILL'); } catch {} }
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) { try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(TMP)) process.kill(Number(pid), 'SIGKILL'); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});
const observe = (label, v) => console.log(`OBSERVED ${label}: ${v}`);
const outcome = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: String(e?.details || e?.shortMessage || e?.message || e).slice(0, 300) }; } };
const wrapped = (k) => serializeErc6492Signature({ address: F[k], data: '0x', signature: SIG });   // factory + calldata + inner signature
const siwe = (k) => createSiweMessage({ address: CF[k], chainId: 8453, domain: 'enclave.host', nonce: 'abcdefgh12345678', uri: 'https://enclave.host', version: '1' });

test('the wallets are NOT deployed (counterfactual), on the chain and as the verifier proves it', T, async () => {
  for (const k of ['always', 'never']) {
    assert.ok(!(await oracle.getCode({ address: CF[k] })), `oracle: ${k} wallet has no code`);
    const v = await authority.client.getCode({ address: CF[k] });
    assert.ok(!v || v === '0x', `verifier: ${k} wallet has no code`);
  }
});

test('auth.js sign-in path (viem verifySiweMessage, ERC-6492) through the verifier: accepts the valid counterfactual wallet, refuses the invalid one, exactly as the chain', T, async () => {
  for (const [k, want] of [['always', true], ['never', false]]) {
    const message = siwe(k), signature = wrapped(k);
    const o = await outcome(() => oracle.verifySiweMessage({ message, signature }));
    const v = await outcome(() => authority.client.verifySiweMessage({ message, signature }));
    observe(`verifySiweMessage counterfactual ${k}`, `oracle ${JSON.stringify(o)} verifier ${JSON.stringify(v)}`);
    assert.equal(o.value, want, `oracle ${k}`);
    assert.deepEqual(v, o, `${k}: the verifier's answer is the chain's`);
  }
  assert.ok(!(await oracle.getCode({ address: CF.always })), 'and nothing was deployed by verifying');
});

test('secrets owner gate and network owner check: an undeployed wallet is NOT supported there (false on the chain AND through the verifier), never a false accept', T, async () => {
  for (const k of ['always', 'never']) {
    const message = siwe(k), signature = wrapped(k);
    for (const [label, fn] of [['secrets gate', (c) => verifyContractOwnerSignature({ client: c, owner: CF[k], message, signature })],
      ['network owner check', (c) => verifyOwnerSignature({ clients: [c], owner: CF[k], message, signature })]]) {
      const o = await fn(oracle), v = await fn(authority.client);
      observe(`${label} counterfactual ${k}`, `oracle ${o} verifier ${v}`);
      assert.equal(o, false, `${label}, oracle, ${k}: addressed ERC-1271 needs deployed code`);
      assert.equal(v, false, `${label}, verifier, ${k}`);
    }
  }
});
