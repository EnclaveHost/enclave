// One supported direct-wallet upload; temporary identity has no funds or authority. Never stores its key/signature.
import fs from 'node:fs';
import {generatePrivateKey,privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
import {directUploadHeaders} from '../enclave/sdk/storage/upload-auth.mjs';
import {DNS} from '../enclavedns-stale-20261021/wallet-handoff/trust.mjs';
import {frozenWasm,readBounded,verifyCar} from '../site-host-live-publish/handoff/site-upload.mjs';
import {classifyUploadFailure} from './root-diagnostic/upload-diagnostic.mjs';
const here=new URL('.',import.meta.url), base=new URL('../enclavedns-stale-20261021/wallet-handoff/',import.meta.url);
const {bytes,dag}=frozenWasm(DNS);
const state=JSON.parse(fs.readFileSync(new URL('journals/upload.json',base)));
if(!['ready','awaiting-signature'].includes(state.status))throw Error('User upload is active; refused');
for(const k of ['publish','upgrade'])if(fs.existsSync(new URL('journals/'+k+'.json',base)))throw Error('Transaction workflow already started; refused');
const origin='https://7ae476a3.app.enclave.host',url=origin+'/add-wasm',audience='0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33';
const account=privateKeyToAccount(generatePrivateKey());
const headers=await directUploadHeaders({audience,url,address:account.address,bytes,signMessage:o=>account.signMessage(o)});
fs.writeFileSync(new URL('direct-attempt.json',here),JSON.stringify({at:new Date().toISOString(),url,artifact:DNS.wasm.sha256,cid:DNS.expectedCid,bytes:bytes.length,method:'supported EIP-191 direct upload, temporary unfunded identity, no chain transaction'},null,2)+'\n',{flag:'wx',mode:0o600});
try {
 const res=await fetch(url,{method:'POST',body:bytes,headers:{...headers,'content-length':String(bytes.length),'content-type':'application/wasm'},redirect:'error',signal:AbortSignal.timeout(300000)});
 const b=await readBounded(res,4096,'upload reply');
 if(!res.ok){const d=classifyUploadFailure(res.status,res.headers.get('server')||'',b.toString('utf8'));fs.writeFileSync(new URL('direct-result.json',here),JSON.stringify({status:'failed',diagnostic:d},null,2));console.log(JSON.stringify({status:'failed',diagnostic:d}));process.exit(1);}
 const answer=JSON.parse(b);if(answer.cid!==DNS.expectedCid)throw Error('CID differs');
 fs.writeFileSync(new URL('direct-upload-accepted.json',here),JSON.stringify({cid:answer.cid,at:new Date().toISOString(),httpStatus:res.status},null,2));
 const carRes=await fetch(DNS.upload.carUrl(DNS.expectedCid),{redirect:'error',signal:AbortSignal.timeout(90000)});
 if(carRes.status!==200)throw Error('Readback failed');
 const car=await readBounded(carRes,DNS.upload.maxCarBytes,'CAR');const proof=verifyCar(DNS,car,dag);
 const out={status:'verified',cid:DNS.expectedCid,artifactSha256:DNS.wasm.sha256,bytes:bytes.length,...proof,verifiedAt:new Date().toISOString(),source:DNS.upload.carUrl(DNS.expectedCid),uploadOrigin:origin,humanWalletUsed:false,chainTransactions:0};
 fs.writeFileSync(new URL('direct-result.json',here),JSON.stringify(out,null,2));console.log(JSON.stringify(out));
} catch(e) {fs.writeFileSync(new URL('direct-unknown.json',here),JSON.stringify({status:'unknown; do not repeat upload',errorType:e?.name||'Error',at:new Date().toISOString()},null,2));console.log('Upload/readback outcome unknown; inspect receipts and perform read-only reconciliation.');process.exitCode=2;}
