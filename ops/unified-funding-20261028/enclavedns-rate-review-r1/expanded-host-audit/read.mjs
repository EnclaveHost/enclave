import fs from 'node:fs';
import {QuorumChain,REGISTRY_SCHEMA4_ABI} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
import {LEDGER_ABI} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/network/lease-gas-owner.mjs';
const id='0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c';
const ledger='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B',registry='0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac';
const view=(name,inputs,outputs)=>({type:'function',name,stateMutability:'view',inputs:inputs.map(type=>({type})),outputs:outputs.map(type=>({type}))});
const lab=[...LEDGER_ABI,view('feeOf',['bytes32'],['address','uint256']),view('rateFor',['bytes32','bytes32'],['uint256']),view('deploymentsSchema',[],['uint256'])];
const rab=[...REGISTRY_SCHEMA4_ABI,view('idAt',['uint256'],['bytes32'])];
const q=new QuorumChain({rpcs:['https://api.enclave.host/rpc/base','https://1rpc.io/base','https://mainnet.base.org'],quorum:2,timeoutMs:10000});
const expectedPayoutWallet='0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
const out={expectedPayoutWallet,capturedAt:new Date().toISOString(),readOnly:true,id,ledger,registry,scope:'Public exact deployment and all registry hosts (maximum 32) with expected payout-wallet comparisons and host-specific pricing at one quorum block. No signatures, sends, config fetches or funds. Canonical observation, not finality.'};
try{out.snapshot=await q.snapshot(async(c,blockNumber)=>{
 const l=(functionName,args=[])=>c.readContract({address:ledger,abi:lab,functionName,args,blockNumber});
 const r=(functionName,args=[])=>c.readContract({address:registry,abi:rab,functionName,args,blockNumber});
 const [d,fee,cap,ledgerSchema,registrySchema,count]=await Promise.all([l('get',[id]),l('feeOf',[id]),l('capOf',[id]),l('deploymentsSchema'),r('registrySchema'),r('count')]);
 if(registrySchema!==4n||count>32n)throw Error('Registry outside reviewed schema/count bound');
 const hosts=[];
 for(let i=0n;i<count;i++){
  const hostId=await r('idAt',[i]);
  const e=await r('get',[hostId]);
  {
   hosts.push({hostId,endpoint:e.endpoint,active:e.active,payoutWallet:e.payoutWallet,payoutMatchesExpected:e.payoutWallet.toLowerCase()===expectedPayoutWallet.toLowerCase(),ownerMatches:e.payoutWallet.toLowerCase()===d.owner.toLowerCase(),rateFor:await l('rateFor',[id,hostId]),isStoredRunner:hostId.toLowerCase()===d.runner.toLowerCase()});
  }
 }
 return {ledgerSchema,registrySchema,count,deployment:{owner:d.owner,active:d.active,storedRate:d.rate,cap,fee,runner:d.runner,leaseUntil:d.leaseUntil,appRef:d.appRef},hosts};
});}catch(e){out.error={message:e.message,failures:e.failures??null};process.exitCode=1;}
const text=JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2);fs.writeFileSync(new URL('./result.json',import.meta.url),text+'\n');console.log(text);
