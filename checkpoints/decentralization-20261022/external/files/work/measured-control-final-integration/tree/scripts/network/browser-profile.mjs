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
//     [--directory https://dir-a.example ...] [--name "..."] [--verify-chain] --out browser-profile.json
import fs from 'node:fs/promises';
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
export function convert({authorityBytes,expectDigest,expectPins,rpcs,quorum=2,confirmations=2,maxBlockAgeSeconds=600,storage=null,directories=[],name=''}){
  const {digest,profile}=parseProfile(authorityBytes,{expectedDigest:expectDigest});
  const pins=contractPinsFromProfile(profile);
  const expected=validateContractPins(expectPins);
  for(const k of Object.keys(expected))if(pins.contracts[k].toLowerCase()!==expected[k])
    throw Error('contract pin '+k+' in the authority profile ('+pins.contracts[k]+') differs from the expected pins ('+expected[k]+')');
  if(Object.keys(pins.contracts).length!==Object.keys(expected).length)throw Error('contract pin sets differ');
  const usdc=profile.contracts.usdc?.address;
  if(!usdc)throw Error('the authority profile pins no usdc');
  const feed=profile.contracts.deployments?.reviewedState?.ethUsdFeed;
  for(const d of directories)if(!/^https:\/\//.test(d))throw Error('directories must be HTTPS origins: a dashboard served over HTTPS cannot reach '+d);
  const out={format:PROFILE_FORMAT,version:1,name:name||'Base · authority profile '+digest.slice(7,19),chainId:profile.chainId,
    rpcs,quorum,confirmations,maxBlockAgeSeconds,
    contractPins:{version:1,chainId:pins.chainId,contracts:Object.fromEntries(Object.entries(pins.contracts).map(([k,v])=>[k,v.toLowerCase()]))},
    usdc:usdc.toLowerCase(),
    ...(feed&&!/^0x0{40}$/i.test(feed)?{ethUsdFeed:feed.toLowerCase()}:{}),
    ...(storage?{storage}:{}),
    ...(directories.length?{directories}:{}),
    source:{authorityProfileDigest:digest,reviewBlock:String(profile.review.blockNumber)}};
  validateBrowserProfile(out);                         // exactly what the dashboard will accept
  for(const u of rpcs)if(!/^https:\/\//.test(u))throw Error('RPCs must be HTTPS for a published browser profile: '+u);
  const text=JSON.stringify(out,null,2)+'\n';
  if(Buffer.byteLength(text)>PROFILE_MAX_BYTES)throw Error('browser profile too large');
  return {text,fingerprint:createHash('sha256').update(text).digest('hex'),authorityDigest:digest,profile};
}

async function main(){
  const {values}=parseArgs({options:{authority:{type:'string'},'expect-digest':{type:'string'},'expect-pins':{type:'string'},
    rpc:{type:'string',multiple:true},quorum:{type:'string'},confirmations:{type:'string'},'max-block-age':{type:'string'},
    'storage-plan':{type:'string'},directory:{type:'string',multiple:true},name:{type:'string'},'verify-chain':{type:'boolean'},out:{type:'string'}},strict:true});
  for(const k of ['authority','expect-digest','expect-pins','out'])if(!values[k])throw Error('--'+k+' is required');
  const authorityBytes=await readBounded(values.authority,MAX_PROFILE_BYTES,'authority profile');
  const expectPins=parseUniqueJSON((await readBounded(values['expect-pins'],16384,'expected pins')).toString('utf8'));
  const storage=values['storage-plan']?parseUniqueJSON((await readBounded(values['storage-plan'],16384,'storage plan')).toString('utf8')):null;
  const r=convert({authorityBytes,expectDigest:values['expect-digest'],expectPins,rpcs:values.rpc||[],quorum:int(values.quorum,'quorum',2),
    confirmations:int(values.confirmations,'confirmations',2),maxBlockAgeSeconds:int(values['max-block-age'],'max-block-age',600),
    storage,directories:values.directory||[],name:values.name||''});
  if(values['verify-chain']){
    const v=await verifyProfileOnChain({profile:r.profile,clients:rpcClients(values.rpc)});
    console.error('authority profile matches the chain at block '+v.blockNumber+' ('+v.blockHash+')');
  }
  await fs.writeFile(values.out,r.text,{flag:'wx',mode:0o644});
  console.log(JSON.stringify({out:values.out,fingerprint:'sha256:'+r.fingerprint,authorityProfileDigest:r.authorityDigest}));
  console.error('Publish this fingerprint through a channel users already trust; the dashboard asks for it before using the profile.');
}
if(import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error('browser-profile: '+e.message);process.exitCode=1;});
