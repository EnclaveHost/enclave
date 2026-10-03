import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {encodeEventTopics,encodeAbiParameters} from 'viem';
import {collectLedgerWindow} from '../availability/chain-observation.mjs';
const load=n=>JSON.parse(fs.readFileSync(new URL(`../contracts/${n}.abi.json`,import.meta.url)));
const d=load('EnclaveDeployments'),p=load('EnclaveProofOfTime');
const ledger='0x'+'11'.repeat(20),proof='0x'+'22'.repeat(20),availability='0x'+'33'.repeat(20),id='0x'+'44'.repeat(32),host='0x'+'55'.repeat(32),owner='0x'+'66'.repeat(20),operator='0x'+'77'.repeat(20);
const entry={id,runner:host,runnerOperator:operator,owner,appRef:'catalog://customer/0',cpuMilli:500,gpuMilli:0,active:true,leaseUntil:1100n,balance6:1000n};
const event=(abi,address,name,args,index)=>({address,blockNumber:9n,blockHash:'0x'+'99'.repeat(32),transactionHash:'0x'+'88'.repeat(32),logIndex:index,
 topics:encodeEventTopics({abi,eventName:name,args}),data:encodeAbiParameters(abi.find(e=>e.type==='event'&&e.name===name).inputs.filter(i=>!i.indexed),abi.find(e=>e.type==='event'&&e.name===name).inputs.filter(i=>!i.indexed).map(i=>args[i.name]))});
const credit=()=>event(d,ledger,'RunnerCredited',{id,operator,amount6:500n,secondsCredited:50n},0);
const checkpoint=()=>event(p,proof,'Checkpointed',{id,enclaveId:host,operator,provenUntil:950n,secondsProven:50n,anchorBlock:8n},1);
function setup({logs=[credit(),checkpoint()],funded=false,archiveFailure=false}={}){
 const client={getBlock:async({blockNumber=10n})=>({number:blockNumber,hash:'block'+blockNumber,timestamp:blockNumber*100n}),getCode:async()=> '0x01',getLogs:async()=>logs,
 readContract:async({functionName,blockNumber})=>{
  if(archiveFailure&&blockNumber===7n)throw new Error('archive unavailable');
  return {ledger,prover:proof,proofRequired:true,getPage:[entry],earnOf:[10n,1000n,900n],fundedJob:funded}[functionName];
 }};
 return {client,ledger,proof,availability,windowSec:200n,classId:'cpu'};
}
test('replays actual checkpoint ABI into normalized paid intervals',async()=>{
 const out=await collectLedgerWindow(setup());assert.equal(out.services.length,1);
 assert.deepEqual([out.services[0].startSec,out.services[0].endSec,out.services[0].shareMilli],[900n,950n,500n]);
 assert.equal(out.services[0].hostId,host);assert.equal(out.checkpoint.fromBlock,8n);
});
test('unproven credits and verification jobs cannot create demand',async()=>{
 assert.equal((await collectLedgerWindow(setup({logs:[credit()]}))).services.length,0);
 assert.equal((await collectLedgerWindow(setup({funded:true}))).services.length,0);
 assert.equal((await collectLedgerWindow({...setup(),knownVerificationAppRefs:[entry.appRef]})).services.length,0);
});
test('archive failure and proof-policy changes fail closed',async()=>{
 await assert.rejects(collectLedgerWindow(setup({archiveFailure:true})),/archive/);
 const change=event(d,ledger,'ProofRequiredFromSet',{at:900n},0);
 await assert.rejects(collectLedgerWindow(setup({logs:[change]})),/policy changed/);
});

import {privateKeyToAccount} from 'viem/accounts';
import {receiptData} from '../availability/evidence.mjs';
import {createObservationLoader} from '../availability/observation.mjs';
const witnesses=[1,2].map(i=>privateKeyToAccount('0x'+String(i).padStart(64,'0')));
const trust={chainId:8453,contract:availability,quorum:2,signers:Object.fromEntries(witnesses.map((a,i)=>[a.address.toLowerCase(),'group'+i]))};
async function observation(payloadChanges={},registryChanges={}){
 const payload={kind:'capacity',hostId:host,hardwareId:'0x'+'ab'.repeat(32),operator,payoutWallet:operator,classId:'cpu',issuedSec:'700',expiresSec:'1200',spareAtSec:'1000',units:'100',spareUnits:'50',minimumRate6:'0',...payloadChanges};
 const envelope={payload,signatures:await Promise.all(witnesses.map(a=>a.signTypedData(receiptData(payload,trust))))};
 return createObservationLoader({chain:setup(),trust,loadReceipts:async()=>[envelope],resolveHost:async()=>({active:true,operator,payoutWallet:operator,...registryChanges}),now:()=>1000n,
  limits:{maxReceipts:10,maxSpareAgeSec:30n,maxUnitsPerHost:1000n,anchorRate6:10n,maxQueuedUnits:10000n,maxDemandPerOwnerUnits:10000n}})();
}
test('quorum capacity and finalized paid service compose into market observation',async()=>{
 const o=await observation();assert.equal(o.qualifiedSupplyUnits,20000n);assert.equal(o.completedDemandUnits,2500n);assert.equal(o.hosts[0].spareUnits,50n);
});
test('signed capacity still needs matching registry identity and fresh spare evidence',async()=>{
 await assert.rejects(observation({}, {operator:owner}),/registry mismatch/);
 assert.equal((await observation({spareAtSec:'900'})).qualifiedSupplyUnits,0n);
 assert.equal((await observation({units:'1001'})).qualifiedSupplyUnits,0n);
});
