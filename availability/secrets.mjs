import {encodeAbiParameters} from 'viem';
import {createHash} from 'node:crypto';
export function stageDeploymentSecrets({apiBase,account,fetchImpl=fetch,now=()=>Math.floor(Date.now()/1000),contractWallet=false}) {
 const base=new URL(apiBase);if(base.protocol!=='https:')throw new Error('HTTPS secret API required');
 return async(id,secrets)=>{
  if(!/^0x[0-9a-f]{64}$/.test(id))throw new Error('invalid deployment id');
  const payload=JSON.stringify({set:secrets}),expiry=now()+300;
  const message=`enclave-secrets:put:${id}:${expiry}:${createHash('sha256').update(payload).digest('hex')}`;
  const raw=await account.signMessage({message});
  const signature=contractWallet?encodeAbiParameters([{type:"string"},{type:"bytes"}],[message,raw]):raw;
  const result=await fetchImpl(new URL('/v1/secrets/'+id,base),{method:'POST',redirect:'error',
   signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json'},body:JSON.stringify({payload,expiry,signature,...(contractWallet?{signatureType:"erc1271"}:{})})});
  if(!result.ok)throw new Error(`secret staging HTTP ${result.status}`);
  return result.json();
 };
}
