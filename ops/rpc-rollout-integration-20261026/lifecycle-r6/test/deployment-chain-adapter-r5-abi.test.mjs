// r5: (A) the test doubles are proven to encode EXACTLY the actual reviewed ABIs the adapter and the real ledger decode
// (34a3c0d6 registry/catalog/address book, KVM dependencies-r1 closure getters, the production host-ownership read), and
// (B) the r2 coverage whose fake-ABI doubles broke in root 1369 (r2-corrected 1/7) is re-proved on the REAL candidate ledger.
// Replaced r2 cases (why): r2 TestRegistry returned an 11-field Enclave (actual 34a3 ABI: 13 fields, + caps, region), so every read
// misdecoded; r2 TestLedger hard-coded lifecycleOperator/lifecycleFunded/secondsFundable, so "paid horizon" asserted the F1 bug (now
// the r5-policy F1 real-ledger tests); setDeployment owner swaps are replaced by the real controller-gated transferDeployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { keccak256, parseAbi, toBytes } from 'viem';
import { useAnvil, world, step, mine, tx, read, S, HOST, LEDGER, LIFECYCLE, MAX_T, RESERVE, ZERO } from './fixtures/r5-world.mjs';
import { LEDGER_DEPENDENCIES } from '../network/deployment-chain-adapter.mjs';

useAnvil();
const J = f => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
const REVIEWED = J('../abi/dependencies-34a3c0d6.json').contracts, CLOSURE = J('../abi/dependencies-r1.json').contracts;
const canon = p => (p.type.startsWith('tuple') ? `(${p.components.map(canon).join(',')})${p.type.slice(5)}` : p.type);
const sig = f => `${f.name}(${f.inputs.map(canon)})->(${f.outputs.map(canon)})`;
const fn = (abi, name) => abi.filter(f => f.type === 'function' && f.name === name).map(sig);
const addressGetters = abi => abi.filter(f => f.type === 'function' && ['view', 'pure'].includes(f.stateMutability) && f.outputs.length &&
  f.outputs.every(o => o.type === 'address') && (f.inputs.length === 0 || (f.inputs.length === 1 && f.inputs[0].type === 'address'))).map(f => f.name);
const MAX = Number.MAX_SAFE_INTEGER;

test('the doubles encode exactly the actual reviewed ABIs (registry 13 fields, catalog, address book, closure getters incl. the authorityPins tuple, host ownership)', () => {
  const K = S.K, pairs = [['TestRegistry', REVIEWED.registry.abi, ['get', 'registrySchema']], ['TestCatalog', REVIEWED.catalog.abi, ['getApp', 'getVersion']],
    ['TestAddressBook', REVIEWED.addressBook.abi, ['all', 'addr', 'owner', 'pendingOwner']]];
  for (const [d, abi, names] of pairs) for (const n of names) assert.deepEqual(fn(K[d].abi, n), fn(abi, n), `${d}.${n}`);
  assert.equal(REVIEWED.registry.abi.find(f => f.name === 'get').outputs[0].components.length, 13);
  const closure = { connectivity: 'R4Connectivity', pinnedSessionAuthority: 'R4PinnedSessionAuthority', proofOfTime: 'R4ProofOfTime', secretVaultV2: 'R4SecretVaultV2',
    sessionVaultFactory: 'R4VaultFactory', sessionVaultImplementation: 'R4SessionVaultImplementation', verificationFees: 'R4VerificationFees' };
  for (const [k, d] of Object.entries(closure)) {
    const names = new Set([...addressGetters(CLOSURE[k].abi), ...(k === 'sessionVaultFactory' ? ['isVault'] : [])]);
    assert.ok(names.size > 0, k);
    for (const n of names) assert.deepEqual(fn(K[d].abi, n), fn(CLOSURE[k].abi, n), `${d}.${n}`);
  }
  assert.deepEqual(fn(CLOSURE.sessionVaultFactory.abi, 'authorityPins'), ['authorityPins()->(address,address,address)']);
  // the production host-ownership read (34a3 network/host-admission-policy.mjs, parsed from the pinned file itself)
  const src = fs.readFileSync(new URL('../network/host-admission-policy.mjs', import.meta.url), 'utf8');
  const prod = parseAbi([/parseAbi\(\['([^']+)'\]\)/.exec(src)[1]]);
  assert.deepEqual(fn(K.TestHostOwnership.abi, 'authority'), fn(prod, 'authority'));
  // the real ledger and controller artifacts are used as-is (no double): the adapter's ledger/controller reads come from them
  for (const f of ['get', 'rateFor', 'lifecycleOperator', 'lifecycleFunded', 'owner', 'pendingOwner']) assert.equal(fn(LEDGER.abi, f).length, 1, f);
});

test('real ledger decodes the actual 13-field registry; SessionVault-owned deployment: owner authority = vault owner; coherent same-block read', async () => {
  const w = await world({ ownedBy: 'vault' });
  assert.equal(await read(w.contracts.ledger, LEDGER.abi, 'lifecycleOwner', [w.id]), w.vault);
  assert.equal(await read(w.contracts.ledger, LEDGER.abi, 'lifecycleOperator', [w.id, HOST]), w.operator.address);   // real ledger, 13-field reply
  await step(w, 'queued', 'enroll'); await mine();
  const s = await w.adapter().read(w.id), head = await S.pub.getBlock({ blockTag: 'latest' });
  assert.deepEqual([s.verified, s.enabled, s.admitted, s.funded, s.assignment.state, s.assignment.generation, s.fundedUntil],
    [true, true, true, true, 'queued', 1, MAX]);
  assert.equal(s.ownerAuthority, w.human.address); assert.equal(s.blockAt, Number(head.timestamp) * 1000); assert.equal(s.blockHash, head.hash);
  assert.deepEqual(s.policy, { witnesses: w.witnesses.map(x => x.address), threshold: 3, maxAnchorAgeSec: 0, revision: 1,
    maxTransitionWei: MAX_T.toString(), stopReserveWei: RESERVE.toString() });
  assert.equal(s.generationAuthority, undefined);
});

test('each of the five primary dependencies bound to another (legacy) ledger is refused at runtime and statically', async () => {
  for (const k of Object.keys(LEDGER_DEPENDENCIES)) {
    const w = await world({ staleDep: k });
    await assert.rejects(w.adapter().read(w.id), new RegExp(`binding ${k}\\.${LEDGER_DEPENDENCIES[k]} differs`), k);
    const C = w.pins.contracts;
    assert.throws(() => w.adapter({ pins: { ...w.pins, contracts: { ...C, [k]: { ...C[k], bindings: { ...C[k].bindings, [LEDGER_DEPENDENCIES[k]]: 'legacyLedger' } } } } }),
      /must be THIS ledger/, k);
  }
});

test('host ban, measurement gate and catalog moderation set the right (global vs this-host) flags on the real ledger', async () => {
  const w = await world({}); await step(w, 'queued', 'enroll'); const r = () => w.adapter().read(w.id);
  const reg = e => tx(w.admin, w.contracts.registry, S.K.TestRegistry.abi, 'set', [HOST, w.enclave(e)]);
  await reg({ active: false });
  let s = await r(); assert.deepEqual([s.enabled, s.admitted, s.funded], [true, false, true]);     // a host ban never stops globally
  await reg({});
  s = await w.adapter({ pins: { ...w.pins, allowedMeasurements: [keccak256(toBytes('other'))] } }).read(w.id); assert.deepEqual([s.enabled, s.admitted], [true, false]);
  const cat = (a, v) => tx(w.admin, w.contracts.catalog, S.K.TestCatalog.abi, 'set', [w.app(a), w.ver(v)]);
  await cat({}, { yanked: true }); assert.equal((await r()).enabled, false);
  await cat({ active: false }, {}); assert.equal((await r()).enabled, false);
  await cat({}, {}); s = await r(); assert.deepEqual([s.enabled, s.admitted], [true, true]);
});

test('owner change through the real controller-gated transferDeployment disables globally (owner authority follows the ledger owner)', async () => {
  const w = await world({ deposit: false });
  assert.equal((await w.adapter().read(w.id)).enabled, true);
  await tx(w.human, w.contracts.ledger, LEDGER.abi, 'transferDeployment', [w.id, w.other.address]);
  const s = await w.adapter().read(w.id);
  assert.deepEqual([s.enabled, s.ownerAuthority], [false, w.other.address]);         // controller assignment still names the old owner
  assert.notEqual((await read(w.contracts.lifecycle, LIFECYCLE.abi, 'assignments', [w.id]))[0], ZERO);
});
