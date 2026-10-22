// Prepare the current reviewed creation request for a later explicit wallet handoff.
// No wallet, key access, RPC request, signature or transaction broadcast occurs here.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { reserveRequest } from './request.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url)));
const request=reserveRequest({
 pre:read('../../outputs/app-lease-gas-review/production-funding-preflight.json'),
 draft:read('../lease-gas-production-preflight/reserve-creation-draft.json'),
 simulation:read('../lease-gas-production-preflight/multicall-simulation.json'),
 mainSourceHash:createHash('sha256').update(fs.readFileSync(new URL('../enclave/contracts/EnclaveLeaseGasReserve.sol',import.meta.url))).digest('hex'),
});
// Always write a fresh filename so a pending request cannot be replaced by a new nonce.
const output=process.argv[2];if(!output)throw Error('usage: node prepare-reserve.mjs NEW_REQUEST_JSON');
fs.writeFileSync(output,JSON.stringify(request,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({file:output,status:request.status,expiresAt:request.expiresAt,value:'0 ETH',estimatedFeeLimitWei:request.estimatedFeeLimitWei}));
