// One-hop qualification: one signed request for an exit peer, sent to a provider's control port from where this runs
// (no guard in between). Prints "granted" or "refused: <the provider's answer>".
import fs from 'node:fs';import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {peerRequestMessage} from '../../../network/wg-provider/provider.mjs';
const [address,runnerKey,id,policyFile]=process.argv.slice(2);
const account=privateKeyToAccount(runnerKey);
const key=generateKeyPairSync('x25519').publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
const request={version:1,providerId:'aa'.repeat(16),role:'exit',deploymentId:id,runner:'0x'+'11'.repeat(32),wgPublicKey:key,policy:policyFile&&policyFile!=='-'?JSON.parse(fs.readFileSync(policyFile,'utf8')):null,
 ingress:true,egress:true,issuedAt:Date.now(),nonce:randomBytes(16).toString('hex'),expiresAt:Date.now()+600000};
const r=await fetch(`http://${address}:51822/v1/peer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature:await account.signMessage({message:peerRequestMessage(request)})})});
const b=await r.json();console.log(r.ok?'granted':'refused: '+b.error);
