import fs from 'node:fs/promises';
import {RawArtifacts} from '../enclave/sdk/storage/raw-artifacts.mjs';
const client=new RawArtifacts({gateways:['http://127.0.0.1:1/ipfs','http://134.209.248.172:8189/ipfs','http://165.245.191.129:8189/ipfs']});
const receipt=await client.get('167f4fae8da1a13916df314f64534ed698b1807f12042e84b52b36b678ebb773',new URL('./app.bundle',import.meta.url).pathname);
await fs.writeFile(new URL('./bundle-receipt.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
