import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {assessMigrationInventory,readMigrationPreflight} from '../network/deployment-migration-preflight.mjs';
const A=n=>'0x'+n.toString(16).padStart(40,'0'),H=n=>'0x'+n.toString(16).padStart(64,'0');
const base=()=>({id:H(9),source:{schema:16,rowId:H(9),exists:true,active:true,owner:A(8),appRef:'catalog://test/1',runner:H(0),runnerOperator:A(0),leaseUntil:0n,rate6:0n,balance6:0n,spent6:12n,publisherRecipient:A(0),publisherFee6:0n,runnerRate6:0n,escrow6:0n,ownerEscrow6:0n,refundable6:0n,capRate6:14n,gasReserveWei:200n},intendedHost:{active:true,operator:A(7)},destination:{ledger:A(4),controller:A(5),schema:17,lifecycleSchema:2,pairMatches:true,importsSealed:false,exists:false,ownerPrincipal:A(8),hostPrincipal:A(8)},gasAdapter:{ledger:A(1),reserve:A(2)}});
test('zero-balance candidate preserves economic identity but is never executable',()=>{
 const r=assessMigrationInventory(base());assert.equal(r.status,'zero-balance-canary-review');assert.equal(r.executable,false);assert.equal(r.preserved.capRate6,14n);assert.equal(r.preserved.spent6,12n);
 assert.ok(r.obligations.some(x=>x.code==='old-gas-reserve'));assert.ok(r.obligations.some(x=>x.code==='funding-incompatible'));assert.ok(r.obligations.some(x=>x.code==='activation-evidence'));
 assert.ok(r.obligations.some(x=>x.code==='host-offline-authority'));assert.ok(r.obligations.some(x=>x.code==='app-emergency-stop'));
 assert.ok(r.obligations.some(x=>x.code==='host-bootstrap-budget'));
});
test('expired but attached legacy assignment cannot be imported',()=>{
 const v=base();v.source.runner=H(3);v.source.runnerOperator=A(7);v.source.leaseUntil=1n;
 assert.ok(assessMigrationInventory(v).blockers.some(x=>x.code==='legacy-assignment'));
});
test('each nonzero financial component refuses blind accounting import',()=>{
 for(const key of ['rate6','balance6','publisherFee6','runnerRate6','escrow6','ownerEscrow6','refundable6']){
  const v=base();v.source[key]=1n;assert.ok(assessMigrationInventory(v).blockers.some(x=>x.code==='financial-conservation'),key);
 }
});
test('serialized zero amounts work without allowing negative, unsafe numeric or missing amounts',()=>{
 const v=base();v.source.balance6='0';assert.equal(assessMigrationInventory(v).status,'zero-balance-canary-review');
 for(const value of [-1n,0,undefined,'00','-1']){v.source.balance6=value;assert.throws(()=>assessMigrationInventory(v),/invalid balance6/);}
});
test('disabled source and inactive host cannot be activated as a migration side effect',()=>{
 const v=base();v.source.active=false;v.intendedHost.active=false;
 assert.deepEqual(assessMigrationInventory(v).blockers.map(x=>x.code),['host-unavailable','source-disabled']);
});
test('missing or malformed intended host operator holds admission',()=>{
 for(const operator of [undefined,null,'',A(0),'0x1234']){const v=base();v.intendedHost.operator=operator;assert.ok(assessMigrationInventory(v).blockers.some(x=>x.code==='host-unavailable'));}
});
test('missing, already imported, sealed or wrongly paired destination holds',()=>{
 for(const change of [v=>v.destination=null,v=>v.destination.exists=true,v=>v.destination.importsSealed=true,v=>v.destination.pairMatches=false,v=>v.destination.schema=16]){
  const v=base();change(v);assert.equal(assessMigrationInventory(v).status,'hold');
 }
});
test('host payout must resolve to same nonzero principal, not an arbitrary owner getter',()=>{
 const v=base();v.destination.hostPrincipal=A(12);assert.ok(assessMigrationInventory(v).blockers.some(x=>x.code==='selfhost-identity'));
 v.destination.ownerPrincipal=A(0);v.destination.hostPrincipal=A(0);assert.equal(assessMigrationInventory(v).status,'hold');
});
function world({proof=true,badCode=false,badBinding=false,failRead=false}={}){
 const calls=[],code='0x60006000',p=n=>({address:A(n),codeHash:keccak256(code)});
 const pins={chainId:8453,source:{ledger:p(1),reserve:p(2),registry:p(3)},destination:{ledger:p(4),controller:p(5),identity:p(6)},gasAdapter:p(10)};
 const source=base().source;
 const d={id:H(9),createdAt:1n,owner:source.owner,active:true,appRef:source.appRef,runner:H(0),runnerOperator:A(0),leaseUntil:0n,rate:0n,balance6:0n,spent6:12n};
 const c={getCode:async x=>{calls.push(x);return badCode?'0x6001':code;},readContract:async x=>{
  calls.push(x);if(failRead)throw Error('reader unavailable');const {address:a,functionName:f}=x;
  if(f==='get'&&a===A(1))return d;
  if(f==='get'&&a===A(4))return {...d,createdAt:0n};
  if(f==='get'&&a===A(3))return {operator:A(7),payoutWallet:A(8),active:true};
  if(f==='deploymentsSchema')return a===A(1)?16n:17n;
  if(f==='registry')return A(3);
  if(f==='feeOf')return [A(0),0n];if(f==='earnOf')return [0n,0n,0n];
  if(['ownerEscrow6','refundableOf'].includes(f))return 0n;
  if(f==='capOf')return 14n;if(f==='reserveOf')return {balanceWei:200n};
  if(f==='ledger')return a===A(5)?A(4):badBinding?A(99):A(1);
  if(f==='reserve')return A(2);if(f==='lifecycleSchema')return 2n;
  if(f==='lifecycleController')return A(5);if(f==='selfHostingIdentity')return A(6);
  if(f==='importsSealed')return false;if(f==='principal')return A(8);
  throw Error('unexpected call '+f);
 }};
 const snapshot=async fn=>({value:await fn(c,100n),blockNumber:100n,blockHash:H(100),timestamp:100000,evidence:{proofVerified:proof,tier:proof?'l1-finalized-derived':'safe'}});
 return {pins,snapshot,id:H(9),intendedHost:H(3),calls};
}
test('collector pins every code and contract read to supplied block and returns no transaction data',async()=>{
 const w=world(),r=await readMigrationPreflight(w);assert.equal(r.assessment.status,'zero-balance-canary-review');assert.equal(r.executable,false);
 assert.ok(w.calls.length>20);assert.ok(w.calls.every(x=>x.blockNumber===100n));assert.equal(r.inventory.source.owner,A(8));assert.equal(r.inventory.gasAdapter.reserve,A(2));
});
test('ordinary RPC labels cannot substitute for authenticated lifecycle snapshot',async()=>{
 await assert.rejects(readMigrationPreflight(world({proof:false})),/authenticated in-domain/);
});
test('actual deployed code and authority bindings are checked, not template hashes alone',async()=>{
 await assert.rejects(readMigrationPreflight(world({badCode:true})),/deployed code differs/);
 await assert.rejects(readMigrationPreflight(world({badBinding:true})),/binding differs/);
});
test('read failure propagates with no fallback, output or send',async()=>{
 await assert.rejects(readMigrationPreflight(world({failRead:true})),/reader unavailable/);
});
test('incomplete pins and source equal destination refuse before chain work',async()=>{
 const w=world();w.pins.source.ledger.codeHash=H(0);await assert.rejects(readMigrationPreflight(w),/code pin required/);assert.equal(w.calls.length,0);
 const z=world();z.pins.destination.ledger=z.pins.source.ledger;await assert.rejects(readMigrationPreflight(z),/must differ/);assert.equal(z.calls.length,0);
});
