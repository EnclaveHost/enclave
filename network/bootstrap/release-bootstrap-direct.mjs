// Interim release bootstrap for eyesoff.ai (0x9eb4e600) on metal0, 2026-10-14 (enclave-1a).
// guestd (-release-bootstrap-routes) admits a STARTING guest's egress only through a route in this file; the TUNA-era
// writer (retired-tuna-20261014/tuna-privacy/release-bootstrap-routes.mjs) pointed it at TUNA SOCKS proxies and was
// retired with TUNA, leaving every new eyesoff guest unable to reach the relay for its sealed release.
// This one serves a loopback SOCKS5 (CONNECT only) that dials DIRECTLY from this host, and keeps the file fresh (30 s
// expiry, rewritten every 10 s). The guest's own allowlist and guestd's egress server still decide where it may go.
// Replace with an Enclave-network bootstrap route (docs/design/enclave-network.md has none yet).
// 2026-10-16: plus EVERY deployment leased to metal0's runner (ledger getPage, refreshed each pass). Capacity audits
// create a new deployment per job, and a new audit guest died 100 s into boot because its id was not in this file.
// guestd still admits only a STARTING, ticketed guest of a listed deployment, and only to the relay/custodian hosts.
import fs from 'node:fs/promises';
import net from 'node:net';
import { createRequire } from 'node:module';
const req = createRequire('/home/steven/enclave-prod/capacity-audit/src/package.json');
const { createPublicClient, http, stringToHex } = req('viem');
const BOOK_ABI = [{ inputs: [{ type: 'bytes32' }], name: 'addr', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' }];
const DEP_ABI = req('/home/steven/enclave-prod/capacity-audit/src/contracts/EnclaveDeployments.abi.json');
const root = '/home/steven/enclave-prod/enclave-network/metal0';
const output = root + '/state/release-bootstrap-routes.json';
// eyesoff.ai, and (2026-10-14, secret custody's hardware canary) the agent-owned hello-world 0x4e62e60d
const ids = ['0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c',
             '0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e'];
const log = (...a) => console.log(new Date().toISOString(), ...a);
// one SOCKS listener PER APP: guestd refuses the whole file when two apps share a proxy ("invalid or reused app proxy")
function socksServer() {
let active = 0;
return net.createServer((c) => {
  if (active >= 64) return c.destroy();
  active++;
  let up = null, buf = Buffer.alloc(0), stage = 0;
  const end = () => { c.destroy(); if (up) up.destroy(); };
  c.on('close', () => { active--; if (up) up.destroy(); });
  c.on('error', end);
  c.setTimeout(60000, end);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0) {
      if (buf.length < 2 || buf.length < 2 + buf[1]) return;
      if (buf[0] !== 5 || !buf.subarray(2, 2 + buf[1]).includes(0)) { c.end(Buffer.from([5, 0xff])); return; }
      buf = buf.subarray(2 + buf[1]); stage = 1; c.write(Buffer.from([5, 0]));
    }
    if (stage === 1) {
      if (buf.length < 5) return;
      if (buf[0] !== 5 || buf[1] !== 1) { c.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      let host, off;
      if (buf[3] === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
      else if (buf[3] === 3) { const n = buf[4]; if (buf.length < 7 + n) return; host = buf.subarray(5, 5 + n).toString(); off = 5 + n; }
      else if (buf[3] === 4) { if (buf.length < 22) return; const h = buf.subarray(4, 20).toString('hex'); host = h.match(/.{4}/g).join(':'); off = 20; }
      else { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const port = buf.readUInt16BE(off); const rest = buf.subarray(off + 2);
      stage = 2; c.removeListener('data', onData);
      up = net.connect({ host, port });
      up.setTimeout(60000, end);
      up.once('connect', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); if (rest.length) up.write(rest); c.pipe(up); up.pipe(c); log('connect', host + ':' + port); });
      up.on('error', (e) => { log('dial failed', host + ':' + port, e.code || e.message); if (!c.destroyed) c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); end(); });
      up.on('close', () => c.destroy());
    }
  };
  c.on('data', onData);
});
}
const addrs = {}, servers = {}, seen = {};
async function listen(id) {
  if (addrs[id]) return;
  if (Object.keys(addrs).length >= 64) throw new Error('64 bootstrap listeners already open');
  const server = socksServer();
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  addrs[id] = '127.0.0.1:' + server.address().port; servers[id] = server;
  log('socks5 for', id.slice(0, 10), 'on', addrs[id]);
}
for (const id of ids) await listen(id);
let ledger = null, ledgerAt = 0;
async function leased(cfg) {   // active deployments whose lease metal0's runner holds now
  let err = '';
  for (const url of cfg.chain.rpc) {
    try {
      const c = createPublicClient({ transport: http(url, { timeout: 8000, retryCount: 0 }) });
      if (!ledger || Date.now() - ledgerAt > 3600_000) {
        ledger = await c.readContract({ address: cfg.chain.addressBook, abi: BOOK_ABI, functionName: 'addr', args: [stringToHex('deployments', { size: 32 })] });
        ledgerAt = Date.now();
      }
      const total = Number(await c.readContract({ address: ledger, abi: DEP_ABI, functionName: 'count' }));
      const rows = [];
      for (let i = 0; i < total; i += 50) rows.push(...await c.readContract({ address: ledger, abi: DEP_ABI, functionName: 'getPage', args: [BigInt(i), 50n] }));
      const now = Math.floor(Date.now() / 1000), runner = String(cfg.runner).toLowerCase();
      return rows.filter((r) => String(r.runner).toLowerCase() === runner && r.active === true && Number(r.leaseUntil) > now).map((r) => String(r.id).toLowerCase());
    } catch (e) { err = e.shortMessage || e.message; }
  }
  throw new Error('no RPC answered: ' + err);
}
async function refresh() {
  const cfg = JSON.parse(await fs.readFile(root + '/config.json', 'utf8'));
  try {
    for (const id of await leased(cfg)) { seen[id] = Date.now(); await listen(id); }
  } catch (e) { log('leased apps not read (static list still served):', e.message); }
  for (const id of Object.keys(addrs)) {   // a deployment gone from the lease list for 2 h loses its listener
    if (!ids.includes(id) && Date.now() - (seen[id] || 0) > 2 * 3600_000) { servers[id].close(); delete addrs[id]; delete servers[id]; log('closed', id.slice(0, 10)); }
  }
  const doc = { version: 1, expiresAt: Date.now() + 30000, apps: Object.fromEntries(Object.keys(addrs).map((id) => [id, { proxies: [addrs[id]], dns: cfg.dns }])) };
  await fs.writeFile(output + '.tmp', JSON.stringify(doc) + '\n', { mode: 0o600 });
  await fs.rename(output + '.tmp', output);
}
for (;;) { try { await refresh(); } catch (e) { log('bootstrap file not written:', e.message); } await new Promise((r) => setTimeout(r, 10000)); }
