// The ONLY write path of the migration tooling: a local anvil fork this process starts itself (gate G2).
// Every write goes through ForkNode, which refuses unless the node
//   - is the anvil child this process spawned, on 127.0.0.1 at the port it chose;
//   - answers anvil_nodeInfo with chainId 31337 (EIP-155: nothing signed here is valid on Base) and a fork block
//     equal to the snapshot block, forked from an allowlisted public Base endpoint.
// Fixture keys are anvil's well-known PUBLIC dev keys; impersonation exists only on this node.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { LIVE, assertLiveUrl } from './live.mjs';

export const FORK_CHAIN_ID = 31337;
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';   // public anvil fixture
const chain = { id: FORK_CHAIN_ID, name: 'base-fork-31337', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

export class ForkNode {
  /** chainId 31337 (default): fixture keys may sign, and nothing signed is valid on Base.
   *  chainId 8453 is allowed ONLY with impersonationOnly: no key exists on this node, every write is an unsigned,
   *  node-local impersonated call, so the plan's exact chain-8453 calldata (e.g. GovernanceSeal configuration hashes,
   *  which commit to block.chainid) can be replayed byte for byte without anything replayable ever being created. */
  static async start({ block, forkUrl = LIVE.state[1], log = () => {}, logFile = null, chainId = FORK_CHAIN_ID, impersonationOnly = false }) {
    if (chainId !== FORK_CHAIN_ID && !(chainId === 8453 && impersonationOnly)) throw Error('refused: a chain-8453 fork must be impersonation-only');
    assertLiveUrl(forkUrl);   // only an allowlisted public Base endpoint may be the fork source (read-only from it)
    const port = await freePort();
    const args = ['--fork-url', forkUrl, '--fork-block-number', String(block), '--chain-id', String(chainId), '--host', '127.0.0.1',
      '--port', String(port), '--retries', '6', '--fork-retry-backoff', '800', '--timeout', '20000', '--compute-units-per-second', '330',
      '--gas-limit', '60000000'];
    const child = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    if (logFile) { const fs = await import('node:fs'); const w = fs.createWriteStream(logFile); child.stdout.pipe(w); } else child.stdout.resume();
    const node = new ForkNode(child, port, BigInt(block), forkUrl, { chainId, impersonationOnly });
    for (let i = 0; ; i++) {
      try { await node.raw('eth_chainId', []); break; } catch { if (i > 300 || child.exitCode !== null) throw Error('anvil did not start: ' + err.slice(0, 300)); await new Promise((r) => setTimeout(r, 200)); }
    }
    await node.assertGuarded();
    log(`fork up on 127.0.0.1:${port}, chain ${FORK_CHAIN_ID}, forked from ${new URL(forkUrl).host} at ${block}`);
    return node;
  }
  constructor(child, port, block, forkUrl, { chainId = FORK_CHAIN_ID, impersonationOnly = false } = {}) {
    Object.assign(this, { child, port, block, forkUrl, url: `http://127.0.0.1:${port}`, guarded: false, chainId, impersonationOnly });
    this.chain = { ...chain, id: chainId };
    this.pub = createPublicClient({ chain: this.chain, transport: http(this.url, { timeout: 180000, retryCount: 0 }) });
  }
  async raw(method, params) {
    const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(180000) });
    const j = await r.json(); if (j.error) throw Object.assign(Error(j.error.message), { data: j.error.data }); return j.result;
  }
  /** G2: this is our own loopback anvil, chain 31337, forked at the snapshot block from the allowlisted source. */
  async assertGuarded() {
    if (this.child.exitCode !== null) throw Error('fork node exited');
    const u = new URL(this.url);
    if (u.hostname !== '127.0.0.1' || Number(u.port) !== this.port) throw Error('not our loopback node');
    const id = Number(await this.raw('eth_chainId', []));
    const info = await this.raw('anvil_nodeInfo', []);
    const fb = info?.forkConfig?.forkBlockNumber;
    if (id !== this.chainId || Number(info?.environment?.chainId) !== this.chainId) throw Error(`refused: node chain ${id}, not ${this.chainId}`);
    if (this.chainId !== FORK_CHAIN_ID && !this.impersonationOnly) throw Error('refused: a non-31337 fork must be impersonation-only');
    if (fb === undefined || fb === null || BigInt(fb) !== this.block) throw Error(`refused: fork block ${fb ?? 'none (not a fork)'}, not the snapshot block ${this.block}`);
    if (!String(info?.forkConfig?.forkUrl || '').startsWith(this.forkUrl.replace(/\/$/, ''))) throw Error('refused: fork source is not the allowlisted endpoint');
    this.guarded = true;
  }
  account(i) { return mnemonicToAccount(DEV_MNEMONIC, { addressIndex: i }); }
  async write(fn) { if (!this.guarded) await this.assertGuarded(); return fn(); }

  /** Send as a fixture key (signed for chain 31337) or as an impersonated address (unsigned, node-local). */
  async send({ from, to, data, value = 0n, gas = 15_000_000n, label, expectRevert = false }) {
    return this.write(async () => {
      let hash;
      if (typeof from === 'object') {
        if (this.impersonationOnly) throw Error('refused: this fork is impersonation-only; no key may sign here');
        const w = createWalletClient({ chain: this.chain, transport: http(this.url), account: from });
        hash = await w.sendTransaction({ to, data, value, gas, chain: this.chain });
      } else {
        await this.raw('anvil_impersonateAccount', [from]);
        await this.raw('anvil_setBalance', [from, '0x56BC75E2D63100000']);   // 100 ETH of fork gas money, fork only
        hash = await this.raw('eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, value: '0x' + value.toString(16), gas: '0x' + gas.toString(16) }]);
        await this.raw('anvil_stopImpersonatingAccount', [from]);
      }
      const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 180000 });
      const ok = rc.status === 'success';
      if (ok === expectRevert) {
        let reason = '';
        if (!ok) { try { await this.pub.call({ account: typeof from === 'object' ? from.address : from, to, data, value, blockNumber: rc.blockNumber - 1n }); } catch (e) { reason = (e.shortMessage || e.message).split('\n').slice(0, 2).join(' '); } }
        throw Error(`${label}: ${ok ? 'succeeded but a revert was expected' : 'reverted ' + reason}`);
      }
      return { label, hash, status: rc.status, gasUsed: rc.gasUsed, contractAddress: rc.contractAddress, block: rc.blockNumber, logs: rc.logs };
    });
  }
  async read(address, abi, functionName, args = [], blockNumber) {
    const data = await this.pub.call({ to: address, data: encodeFunctionData({ abi, functionName, args }), blockNumber });
    return decodeFunctionResult({ abi, functionName, data: data.data });
  }
  async revertReason({ from, to, data }) {
    try { await this.pub.call({ account: typeof from === 'object' ? from.address : from, to, data }); return null; }
    catch (e) { return (e.shortMessage || e.message).split('\n').find((l) => /reverted|revert/.test(l)) || (e.shortMessage || e.message).slice(0, 160); }
  }
  async warp(seconds) { return this.write(async () => { await this.raw('evm_increaseTime', [Number(seconds)]); await this.raw('evm_mine', []); }); }
  async stop() { try { this.child.kill('SIGTERM'); } catch {} await new Promise((r) => (this.child.exitCode !== null ? r() : this.child.once('exit', r))); }
}

/** Refuse any attempt to use a live endpoint as a write target (exercised by the tests). */
export function refuseLiveWrite(url) {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1') throw Error(`refused: ${u.host} is not a local fork; the migration tooling never writes to a live endpoint`);
}
