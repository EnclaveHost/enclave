import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EgressMap} from '../network/egress-map.mjs';
test('startup routes require opt in and current authorization, and expire on revocation',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'egress-test-'));
 try{
  let until=20000;
  const circuit={healthy:false,egressReady:true,closed:false,egress:'127.0.0.1:1234'};
  const manager={apps:new Map([['startup',{id:'startup',startupEgress:true,circuits:[circuit]}],['ordinary',{id:'ordinary',circuits:[circuit]}]]),authorizationUntil:()=>until};
  const m=new EgressMap({directory,manager,dns:[{address:'1.1.1.1',serverName:'cloudflare-dns.com',path:'/dns-query'}],now:()=>10000});
  const map=await m.write();assert.deepEqual(Object.keys(map.apps),['startup']);assert.equal(map.expiresAt,20000);
  circuit.closed=true;assert.deepEqual((await m.write()).apps,{});
  circuit.closed=false;until=10000;assert.deepEqual((await m.write()).apps,{});
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
