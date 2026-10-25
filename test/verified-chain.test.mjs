// network/verified-chain.mjs and the two independent policy readers on it: service-index readServiceIndex (discovery,
// cold bootstrap) and the platform host policy (resolveHostPolicyConfig, hostPolicySnapshot, createHostPolicyRuntime),
// plus their config surfaces (host services runner, policy-mirror role). The verifier is an in-process stand-in that
// answers like the patched Helios; the real verifier on real contracts is test/policy-verifier.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pad, toHex, keccak256, encodeFunctionResult, decodeFunctionData } from 'viem';
import { createVerifiedSnapshot, chainVerifierOf } from '../network/verified-chain.mjs';
import * as si from '../network/service-index.mjs';
import { resolveHostPolicyConfig, PRODUCTION_BOOK, PRODUCTION_HOST_OWNERSHIP } from '../network/platform-host-policy-config.mjs';
import { hostPolicySnapshot, verifiedHostSnapshot, createHostPolicyRuntime } from '../network/host-policy-runtime.mjs';
import { validateHostServicesConfig, policyEnv } from '../network/host-services/runner.mjs';
import { ROLES } from '../network/host-services/roles.mjs';

const NOW = 1_800_000_000_000;
const INDEX = '0x' + '1d'.repeat(20), CODE = '0x6080604052', OPERATOR = '0x' + '0a'.repeat(20);
const hash = (n, salt = 0) => pad(toHex(BigInt(n) * 1000n + BigInt(salt)), { size: 32 });
function chain({ head = 100n } = {}) {
  const st = { head, salt: new Map(), calls: [], mode: {}, code: CODE, ads: [] };
  const block = (n) => ({ number: toHex(n), hash: hash(n, st.salt.get(n) || 0), stateRoot: pad(toHex(n + 3n), { size: 32 }),
    timestamp: toHex(Math.floor(NOW / 1000) - Number(st.head - n) * 2 - (st.mode.old ? 600 : 0) + (st.mode.future ? 600 : 0)) });
  const verifier = { request: async (method, params) => {
    st.calls.push({ method, params });
    if (st.mode.down) throw new Error('verifier HTTP 502');
    switch (method) {
      case 'eth_chainId': return toHex(st.mode.wrongChain ? 1 : 8453);
      case 'eth_blockNumber': return toHex(st.head);
      case 'eth_getBlockByNumber': { const n = BigInt(params[0]); if (st.mode.reorgSecond && st.calls.filter((c) => c.method === 'eth_getBlockByNumber').length >= 2) st.salt.set(n, 7); return block(n); }
      case 'eth_getCode': assert.ok(params[1]?.blockHash, 'pinned by block hash'); return st.code;
      case 'eth_call': {
        if (st.mode.proofFail) throw new Error('verifier: invalid storage proof');
        assert.ok(params[1]?.blockHash, 'pinned by block hash');
        const d = decodeFunctionData({ abi: si.SERVICE_INDEX_ABI, data: params[0].data });
        const ad = (op) => ({ operator: op, slot: 0, kind: 1, version: 1, sequence: 1n, expiresAt: BigInt(Math.floor(NOW / 1000) + 86400), updatedAt: 1n,
          descriptor: pad('0x', { size: 32 }), endpoints: ['https://dir-a.example.net/'] });
        if (d.functionName === 'page') return encodeFunctionResult({ abi: si.SERVICE_INDEX_ABI, functionName: 'page', result: [d.args[0] === 1 ? [ad(OPERATOR)] : [], d.args[0] === 1 ? 1n : 0n] });
        if (d.functionName === 'get') return encodeFunctionResult({ abi: si.SERVICE_INDEX_ABI, functionName: 'get', result: ad(d.args[0]) });
        throw new Error('execution reverted');
      }
      default: throw new Error('method not supported');
    }
  } };
  return { st, verifier };
}
const PIN = { chainId: 8453, address: INDEX, codeHash: keccak256(CODE) };
const T = { timeout: 20000 };

test('a verified snapshot: one confirmed block, fresh, pinned by hash, re-checked, monotonic', T, async () => {
  const { st, verifier } = chain();
  const snap = createVerifiedSnapshot({ verifier, chainId: 8453, now: () => NOW });
  const r = await snap(async (c, b) => ({ code: await c.getCode({ address: INDEX, blockNumber: b }) }));
  assert.equal(r.blockNumber, 98n); assert.equal(r.blockHash, hash(98n)); assert.equal(r.value.code, CODE);
  assert.deepEqual(r.evidence.tier, 'unsafe');
  st.head = 95n;                                                      // the verifier went backwards
  await assert.rejects(snap(async () => ({})), (e) => e.code === 'chain_rollback');
  st.head = 100n; st.salt.set(98n, 3);                                // the accepted block was replaced
  await assert.rejects(snap(async () => ({})), (e) => e.code === 'chain_rollback');
});

test('stale, future, wrong chain, reorganization, proof failure and an unreachable verifier refuse with quorum-class codes', T, async () => {
  for (const [mode, code] of [['old', 'chain_stale'], ['future', 'chain_future'], ['wrongChain', 'chain_wrong_network'], ['reorgSecond', 'chain_reorg'], ['down', 'chain_unconfirmed']]) {
    const { st, verifier } = chain(); st.mode[mode] = true;
    const snap = createVerifiedSnapshot({ verifier, chainId: 8453, now: () => NOW });
    await assert.rejects(snap(async (c, b) => ({ code: await c.getCode({ address: INDEX, blockNumber: b }) })), (e) => e.code === code && e.status === 503, mode);
  }
});

test('ONE deadline bounds the whole operation including a hung callback; a retained client refuses afterwards', T, async () => {
  const { verifier } = chain();
  const snap = createVerifiedSnapshot({ verifier, chainId: 8453, now: () => NOW, deadlineMs: 300 });
  let kept = null;
  const t0 = Date.now();
  await assert.rejects(snap(async (c) => { kept = c; return new Promise(() => {}); }), (e) => e.code === 'chain_timeout');
  assert.ok(Date.now() - t0 < 2000, 'bounded by the deadline');
  await assert.rejects(kept.getCode({ address: INDEX }), (e) => e.code === 'chain_closed');
  // also after a successful snapshot
  const snap2 = createVerifiedSnapshot({ verifier, chainId: 8453, now: () => NOW });
  await snap2(async (c) => { kept = c; return {}; });
  await assert.rejects(kept.readContract({ address: INDEX, abi: si.SERVICE_INDEX_ABI, functionName: 'count', args: [1] }), (e) => e.code === 'chain_closed');
});

test('inside a snapshot only proof-backed methods at the pinned block exist; resumed history must still be fresh and canonical', T, async () => {
  const { st, verifier } = chain();
  const snap = createVerifiedSnapshot({ verifier, chainId: 8453, now: () => NOW });
  for (const bad of [(c) => c.getLogs({}), (c) => c.request({}), (c) => c.multicall({}), (c) => c.call({})])
    await assert.rejects(snap(async (c) => ({ x: await bad(c) })), /not available under the verifier authority/);
  await assert.rejects(snap(async (c, b) => ({ x: await c.getCode({ address: INDEX, blockNumber: b - 1n }) })), /pinned to block/);
  await assert.rejects(snap(async (c) => ({ x: await c.getCode({ address: INDEX, blockTag: 'latest' }) })), /no block tags/);
  await assert.rejects(snap(async () => ({}), { atBlock: { number: 97n, hash: hash(97n, 1) } }), (e) => e.code === 'chain_reorg');
  st.mode.old = true;
  await assert.rejects(snap(async () => ({}), { atBlock: { number: 97n, hash: hash(97n) } }), (e) => e.code === 'chain_stale', 'history is never fresh authority');
});

test('the explicit authority choice: quorum by default, verifier only when said, local only', () => {
  assert.equal(chainVerifierOf({}), null);
  assert.equal(chainVerifierOf({ chainAuthority: 'quorum' }), null);
  assert.equal(chainVerifierOf({ chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' }), 'http://127.0.0.1:8545/');
  assert.throws(() => chainVerifierOf({ chainVerifier: 'http://127.0.0.1:8545/' }), /not verifier/);
  assert.throws(() => chainVerifierOf({ chainAuthority: 'verifier' }), /needs chainVerifier/);
  assert.throws(() => chainVerifierOf({ chainAuthority: 'verifier', chainVerifier: 'https://rpc.example.org' }), /local endpoint/);
  assert.throws(() => chainVerifierOf({ chainAuthority: 'remote' }), /quorum or verifier/);
});

test('service index under the verifier: same listing logic, no provider client, pin never weakened, refusals are QuorumErrors', T, async () => {
  const { st, verifier } = chain();
  const r = await si.readServiceIndex({ pin: PIN, kinds: ['directory'], lookups: [{ operator: OPERATOR, slot: 0 }], chainAuthority: 'verifier', chainVerifier: verifier, now: () => NOW });
  assert.equal(r.status, 'complete');
  assert.deepEqual(r.candidates.map((c) => [c.operator, c.endpoints[0]]), [[OPERATOR, 'https://dir-a.example.net/']]);
  assert.equal(r.lookups[0].state, 'listed');
  assert.equal(r.evidence.authority, 'local-verifier');
  assert.equal(r.blockHash, hash(98n));
  // provider peers alongside the verifier are never turned into clients (no fallback)
  const r2 = await si.readServiceIndex({ peers: [{ label: 'x', client: {} }], pin: PIN, kinds: ['directory'], chainAuthority: 'verifier', chainVerifier: verifier, now: () => NOW });
  assert.equal(r2.candidates.length, 1);
  await assert.rejects(si.readServiceIndex({ pin: { ...PIN, codeHash: keccak256('0x00') }, kinds: ['directory'], chainAuthority: 'verifier', chainVerifier: verifier, now: () => NOW }), /pinned/);
  st.mode.proofFail = true;
  await assert.rejects(si.readServiceIndex({ pin: PIN, kinds: ['directory'], chainAuthority: 'verifier', chainVerifier: verifier, now: () => NOW }), (e) => e instanceof si.QuorumError && /no verified service index snapshot/.test(e.message));
  st.mode = { old: true };
  await assert.rejects(si.readServiceIndex({ pin: PIN, kinds: ['directory'], chainAuthority: 'verifier', chainVerifier: verifier, now: () => NOW }), /chain_stale|older than/);
  await assert.rejects(si.readServiceIndex({ pin: PIN, kinds: ['directory'], chainVerifier: verifier }), /not verifier/);
  // the legacy default is unchanged: two peers still required
  await assert.rejects(si.readServiceIndex({ pin: PIN, kinds: ['directory'] }), /two or more/);
});

test('platform host policy config: explicit verifier authority from env or JSON; ambiguous or remote refused', () => {
  const env = { ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify({ book: '0x' + '0b'.repeat(20), hostOwnership: '0x' + '0c'.repeat(20), mirrors: [] }) };
  assert.equal(resolveHostPolicyConfig({ env }).config.chainAuthority, undefined);
  const v = resolveHostPolicyConfig({ env: { ...env, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' } }).config;
  assert.deepEqual([v.chainAuthority, v.chainVerifier], ['verifier', 'http://127.0.0.1:8545/']);
  const j = resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify({ book: '0x' + '0b'.repeat(20), hostOwnership: '0x' + '0c'.repeat(20), mirrors: [], chainAuthority: 'verifier', chainVerifier: 'http://localhost:9/' }) } }).config;
  assert.equal(j.chainAuthority, 'verifier');
  assert.equal(resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: 'production', ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:1/' } }).config.chainAuthority, 'verifier');
  assert.throws(() => resolveHostPolicyConfig({ env: { ...env, ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' } }), /not verifier/);
  assert.throws(() => resolveHostPolicyConfig({ env: { ...env, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' } }), /local/);
});

test('the policy snapshot follows the configured authority, with quorumSnapshot\'s interface and result shape', T, async () => {
  const { st, verifier } = chain();
  const snap = verifiedHostSnapshot({ verifier, now: () => NOW });
  const out = await snap(async (at) => ({ code: await at.code(INDEX), block: at.block }));
  assert.equal(out.code, CODE); assert.equal(out.blockNumber, 100n, 'head block (0 confirmations, like the quorum snapshot)');
  assert.equal(out.blockHash, hash(100n)); assert.equal(typeof out.blockTimestamp, 'number');
  assert.equal(st.calls.filter((c) => c.method === 'eth_getCode').length, 1);
  // quorum stays the default; a verifier needs the explicit authority
  assert.throws(() => hostPolicySnapshot({ chainVerifier: verifier }), /not verifier/);
  assert.equal(typeof hostPolicySnapshot({ chainAuthority: 'verifier', chainVerifier: verifier }), 'function');
  // the runtime uses the verifier when its config says so (and reports it), never the RPC list
  const rt = createHostPolicyRuntime({ book: '0x' + '0b'.repeat(20), hostOwnership: '0x' + '0c'.repeat(20), mirrors: ['https://m.example.org/platform-policy'],
    rpcs: ['https://a.example.org', 'https://b.example.org'], chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:1/' }, { fetch: async () => { throw new Error('no network'); } });
  assert.match(rt.status().chainAuthority, /local-verifier/);
});

test('host services and the policy-mirror role accept the explicit verifier authority and refuse ambiguous ones', () => {
  // a policy-mirror service must carry the platform policy's own book and ownership extension (production here)
  const pm = { port: 9100, bind: '127.0.0.1', stateDir: '/var/lib/pm', book: PRODUCTION_BOOK, hostOwnership: PRODUCTION_HOST_OWNERSHIP };
  const base = { format: 'enclave-host-services/v1', host: { endpoint: 'https://host-a.example.net' }, platformHostPolicy: 'production',
    packagesDir: '/opt/packages', stateRoot: '/var/lib/enclave-host-services',
    services: [{ role: 'policy-mirror', package: 'sha256:' + 'ab'.repeat(32), config: { ...pm, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' } }] };
  const cfg = validateHostServicesConfig({ ...base, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' });
  assert.deepEqual([policyEnv(cfg).ENCLAVE_CHAIN_AUTHORITY, policyEnv(cfg).ENCLAVE_CHAIN_VERIFIER], ['verifier', 'http://127.0.0.1:8545/']);
  assert.equal(policyEnv(validateHostServicesConfig(base)).ENCLAVE_CHAIN_AUTHORITY, undefined);
  assert.throws(() => validateHostServicesConfig({ ...base, chainVerifier: 'http://127.0.0.1:8545/' }), /not verifier/);
  assert.throws(() => validateHostServicesConfig({ ...base, chainAuthority: 'verifier', chainVerifier: 'https://rpc.example.org/' }), /local endpoint/);
  const v = ROLES['policy-mirror'].validate({ ...pm, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' });
  assert.deepEqual([v.chainAuthority, v.rpc], ['verifier', undefined]);
  assert.throws(() => ROLES['policy-mirror'].validate(pm), /rpc/);
});
