// Actual reviewed lifecycle artifacts on isolated loopback Anvil.
// Finality is a TEST capability; raw receipts and transactions come from local EVM execution.
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPublicClient, createWalletClient, decodeFunctionResult, encodeDeployData, encodeEventTopics, encodeFunctionData, getAddress, http, keccak256,
  parseEther, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createLifecycleChainAdapter } from '../../network/deployment-chain-adapter.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const ART = n => JSON.parse(fs.readFileSync(path.join(ROOT, `deploy/lifecycle/artifacts/${n}.json`), 'utf8'));
export const LIFECYCLE = ART('EnclaveDeploymentLifecycle'), IDENTITY = ART('EnclaveSelfHostingIdentity'), LEDGER = ART('EnclaveDeployments');
export const HOST = keccak256(toBytes('host-a')), MEAS = keccak256(toBytes('measurement-1')), ZERO = `0x${'0'.repeat(40)}`, ZERO32 = `0x${'0'.repeat(64)}`;
export const MAX_T = 10n ** 15n, RESERVE = 10n ** 15n, MAX_GAS = 100n * 10n ** 9n, CAP6 = 100n, PAID6 = 10n;
export const S = { pub: null, wallet: null, K: null, skewMs: 0 };
let anvil, idn = 0;
export const rpc = (m, p = []) => S.pub.request({ method: m, params: p });
export const hex = n => `0x${BigInt(n).toString(16)}`;
export const mine = () => rpc('evm_mine');
export const chainNow = () => Date.now() + S.skewMs;
export async function warp(sec) { S.skewMs += sec * 1000; await rpc('evm_increaseTime', [sec]); await mine(); }
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

export function useAnvil() {
  test.before(async () => {
    // Compiler exits before Anvil starts, keeping compiler memory out of the execution phase.
    S.K = JSON.parse(execFileSync(process.execPath, [new URL('./compile-lifecycle-doubles.mjs', import.meta.url).pathname], {timeout:20000,maxBuffer:2*1024*1024}));
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    anvil = spawn(process.env.ANVIL || path.join(os.homedir(), '.foundry/bin/anvil'),
      ['--port', String(port), '--host', '127.0.0.1', '--chain-id', '8453', '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
    // r6: LOCAL-ANVIL harness only: a receipt missed by viem's single immediate check (anvil seals asynchronously) waits 25 ms, not the
    // 4000 ms default poll (root 1386 latency diagnosis). No assertion, authority, freshness or timeout changes.
    S.pub = createPublicClient({ cacheTime: 0, pollingInterval: 25, transport: http(url, { retryCount: 0 }) }); S.wallet = createWalletClient({ transport: http(url, { retryCount: 0 }) });
    for (let i = 0; ; ++i) { try { if (await S.pub.getChainId() === 8453) break; } catch { if (i > 100) throw Error('anvil did not start'); } await new Promise(r => setTimeout(r, 100)); }

  });
  test.after(async () => { if (anvil && anvil.exitCode === null && anvil.signalCode === null) { const death=once(anvil,'exit'); anvil.kill('SIGKILL'); await death; } });
}

export async function account() { const a = privateKeyToAccount(generatePrivateKey()); await rpc('anvil_setBalance', [a.address, '0x8ac7230489e80000']); return a; }
export async function send(from, args) { const hash = await S.wallet.sendTransaction({ account: from, chain: null, gas: 5_000_000n, ...args });
  const r = await S.pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw Error('tx reverted'); return r; }
const deployRaw = async (from, abi, bytecode, args = [], gas = 5_000_000n) => (await send(from, { gas, data: encodeDeployData({ abi, bytecode, args }) })).contractAddress;
export const dep = (from, name, args = []) => deployRaw(from, S.K[name].abi, `0x${S.K[name].evm.bytecode.object}`, args);
export const tx = (from, to, abi, functionName, args = [], value) => send(from, { to, data: encodeFunctionData({ abi, functionName, args }), ...(value ? { value } : {}) });
export const codeHash = async a => keccak256(await S.pub.getCode({ address: a }));
export const read = (address, abi, functionName, args = []) => S.pub.readContract({ address, abi, functionName, args });

// TEST DOUBLE of the untrusted history source (r3): WHERE (TransitionPaid log query) + raw headers, raw signed transactions, receipts.
export function anvilReceipts(hooks) {
  const base = {
    locate: async ({ id, digest, controller }) => {
      const logs = await rpc('eth_getLogs', [{ address: controller, fromBlock: '0x0', toBlock: 'latest',
        topics: encodeEventTopics({ abi: LIFECYCLE.abi, eventName: 'TransitionPaid', args: { id, intent: digest } }) }]);
      const l = logs.at(-1); return l ? { blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash } : null; },
    header: async n => rpc('eth_getBlockByNumber', [hex(n), false]),
    block: async n => { const b = await rpc('eth_getBlockByNumber', [hex(n), true]);
      return { header: b, transactions: await Promise.all(b.transactions.map(t => rpc('eth_getRawTransactionByHash', [t.hash]))),
        receipts: await rpc('eth_getBlockReceipts', [hex(n)]) }; },
  };
  return { base,
    locate: q => (hooks.locate ?? base.locate)(q),
    header: async n => (hooks.header ?? (x => x))(structuredClone(await base.header(n)), n),
    block: async n => (hooks.block ?? (x => x))(structuredClone(await base.block(n)), n) };
}
// TEST DOUBLE of createLifecycleFinalitySnapshot's capability: ONE uncached block object (auth.pin or latest), labelled.
export function testAuthority(auth, kind) {
  return { kind, snapshot: async readFn => {
    const header = auth.pin != null ? await S.pub.getBlock({ blockNumber: auth.pin }) : await S.pub.getBlock({ blockTag: 'latest' });
    return { blockNumber: header.number, blockHash: header.hash, timestamp: Number(header.timestamp) * 1000, observedAt: Date.now(),
      value: await readFn(S.pub, header.number, { ...header, timestamp: Number(header.timestamp) * 1000 }), evidence: { tier: auth.tier, proofVerified: auth.proof } }; } };
}


export async function step(w, target, reason) { const a=w.adapter(), intent=await a.prepare(w.id,await a.read(w.id),target,reason); await a.submit(w.id,intent); return intent; }
