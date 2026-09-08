import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, hkdfSync, createCipheriv } from 'node:crypto';
import { boxToPadKey } from '../relay/pads.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gg = join(root,'wasm/ggml-shielded');

test('seed boxes: allocation-free Node interoperability, tampering, and attacker-known zero-DH keys', () => {
  const dir = mkdtempSync(join(tmpdir(),'pad-seed-open-'));
  try {
    const bin = join(dir,'test');
    const cc = spawnSync('cc',['-O1','-g','-fsanitize=address,undefined','-ffunction-sections','-fdata-sections',
      '-Wall','-Wextra','-I',gg,join(root,'test/fixtures/pad-seed-open.c'),join(gg,'tweetnacl.c'),
      join(gg,'poly1305-donna.c'),'-Wl,--gc-sections','-lm','-pthread','-o',bin],{encoding:'utf8',timeout:60_000});
    assert.equal(cc.status,0,cc.stdout+cc.stderr);
    const x=generateKeyPairSync('x25519');
    const sk=x.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('hex');
    const pk=x.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
    const seed=randomBytes(32);
    const run = (b, rc) => {
      const r=spawnSync(bin,[sk,pk,b.epk,b.nonce,b.box,seed.toString('hex'),String(rc)],{encoding:'utf8',timeout:10_000});
      assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/pad-seed-open: ok/);
    };
    const good=boxToPadKey(pk,seed); run(good,0);
    for (let i=0;i<48;i++) {
      const box=Buffer.from(good.box,'hex'); box[i]^=1;
      run({...good,box:box.toString('hex')},-10);
    }
    // Craft valid AEAD boxes under the public zero-DH-derived key. A tag-only
    // rejection test would miss that TweetNaCl accepts these low-order inputs.
    for (const low of [0,1]) {
      const epk=Buffer.alloc(32); epk[0]=low;
      const key=Buffer.from(hkdfSync('sha512',Buffer.alloc(32),Buffer.concat([epk,Buffer.from(pk,'hex')]),Buffer.from('enclave-pads-seed-box'),32));
      const nonce=randomBytes(12), cipher=createCipheriv('chacha20-poly1305',key,nonce,{authTagLength:16});
      const box=Buffer.concat([cipher.update(seed),cipher.final(),cipher.getAuthTag()]);
      run({epk:epk.toString('hex'),nonce:nonce.toString('hex'),box:box.toString('hex')},-10);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
