// Offline preparation only. Identity signatures use ephemeral test keys; host authority and SNP proof are explicit fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileCapturedGenesis} from '../driver/genesis-submit.mjs';
import {captureGenesis} from '../driver/genesis-capture.mjs';
import {R2,METAL0_REGISTRY_ID,METAL0_OPERATOR,METAL0_ENDPOINT,ORIGINAL_VAULT_V2} from '../driver/plan.mjs';
import {BOOK,REVIEWED} from '../driver/clipins.mjs';
import {ADMIN} from '../driver/genesis.mjs';
const repo='/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2';
const viem=await import(pathToFileURL(repo+'/node_modules/viem/_esm/index.js').href);
const accounts=await import(pathToFileURL(repo+'/node_modules/viem/_esm/accounts/index.js').href);
const realD=await import(pathToFileURL(repo+'/custody/v2/digests.mjs').href);
const {VAULT_V2_ABI:abi}=await import(pathToFileURL(repo+'/custody/v2/chain.mjs').href);
const endpoint='https://custody-canary.enclave.host',H=x=>'0x'+x.repeat(32);
async function rig() {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'genesis-prepare-'))),key=accounts.privateKeyToAccount(accounts.generatePrivateKey());
 const machine={identity:key.address.toLowerCase(),encKey:H('34'),endpoint,chipId:H('56'),registryId:METAL0_REGISTRY_ID,measurement:R2.measurementSha256};
 const salt=H('ab'),Y='0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',codeSet=[R2.measurementSha256];
 const common={chainId:8453,vault:ORIGINAL_VAULT_V2,machine},committeeId=realD.committeeIdOf({...common,salt,Y});
 const identitySig=await realD.signDigest(key,realD.genesisDigest({...common,committeeId,Y,codeSet})),hostSig='0x'+'00'.repeat(65);
 const args=[salt,machine,Y,codeSet,identitySig,hostSig];
 assert.equal(captureGenesis({dir,endpoint,body:Buffer.from(JSON.stringify({fn:'createCommittee',args}))}).code,'canary_genesis_captured');
 const s={time:1005000,quote:{machine:{...machine},requestedAt:1000000,verifiedAt:1001000,publicEvidence:{identity:machine.identity}},committee:null,pending:null,
  facts:{blockNumber:100n,blockHash:H('cd'),blockTimestamp:1000,enclaveOwner:ADMIN,entries:{[METAL0_REGISTRY_ID]:{active:true,endpoint:METAL0_ENDPOINT,operator:METAL0_OPERATOR,owner:ADMIN,payoutWallet:ADMIN,vaultEnclave:true,ownerConflict:false}}}};
 const opts={dir,endpoint,viem,abi,now:()=>s.time,attest:async()=>s.quote,
  digests:{...realD,recoverDigest:async(d,sig)=>sig===hostSig?METAL0_OPERATOR:realD.recoverDigest(d,sig)},
  reader:{readVaultIdentity:async()=>({codeHash:REVIEWED.secretVaultV2.codeHash,enclaveOwner:ADMIN,book:BOOK}),readAuthorization:async()=>s.facts,
   readCommittee:async({committeeId:id})=>{assert.equal(id,committeeId);return {committee:s.committee,pending:s.pending};}}};
 return {s,opts,dir,machine,committeeId,identitySig,hostSig,done:()=>fs.rmSync(dir,{recursive:true})};
}
test('compiles exact captured creation only after fresh machine proof, accepted authority and both authorizations',async()=>{
 const r=await rig();try{
  const v=await compileCapturedGenesis(r.opts),call=viem.decodeFunctionData({abi,data:v.data});
  assert.equal(call.functionName,'createCommittee');assert.deepEqual({...call.args[1],identity:call.args[1].identity.toLowerCase()},r.machine);assert.equal(v.summary.committeeId,r.committeeId);
  assert.equal(v.summary.host.acceptedOwner,ADMIN);assert.equal(v.captureDigest.length,64);
  const text=JSON.stringify(v.summary);for(const privateValue of [r.machine.chipId,r.identitySig,r.hostSig,v.data])assert.ok(!text.includes(privateValue));
 }finally{r.done();}
});
test('machine substitution, unaccepted host, bad signature and existing committee all refuse before signing is possible',async()=>{
 for(const mutate of [r=>r.s.quote.machine.encKey=H('77'),r=>r.s.quote.machine.chipId=H('77'),r=>r.s.facts.entries[METAL0_REGISTRY_ID].owner='0x'+'00'.repeat(20),
  r=>r.opts.digests.recoverDigest=async()=>null,r=>r.s.committee={epoch:1},r=>r.s.pending={}]){
  const r=await rig();try{mutate(r);await assert.rejects(compileCapturedGenesis(r.opts),/refused/);}finally{r.done();}
 }
});
test('rechecks quote age after chain reads and sanitizes provider errors',async()=>{
 const r=await rig();try{
  r.opts.reader.readCommittee=async()=>{r.s.time=1120001;return {committee:null,pending:null};};
  await assert.rejects(compileCapturedGenesis(r.opts),/fresh verified quote/);
  r.s.time=1005000;r.opts.reader.readCommittee=async()=>{throw Error('private signature payload');};
  await assert.rejects(compileCapturedGenesis(r.opts),e=>!e.message.includes('private signature payload'));
 }finally{r.done();}
});
