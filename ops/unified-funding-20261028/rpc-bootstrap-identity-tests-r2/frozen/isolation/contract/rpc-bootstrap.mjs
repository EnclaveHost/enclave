import {createHash} from 'node:crypto';
export const RPC_BOOTSTRAP_PURPOSE = 'enclave-rpc-storage-bootstrap/1';
const fields=['appId','baseVolume','boot','deadlineMonotonicNs','deployment','l1Volume','nonce','originMonotonicNs','profile','schema'];
const hash=x=>typeof x==='string' && /^[0-9a-f]{64}$/.test(x) && x!=='0'.repeat(64);
export const sha256=x=>createHash('sha256').update(x).digest();
export function rpcStorageRequestBytes(r) {
 if(!r || typeof r!=='object' || Array.isArray(r) || Reflect.ownKeys(r).length!==fields.length || !fields.every(k=>Object.hasOwn(r,k))) throw Error('exact storage request required');
 for(const k of ['appId','baseVolume','l1Volume','nonce','profile']) if(!hash(r[k])) throw Error('invalid request identity');
 if(r.schema!=='enclave-rpc-storage-acquire/1' || typeof r.deployment!=='string' || !r.deployment.startsWith('0x') || !hash(r.deployment.slice(2)) || r.baseVolume===r.l1Volume) throw Error('invalid request scope');
 if(typeof r.boot!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.boot) || /^0+$/.test(r.boot.replaceAll('-',''))) throw Error('invalid boot');
 if(!Number.isSafeInteger(r.originMonotonicNs) || r.originMonotonicNs<0 || !Number.isSafeInteger(r.deadlineMonotonicNs) || r.deadlineMonotonicNs-r.originMonotonicNs!==900000000000) throw Error('original exact bootstrap clock required');
 return Buffer.from(JSON.stringify(Object.fromEntries(fields.map(k=>[k,r[k]]))));
}
export function rpcBootstrapBinding({request,spki,certificate,challenge,runtime}) {
 const raw=rpcStorageRequestBytes(request);
 if(!Buffer.isBuffer(spki) || spki.length<32 || spki.length>4096 || !Buffer.isBuffer(certificate) || certificate.length===0 || certificate.length>16384 || !Buffer.isBuffer(challenge) || challenge.length!==32 || !challenge.some(x=>x) || !Buffer.isBuffer(runtime) || runtime.length!==32 || !runtime.some(x=>x)) throw Error('bounded bootstrap key, certificate, challenge and runtime required');
 return sha256(Buffer.concat([Buffer.from(RPC_BOOTSTRAP_PURPOSE+'\n'),sha256(raw),sha256(spki),sha256(certificate),challenge,runtime]));
}
