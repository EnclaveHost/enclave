// Where the Windows node's proof key is (windows/node/chain.mjs): this process's file, or a capacity partition's memory.
// Once a partition's key is expected, the file key is never the box's proof key again, even while the partition is down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recoverTypedDataAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import * as chain from '../windows/node/chain.mjs';
import {reportMessage} from '../network/proof-of-capacity.mjs';

const H = b => '0x' + b.repeat(32);
const message = reportMessage({chainId: 8453, contract: '0x00000000000000000000000000000000000c0ffe'}, {epoch: 1, checker: H('a1'), target: H('b2'), verdict: 1, seed: H('01'), evidence: H('02')});

test('the proof key is the file\'s until a partition\'s is expected; then only the partition\'s, and nothing while it is unknown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-signer-')), file = path.join(dir, 'proof.key');
  try {
    const fileAddress = chain.newProofKey(file);
    assert.equal(chain.proofAddress(), fileAddress); assert.equal(chain.proofKeyIn(), 'host-process'); assert.equal(chain.proofKeyPending(), false);
    assert.equal(await recoverTypedDataAddress({...message, signature: await chain.proofSign(message)}), fileAddress);

    chain.expectProofSigner();
    assert.equal(chain.proofAddress(), null); assert.equal(chain.proofKeyPending(), true); assert.equal(chain.proofKeyIn(), 'shield-partition');
    assert.throws(() => chain.proofSign(message), /capacity partition's proof key is not known yet/);

    const partition = privateKeyToAccount(generatePrivateKey()), asked = [];
    chain.setProofSigner({address: partition.address, sign: m => { asked.push(m.primaryType); return partition.signTypedData(m); }});
    assert.equal(chain.proofAddress(), partition.address); assert.equal(chain.proofKeyPending(), false);
    assert.equal(await recoverTypedDataAddress({...message, signature: await chain.proofSign(message)}), partition.address);
    assert.deepEqual(asked, ['CapacityReport']);

    chain.setProofSigner(null);     // the partition is down or was restarted: no key, never the file's
    assert.equal(chain.proofAddress(), null); assert.equal(chain.proofKeyPending(), true);
    assert.throws(() => chain.proofSign(message), /not known yet/);
    assert.throws(() => chain.setProofSigner({address: 'x', sign() {}}), /has an address and signs/);
    assert.throws(() => chain.setProofSigner({address: partition.address}), /has an address and signs/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
