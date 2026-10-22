// App-zone DNS-01 authorization (network/app-zone-challenge.mjs): what each provider route replica checks before it
// answers _acme-challenge.<label>.app.enclave.host for a direct guest's in-guest ACME. Synthetic SNP reports with the
// production judge in its explicit lab-unsigned mode; the chain is test/app-zone-fixture.mjs's deterministic ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createAppZoneAuthority, createLedgerIndex, appChallengeName, appLabel, appPushPreconditions} from '../network/app-zone-challenge.mjs';
import {judge} from '../isolation/m2/judge.mjs';
import * as F from './app-zone-fixture.mjs';

function rig({state = F.chainState(), mode = 'lab-unsigned', now} = {}) {
  const reader = F.fakeReader(state);
  const ledger = createLedgerIndex({reader, deployments: F.PINS.deployments, cooldownMs: 0});
  const auth = createAppZoneAuthority({zone: F.ZONE, measurements: new Set([F.MEAS]), judge, mode, kds: false, reader, pins: F.PINS, ledger, ...(now ? {now} : {})});
  const go = (p, method = 'POST') => auth.authorize({raw: p.body, sig: p.sig, method});
  return {state, reader, ledger, auth, go};
}

if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control: the suite must exit nonzero)', () => assert.fail('injected'));

test('an attested guest push for its own current, admitted, catalog-allowed deployment is accepted, bound and bounded', async () => {
  const r = rig(), key = F.guestKey(), p = F.appPush(key);
  const v = await r.go(p);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.name, `_acme-challenge.7ae476a3.${F.ZONE}`); assert.equal(v.value, p.value);
  assert.ok(v.ttlSec > 0 && v.ttlSec <= 120, 'TXT lifetime capped at 120 s');
  assert.equal(r.reader.calls >= 2, true, 'ledger index + one agreed chain read');
  // delete with the same proof
  const d = await r.go(F.appPush(key, {op: 'delete', value: p.value}), 'DELETE');
  assert.equal(d.ok, true, JSON.stringify(d));
});

test('refusals: cross-app, apex/wildcard/deeper names, wrong guest, replay, stale lease, banned host, catalog moderation', async () => {
  const key = F.guestKey(), other = F.guestKey();
  const order = (s) => ({url: 'https://ca.example/order/9', expires: Math.floor(Date.now() / 1000) + s});
  const cases = {
    "another deployment's label (cross-app)": [F.appPush(key, {name: appChallengeName(F.OTHER_DEP, F.ZONE)}), 403, /not this deployment/],
    'zone apex (wildcard certificate)': [F.appPush(key, {name: `_acme-challenge.${F.ZONE}`}), 403, /not this deployment/],
    'deeper name': [F.appPush(key, {name: `_acme-challenge.x.7ae476a3.${F.ZONE}`}), 403, /not this deployment/],
    'wildcard label': [F.appPush(key, {name: `_acme-challenge.*.${F.ZONE}`}), 403, /not this deployment/],
    'another zone': [F.appPush(key, {name: `_acme-challenge.7ae476a3.example.org`}), 403, /not this deployment/],
    "another deployment's HOST_DATA (wrong guest)": [F.appPush(key, {reportOpts: {hostData: F.OTHER_DEP}}), 403, /attestation/],
    'unpinned measurement (unadmitted front)': [F.appPush(key, {reportOpts: {measurement: '66'.repeat(48)}}), 403, /not pinned/],
    'signed by another key (host forging)': [F.appPush(key, {signer: other}), 401, /not signed/],
    'attested key differs from the named key': [F.appPush(key, {docKey: other}), 403, /no hardware attestation|attestation/],
    'attestation for a different push': [F.appPush(key, {nonceOverride: randomBytes(32)}), 403, /does not bind/],
    'value changed after signing': [F.appPush(key, {tamper: (s) => s.replace(/"value":"([^"]{5})/, '"value":"AAAAA')}), 401, /not signed/],
    'stale timestamp (replay after expiry)': [F.appPush(key, {ts: Math.floor(Date.now() / 1000) - 900}), 401, /window/],
    'expired ACME authorization': [F.appPush(key, {order: order(-10)}), 401, /expired/],
    'stale lease: another runner': [F.appPush(key, {lease: {runner: '0x' + 'ce'.repeat(32), operator: F.OPERATOR, appRef: F.APP_REF, envelope: F.ENVELOPE}}), 403, /stale/],
    'stale lease: another envelope': [F.appPush(key, {lease: {runner: F.RUNNER, operator: F.OPERATOR, appRef: F.APP_REF, envelope: 'old'}}), 403, /stale/],
    'previous owner': [F.appPush(key, {owner: '0x' + '99'.repeat(20)}), 403, /owner/],
    'not a dns-01 value': [F.appPush(key, {value: 'x'.repeat(44)}), 400, /dns-01/],
    'extra field': [F.appPush(key, {extra: {note: 1}}), 400, /exactly/],
  };
  for (const [what, [p, status, re]] of Object.entries(cases)) {
    const r = rig(), v = await r.go(p);
    assert.equal(v.ok, false, what); assert.equal(v.status, status, `${what}: ${v.why}`); assert.match(v.why, re, what);
  }
  // chain-state refusals on an otherwise perfect push
  const chainCases = {
    'lease released (no runner)': (s) => { s.deployments[F.DEP].runner = '0x' + '0'.repeat(64); s.deployments[F.DEP].runnerOperator = '0x' + '0'.repeat(40); },
    'lease expired': (s) => { s.deployments[F.DEP].leaseUntil = Math.floor(Date.now() / 1000) - 5; },
    'deployment suspended': (s) => { s.deployments[F.DEP].active = false; },
    're-leased to another host': (s) => { s.deployments[F.DEP].runner = '0x' + 'ce'.repeat(32); s.hosts['0x' + 'ce'.repeat(32)] = {operator: F.OPERATOR, active: true}; },
    'ownership transferred': (s) => { s.deployments[F.DEP].owner = '0x' + '99'.repeat(20); },
    'host banned by the platform (registry inactive)': (s) => { s.hosts[F.RUNNER].active = false; },
    'registry operator changed': (s) => { s.hosts[F.RUNNER].operator = '0x' + 'ef'.repeat(20); },
    'catalog app delisted': (s) => { s.apps['0x' + '66'.repeat(32)].active = false; },
    'catalog version yanked': (s) => { s.versions['0x' + '66'.repeat(32) + '/1'].yanked = true; },
    'catalog version rejected': (s) => { s.versions['0x' + '66'.repeat(32) + '/1'].approval = 2; },
    'pending version on a public deployment': (s) => { s.versions['0x' + '66'.repeat(32) + '/1'].approval = 0; },
    'ambiguous label (a ground prefix)': (s) => { s.ids.push('0x7ae476a3' + '99'.repeat(28)); },
  };
  for (const [what, mutate] of Object.entries(chainCases)) {
    const state = F.chainState(); mutate(state);
    const r = rig({state}), v = await r.go(F.appPush(key));
    assert.equal(v.ok, false, what); assert.ok([403].includes(v.status), `${what}: ${v.status} ${v.why}`);
  }
  // a PRIVATE deployment may use a pending version (the platform's own forPrivate rule), as at admission
  const priv = F.chainState(); priv.deployments[F.DEP].isPublic = false; priv.versions['0x' + '66'.repeat(32) + '/1'].approval = 0;
  assert.equal((await rig({state: priv}).go(F.appPush(key))).ok, true, 'private + pending is allowed exactly as admission allows it');
});

test('one-shot: an accepted push cannot be replayed to re-set a deleted value', async () => {
  const r = rig(), key = F.guestKey(), p = F.appPush(key);
  assert.equal((await r.go(p)).ok, true);
  assert.equal((await r.go(F.appPush(key, {op: 'delete', value: p.value}), 'DELETE')).ok, true);
  const again = await r.go(p);
  assert.equal(again.ok, false); assert.equal(again.status, 409); assert.match(again.why, /one-shot/);
  const asDelete = await r.go(p, 'DELETE');
  assert.equal(asDelete.status, 400, 'a set body cannot be sent as a delete');
});

test('no agreeing chain or an incomplete ledger index refuses (never assumes allowed or unique)', async () => {
  const key = F.guestKey(), state = F.chainState();
  const reader = F.fakeReader(state, {fail: true});
  const ledger = createLedgerIndex({reader, deployments: F.PINS.deployments, cooldownMs: 0});
  const auth = createAppZoneAuthority({zone: F.ZONE, measurements: new Set([F.MEAS]), judge, mode: 'lab-unsigned', kds: false, reader, pins: F.PINS, ledger});
  const v = await auth.authorize({raw: F.appPush(key).body, sig: F.appPush(key).sig, method: 'POST'});
  assert.equal(v.ok, false); assert.equal(v.status, 401, 'signature first: a push for another body is refused before any chain read');
  const p = F.appPush(key), w = await auth.authorize({raw: p.body, sig: p.sig, method: 'POST'});
  assert.equal(w.ok, false); assert.equal(w.status, 503); assert.match(w.why, /index is not complete/);
  // trusted mode (production) refuses synthetic, unsigned reports
  const t = rig({mode: 'trusted'}), x = await t.go(F.appPush(key));
  assert.equal(x.ok, false); assert.equal(x.status, 403); assert.match(x.why, /attestation/);
});

test('bounded: body size, ledger sync pages and the replica never trusts the label alone', async () => {
  const key = F.guestKey();
  const big = F.appPush(key, {extra: {pad: 'x'.repeat(40000)}});
  assert.equal(appPushPreconditions({raw: big.body, sig: big.sig, method: 'POST', zone: F.ZONE}).status, 413);
  const state = F.chainState(); for (let i = 0; i < 300; i++) state.ids.push('0x' + (0xa0000000 + i).toString(16) + '00'.repeat(28));
  const reader = F.fakeReader(state);
  const ledger = createLedgerIndex({reader, deployments: F.PINS.deployments, pageSize: 64, maxPagesPerSync: 2, cooldownMs: 0});
  await ledger.sync({force: true}); assert.equal(ledger.size(), 128, 'one sync reads at most pageSize*maxPagesPerSync ids');
  assert.equal(ledger.complete(), false);
  await ledger.sync({force: true}); await ledger.sync({force: true}); assert.equal(ledger.complete(), true);
  assert.equal(ledger.uniqueRefusal(F.DEP), null); assert.equal(appLabel(F.DEP), '7ae476a3');
  // a quorum that reports the same id at two positions: its label is ambiguous (refused), never merged away
  const dup = F.chainState(); dup.ids.push(F.DEP);
  const l2 = createLedgerIndex({reader: F.fakeReader(dup), deployments: F.PINS.deployments, cooldownMs: 0});
  await l2.sync({force: true}); assert.equal(l2.complete(), true); assert.match(l2.uniqueRefusal(F.DEP), /more than one/);
});
