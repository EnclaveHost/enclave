import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {AsnInventory} from '../network/asn-inventory.mjs';
test('ASN refresh falls back to an independent data source and rejects ambiguous origins',async()=>{
 const calls=[];const inv=new AsnInventory({file:'/unused/asn.json',fetchFn:async url=>{calls.push(url);if(url.includes('ripe'))throw Error('unavailable');return Response.json({Status:0,Answer:[{type:16,data:'"15169 | 8.8.8.0/24 | US | arin | 2020-01-01"'}]});}});
 assert.equal((await inv.lookup('8.8.8.8')).asn,15169);assert.equal(calls.length,2);
 inv.fetchFn=async()=>Response.json({data:{asns:[1,2]},Status:0,Answer:[{type:16,data:'"1 2 | 8.8.8.0/24"'}]});
 await assert.rejects(inv.lookup('8.8.8.8'),/ambiguous/);
});
test('an ASN service outage does not renew an expired mapping or erase a fresh sibling',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'asn-cache-')),file=path.join(directory,'asn.json');let now=1700000000000;
 try{
  await fs.writeFile(file,JSON.stringify({addresses:{'8.8.8.8':{asn:15169,expiresAt:now-1},'1.1.1.1':{asn:13335,expiresAt:now+1000}}}));
  const inv=new AsnInventory({file,now:()=>now,fetchFn:async()=>{throw Error('offline')}});
  assert.deepEqual(Object.keys(await inv.read()),['1.1.1.1']);await inv.refresh([{address:'8.8.8.8'}]);
  assert.equal((await inv.read())['8.8.8.8'],undefined);now+=1001;assert.deepEqual(await inv.read(),{});
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('legacy snapshot migration keeps untouched entries original expiry',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'asn-cache-')),file=path.join(directory,'asn.json');const now=1700000000000;
 try{
  await fs.writeFile(file,JSON.stringify({expiresAt:now+1000,addresses:{'8.8.8.8':{asn:15169},'1.1.1.1':{asn:13335}}}));
  const inv=new AsnInventory({file,now:()=>now,fetchFn:async()=>Response.json({data:{asns:[15169],prefix:'8.8.8.0/24'}})});
  await inv.refresh([{address:'8.8.8.8'}]);const result=await inv.read();assert.equal(result['1.1.1.1'].expiresAt,now+1000);assert.equal(result['8.8.8.8'].expiresAt,now+7*86400000);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
