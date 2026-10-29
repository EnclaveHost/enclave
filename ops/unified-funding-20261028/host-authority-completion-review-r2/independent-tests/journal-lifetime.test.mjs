// Independent requirements, actual file/lock implementations, owned TEST files.
// Synthetic host contexts; no chain, network, production journal or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLockedHostAuthorityJournal } from './network/deployment-host-authority-journal.mjs';
import { openLockedHostIncarnationJournal } from './network/lifecycle-host-incarnation-journal.mjs';
import { hostAuthorityContextOf } from './network/deployment-host-authority.mjs';
import { hostIncarnationOf } from './network/lifecycle-host-profile.mjs';
const H=b=>'0x'+b.repeat(32), A=b=>'0x'+b.repeat(20), host=H('a1');
const base=g=>({ scope:'host', registry:A('ab'), codeConsistent:true, status:'online', online:true,
  generation:String(g), hardwareId:H('b1'),descriptorDigest:H('b2'),qualificationDigest:H('b3'),
  resourceDigest:H('b4'),trustAnchorId:H('b5'),owner:A('1d'),revision:'1',policyHash:H('55'),
  reporters:{keys:[A('11'),A('22'),A('33')],threshold:2,revision:'1'} });
const opts={chainId:8453,hostId:host,registryCodeHash:H('23')};
const types=[
  {name:'permit authority', open:(f,o)=>openLockedHostAuthorityJournal(f,o),
   read:j=>j.read(host), write:(j,g)=>j.accept(host,hostAuthorityContextOf(base(g),opts))},
  {name:'dispatch incarnation', open:(f,o)=>openLockedHostIncarnationJournal({readHostAuthority:()=>null},f,o),
   read:j=>j.readHostIncarnation(host),write:(j,g)=>j.acceptHostIncarnation(host,hostIncarnationOf(base(g),opts))}
];
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'ha-lifetime-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return path.join(d,'journal.json');}
for(const type of types){
  for(const operation of ['read','write']) test(`${type.name}: released handle cannot ${operation} while the new writer owns the lock`,async t=>{
    const f=temp(t),first=await type.open(f);t.after(()=>first.release());type.write(first.journal,1);
    first.release();
    const second=await type.open(f);t.after(()=>second.release());assert.ok(type.read(second.journal),'new writer opens existing evidence');
    const bytes=fs.readFileSync(f,'utf8');
    assert.throws(()=>operation==='read'?type.read(first.journal):type.write(first.journal,2),undefined,'released handles must be permanently unusable');
    assert.equal(fs.readFileSync(f,'utf8'),bytes,'released writer changed no evidence');
  });
  test(`${type.name}: reopening does not erase uncertainty after rename and failed directory fsync`,async t=>{
    const f=temp(t);let fail=false;
    const fsImpl={...fs,fsyncSync(fd){if(fail&&fs.fstatSync(fd).isDirectory())throw Error('owned injected directory fsync failure');return fs.fsyncSync(fd);}};
    const first=await type.open(f,{fsImpl});t.after(()=>first.release());type.write(first.journal,1);fail=true;
    assert.throws(()=>type.write(first.journal,2),/injected|uncertain/);fail=false;
    assert.throws(()=>type.read(first.journal),/uncertain/,'current writer correctly latches');first.release();
    const second=await type.open(f);t.after(()=>second.release());
    assert.throws(()=>type.read(second.journal),undefined,'fresh process/handle alone is not explicit verified persistence recovery');
  });
}
