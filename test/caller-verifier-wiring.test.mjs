// Caller configuration of the local-verifier chain authority where an existing LeaseReader / host-policy snapshot can take
// it: independent-mode trust (--chain-verifier), its LeaseReader options, the management and native clients, the CLI
// flag, and the MCP profile key. Everything else in those callers (their RPC-quorum reads and every transaction) is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadIndependentTrust, independentReaderAuthority } from '../cli/independent.mjs';
import { ManagementClient } from '../network/management-client.mjs';
import { NativeClient } from '../network/native-client.mjs';
import { loadConfig, Authority } from '../mcp/independent.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'caller-verifier-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const PINS = Object.freeze({ registry: '0x' + '11'.repeat(20), deployments: '0x' + '22'.repeat(20), appCatalog: '0x' + '33'.repeat(20), proofOfTime: '0x' + '44'.repeat(20),
  enclavePay: '0x' + '00'.repeat(20), verificationFees: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20), secretVaultV2: '0x' + '00'.repeat(20) });
const trustArgs = { contractPins: PINS, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', rpcs: ['https://a.example.org', 'https://b.example.org'] };

test('independent trust: --chain-verifier is optional, local only, and selects the verifier for LeaseReader reads', () => {
  const q = loadIndependentTrust(trustArgs);
  assert.equal(q.chainVerifier, null);
  const chain = { peers: [{ client: { a: 1 } }, { client: { b: 2 } }] };
  assert.deepEqual(Object.keys(independentReaderAuthority(q, chain)), ['clients']);
  const v = loadIndependentTrust({ ...trustArgs, chainVerifier: 'http://127.0.0.1:8545/' });
  assert.equal(v.chainVerifier, 'http://127.0.0.1:8545/');
  assert.deepEqual(independentReaderAuthority(v, chain), { authority: 'verifier', verifier: 'http://127.0.0.1:8545/' });
  assert.throws(() => loadIndependentTrust({ ...trustArgs, chainVerifier: 'https://rpc.example.org/' }), /local endpoint/);
  // the RPC quorum itself is still required: the verifier replaces no other read and no transaction
  assert.throws(() => loadIndependentTrust({ ...trustArgs, rpcs: [], chainVerifier: 'http://127.0.0.1:8545/' }), /RPC/);
});

test('the management client builds its LeaseReader on the verifier when told, never on the RPC list', () => {
  const common = { deploymentId: '0x' + 'cd'.repeat(32), authorityPins: { deployments: PINS.deployments, registry: PINS.registry, connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) },
    directories: ['http://8.8.8.8:1/'], stateDir: path.join(tmp, 'mgmt'), signer: async () => 'x' };
  const v = new ManagementClient({ ...common, rpc: ['https://a.example.org', 'https://b.example.org'], chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' });
  assert.equal(v.reader.authority, 'verifier');
  assert.equal(v.reader.clients.length, 0);
  const q = new ManagementClient({ ...common, rpc: ['https://a.example.org', 'https://b.example.org'] });
  assert.equal(q.reader.authority, 'quorum');
  assert.throws(() => new ManagementClient({ ...common, rpc: ['https://a.example.org', 'https://b.example.org'], chainVerifier: 'http://127.0.0.1:8545/' }), /not verifier/);
});

test('a native trust profile may choose the verifier for its LeaseReader', () => {
  const profile = { version: 1, deploymentId: '0x' + 'cd'.repeat(32), hostname: 'app.example.org', stateDir: path.join(tmp, 'native'), chainId: 8453, linux: {}, checkers: ['0x' + '55'.repeat(20)],
    expected: { appRef: 'ref', configCid: 'cid', appSha256: 'ab'.repeat(32), runtimeId: 'cd'.repeat(32) },
    authorityPins: { deployments: PINS.deployments, registry: PINS.registry, connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) }, directories: ['http://192.0.2.1:1/'], rpc: ['https://a.example.org', 'https://b.example.org'] };
  const opts = { hostAdmission: async () => ({ admit: true }), fetch: async () => { throw Error('no I/O at construction'); } };
  const v = new NativeClient({ ...profile, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' }, opts);
  assert.equal(v.reader.authority, 'verifier');
  assert.equal(v.reader.clients.length, 0);
  assert.equal(new NativeClient(profile, opts).reader.authority, 'quorum');
  assert.throws(() => new NativeClient({ ...profile, chainAuthority: 'verifier', chainVerifier: 'https://rpc.example.org/' }, opts), /local endpoint/);
});

test('the CLI flag: --chain-verifier belongs to independent mode', () => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'cli', 'enclave.mjs');
  const r = spawnSync(process.execPath, [cli, 'ls', '--chain-verifier', 'http://127.0.0.1:8545/'], { encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: tmp, ENCLAVE_NO_UPDATE_CHECK: '1' } });
  assert.match(r.stderr + r.stdout, /--chain-verifier apply to independent mode/);
});

test('the MCP profile key reaches the profile trust (and a remote URL is refused there)', async () => {
  fs.writeFileSync(path.join(tmp, 'pins.json'), JSON.stringify({ version: 1, chainId: 8453, contracts: PINS }));
  const cfgFile = (extra) => { const f = path.join(tmp, `mcp-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ format: 'enclave-mcp-independent/v1', profiles: { p: { contractPins: 'pins.json', rpcs: ['https://a.example.org', 'https://b.example.org'], stateDir: 'state', ...extra } } })); return f; };
  const prof = loadConfig(cfgFile({ chainVerifier: 'http://127.0.0.1:8545/' })).profiles.get('p');
  assert.equal(prof.chainVerifier, 'http://127.0.0.1:8545/');
  const a = new Authority(prof);
  assert.equal((await a.trustPromise).chainVerifier, 'http://127.0.0.1:8545/');
  const bad = new Authority(loadConfig(cfgFile({ chainVerifier: 'https://rpc.example.org/' })).profiles.get('p'));
  await assert.rejects(bad.trustPromise, /local endpoint/);
});
