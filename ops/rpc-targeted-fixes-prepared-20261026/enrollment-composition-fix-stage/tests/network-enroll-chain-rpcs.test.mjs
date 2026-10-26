// network-enroll-chain-rpcs.test.mjs (enrollment-composition-fix-stage; PREPARED; root copies it into the candidate export and
// runs it: exactly 6 tests; on the UNPATCHED candidate exactly tests 1, 2, 5 and 6 fail with ReferenceError: rpcs is not defined).
// The composed windows/node/network-enroll.mjs chain section: legacy follows the node's https RPC list; the node's explicit
// chain authority (verifier, or an INVALID selection) is exactly agentChain() and never carries a public RPC list; operator
// opt-ins (challengeReplica) are kept across an RPC switch. Same harness shape as test/windows-chain-authority.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseConfig, createNetworkEnroll } from '../windows/node/network-enroll.mjs';

const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const ID = '0x' + 'ab'.repeat(32);
const OLD = ['https://old-a.example.org', 'https://old-b.example.org'];
const NEW = ['https://rpc-a.example.org', 'https://rpc-b.example.org'];
const VERIFIER = { authority: 'verifier', verifier: 'http://127.0.0.1:8545/' };
const TMPS = [];
test.after(() => { for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true }); });

function box(chain = {}, mutateNetwork = null) {
  const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'enroll-rpcs-')); TMPS.push(tmp);
  const common = { agentDir: path.join(tmp, 'agent'), binDir: path.join(tmp, 'bin'), nodeBinary: process.execPath, operatorKeyFile: path.join(tmp, 'op.key'),
    runner: ID, endpoint: 'https://host.example.org', relayBase: 'https://relay.example.org', policyFile: path.join(tmp, 'p.json'), tpmBinary: 'tpm.exe', tpmSha256: 'aa'.repeat(32),
    addressBook: a(0xb00c), chainRpc: OLD, enclaveNetwork: { checkers: [a(0xc4)] } };
  fs.mkdirSync(common.agentDir, { recursive: true });
  fs.writeFileSync(common.policyFile, JSON.stringify({ cpu: { runtimeId: 'aa'.repeat(32) } }));
  const cfgFile = path.join(common.agentDir, 'privacy-config.json');
  const base = baseConfig({ ...common, ...chain });
  const initial = { ...base, ...(mutateNetwork ? { enclaveNetwork: mutateNetwork(base.enclaveNetwork) } : {}),
    apps: [{ deploymentId: ID, names: [], expectedFile: path.join(tmp, 'e.json'), internetMode: 'enclave-network', publishToMirror: true }] };
  fs.writeFileSync(cfgFile, JSON.stringify(initial));
  const state = { restarts: 0 };
  const pass = (config) => createNetworkEnroll({ agentDir: common.agentDir, binDir: common.binDir, runner: ID, relayBase: common.relayBase, config: { ...common, ...config },
    rows: async () => [], version: async () => ({}), vms: async () => [], fetch: async () => ({ ok: false }), restartAgent: async () => { state.restarts++; }, log: () => {} }).pass();
  const read = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  return { pass, read, state };
}

test('1 legacy: the node https RPC list (>= 2, http dropped) replaces the agent list and restarts once; an unchanged list restarts nothing', async () => {
  const b = box();
  await b.pass({ chainRpc: [...NEW, 'http://plain.example.org'] });
  assert.deepEqual(b.read().chain, { addressBook: a(0xb00c), rpc: NEW });
  assert.equal(b.state.restarts, 1);
  await b.pass({ chainRpc: [...NEW, 'http://plain.example.org'] });
  assert.equal(b.state.restarts, 1, 'the same list changes nothing');
});

test('2 legacy: fewer than two https RPCs never replace (or empty) the agent list', async () => {
  const b = box();
  await b.pass({ chainRpc: ['https://only-one.example.org', 'http://plain.example.org'] });
  assert.deepEqual(b.read().chain, { addressBook: a(0xb00c), rpc: OLD });
  assert.equal(b.state.restarts, 0);
});

test('3 verifier authority: the chain is exactly the local verifier; the node public chainRpc is never written beside it (no public fallback)', async () => {
  const b = box();
  await b.pass({ chainRpc: NEW, chainAuthority: VERIFIER });
  assert.deepEqual(b.read().chain, { addressBook: a(0xb00c), authority: 'verifier', verifier: 'http://127.0.0.1:8545/' });
  assert.equal('rpc' in b.read().chain, false);
  assert.equal(b.state.restarts, 1);
});

test('4 an INVALID authority selection configures NO RPC at all (the agent readers refuse), never the public list', async () => {
  const b = box();
  await b.pass({ chainRpc: NEW, chainAuthority: { invalid: 'ENCLAVE_CHAIN_AUTHORITY is not quorum or verifier' } });
  assert.deepEqual(b.read().chain, { addressBook: a(0xb00c) });
  assert.equal(b.state.restarts, 1);
});

test('5 verifier -> legacy: the verifier selection is removed explicitly and the node https list is restored, one restart', async () => {
  const b = box({ chainRpc: [], chainAuthority: VERIFIER });
  assert.equal(b.read().chain.authority, 'verifier');
  await b.pass({ chainRpc: NEW });
  assert.deepEqual(b.read().chain, { addressBook: a(0xb00c), rpc: NEW });
  assert.equal(b.state.restarts, 1);
});

test('6 the operator challengeReplica opt-in is kept byte-for-byte across a legacy RPC switch', async () => {
  const replica = { role: 'challenge', listen: '127.0.0.1:9443', note: 'operator-owned; never computed here' };
  const b = box({}, (en) => ({ ...en, challengeReplica: replica }));
  await b.pass({ chainRpc: NEW });
  assert.deepEqual(b.read().enclaveNetwork.challengeReplica, replica);
  assert.deepEqual(b.read().chain.rpc, NEW);
});
