import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {NativeClient} from '../enclave/network/native-client.mjs';
import {probeGuest} from '../enclave/network/guest-probe.mjs';
const profile=JSON.parse(await fs.readFile(new URL('./isolated-client-profile.json',import.meta.url)));
let publicFetches=0,proofCalls=0;
const client=new NativeClient(profile,{fetch:(...a)=>{publicFetches++;return fetch(...a);},probe:(...a)=>{proofCalls++;return probeGuest(...a);}});
let refusal;
try{await client.request({path:'/ping'});throw Error('inactive deployment was accepted');}
catch(e){assert.match(e.message,/no current lease matching/);refusal=e.message;}
assert.equal(publicFetches,0);assert.equal(proofCalls,0);
const result={verifiedAt:new Date().toISOString(),deploymentId:profile.deploymentId,refusal,publicFetches,proofCalls,requestAccepted:false};
await fs.writeFile(new URL('./suspended-refusal.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
