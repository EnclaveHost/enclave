// netns e2e helper: ask a provider for a peer as a given key (probe as a checker, guard as a runner), print grant + keys.
import {randomBytes,generateKeyPairSync} from 'node:crypto';import {privateKeyToAccount} from 'viem/accounts';
import {peerRequestMessage} from '../../network/wg-provider/provider.mjs';
const [url,role,signerKey]=process.argv.slice(2);const account=privateKeyToAccount(signerKey);
const {privateKey,publicKey}=generateKeyPairSync('x25519');
const priv=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'),pub=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
const zero='0x'+'0'.repeat(64),probe=role==='probe';
const request={version:1,providerId:'aa'.repeat(16),role,deploymentId:probe?zero:'0x'+'ab'.repeat(32),runner:probe?zero:'0x'+'11'.repeat(32),wgPublicKey:pub,policy:null,
 ingress:probe,egress:probe,issuedAt:Date.now(),nonce:randomBytes(16).toString('hex'),expiresAt:Date.now()+300000};
const r=await fetch(url+'/v1/peer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature:await account.signMessage({message:peerRequestMessage(request)})})});
const b=await r.json();if(!r.ok){console.error(b.error);process.exit(1);}
console.log(JSON.stringify({priv,grant:b.grant}));
