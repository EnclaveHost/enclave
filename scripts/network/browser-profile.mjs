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
//     [--directory https://dir-a.example ...] [--capacity-directory https://mirror.example ...] [--name "..."] [--address-book 0x...]
//     [--verify-chain] --out browser-profile.json
// --host-ownership: the host-ownership extension the signed platform host policy binds (default for the platform book:
// network/platform-host-policy-config.mjs PRODUCTION_HOST_OWNERSHIP; required for any other book).
// --host-policy-mirror (required with --address-book; 1-8 HTTPS origins): mirrors of the administrator's signed platform host
// policy (network/platform-host-policy.mjs); the profile's book owner and anchor are its authority. With --verify-chain the
// anchor is read at the verified block and reported: anchored (enforcing), unanchored (not activated yet), torn (refused).
// --capacity-directory: optional mirrors of operator-signed host capacity records (GET /v1/host-capacity); the dashboard also
// reads each host's own record and verifies every record itself, so no mirror is required or trusted.
// --address-book selects administrator-directed following and with it the ORIGINAL session factory (legacySessionVaultFactory);
// with --verify-chain the binding (factory -> implementation -> book, USDC, core entries) is checked at the verified block.
// With --verify-chain each --rpc that is an Enclave host's public RPC (network/public-rpc.mjs) is asked which host it is: two
// origins of ONE host are refused (one vote, not two RPCs); an RPC that states no identity is reported as unknown.
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
import {ANCHOR_KEYS,decodeAnchor} from '../../network/platform-host-policy.mjs';
import {rpcHostIdentities,assertDistinctRpcHosts} from '../../network/public-rpc-hosts.mjs';
// the Enclave platform's book and production host-ownership extension (network/platform-host-policy-config.mjs; pinned by
// test/site-host-policy.test.mjs, like site/js/core/host-policy.js)
export const PLATFORM_BOOK='0xab214342d5a490150a4a977063a2f88e21f80907',PLATFORM_HOST_OWNERSHIP='0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7';

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
export function convert({authorityBytes,expectDigest,expectPins,rpcs,quorum=2,confirmations=2,maxBlockAgeSeconds=600,storage=null,directories=[],name='',addressBook=null,ledgerHistory=null,capacityDirectories=[],hostPolicyMirrors=null,hostOwnership=null}){
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
  // The platform host policy gate (site/js/core/host-policy.js): an address-book profile always enables it - there is no
  // bypass. Its authority is this book's owner and anchor; the mirrors only carry candidate documents. The host-ownership
  // extension the policy binds is an EXPLICIT input (--host-ownership): it must be the one the signed policy names
  // (network/platform-host-policy-config.mjs, when published), and it is not inferred from the authority profile.
  let hostPolicy=null;
  if(addressBook!==null){
    if(!Array.isArray(hostPolicyMirrors)||!hostPolicyMirrors.length)
      throw Error('an address-book profile must enable the platform host policy: pass --host-policy-mirror <https origin> (2 or more independent mirrors recommended)');
    // the platform book's production extension (network/platform-host-policy-config.mjs PRODUCTION_HOST_OWNERSHIP) unless given
    if(hostOwnership==null&&addressBook.toLowerCase()===PLATFORM_BOOK)hostOwnership=PLATFORM_HOST_OWNERSHIP;
    if(typeof hostOwnership!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(hostOwnership)||/^0x0{40}$/i.test(hostOwnership))
      throw Error('an address-book profile needs --host-ownership <address>: the host-ownership extension the platform host policy binds');
    hostPolicy={book:addressBook.toLowerCase(),hostOwnership:hostOwnership.toLowerCase(),mirrors:hostPolicyMirrors};
  } else if((hostPolicyMirrors&&hostPolicyMirrors.length)||hostOwnership)throw Error('--host-policy-mirror / --host-ownership need --address-book: the policy authority is the address book');
  for(const d of directories)if(!/^https:\/\//.test(d))throw Error('directories must be HTTPS origins: a dashboard served over HTTPS cannot reach '+d);
  for(const d of capacityDirectories)if(!/^https:\/\//.test(d))throw Error('capacity directories must be HTTPS origins: a dashboard served over HTTPS cannot reach '+d);
  const out={format:PROFILE_FORMAT,version:1,name:name||'Base · authority profile '+digest.slice(7,19),chainId:profile.chainId,
    rpcs,quorum,confirmations,maxBlockAgeSeconds,
    contractPins:{version:1,chainId:pins.chainId,contracts},
    usdc:usdc.toLowerCase(),
    ...(addressBook !== null ? {addressBook} : {}),
    ...(ledgerHistory ? {ledgerHistory} : {}),
    ...(feed&&!/^0x0{40}$/i.test(feed)?{ethUsdFeed:feed.toLowerCase()}:{}),
    ...(storage?{storage}:{}),
    ...(directories.length?{directories}:{}),
    ...(capacityDirectories.length?{capacityDirectories}:{}),
    ...(hostPolicy?{hostPolicy}:{}),
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

/* The book's platform host policy anchor at the verified block, on every RPC (they must agree exactly). ->
   { state: "anchored", digest } | { state: "unanchored" }; a torn or malformed anchor throws (network/platform-host-policy.mjs). */
export async function readPolicyAnchor({clients,book,blockNumber}){
  const abi=parseAbi(['function addr(bytes32) view returns (address)']);
  const answers=await Promise.all(clients.map(async c=>JSON.stringify(await Promise.all([ANCHOR_KEYS.hi,ANCHOR_KEYS.lo].map(k=>
    c.readContract({address:book,abi,functionName:'addr',args:[k],blockNumber}).then(a=>a.toLowerCase()))))));
  if(new Set(answers).size!==1)throw Error('RPCs disagree about the host policy anchor at block '+blockNumber);
  const [hi,lo]=JSON.parse(answers[0]);
  return decodeAnchor(hi,lo);
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
    'storage-plan':{type:'string'},directory:{type:'string',multiple:true},'capacity-directory':{type:'string',multiple:true},'host-policy-mirror':{type:'string',multiple:true},'host-ownership':{type:'string'},name:{type:'string'},'address-book':{type:'string'},'ledger-history-from':{type:'string'},'log-span':{type:'string'},'verify-chain':{type:'boolean'},out:{type:'string'}},strict:true});
  for(const k of ['authority','expect-digest','expect-pins','out'])if(!values[k])throw Error('--'+k+' is required');
  if(!values['address-book'])console.error('note: a fixed profile has no platform host policy; on the Enclave platform network the dashboard then admits no host (use --address-book with --host-policy-mirror)');
  const authorityBytes=await readBounded(values.authority,MAX_PROFILE_BYTES,'authority profile');
  const expectPins=parseUniqueJSON((await readBounded(values['expect-pins'],16384,'expected pins')).toString('utf8'));
  const storage=values['storage-plan']?parseUniqueJSON((await readBounded(values['storage-plan'],16384,'storage plan')).toString('utf8')):null;
  if(values['ledger-history-from']!=null&&(!values['address-book']||!values['verify-chain']))
    throw Error('--ledger-history-from needs --address-book and --verify-chain (the history is read from the chain)');
  const args={authorityBytes,expectDigest:values['expect-digest'],expectPins,rpcs:values.rpc||[],quorum:int(values.quorum,'quorum',2),
    confirmations:int(values.confirmations,'confirmations',2),maxBlockAgeSeconds:int(values['max-block-age'],'max-block-age',600),
    storage,directories:values.directory||[],capacityDirectories:values['capacity-directory']||[],hostPolicyMirrors:values['host-policy-mirror']||null,hostOwnership:values['host-ownership']??null,name:values.name||'',addressBook:values['address-book']??null};
  let r=convert(args);
  if(values['verify-chain']){
    // an Enclave host's public RPC names its host: two origins of one host are one vote (network/public-rpc-hosts.mjs)
    for(const x of assertDistinctRpcHosts(await rpcHostIdentities(values.rpc||[])))
      console.error('rpc '+x.url+': '+(x.hostId?'Enclave host '+x.hostId+' (its own node)':'identity not stated (not an Enclave host RPC)'));
    const clients=rpcClients(values.rpc);
    const v=await verifyProfileOnChain({profile:r.profile,clients});
    console.error('authority profile matches the chain at block '+v.blockNumber+' ('+v.blockHash+')');
    if(r.browser.addressBook){
      const b=await verifyBookBinding({clients,browser:r.browser,blockNumber:BigInt(v.blockNumber)});
      console.error('address book '+r.browser.addressBook+' (administrator '+b.owner+') binds the original session factory at that block');
      const ownCode=await Promise.all(clients.map(c=>c.getCode({address:r.browser.hostPolicy.hostOwnership,blockNumber:BigInt(v.blockNumber)})));
      if(ownCode.some(x=>!x||x==='0x'))throw Error('--host-ownership '+r.browser.hostPolicy.hostOwnership+' has no code at block '+v.blockNumber);
      const anchor=await readPolicyAnchor({clients,book:r.browser.addressBook,blockNumber:BigInt(v.blockNumber)});
      if(anchor.state==='anchored')console.error('platform host policy anchored at that block: digest '+anchor.digest+' (the dashboard loads it from '+r.browser.hostPolicy.mirrors.join(', ')+')');
      else console.error('platform host policy NOT ACTIVATED at that block (the book anchors none): hosts are admitted as before until the administrator anchors a signed policy, which activates enforcement for this profile with no new release');
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
