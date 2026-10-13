#!/usr/bin/env node
// Set an app's Enclave-network policy as its owner, the way the Network tab does (docs/design/enclave-network.md):
//   ENCLAVE_KEY=<owner key> node scripts/network/owner-policy.mjs <deploymentId> '<policy fields JSON>' [--byo wg.conf] [--relay URL]
// The fields are merged over {mode, fallback, enclaveNetwork|byo|direct}; nonce = the relay's current + 1. With --byo the
// config is stored first (sealed on the relay; the policy carries only its salted digest). Prints the stored policy.
import fs from 'node:fs/promises';import {randomBytes} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {validateNetworkPolicy,networkPolicyMessage,byoConfigMessage} from '../../network/network-policy-core.mjs';
import {parseWireGuardConfig,wireGuardConfigDigest} from '../../network/wg-config.mjs';
const [id,fieldsJson]=process.argv.slice(2).filter(a=>!a.startsWith('--'));
const arg=n=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:undefined;};
const relay=arg('relay')||'https://api.enclave.host';
const account=privateKeyToAccount(process.env.ENCLAVE_KEY.startsWith('0x')?process.env.ENCLAVE_KEY:'0x'+process.env.ENCLAVE_KEY);
const call=async(p,body)=>{const r=await fetch(relay+p,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body&&JSON.stringify(body)});const b=await r.json();if(!r.ok)throw new Error(`${p}: ${b.error||r.status} ${JSON.stringify(b.problems||'')}`);return b;};
const cur=(await call('/v1/network/policy/'+id)).policy;
const next={version:5,deploymentId:id,nonce:cur.nonce+1,issuedAt:Math.floor(Date.now()/1000),fallback:'none',...JSON.parse(fieldsJson||'{}')};
if(arg('byo')){
 const text=await fs.readFile(arg('byo'),'utf8'),{config}=parseWireGuardConfig(text),salt=randomBytes(32).toString('hex');
 const digest=await wireGuardConfigDigest(salt,config),expiry=Math.floor(Date.now()/1000)+300;
 const stored=await call('/v1/network/byo/'+id,{config:text,salt,expiry,signature:await account.signMessage({message:byoConfigMessage({deploymentId:id,configDigest:digest,expiry})})});
 console.log('BYO config stored (sealed):',JSON.stringify(stored.redacted));
 next.byo={configDigest:digest,ingress:next.byo?.ingress||'enclave-network'};
}
validateNetworkPolicy(next);
const out=await call('/v1/network/policy/'+id,{envelope:{policy:next,signature:await account.signMessage({message:networkPolicyMessage(next)})}});
console.log(JSON.stringify(out.policy));
