// READ-ONLY: the vault address the app (eab1.rs / tools/eab1.mjs / recover.js, one formula, locally cross-checked in
// tests/passkey-recovery.mjs) derives with the PRODUCTION pins equals the LIVE factory's own vaultFor(x, y), for random
// P-256 points. eth_call only, two public RPCs agreeing at one block. Nothing is sent or signed.
import crypto from 'node:crypto';
import fs from 'node:fs';
const WO = '/home/steven/Documents/Codex/2026-10-18/wo/work';
const viem = await import(`${WO}/enclave/node_modules/viem/_esm/index.js`);
const T = await import(`${WO}/app-auth-release-migration/tools/eab1.mjs`);
const cfg = JSON.parse(fs.readFileSync(new URL('./recover/recover-config.production.json', import.meta.url), 'utf8'));
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const rpc = async (u, m, p) => { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(15000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
const block = '0x' + (Math.min(...(await Promise.all(RPCS.map((u) => rpc(u, 'eth_blockNumber', [])))).map((h) => parseInt(h, 16))) - 5).toString(16);
const ABI = [{ type: 'function', name: 'vaultFor', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'address' }] },
             { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
const call = async (fn, args) => { const data = viem.encodeFunctionData({ abi: ABI, functionName: fn, args });
  const r = await Promise.all(RPCS.map((u) => rpc(u, 'eth_call', [{ to: cfg.factory, data }, block])));
  if (new Set(r).size !== 1) throw new Error('RPCs disagree'); return viem.decodeFunctionResult({ abi: ABI, functionName: fn, data: r[0] }).toLowerCase(); };
const out = { block: parseInt(block, 16), factory: cfg.factory, origin: cfg.origin, rpId: cfg.rpId,
  implementationLive: await call('implementation', []), implementationPinned: cfg.implementation, samples: [] };
for (let i = 0; i < 3; i++) {
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const x = '0x' + Buffer.from(jwk.x, 'base64url').toString('hex'), y = '0x' + Buffer.from(jwk.y, 'base64url').toString('hex');
  const live = await call('vaultFor', [BigInt(x), BigInt(y)]), derived = T.vaultFor(cfg.factory, cfg.implementation, x, y);
  out.samples.push({ x, y, live, derived, equal: live === derived });
}
out.ok = out.implementationLive === cfg.implementation && out.samples.every((s) => s.equal);
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
