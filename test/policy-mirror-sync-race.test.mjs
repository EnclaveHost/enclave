// policy-mirror sync race (hosted-policy-cold-start t2, 4106c311): sync() verified a snapshot of the store, then dropped
// every key of the CURRENT store its verification did not cover - so a document the admin POSTed while that verification
// was awaited was dropped as "not signed by the address book's current owner". Deterministic here: the REAL policy-mirror
// module, the REAL quorum snapshot over the loopback policy world (admin-signed documents, the book's owner and anchor read
// from its JSON-RPC fixture), and a snapshot wrapper that holds exactly the sync's verification while a publication lands.
// The owner, binding and anchor checks are exercised alongside, so the fix cannot pass by verifying less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startPolicyMirror } from '../network/host-services/policy-mirror.mjs';
import { quorumSnapshot } from '../network/host-policy-runtime.mjs';
import { policyTypedData, policyDigest } from '../network/platform-host-policy.mjs';
import { platformPolicyWorld, BOOK, OWNERSHIP } from './helpers/platform-policy-world.mjs';

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return Object.assign(p, { resolve }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rig(t, extra = {}) {
  const w = await platformPolicyWorld(t);
  const real = quorumSnapshot({ rpcs: w.rpcs });
  // hold(): the NEXT verification (and only it) waits at its chain read until released
  let held = null;
  const snapshot = async (fn) => { if (held) { const h = held; held = null; h.entered.resolve(); await h.release; } return real(fn); };
  const hold = () => { held = { entered: deferred(), release: deferred() }; return held; };
  const stateDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pm-race-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const logs = [];
  const start = async () => {
    const m = await startPolicyMirror({ port: 0, bind: '127.0.0.1', stateDir, rpc: w.rpcs, book: BOOK, hostOwnership: OWNERSHIP, syncSec: 3600, ...extra },
      { snapshot, log: (l) => logs.push(l) });
    t.after(() => m.close());
    const base = `http://127.0.0.1:${m.server.address().port}`;
    for (let i = 0; i < 100 && m.status().at === null && m.status().error === null; i++) await sleep(20);   // the startup sync settles first
    return { m, base };
  };
  const post = (base, doc) => fetch(base + '/platform-policy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
  const get = (base, d) => fetch(`${base}/platform-policy/${d}.json`).then((r) => r.status);
  return { w, hold, start, post, get, logs, stateDir };
}

test('a publication that lands while a sync verifies is kept; the sync judges only what it captured', { timeout: 60_000 }, async (t) => {
  const r = await rig(t);
  const d1 = await r.w.publish({ deny: [] });
  const d2 = await r.w.publish({ deny: [{ kind: 'operator', value: '0x' + '44'.repeat(20), reason: 'abuse' }] });   // the admin's ban
  r.w.anchor(d1);                                            // the ban is published to the carrier before it is anchored
  const { m, base } = await r.start();
  assert.equal((await r.post(base, r.w.document(d1))).status, 201);
  const h = r.hold();
  const syncing = m.sync();                                  // this sync captures { d1 } and waits at its chain read
  await h.entered;
  const res = await r.post(base, r.w.document(d2));          // the ban arrives meanwhile, verified on its own
  assert.equal(res.status, 201, await res.text());
  h.release.resolve(); await syncing;
  assert.equal(await r.get(base, d2), 200, 'the ban published during the sync is still carried');
  assert.equal(await r.get(base, d1), 200);
  assert.equal(m.status().documents, 2);
  assert.ok(!r.logs.some((l) => /dropped/.test(l)), r.logs.join('\n'));
  // after anchoring, a later sync keeps it as the anchored one
  r.w.anchor(d2); await m.sync();
  assert.equal(m.status().anchor, d2); assert.equal(m.status().anchoredAvailable, true);
});

test('the checks stand: a foreign-signed document is refused on publication and dropped from a stored copy; the anchored one is filled from importDir', { timeout: 60_000 }, async (t) => {
  const importDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pm-import-'));
  t.after(() => fs.rmSync(importDir, { recursive: true, force: true }));
  const r = await rig(t, { importDir });
  const d1 = await r.w.publish({ deny: [] });
  // the same content signed by someone who is not the book's owner
  const p = { ...JSON.parse(r.w.document(d1).document), sequence: 99 };
  const foreign = { document: JSON.stringify(p), signature: await privateKeyToAccount(generatePrivateKey()).signTypedData(policyTypedData(p)) };
  const fd = policyDigest(p);
  // a stored copy from an earlier run (as on disk), and the anchored document only in the operator's import
  fs.mkdirSync(path.join(r.stateDir, 'documents'), { recursive: true });
  fs.writeFileSync(path.join(r.stateDir, 'documents', `${fd}.json`), JSON.stringify({ ...foreign, sequence: 99 }));
  fs.writeFileSync(path.join(importDir, `${d1}.json`), JSON.stringify(r.w.document(d1)));
  const { m, base } = await r.start();                       // its startup sync re-verifies what it loaded
  assert.equal(await r.get(base, fd), 404, 'the foreign stored copy is dropped');
  assert.ok(r.logs.some((l) => l.includes(`dropped ${fd.slice(0, 18)}`) && /current owner/.test(l)), r.logs.join('\n'));
  assert.equal(await r.get(base, d1), 200, 'the anchored document comes from importDir');
  assert.equal(m.status().anchoredAvailable, true);
  const res = await r.post(base, foreign);
  assert.equal(res.status, 422, 'publication by a non-owner is refused');
  assert.equal(await r.get(base, fd), 404);
});
