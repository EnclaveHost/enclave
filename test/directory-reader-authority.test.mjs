// The public directory's chain reader authority (network/directory-server.mjs directoryReaderOptions -> LeaseReader):
// the legacy provider quorum is unchanged; an EXPLICIT local verifier is the only source (no provider client, no
// fallback), a mixed config is refused, and verifier outage / proof failure / another chain / a stale head refuse the read.
// The verifier is an in-process stand-in that answers like the patched Helios (as in test/lease-reader-verifier.test.mjs);
// the real Helios path is covered by test/lease-reader-verifier.e2e.test.mjs. It is the host-LOCAL verifier, not attested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionResult, decodeFunctionData, pad, toHex } from 'viem';
import { LeaseReader } from '../network/lease-reader.mjs';
import { directoryReaderOptions, runDirectory } from '../network/directory-server.mjs';

const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const PINS = { deployments: '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b', registry: '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',
  connectivity: '0x5f8b636e0768e84bd47b736652030b65db615111', sessionVaultFactory: '0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c' };
const HOST = '0x' + 'ab'.repeat(32), OWNER = '0x' + '44'.repeat(20);
const registryGet = [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components:
  [['endpoint','string'],['repo','string'],['measurement','bytes32'],['operator','address'],['registeredAt','uint64'],['lastSeen','uint64'],['active','bool']].map(([name, type]) => ({ name, type })) }] }];
const hash = (n) => pad(toHex(BigInt(n) * 1000n + 7n), { size: 32 });

function standIn() {
  const st = { head: 100n, mode: {}, calls: [] };
  const block = (n) => ({ number: toHex(n), hash: hash(n), stateRoot: pad(toHex(n + 3n), { size: 32 }),
    timestamp: toHex(Math.floor(Date.now() / 1000) - Number(st.head - n) * 2 - (st.mode.stale ? 600 : 0)) });
  const numberOf = (h) => { for (let n = 0n; n <= st.head; n++) if (hash(n) === h) return n; throw new Error('unknown block hash'); };
  const verifier = { request: async (method, params) => {
    st.calls.push(method);
    if (st.mode.down) throw new Error('verifier HTTP 502');
    switch (method) {
      case 'eth_chainId': return toHex(st.mode.wrongChain ? 10 : 8453);
      case 'eth_blockNumber': return toHex(st.head);
      case 'eth_getBlockByNumber': { const n = BigInt(params[0]); return n <= st.head ? block(n) : null; }
      case 'eth_call': {
        if (st.mode.proofFail) throw new Error('verifier: invalid account proof for address ' + params[0].to);
        assert.ok(params[1]?.blockHash, 'calls are pinned by block hash'); numberOf(params[1].blockHash);
        assert.equal(params[0].to.toLowerCase(), PINS.registry, 'only the pinned registry is read');
        const d = decodeFunctionData({ abi: registryGet, data: params[0].data });
        assert.equal(d.args[0], HOST);
        return encodeFunctionResult({ abi: registryGet, functionName: 'get', result: { endpoint: 'https://h', repo: 'r', measurement: hash(1), operator: OWNER,
          registeredAt: 1n, lastSeen: 2n, active: true } });
      }
      default: throw new Error('method not supported');
    }
  } };
  return { st, verifier };
}
const T = { timeout: 20000 };

test('legacy mode is unchanged: the same LeaseReader options as before, a provider quorum of the configured rpc', () => {
  const cfg = { rpc: ['https://a.example.org', 'https://b.example.org'], addressBook: BOOK, authorityPins: PINS, stateDir: '/x', checkers: [] };
  assert.deepEqual(directoryReaderOptions(cfg), { rpc: cfg.rpc, addressBook: BOOK, authorityPins: PINS, includeHostPayout: true });
  const r = new LeaseReader(directoryReaderOptions(cfg));
  assert.equal(r.authority, 'quorum'); assert.equal(r.clients.length, 2); assert.deepEqual(r.authorityPins, PINS);
  assert.equal(directoryReaderOptions({ ...cfg, chainAuthority: 'quorum' }).rpc, cfg.rpc);
});

test('explicit verifier mode: a config that still names rpc, a verifier without the mode, or no verifier URL is refused', async () => {
  const { verifier } = standIn();
  const base = { addressBook: BOOK, authorityPins: PINS };
  assert.throws(() => directoryReaderOptions({ ...base, chainAuthority: 'verifier', chainVerifier: verifier, rpc: ['https://a.example.org', 'https://b.example.org'] }), /rpc is not used with chainAuthority "verifier"/);
  assert.throws(() => directoryReaderOptions({ ...base, chainAuthority: 'verifier', chainVerifier: verifier, rpc: [] }), /rpc is not used/);
  assert.throws(() => directoryReaderOptions({ ...base, chainVerifier: 'http://127.0.0.1:8545/', rpc: ['https://a.example.org', 'https://b.example.org'] }), /not verifier/);
  assert.throws(() => directoryReaderOptions({ ...base, chainAuthority: 'verifier' }), /needs chainVerifier/);
  assert.throws(() => new LeaseReader(directoryReaderOptions({ ...base, chainAuthority: 'verifier', chainVerifier: 'https://rpc.example.org/' })), /local endpoint/);
  // the server itself refuses the mixed config at startup, before any listener or read
  await assert.rejects(runDirectory({ ...base, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:9/', rpc: ['https://a.example.org', 'https://b.example.org'],
    stateDir: '/nonexistent-directory-state', checkers: [] }), /rpc is not used/);
});

test('verifier mode reads ONLY through the local verifier: pinned registry, proof-backed operator, no provider client', T, async () => {
  const { st, verifier } = standIn();
  const r = new LeaseReader(directoryReaderOptions({ chainAuthority: 'verifier', chainVerifier: verifier, addressBook: BOOK, authorityPins: PINS }));
  assert.equal(r.clients.length, 0, 'no provider client exists to fall back to');
  assert.equal(r.authorityInfo().authority, 'local-verifier'); assert.equal(r.authorityInfo().tier, 'unsafe');
  assert.equal(await r.bookAddress('registry'), PINS.registry, 'the pinned registry, as the directory reads it');
  const [h] = await r.registryEntries(PINS.registry, [HOST]);
  assert.equal(h.active, true); assert.equal(h.operator, OWNER);
  assert.ok(st.calls.includes('eth_call') && st.calls.includes('eth_chainId'), 'read through the verifier, chain checked');
});

test('verifier outage, proof failure, another chain or a stale head: the read is refused, nothing else is asked', T, async () => {
  for (const [mode, why] of [['down', /502|verifier/], ['proofFail', /proof/], ['wrongChain', /another chain/], ['stale', /old|stale|fresh|age/i]]) {
    const { st, verifier } = standIn(); st.mode[mode] = true;
    const r = new LeaseReader(directoryReaderOptions({ chainAuthority: 'verifier', chainVerifier: verifier, addressBook: BOOK, authorityPins: PINS }));
    await assert.rejects(r.registryEntries(PINS.registry, [HOST]), why, mode);
    assert.equal(r.clients.length, 0, mode);
  }
});
