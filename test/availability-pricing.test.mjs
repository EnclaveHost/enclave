import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteVerification} from '../availability/pricing.mjs';
const policy = { enabled: true, classId: 'shield-cpu-reference-unit', anchorRate6: 1000n, maximumRate6: 4000n,
  maximumJobSpend6: 1_000_000n, minimumMultiplierPpm: 50_000n,
  maximumMultiplierPpm: 4_000_000n, maxObservationAgeSec: 3600n,
  quoteTtlSec: 60n, minimumDurationSec: 10n, maximumDurationSec: 600n,
  maxChangePpmPerHour: 500_000n };
const observation = { classId: 'shield-cpu-reference-unit', atSec: 10_000n,
  windowSec: 3600n, paidDemandUnits: 100n, qualifiedSupplyUnits: 100n };
const args = { observation, policy, nowSec: 10_000n, durationSec: 60n,
  availableBudget6: 1_000_000n, hostMinimumRate6: 0n, spareUnits: 1n };
const quote = changes => quoteVerification({...args, ...changes});
test('scarcity raises the offered price; oversupply lowers it', () => {
  assert.equal(quote({}).rate6, 1000n);
  assert.equal(quote({observation: {...observation, paidDemandUnits: 50n}}).rate6, 250n);
  assert.equal(quote({observation: {...observation, paidDemandUnits: 200n}}).rate6, 4000n);
  assert.equal(quote({observation: {...observation, paidDemandUnits: 0n}}).rate6, 50n);
});
test('extreme demand cannot exceed rate, job or actual funding caps', () => {
  const q = quote({observation: {...observation, paidDemandUnits: 10n**100n}, availableBudget6: 10000n});
  assert.equal(q.accepted, true); assert.equal(q.rate6, 166n);
  assert.ok(q.maximumSpend6 <= 10000n); assert.ok(q.rate6 <= policy.maximumRate6);
});
test('no funds or qualified spare resources means no offer, not unbacked rewards', () => {
  for (const c of [{availableBudget6:0n},{spareUnits:0n},
    {observation:{...observation,qualifiedSupplyUnits:0n}}]) assert.equal(quote(c).accepted,false);
});
test('the host may reject an offer below its floor', () => {
  assert.equal(quote({hostMinimumRate6: 1001n}).reason,'below host minimum');
});
test('freshness, class, ordering and duration fail closed', () => {
  for (const c of [{nowSec:14000n},{nowSec:9999n},{durationSec:9n},{durationSec:601n},
    {previous:{windowSec:3600n,classId:'other',atSec:9000n,rate6:1000n}},
    {previous:{windowSec:3600n,classId:observation.classId,atSec:10000n,rate6:1000n}}])
    assert.equal(quote(c).accepted,false);
});
test('new epochs limit price movement; repeated observations cannot ratchet', () => {
  const q = quote({observation:{...observation,paidDemandUnits:200n},
    previous:{windowSec:3600n,classId:observation.classId,atSec:6400n,rate6:1000n}});
  assert.equal(q.rate6,1500n);
  assert.equal(quote({previous:q}).accepted,false);
});
test('a changed payer cap immediately overrides smoothing and existing price', () => {
  const q = quote({policy:{...policy,maximumRate6:100n},
    previous:{windowSec:3600n,classId:observation.classId,atSec:9999n,rate6:4000n}});
  assert.equal(q.rate6,100n);
});
test('quotes are disabled by default unless explicitly enabled', () => {
  assert.equal(quote({policy:{...policy,enabled:false}}).reason,'disabled');
  assert.equal(quote({policy:{...policy,enabled:'true'}}).reason,'disabled');
  assert.equal(quote({policy:{...policy,classId:'other'}}).reason,'different resource class');
});
test('reject floats, negative values and malformed policies', () => {
  assert.throws(()=>quote({durationSec:60}),/bigint/);
  assert.throws(()=>quote({availableBudget6:-1n}),/bigint/);
  assert.throws(()=>quote({policy:{...policy,minimumMultiplierPpm:2_000_000n}}),/bounds/);
});
test('monotone rate over demand and inverse monotone over supply within fixed policy', () => {
  let last=0n;
  for(let d=0n;d<1000n;d++) {
    const q=quote({observation:{...observation,paidDemandUnits:d}});
    assert.ok(q.rate6>=last); assert.ok(q.maximumSpend6<=args.availableBudget6); last=q.rate6;
  }
  last=policy.maximumRate6;
  for(let s=1n;s<1000n;s++) {
    const q=quote({observation:{...observation,qualifiedSupplyUnits:s}});
    assert.ok(q.rate6<=last); last=q.rate6;
  }
});
