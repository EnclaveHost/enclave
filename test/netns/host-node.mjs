// netns e2e helper: the host's control plane for one circuit: guard grant, enclave-wg outer, exit grant through the
// guard, inner tunnel, then print the circuit (egress SOCKS) as JSON.
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {peerRequestMessage} from '../../network/wg-provider/provider.mjs';
const [wgBinary,guardAddr,exitAddr,operatorKey,ingressPort]=process.argv.slice(2);
const account=privateKeyToAccount(operatorKey);
const id='0x'+'ab'.repeat(32),runner='0x'+'11'.repeat(32);
const x25519=()=>{const {privateKey,publicKey}=generateKeyPairSync('x25519');return {priv:privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'),pub:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')};};
async function ask(url,role,key,extra){
 const request={version:1,providerId:'aa'.repeat(16),role,deploymentId:id,runner,wgPublicKey:key,policy:null,ingress:false,egress:false,issuedAt:Date.now(),nonce:randomBytes(16).toString('hex'),expiresAt:Date.now()+600000,...extra};
 const r=await fetch(url+'/v1/peer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature:await account.signMessage({message:peerRequestMessage(request)})})});
 const b=await r.json();if(!r.ok)throw new Error(role+': '+b.error);return b.grant;
}
const gk=x25519(),xk=x25519();
const g=await ask(`http://${guardAddr}:51822`,'guard',gk.pub);
const child=spawn(wgBinary,[],{stdio:['pipe','pipe','inherit']});
const lines=createInterface({input:child.stdout});const next=type=>new Promise((res,rej)=>{const f=l=>{const v=JSON.parse(l);if(v.type===type){lines.off('line',f);res(v);}else if(v.type==='down'){rej(new Error(v.error));}};lines.on('line',f);});
child.stdin.write(JSON.stringify({type:'outer',peer:{privateKey:gk.priv,publicKey:g.providerPublicKey,endpoint:g.endpoint,addresses:[g.clientAddress],mtu:1420,keepalive:25},control:`${exitAddr}:51822`,guardSocks:{listen:'127.0.0.1:0',only:[`${exitAddr}:443`,`${exitAddr}:80`]}})+'\n');
const outer=await next('outer-ready');
const x=await ask(`http://${outer.control}`,'exit',xk.pub,{ingress:true,egress:true});
const user=randomBytes(16).toString('hex'),pass=randomBytes(16).toString('hex');
child.stdin.write(JSON.stringify({type:'inner',peer:{privateKey:xk.priv,publicKey:x.providerPublicKey,endpoint:x.endpoint,addresses:[x.clientAddress],dns:['44.0.0.1'],mtu:1340,keepalive:25},
 egress:{user,pass},ingress:{'443':`127.0.0.1:${ingressPort}`,'80':`127.0.0.1:${ingressPort}`}})+'\n');
const ready=await next('ready');
console.log(JSON.stringify({egress:`${user}:${pass}@${ready.egress}`,guardSocks:outer.guardSocks,guard:g,exit:x}));
lines.on('line',l=>{const v=JSON.parse(l);if(v.type==='down'){console.error('[host] down',v.error);process.exit(1);}});
setInterval(()=>{},1e9);
