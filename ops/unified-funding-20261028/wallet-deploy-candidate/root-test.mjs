import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadInputs,computeToolDigests,createChainReader,createService,validateAuthorization,AUTH_SCHEMA,PROVIDERS,READ_METHODS,LIMITS,assertReadMethod,writeJournalAtomic,freshJournal} from './lib.mjs';
import {startServer,loadStaticFiles} from './server.mjs';
import {decodeFunctionData,encodeFunctionResult,toHex} from 'viem';
import {ORACLE_ABI,FEED_ABI} from '../fee-policy-candidate/fee-policy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)), uf=path.dirname(here);
const inputs=loadInputs({deployDir:path.join(uf,'deployment-candidate'),unifiedDir:uf});
const digests=computeToolDigests(here),now=Date.now(),BH='0x'+'a1'.repeat(32);
const feeConfig=JSON.parse(fs.readFileSync(path.join(uf,'fee-policy-candidate/BASE-OBSERVATION-r1.json'))).results[0].config;
function auth(){return {schema:AUTH_SCHEMA,chainId:8453,expectedOwner:inputs.owner,...inputs.digests,toolSourceSha256:digests,activationSourceSha256:'a'.repeat(64),transactions:inputs.txs.map(t=>({name:t.name,nonce:String(t.nonce),dataHash:t.dataHash,predictedAddress:t.predictedAddress.toLowerCase(),runtimeCodehash:t.runtime.codehash,gas:String(t.gas),maxFeePerGas:String(t.maxFeePerGas),maxPriorityFeePerGas:String(t.maxPriorityFeePerGas)})),implementation:{address:inputs.implementation.address,runtimeCodehash:inputs.implementation.codehash},maxTotalObservedWei:String(inputs.cost.totalObservedBoundWei),maxL1OperatorObservationPerTxWei:'1000000000000',reviewedBy:'OFFLINE TEST ONLY',reviewedAt:new Date(now-1000).toISOString(),notAfter:new Date(now+60000).toISOString()};}
// SCRIPTED JSON-RPC; no wallet signature, chain execution, or network proof.
function chain(over={}){const calls=[];let blocked;
const rpc=async(m,p)=>{calls.push({m,p});if(over.block&&m==='eth_chainId')await new Promise(r=>blocked=r);
if(m==='eth_chainId')return '0x2105';if(m==='eth_blockNumber')return '0x64';
if(m==='eth_getBlockByNumber')return {number:'0x62',hash:BH,timestamp:toHex(BigInt(Math.floor(now/1000)-(over.stale?500:3))),baseFeePerGas:'0x1',transactions:[]};
if(m==='eth_getTransactionCount')return toHex(BigInt(inputs.txs[0].nonce)+(over.used?1n:0n));
if(m==='eth_getBalance')return toHex(10n**18n);
if(m==='eth_getStorageAt')return '0x'+'0'.repeat(24)+feeConfig.oracle.implementation.slice(2).toLowerCase();
if(m==='eth_call'){const fn=decodeFunctionData({abi:ORACLE_ABI,data:p[0].data}).functionName;return encodeFunctionResult({abi:ORACLE_ABI,functionName:fn,result:fn.startsWith('is')?true:(over.expensive?10n**18n:1n)});}
if(m==='eth_getCode'){if([feeConfig.oracle.address,feeConfig.oracle.implementation].map(a=>a.toLowerCase()).includes(p[0].toLowerCase()))return '0x6000';const a=p[0].toLowerCase();const b=inputs.bindings.find(b=>b.address.toLowerCase()===a);if(b)return JSON.parse(fs.readFileSync(path.join(uf,'deployment-candidate/UNSIGNED-PROPOSAL-r1.json'))).bindings[b.address]?.code??bindingCodes[a];return '0x';}
if(m==='eth_getTransactionByHash'||m==='eth_getTransactionReceipt')return null;
throw Error('unscripted '+m);};return {rpc,calls,release:()=>blocked?.()};}
// Actual input baseline stores code hashes, not original code: codeAt must receive fixture bytes matching pinned hashes.
// For scripted tests only, use one simple dependency runtime and independently adjusted in-memory pins.
import {keccak256} from 'viem';
const bindingCodes=Object.fromEntries(inputs.bindings.map(b=>[b.address.toLowerCase(),'0x6000']));
const fixtureInputs={...inputs,feeOracle:{...feeConfig.oracle,proxyCodehash:keccak256('0x6000'),implementationCodehash:keccak256('0x6000')},bindings:inputs.bindings.map(b=>({...b,bytes:2,codehash:keccak256('0x6000')}))};
const testDir=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'wallet-deploy-test-'));fs.chmodSync(p,0o700);return p;};
function service(t,opts={}){const dir=testDir(),c=chain(opts);const svc=createService({inputs:fixtureInputs,journalDir:dir,rpcs:[c.rpc,c.rpc],toolDigests:digests,authorization:opts.disabled?null:auth(),now:()=>now});t.after(()=>{svc.close();fs.rmSync(dir,{recursive:true,force:true});});return {svc,c,dir};}
const body={index:0,account:inputs.owner,walletChainId:'0x2105'};
test('actual bundle is accepted offline and authorization rejects changed calldata identity',()=>{assert.equal(inputs.txs.length,4);assert.doesNotThrow(()=>validateAuthorization(auth(),inputs,digests,now));const a=auth();a.transactions[0].dataHash='0x'+'ff'.repeat(32);assert.throws(()=>validateAuthorization(a,inputs,digests,now));});
test('signing is off without authorization; wrong owner and chain refuse before RPC',async t=>{let x=service(t,{disabled:true});assert.equal((await x.svc.prepare(body)).refusal.code,'signing_disabled');assert.equal(x.c.calls.length,0);x=service(t);assert.equal((await x.svc.prepare({...body,account:'0x'+'11'.repeat(20)})).refusal.code,'wrong_owner');assert.equal((await x.svc.prepare({...body,walletChainId:'0x1'})).refusal.code,'wrong_chain');assert.equal(x.c.calls.length,0);});
test('stale RPC and consumed nonce refuse',async t=>{assert.equal((await service(t,{stale:true}).svc.prepare(body)).refusal.code,'stale_rpc');assert.equal((await service(t,{used:true}).svc.prepare(body)).refusal.code,'proposal_nonce_stale');});
test('unknown wallet outcome survives reconstruction and never offers again',async t=>{const {svc,dir,c}=service(t);const p=await svc.prepare(body);assert.equal(p.ok,true,JSON.stringify(p));assert.equal((await svc.report({index:0,offerId:p.offerId,kind:'unknown'})).state,'pending');assert.equal((await svc.prepare(body)).refusal.code,'unresolved_pending');svc.close();const s=createService({inputs:fixtureInputs,journalDir:dir,rpcs:[c.rpc,c.rpc],authorization:auth(),toolDigests:digests,now:()=>now});t.after(()=>s.close());assert.equal((await s.prepare(body)).refusal.code,'unresolved_pending');assert.equal(s.journal().entries[0].state,'pending');});
test('runtime disagreement and unsafe RPC methods refuse',async()=>{for(const m of ['eth_sendRawTransaction','eth_sendTransaction','wallet_sendCalls','eth_sign'])assert.throws(()=>assertReadMethod(m));const c=chain();const r=createChainReader({inputs:fixtureInputs,rpcs:[c.rpc,async(m,p)=>m==='eth_getCode'?'0x6001':c.rpc(m,p)],now:()=>now});await assert.rejects(()=>r.preflight(0),/differs/);});
test('same-origin capability and CSRF protection; GET does not mutate',async t=>{let mutations=0;const srv=await startServer({service:{state:()=>({ok:true}),prepare:async()=>{mutations++;return {ok:true};}},files:loadStaticFiles(here)});t.after(()=>srv.close());assert.equal((await fetch(srv.url)).status,200);assert.equal(mutations,0);assert.equal((await fetch(srv.url+'api/prepare',{method:'POST',headers:{'content-type':'application/json',origin:'https://example.org'},body:'{}'})).status,403);assert.equal(mutations,0);assert.equal((await fetch(srv.url+'api/prepare',{method:'POST',headers:{'content-type':'application/json',origin:`http://127.0.0.1:${srv.port}`,'x-deploy-token':srv.token},body:'{}'})).status,200);assert.equal(mutations,1);});
test('preflight refreshes L1/operator fee rather than reusing old cost observation',async()=>{const c=chain();await createChainReader({inputs:fixtureInputs,rpcs:[c.rpc,c.rpc],now:()=>now}).preflight(0);assert.ok(c.calls.some(x=>x.m==='eth_call'),'no current L1/operator fee read occurred');});

test('fresh fee above reviewed cap refuses before offering',async t=>{const {svc}=service(t,{expensive:true});assert.equal((await svc.prepare(body)).refusal.code,'live_fee_above_review');assert.equal(svc.journal().entries[0].state,'none');});
import {privateKeyToAccount} from 'viem/accounts';
import {parseTransaction,getContractAddress} from 'viem';
// Public Anvil fixture key; only local signature construction, never any RPC send or production wallet.
const testAccount=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
async function mined(over={}){
 const t=inputs.txs[0],owner=testAccount.address,pred=getContractAddress({from:owner,nonce:BigInt(t.nonce)});
 const serial=await testAccount.signTransaction({chainId:8453,type:'eip1559',nonce:t.nonce,gas:t.gas,maxFeePerGas:t.maxFeePerGas,maxPriorityFeePerGas:t.maxPriorityFeePerGas,value:0n,data:over.badData?'0x00':t.data});
 const parsed=parseTransaction(serial),hash=keccak256(serial),b='0x'+'b1'.repeat(32);
 const tx={hash,from:owner,to:null,nonce:toHex(t.nonce),value:'0x0',input:parsed.data,gas:toHex(t.gas),maxFeePerGas:toHex(t.maxFeePerGas),maxPriorityFeePerGas:toHex(t.maxPriorityFeePerGas),chainId:'0x2105',type:'0x2',accessList:[],r:parsed.r,s:parsed.s,yParity:toHex(parsed.yParity),blockNumber:over.zero?'0x0':'0x5a',blockHash:b};
 const rc={transactionHash:hash,from:owner,contractAddress:pred,blockHash:b,blockNumber:tx.blockNumber,status:over.status??'0x1'};
 const c=chain();const rpc=async(m,p)=>{
  if(m==='eth_getTransactionByHash')return tx;if(m==='eth_getTransactionReceipt')return rc;
  if(m==='eth_getBlockByNumber'&&p[0]==='0x5a')return {number:'0x5a',hash:b,transactions:over.omit?[]:[hash]};
  if(m==='eth_getCode'&&p[0].toLowerCase()===pred.toLowerCase())return over.badRuntime?'0x6001':t.runtime.code;
  return c.rpc(m,p);
 };
 const r=createChainReader({inputs:{...fixtureInputs,owner,txs:[{...t,predictedAddress:pred},...inputs.txs.slice(1)]},rpcs:[rpc,rpc],now:()=>now});return r.verifyMined(0,hash);
}
test('actual local ECDSA envelope plus scripted canonical receipt verifies exact runtime',async()=>assert.equal((await mined()).kind,'confirmed'));
test('block-zero preconfirmation and omitted block membership are not inclusion',async()=>{assert.equal((await mined({zero:true})).code,'zero_block_receipt');assert.equal((await mined({omit:true})).code,'not_canonical');});
test('changed calldata/runtime and unknown receipt status never advance',async()=>{assert.ok((await mined({badData:true})).problems.includes('calldata'));assert.ok((await mined({badRuntime:true})).problems.includes('runtime'));assert.ok((await mined({status:'0x2'})).problems.includes('reverted'));});
test('concurrent preparation yields one offer only',async t=>{const c=chain(),dir=testDir();let release;const gate=new Promise(r=>release=r);const rpc=async(m,p)=>{if(m==='eth_chainId')await gate;return c.rpc(m,p);};const s=createService({inputs:fixtureInputs,journalDir:dir,rpcs:[rpc,rpc],authorization:auth(),toolDigests:digests,now:()=>now});t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});const first=s.prepare(body);assert.equal((await s.prepare(body)).refusal.code,'busy');release();assert.equal((await first).ok,true);assert.equal(s.journal().entries[0].events.length,1);});
