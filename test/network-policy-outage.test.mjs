// An unreachable relay is not an answer about an app's network policy (network/enclave-network-host.mjs policyFor): the
// last policy it gave stays in force for up to 10 minutes, so a short outage does not revoke the app (2026-10-13 15:21Z).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createNetworkHost} from '../network/enclave-network-host.mjs';

test('a failed policy fetch keeps the last policy for ten minutes, then refuses',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'policy-outage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id='0x'+'7a'.repeat(32),lease={id,owner:'0x'+'11'.repeat(20)};
 let clock=1_800_000_000_000,down=false,calls=0;
 const fetch=async()=>{calls++;if(down)throw new TypeError('fetch failed');return new Response('{"error":"not_found"}',{status:404});};
 const host=await createNetworkHost({config:{relay:'http://127.0.0.1:9',checkers:['0x'+'22'.repeat(20)],apps:'all',wgBinary:'/bin/true',nodeBinary:process.execPath,workerModule:'/bin/true'},directory:dir,fetch,now:()=>clock});
 const first=await host.policyFor({deploymentId:id},lease);
 assert.ok(first,'the default policy while the owner has set none');
 down=true;clock+=60_000;
 assert.deepEqual(await host.policyFor({deploymentId:id},lease),first,'relay unreachable: the last answer stands');
 assert.equal(calls,2,'it did try the relay');
 clock+=9*60_000+1;
 await assert.rejects(host.policyFor({deploymentId:id},lease),/fetch failed/,'past ten minutes an outage is no longer bridged');
 down=false;
 assert.deepEqual(await host.policyFor({deploymentId:id},lease),first,'and a definite answer takes over again');
});
