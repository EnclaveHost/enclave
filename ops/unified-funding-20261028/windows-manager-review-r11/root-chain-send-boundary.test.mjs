// Actual frozen chain.mjs serialization/send/helpers. TEST public account, inert RPC/wallet doubles; no network/signing/transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const url=new URL('./candidate/control/windows/node/chain.mjs',import.meta.url);
const state={writes:[],simulate:async()=>{},nonce:0};globalThis.__r10SendBoundary=state;
const modules={
 viem:`const s=globalThis.__r10SendBoundary;
 export const createPublicClient=()=>({simulateContract:(o)=>s.simulate(o),getTransactionCount:async()=>s.nonce,waitForTransactionReceipt:async()=>({status:'success'})});
 export const createWalletClient=()=>({writeContract:async(o)=>{s.writes.push(o.functionName);return '0x'+'ab'.repeat(32);}});
 export const http=()=>null,fallback=()=>null,keccak256=()=>null,toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
 'viem/accounts':`export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account; no signer'});`,
 'viem/chains':'export const base={id:8453};',
 './host-admission.bundle.mjs':'export const loadContractPins=()=>null;',
 './waf.mjs':'export const parseWaf=()=>({});',
 './verification-checkpoints.mjs':'export const planCheckpoints=()=>[];',
 './lease-gas-runtime.bundle.mjs':`export const leaseGasConfigured=()=>false,loadLeaseGasConfig=()=>{throw Error('TEST no sponsored path');},configuredLeaseSender=()=>{throw Error('TEST no sponsored path');},openReleaseJournal=()=>null;`,
};
const hooks=registerHooks({resolve(spec,ctx,next){
 if(ctx.parentURL!==url.href||!Object.hasOwn(modules,spec))return next(spec,ctx);
 return {url:'data:text/javascript;base64,'+Buffer.from(modules[spec]).toString('base64'),shortCircuit:true};
}});
const prior=process.env.NODE_OPERATOR_KEY;process.env.NODE_OPERATOR_KEY='0x'+'11'.repeat(32);
const chain=await import(url.href);chain.loadOperator();
if(prior===undefined)delete process.env.NODE_OPERATOR_KEY;else process.env.NODE_OPERATOR_KEY=prior;
const dep='0x'+'22'.repeat(32),host='0x'+'33'.repeat(32);
chain.addresses.deployments='0x'+'44'.repeat(20);
test('ROOT positive control: renewal gate refuses before inert queue send',async()=>{
 state.writes=[];state.simulate=async()=>{};
 await assert.rejects(chain.renewDeployment(dep,{gate:()=> 'TEST policy unknown'}),/not sent/);
 assert.deepEqual(state.writes,[]);
});
test('ROOT claim helper must carry caller gate into actual serialized sender',async()=>{
 state.writes=[];state.simulate=async()=>{};
 await chain.claimDeployment(dep,host,{gate:()=> 'TEST policy unknown'}).catch(()=>{});
 assert.deepEqual(state.writes,[],'claim helper currently drops gate; inert wallet observed claim');
});
test('ROOT release helper must carry caller gate into actual serialized sender',async()=>{
 state.writes=[];state.simulate=async()=>{};
 await chain.releaseDeployment(dep,{gate:()=> 'TEST policy unknown'}).catch(()=>{});
 assert.deepEqual(state.writes,[],'release helper currently drops gate; inert wallet observed release');
});
test('ROOT renewal must recheck permission after awaited simulation before inert wallet write',async()=>{
 state.writes=[];let allowed=true;
 state.simulate=async()=>{await Promise.resolve();allowed=false;};
 await chain.renewDeployment(dep,{gate:()=>allowed?null:'TEST policy changed during simulation'}).catch(()=>{});
 assert.deepEqual(state.writes,[],'queue-entry permission is not a final pre-write fence');
});
test.after(()=>{hooks.deregister();delete globalThis.__r10SendBoundary;});
