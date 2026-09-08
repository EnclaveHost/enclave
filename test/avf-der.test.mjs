import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyAvfEvidence} from '../relay/avf-verify.mjs';
import {haveOpenssl, tmpdir, makeCa, issueLeaf, seq, octet, utf8, integer, CHALLENGE, CODE, AUTH} from './fixtures/avf-synthetic.mjs';

test('AVF DER parser bounds parent extents and refuses ambiguous security fields', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('./fixtures/avf-der-malformed.mjs',import.meta.url))],
    {encoding:'utf8',timeout:3000});
  assert.match(out,/avf-der-malformed: PASS/);
});

test('a valid synthetic certificate signature cannot turn an empty AVF security flag into true',
  {skip:!haveOpenssl && 'openssl not installed'}, () => {
  const dir = tmpdir('avf-der-signed-');
  try {
    const ca = makeCa(dir);
    const components = seq(seq(utf8('apk:host.enclave.anchor.avf'),integer(1),octet(CODE),octet(AUTH)));
    const leaf = issueLeaf(dir,{ext:seq(octet(CHALLENGE),Buffer.from([1,0]),components)});
    const evidence = {chain:[leaf.leaf,ca.inter,ca.root],challenge:CHALLENGE,signature:leaf.sign(CHALLENGE),signedMessage:CHALLENGE};
    const result = verifyAvfEvidence(evidence,{rootPins:[ca.rootPin],allowedCodeHashes:[CODE.toString('hex')],allowedAuthorityHashes:[AUTH.toString('hex')]});
    assert.equal(result.ok,false); assert.match(result.reasons.at(-1),/BOOLEAN/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
