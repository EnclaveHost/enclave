// END-TO-END: LeaseReader authority 'verifier' against the REAL platform contracts on a local chain (the
// cli-independent rig: schema-16 ledger, catalog with published apps, schema-4 registry; chain id 8453), through the
// patched Helios (branch enclave-base-evm: Base EVM over proof-backed state) and the witness gateway. Real consumers:
// deployment/lease snapshots, host admission + catalog moderation (createHostAdmission), admin AddressBook migration,
// settlement pinned reads; plus tampered proofs, missing witnesses, a stale head and unknown state.
// SYNTHETIC HEAD AUTHORITY: the local chain's blocks are signed by a TEST sequencer key (helios.toml override). The real
// Base head path is tested separately (helios-base-head.e2e) and real Base execution by helios-base-replay.e2e.
// ANVIL IS NOT A CANONICAL STATE TRIE: it keeps zero-valued storage slots as leaves (fixtures/anvil-zero-leaf-diag:
// a cleared slot and a zero written onto an unset slot both prove as an inclusion of 0x80; canonical clients delete
// them). The verifier REFUSES such proofs. The ledger, catalog and ownership contracts write zeros, so on anvil their
// verified reads must refuse - asserted here; positive consumer paths over those contracts need a canonical chain.
// AddressBook paths (no zero writes) are positive here.
// COMPOSED with the proof-aware gateway (witness-failover ce7c1b73), which serves no unverified witness: the gateway is
// given the witness-check helper and a root store, and the head feed pushes each signed head to the root store before
// serving it (the runtime's order). The feed signs each block's real parent beacon root, so a commitment's block hash
// matches its contents (the native listener verifies that; Helios alone does not).
//   env: HELIOS_BASE_BIN, WITNESS_CHECK_BIN, TEST_TMP. Needs anvil and contracts/foundry/out (as the rig does). Run inside `unshare -r -n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { stringToHex, pad, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { LeaseReader } from '../network/lease-reader.mjs';
import { createHostAdmission } from '../network/host-admission-runtime.mjs';
import { hostAdmissionPolicyHash } from '../network/host-admission-policy.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';

const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN } = process.env;
const skip = haveTools() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (!WITNESS_CHECK_BIN && 'WITNESS_CHECK_BIN not set');
// RIG_CHAIN_NODE=reth: canonical state tries -> the positive consumer paths over ledger/catalog/ownership run; on anvil
// (non-canonical zero leaves) the same reads must refuse.
const canonical = process.env.RIG_CHAIN_NODE === 'reth';
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'verifier-e2e-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'contracts/foundry/out');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rig, helios, heliosUrl, feed, proxy, gateway, reader, book, bookAbi, leaseId, miner, checker, roots;
const proxyMode = { value: 'ok' };

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
const heliosHead = async () => BigInt(await rpc(heliosUrl, 'eth_blockNumber'));
async function untilHelios(n, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await heliosHead() >= BigInt(n)) return; } catch {} await sleep(300); }
  throw new Error(`helios did not reach block ${n}`);
}
// the head source: every block of the local chain, in order, one per /latest poll, signed by the test sequencer key
function startFeed() {
  let served = 0n, current = null, frozen = false;
  const srv = http.createServer(async (q, res) => {
    if (q.url === '/chain_id') return res.end('8453');
    try {
      const latest = BigInt(await rig.rpcCall('eth_blockNumber'));
      if (served === 0n && latest > 3n) served = latest - 3n;     // start near the head, then every block in order
      if (!frozen && served < latest) {
        const n = served + 1n;
        const b = await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false]);
        const txs = await Promise.all(b.transactions.map((h) => rig.rpcCall('eth_getRawTransactionByHash', [h])));
        current = await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs, ...(b.parentBeaconBlockRoot ? { parentBeaconRoot: b.parentBeaconBlockRoot } : {}) });
        await roots.offer(current);     // bound before Helios can see the head
        served = n;
      }
    } catch {}
    res.end(JSON.stringify(current));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/`, freeze: (v) => { frozen = v; } })));
}
// the only witness source: forwards to the chain, or tampers with proven values, or is down
function startProxy() {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    if (proxyMode.value === 'down') { res.writeHead(503); return res.end(); }
    const up = await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    const j = await up.json();
    if (proxyMode.value === 'tamper') for (const x of [j].flat()) if (x?.result?.storageProof) for (const s of x.result.storageProof) s.value = '0x' + 'beef'.padStart(40, '1');
    res.end(JSON.stringify(j));
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  // blocks come only from this test: automine for writes, plus one block every 2 s (the head feed serves 1 block/s)
  if (!canonical) { await rig.setMining(false); await rig.rpcCall('evm_setAutomine', [true]); miner = setInterval(() => rig.mine(), 2000); }
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  const dep = rig.wc(KEYS.deployer);
  await rig.write(dep, book, bookAbi, 'set', [stringToHex('deployments', { size: 32 }), rig.addresses.ledger]);
  await rig.write(dep, book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]);
  const created = await rig.create(KEYS.owner);
  leaseId = rig.createdId(created);
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: seqSigner });
  roots = createRootStore({ checker });
  feed = await startFeed(); proxy = await startProxy();
  gateway = createWitnessGateway({ upstreams: [proxy.url], proofs: { checker, roots } }); const gUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  await untilHelios(created.blockNumber + 2n);    // a confirmed block past the deployment's creation
  reader = new LeaseReader({ authority: 'verifier', verifier: heliosUrl, addressBook: book, confirmations: 1, maxBlockAgeMs: 60000, deadlineMs: 30000 });
});
test.after(async () => {
  clearInterval(miner);
  helios?.kill('SIGKILL');
  await gateway?.close(); feed?.srv.close(); proxy?.srv.close(); checker?.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 240000 };
const waitTx = async (rc) => untilHelios(rc.blockNumber + 2n);

test('on anvil, verified reads of the ledger, catalog and ownership (zero-written slots) are REFUSED, never answered', { ...T, skip: skip || (canonical && 'canonical chain') }, async () => {
  await assert.rejects(reader.refresh([leaseId]), /invalid storage proof/);
  assert.equal(reader.get(leaseId), null, 'no unverified lease is admitted');
  const own = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [rig.addresses.registry]);
  const ownAbi = art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership').abi;
  await rig.write(rig.wc(KEYS.operator), own, ownAbi, 'proposeOwner', [rig.runner, rig.owner]);
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'acceptOwner', [rig.runner]));   // acceptOwner writes policyHash = 0
  const admission = createHostAdmission({ hostId: rig.runner, ownershipContract: own.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), catalog: rig.addresses.catalog.toLowerCase(),
    reader, loadPolicy: async () => { throw new Error('unused'); }, cacheMs: 0 });
  await assert.rejects(admission.refusal({ deploymentId: leaseId, appRef: `catalog://${rig.appId}/1` }), /invalid storage proof/);
});

const C = { ...T, skip: skip || (!canonical && 'needs a canonical-trie chain (RIG_CHAIN_NODE=reth)') };
test('deployment/lease snapshot through the verifier equals the chain record at the same block', C, async () => {
  const [lease] = await reader.refresh([leaseId]);
  assert.ok(lease, 'the deployment was read');
  assert.equal(lease.deployments, rig.addresses.ledger.toLowerCase(), 'resolved through the AddressBook');
  const direct = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.A.ledger.abi, functionName: 'get', args: [leaseId], blockNumber: BigInt(lease.blockNumber) });
  assert.equal(lease.owner.toLowerCase(), direct.owner.toLowerCase());
  assert.equal(lease.appRef, direct.appRef);
  assert.equal(lease.active, direct.active);
  assert.equal(String(lease.leaseUntil / 1000), String(direct.leaseUntil));
  const block = await rig.rpcCall('eth_getBlockByNumber', [toHex(BigInt(lease.blockNumber)), false]);
  assert.equal(lease.blockHash, block.hash);
  assert.equal(reader.lastEvidence.stateRoot, block.stateRoot.toLowerCase());
  assert.equal(reader.authorityInfo().tier, 'unsafe');
});

test('host admission and catalog moderation through the verifier follow owner policy, yanking and delisting', C, async () => {
  const own = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [rig.addresses.registry]);
  const ownAbi = art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership').abi;
  await rig.write(rig.wc(KEYS.operator), own, ownAbi, 'proposeOwner', [rig.runner, rig.owner]);
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'acceptOwner', [rig.runner]));
  const doc = { version: 1, chainId: 8453, ownershipContract: own.toLowerCase(), hostId: rig.runner, requireCatalogApproval: false, denyDeployments: [leaseId.toLowerCase()], denyAppRefs: [] };
  const admission = createHostAdmission({ hostId: rig.runner, ownershipContract: own.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), catalog: rig.addresses.catalog.toLowerCase(),
    reader, loadPolicy: async () => doc, cacheMs: 0 });
  const request = { deploymentId: leaseId, appRef: `catalog://${rig.appId}/1` };
  assert.equal(await admission.refusal(request), null, 'approved app, default owner policy');
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'setPolicy', [rig.runner, hostAdmissionPolicyHash(doc)]));
  assert.equal(await admission.refusal(request), 'this host owner declines this deployment');
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'setPolicy', [rig.runner, pad('0x', { size: 32 })]));
  assert.equal(await admission.refusal(request), null);
  await waitTx(await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.A.catalog.abi, 'yankVersion', ['hello', 1n]));
  assert.match(await admission.refusal(request), /yanked/);
  await waitTx(await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.A.catalog.abi, 'setActive', ['hello', false]));
  assert.match(await admission.refusal(request), /delisted/);
});

test('settlement reads at the lease snapshot block and lease failures on canonical state: tampered, missing, unknown', C, async () => {
  const [lease] = await reader.refresh([leaseId]);
  const owner = await reader.readAt({ blockNumber: lease.blockNumber, blockHash: lease.blockHash },
    (c, b) => c.readContract({ address: rig.addresses.ledger, abi: rig.A.ledger.abi, functionName: 'get', args: [leaseId], blockNumber: b }).then((d) => d.owner.toLowerCase()));
  assert.equal(owner, rig.owner.toLowerCase());
  // the rig's deployment is created but never claimed (leaseUntil 0): get() correctly serves no running lease for it,
  // so the verified record itself is compared
  assert.equal(reader.get(leaseId), null, 'an unclaimed deployment is not a running lease');
  const before = reader.cache.get(leaseId);
  for (const mode of ['tamper', 'down']) {
    proxyMode.value = mode;
    try {
      await untilHelios(BigInt(lease.blockNumber) + 3n);
      await assert.rejects(reader.refresh([leaseId]), /no fresh verified chain state/, mode);
      assert.equal(reader.cache.get(leaseId)?.blockHash, before.blockHash, 'the last verified record stands, unchanged');
      assert.equal(reader.get('0x' + '77'.repeat(32)), null, 'never verified, never admitted');
    } finally { proxyMode.value = 'ok'; }
  }
  assert.deepEqual(reader.hold(60000), [], 'unknown state: no hold for anything not running (only verified running leases are held)');
  assert.ok((await reader.refresh([leaseId]))[0], 'recovers once the source is honest again');
});

test('admin-directed AddressBook migration is followed; an outsider cannot repoint it', T, async () => {
  assert.equal(await reader.bookAddress('registry'), rig.addresses.registry.toLowerCase());
  await assert.rejects(rig.write(rig.wc(KEYS.other), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry5]));
  assert.equal(await reader.bookAddress('registry'), rig.addresses.registry.toLowerCase());
  await waitTx(await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry5]));
  assert.equal(await reader.bookAddress('registry'), rig.addresses.registry5.toLowerCase());
});

test('settlement pinned reads: anchor hashes and reads at the snapshot block are proof-backed', T, async () => {
  await reader.bookAddress('deployments');
  const pinned = reader.lastEvidence;
  const n = BigInt(pinned.blockNumber) - 1n;
  const real = (await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false])).hash;
  assert.equal(await reader.blockHashIs(n, real), true);
  assert.equal(await reader.blockHashIs(n, pad('0x1234', { size: 32 })), false);
  const ledger = await reader.readAt({ blockNumber: pinned.blockNumber, blockHash: pinned.blockHash },
    (c, b) => c.readContract({ address: book, abi: bookAbi, functionName: 'addr', args: [stringToHex('deployments', { size: 32 })], blockNumber: b }).then((a) => a.toLowerCase()));
  assert.equal(ledger, rig.addresses.ledger.toLowerCase());
  await assert.rejects(reader.readAt({ blockNumber: pinned.blockNumber, blockHash: pad('0x99', { size: 32 }) }, async () => 'x'), /no longer canonical/);
});

test('tampered proofs and a missing witness source refuse; the last verified lease stands; nothing new is admitted', T, async () => {
  assert.equal(await reader.bookAddress('deployments'), rig.addresses.ledger.toLowerCase());
  for (const mode of ['tamper', 'down']) {
    proxyMode.value = mode;
    try {
      await untilHelios(BigInt(reader.lastEvidence.blockNumber) + 3n);   // a NEW block: its witnesses must come from the source
      await assert.rejects(reader.bookAddress('deployments'), /no fresh verified chain state/, mode);
      assert.equal(reader.get('0x' + '77'.repeat(32)), null, 'never verified, never admitted');
    } finally { proxyMode.value = 'ok'; }
  }
  assert.equal(await reader.bookAddress('deployments'), rig.addresses.ledger.toLowerCase(), 'recovers once the source is honest again');
});

test('a stale head refuses fresh authority while the chain keeps moving', T, async () => {
  const strict = new LeaseReader({ authority: 'verifier', verifier: heliosUrl, addressBook: book, confirmations: 1, maxBlockAgeMs: 15000, deadlineMs: 20000 });
  assert.equal(await strict.bookAddress('deployments'), rig.addresses.ledger.toLowerCase());
  feed.freeze(true);
  try {
    await sleep(20000);                                          // blocks keep being mined; the verifier sees none of them
    await assert.rejects(strict.bookAddress('deployments'), /stale chain block/);
  } finally { feed.freeze(false); }
});
