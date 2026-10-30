// Independent acceptance tests against the frozen r2 witness, not production.
// Real EIP712 operator/witness signatures and journal; synthetic authenticated
// chain/readiness observations and deterministic clock. No network or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { DeploymentLifecycleWitness } from './network/deployment-lifecycle-witness.mjs';
import { openLifecycleJournal } from './network/deployment-lifecycle-journal.mjs';
import { openHostAuthorityJournal } from './network/deployment-host-authority-journal.mjs';
import { hostAuthorityContextOf } from './network/deployment-host-authority.mjs';
import { servingPermitTypedData, validateServingPermitContext } from './network/deployment-serving-permit.mjs';

const H = b => '0x' + b.repeat(32), A = b => '0x' + b.repeat(20);
const id = H('a2'), host = H('a1'), block = H('e1');
const pins = { chainId: 8453, lifecycle: A('c7'), servingPermit: { version: 2, profile: 'independent-host-registry-r1' } };

async function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-final-await-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const operator = privateKeyToAccount(generatePrivateKey());
  const accounts = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()));
  accounts.sort((a,b) => BigInt(a.address) < BigInt(b.address) ? -1 : 1);
  const account = accounts[0], policy = { witnesses: accounts.map(a => a.address), threshold: 3, revision: 1 };
  const context = hostAuthorityContextOf({ scope: 'host', registry: A('ab'), codeConsistent: true,
    status: 'online', online: true, generation: '1', hardwareId: H('b1'), descriptorDigest: H('b2'),
    qualificationDigest: H('b3'), resourceDigest: H('b4'), trustAnchorId: H('b5'), owner: A('1d'),
    revision: '1', policyHash: H('55'), reporters: { keys: policy.witnesses.map(a => a.toLowerCase()), threshold: 2, revision: '1' }
  }, { chainId: 8453, hostId: host, registryCodeHash: H('23') });
  let clock = 1000, reads = 0, thirdEntered = false, release;
  const held = new Promise(r => { release = r; });
  const record = { deployment: id, host, generation: 3, policyRevision: 1, sequence: 1,
    issuedAt: 1000, validUntil: 1020, hostAuthority: context };
  const snapshot = (fresh = false) => ({ policy, hostAdmitted: true,
    hostAuthority: { context, status: 'online', blockHash: block, proofVerified: true },
    assignment: { deployment: id, host, operator: operator.address, state: 'running', generation: 3,
      policyRevision: 1, admitted: !(fresh && mode === 'app-denied'), funded: true,
      authorityTier: 'finalized', proofVerified: true, observedAt: 1000,
      blockTimestamp: mode === 'readiness-extension' && !fresh ? 990 : 1000, blockHash: block } });
  const initialUntil = validateServingPermitContext(record, { ...snapshot(), pins, nowSec: clock }).serveUntil;
  const refreshedUntil = validateServingPermitContext(record, { ...snapshot(true),
    assignment: { ...snapshot(true).assignment, admitted: true }, pins, nowSec: clock }).serveUntil;
  const journal = openLifecycleJournal(path.join(dir, 'witness.json'));
  const witness = new DeploymentLifecycleWitness({ pins, account, journal, now: () => clock * 1000,
    hostAuthorityJournal: openHostAuthorityJournal(path.join(dir, 'host.json')),
    authority: { async read() { ++reads; if (reads === 3) { thirdEntered = true; await held; } return snapshot(reads === 3); } },
    health: { async verify() { return { verified: true, deployment: id, host, generation: 3,
      ready: true, validUntil: mode === 'readiness-extension' ? initialUntil : 1060 }; } }
  });
  const signature = await operator.signTypedData(servingPermitTypedData(pins, record));
  const pending = witness.permit(record, signature);
  // Attach a rejection handler immediately; the test asserts the final outcome below.
  pending.catch(() => {});
  for (let i = 0; i < 1000 && !thirdEntered; i++) await new Promise(r => setImmediate(r));
  assert.equal(thirdEntered, true, 'reached the actual THIRD authority read AFTER signing');
  if (mode === 'closed') witness.close();
  if (mode === 'fenced') witness.fence(id, 3);
  if (mode === 'expired') clock = 1021;
  release();
  return { pending, account, record, reads: () => reads, initialUntil, refreshedUntil };
}

test('positive: final read returns unchanged authority and a valid real signature', async t => {
  const w = await fixture(t, 'positive');
  const result = await w.pending;
  assert.equal(w.reads(), 3);
  assert.equal(await recoverTypedDataAddress({ ...servingPermitTypedData(pins, w.record), signature: result.signature }), w.account.address);
});
for (const mode of ['closed', 'fenced', 'expired', 'app-denied', 'readiness-extension']) {
  test(`final awaited read: ${mode} must prevent signature release`, async t => {
    const w = await fixture(t, mode);
    if (mode === 'readiness-extension') {
      assert.equal(w.initialUntil, 1010);
      assert.equal(w.refreshedUntil, 1018, 'same signed record gets a longer effective window under fresh evidence');
    }
    await assert.rejects(w.pending, undefined, `${mode}: signed response must not leave the witness`);
  });
}
