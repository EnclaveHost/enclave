#!/usr/bin/env node
// TEST FIXTURE (not a service): an app-zone challenge "fleet" of SEPARATE replica processes for end-to-end tests.
//   node test/app-zone-fleet.mjs [replicas=3]  -> prints ONE JSON line {replicas:[{api,dns,pid}], control, upstreamValue, ...}
// It runs, all on loopback (run it inside an unshared network namespace):
//   - a deterministic Base chain over HTTPS JSON-RPC on 127.0.0.2-4 (three RPC "hosts", a per-run test CA): the ledger,
//     registry and catalog of test/app-zone-fixture.mjs, served through Multicall3 exactly as viem's batching asks;
//   - the route map a read-only replica polls (no labels: challenges need none);
//   - an "upstream" TCP DNS standing in for today's control challenge store (one legacy TXT value), for the transition merge;
//   - N `node relay/dns-relay.js` processes with DNS_READ_ONLY=1 APP_CHALLENGE_AUTH=attested-lease (replica 0 forwards
//     accepted pushes to the others), judge lab-unsigned (synthetic reports, stated);
//   - a control API: POST /attest {spki,nonce,hostData?,measurement?} -> attestation document; POST /chain {op,...}
//     mutates the chain; POST /kill {i} stops replica i; POST /quit stops everything.
// Exits (and stops every child) when stdin closes.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import * as F from './app-zone-fixture.mjs';
import {DEPLOYMENTS_ABI, REGISTRY_ABI, CATALOG_ABI} from '../network/app-zone-challenge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'network', 'package.json'));
const {decodeFunctionData, encodeFunctionResult, parseAbi} = await import(pathToFileURL(req.resolve('viem')).href);
const N = Math.min(Math.max(Number(process.argv[2] || 3), 1), 8);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'app-zone-fleet-'));
const children = [];
let control = null;   // set once the control API listens (shutdown may run earlier)
const state = F.chainState();
const LEGACY_LABEL = 'c0ffee00', LEGACY_VALUE = 'L'.repeat(43);

// ---- per-run TLS for the RPC hosts --------------------------------------------------------------------------------
const ossl = (args) => execFileSync('openssl', args, {cwd: T, stdio: ['ignore', 'ignore', 'pipe']});
ossl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=app-zone-fleet-test-ca',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
ossl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'rpc.key', '-out', 'rpc.csr', '-subj', '/CN=rpc']);
fs.writeFileSync(path.join(T, 'rpc.ext'), 'subjectAltName=IP:127.0.0.2,IP:127.0.0.3,IP:127.0.0.4\nextendedKeyUsage=serverAuth\n');
ossl(['x509', '-req', '-in', 'rpc.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'rpc.pem', '-days', '1', '-extfile', 'rpc.ext']);

// ---- the chain ------------------------------------------------------------------------------------------------------
const multicallABI = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const start = Math.floor(Date.now() / 1000), head = 52840000;
function contract(target, data) {
  target = target.toLowerCase();
  if (target === MULTICALL) {
    const {args: [calls]} = decodeFunctionData({abi: multicallABI, data});
    return encodeFunctionResult({abi: multicallABI, functionName: 'aggregate3', result: calls.map((c) => {
      try { return {success: true, returnData: contract(c.target, c.callData)}; } catch (e) { if (!c.allowFailure) throw e; return {success: false, returnData: '0x'}; }
    })});
  }
  const abi = target === F.PINS.deployments ? DEPLOYMENTS_ABI : target === F.PINS.registry ? REGISTRY_ABI : target === F.PINS.catalog ? CATALOG_ABI : null;
  if (!abi) throw Error('unexpected contract ' + target);
  const {functionName, args} = decodeFunctionData({abi, data});
  const result = F.readContract(state, {address: target, functionName, args});
  return encodeFunctionResult({abi, functionName, result});
}
const rpcCounts = {};
function rpc(q) {
  rpcCounts[q.method] = (rpcCounts[q.method] || 0) + 1;
  try {
    let result;
    switch (q.method) {
      case 'eth_chainId': result = '0x2105'; break;
      case 'eth_blockNumber': result = '0x' + (head + Math.floor((Date.now() / 1000 - start) / 2)).toString(16); break;
      case 'eth_getBlockByNumber': { const n = Number(BigInt(q.params[0]));
        result = {number: q.params[0], hash: '0x' + n.toString(16).padStart(64, '0'), timestamp: '0x' + (start + (n - head) * 2).toString(16), transactions: []}; break; }
      case 'eth_call': result = contract(q.params[0].to, q.params[0].data); break;
      case 'eth_getCode': result = '0x'; break;
      default: throw Error('unexpected RPC ' + q.method);
    }
    return {jsonrpc: '2.0', id: q.id, result};
  } catch (e) { return {jsonrpc: '2.0', id: q.id, error: {code: -32603, message: e.message}}; }
}
const rpcServers = [];
for (let i = 0; i < 3; i++) {
  const s = https.createServer({cert: fs.readFileSync(path.join(T, 'rpc.pem')), key: fs.readFileSync(path.join(T, 'rpc.key'))}, async (rq, rs) => {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const q = JSON.parse(Buffer.concat(chunks).toString());
    rs.writeHead(200, {'content-type': 'application/json'}); rs.end(JSON.stringify(Array.isArray(q) ? q.map(rpc) : rpc(q)));
  });
  await new Promise((ok) => s.listen(0, `127.0.0.${i + 2}`, ok));
  rpcServers.push(s);
}
const rpcUrls = rpcServers.map((s) => `https://${s.address().address}:${s.address().port}`);

// ---- route map (empty) and the upstream control DNS ---------------------------------------------------------------
const routeMap = http.createServer((rq, rs) => { rs.writeHead(200, {'content-type': 'application/json'}); rs.end(JSON.stringify({transport: 'enclave-network', labels: {}, deployments: {}, pending: []})); });
await new Promise((ok) => routeMap.listen(0, '127.0.0.1', ok));
const upstream = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length < 2 || buf.length < 2 + buf.readUInt16BE(0)) return;
    const q = buf.subarray(2, 2 + buf.readUInt16BE(0));
    let o = 12, labels = [];
    while (q[o]) { labels.push(q.subarray(o + 1, o + 1 + q[o]).toString()); o += 1 + q[o]; }
    const name = labels.join('.').toLowerCase(), question = q.subarray(12, o + 5);
    const hit = name === `_acme-challenge.${LEGACY_LABEL}.${F.ZONE}`;
    const hdr = Buffer.alloc(12); q.copy(hdr, 0, 0, 2); hdr.writeUInt16BE(0x8400, 2); hdr.writeUInt16BE(1, 4); hdr.writeUInt16BE(hit ? 1 : 0, 6);
    const ans = hit ? Buffer.concat([Buffer.from([0xc0, 0x0c]), Buffer.from([0, 16, 0, 1, 0, 0, 0, 30]), Buffer.from([0, 44, 43]), Buffer.from(LEGACY_VALUE)]) : Buffer.alloc(0);
    const msg = Buffer.concat([hdr, question, ans]);
    const len = Buffer.alloc(2); len.writeUInt16BE(msg.length); sock.end(Buffer.concat([len, msg]));
  });
});
await new Promise((ok) => upstream.listen(0, '127.0.0.1', ok));

// ---- the replicas ---------------------------------------------------------------------------------------------------
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const replicas = [];
for (let i = 0; i < N; i++) replicas.push({api: await freePort(), dns: await freePort()});
const blank = Object.fromEntries(['TCP_ZONE', 'BOX_ZONE', 'APP_STATIC', 'DNS_TXT_KEY', 'SECRET', 'REGISTRY_ADDRESS', 'ENCLAVES', 'ENCLAVE_URL', 'ELIGIBILITY_API',
  'DOMAINS_API', 'ADDRESS_BOOK_ADDRESS', 'BASE_RPC', 'DNS_CHALLENGE_AUTH', 'ATTESTED_SHIELD_POLICY'].map((k) => [k, '']));
for (let i = 0; i < N; i++) {
  const r = replicas[i];
  const env = {...process.env, ...blank, NODE_EXTRA_CA_CERTS: path.join(T, 'ca.pem'), DNS_READ_ONLY: '1', ROUTE_MAP_URL: `http://127.0.0.1:${routeMap.address().port}/v1/network/routes`,
    IP_ZONE: 'ip.enclave.host', APP_ZONE: F.ZONE, NS_NAME: `ns-${i}.enclave.host`, DNS_BIND: '127.0.0.1', DNS_PORT: String(r.dns), DNS_API_BIND: '127.0.0.1', DNS_API_PORT: String(r.api),
    APP_CHALLENGE_AUTH: 'attested-lease', APP_CHALLENGE_MEASUREMENTS: F.MEAS, APP_CHALLENGE_JUDGE_MODE: 'lab-unsigned', APP_CHALLENGE_KDS: '0',
    APP_CHALLENGE_RPCS: rpcUrls.join(','), APP_CHALLENGE_PINS: JSON.stringify(F.PINS), APP_CHALLENGE_UPSTREAM: `127.0.0.1:${upstream.address().port}`,
    APP_CHALLENGE_PEERS: i === 0 ? replicas.slice(1).map((x) => `http://127.0.0.1:${x.api}`).join(',') : '', NET_POLL_SEC: '5'};
  // APPZONE_REPLICA_ENTRY: run the BUILT replica bundle (deploy/dist/dns.mjs) instead of the source entry
  const entry = process.env.APPZONE_REPLICA_ENTRY ? path.resolve(process.env.APPZONE_REPLICA_ENTRY) : path.join(ROOT, 'relay', 'dns-relay.js');
  const child = spawn(process.execPath, [entry], {cwd: path.dirname(entry), env, stdio: ['ignore', 'pipe', 'pipe']});
  r.log = ''; child.stdout.on('data', (c) => { r.log += c; }); child.stderr.on('data', (c) => { r.log += c; });
  r.child = child; children.push(child);
}
for (const r of replicas) {
  let ok = false;
  for (let k = 0; k < 150 && !ok; k++) {
    const h = await fetch(`http://127.0.0.1:${r.api}/health`).then((x) => x.json()).catch(() => null);
    ok = !!h?.appChallenge?.ledgerIndex?.complete;
    if (!ok) await new Promise((res) => setTimeout(res, 200));
  }
  if (!ok) { process.stderr.write('replica did not become ready:\n' + r.log.slice(-3000)); shutdown(1); }
}

// ---- control ------------------------------------------------------------------------------------------------------
control = http.createServer(async (rq, rs) => {
  const chunks = []; for await (const c of rq) chunks.push(c);
  let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
  const send = (code, v) => { rs.writeHead(code, {'content-type': 'application/json'}); rs.end(JSON.stringify(v)); };
  try {
    if (rq.url === '/attest') return send(200, F.attestDoc(Buffer.from(b.spki, 'base64'), Buffer.from(b.nonce, 'hex'),
      {...(b.hostData ? {hostData: b.hostData} : {}), ...(b.measurement ? {measurement: b.measurement} : {})}));
    if (rq.url === '/chain') {
      const d = state.deployments[F.DEP];
      if (b.op === 'ban-host') state.hosts[F.RUNNER].active = false;
      else if (b.op === 'unban-host') state.hosts[F.RUNNER].active = true;
      else if (b.op === 'delist') state.apps['0x' + '66'.repeat(32)].active = false;
      else if (b.op === 'relist') state.apps['0x' + '66'.repeat(32)].active = true;
      else if (b.op === 'release') { d.runner = '0x' + '0'.repeat(64); d.runnerOperator = '0x' + '0'.repeat(40); }
      else if (b.op === 'relet') { d.runner = '0x' + 'ce'.repeat(32); state.hosts[d.runner] = {operator: F.OPERATOR, active: true}; }
      else if (b.op === 'restore') Object.assign(state, F.chainState());
      else return send(400, {error: 'unknown op'});
      return send(200, {ok: true});
    }
    if (rq.url === '/kill') { const r = replicas[b.i]; r.child.kill('SIGTERM'); await new Promise((ok) => r.child.once('exit', ok)); r.dead = true; return send(200, {ok: true}); }
    if (rq.url === '/logs') return send(200, replicas.map((r) => r.log.slice(-4000)));
    if (rq.url === '/quit') { send(200, {ok: true}); return shutdown(0); }
    send(404, {error: 'not found'});
  } catch (e) { send(500, {error: e.message}); }
});
await new Promise((ok) => control.listen(0, '127.0.0.1', ok));

function shutdown(code) {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  for (const s of [...rpcServers, routeMap, upstream, control].filter(Boolean)) { try { s.closeAllConnections?.(); s.close(); } catch {} }
  // remove the per-run fixture directory now (an unref'd timer may never fire), then give children a moment to exit
  try { fs.rmSync(T, {recursive: true, force: true}); } catch {}
  setTimeout(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } process.exit(code); }, 500);
}
process.stdin.on('end', () => shutdown(0)); process.stdin.resume();
process.on('SIGTERM', () => shutdown(0));
process.stdout.write(JSON.stringify({entry: process.env.APPZONE_REPLICA_ENTRY ? path.resolve(process.env.APPZONE_REPLICA_ENTRY) : 'relay/dns-relay.js', replicas: replicas.map((r) => ({api: `http://127.0.0.1:${r.api}`, dns: `127.0.0.1:${r.dns}`, pid: r.child.pid})),
  control: `http://127.0.0.1:${control.address().port}`, zone: F.ZONE, deployment: F.DEP, owner: F.OWNER, runner: F.RUNNER, operator: F.OPERATOR,
  appRef: F.APP_REF, envelope: F.ENVELOPE, legacy: {name: `_acme-challenge.${LEGACY_LABEL}.${F.ZONE}`, value: LEGACY_VALUE}}) + '\n');
