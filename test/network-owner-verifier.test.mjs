// The network host's owner-signature verification under the explicit local verifier (no pins, no provider clients): a
// contract-wallet (SessionVault) owner is verified through the authenticated reader at ONE block, with the SessionVault
// factory read from the admin's address book at that block; a refusing reader answers "not the owner"; an EOA owner needs no
// chain read. The legacy reader without pins and without RPCs is unchanged (EOA only). The real-chain version of this is
// test/windows-verifier.e2e.test.mjs (enrollment -> privacy-agent construction -> policyFor on reth + Helios).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { stringToHex } from 'viem';
import { createNetworkHost } from '../network/enclave-network-host.mjs';
import { defaultNetworkPolicy, signNetworkPolicy } from '../network/network-policy.mjs';

const a = (n) => '0x' + n.repeat(40), book = a('1'), factory = a('4'), vault = a('5');
const id = '0x' + 'b'.repeat(64);
const owner = privateKeyToAccount('0x' + '11'.repeat(32));
const FACTORY_KEY = stringToHex('sessionVaultFactory', { size: 32 });
// the pinned client a verified snapshot hands its callback (block 998)
const pinned = (st) => ({
  getCode: async (q) => { assert.equal(q.blockNumber, 998n); return q.address === vault ? '0x01' : '0x'; },
  readContract: async (q) => {
    assert.equal(q.blockNumber, 998n);
    if (q.functionName === 'addr') { assert.equal(q.address, book); assert.equal(q.args[0], FACTORY_KEY); st.bookReads++; return st.factory; }
    if (q.functionName === 'isValidSignature') return '0xffffffff';
    if (q.functionName === 'isVault') return q.address === factory;
    if (q.functionName === 'owner') { assert.equal(q.address, vault); return owner.address; }
    throw new Error('unexpected ' + q.functionName);
  },
});
const verifierReader = (st) => ({ authority: 'verifier', agreed: async (fn) => { st.snapshots++; if (st.refuse) throw new Error('no fresh verified chain state: stand-in'); return fn(pinned(st), 998n); } });

test('verifier-authority reader: a SessionVault owner policy is admitted at one block, follows the book, and fails closed', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'owner-verifier-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { relay: 'http://127.0.0.1:9', checkers: [owner.address], apps: 'all', wgBinary: '/bin/true', nodeBinary: process.execPath, workerModule: '/bin/true' };
  const policy = { ...defaultNetworkPolicy(id), nonce: 1, issuedAt: 1 }; const envelope = await signNetworkPolicy(owner, policy);
  const host = (leaseReader) => createNetworkHost({ config, directory: fs.mkdtempSync(path.join(dir, 'h-')), addressBook: book, leaseReader, fetch: async () => Response.json({ envelope }) });
  const st = { factory, bookReads: 0, snapshots: 0, refuse: false };
  assert.deepEqual(await (await host(verifierReader(st))).policyFor({ deploymentId: id }, { id, owner: vault }), policy);
  // the directory lookup and the admission each verify the signature: every verification is ONE snapshot that read the factory
  // from the admin book at its own verified block
  assert.ok(st.snapshots >= 1); assert.equal(st.bookReads, st.snapshots, 'the factory came from the admin book at the verified block');
  st.factory = a('9');                                                          // the admin repoints the book's factory
  await assert.rejects((await host(verifierReader(st))).policyFor({ deploymentId: id }, { id, owner: vault }), /no valid owner policy/);
  st.factory = factory; st.refuse = true;                                       // stale head / missing proof
  await assert.rejects((await host(verifierReader(st))).policyFor({ deploymentId: id }, { id, owner: vault }), /no valid owner policy/);
  const before = st.snapshots;
  assert.deepEqual(await (await host(verifierReader(st))).policyFor({ deploymentId: id }, { id, owner: owner.address }), policy, 'EOA owner: no chain read');
  assert.equal(st.snapshots, before);
  // legacy (provider-quorum) reader without pins and without RPCs: contract owners refused exactly as before
  const legacy = { authority: 'quorum', agreed: async () => { throw new Error('the legacy path must not use the reader for owners'); } };
  await assert.rejects((await host(legacy)).policyFor({ deploymentId: id }, { id, owner: vault }), /no valid owner policy/);
  assert.deepEqual(await (await host(legacy)).policyFor({ deploymentId: id }, { id, owner: owner.address }), policy);
});
