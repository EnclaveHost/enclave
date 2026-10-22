// ADVERSARIAL reproduction against the draft (6e46c06da), root review 2026-10-22: an UNBANNED advertiser republishes a
// BANNED operator's still-valid native-CA endpoint. The draft judges only the advertiser and proves only "this address holds
// a native-CA key for the name", so it serves the banned operator's endpoint. A PASS here means the defect is reproduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { keccak256 } from 'viem';
import { SERVICE_KINDS, AD_VERSION } from '../network/service-index.mjs';
import { discoverControlRoutes } from '../network/native-control-routes.mjs';

const API = 'api.enclavehost.eth', MCP = 'mcp.enclavehost.eth', Z32 = '0x' + '0'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-subst-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const o = (a) => execFileSync('openssl', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=native', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
// the production profile (renew-native-cert.py): DNS SANs only - nothing in the leaf names an operator or a registry host
o(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'y.key', '-out', 'y.csr', '-subj', `/CN=${API}`, '-addext', `subjectAltName=DNS:${API},DNS:${MCP}`]);
o(['x509', '-req', '-in', 'y.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '0x01', '-days', '1', '-copy_extensions', 'copy', '-out', 'y.pem']);
const caPem = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'), Y_LEAF = fs.readFileSync(path.join(dir, 'y.pem'), 'utf8');

const BANNED = '0x' + '66'.repeat(20), ADVERTISER = '0x' + '11'.repeat(20), Y_ENDPOINT = '44.0.0.6';
let port; const dials = [];
const server = tls.createServer({ key: fs.readFileSync(path.join(dir, 'y.key')), cert: Y_LEAF }, (s) => s.on('error', () => {}));
server.on('tlsClientError', () => {});
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => server.close());
const connect = (opts) => { dials.push(opts.host); return tls.connect({ ...opts, host: '127.0.0.1', port: opts.host === Y_ENDPOINT ? port : 1 }); };

const CODE = '0x6080', PIN = { chainId: 8453, address: '0x' + '5a'.repeat(20), codeHash: keccak256(CODE) };
const ads = [{ operator: BANNED, endpoints: [`https://${Y_ENDPOINT}/`] }, { operator: ADVERTISER, endpoints: [`https://${Y_ENDPOINT}/`] }];
const rpc = () => {
  const ts = BigInt(Math.floor(Date.now() / 1000));
  const row = (a) => ({ operator: a.operator, slot: 0, kind: SERVICE_KINDS['native-control'], version: AD_VERSION, sequence: 1n, expiresAt: ts + 3600n, updatedAt: ts, descriptor: Z32, endpoints: a.endpoints });
  return { getChainId: async () => 8453, getBlockNumber: async () => 100n, getCode: async () => CODE,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: '0x' + blockNumber.toString(16).padStart(64, '0'), timestamp: ts, parentHash: '0x' + (blockNumber - 1n).toString(16).padStart(64, '0') }),
    readContract: async ({ functionName, args }) => {
      if (functionName === 'page') { const l = Number(args[0]) === SERVICE_KINDS['native-control'] ? ads : []; return [l.slice(Number(args[1])).map(row), BigInt(l.length)]; }
      throw new Error(functionName);
    } };
};
// the platform host policy as decideOperators answers it: the serving operator is banned, the advertiser is not
const decide = async (ops) => Object.fromEntries(ops.map((x) => [x, x === BANNED ? { admit: false, status: 'current', reason: 'banned by platform policy #7 (operator): abuse' } : { admit: true, status: 'current', reason: null }]));

test('DRAFT DEFECT reproduced: an unbanned advertiser reintroduces a banned operator\'s native-CA endpoint', async () => {
  const r = await discoverControlRoutes({ clients: [rpc(), rpc()], indexPin: PIN, caPem, decide, failureDomains: [], connect, probeTimeoutMs: 2000 });
  assert.deepEqual(r.refusedByPolicy.map((x) => x.operator), [BANNED], 'the banned operator\'s OWN ad is refused');
  assert.deepEqual(r.routes[API]?.addresses, [Y_ENDPOINT], 'yet the same endpoint is served through the advertiser');
  assert.deepEqual(r.routes[MCP]?.addresses, [Y_ENDPOINT]);
  assert.ok(r.verified.every((v) => v.operator === ADVERTISER), 'the proof is attributed to the advertiser, who holds no key');
  assert.ok(dials.every((d) => d === Y_ENDPOINT));
  // what the TLS proof actually bound: a key to DNS names. No operator, registry id or host endpoint is in the leaf.
  const san = new X509Certificate(Y_LEAF).subjectAltName;
  assert.equal(san, `DNS:${API}, DNS:${MCP}`);
});
