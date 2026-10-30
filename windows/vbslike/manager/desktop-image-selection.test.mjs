import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ImageLauncher} from './shield-profile.mjs';

// Injected stub launchers: each records the spawns it was asked to start and carries a pin that must never change.
function stub(imageRole, {ok = true, checks = [{name: 'image-pin', ok: true}], delay = 0} = {}) {
  const l = {
    pin: 'sha256:' + (imageRole ?? 'unpinned'), starts: [], stops: [],
    boundary: 'boundary:' + imageRole, marker: 'shared-marker', prefix: 'shared-prefix',
    async start(mapping, opts) {
      l.starts.push({mapping, opts});
      await new Promise(r => setTimeout(r, delay));
      return {image: l.pin, name: mapping.name};
    },
    async preflight() { return {ok, checks}; },
    async survey() { return 'survey:' + imageRole; },
    async teardown() { return 'teardown:' + imageRole; },
    async stop(h) { l.stops.push(h); },
  };
  if (imageRole !== undefined) l.imageRole = imageRole;
  return l;
}
function launchers() {
  return {legacy: stub(undefined), shieldDirect: stub('shield-direct'), gpu: stub(undefined), desktop: stub('desktop')};
}
const totalStarts = ls => Object.values(ls).reduce((n, l) => n + (l?.starts.length ?? 0), 0);
const plain = {name: 'plain', record: {}};
const inference = {name: 'inference', record: {inference: {model: 'm', gpuMilli: 1000}}};
const pkg = {name: 'package', record: {}};
const desk = {name: 'desktop', record: {desktop: {profile: 'kvm-box-masked-v1', gpuMilli: 500}}};

test('every route reaches its own image; the desktop image only runs desktop mappings', async () => {
  const ls = launchers(), il = new ImageLauncher(ls);
  assert.equal(il.roleFor(plain), 'legacy');
  assert.equal(il.roleFor(inference), 'gpu');
  assert.equal(il.roleFor(pkg, {bootstrap: {owner: 'x'}}), 'shield-direct');
  assert.equal(il.roleFor(desk), 'desktop');
  assert.equal(il.roleFor({name: 'null-desktop', record: {desktop: null}}), 'legacy');
  assert.equal(il.roleFor({name: 'null-desktop-gpu', record: {desktop: null, inference: {}}}), 'gpu');
  assert.equal(il.roleFor({record: {desktop: {}, inference: null}}, {bootstrap: null, custody: undefined}), 'desktop');
  assert.equal((await il.start(plain)).image, ls.legacy.pin);
  assert.equal((await il.start(inference)).image, ls.gpu.pin);
  assert.equal((await il.start(pkg, {bootstrap: {owner: 'x'}})).image, ls.shieldDirect.pin);
  assert.equal((await il.start(desk)).image, ls.desktop.pin);
  assert.deepEqual(ls.desktop.starts.map(s => s.mapping), [desk]);
  assert.deepEqual(ls.legacy.starts.map(s => s.mapping), [plain]);
  assert.deepEqual(ls.gpu.starts.map(s => s.mapping), [inference]);
  assert.deepEqual(ls.shieldDirect.starts.map(s => s.mapping), [pkg]);
  // Shared inventory stays on the legacy launcher.
  assert.equal(await il.survey(), 'survey:undefined');
  assert.equal(await il.teardown(), 'teardown:undefined');
  await il.stop('vm-1');
  assert.deepEqual(ls.legacy.stops, ['vm-1']);
  assert.equal(ls.desktop.stops.length, 0);
  assert.equal(il.prefix, ls.legacy.prefix); assert.equal(il.marker, ls.legacy.marker); assert.equal(il.boundary, ls.legacy.boundary);
});

test('existing legacy/direct/GPU behaviour is unchanged without a desktop launcher', async () => {
  const ls = {legacy: stub('legacy'), shieldDirect: stub('shield-direct'), gpu: stub('gpu')};
  for (const il of [new ImageLauncher(ls), new ImageLauncher({...ls, desktop: null}), new ImageLauncher({...ls, desktop: undefined})]) {
    assert.equal(il.desktop, null);
    assert.equal(il.roleFor(plain), 'legacy');
    assert.equal(il.roleFor(inference), 'gpu');
    assert.equal(il.roleFor(pkg, {bootstrap: true}), 'shield-direct');
    await assert.rejects(il.start(inference, {bootstrap: true}), /GPU inference domain/);
  }
  const gpuless = new ImageLauncher({legacy: stub(undefined)});
  await assert.rejects(gpuless.start(inference), /no GPU image/);
  await assert.rejects(gpuless.start(pkg, {bootstrap: true}), /no Shield-direct image/);
});

test('a desktop mapping without a desktop launcher is refused and never falls back', async () => {
  const ls = {legacy: stub(undefined), shieldDirect: stub('shield-direct'), gpu: stub('gpu')};
  const il = new ImageLauncher(ls);
  assert.equal(il.roleFor(desk), 'desktop');
  await assert.rejects(il.start(desk), /no desktop image/);
  await assert.rejects(new ImageLauncher({legacy: ls.legacy}).start(desk), /no desktop image/);
  assert.equal(totalStarts(ls), 0);
});

test('a wrong or malformed desktop launcher and a wrongly-pinned GPU launcher are refused at construction', () => {
  const legacy = stub(undefined);
  for (const desktop of [stub(undefined), stub('legacy'), stub('gpu'), stub('shield-direct'), stub('Desktop'), stub(''),
    {imageRole: 'desktop'}, {imageRole: 'desktop', start() {}}, Object.assign([], stub('desktop')),
    true, false, 0, '', 'desktop', 1, () => {}])
    assert.throws(() => new ImageLauncher({legacy, desktop}), /desktop launcher/);
  for (const gpu of [stub('desktop'), stub('legacy'), stub(''), {imageRole: undefined, start() {}}, {imageRole: null, start() {}}])
    assert.throws(() => new ImageLauncher({legacy, gpu}), /GPU launcher/);
  assert.ok(new ImageLauncher({legacy, gpu: stub(undefined)}));
  assert.ok(new ImageLauncher({legacy, gpu: stub('gpu')}));
  // One launcher object cannot serve as the desktop image and another role.
  const d = stub('desktop');
  assert.throws(() => new ImageLauncher({legacy: d, desktop: d}), /legacy launcher/);
  assert.throws(() => new ImageLauncher({legacy, gpu: d, desktop: d}), /GPU launcher/);
  assert.throws(() => new ImageLauncher({legacy, shieldDirect: d, desktop: d}), /Shield-direct launcher/);
});

test('desktop mixed with inference, bootstrap or custody, or a malformed desktop value, is refused before any start', async () => {
  const cases = [
    [{record: {desktop: {}, inference: {model: 'm'}}}, {}, /GPU inference/],
    [{record: {desktop: {}, inference: false}}, {}, /GPU inference/],
    [{record: {desktop: {}, inference: 0}}, {}, /GPU inference/],
    [{record: {desktop: {}, inference: ''}}, {}, /GPU inference/],
    [{record: {desktop: {}}}, {bootstrap: {owner: 'x'}}, /owner-committed/],
    [{record: {desktop: {}}}, {bootstrap: false}, /owner-committed/],
    [{record: {desktop: {}}}, {bootstrap: 0}, /owner-committed/],
    [{record: {desktop: {}, custody: {}}}, {}, /custody/],
    [{record: {desktop: {}, custody: false}}, {}, /custody/],
    [{record: {desktop: {}}}, {custody: ''}, /custody/],
    [{record: {desktop: false}}, {}, /malformed/],
    [{record: {desktop: 0}}, {}, /malformed/],
    [{record: {desktop: ''}}, {}, /malformed/],
    [{record: {desktop: true}}, {}, /malformed/],
    [{record: {desktop: 'kvm-box-masked-v1'}}, {}, /malformed/],
    [{record: {desktop: []}}, {}, /malformed/],
    [{record: {desktop: false, inference: {}}}, {}, /malformed/],
    [{record: {desktop: 0}}, {bootstrap: true}, /malformed/],
  ];
  for (const withDesktop of [true, false]) {
    const ls = launchers(); if (!withDesktop) delete ls.desktop;
    const il = new ImageLauncher(ls);
    for (const [mapping, opts, re] of cases) {
      assert.throws(() => il.roleFor(mapping, opts), re);
      await assert.rejects(il.start(mapping, opts), re);
    }
    assert.equal(totalStarts(ls), 0);
  }
});

test('concurrent mixed spawns each take their own route and leave every pin unchanged', async () => {
  const ls = {legacy: stub(undefined, {delay: 5}), shieldDirect: stub('shield-direct', {delay: 1}), gpu: stub('gpu', {delay: 3}), desktop: stub('desktop', {delay: 2})};
  const before = Object.fromEntries(Object.entries(ls).map(([k, l]) => [k, {pin: l.pin, imageRole: l.imageRole}]));
  const il = new ImageLauncher(ls);
  const spawns = [];
  for (let i = 0; i < 8; i++) spawns.push(
    [{name: 'p' + i, record: {}}, {}, ls.legacy],
    [{name: 'g' + i, record: {inference: {gpuMilli: 500}}}, {}, ls.gpu],
    [{name: 'b' + i, record: {}}, {bootstrap: {owner: i}}, ls.shieldDirect],
    [{name: 'd' + i, record: {desktop: {gpuMilli: 500}}}, {}, ls.desktop],
    [{name: 'x' + i, record: {desktop: {}, inference: {}}}, {}, null]);
  const results = await Promise.allSettled(spawns.map(([m, o]) => il.start(m, o)));
  spawns.forEach(([m, , l], i) => {
    if (!l) return assert.equal(results[i].status, 'rejected');
    assert.equal(results[i].status, 'fulfilled');
    assert.deepEqual(results[i].value, {image: l.pin, name: m.name});
  });
  for (const [k, l] of Object.entries(ls)) {
    assert.deepEqual({pin: l.pin, imageRole: l.imageRole}, before[k]);
    assert.equal(l.starts.length, 8);
    assert.deepEqual(new Set(l.starts.map(s => s.mapping.name[0])).size, 1);
  }
  assert.deepEqual(ls.desktop.starts.map(s => s.mapping.name).sort(), [0, 1, 2, 3, 4, 5, 6, 7].map(i => 'd' + i));
  assert.equal(il.legacy, ls.legacy); assert.equal(il.gpu, ls.gpu); assert.equal(il.shieldDirect, ls.shieldDirect); assert.equal(il.desktop, ls.desktop);
});

test('desktop preflight is separate and cannot disable existing roles', async () => {
  const legacyResult = {ok: true, checks: [{name: 'image-pin', ok: true}, {name: 'hyperv', ok: true}]};
  const legacy = {...stub(undefined), preflight: async () => legacyResult};
  assert.equal(await new ImageLauncher({legacy}).preflight(), legacyResult);
  assert.equal(await new ImageLauncher({legacy, gpu: stub('gpu')}).preflight(), legacyResult);
  const desktopResult={ok:false,checks:[{name:'native-worker',ok:false}]};
  const desktop={...stub('desktop'),preflight:async()=>desktopResult};
  let r=await new ImageLauncher({legacy,desktop}).preflight();
  assert.equal(r.ok,true);assert.deepEqual(r.checks,legacyResult.checks);
  assert.equal(r.roles.desktop,desktopResult);
  const shieldDirect=stub('shield-direct',{ok:false,checks:[{name:'port-9446',ok:false}]});
  r=await new ImageLauncher({legacy,shieldDirect,desktop}).preflight();
  assert.equal(r.ok,false);assert.equal(r.roles.desktop.ok,false);
  assert.ok(r.checks.some(x=>x.name==='shield-direct image: port-9446'&&!x.ok));
  r=await new ImageLauncher({legacy,desktop:{...desktop,preflight:async()=>{throw Error('native probe failed');}}}).preflight();
  assert.equal(r.ok,true);assert.equal(r.roles.desktop.ok,false);
  assert.match(r.roles.desktop.checks[0].detail,/native probe failed/);
  r=await new ImageLauncher({legacy,desktop:{...desktop,preflight:async()=>undefined}}).preflight();
  assert.equal(r.ok,true);assert.equal(r.roles.desktop,undefined);
  r=await new ImageLauncher({legacy:{...legacy,preflight:async()=>({ok:false,checks:[]})},desktop:stub('desktop')}).preflight();
  assert.equal(r.ok,false);assert.equal(r.roles.desktop.ok,true);
});

test('native image must share the inventory and guest-state cleanup scope',()=>{
  for(const key of ['prefix','marker','guestStateRunDir','guestStateArchiveDir']){
    const ls=launchers();ls.desktop[key]='different';
    assert.throws(()=>new ImageLauncher(ls),new RegExp('share '+key));
  }
});
