// A REAL Base-chain-id dev node for tests: reth v2.8.0 `node --dev` (the pinned binary of work/rpc-priority, RETH_BIN) with
// test/fixtures/reth-dev-8453-genesis.json (chain id 8453, forks through Osaka at genesis, the anvil dev accounts funded;
// copied unchanged from work/rpc-priority/fixture-tools, sha256 cc045d9d...). The same flags as the opt-in reth rig of
// test/helpers/cli-independent-rig.mjs at rpc-priority e32dd607b: loopback HTTP only, no discovery, one block per
// blockTime, proofs served 1024 blocks back. `genesis` picks another fixture (B's EIP-2935 variant). The datadir is under TMPDIR. -> { url, stop() } or null when RETH_BIN is absent.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETH_BIN = process.env.RETH_BIN || '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/vendor-inspect/reth-v2.8.0/bin/reth';
export const GENESIS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reth-dev-8453-genesis.json');
// anvil's public dev key #0, funded by the genesis (never a production wallet)
export const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const haveReth = () => fs.existsSync(RETH_BIN) ? null : 'needs the pinned reth binary (RETH_BIN)';
export const freePort = () => new Promise((ok, no) => { const s = net.createServer(); s.once('error', no); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

export async function startRethDev({ blockTime = '1s', genesis = GENESIS } = {}) {
  const port = await freePort(), auth = await freePort();
  const data = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'reth-dev-'));
  const child = spawn(RETH_BIN, ['node', '--dev', '--dev.block-time', blockTime, '--chain', genesis, '--datadir', data,
    '--http', '--http.addr', '127.0.0.1', '--http.port', String(port), '--http.api', 'eth,net,web3', '--disable-discovery', '--ipcdisable',
    '--port', '0', '--authrpc.port', String(auth), '--rpc.eth-proof-window', '1024'], { stdio: 'ignore' });
  const kill = () => { try { child.kill('SIGKILL'); } catch {} };
  process.once('exit', kill);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' }); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop() { process.removeListener('exit', kill); kill(); fs.rmSync(data, { recursive: true, force: true }); } };
}
