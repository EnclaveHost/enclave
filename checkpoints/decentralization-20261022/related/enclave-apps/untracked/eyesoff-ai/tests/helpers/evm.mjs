// A REAL EVM for the contract-wallet sign-in tests of every app that carries the shared wallet.rs (eyesoff-ai, jot, depot,
// api-mcp-adapter): a local anvil chain (no fork, no network), the test wallets of fixtures/contract-wallet/TestWallets.sol
// deployed on it, and JSON-RPC "readers" in front of it that the component is pinned to. Honest readers forward to anvil
// untouched, so every isValidSignature verdict and every ERC-6492 deployless validation is EXECUTED by the EVM - nothing
// here decides a signature. Lying readers rewrite one answer kind; a down reader is a closed port.
//
// What this is NOT: the Safe passkey signer, Coinbase Smart Wallet or any production wallet contract. The wallet here is
// an ERC-1271 owner wallet (ECDSA owner, per-hash revocation) and a CREATE2 factory; it exercises the protocol the apps
// speak (EIP-1271 and ERC-6492 through agreeing readers at one block hash), which is what the apps decide on.
//
// Needs: anvil and cast (Foundry), offline. Signatures: `cast wallet sign` with throwaway keys.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const ART = JSON.parse(readFileSync(new URL('../fixtures/contract-wallet/artifacts.json', import.meta.url), 'utf8'));
export const haveEvm = (() => { try { execFileSync('anvil', ['--version'], { stdio: 'ignore' }); execFileSync('cast', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
export const MAGIC_6492 = '6492'.repeat(16);
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** EIP-191 personal_sign of `msg` by `key` (65 bytes, 0x hex). */
export const personalSign = (key, msg) => cast('wallet', 'sign', '--private-key', key, msg);
export const addressOf = (key) => cast('wallet', 'address', '--private-key', key).toLowerCase();
export const hashMessage = (msg) => cast('hash-message', msg);

/**
 * startChain() -> { url, rpc, deployWallet(ownerKey, salt), predict(ownerKey, salt), wrap6492(ownerKey, salt, sig),
 *                   revoke(ownerKey, wallet, hash), code(addr), stop() }
 * anvil mines a block every second (so the readers' agreed block, a few confirmations back, is always fresh) with chain
 * id 8453, the chain the apps' wallet block defaults to.
 */
export async function startChain() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '8453', '--block-time', '1', '--silent'], { stdio: 'ignore' });
  const rpc = async (method, params = []) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  for (let i = 0; ; i++) {
    try { await rpc('eth_chainId'); break; } catch { if (i > 100) { anvil.kill('SIGKILL'); throw new Error('anvil did not start'); } await sleep(100); }
  }
  const [deployer] = await rpc('eth_accounts');
  const mined = async (hash) => { for (;;) { const rc = await rpc('eth_getTransactionReceipt', [hash]); if (rc) { if (rc.status !== '0x1') throw new Error('transaction reverted'); return rc; } await sleep(200); } };
  const send = async (tx) => mined(await rpc('eth_sendTransaction', [{ from: deployer, gas: '0x7a1200', ...tx }]));
  const factory = (await send({ data: ART.contracts.WalletFactory.bytecode })).contractAddress.toLowerCase();
  const salt = (s) => '0x' + BigInt(s).toString(16).padStart(64, '0');
  const deployCalldata = (owner, s) => cast('calldata', 'deploy(address,bytes32)', owner, salt(s));
  const predict = async (ownerKey, s) => {
    const r = await rpc('eth_call', [{ to: factory, data: cast('calldata', 'predict(address,bytes32)', addressOf(ownerKey), salt(s)) }, 'latest']);
    return ('0x' + r.slice(-40)).toLowerCase();
  };
  return {
    url, rpc, factory,
    predict,
    async deployWallet(ownerKey, s) {
      await send({ to: factory, data: deployCalldata(addressOf(ownerKey), s) });
      return predict(ownerKey, s);
    },
    /** ERC-6492: abi.encode(factory, deploy(owner, salt) calldata, signature) ++ magic */
    wrap6492(ownerKey, s, sig) {
      const enc = cast('abi-encode', 'f(address,bytes,bytes)', factory, deployCalldata(addressOf(ownerKey), s), sig);
      return enc + MAGIC_6492;
    },
    /** the OWNER revokes `hash` on its deployed wallet (a real transaction, signed by the owner key) */
    async revoke(ownerKey, wallet, hash) {
      await rpc('anvil_setBalance', [addressOf(ownerKey), '0x56bc75e2d63100000']);
      cast('send', '--rpc-url', url, '--private-key', ownerKey, wallet, 'revoke(bytes32)', hash);
    },
    code: (a) => rpc('eth_getCode', [a, 'latest']),
    stop: () => anvil.kill('SIGKILL'),
  };
}

/**
 * reader(chainUrl, mode) -> { url, calls, setMode(m), stop() }: a JSON-RPC reader on its own loopback port.
 *   honest   forwards every request to anvil unchanged
 *   denies   every eth_call answers "not valid" (0xffffffff... for EIP-1271, 0x00 for the ERC-6492 validator)
 *   approves every eth_call answers "valid"
 *   reverts  every eth_call is an execution revert
 *   garbage  every eth_call answers text that is not hex
 *   down     the port is closed (connection refused)
 * `calls` counts requests answered, so a test can show a path asked no reader at all.
 */
export async function reader(chainUrl, mode = 'honest') {
  let m = mode, calls = 0;
  const rewrite = (it, res) => {
    if (it.method !== 'eth_call' || m === 'honest') return res;
    const deployless = !it.params?.[0]?.to;
    const id = it.id, ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (m === 'reverts') return { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } };
    if (m === 'garbage') return ok('0xnot-hex');
    const valid = m === 'approves';
    return ok(deployless ? (valid ? '0x01' : '0x00') : (valid ? '0x1626ba7e' : '0xffffffff') + '0'.repeat(56));
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      calls++;
      try {
        const q = JSON.parse(body);
        const items = Array.isArray(q) ? q : [q];
        const upstream = await (await fetch(chainUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(items) })).json();
        const answers = items.map((it) => rewrite(it, upstream.find((u) => u.id === it.id)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(q) ? answers : answers[0]));
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
  });
  const port = await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
  const r = {
    url: `http://127.0.0.1:${port}`,
    get calls() { return calls; },
    setMode(x) {
      if (x === 'down' && m !== 'down') { server.close(); server.closeAllConnections(); }
      m = x;
    },
    stop() { server.closeAllConnections(); server.close(); },
  };
  if (mode === 'down') r.setMode('down');
  return r;
}

/** Three readers (two honest, one `liar`) and the wallet block that pins them. */
export async function readers(chain, liar = 'honest') {
  const rs = [await reader(chain.url), await reader(chain.url), await reader(chain.url, liar)];
  return {
    rs,
    calls: () => rs.reduce((n, r) => n + r.calls, 0),
    contract_wallets: { rpcs: rs.map((r) => r.url), quorum: 2, confirmations: 2, max_age_secs: 120, timeout_secs: 5 },
    stop: () => rs.forEach((r) => r.stop()),
  };
}
