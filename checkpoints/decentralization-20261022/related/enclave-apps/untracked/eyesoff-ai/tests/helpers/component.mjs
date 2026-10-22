// Shared harness for the component end-to-end tests: the BUILT eyesoff-ai component under `wasmtime serve`, and
// throwaway-key signatures from Foundry's `cast` (offline; the same EIP-191 personal_sign a browser wallet produces).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';

// EYESOFF_WASM names the component explicitly (a test build, say); otherwise the release build
export const WASM = process.env.EYESOFF_WASM || new URL('../../target/wasm32-wasip2/release/eyesoff_ai.wasm', import.meta.url).pathname;
export const have = (cmd) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
export const skip = !existsSync(WASM) ? 'build the component first' : !have('wasmtime') ? 'wasmtime missing' : !have('cast') ? 'cast missing' : false;

export const AUD = '0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa';
export const OTHER = '0x1111111111111111111111111111111111111111111111111111111111111111';
export const KEY_A = '0x' + '42'.repeat(32);            // address 0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025
export const KEY_B = '0x' + '43'.repeat(32);
export const ADDR_A = '0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025';
export const SEED = 's33d-0f1e2d3c4b5a69788796a5b4c3d2e1f0';

export const sign = (key, msg) => execFileSync('cast', ['wallet', 'sign', '--private-key', key, msg], { encoding: 'utf8' }).trim();
export const addrOf = (key) => execFileSync('cast', ['wallet', 'address', '--private-key', key], { encoding: 'utf8' }).trim();
export const b64u = (b) => Buffer.from(b).toString('base64url');
export const ews1 = (msg, sig) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sig.slice(2), 'hex'))}`;
export const est1 = (claims) => {
  const p = b64u(JSON.stringify(claims));
  return `EST1.${p}.${b64u(Buffer.from(sign(KEY_A, `EST1.${p}`).slice(2), 'hex'))}`;
};
export const now = () => Math.floor(Date.now() / 1000);

export async function freePort() {
  return new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

export async function serve(config) {
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const cfg = JSON.stringify(config(host));
  const child = spawn('wasmtime', ['serve', '-Scommon', '-Snn', '--addr', host, '--env', `ENCLAVE_CONFIG=${cfg}`, WASM], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const base = `http://${host}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/ping`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error(`wasmtime did not come up: ${err}`);
  }
  const call = async (path, { method = 'GET', token, body, header = 'authorization', extra = {} } = {}) => {
    const headers = { 'content-type': 'application/json', ...extra };
    if (token) headers[header] = header === 'authorization' ? `Bearer ${token}` : token;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  return { host, base, call, stop: () => child.kill('SIGKILL') };
}

// what the playground does: challenge, check it names us, personal_sign, wrap
export async function walletSignIn(s, key, aud = AUD) {
  const address = addrOf(key);
  const nonce = 'e2e' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const c = await s.call(`/auth/wallet/challenge?address=${address}&nonce=${nonce}`);
  assert.equal(c.status, 200, c.text);
  const msg = c.json.message;
  assert.ok(msg.startsWith(`${s.host} wants you to sign in with your Ethereum account:\n`), msg);
  assert.ok(msg.endsWith(`\n- urn:enclave:deployment:${aud}`), msg);
  return { msg, token: ews1(msg, sign(key, msg)) };
}
export const gated = (s, token, header) => s.call('/title', { method: 'POST', token, header, body: { messages: [{ role: 'user', content: 'hi' }] } });
