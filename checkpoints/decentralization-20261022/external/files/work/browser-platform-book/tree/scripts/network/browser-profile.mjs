#!/usr/bin/env node
// Turn a REVIEWED authority profile (enclave.authority-profile, e.g. contracts/deployments/network-profile-base.json)
// into an independent-dashboard browser profile (docs/network/independent-dashboard.md). Read-only and offline unless
// --verify-chain is given. The authority profile never vouches for itself: its digest and its contract pins must
// equal values obtained out of band. Addresses come only from that reviewed file; nothing is discovered from the
// mutable address book or from live observations. Operator choices (RPCs, storage adapters, directories) are explicit
// inputs. Prints the output's SHA-256 fingerprint for the publisher to announce; refuses to overwrite a file.
//
//   node scripts/network/browser-profile.mjs --authority contracts/deployments/network-profile-base.json \
//     --expect-digest sha256:<64 hex> --expect-pins contracts/deployments/contract-pins-base.json \
//     --rpc https://base-rpc.publicnode.com --rpc https://mainnet.base.org --rpc https://base.drpc.org \
//     [--quorum 2] [--confirmations 2] [--max-block-age 600] [--storage-plan storage.json] \
//     [--directory https://dir-a.example ...] [--name "..."] [--address-book 0x...] [--verify-chain] --out browser-profile.json
// --address-book selects administrator-directed following and with it the ORIGINAL session factory (legacySessionVaultFactory);
// with --verify-chain the binding (factory -> implementation -> book, USDC, core entries) is checked at the verified block.
// --ledger-history-from <block> (with both; the book's deployment block) records every ledger the book named for
// "deployments" up to the verified block, from its AddressSet events with all RPCs agreeing, as the profile's ledgerHistory.
import fs from 'node:fs/promises';
import {parseAbi,stringToHex} from 'viem';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {parseProfile,contractPinsFromProfile,MAX_PROFILE_BYTES,rpcClients,verifyProfileOnChain} from '../../network/authority-profile.mjs';
import {validateContractPins} from '../../network/contract-pins.mjs';
import {validateProfile as validateBrowserProfile,parseUniqueJSON,PROFILE_FORMAT,PROFILE_MAX_BYTES} from '../../site/js/core/independent.js';

async function readBounded(file,max,what){
  const h=await fs.open(file,'r');
  try{
    const b=Buffer.alloc(max+1);let n=0;
    for(;;){const {bytesRead}=await h.read(b,n,b.length-n,null);if(!bytesRead)break;n+=bytesRead;if(n>max)throw Error(what+' is too large');}
    return b.subarray(0,n);
  }finally{await h.close();}
}
const int=(v,name,def)=>{if(v==null)return def;if(!/^[0-9]+$/.test(v))throw Error('--'+name+' must be an integer');return Number(v);};

/* Pure conversion (tests call this): reviewed authority bytes + out-of-band digest and pins + operator choices. */
export function convert({authorityBytes,expectDigest,expectPins,rpcs,quorum=2,confirmations=2,maxBlockAgeSeconds=600,storage=null,directories=[],name='',addressBook=null,ledgerHistory=null}){
  const {digest,profile}=parseProfile(authorityBytes,{expectedDigest:expectDigest});
  const pins=contractPinsFromProfile(profile);
  const expected=validateContractPins(expectPins);
  for(const k of Object.keys(expected))if(pins.contracts[k].toLowerCase()!==expected[k])
    throw Error('contract pin '+k+' in the authority profile ('+pins.contracts[k]+') differs from the expected pins ('+expected[k]+')');
  if(Object.keys(pins.contracts).length!==Object.keys(expected).length)throw Error('contract pin sets differ');
  const usdc=profile.contracts.usdc?.address;
  if(!usdc)throw Error('the authority profile pins no usdc');
  const feed=profile.contracts.deployments?.reviewedState?.ethUsdFeed;
  const contracts=Object.fromEntries(Object.entries(pins.contracts).map(([k,v])=>[k,v.toLowerCase()]));
  // Address-book mode follows the administrator's book, which only the ORIGINAL session factory's vaults consult: select
  // that factory from the same digest-checked authority profile. The pinned alternate factory never reads the book, and
  // the dashboard refuses to sign sessions through a factory bound to another book (independent-chain sessionAuthority).
  if(addressBook!==null){
    const original=profile.contracts.legacySessionVaultFactory?.address;
    if(!original||/^0x0{40}$/i.test(original))throw Error('address-book mode needs the original session factory (legacySessionVaultFactory) in the authority profile');
    contracts.sessionVaultFactory=original.toLowerCase();
  }
  for(const d of directories)if(!/^https:\/\//.test(d))throw Error('directories must be HTTPS origins: a dashboard served over HTTPS cannot reach '+d);
  const out={format:PROFILE_FORMAT,version:1,name:name||'Base · authority profile '+digest.slice(7,19),chainId:profile.chainId,
    rpcs,quorum,confirmations,maxBlockAgeSeconds,
    contractPins:{version:1,chainId:pins.chainId,contracts},
    usdc:usdc.toLowerCase(),
    ...(addressBook !== null ? {addressBook} : {}),
    ...(ledgerHistory ? {ledgerHistory} : {}),
    ...(feed&&!/^0x0{40}$/i.test(feed)?{ethUsdFeed:feed.toLowerCase()}:{}),
    ...(storage?{storage}:{}),
    ...(directories.length?{directories}:{}),
    source:{authorityProfileDigest:digest,reviewBlock:String(profile.review.blockNumber)}};
  validateBrowserProfile(out);                         // exactly what the dashboard will accept
  for(const u of rpcs)if(!/^https:\/\//.test(u))throw Error('RPCs must be HTTPS for a published browser profile: '+u);
  const text=JSON.stringify(out,null,2)+'\n';
  if(Buffer.byteLength(text)>PROFILE_MAX_BYTES)throw Error('browser profile too large');
  return {text,fingerprint:createHash('sha256').update(text).digest('hex'),authorityDigest:digest,profile,browser:out};
}

// keccak256("AddressSet(bytes32,address)") and the "deployments" key (contracts/EnclaveAddressBook.sol)
const SET_TOPIC='0xb37614c7d254ea8d16eb81fa11dddaeb266aa8ba4917980859c7740aff30c691';
const KEY_DEPLOYMENTS=stringToHex('deployments',{size:32});
/* Every ledger the book has named for "deployments" in [fromBlock, toBlock]: its own AddressSet events, read in `span`
   ranges, every RPC returning the identical log set; each ledger must have code at toBlock. The profile's current pin is
   not "replaced" and is left out. -> {ledgerHistory:{through,ledgers}, events} for the profile (fingerprint-covered). */
export async function bookLedgerHistory({clients,book,fromBlock,toBlock,current,span=2000}){
  if(!(fromBlock>=0n)||!(toBlock>=fromBlock)||!(span>0n))throw Error('invalid ledger-history range');
  book=String(book).toLowerCase();current=String(current||'').toLowerCase();
  const events=[],ledgers=[];
  for(let from=fromBlock;from<=toBlock;from+=span){
    const to=from+span-1n<toBlock?from+span-1n:toBlock;
    const answers=await Promise.all(clients.map(async c=>{
      const logs=await c.request({method:'eth_getLogs',params:[{address:book,topics:[SET_TOPIC,KEY_DEPLOYMENTS],fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16)}]});
      if(!Array.isArray(logs))throw Error('bad eth_getLogs answer');
      return JSON.stringify(logs.map(l=>{
        const n=BigInt(l.blockNumber),t=(l.topics||[]).map(x=>String(x).toLowerCase()),data=String(l.data||'').toLowerCase();
        if(String(l.address).toLowerCase()!==book||l.removed||n<from||n>to||t.length!==2||t[0]!==SET_TOPIC||t[1]!==KEY_DEPLOYMENTS||!/^0x0{24}[0-9a-f]{40}$/.test(data))
          throw Error('an RPC returned a log outside the request');
        return [n.toString(),Number(BigInt(l.logIndex)),String(l.transactionHash).toLowerCase(),'0x'+data.slice(26)];
      }).sort((a,b)=>BigInt(a[0])<BigInt(b[0])?-1:BigInt(a[0])>BigInt(b[0])?1:a[1]-b[1]));
    }));
    if(new Set(answers).size!==1)throw Error('RPCs disagree about the address book history in blocks '+from+'-'+to);
    for(const [block,,tx,value] of JSON.parse(answers[0])){
      events.push({block,tx,value});
      if(!/^0x0{40}$/.test(value)&&value!==current&&!ledgers.includes(value))ledgers.push(value);
    }
  }
  for(const l of ledgers){
    const codes=await Promise.all(clients.map(c=>c.getCode({address:l,blockNumber:toBlock})));
    if(codes.some(x=>!x||x==='0x'))throw Error('historical ledger '+l+' has no code at block '+toBlock);
  }
  if(ledgers.length>32)throw Error('more than 32 historical ledgers');
  return {ledgerHistory:{through:toBlock.toString(),ledgers},events};
}

const BOOK_ABI=parseAbi(['function implementation() view returns (address)','function factory() view returns (address)',
  'function book() view returns (address)','function usdc() view returns (address)','function owner() view returns (address)',
  'function addr(bytes32) view returns (address)']);
/* Address-book mode at the verified block: every RPC must report the original factory bound to this book and USDC, an
   administrator, and the book's core entries equal to the profile's starting pins (otherwise review the pins first). */
export async function verifyBookBinding({clients,browser,blockNumber}){
  const {addressBook:book,usdc}=browser,{sessionVaultFactory:factory}=browser.contractPins.contracts;
  const answers=await Promise.all(clients.map(async c=>{
    const read=(address,functionName,args=[])=>c.readContract({address,abi:BOOK_ABI,functionName,args,blockNumber}).then(a=>a.toLowerCase());
    const implementation=await read(factory,'implementation');
    const out={implementation,factory:await read(implementation,'factory'),book:await read(implementation,'book'),
      usdc:await read(implementation,'usdc'),owner:await read(book,'owner')};
    for(const k of ['registry','deployments','appCatalog'])out[k]=await read(book,'addr',[stringToHex(k,{size:32})]);
    return JSON.stringify(out);
  }));
  if(new Set(answers).size!==1)throw Error('RPCs disagree about the address-book binding at block '+blockNumber);
  const a=JSON.parse(answers[0]);
  if(a.factory!==factory)throw Error('the session implementation '+a.implementation+' belongs to another factory');
  if(a.book!==book)throw Error('the original session factory follows book '+a.book+', not '+book);
  if(a.usdc!==usdc)throw Error('the session implementation uses USDC '+a.usdc+', not '+usdc);
  if(/^0x0{40}$/.test(a.owner))throw Error('the address book has no administrator');
  for(const k of ['registry','deployments','appCatalog'])if(a[k]!==browser.contractPins.contracts[k])
    throw Error('the address book now selects '+a[k]+' for '+k+' (profile pin '+browser.contractPins.contracts[k]+'); review the pins before publishing');
  return a;
}

async function main(){
  const {values}=parseArgs({options:{authority:{type:'string'},'expect-digest':{type:'string'},'expect-pins':{type:'string'},
    rpc:{type:'string',multiple:true},quorum:{type:'string'},confirmations:{type:'string'},'max-block-age':{type:'string'},
    'storage-plan':{type:'string'},directory:{type:'string',multiple:true},name:{type:'string'},'address-book':{type:'string'},'ledger-history-from':{type:'string'},'log-span':{type:'string'},'verify-chain':{type:'boolean'},out:{type:'string'}},strict:true});
  for(const k of ['authority','expect-digest','expect-pins','out'])if(!values[k])throw Error('--'+k+' is required');
  const authorityBytes=await readBounded(values.authority,MAX_PROFILE_BYTES,'authority profile');
  const expectPins=parseUniqueJSON((await readBounded(values['expect-pins'],16384,'expected pins')).toString('utf8'));
  const storage=values['storage-plan']?parseUniqueJSON((await readBounded(values['storage-plan'],16384,'storage plan')).toString('utf8')):null;
  if(values['ledger-history-from']!=null&&(!values['address-book']||!values['verify-chain']))
    throw Error('--ledger-history-from needs --address-book and --verify-chain (the history is read from the chain)');
  const args={authorityBytes,expectDigest:values['expect-digest'],expectPins,rpcs:values.rpc||[],quorum:int(values.quorum,'quorum',2),
    confirmations:int(values.confirmations,'confirmations',2),maxBlockAgeSeconds:int(values['max-block-age'],'max-block-age',600),
    storage,directories:values.directory||[],name:values.name||'',addressBook:values['address-book']??null};
  let r=convert(args);
  if(values['verify-chain']){
    const clients=rpcClients(values.rpc);
    const v=await verifyProfileOnChain({profile:r.profile,clients});
    console.error('authority profile matches the chain at block '+v.blockNumber+' ('+v.blockHash+')');
    if(r.browser.addressBook){
      const b=await verifyBookBinding({clients,browser:r.browser,blockNumber:BigInt(v.blockNumber)});
      console.error('address book '+r.browser.addressBook+' (administrator '+b.owner+') binds the original session factory at that block');
      if(values['ledger-history-from']!=null){
        const h=await bookLedgerHistory({clients,book:r.browser.addressBook,fromBlock:BigInt(int(values['ledger-history-from'],'ledger-history-from')),
          toBlock:BigInt(v.blockNumber),current:r.browser.contractPins.contracts.deployments,span:BigInt(int(values['log-span'],'log-span',2000))});
        for(const e of h.events)console.error('book history: deployments = '+e.value+' at block '+e.block+' ('+e.tx+')');
        r=convert({...args,ledgerHistory:h.ledgerHistory});
        console.error('ledger history through block '+h.ledgerHistory.through+': '+(h.ledgerHistory.ledgers.join(', ')||'none replaced'));
      }
    }
  }
  await fs.writeFile(values.out,r.text,{flag:'wx',mode:0o644});
  console.log(JSON.stringify({out:values.out,fingerprint:'sha256:'+r.fingerprint,authorityProfileDigest:r.authorityDigest}));
  console.error('Publish this fingerprint through a channel users already trust; the dashboard asks for it before using the profile.');
}
if(import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error('browser-profile: '+e.message);process.exitCode=1;});
