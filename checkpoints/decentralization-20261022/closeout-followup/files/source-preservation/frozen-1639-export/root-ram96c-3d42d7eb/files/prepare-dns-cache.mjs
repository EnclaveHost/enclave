import fs from 'node:fs';
import {DNS} from '../enclavedns-stale-20261021/wallet-handoff/trust.mjs';
import {frozenWasm,carHeaderOf,verifyCar} from '../site-host-live-publish/handoff/site-upload.mjs';
const {bytes,dag}=frozenWasm(DNS);
function vi(n){let a=[];do{let b=n%128;n=Math.floor(n/128);a.push(b|(n?128:0));}while(n);return Buffer.from(a);}
const header=carHeaderOf(DNS.expectedCid),parts=[vi(header.length),header];
for(const[c,b]of dag.blocks){parts.push(vi(c.length+b.length),c,b);}
const car=Buffer.concat(parts),proof=verifyCar(DNS,car,dag),dir=new URL('./dns-artifact/',import.meta.url);fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(new URL(DNS.expectedCid+'.bin',dir),bytes);fs.writeFileSync(new URL(DNS.expectedCid+'.car',dir),car);
const receipt={at:new Date().toISOString(),cid:DNS.expectedCid,sha256:DNS.wasm.sha256,bytes:bytes.length,carBytes:car.length,...proof,source:'Already-published frozen EnclaveDNS0.1.5 release. Reconstructed exact UnixFS DAG, verified every CAR block and root.'};
fs.writeFileSync(new URL('./dns-artifact-proof.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
