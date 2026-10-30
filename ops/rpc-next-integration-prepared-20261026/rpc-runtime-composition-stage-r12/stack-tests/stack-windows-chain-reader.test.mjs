// r7 REGRESSION (root-composition-r6-0206): the composed Windows node's chain reader must link against the REGENERATED host
// admission bundle, and select its chain authority explicitly with no provider fallback. Real modules; recorded boundary.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as bundle from '../windows/node/host-admission.bundle.mjs';
import * as entry from '../network/host-admission-node.mjs';
import { chainAuthorityOf, chainReader } from '../windows/node/chain-reader.mjs';
import { recorder } from './helpers-recorder.mjs';
const P = await recorder('public-rpc'); after(() => P.close());
const importedFromBundle = (rel) => {
  const t = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'); const out = [];
  for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/host-admission\.bundle\.mjs["']/g))
    out.push(...m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  return out;
};
test('every name the Windows chain modules import from the admission bundle is exported by the bundle AND its source entry', () => {
  const need = [...new Set([...importedFromBundle('../windows/node/chain-reader.mjs'), ...importedFromBundle('../windows/node/chain.mjs')])];
  for (const n of ['chainVerifierFromEnv', 'verifiedStateReader', 'transactionRpcsFromEnv', 'verifiedSnapshot', 'verifiedStateClient']) assert.ok(need.includes(n), `importers still name ${n}`);
  for (const n of need) { assert.ok(n in bundle, `regenerated bundle exports ${n}`); assert.ok(n in entry, `source entry exports ${n}`); }
  assert.equal(typeof bundle.createHostServiceGate, 'function', 'the admission gate export is unchanged');
});
test('explicit authority only: quorum by default, the local verifier only when selected, ambiguity and remote URLs refused', () => {
  assert.deepEqual(chainAuthorityOf({}), { authority: 'provider-quorum' });
  const v = chainAuthorityOf({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:28590/' });
  assert.equal(v.authority, 'local-verifier'); assert.equal(v.tier, 'unsafe');
  assert.throws(() => chainAuthorityOf({ ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:28590/' }));
  assert.throws(() => chainAuthorityOf({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://verifier.example/' }));
  assert.throws(() => chainAuthorityOf({ ENCLAVE_CHAIN_AUTHORITY: 'public' }));
});
test('with the verifier selected the reader is the verified LeaseReader and the configured public RPC is never contacted', async () => {
  const r = await chainReader({ rpcs: [P.url, P.url.replace('127.0.0.1', 'localhost')], env: { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:28590/' } });
  assert.ok(r instanceof bundle.LeaseReader, 'a verified-state LeaseReader from the admission bundle');
  assert.deepEqual(P.calls, [], 'no request reached the public RPC');
});
