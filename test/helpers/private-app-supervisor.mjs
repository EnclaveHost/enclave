// Test-only process fixture for PRIVATE-APP BROWSER ACCESS (work/private-browser-access-interface.txt): the ACTUAL
// supervisor.js, unmodified and without any self-test seam, as a child process. Derived from management-supervisor.mjs
// (kept unchanged); this one adds what the private data path needs:
//   - several deployments, each restored from a seeded STATE_FILE (the supervisor's own loadState) as a running, PRIVATE,
//     vm-backed record exactly as a claim leaves it - including `access` (what parseDepOptions makes of an envelope);
//   - a tenant HTTP server per deployment behind its forwarded port, recording what reached the app (e.g. its Cookie);
//   - chain reads from `chain`: session vaults and factory (eth_call), and the deployments ledger's code and delegation
//     storage (eth_getCode / eth_getStorageAt), so the owner-delegation path (a Safe-held deployment) is real;
//   - the network: the loopback-only preload refuses every non-loopback fetch (no RPC fallback, no Enclave domain).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {decodeFunctionData, encodeFunctionResult, getAddress} from 'viem';
import {VAULT_ABI, FACTORY_ABI} from '../../windows/node/session-api-auth.mjs';

const ABI = [...VAULT_ABI, ...FACTORY_ABI];
const ZERO32 = '0x' + '00'.repeat(32);
export const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const readJson = req => new Promise((resolve, reject) => { const c = []; req.on('data', d => c.push(d)); req.once('end', () => { try { resolve(c.length ? JSON.parse(Buffer.concat(c)) : null); } catch (e) { reject(e); } }); });

// chain: {factory, ledger, ledgerCode, delegated: Set<slot>, vaults: {<vault lc>: {owner, held: {<id>: env},
//         sessions: {<sid>: {keyHash, actions, envs, expiresAt, live}}}}}. Mutable: tests rotate, revoke and delegate live.
function rpcServer(chain) {
  const call = ({to, data}) => {
    const {functionName, args} = decodeFunctionData({abi: ABI, data});
    const at = String(to).toLowerCase(), v = chain.vaults[at];
    let result;
    if (functionName === 'isVault') { if (at !== chain.factory.toLowerCase()) throw Error('not the factory'); result = !!chain.vaults[String(args[0]).toLowerCase()]; }
    else if (!v) throw Error('no contract');
    else if (functionName === 'owner') result = getAddress(v.owner);
    else if (functionName === 'held') result = [v.held[String(args[0]).toLowerCase()] || 0, ZERO32, ZERO32];
    else if (functionName === 'sessionOf') {
      const x = v.sessions[String(args[0]).toLowerCase()];
      const s = x || {keyHash: ZERO32, actions: '0', envs: 0, expiresAt: 0, live: false};
      result = [{keyHash: s.keyHash, measurement: ZERO32, actions: BigInt(s.actions), expiresAt: BigInt(s.expiresAt), epoch: 0n, envs: s.envs, state: 0, anyApp: false,
        balance6: 0n, spent6: 0n, perPeriod6: 0n, maxFee6: 0n, maxAppFeeHour6: 0n, maxRateHour6: 0n, periodStart: 0n, period: 0, opsPerPeriod: 0, periodSpent6: 0n, periodOps: 0},
        !!(x && x.live), []];
    } else throw Error('unscripted');
    return encodeFunctionResult({abi: ABI, functionName, result});
  };
  const one = m => {
    try {
      if (m.method === 'eth_chainId') return {result: '0x2105'};
      if (m.method === 'eth_blockNumber') return {result: '0x100'};
      if (m.method === 'eth_getLogs') return {result: []};
      if (m.method === 'eth_call') return {result: call(m.params[0])};
      if (m.method === 'eth_getCode') return {result: String(m.params[0]).toLowerCase() === String(chain.ledger || '').toLowerCase() ? (chain.ledgerCode || '0x') : '0x'};
      if (m.method === 'eth_getStorageAt') {
        const on = String(m.params[0]).toLowerCase() === String(chain.ledger || '').toLowerCase() && chain.delegated && chain.delegated.has(String(m.params[1]).toLowerCase());
        return {result: '0x' + '0'.repeat(63) + (on ? '1' : '0')};
      }
      return {error: {code: -32601, message: 'not available in this fixture'}};
    } catch (e) { return {error: {code: 3, message: 'execution reverted: ' + e.message, data: '0x'}}; }
  };
  return http.createServer(async (req, res) => {
    const body = await readJson(req).catch(() => null);
    const answer = Array.isArray(body) ? body.map(m => ({jsonrpc: '2.0', id: m.id, ...one(m)})) : {jsonrpc: '2.0', id: body?.id, ...one(body || {})};
    res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(answer));
  });
}

const managerServer = () => http.createServer(async (req, res) => {
  await readJson(req).catch(() => null);
  const u = new URL(req.url, 'http://manager.local');
  res.writeHead(200, {'content-type': 'application/json'});
  if (req.method === 'GET' && u.pathname === '/vms') return res.end('[]');
  if (req.method === 'GET' && u.pathname.startsWith('/vms/')) return res.end(JSON.stringify({id: u.pathname.slice(5), status: 'running'}));
  res.end('{"ok":true}');
});

// The private app itself: answers every path with its id, and records each request's Cookie (the supervisor must have
// stripped its own enclave_app pair before the app sees it).
function tenantServer(id, seen) {
  return http.createServer((req, res) => {
    seen.push({path: req.url, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null});
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(`<!doctype html><title>private app</title><h1 id="app">PRIVATE-APP ${id}</h1>`);
  });
}

/**
 * -> {port, tenants: {<id>: [requests]}, stdout()} once the supervisor listens.
 * deployments: [{id, owner, access?}] restored running + private. `env` adds or overrides supervisor environment.
 */
export async function startPrivateAppSupervisor(t, {chain, deployments, pins, publicUrl, env = {}}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-app-supervisor-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const rpc = rpcServer(chain), manager = managerServer(), tenants = {}, servers = [rpc, manager];
  for (const d of deployments) { tenants[d.id] = []; servers.push(d._server = tenantServer(d.id, tenants[d.id])); }
  await Promise.all(servers.map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
  const pinFile = path.join(dir, 'pins.json');
  fs.writeFileSync(pinFile, JSON.stringify({version: 1, chainId: 8453, contracts: pins}));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({savedAt: Date.now(), deployments: deployments.map((d, i) => ({id: d.id, owner: getAddress(d.owner), status: 'running', public: false,
    firewall: [], image: {reference: 'catalog://0x' + '00'.repeat(32) + '/0'}, command: [], config: '', resources: {cpuShare: 0.1, gpuShare: 0},
    network: {port: 8080, protocol: 'https'}, remainingMs: null, _vmId: 'vm-private-' + i, _vmHostPort: d._server.address().port, _port: 0,
    ...(d.access ? {access: d.access} : {}), startedAt: Date.now(), createdAt: new Date().toISOString()}))}));
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', new URL('./loopback-only-fetch.mjs', import.meta.url).pathname, 'supervisor.js'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {PATH: process.env.PATH, HOME: dir, SECRET: 'private-app-fixture-secret', PORT: String(port), ENABLE_MPS: '0', STATE_FILE: stateFile,
      PROVISION_BACKEND: 'vm', VMMGR_URL: `http://127.0.0.1:${manager.address().port}`, BASE_RPC: `http://127.0.0.1:${rpc.address().port}`,
      ENCLAVE_CONTRACT_PINS_FILE: pinFile, ADDRESS_BOOK_ADDRESS: '', PUBLIC_URL: publicUrl, SECRETS_API: '', DOMAINS_API: '', CERTS_API: '', DNS_API: '',
      APP_CERT_DOMAIN: '', CLAIM_ENABLED: '', REGISTRY_ENABLED: '', SESSION_KEY_DIR: path.join(dir, 'session-key'), ...env},
  });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('the supervisor did not start:\n' + out.slice(-2000))), 30000);
    const check = () => { if (out.includes(`enclave supervisor on :${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check);
    child.once('exit', code => { clearTimeout(timer); reject(Error(`the supervisor exited ${code}:\n` + out.slice(-2000))); });
  });
  return {port, tenants, stdout: () => out, child};
}
