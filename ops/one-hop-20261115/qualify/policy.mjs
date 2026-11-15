// One-hop qualification: an owner-signed network policy (version 5) for one deployment, guard true or false.
import fs from 'node:fs';import {privateKeyToAccount} from 'viem/accounts';
import {signNetworkPolicy} from '../../../network/network-policy.mjs';
const [ownerKey,id,guard,nonce,out]=process.argv.slice(2);
const env=await signNetworkPolicy(privateKeyToAccount(ownerKey),{version:5,deploymentId:id,nonce:Number(nonce),issuedAt:Date.now(),mode:'enclave-network',fallback:'none',enclaveNetwork:{routes:1,guard:guard==='true',maxPricePerGiB6:0,budget6:0}});
fs.writeFileSync(out+'.tmp',JSON.stringify(env));fs.renameSync(out+'.tmp',out);
