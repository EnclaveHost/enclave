// Does a local anvil (--network optimism, no fork) execute RIP-7212 P256VERIFY at 0x100? One valid signature, one wrong key.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
const port = await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const anvil = spawn('anvil', ['--port', String(port), '--network', 'optimism', '--silent'], { stdio: 'ignore' });
const rpc = async (m, p) => (await (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json());
try {
  for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId', []); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }), h = (b) => Buffer.from(b, 'base64url').toString('hex');
  const msg = Buffer.from('rip-7212 probe'), digest = crypto.createHash('sha256').update(msg).digest('hex');
  const sig = crypto.sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('hex');
  const call = (x, y) => rpc('eth_call', [{ to: '0x0000000000000000000000000000000000000100', data: '0x' + digest + sig.slice(0, 64) + sig.slice(64) + x + y }, 'latest']);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  console.log('valid signature  ->', (await call(h(jwk.x), h(jwk.y))).result);
  console.log('another key      ->', (await call(h(other.x), h(other.y))).result);
} finally { anvil.kill('SIGKILL'); }
