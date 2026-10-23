// LeaseReader authority 'verifier': the reader's semantics (block selection, freshness, monotonicity, reorg, one
// deadline, pinned proof-backed client, explicit refusals) and REAL consumers driven through it (deployment/lease
// snapshots, host admission + catalog moderation, admin-directed AddressBook migration, settlement pinned reads), with
// proof failure, missing witness, stale head and unknown state. The verifier here is an in-process stand-in that
// answers like the patched Helios (eth_* methods; errors where Helios refuses). Real Helios: lease-reader-verifier.e2e.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi, encodeFunctionResult, decodeFunctionData, pad, toHex, stringToHex } from 'viem';
import { LeaseReader, chainAuthorityOptions, chainAuthorityFromEnv } from '../network/lease-reader.mjs';
import { createHostAdmission } from '../network/host-admission-runtime.mjs';
import { hostAdmissionPolicyHash } from '../network/host-admission-policy.mjs';
import { USDCBandwidthSettlement } from '../network/usdc-bandwidth.mjs';

const BOOK = '0x' + 'b0'.repeat(20), LEDGER = '0x' + '1e'.repeat(20), LEDGER2 = '0x' + '2e'.repeat(20), CATALOG = '0x' + 'ca'.repeat(20);
const OWNERSHIP = '0x' + '0e'.repeat(20), REGISTRY = '0x' + 'ee'.repeat(20), METER = '0x' + 'ae'.repeat(20);
const HOST = '0x' + 'ab'.repeat(32), APP = '0x' + 'ef'.repeat(32), DEP = '0x' + 'cd'.repeat(32), OWNER = '0x' + '44'.repeat(20);
const fields = [['id','bytes32'],['owner','address'],['appRef','string'],['ports','string'],['configCid','string'],['gpuMilli','uint16'],['cpuMilli','uint16'],['appPort','uint32'],['isPublic','bool'],['active','bool'],['createdAt','uint64'],['rate','uint256'],['balance6','uint256'],['spent6','uint256'],['runner','bytes32'],['runnerOperator','address'],['leaseUntil','uint64']];
const ABI = {
  book: parseAbi(['function addr(bytes32) view returns (address)']),
  ledger: [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: fields.map(([name, type]) => ({ name, type })) }] },
    ...parseAbi(['function deploymentsSchema() view returns (uint256)'])],
  ownership: parseAbi(['function registry() view returns (address)', 'function authority(bytes32) view returns (address owner,address pendingOwner,uint64 revision,bytes32 policyHash)']),
  catalog: parseAbi(['function getApp(bytes32) view returns ((bytes32 appId,address publisher,string slug,string name,string description,uint32 versionCount,uint64 createdAt,uint64 updatedAt,bool active))',
    'function getVersion(bytes32,uint256) view returns ((string cid,string version,uint32 vramMb,uint32 gpuGflops,uint32 memMb,uint32 cpuGflops,uint64 createdAt,bool verified,bool yanked,string ports,uint8 approval,string config))']),
  meter: parseAbi(['function bytesServed(bytes32) view returns (uint256)']),
};
const NOW = 1_800_000_000_000;
const hash = (n, salt = 0) => pad(toHex(BigInt(n) * 1000n + BigInt(salt)), { size: 32 });

// A chain the stand-in verifier "proves": state can change at a block (admin repoints the book, moderation yanks).
function chain() {
  const st = { head: 100n, now: NOW, salt: new Map(), calls: [], mode: {}, at: {}, bookLedger: [[0n, LEDGER]], yankedFrom: null, deniedFrom: null, bytes: 7n };
  const numberOf = (h) => { for (let n = 0n; n <= st.head + 5n; n++) if (hash(n, st.salt.get(n) || 0) === h) return n; throw new Error('unknown block hash'); };
  const block = (n) => ({ number: toHex(n), hash: hash(n, st.salt.get(n) || 0), stateRoot: pad(toHex(n + 7n), { size: 32 }),
    timestamp: toHex(Math.floor(st.now / 1000) - Number(st.head - n) * 2 + (st.mode.future ? 3600 : 0) - (st.mode.oldBlocks ? 600 : 0)) });
  const current = (list, n) => list.filter(([from]) => from <= n).at(-1)[1];
  const answer = (to, data, n) => {
    const t = to.toLowerCase();
    const find = (abi) => { const d = decodeFunctionData({ abi, data }); return [abi, d]; };
    if (t === BOOK) { const [abi] = find(ABI.book); return encodeFunctionResult({ abi, functionName: 'addr', result: current(st.bookLedger, n) }); }
    if (t === LEDGER || t === LEDGER2) {
      const [abi, d] = find(ABI.ledger);
      if (d.functionName === 'deploymentsSchema') return encodeFunctionResult({ abi, functionName: 'deploymentsSchema', result: 15n });
      return encodeFunctionResult({ abi, functionName: 'get', result: { id: d.args[0], owner: OWNER, appRef: `catalog://${APP}/1`, ports: 'http:8080', configCid: '', gpuMilli: 0, cpuMilli: 100,
        appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 0n, balance6: 5n, spent6: 0n, runner: HOST, runnerOperator: OWNER, leaseUntil: BigInt(Math.floor(st.now / 1000) + 3600) } });
    }
    if (t === OWNERSHIP) {
      const [abi, d] = find(ABI.ownership);
      if (d.functionName === 'registry') return encodeFunctionResult({ abi, functionName: 'registry', result: REGISTRY });
      const denied = st.deniedFrom !== null && n >= st.deniedFrom;
      return encodeFunctionResult({ abi, functionName: 'authority', result: [OWNER, '0x' + '00'.repeat(20), denied ? 2n : 1n, denied ? st.policyHash : pad('0x', { size: 32 })] });
    }
    if (t === CATALOG) {
      const [abi, d] = find(ABI.catalog);
      if (d.functionName === 'getApp') return encodeFunctionResult({ abi, functionName: 'getApp', result: { appId: APP, publisher: OWNER, slug: 'a', name: 'A', description: '', versionCount: 2, createdAt: 1n, updatedAt: 1n, active: true } });
      const yanked = st.yankedFrom !== null && n >= st.yankedFrom;
      return encodeFunctionResult({ abi, functionName: 'getVersion', result: { cid: 'bafy', version: '1', vramMb: 0, gpuGflops: 0, memMb: 64, cpuGflops: 1, createdAt: 1n, verified: false, yanked, ports: 'http:8080', approval: 1, config: '{}' } });
    }
    if (t === METER) { const [abi] = find(ABI.meter); return encodeFunctionResult({ abi, functionName: 'bytesServed', result: st.bytes }); }
    throw new Error('execution reverted');
  };
  const verifier = {
    request: async (method, params) => {
      st.calls.push({ method, params });
      if (st.mode.hang) return new Promise(() => {});
      if (st.mode.down) throw new Error('verifier HTTP 502');
      switch (method) {
        case 'eth_chainId': return toHex(st.mode.wrongChain ? 10 : 8453);
        case 'eth_blockNumber': if (st.mode.stale) throw new Error('verifier: out of sync: 125 seconds behind'); return toHex(st.head);
        case 'eth_getBlockByNumber': {
          const n = BigInt(params[0]);
          if (st.mode.reorgOnce && st.calls.filter((c) => c.method === 'eth_getBlockByNumber').length === 2) { st.salt.set(n, 9); st.mode.reorgOnce = false; }
          return n <= st.head ? block(n) : null;
        }
        case 'eth_call': {
          if (st.mode.proofFail) throw new Error('verifier: invalid account proof for address ' + params[0].to);
          if (st.mode.missing) throw new Error('verifier: no witness source answered');
          assert.ok(params[1]?.blockHash, 'calls are pinned by block hash');
          return answer(params[0].to, params[0].data, numberOf(params[1].blockHash));
        }
        case 'eth_getCode': return '0x6000';
        case 'eth_getStorageAt': return pad('0x2a', { size: 32 });
        case 'eth_getBalance': return '0x10';
        default: throw new Error('method not supported');
      }
    },
  };
  return { st, verifier };
}
const reader = (verifier, opts = {}) => new LeaseReader({ authority: 'verifier', verifier, addressBook: BOOK, now: () => NOW, confirmations: 2, ...opts });
const T = { timeout: 20000 };

test('construction: the verifier is explicit, local, exclusive, and never mixed with provider clients', () => {
  const { verifier } = chain();
  assert.throws(() => new LeaseReader({ verifier, addressBook: BOOK }), /authority is quorum/);
  assert.throws(() => new LeaseReader({ authority: 'verifier', verifier: 'https://rpc.example.org', addressBook: BOOK }), /local endpoint/);
  assert.throws(() => new LeaseReader({ authority: 'verifier', addressBook: BOOK }), /verifier endpoint/);
  // a shared chain config that also lists provider RPCs: they are ignored, no client exists
  const r = new LeaseReader({ authority: 'verifier', verifier, rpc: ['https://a.example.org', 'https://b.example.org'], addressBook: BOOK });
  assert.equal(r.clients.length, 0);
  assert.equal(r.authorityInfo().authority, 'local-verifier');
  assert.equal(r.authorityInfo().tier, 'unsafe');
  const q = new LeaseReader({ rpc: ['https://a.example.org', 'https://b.example.org'], addressBook: BOOK });
  assert.equal(q.authority, 'quorum');
  assert.equal(q.authorityInfo().independentOfProviders, false);
  assert.deepEqual(chainAuthorityOptions({}), {});
  assert.deepEqual(chainAuthorityOptions({ chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' }), { authority: 'verifier', verifier: 'http://127.0.0.1:8545/' });
  assert.throws(() => chainAuthorityOptions({ chainVerifier: 'http://127.0.0.1:8545/' }), /not verifier/);
  assert.throws(() => chainAuthorityOptions({ chainAuthority: 'verifier' }), /needs chainVerifier/);
  assert.deepEqual(chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:1/' }).authority, 'verifier');
});

test('deployment/lease snapshot: one confirmed block, pinned by hash, fresh, with verified evidence', T, async () => {
  const { st, verifier } = chain();
  const r = reader(verifier);
  const [lease] = await r.refresh([DEP]);
  assert.equal(lease.id, DEP);
  assert.equal(lease.blockNumber, '98');
  assert.equal(lease.blockHash, hash(98n));
  assert.equal(lease.deployments, LEDGER);
  assert.equal(r.lastEvidence.stateRoot, pad(toHex(105n), { size: 32 }));
  for (const c of st.calls.filter((x) => x.method === 'eth_call')) assert.deepEqual(c.params[1], { blockHash: hash(98n) });
  assert.ok(!st.calls.some((c) => c.method === 'eth_call' && c.params[1] === 'latest'));
});

test('admin-directed migration: a repointed AddressBook entry is followed at the next fresh read', T, async () => {
  const { st, verifier } = chain();
  const r = reader(verifier);
  assert.equal(await r.bookAddress('deployments'), LEDGER);
  st.bookLedger.push([101n, LEDGER2]); st.head = 104n;            // the admin repointed at block 101
  assert.equal(await r.bookAddress('deployments'), LEDGER2);
  const [lease] = await r.refresh([DEP]);
  assert.equal(lease.deployments, LEDGER2);
});

test('freshness, monotonicity, chain, reorganization and the single deadline all refuse', T, async () => {
  let { st, verifier } = chain();
  let r = reader(verifier);
  st.mode.oldBlocks = true;
  await assert.rejects(r.refresh([DEP]), /stale chain block/);
  st.mode.oldBlocks = false; st.mode.future = true;
  await assert.rejects(r.refresh([DEP]), /stale chain block/);
  st.mode.future = false; st.mode.stale = true;                      // Helios check_head_age: head older than 60 s
  await assert.rejects(r.refresh([DEP]), /out of sync/);
  st.mode.stale = false; st.mode.wrongChain = true;
  await assert.rejects(r.refresh([DEP]), /another chain/);
  st.mode.wrongChain = false;
  await r.refresh([DEP]);
  st.head = 90n;                                                     // a verifier that went backwards
  await assert.rejects(r.refresh([DEP]), /behind block 98/);
  ({ st, verifier } = chain()); r = reader(verifier);
  st.mode.reorgOnce = true;
  await assert.rejects(r.refresh([DEP]), /reorganized/);
  ({ st, verifier } = chain()); r = reader(verifier, { deadlineMs: 300 });
  st.mode.hang = true;
  const t0 = Date.now();
  await assert.rejects(r.refresh([DEP]), /timed out|deadline/);
  assert.ok(Date.now() - t0 < 2000, 'one total deadline');
});

test('inside a read: only proof-backed methods at the pinned block; anything else refuses by name', T, async () => {
  const { verifier } = chain();
  const r = reader(verifier);
  for (const bad of [(c) => c.getLogs({}), (c) => c.multicall({ contracts: [] }), (c) => c.request({ method: 'eth_call' }), (c) => c.call({}), (c) => c.getTransactionReceipt({})])
    await assert.rejects(r.agreed(async (c) => ({ x: await bad(c) })), /not available under the verifier authority/);
  await assert.rejects(r.agreed(async (c, b) => ({ x: await c.readContract({ address: BOOK, abi: ABI.book, functionName: 'addr', args: [stringToHex('registry', { size: 32 })], blockNumber: b - 1n }) })), /pinned to block/);
  await assert.rejects(r.agreed(async (c) => ({ x: await c.getCode({ address: BOOK, blockTag: 'latest' }) })), /no block tags/);
  const ok = await r.agreed(async (c, b) => ({ code: await c.getCode({ address: BOOK, blockNumber: b }), word: await c.getStorageAt({ address: BOOK, slot: '0x0', blockNumber: b }), bal: String(await c.getBalance({ address: OWNER, blockNumber: b })) }));
  assert.deepEqual([ok.code, ok.bal], ['0x6000', '16']);
});

test('proof failure, missing witness or an unreachable verifier: refused, cache untouched, nothing newly admitted', T, async () => {
  const { st, verifier } = chain();
  const r = reader(verifier);
  const [lease] = await r.refresh([DEP]);
  for (const mode of ['proofFail', 'missing', 'down']) {
    st.mode = { [mode]: true };
    await assert.rejects(r.refresh([DEP]), /no fresh verified chain state/);
    assert.equal(r.get(DEP).blockHash, lease.blockHash, 'the last verified answer stands, unchanged');
    await assert.rejects(r.refresh(['0x' + '99'.repeat(32)]));
    assert.equal(r.get('0x' + '99'.repeat(32)), null, 'never-verified deployment is not admitted');
  }
  // unknown state: the existing outage hold is bounded by the lease and the grace, and only for leases already verified
  assert.deepEqual(r.hold(60000), [DEP]);
});

test('host admission + catalog moderation through the verifier: approve, yank, owner policy, and failures refuse', T, async () => {
  const { st, verifier } = chain();
  const r = reader(verifier);
  const doc = { version: 1, chainId: 8453, ownershipContract: OWNERSHIP, hostId: HOST, requireCatalogApproval: false, denyDeployments: [DEP], denyAppRefs: [] };
  st.policyHash = hostAdmissionPolicyHash(doc);
  const admission = createHostAdmission({ hostId: HOST, ownershipContract: OWNERSHIP, registry: REGISTRY, catalog: CATALOG, reader: r, loadPolicy: async () => doc, now: () => NOW, cacheMs: 0 });
  const request = { deploymentId: DEP, appRef: `catalog://${APP}/1` };
  assert.equal(await admission.refusal(request), null);
  st.yankedFrom = 101n; st.head = 103n;                                       // platform moderation: the version is yanked
  assert.match(await admission.refusal(request), /yank/i);
  st.yankedFrom = null; st.deniedFrom = 104n; st.head = 106n;                 // the host owner commits a deny policy
  assert.equal(await admission.refusal(request), 'this host owner declines this deployment');
  st.mode = { proofFail: true }; st.head = 108n;
  await assert.rejects(admission.refusal(request), /no fresh verified chain state/);
  st.mode = { missing: true };
  await assert.rejects(admission.refusal(request), /no fresh verified chain state/);
  st.mode = { stale: true };
  await assert.rejects(admission.refusal(request), /out of sync/);
});

test('settlement pinned reads: anchors and metered bytes at the snapshot block, verified or refused', T, async () => {
  const { st, verifier } = chain();
  const r = reader(verifier);
  const [lease] = await r.refresh([DEP]);
  assert.equal(await r.blockHashIs(95n, hash(95n)), true);
  assert.equal(await r.blockHashIs(95n, hash(95n, 1)), false);
  st.mode = { down: true };
  assert.equal(await r.blockHashIs(95n, hash(95n)), false, 'unverifiable is not verified');
  st.mode = {};
  // USDCBandwidthSettlement.chainBytes is the actual consumer code: it reads bytesServed at lease.blockNumber through readAt
  const ctx = { leaseReader: r, confirmed: new Map(), meterHost: () => HOST };
  const c = { address: METER, nonce: 3 };
  assert.equal(await USDCBandwidthSettlement.prototype.chainBytes.call(ctx, { ...lease }, c), 7n);
  ctx.confirmed.clear(); st.mode = { proofFail: true };
  await assert.rejects(USDCBandwidthSettlement.prototype.chainBytes.call(ctx, { ...lease }, c), /bandwidth payment state unverified/);
  ctx.confirmed.clear(); st.mode = {}; st.salt.set(98n, 5);                    // the snapshot block was reorganized away
  await assert.rejects(USDCBandwidthSettlement.prototype.chainBytes.call(ctx, { ...lease }, c), /unverified/);
});

test('legacy quorum mode is unchanged by the new primitives (two agreeing clients, never one)', T, async () => {
  const blockOf = (h) => ({ getBlock: async () => ({ hash: h }), readContract: async () => 5n, getChainId: async () => 8453, getBlockNumber: async () => 100n });
  const q = new LeaseReader({ clients: [blockOf('0xaa'), blockOf('0xaa'), blockOf('0xbb')], addressBook: BOOK });
  assert.equal(await q.blockHashIs(9n, '0xaa'), true);
  assert.equal(await q.blockHashIs(9n, '0xbb'), false);
  assert.equal(await q.readAt({ blockNumber: 9n }, (cl, b) => cl.readContract({ blockNumber: b }).then(String)), '5');
  const one = new LeaseReader({ clients: [blockOf('0xaa'), { ...blockOf('0xaa'), readContract: async () => { throw new Error('down'); } }], addressBook: BOOK });
  assert.equal(await one.readAt({ blockNumber: 9n }, (cl, b) => cl.readContract({ blockNumber: b }).then(String)), null);
});
