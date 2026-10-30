// Actual frozen chain.mjs serialization/send/helpers. TEST public account, inert RPC/wallet doubles; no network/signing/transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const url=new URL('./candidate/control/windows/node/chain.mjs',import.meta.url);
const state={writes:[],simulate:async()=>{},nonce:0,writeError:false};globalThis.__r10SendBoundary=state;
const modules={
 viem:`const s=globalThis.__r10SendBoundary;
 export const createPublicClient=()=>({simulateContract:(o)=>s.simulate(o),getTransactionCount:async()=>s.nonce,waitForTransactionReceipt:async()=>({status:'success'})});
 export const createWalletClient=()=>({writeContract:async(o)=>{s.writes.push(o.functionName);if(s.writeError)throw Error('TEST broadcast response lost');return '0x'+'ab'.repeat(32);}});
 export const http=()=>null,fallback=()=>null,keccak256=()=>null,toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
 'viem/accounts':`export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account; no signer'});`,
 'viem/chains':'export const base={id:8453};',
 './host-admission.bundle.mjs':'export const loadContractPins=()=>null;',
 './waf.mjs':'export const parseWaf=()=>({});',
 './verification-checkpoints.mjs':'export const planCheckpoints=()=>[];',
 './lease-gas-runtime.bundle.mjs':`export const leaseGasConfigured=()=>false,loadLeaseGasConfig=()=>{throw Error('TEST no sponsored path');},configuredLeaseSender=()=>{throw Error('TEST no sponsored path');},openReleaseJournal=()=>null;`,
};
const hooks=registerHooks({resolve(spec,ctx,next){
 if(ctx.parentURL?.split('?')[0]!==url.href||!Object.hasOwn(modules,spec))return next(spec,ctx);
 return {url:'data:text/javascript;base64,'+Buffer.from(modules[spec]).toString('base64'),shortCircuit:true};
}});
const prior=process.env.NODE_OPERATOR_KEY;process.env.NODE_OPERATOR_KEY='0x'+'11'.repeat(32);
const chain=await import(url.href);chain.loadOperator();
if(prior===undefined)delete process.env.NODE_OPERATOR_KEY;else process.env.NODE_OPERATOR_KEY=prior;
const dep='0x'+'22'.repeat(32),host='0x'+'33'.repeat(32);
chain.addresses.deployments='0x'+'44'.repeat(20);
test('ROOT restart reconstruction must retain an unresolved attempted write and refuse another inert broadcast',async()=>{
 state.nonce=0;state.writes=[];state.writeError=true;
 await assert.rejects(chain.renewDeployment(dep,{gate:()=>null}),e=>e.unknownOutcome===true);
 assert.deepEqual(state.writes,['renew']);
 await assert.rejects(chain.renewDeployment(dep,{gate:()=>null}),e=>e.code==='AmbiguousPriorWrite');
 assert.deepEqual(state.writes,['renew'],'same loaded sender retains unknown');
 // New module instance models loss of module memory at restart; same public TEST identity/RPC count, no OS process/crash or live key.
 const previous=process.env.NODE_OPERATOR_KEY;process.env.NODE_OPERATOR_KEY='0x'+'11'.repeat(32);
 let restarted;try {restarted=await import(url.href+'?ROOT-restart');restarted.loadOperator();}
 finally {if(previous===undefined)delete process.env.NODE_OPERATOR_KEY;else process.env.NODE_OPERATOR_KEY=previous;}
 restarted.addresses.deployments='0x'+'44'.repeat(20);
 state.writeError=false;
 await restarted.renewDeployment(dep,{gate:()=>null}).catch(()=>{});
 assert.deepEqual(state.writes,['renew'],'fresh sender must recover attempted-write quarantine before allowing any new inert broadcast');
});
test.after(()=>{hooks.deregister();delete globalThis.__r10SendBoundary;});
