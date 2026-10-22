import fs from 'node:fs';
import {leaseGasTransit} from '/home/steven/enclave-prod/metal-deabf8f90/metal/guest/lease-gas-conduit.bundle.mjs';
const p=JSON.parse(fs.readFileSync(new URL('./plan.json',import.meta.url)));
const t=leaseGasTransit(p.leaseGas,{readFile:f=>fs.readFileSync(f),chainId:8453});
if(t.relays.length!==1||t.relays[0]!=='https://134.209.248.172')throw Error('retired relay persists');
console.log(JSON.stringify({ok:true,chainId:t.chainId,relays:t.relays,quorum:t.quorum,rpcs:t.rpcs.length,recordDigest:t.digest}));
