import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createPhysicalReservations, physicalReservationsFromEnv } from './physical-reservations.mjs';
const config = { command: 'C:\\owned\\physical-pool-command.exe', commandHash: 'a'.repeat(64), configPath: 'C:\\owned\\pool.txt', poolHash: 'b'.repeat(64), boot: 'c'.repeat(32) };
const claim = { poolHash: config.poolHash, boot: config.boot, actor: 'app-legacy', id: 'd'.repeat(64), bytes: 1048576 };
function deps(change = () => {}, calls = []) {
  return { platform: 'win32', installation: 'C:\\owned', imageHash: async () => config.commandHash, spawn(exe, argv, opts) {
    calls.push({ exe, argv, opts }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      const r = { schema: 'host-physical-pool-result/1', operation: argv[0], poolHash: argv[2], boot: argv[3], actor: argv[4], id: argv[5], bytes: Number(argv[6]), nonce: argv[7], imageHash: argv[10] };
      change(r, child); if (!child.killed) { child.stdout.write(JSON.stringify(r)+'\n'); child.emit('close', 0, null); }
    }); return child;
  } };
}
test('fixed command arguments and exact response are bound', async () => {
  const calls = [], p = createPhysicalReservations(config, deps(() => {}, calls));
  await p.acquire(claim); await p.consumeStart(claim);
  assert.equal(calls.length, 2); assert.equal(calls[0].exe, config.command); assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].argv[0], 'acquire'); assert.equal(calls[1].argv[0], 'consume'); assert.equal(Number(calls[0].argv[9])-Number(calls[0].argv[8]),5000);
});
test('wrong image refuses before spawn', async () => {
  const calls=[], p=createPhysicalReservations(config,{...deps(()=>{},calls),imageHash:async()=> 'e'.repeat(64)});
  await assert.rejects(p.acquire(claim),/hash mismatch/); assert.equal(calls.length,0);
});
test('response mismatch or extra fields never confirms a claim', async () => {
  for (const change of [r=>{r.nonce='0'.repeat(32);},r=>{r.bytes++;},r=>{r.extra=true;}]) {
    await assert.rejects(createPhysicalReservations(config,deps(change)).acquire(claim),/did not confirm/);
  }
});
test('busy transport refuses competing local launches before a second worker', async () => {
  let release; const calls=[], p=createPhysicalReservations(config,{...deps(()=>{},calls),imageHash:()=>new Promise(r=>{release=r;})});
  const first=p.acquire(claim); await assert.rejects(p.acquire({...claim,id:'e'.repeat(64)}),/occupied/);
  release(config.commandHash); await first; assert.equal(calls.length,1);
});
test('expired hash read cannot spawn with a renewed request window', async () => {
  let now=0;const calls=[],p=createPhysicalReservations(config,{...deps(()=>{},calls),clock:()=>now,imageHash:async()=>{now=5001;return config.commandHash;}});
  await assert.rejects(p.acquire(claim),/deadline/);assert.equal(calls.length,0);
});
test('oversized worker output poisons transport rather than admitting or retrying', async () => {
  const p=createPhysicalReservations(config,deps((r,c)=>c.stdout.write('x'.repeat(2049))));
  await assert.rejects(p.acquire(claim),/unconfirmed/);await assert.rejects(p.acquire(claim),/held/);
});
test('host configuration and app claim cannot choose another pool or role', async () => {
  assert.equal(physicalReservationsFromEnv({}),null);
  assert.throws(()=>physicalReservationsFromEnv({ENCLAVE_PHYSICAL_POOL_CONFIG:config.configPath}));
  for(const command of ['\\\\server\\pool.exe','C:\\owned\\..\\pool.exe','C:\\owned\\pool.exe:stream'])assert.throws(()=>createPhysicalReservations({...config,command},deps()));
  assert.throws(()=>createPhysicalReservations({...config,command:'C:\\writable\\physical-pool-command.exe'},deps()));
  const p=createPhysicalReservations(config,deps());
  for(const bad of [{actor:'rpc'},{boot:'e'.repeat(32)},{poolHash:'e'.repeat(64)},{bytes:1},{bytes:Number.MAX_SAFE_INTEGER+1}])await assert.rejects(p.acquire({...claim,...bad}),/invalid manager/);
});
