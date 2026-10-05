// Provider-owned conversion wallets. No deployment ledger access, token
// approvals or arbitrary contract calls. Native signing uses the pinned,
// offline currency-wallet helper; only this adapter can broadcast its output.
import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,parseTransaction,recoverTransactionAddress,keccak256,decodeEventLog,getAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';import {base} from 'viem/chains';
import {ASSETS,units} from './policy.mjs';import {NativeNknRPC,exactJSON} from './native-rpc.mjs';import {DurableState} from '../durable-state.mjs';
const GAS_ORACLE='0x420000000000000000000000000000000000000F';
const gasABI=parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)','function getOperatorFee(uint256) view returns (uint256)']);
const TOKEN='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const abi=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const eq=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
async function nativeCall(binary,seedFile,request){
 return new Promise((resolve,reject)=>{
  const p=spawn(binary,seedFile?['--seed-file',seedFile]:[],{stdio:['pipe','pipe','pipe'],windowsHide:true});let out='',settled=false;
  const timer=setTimeout(()=>{p.kill();finish(Error('offline native signer timed out'));},15000);
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  p.on('error',()=>finish(Error('offline native signer could not start')));
  p.stdout.on('data',b=>{out+=b;if(out.length>65536){p.kill();finish(Error('native signer response too large'));}});
  p.stderr.resume();
  p.stdin.on('error',()=>{});p.on('exit',code=>{if(code!==0)return finish(Error('native signer rejected the request'));try{finish(null,JSON.parse(out));}catch{finish(Error('invalid native signer response'));}});
  p.stdin.end(exactJSON(request));
 });
}
async function secretFile(file){const real=await fs.realpath(file),st=await fs.stat(real);if(!st.isFile()||(process.platform!=='win32'&&(st.mode&0o077)))throw Error('private provider key permissions required');return real;}
export class ProviderConversionWallet {
 constructor({account,wallet,clients,native,signNative,store,limits,release=async()=>{},now=Date.now}){
  Object.assign(this,{account,wallet,clients,native,signNative,store,limits,release,now});this.tail=Promise.resolve();
  for(const k of ['nknFee8','maxGasWei','maxEthPriceUsdc6'])units(limits[k]);
  if(units(limits.maxGasWei)===0n||units(limits.maxEthPriceUsdc6)===0n)throw Error('explicit gas limits required');
 }
 async init(){
  this.nativeAddress=(await this.signNative({action:'address'})).address;await this.validateAddress('NKN',this.nativeAddress);
  const identity={version:1,USDC:this.account.address,NKN:this.nativeAddress};
  await this.store.update('wallet-identity',prior=>{
   if(prior&&exactJSON(prior)!==exactJSON(identity))throw Error('conversion journal belongs to different wallets');
   return identity;
  });return this;
 }
 async addresses(){return {USDC:this.account.address,NKN:this.nativeAddress};}
 async validateAddress(currency,address){
  if(currency==='USDC'){if(!eq(getAddress(address),address)||/^0x0{40}$/i.test(address))throw Error('invalid Base recipient');}
  else if(currency==='NKN'){if((await this.signNative({action:'validateAddress',address})).address!==address)throw Error('invalid native recipient');}
  else throw Error('unsupported conversion asset');
 }
 async quorum(fn){const values=await Promise.all(this.clients.map(c=>fn(c).catch(()=>undefined)));for(const value of values)if(value!==undefined&&values.filter(v=>v!==undefined&&exactJSON(v)===exactJSON(value)).length>=2)return value;throw Error('Base wallet RPC quorum unavailable');}
 async finalBlock(){
  if(await this.quorum(c=>c.getChainId())!==8453)throw Error('conversion requires Base mainnet');
  const heads=await Promise.all(this.clients.map(c=>c.getBlock({blockTag:'finalized'}).catch(()=>null)));
  const numbers=heads.filter(b=>b?.number!==undefined).map(b=>b.number).sort((a,b)=>a>b?-1:a<b?1:0);
  if(numbers.length<2)throw Error('Base finality unavailable');
  const b=await this.quorum(c=>c.getBlock({blockNumber:numbers[1]}));if(!b.hash||b.timestamp>BigInt(Math.floor(this.now()/1000+10))||b.timestamp<BigInt(Math.floor(this.now()/1000-3600)))throw Error('Base finalized chain is stale');return b;
 }
 async balances(){
  const [block,anchor]=await Promise.all([this.finalBlock(),this.native.anchor()]);
  const usdc=await this.quorum(c=>c.readContract({address:TOKEN,abi,functionName:'balanceOf',args:[this.account.address],blockNumber:block.number}));
  const nkn=BigInt(await this.native.balance(this.nativeAddress)),fee=units(this.limits.nknFee8);
  await this.store.set('native-checkpoint',{height:anchor.height,hash:anchor.hash,timestamp:anchor.timestamp});
  return {usdc6:String(usdc),nkn8:String(nkn>fee?nkn-fee:0n)};
 }
 prepareTransfer(request){if(this.closing)return Promise.reject(Error('conversion wallet closed'));const op=this.tail.then(()=>this.prepare(request));this.tail=op.catch(()=>{});return op;}
 async prepare({key,transfer,allInUsdc6,minimumOut,minUsdcPerNkn6}){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key||''))throw Error('conversion key required');
  const prior=await this.store.get('wallet-current');
  if(prior?.key===key){if(exactJSON(prior.transfer)!==exactJSON(transfer))throw Error('conversion key reused with different transfer');await this.validatePrepared({signed:prior.signed,transfer,allInUsdc6,minimumOut,minUsdcPerNkn6});return prior.signed;}
  if(prior&&!['confirmed','reverted'].includes(await this.fundingStatus(prior.signed)))throw Error('previous wallet transaction must be reconciled');
  const currency=transfer.asset===ASSETS.USDC.id?'USDC':transfer.asset===ASSETS.NKN.id?'NKN':null;
  if(!currency||!eq(transfer.from,(await this.addresses())[currency])||units(transfer.amount,{zero:false})===0n)throw Error('provider-owned conversion transfer required');
  await this.validateAddress(currency,transfer.to);
  const checkpoint=await this.store.get('native-checkpoint');if(!checkpoint)throw Error('native chain checkpoint required');
  let signed;
  if(currency==='USDC'){
   await this.finalBlock();
   const nonce=await this.quorum(c=>c.getTransactionCount({address:this.account.address,blockTag:'pending'}));
   const data=encodeFunctionData({abi,functionName:'transfer',args:[transfer.to,units(transfer.amount)]});
   const request=await this.wallet.prepareTransactionRequest({account:this.account,chain:base,to:TOKEN,data,value:0n,nonce});
   const raw=await this.wallet.signTransaction(request);signed={raw,hash:keccak256(raw),asset:transfer.asset,transfer};
  }else{
   await this.native.anchor();const nonce=await this.native.nonce(this.nativeAddress);
   if(BigInt(await this.native.balance(this.nativeAddress))<units(transfer.amount)+units(this.limits.nknFee8))throw Error('insufficient provider native balance');
   const result=await this.signNative({action:'prepare',recipient:transfer.to,amount:transfer.amount,fee:this.limits.nknFee8,nonce});
   signed={raw:result.raw,hash:result.hash,asset:transfer.asset,transfer};
  }
  await this.validatePrepared({signed,transfer,allInUsdc6,minimumOut,minUsdcPerNkn6});
  // This journal closes the gap before AutomaticConversion persists funding.
  // Retrying the same order returns exactly these bytes and nonce.
  await this.store.set('wallet-current',{key,transfer,signed,feeTerms:{allInUsdc6,minimumOut,minUsdcPerNkn6},checkpoint,scan:{height:checkpoint.height,hash:checkpoint.hash},found:{}});
  return signed;
 }
 async validatePrepared({signed,transfer,allInUsdc6,minimumOut,minUsdcPerNkn6,checkCurrentFees=true}){
  if(!signed||signed.asset!==transfer.asset)throw Error('conversion funding asset changed');
  if(transfer.asset===ASSETS.USDC.id){
   const tx=parseTransaction(signed.raw),from=await recoverTransactionAddress({serializedTransaction:signed.raw});
   const expected=encodeFunctionData({abi,functionName:'transfer',args:[transfer.to,units(transfer.amount,{zero:false})]});
   if(tx.chainId!==8453||!eq(tx.to,TOKEN)||!eq(from,this.account.address)||!eq(transfer.from,from)||(tx.value??0n)!==0n||tx.data!==expected||keccak256(signed.raw)!==signed.hash)throw Error('signed USDC transfer differs from order');
   // Recovery must still validate the signed transfer, but changing fee
   // estimates cannot prevent reconciliation of an already funded order.
   if(!checkCurrentFees)return;
   const [l1,operator]=await Promise.all([
    this.quorum(c=>c.readContract({address:GAS_ORACLE,abi:gasABI,functionName:'getL1FeeUpperBound',args:[BigInt((signed.raw.length-2)/2)]})),
    this.quorum(c=>c.readContract({address:GAS_ORACLE,abi:gasABI,functionName:'getOperatorFee',args:[tx.gas]})),
   ]);
   // Include rollup fees, with headroom, in the pre-broadcast estimate. Their
   // actual inclusion-time price is not capped by EIP-1559's execution fee.
   const fee=tx.gas*(tx.maxFeePerGas??tx.gasPrice)+2n*(l1+operator);if(fee>units(this.limits.maxGasWei))throw Error('conversion gas cap exceeded');
   const fee6=(fee*units(this.limits.maxEthPriceUsdc6)+10n**18n-1n)/10n**18n;
   if(units(allInUsdc6)<units(transfer.amount)+fee6)throw Error('quote does not cover bounded conversion gas');
  }else if(transfer.asset===ASSETS.NKN.id){
   const tx=await this.signNative({action:'inspect',raw:signed.raw});
   if(tx.hash!==signed.hash||tx.from!==this.nativeAddress||transfer.from!==this.nativeAddress||tx.to!==transfer.to||tx.amount!==transfer.amount||tx.fee!==this.limits.nknFee8)throw Error('signed native transfer differs from order');
   if(units(minimumOut,{zero:false})*100000000n<(units(transfer.amount)+units(tx.fee))*units(minUsdcPerNkn6,{zero:false}))throw Error('native fee exceeds accepted conversion price');
  }else throw Error('unsupported funding asset');
 }
 async scanNative(){
  const s=await this.store.get('wallet-current');if(!s)return null;
  const head=await this.native.anchor();if(head.height<s.scan.height)throw Error('native chain regressed');
  if((await this.native.block(s.scan.height)).hash!==s.scan.hash)throw Error('native funding checkpoint reorganized');
  // Bound each tick, and persist its exact scan position. Long-delayed orders
  // resume scanning; they do not assume an exchange's success means payment.
  const end=Math.min(head.height,s.scan.height+100);
  for(let h=s.scan.height+1;h<=end;h++){
   const b=await this.native.block(h);if(b.previous!==s.scan.hash)throw Error('native block continuity failed');
   for(const info of b.transactions){
    if(info.txType!=='TRANSFER_ASSET_TYPE')continue;
    const tx=await this.signNative({action:'inspect',info});
    if(tx.amount!=='0'&&(tx.hash===s.signed.hash||tx.to===this.nativeAddress))s.found[tx.hash]={...tx,timestamp:b.timestamp,height:h,blockHash:b.hash};
   }
   if(Object.keys(s.found).length>10000)throw Error('native transfer scan limit reached; operator reconciliation required');
   s.scan={height:h,hash:b.hash};await this.store.set('wallet-current',s);
  }
  return s;
 }
 async fundingStatus(signed){
  if(signed.asset===ASSETS.NKN.id){const s=await this.scanNative();return s?.found[signed.hash]?'confirmed':'unknown';}
  if(signed.asset!==ASSETS.USDC.id)throw Error('unsupported funding asset');
  const b=await this.finalBlock();
  const r=await this.quorum(c=>c.getTransactionReceipt({hash:signed.hash})).catch(()=>null);
  if(!r||r.blockNumber>b.number)return 'unknown';
  const canonical=await this.quorum(c=>c.getBlock({blockNumber:r.blockNumber}));if(canonical.hash!==r.blockHash)throw Error('funding receipt reorganized');
  return r.status==='success'?'confirmed':'reverted';
 }
 async broadcast(signed){
  if(this.closing)throw Error('conversion wallet closed');
  const s=await this.store.get('wallet-current');if(!s||s.signed.hash!==signed.hash||s.signed.raw!==signed.raw||s.signed.asset!==signed.asset)throw Error('only journaled funding can be broadcast');
  await this.validatePrepared({signed,transfer:s.transfer,...s.feeTerms});
  if(signed.asset===ASSETS.NKN.id)return this.native.broadcast(signed.raw,signed.hash);
  const hash=await this.clients[0].sendRawTransaction({serializedTransaction:signed.raw});if(hash!==signed.hash)throw Error('funding broadcast hash mismatch');return hash;
 }
 async verifyTransfer({asset,recipient,hash,notBefore}){
  if(asset===ASSETS.NKN.id){
   if(recipient!==this.nativeAddress||!/^[0-9a-f]{64}$/.test(hash))throw Error('native destination mismatch');
   const s=await this.scanNative(),tx=s?.found[hash];if(!tx||tx.to!==recipient||tx.timestamp<notBefore)return null;
   return {asset,recipient,hash,amount:tx.amount,transferId:hash,timestamp:tx.timestamp,finalized:true};
  }
  if(asset!==ASSETS.USDC.id||!eq(recipient,this.account.address))throw Error('Base destination mismatch');
  const b=await this.finalBlock(),r=await this.quorum(c=>c.getTransactionReceipt({hash}));
  if(r.status!=='success'||r.blockNumber>b.number)return null;
  const block=await this.quorum(c=>c.getBlock({blockNumber:r.blockNumber}));
  if(block.hash!==r.blockHash||Number(block.timestamp)*1000<notBefore)return null;
  let amount=0n;
  for(const log of r.logs){if(!eq(log.address,TOKEN))continue;try{const event=decodeEventLog({abi,...log});if(event.eventName==='Transfer'&&eq(event.args.to,recipient))amount+=event.args.value;}catch{}}
  if(amount===0n)return null;
  return {asset,recipient,hash,amount:String(amount),transferId:hash.toLowerCase(),timestamp:Number(block.timestamp)*1000,finalized:true};
 }
 async close(){if(!this.closing)this.closing=this.tail.then(()=>this.release());await this.closing;}
}
export async function create(config){
 const files=await Promise.all([secretFile(config.usdcKeyFile),secretFile(config.nknSeedFile)]),locks=[];
 try{
  for(const file of [...new Set(files)].sort()){const lock=file+'.conversion-lock';await fs.mkdir(lock,{mode:0o700});locks.push(lock);}
  if(!path.isAbsolute(config.nativeBinary)||createHash('sha256').update(await fs.readFile(config.nativeBinary)).digest('hex')!==config.nativeBinarySha256)throw Error('pinned offline native signer required');
  if(!path.isAbsolute(config.directory))throw Error('conversion wallet state directory required');
  const rpc=config.baseRpc;if(!Array.isArray(rpc)||rpc.length<2||new Set(rpc.map(u=>new URL(u).hostname)).size!==rpc.length||rpc.some(u=>new URL(u).protocol!=='https:'))throw Error('independent Base HTTPS RPCs required');
  const account=privateKeyToAccount((await fs.readFile(files[0],'utf8')).trim());
  const clients=rpc.map(url=>createPublicClient({chain:base,transport:http(url,{timeout:15000})}));
  const wallet=createWalletClient({account,chain:base,transport:http(rpc[0],{timeout:15000})});
  const native=new NativeNknRPC(config.native);
  const result=new ProviderConversionWallet({account,wallet,clients,native,signNative:r=>nativeCall(config.nativeBinary,['address','prepare'].includes(r.action)?files[1]:null,r),store:new DurableState(config.directory),limits:config.limits,release:async()=>{for(const lock of locks)await fs.rmdir(lock);}});
  await result.init();return result;
 }catch(e){for(const lock of locks)await fs.rmdir(lock).catch(()=>{});throw e;}
}
