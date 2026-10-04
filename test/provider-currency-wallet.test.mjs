import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
import {privateKeyToAccount} from 'viem/accounts';import {keccak256,encodeFunctionData,parseAbi,encodeEventTopics} from 'viem';
import {ProviderConversionWallet,create} from '../network/conversion/provider-wallet.mjs';
import {NativeNknRPC,exactParse,exactJSON} from '../network/conversion/native-rpc.mjs';
import {ASSETS} from '../network/conversion/policy.mjs';import {DurableState} from '../network/durable-state.mjs';
const token='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',destination='0x'+'11'.repeat(20),blockHash='0x'+'ab'.repeat(32),now=1800000000000;
const account=privateKeyToAccount('0x'+'04'.repeat(32));
const abi=parseAbi(['function transfer(address,uint256) returns (bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const binary=process.env.NKN_CURRENCY_TEST_BINARY;
async function nativeExec(seed,request){return new Promise((resolve,reject)=>{const p=spawn(binary,seed?['--seed-file',seed]:[],{stdio:['pipe','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.stderr.resume();p.on('error',reject);p.on('exit',code=>{if(code!==0)return reject(Error('native helper rejected'));try{resolve(JSON.parse(out));}catch(e){reject(e)}});p.stdin.end(exactJSON(request));});}
async function fixture(t,{native=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'currency-wallet-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const seed=path.join(directory,'native.seed');await fs.writeFile(seed,'03'.repeat(32),{mode:0o600});
 const nativeAddress=native?(await nativeExec(seed,{action:'address'})).address:'NKN-test-address';
 const state={nonce:0,receipts:new Map(),blocks:new Map(),broadcasts:0,dataFee:10n,head:1};
 const client={getChainId:async()=>8453,getBlock:async({blockNumber})=>({number:blockNumber??10n,hash:blockHash,timestamp:BigInt(now/1000)}),
  readContract:async({functionName})=>functionName==='balanceOf'?10000000n:state.dataFee,getTransactionCount:async()=>state.nonce,
  getTransactionReceipt:async({hash})=>{if(!state.receipts.has(hash))throw Error('not found');return state.receipts.get(hash)},
  sendRawTransaction:async({serializedTransaction})=>{state.broadcasts++;return keccak256(serializedTransaction)}};
 const nativeRpc={anchor:async()=>({height:state.head,hash:String(state.head).padStart(64,'0'),timestamp:now}),
  block:async h=>state.blocks.get(h)||{height:h,hash:String(h).padStart(64,'0'),previous:String(h-1).padStart(64,'0'),timestamp:now,transactions:[]},
  balance:async()=> '1000000000',nonce:async()=> '1',broadcast:async(_raw,hash)=>{state.broadcasts++;return hash;}};
 const wallet={prepareTransactionRequest:async r=>({...r,chainId:8453,gas:50000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1000000n,type:'eip1559'}),signTransaction:async r=>account.signTransaction(r)};
 const adapter=await new ProviderConversionWallet({account,wallet,clients:[client,client],native:nativeRpc,signNative:native?r=>nativeExec(['address','prepare'].includes(r.action)?seed:null,r):async r=>({address:r.address||nativeAddress}),store:new DurableState(directory),limits:{nknFee8:'100000',maxGasWei:'1000000000000000',maxEthPriceUsdc6:'5000000000'},now:()=>now}).init();
 const request={key:'job-1',transfer:{asset:ASSETS.USDC.id,from:account.address,to:destination,amount:'1000000'},allInUsdc6:'2000000'};
 await adapter.balances();return {adapter,state,request,nativeAddress,directory,seed,client};
}
test('Base conversion funding signs an exact transfer and persists the same nonce before broadcast',async t=>{
 const x=await fixture(t);const first=await x.adapter.prepareTransfer(x.request);assert.equal(x.state.broadcasts,0);
 x.state.nonce=5;assert.deepEqual(await x.adapter.prepareTransfer(x.request),first);
 await assert.rejects(x.adapter.prepareTransfer({...x.request,transfer:{...x.request.transfer,amount:'1000001'}}),/reused/);
 await x.adapter.broadcast(first);assert.equal(x.state.broadcasts,1);
 await assert.rejects(x.adapter.broadcast({...first,raw:first.raw.slice(0,-2)+'00'}),/journaled/);
 await assert.rejects(x.adapter.prepareTransfer({...x.request,key:'job-2'}),/reconciled/);
});
test('USDC funding rejects altered recipients, token calls, wrong chains and uncovered gas',async t=>{
 const x=await fixture(t),signed=await x.adapter.prepareTransfer(x.request);
 await assert.rejects(x.adapter.validatePrepared({signed,transfer:{...x.request.transfer,to:account.address},allInUsdc6:'2000000'}),/differs/);
 for(const tx of [{to:destination},{chainId:1},{data:'0x095ea7b3'+'00'.repeat(64)}]){
  const raw=await account.signTransaction({chainId:8453,to:token,nonce:0,gas:50000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1n,value:0n,data:encodeFunctionData({abi,functionName:'transfer',args:[destination,1000000n]}),...tx});
  await assert.rejects(x.adapter.validatePrepared({signed:{...signed,raw,hash:keccak256(raw)},transfer:x.request.transfer,allInUsdc6:'2000000'}));
 }
 await assert.rejects(x.adapter.validatePrepared({signed,transfer:x.request.transfer,allInUsdc6:'1000000'}),/gas/);
 x.state.dataFee=10n**18n;await assert.rejects(x.adapter.broadcast(signed),/gas cap/);
 await x.adapter.validatePrepared({signed,...x.request,checkCurrentFees:false});
 await assert.rejects(x.adapter.validatePrepared({signed,transfer:{...x.request.transfer,to:account.address},checkCurrentFees:false}),/differs/);
});
test('Base payout verification requires a finalized canonical USDC transfer to this wallet',async t=>{
 const x=await fixture(t),hash='0x'+'01'.repeat(32);
 const log={address:token,topics:encodeEventTopics({abi,eventName:'Transfer',args:{from:destination,to:account.address}}),data:'0x'+(1234567n).toString(16).padStart(64,'0')};
 const receipt={status:'success',blockNumber:9n,blockHash,logs:[log]};x.state.receipts.set(hash,receipt);
 const input={asset:ASSETS.USDC.id,recipient:account.address,hash,notBefore:now-1000};
 const proof=await x.adapter.verifyTransfer(input);assert.equal(proof.amount,'1234567');assert.equal(proof.finalized,true);
 receipt.blockNumber=11n;assert.equal(await x.adapter.verifyTransfer(input),null);
 receipt.blockNumber=9n;receipt.blockHash='0x'+'00'.repeat(32);assert.equal(await x.adapter.verifyTransfer(input),null);
 receipt.blockHash=blockHash;receipt.logs=[{...log,address:destination}];assert.equal(await x.adapter.verifyTransfer(input),null);
 await assert.rejects(x.adapter.verifyTransfer({...input,recipient:destination}),/destination/);
});
test('native wallet signs exact native transfers, checks fee-inclusive prices and rejects ERC-20 destinations',{skip:!binary},async t=>{
 const x=await fixture(t,{native:true});const request={key:'native-job',transfer:{asset:ASSETS.NKN.id,from:x.nativeAddress,to:x.nativeAddress,amount:'100000000'},minimumOut:'2000000',minUsdcPerNkn6:'1000000'};
 const signed=await x.adapter.prepareTransfer(request);assert.equal(x.state.broadcasts,0);
 const details=await nativeExec(null,{action:'inspect',raw:signed.raw});assert.equal(details.amount,'100000000');assert.equal(details.fee,'100000');
 await assert.rejects(x.adapter.validatePrepared({signed,...request,minimumOut:'1000000'}),/fee exceeds/);
 await assert.rejects(x.adapter.validateAddress('NKN',destination));
 await x.adapter.broadcast(signed);assert.equal(x.state.broadcasts,1);
 assert.equal(await x.adapter.fundingStatus(signed),'unknown');
});
test('native block scanner persists bounded progress and checks chain continuity',async t=>{
 const x=await fixture(t);await x.adapter.prepareTransfer(x.request);x.state.head=205;
 await x.adapter.scanNative();assert.equal((await x.adapter.store.get('wallet-current')).scan.height,101);
 await x.adapter.scanNative();assert.equal((await x.adapter.store.get('wallet-current')).scan.height,201);
 x.state.blocks.set(201,{height:201,hash:'bad',previous:'bad',timestamp:now,transactions:[]});
 await assert.rejects(x.adapter.scanNative(),/reorganized/);
});
test('native RPC refuses wrong genesis, stale blocks, disagreement and unsafe JSON rounding',async()=>{
 assert.equal(exactJSON(exactParse('{"nonce":9007199254740993}')),'{"nonce":9007199254740993}');
 const genesis='01'.repeat(32);
 const make=(alter=()=>{})=>new NativeNknRPC({endpoints:['https://one.example','https://two.example'],genesisHash:genesis,now:()=>now,fetchFn:async(url,options)=>{
  const q=JSON.parse(options.body);let result=q.method==='getlatestblockhash'?{height:100,hash:'02'.repeat(32)}:{hash:q.params.height===0?genesis:'02'.repeat(32),header:{height:q.params.height,timestamp:now/1000,prevBlockHash:'02'.repeat(32)},transactions:[]};alter(result,q,url);
  return new Response(JSON.stringify({result}));
 }});
 assert.equal((await make().anchor()).height,88);
 await assert.rejects(make((r,q)=>{if(q.method==='getblock'&&q.params.height===0)r.hash='03'.repeat(32)}).anchor(),/genesis/);
 await assert.rejects(make((r,q)=>{if(q.method==='getblock'&&q.params.height>0)r.header.timestamp-=1000}).anchor(),/stale/);
 await assert.rejects(make((r,q,u)=>{if(q.method==='getblock'&&u.includes('two'))r.hash='03'.repeat(32)}).anchor(),/quorum/);
});
test('production wallet holds exclusive key locks and releases them on close',{skip:!binary},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wallet-lock-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const usdcKeyFile=path.join(directory,'usdc.key'),nknSeedFile=path.join(directory,'nkn.seed');await fs.writeFile(usdcKeyFile,'0x'+'04'.repeat(32),{mode:0o600});await fs.writeFile(nknSeedFile,'03'.repeat(32),{mode:0o600});
 const config={directory:path.join(directory,'state'),usdcKeyFile,nknSeedFile,nativeBinary:binary,nativeBinarySha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex'),baseRpc:['https://one.example','https://two.example'],native:{endpoints:['https://one.example','https://two.example'],genesisHash:'01'.repeat(32)},limits:{nknFee8:'100000',maxGasWei:'1000000000000000',maxEthPriceUsdc6:'5000000000'}};
 const first=await create(config);try{await assert.rejects(create(config));}finally{await first.close();}
 const second=await create(config);await second.close();await second.close();
 await fs.writeFile(usdcKeyFile,'0x'+'05'.repeat(32),{mode:0o600});
 await assert.rejects(create(config),/different wallets/);
 await assert.rejects(fs.stat(usdcKeyFile+'.conversion-lock'),{code:'ENOENT'});
});

test('native receipts require signed transfer inclusion after the checkpoint and survive restart',{skip:!binary},async t=>{
 const x=await fixture(t,{native:true});await x.adapter.prepareTransfer(x.request);
 const transfer=await nativeExec(x.seed,{action:'prepare',recipient:x.nativeAddress,amount:'250000000',fee:'0',nonce:'2'});
 x.state.blocks.set(2,{height:2,hash:'2'.padStart(64,'0'),previous:'1'.padStart(64,'0'),timestamp:now,transactions:[exactParse(transfer.info)]});x.state.head=2;
 const query={asset:ASSETS.NKN.id,recipient:x.nativeAddress,hash:transfer.hash,notBefore:now-1000};
 const proof=await x.adapter.verifyTransfer(query);assert.equal(proof.amount,'250000000');assert.equal(proof.finalized,true);
 assert.equal(await x.adapter.verifyTransfer({...query,notBefore:now+1000}),null);
 const persisted=await new DurableState(x.directory).get('wallet-current');assert.equal(persisted.found[transfer.hash].amount,'250000000');
 x.state.blocks.set(2,{...x.state.blocks.get(2),hash:'3'.padStart(64,'0')});await assert.rejects(x.adapter.verifyTransfer(query),/reorganized/);
});

test('confirmed failed funding permits a new nonce; closing rejects new funding',async t=>{
 const x=await fixture(t),signed=await x.adapter.prepareTransfer(x.request);
 x.state.receipts.set(signed.hash,{status:'reverted',blockNumber:9n,blockHash,logs:[]});x.state.nonce=1;
 const next=await x.adapter.prepareTransfer({...x.request,key:'job-2'});assert.notEqual(next.hash,signed.hash);
 await x.adapter.close();await assert.rejects(x.adapter.prepareTransfer(x.request),/closed/);await assert.rejects(x.adapter.broadcast(next),/closed/);
});

test('native RPC stops reading oversized responses',async()=>{
 let cancelled=false;
 const rpc=new NativeNknRPC({endpoints:['https://one.example','https://two.example'],genesisHash:'01'.repeat(32),fetchFn:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}}))});
 await assert.rejects(rpc.call('https://one.example','getblock'),/too large/);assert.equal(cancelled,true);
});

test('runtime releases both adapters when wallet identity validation fails',async t=>{
 const {startAutomaticConversion}=await import('../network/conversion/runtime.mjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'conversion-startup-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const specs={};
 for(const kind of ['route','wallet']){
  const methods=kind==='route'?['quote','open','lookup','status']:['balances','validateAddress','prepareTransfer','validatePrepared','fundingStatus','broadcast','verifyTransfer'];
  const code=`import fs from 'node:fs/promises';export async function create(config){return {${methods.map(n=>`async ${n}(){}`).join(',')},async addresses(){return {USDC:'wrong',NKN:'wrong'}},async close(){await fs.writeFile(config.closed,'yes')}}}`;
  const module=path.join(directory,kind+'.mjs'),closed=path.join(directory,kind+'.closed');await fs.writeFile(module,code);
  specs[kind]={module,sha256:createHash('sha256').update(code).digest('hex'),config:{closed}};
 }
 await assert.rejects(startAutomaticConversion({config:{...specs,addresses:{USDC:'expected',NKN:'expected'}},directory}),/do not match/);
 for(const kind of ['route','wallet'])assert.equal(await fs.readFile(specs[kind].config.closed,'utf8'),'yes');
});
