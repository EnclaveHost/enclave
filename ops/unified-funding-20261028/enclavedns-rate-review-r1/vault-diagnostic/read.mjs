import fs from 'node:fs';
import {createPublicClient,http,keccak256} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {LEDGER_ABI,VAULT_ABI,LEGACY_SESSION_VAULT_FACTORY} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/network/lease-gas-owner.mjs';
const c=createPublicClient({transport:http('https://api.enclave.host/rpc/base',{retryCount:0,timeout:10000})});
const vault='0xB794C4DD0e1C5E6B72281799F282BfdE7654345D',wallet='0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
const view=(name,input,output)=>({type:'function',name,stateMutability:'view',inputs:[{type:input}],outputs:[{type:output}]});
const fab=[view('isVault','address','bool'),view('vaultFor','address','address')];
const out={capturedAt:new Date().toISOString(),readOnly:true,assurance:'Single Enclave RPC diagnostic only, not quorum-confirmed, not authority for transactions',vault,wallet};
try{
 if(await c.getChainId()!==8453)throw Error('wrong chain');
 const blockNumber=await c.getBlockNumber({cacheTime:0})-2n,block=await c.getBlock({blockNumber});
 if(Math.abs(Date.now()-Number(block.timestamp)*1000)>120000)throw Error('stale block');
 const read=(address,abi,functionName,args=[])=>c.readContract({address,abi,functionName,args,blockNumber});
 const [owner,factory,isVault,vaultFor,code,api]=await Promise.all([
  read(vault,VAULT_ABI,'owner'),read(vault,VAULT_ABI,'factory'),
  read(LEGACY_SESSION_VAULT_FACTORY.address,fab,'isVault',[vault]),read(LEGACY_SESSION_VAULT_FACTORY.address,fab,'vaultFor',[wallet]),
  c.getCode({address:LEGACY_SESSION_VAULT_FACTORY.address,blockNumber}),
  read('0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B',LEDGER_ABI,'get',['0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77'])]);
 if((await c.getBlock({blockNumber})).hash!==block.hash)throw Error('block changed');
 out.observation={blockNumber,blockHash:block.hash,owner,factory,isVault,vaultFor,factoryCodeHash:keccak256(code),expectedFactory:LEGACY_SESSION_VAULT_FACTORY,apiMcpAdapter:{owner:api.owner,rate:api.rate,runner:api.runner}};
}catch(e){out.error=e.shortMessage||e.message;process.exitCode=1;}
const s=JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2);fs.writeFileSync(new URL('./result.json',import.meta.url),s+'\n');console.log(s);
