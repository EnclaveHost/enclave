import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {createHash} from 'node:crypto';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
const m=JSON.parse(readFileSync('../../outputs/bootstrap-manifest.json')),inventory=JSON.parse(readFileSync('../adapter-public-inventory.after.json'));
const present=new Set(inventory.map(x=>x.cid)),account=privateKeyToAccount(generatePrivateKey()),log='../adapter-bootstrap-seeding.json';
const done=existsSync(log)?JSON.parse(readFileSync(log)):[];
for(const cid of m.cids){
 if(present.has(cid)||done.some(x=>x.cid===cid&&x.ok))continue;
 const bytes=readFileSync('../bootstrap-cas/'+cid+'.bin'),hash=createHash('sha256').update(bytes).digest('hex'),expiry=Math.floor(Date.now()/1000)+600;
 const signature=await account.signMessage({message:`enclave-upload:${hash}:${expiry}`});
 const a=await fetch('https://api.enclave.host/v1/apps/upload-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hash,expiry,signature}),signal:AbortSignal.timeout(20000)});if(!a.ok)throw Error('token issuer '+a.status);const auth=await a.json();
 console.log('seeding',cid,bytes.length);
 try{
  const wasm=bytes.subarray(0,4).equals(Buffer.from([0,97,115,109]));
  if(!wasm){const v=JSON.parse(bytes.toString('utf8'));if(!v||Array.isArray(v)||typeof v!=='object')throw Error('invalid config object');}
  const r=await fetch('https://7ae476a3.app.enclave.host/'+(wasm?'add-wasm':'add-json'),{method:'POST',headers:{'content-type':wasm?'application/wasm':'application/json','x-upload-address':auth.address,'x-upload-expiry':String(expiry),'x-upload-token':auth.token},body:bytes,signal:AbortSignal.timeout(360000)});
  const result=await r.json();if(!r.ok||result.cid!==cid)throw Error('CID/upload mismatch '+r.status+' '+JSON.stringify(result));
  done.push({cid,bytes:bytes.length,ok:true,at:new Date().toISOString()});console.log('verified upload CID',cid);
 }catch(e){done.push({cid,ok:false,error:e.message,at:new Date().toISOString()});writeFileSync(log,JSON.stringify(done,null,2));throw e;}
 writeFileSync(log,JSON.stringify(done,null,2));
}
