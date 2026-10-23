// A local L1 (anvil, chain id 1, Prague) carrying the PRODUCTION OptimismPortal of Base as one public provider served
// it at one finalized block (evidence/capture/l1-portal.json: proxy 0x4904…e97e, implementation, SystemConfig proxy and
// implementation, every slot the deposit path read, the proxy's low slots swept). The genesis block number and
// timestamp are the captured block's, so the portal's resource metering sees the same block distance it would have.
// RESEARCH PROVENANCE, NOT VERIFICATION: the bytes are a provider's answer (cross-check with a second provider was
// refused by every other public provider tried; see RESULT-TRANSACTION-CLOSURE.md). What this does prove is how
// THAT bytecode behaves: deposits, aliasing, gas, burn, reverts, the exact TransactionDeposited log.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import * as viem from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const CAPTURE = JSON.parse(fs.readFileSync(new URL('../../evidence/capture/l1-portal.json', import.meta.url), 'utf8'));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/** forwarder runtime: calldatacopy; call(gas, PORTAL, callvalue, 0, size, 0, 0); revert on failure (a contract wallet) */
export const forwarderCode = (portal) => viem.concat(['0x3660006000376000600036600034', '0x73', portal, '0x5af1602d57600060' + '00fd5b00']);

export async function startL1({ baseFeeWei = 1_000_000_000n, capture = CAPTURE } = {}) {
  const port = await free();
  const url = `http://127.0.0.1:${port}`;
  const p = spawn('anvil', ['--chain-id', '1', '--hardfork', 'prague', '--port', String(port), '--host', '127.0.0.1', '--number', String(BigInt(capture.block.number)),
    '--timestamp', String(BigInt(capture.block.timestamp)), '--block-base-fee-per-gas', baseFeeWei.toString(), '--silent'], { stdio: 'ignore' });
  const rpc = async (method, params = []) => {
    const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
  };
  for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  for (const [a, acc] of Object.entries(capture.accounts)) {
    if (acc.code && acc.code !== '0x') await rpc('anvil_setCode', [a, acc.code]);
    for (const [k, v] of Object.entries(acc.storage)) await rpc('anvil_setStorageAt', [a, k, viem.pad(v)]);
  }
  const chain = viem.defineChain({ id: 1, name: 'local-l1', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pc = viem.createPublicClient({ chain, transport: viem.http(url) });
  const wallet = (key) => viem.createWalletClient({ chain, account: privateKeyToAccount(key), transport: viem.http(url) });
  const fund = (address) => rpc('anvil_setBalance', [address, '0x56bc75e2d63100000']);
  /** The plan's UNSIGNED L1 transaction, signed here by a TEST key and sent to the local L1 (never to a network). */
  async function send(key, tx, { gas = 2_000_000n, tipWei = 0n } = {}) {
    await fund(privateKeyToAccount(key).address);
    const fee = (await pc.getBlock()).baseFeePerGas * 2n + tipWei;   // priority fee 0 by default: costs below are base fee only
    const hash = await wallet(key).sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas, maxFeePerGas: fee, maxPriorityFeePerGas: tipWei });
    return pc.waitForTransactionReceipt({ hash });
  }
  /** Put a contract wallet (the forwarder) at `address` on L1: a Safe-like owner, as the portal sees one. */
  const makeContract = (address, portal) => rpc('anvil_setCode', [address, forwarderCode(portal)]);
  const stop = () => p.kill('SIGKILL');
  return { url, rpc, pc, chain, wallet, send, makeContract, fund, stop };
}

/** The local L1's own reading of the portal pin (proxy implementation slot + version()), labelled as such. */
export async function readPortal(l1, portal) {
  const impl = viem.getAddress(viem.slice(await l1.pc.getStorageAt({ address: portal, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' }), 12));
  const version = await l1.pc.readContract({ address: portal, abi: viem.parseAbi(['function version() view returns (string)']), functionName: 'version' });
  const b = await l1.pc.getBlock();
  return { head: { number: Number(b.number), hash: b.hash, verifiedBy: 'test-anvil-l1' }, portal, implementation: impl, version };
}
