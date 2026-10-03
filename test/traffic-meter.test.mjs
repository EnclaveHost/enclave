import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {TrafficMeter,bandwidthCost6} from '../network/traffic-meter.mjs';
const deploymentId='0x'+'ab'.repeat(32),policyHash='cd'.repeat(32);
test('cumulative byte pricing has no per-packet rounding or floating point error',()=>{
  assert.equal(bandwidthCost6(1073741824n,1000000n),1000000n);
  assert.equal(bandwidthCost6(1073741825n,1000000n),1000001n);
  assert.equal(bandwidthCost6(999999999999999999n,0n),0n);
});
test('concurrent sockets and restarts cannot reset or exceed the USDC spending cap',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'meter-')),debits=[];
  const options={directory,deploymentId,policyHash,terms:{pricePerGiB6:'1073741824',budget6:'10',expiresAt:2000},now:()=>1000,
    authorizeDebit:async value=>debits.push(value)};
  try{
    const meter=new TrafficMeter(options);
    const calls=await Promise.allSettled(Array.from({length:12},()=>meter.consume('out',1)));
    assert.equal(calls.filter(r=>r.status==='fulfilled').length,10);
    assert.equal(debits.at(-1).cumulativeCost6,'10');
    await assert.rejects(new TrafficMeter(options).consume('in',1),/exhausted/);
    assert.equal(debits.length,10);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('unbacked or expired authorizations admit no paid bytes, free self-hosting needs no payer',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'meter-'));
  const options={directory,deploymentId,policyHash,terms:{pricePerGiB6:'1',budget6:'10',expiresAt:2000},now:()=>1000};
  try{
    assert.throws(()=>new TrafficMeter(options),/settlement/);
    const meter=new TrafficMeter({...options,authorizeDebit:async()=>{throw Error('insufficient backed USDC');}});
    await assert.rejects(meter.consume('out',1),/insufficient/);
    const free=new TrafficMeter({...options,terms:{...options.terms,pricePerGiB6:'0',budget6:'0'}});
    assert.equal((await free.consume('in',1024)).cost6,'0');
    free.now=()=>2000;await assert.rejects(free.consume('in',1),/expired/);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
