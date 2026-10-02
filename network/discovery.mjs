// Trustless route distribution: an IPNS name chooses a small raw IPFS block;
// that block still needs the app/lease/delegation checks in route-record.mjs.
import {generateKeyPairFromSeed,publicKeyFromMultihash} from '@libp2p/crypto/keys';
import {createIPNSRecordWithExpiration,marshalIPNSRecord,unmarshalIPNSRecord} from 'ipns';
import {validate} from 'ipns/validator';
import {CID} from 'multiformats/cid';
import {base36} from 'multiformats/bases/base36';
import {sha256} from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import {canonical} from './route-record.mjs';

export async function namingKey(seed) {
 if(!(seed instanceof Uint8Array)||seed.length!==32)throw new Error('per-app 32-byte naming seed required');
 const key=await generateKeyPairFromSeed('Ed25519',seed);
 return {key,name:key.publicKey.toCID().toString(base36)};
}
export async function encodeDiscovery(bundle,seed) {
 const bytes=Buffer.from(canonical(bundle));if(bytes.length>32768)throw new Error('route block too large');
 const cid=CID.createV1(raw.code,await sha256.digest(bytes));
 const {key,name}=await namingKey(seed);
 if(bundle.authorization?.delegation?.ipns!==name)throw new Error('delegation does not authorize this IPNS name');
 const record=bundle.record;
 if(!Number.isSafeInteger(record?.sequence)||record.sequence<1||!Number.isSafeInteger(record.expiresAt)||record.expiresAt<=Date.now())throw new Error('expired or invalid route record');
 const ipns=marshalIPNSRecord(await createIPNSRecordWithExpiration(key,'/ipfs/'+cid.toString(),BigInt(record.sequence),new Date(record.expiresAt).toISOString(),{ttlNs:15000000000n}));
 return {name,cid:cid.toString(),bytes,ipns,sequence:String(record.sequence)};
}
export async function verifyIPNS(name,bytes,{now=Date.now()}={}) {
 if(!(bytes instanceof Uint8Array)||bytes.length>10240)throw new Error('oversized IPNS record');
 const identity=CID.parse(name,base36);
 if(identity.code!==0x72||identity.multihash.code!==0)throw new Error('inline Ed25519 IPNS identity required');
 const key=publicKeyFromMultihash(identity.multihash);
 if(key.type!=='Ed25519'||key.toCID().toString(base36)!==name)throw new Error('noncanonical IPNS name');
 await validate(key,bytes);
 const r=unmarshalIPNSRecord(bytes),expiresAt=Date.parse(r.validity);
 if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||typeof r.value!=='string'||!/^\/ipfs\/b[a-z2-7]+$/.test(r.value))throw new Error('invalid IPNS route target');
 const cid=CID.parse(r.value.slice(6));
 if(cid.version!==1||cid.code!==raw.code||cid.multihash.code!==sha256.code||cid.multihash.digest.length!==32)throw new Error('route target must be a SHA-256 raw block');
 return {cid:cid.toString(),sequence:r.sequence,expiresAt};
}
export async function verifyBlock(cidText,bytes) {
 if(!(bytes instanceof Uint8Array)||bytes.length>32768)throw new Error('oversized route block');
 const cid=CID.parse(cidText),computed=CID.createV1(raw.code,await sha256.digest(bytes));
 if(!cid.equals(computed))throw new Error('route block CID mismatch');
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function resolveDiscovery({name,readers=[],backupReaders=[],readBlock,verifyBundle,memory}) {
 if(!Array.isArray(readers)||!Array.isArray(backupReaders)||!readers.length&&!backupReaders.length||readers.length+backupReaders.length>8)throw new Error('1..8 independent discovery readers required');
 const attempts=await Promise.allSettled([
  ...readers.map(async read=>({name,...await verifyIPNS(name,await read(name))})),
  ...backupReaders.map(async read=>{
   const copy=await read(name);
   if(!copy||typeof copy.name!=='string'||name&&copy.name!==name||typeof copy.block!=='string'||copy.block.length>44000||typeof copy.ipns!=='string'||copy.ipns.length>14000)throw new Error('invalid discovery copy');
   const pointer=await verifyIPNS(copy.name,Buffer.from(copy.ipns,'base64'));
   if(pointer.cid!==copy.cid)throw new Error('discovery pointer CID mismatch');
   return {name:copy.name,...pointer,bytes:Buffer.from(copy.block,'base64')};
  })
 ]);
 const candidates=attempts.filter(a=>a.status==='fulfilled').map(a=>a.value).sort((a,b)=>a.sequence>b.sequence?-1:a.sequence<b.sequence?1:b.expiresAt-a.expiresAt);
 for(const candidate of candidates){
  try{
   const previous=await memory.get(candidate.name);
   if(previous&&candidate.sequence<BigInt(previous.sequence))continue;
   const bundle=await verifyBlock(candidate.cid,candidate.bytes||await readBlock(candidate.cid));
   if(bundle.authorization?.delegation?.ipns!==candidate.name)throw new Error('record is for another IPNS name');
   const verified=await verifyBundle(bundle);
   if(BigInt(bundle.record.sequence)!==candidate.sequence||bundle.record.expiresAt>candidate.expiresAt)throw new Error('route and IPNS sequence or lifetime mismatch');
   await memory.update(candidate.name,old=>{
    if(old&&(candidate.sequence<BigInt(old.sequence)||(candidate.sequence===BigInt(old.sequence)&&candidate.cid!==old.cid)))throw new Error('IPNS rollback or equivocation');
    return {sequence:String(candidate.sequence),cid:candidate.cid};
   });
   return verified;
  }catch{/* A withheld or corrupt copy cannot prevent another valid source. */}
 }
 throw new Error('no independently verified current route record');
}

// All transports are explicit callbacks. The host supplies guarded HTTPS or a
// guarded NKN wallet; no implicit public gateway or fallback direct dial exists.
export async function publishDiscovery(encoded,{blockStores,ipnsPublishers,publishBackup}) {
 const stores=await Promise.allSettled(blockStores.map(async put=>{
  const cid=await put(encoded.bytes,encoded.cid);if(cid!==encoded.cid)throw new Error('storage returned wrong CID');return cid;
 }));
 if(!stores.some(r=>r.status==='fulfilled'))throw new Error('no IPFS block store accepted the route');
 const publishers=await Promise.allSettled(ipnsPublishers.map(put=>put(encoded.name,encoded.ipns)));
 // An authenticated inline copy on NKN lets a client reconstruct and CID-check
 // the small block even when all configured HTTP gateways are unreachable.
 const backup=await publishBackup({name:encoded.name,cid:encoded.cid,block:encoded.bytes.toString('base64'),ipns:Buffer.from(encoded.ipns).toString('base64')});
 if(!publishers.some(r=>r.status==='fulfilled'))throw new Error('IPNS announcement failed; signed backup was retained');
 return {cid:encoded.cid,name:encoded.name,stores:stores.filter(r=>r.status==='fulfilled').length,publishers:publishers.filter(r=>r.status==='fulfilled').length,backup};
}
