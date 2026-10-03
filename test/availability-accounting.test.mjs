import test from 'node:test';import assert from 'node:assert/strict';
import {observeMarket} from '../availability/accounting.mjs';
const c={classId:'cpu',hostId:'h',hardwareId:'physical',operator:'op',payoutWallet:'pay',issuedSec:0n,expiresSec:2000n,units:100n,spareUnits:20n,minimumRate6:0n};
const s={classId:'cpu',hostId:'h',eventId:'tx:1',deploymentId:'job',owner:'customer',startSec:900n,endSec:1000n,shareMilli:500n,paid6:1n};
const a={classId:'cpu',nowSec:1000n,windowSec:100n,capacities:[c],services:[s],anchorRate6:10n,maxQueuedUnits:10000n,maxDemandPerOwnerUnits:10000n};
test('counts normalized full capacity and genuinely paid workload',()=>{
 const o=observeMarket(a);assert.equal(o.qualifiedSupplyUnits,10000n);assert.equal(o.paidDemandUnits,5000n);
});
test('verification and self-hosting cannot create demand',()=>{
 assert.equal(observeMarket({...a,verificationIds:new Set(['job'])}).paidDemandUnits,0n);
 assert.equal(observeMarket({...a,services:[{...s,owner:'pay'}]}).paidDemandUnits,0n);
 assert.equal(observeMarket({...a,services:[{...s,paid6:0n}]}).paidDemandUnits,0n);
});
test('duplicate event cannot inflate demand; overlapping intervals are refused',()=>{
 assert.equal(observeMarket({...a,services:[s,s]}).paidDemandUnits,5000n);
 assert.throws(()=>observeMarket({...a,services:[s,{...s,eventId:'tx:2'}]}),/overlapping/);
});
test('aliases cannot inflate supply and fresh certificates are not retroactive',()=>{
 assert.equal(observeMarket({...a,capacities:[c,{...c,hostId:'alias'}]}).qualifiedSupplyUnits,0n);
 assert.equal(observeMarket({...a,capacities:[c,c]}).qualifiedSupplyUnits,10000n);
 assert.equal(observeMarket({...a,capacities:[{...c,issuedSec:950n}]}).qualifiedSupplyUnits,0n);
});
test('expired and wrong-class capacity does not affect price',()=>{
 assert.equal(observeMarket({...a,capacities:[{...c,expiresSec:999n}]}).qualifiedSupplyUnits,0n);
 assert.equal(observeMarket({...a,capacities:[{...c,classId:'gpu'}]}).qualifiedSupplyUnits,0n);
});
test('queue weight is backed by money, deduplicated and capped',()=>{
 const q={id:'q',owner:'buyer',classId:'cpu',active:true,compatible:true,leased:false,requestedUnits:100000n,backedBalance6:100n};
 assert.equal(observeMarket({...a,queued:[q,q]}).queuedDemandUnits,10n);
 assert.equal(observeMarket({...a,queued:[{...q,backedBalance6:0n}]}).queuedDemandUnits,0n);
 assert.equal(observeMarket({...a,queued:[{...q,backedBalance6:10000000n}],maxQueuedUnits:20n}).queuedDemandUnits,20n);
});
test('dominant owner cannot unilaterally fill measured demand',()=>{
 assert.equal(observeMarket({...a,maxDemandPerOwnerUnits:100n}).paidDemandUnits,100n);
});
