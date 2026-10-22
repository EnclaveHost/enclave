// READ-ONLY. Inventory of every registered host at one agreed Base block (registry operator, active, endpoint, payout,
// ACCEPTED owner on the deployed EnclaveHostOwnership 0xbbd8…, current policy anchor keys), and a REVIEWABLE platform host
// policy DRAFT built from it: UNSIGNED, not anchored, not published. The admin must review the inventory and the draft's
// exact bytes; nothing here copies the historical relay allowlist as policy.
import fs from 'node:fs';
import { stringToHex } from 'viem';
import { pinBlock, readMany } from '../../ledger17-migration/lib/live.mjs';
import { policyDigest, anchorTransaction, canonicalPolicy, POLICY_FORMAT, ANCHOR_KEYS } from '../candidate/tree/network/platform-host-policy.mjs';

const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907', OWNERSHIP = '0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7';
const REG_ABI = [
  { type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'idAt', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' }, { name: 'measurement', type: 'bytes32' }, { name: 'operator', type: 'address' },
    { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' }, { name: 'active', type: 'bool' },
    { name: 'cpuPricePerSec6', type: 'uint64' }, { name: 'gpuPricePerSec6', type: 'uint64' }, { name: 'proofKey', type: 'address' }, { name: 'payoutWallet', type: 'address' }] }] }];
const BOOK_ABI = [{ type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
                  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
const OWN_ABI = [{ type: 'function', name: 'authority', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'bytes32' }] }];
// operators an authority has named (evidence, not a decision): coordinator-production-findings.txt and the user
const NAMED = {
  '0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1': 'historical relay TRUSTED_OPERATORS (canonical Enclave fleet operator)',
  '0x3b44dbccd6632f751c8d3676615f171cb1b922a1': 'historical relay TRUSTED_OPERATORS',
  '0x1a01194c34fe3577c6d0a54feb78af6253e494e0': 'user-authorized live minipc operator (coordinator findings)',
  '0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab': 'metal0 host operator (custody-metal0 host; coordinator: currently authorized)',
  '0x389c3f030a209d04d026228d2d053feb75dbadca': 'earlier authorized NucBox operator (windows/PARITY.md:268 - the box serving deployments e64f7cba/a77d0c57/a69dcbba/7ae476a3/d9798e4c; windows/node/payout.test.mjs fixture); admin must confirm it is still authorized',
};
// Registry rows whose endpoint is not an https compute host are NETWORK PROVIDERS (tuna://, wg-provider://): the compute-host
// allowlist does not apply to them (providers are qualified by checkers and route-record, and service-index ads are filtered
// only by explicit operator bans). Listed for review with their binding caveats, never silently dropped or admitted.
const PROVIDER = /^(tuna|wg-provider):\/\//;
const PROVIDER_NOTES = {
  '0xea844afe1d23dfdcaab6a573f0f3cd4b72bf0035': 'wg-provider://165.245.191.129 - coordinator: our ap-southeast server, but endpoint/address alone is not signer-ownership evidence; needs binding evidence',
  '0xaad0e6af72f2ecb6767e5c95d5eb1cfe6175d180': 'tuna://179.237.66.103:30120 - unverified (no binding evidence)',
};
const NAMED_PREFIXES = { '0x8179213': 'coordinator: currently authorized operator (prefix only given; matched against inventory)' };

const block = await pinBlock();
const [{ value: n }, { value: owner }, { value: registry }, { value: hi }, { value: lo }] = await readMany(block, [
  { address: '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac', abi: REG_ABI, functionName: 'count' },
  { address: BOOK, abi: BOOK_ABI, functionName: 'owner' },
  { address: BOOK, abi: BOOK_ABI, functionName: 'addr', args: [stringToHex('registry', { size: 32 })] },
  { address: BOOK, abi: BOOK_ABI, functionName: 'addr', args: [ANCHOR_KEYS.hi] },
  { address: BOOK, abi: BOOK_ABI, functionName: 'addr', args: [ANCHOR_KEYS.lo] }]);
const REG = registry.toLowerCase();
const ids = (await readMany(block, Array.from({ length: Number(n) }, (_, i) => ({ address: REG, abi: REG_ABI, functionName: 'idAt', args: [BigInt(i)] })))).map((r) => r.value);
const entries = await readMany(block, ids.map((id) => ({ address: REG, abi: REG_ABI, functionName: 'get', args: [id], allowFailure: true })));
const auth = await readMany(block, ids.map((id) => ({ address: OWNERSHIP, abi: OWN_ABI, functionName: 'authority', args: [id] })));
const hosts = ids.map((id, i) => {
  const e = entries[i].ok ? entries[i].value : null, op = e ? e.operator.toLowerCase() : null;
  const named = op && (NAMED[op] || Object.entries(NAMED_PREFIXES).find(([p]) => op.startsWith(p))?.[1]) || null;
  return { registryId: id.toLowerCase(), endpoint: e?.endpoint ?? null, active: e?.active ?? null, operator: op, payout: e?.payoutWallet?.toLowerCase() ?? null,
           lastSeen: e ? Number(e.lastSeen) : null, acceptedOwner: auth[i].value[0].toLowerCase(), namedAuthorization: named };
});
const active = hosts.filter((h) => h.active);
const operators = [...new Set(active.map((h) => h.operator))].sort();
const namedFound = Object.keys(NAMED).concat(operators.filter((o) => Object.keys(NAMED_PREFIXES).some((p) => o.startsWith(p))));
const t = Math.floor(Date.now() / 1000);
// The DRAFT: allowlist of operators an authority has named AND that operate an active registered host (or are named in full).
// Every other active operator is listed in the review file as NOT ADMITTED pending an admin decision. No bans are invented.
const computeOps = new Set(active.filter((h) => !PROVIDER.test(String(h.endpoint || ''))).map((h) => h.operator));
const admit = [...new Set(namedFound)].filter((o) => /^0x[0-9a-f]{40}$/.test(o) && computeOps.has(o)).sort().map((o) => ({ kind: 'operator', value: o }));
const draft = { format: POLICY_FORMAT, chainId: 8453, book: BOOK, registry: REG, hostOwnership: OWNERSHIP, sequence: 1, issuedAt: t, expiresAt: 0,
                maxStaleSec: 0, previousDigest: '0x' + '00'.repeat(32), mode: 'allowlist', deny: [], admit };
const digest = policyDigest(draft);
const out = {
  block: String(block.number), blockHash: block.hash, bookOwner: owner.toLowerCase(), registry: REG, anchorNow: { hi: hi.toLowerCase(), lo: lo.toLowerCase() },
  registeredHosts: hosts.length, activeHosts: active.length, activeOperators: operators,
  review: operators.map((o) => ({ operator: o, hosts: active.filter((h) => h.operator === o).map((h) => ({ endpoint: h.endpoint, registryId: h.registryId, acceptedOwner: h.acceptedOwner, payout: h.payout })),
    draftDecision: !computeOps.has(o) ? 'NOT SUBJECT: network provider row (outside the compute-host allowlist; review binding evidence)'
      : admit.some((a) => a.value === o) ? 'ADMIT (named by an authority; admin must confirm)' : 'NOT ADMITTED in the draft (no authority named it; admin decision required)',
    evidence: NAMED[o] || PROVIDER_NOTES[o] || Object.entries(NAMED_PREFIXES).find(([p]) => o.startsWith(p))?.[1] || null })),
  namedButNoActiveHost: Object.keys(NAMED).filter((o) => !operators.includes(o)),
  draft, draftCanonical: canonicalPolicy(draft), draftDigest: digest,
  unsignedAnchor: anchorTransaction(BOOK, digest),
  status: 'DRAFT ONLY: unsigned, unanchored, unpublished. Anchored non-expiring mode (expiresAt 0): no renewal schedule. The digest and calldata change with any edit (and with issuedAt); regenerate at review time.',
};
fs.writeFileSync(new URL('../evidence/host-policy-inventory.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ block: out.block, registeredHosts: out.registeredHosts, activeHosts: out.activeHosts, activeOperators: operators.length, anchorNow: out.anchorNow,
  review: out.review.map((r) => [r.operator, r.hosts.length, r.draftDecision.split(' ')[0] + ' ' + (r.draftDecision.includes('NOT') ? 'NOT' : '')]), namedButNoActiveHost: out.namedButNoActiveHost, draftDigest: digest }, null, 1));
