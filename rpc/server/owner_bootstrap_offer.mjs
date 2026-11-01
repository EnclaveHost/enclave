// Purpose-separated endpoint authentication, never a writer/root consent.
import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import net from 'node:net';
import {sha256} from '../../isolation/contract/rpc-bootstrap.mjs';
const fields=['attempt','challenge','clientCertificateSha256','credentialBlob','host','hostNonce','manifestSha256','port','requestSha256','runtime','schema','secret','serverCertificateSha256','serverName'];
export function offerBytes(o){
 if(!o||Object.keys(o).length!==fields.length||!fields.every(k=>Object.hasOwn(o,k))||!['enclave-rpc-owner-offer/1','enclave-rpc-owner-offer/2'].includes(o.schema)||!/^[0-9a-f]{32}$/.test(o.attempt))throw Error('exact owner endpoint offer required');
 for(const k of ['challenge','clientCertificateSha256','manifestSha256','requestSha256','runtime','serverCertificateSha256'])if(!/^[0-9a-f]{64}$/.test(o[k])||o[k]==='0'.repeat(64))throw Error('nonzero endpoint binding required');
 if(!net.isIP(o.host)||!Number.isInteger(o.port)||o.port<1024||o.port>65535||typeof o.serverName!=='string'||o.serverName.length>253||!o.serverName.split('.').every(x=>x.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)))throw Error('explicit endpoint required');
 for(const k of ['hostNonce','credentialBlob','secret']){const v=o[k];if(typeof v!=='string'||v.length>5464)throw Error('TPM offer bound');const b=Buffer.from(v,'base64');if(!b.length||b.length>4096||b.toString('base64')!==v||k==='hostNonce'&&b.length!==32)throw Error('canonical TPM offer required');}
 return Buffer.from(JSON.stringify(Object.fromEntries(fields.map(k=>[k,o[k]]))));
}
export function signOwnerOffer(offer,seeds,publicKeys){
 const raw=offerBytes(offer),digest=sha256(raw);
 if(!Array.isArray(seeds)||seeds.length!==2||!Array.isArray(publicKeys)||publicKeys.length!==2)throw Error('both provisioned owner keys required');
 const signatures=seeds.map((seed,role)=>{
  if(!Buffer.isBuffer(seed)||seed.length!==32)throw Error('exact provisioned owner seed required');
  const pkcs8=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]);
  try{
   const key=createPrivateKey({key:pkcs8,format:'der',type:'pkcs8'}),pub=createPublicKey(key).export({format:'der',type:'spki'});
   if(pub.length!==44||pub.subarray(12).toString('hex')!==publicKeys[role])throw Error('original owner key identity differs');
   return sign(null,Buffer.concat([Buffer.from('ENCLAVE-RPC-OWNER-ENDPOINT/1\0'),Buffer.from([role]),digest]),key).toString('hex');
  }finally{pkcs8.fill(0);}
 });
 return {base:signatures[1],l1:signatures[0],offer:JSON.parse(raw)};
}
