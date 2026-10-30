import fs from 'node:fs';
import {createPublicClient,http,keccak256,parseAbi,encodeFunctionData} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
import {LEDGER_ABI,OWNER_ABI,VAULT_ABI,LEGACY_SESSION_VAULT_FACTORY} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/network/lease-gas-owner.mjs';
const ledger='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B',reserve='0x12A3f873041Dec436DaA0085B766a399A6fA3639',wallet='0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
const extra=parseAbi(['function count() view returns(uint256)','function deploymentsSchema() view returns(uint256)','function ownerEscrow6(bytes32) view returns(uint256)','function refundableOf(bytes32) view returns(uint256)','function earnOf(bytes32) view returns(uint256,uint256,uint64)','function feeOf(bytes32) view returns(address,uint256)','function transferDeployment(bytes32,address)','function book() view returns(address)','function deployments() view returns(address)','function isVault(address) view returns(bool)','function vaultFor(address) view returns(address)']);
const get=LEDGER_ABI.find(x=>x.name==='get');
const lab=[...LEDGER_ABI,...extra,{type:'function',name:'getPage',stateMutability:'view',inputs:[{type:'uint256'},{type:'uint256'}],outputs:[{type:'tuple[]',components:get.outputs[0].components}]}];
const mode=process.argv[2];if(!['quorum','diagnostic'].includes(mode))throw Error('explicit assurance mode required');
const out={capturedAt:new Date().toISOString(),mode,readOnly:true,ledger,reserve,wallet,scope:'Complete bounded ledger enumeration, known legacy-vault classification and public balances. No sends, signatures, private config or secret payloads. Unknown contract owners retained for further classification. Eth_call simulation does not execute a transaction.'};
async function observe(c,blockNumber){
 const r=(a,abi,functionName,args=[])=>c.readContract({address:a,abi,functionName,args,blockNumber});
 const [count,schema,lc,rc,fc]=await Promise.all([r(ledger,lab,'count'),r(ledger,lab,'deploymentsSchema'),c.getCode({address:ledger,blockNumber}),c.getCode({address:reserve,blockNumber}),c.getCode({address:LEGACY_SESSION_VAULT_FACTORY.address,blockNumber})]);
 if(count>512n||schema!==16n)throw Error('count/schema outside reviewed bound');
 if(keccak256(fc)!==LEGACY_SESSION_VAULT_FACTORY.codeHash)throw Error('legacy factory code mismatch');
 const rows=[];
 for(let i=0n;i<count;i+=32n)rows.push(...await r(ledger,lab,'getPage',[i,32n]));
 if(BigInt(rows.length)!==count||new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('incomplete/duplicate enumeration');
 const owners=[];
 for(const owner of [...new Set(rows.map(d=>d.owner.toLowerCase()))]){
  const [code,known]=await Promise.all([c.getCode({address:owner,blockNumber}),r(LEGACY_SESSION_VAULT_FACTORY.address,extra,'isVault',[owner])]);
  const info={owner,codeHash:code?keccak256(code):null,classification:owner===wallet.toLowerCase()?'target-wallet':code&&code!=='0x'?'unclassified-contract':'externally-owned-account'};
  if(known){
   const [controllingWallet,factory,book]=await Promise.all([r(owner,VAULT_ABI,'owner'),r(owner,VAULT_ABI,'factory'),r(owner,extra,'book')]);
   const [vaultFor,resolvedLedger]=await Promise.all([r(factory,extra,'vaultFor',[controllingWallet]),r(book,extra,'deployments')]);
   if(factory.toLowerCase()!==LEGACY_SESSION_VAULT_FACTORY.address.toLowerCase()||vaultFor.toLowerCase()!==owner)throw Error('vault provenance mismatch');
   Object.assign(info,{classification:'recognized-legacy-session-vault',controllingWallet,factory,book,resolvedLedger,matchesUser:controllingWallet.toLowerCase()===wallet.toLowerCase()});
  }
  owners.push(info);
 }
 const vaultApps=[];
 for(const d of rows){
  const o=owners.find(o=>o.owner===d.owner.toLowerCase());if(o.classification!=='recognized-legacy-session-vault')continue;
  const [ownerEscrow6,earn,refundable6,cap,fee,oldReserve,newReserve]=await Promise.all([r(ledger,lab,'ownerEscrow6',[d.id]),r(ledger,lab,'earnOf',[d.id]),r(ledger,lab,'refundableOf',[d.id]),r(ledger,lab,'capOf',[d.id]),r(ledger,lab,'feeOf',[d.id]),r(reserve,OWNER_ABI,'reserveOf',[d.id,d.owner]),r(reserve,OWNER_ABI,'reserveOf',[d.id,o.controllingWallet])]);
  let transferSimulation;
  try{await c.call({account:o.controllingWallet,to:d.owner,data:encodeFunctionData({abi:VAULT_ABI,functionName:'ownerCall',args:[ledger,encodeFunctionData({abi:lab,functionName:'transferDeployment',args:[d.id,o.controllingWallet]})]}),blockNumber});transferSimulation={ok:true};}
  catch(e){transferSimulation={ok:false,message:String(e.shortMessage||e.message).slice(0,600)};}
  vaultApps.push({deployment:d,controllingWallet:o.controllingWallet,matchesUser:o.matchesUser,ownerEscrow6,earn,refundable6,cap,fee,oldReserve,newReserve,escrowGateClear:ownerEscrow6===0n||earn[1]===0n,transferSimulation});
 }
 return {count,schema,ledgerCodeHash:keccak256(lc),reserveCodeHash:keccak256(rc),factoryCodeHash:keccak256(fc),owners,rows,vaultApps};
}
try{
 if(mode==='quorum'){
  const q=new QuorumChain({rpcs:['https://api.enclave.host/rpc/base','https://base-mainnet.public.blastapi.io','https://base-rpc.publicnode.com'],quorum:2,timeoutMs:10000});
  out.assurance='Two-provider consistent block observation, not finality or full migration readiness';out.snapshot=await q.snapshot(observe);
 }else{
  out.assurance='Single Enclave-operated RPC diagnostic ONLY, not independent confirmation or transaction authority';
  const c=createPublicClient({transport:http('https://api.enclave.host/rpc/base',{timeout:10000,retryCount:0})});
  if(await c.getChainId()!==8453)throw Error('wrong chain');
  const blockNumber=await c.getBlockNumber({cacheTime:0})-2n,b=await c.getBlock({blockNumber});
  if(Math.abs(Date.now()-Number(b.timestamp)*1000)>120000)throw Error('stale block');
  const value=await observe(c,blockNumber);
  if((await c.getBlock({blockNumber})).hash!==b.hash)throw Error('block replaced');
  out.snapshot={blockNumber,blockHash:b.hash,timestamp:b.timestamp,value};
 }
}catch(e){out.error={message:String(e.shortMessage||e.message).slice(0,1500),failures:e.failures??null};process.exitCode=1;}
fs.writeFileSync(new URL(`./${mode}-result.json`,import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({mode,error:out.error,count:out.snapshot?.value.count?.toString(),owners:out.snapshot?.value.owners,vaultApps:out.snapshot?.value.vaultApps.length},(_,v)=>typeof v==='bigint'?v.toString():v));
