// Cold-start discovery and bootstrap WITHOUT a named failure domain (work/hosted-service-placement): a client with empty
// caches finds directories, bootstrap replicas and DNS replicas, reads public records and fetches verified bootstrap
// artifacts, and proves it used nothing inside the failure domains it was told to treat as down (today: the four
// DigitalOcean transport machines, whose simultaneous loss is a required failure domain).
//
// What it starts from (and nothing else):
//   - two or more Base RPCs of distinct providers (the caller's quorum) and the PINNED EnclaveServiceIndex (chain, address,
//     runtime code hash): network/service-index.mjs readServiceIndex, one agreed snapshot, untrusted candidates;
//   - the platform host policy's operator decisions (network/host-policy-adapters.mjs operatorDecider): an administrator's
//     ban removes an operator's advertisements (applyHostPolicy) - Enclave administration applies to discovery too. With
//     `policy` ({ book, hostOwnership, activation? }) the client loads the ANCHORED policy itself, without the fleet: from
//     the policy carriers the same index read lists (kind "policy", failure domains excluded) plus any it names, through
//     the unchanged gate (anchor, current-owner signature, bans) over the same RPC quorum (network/policy-carriers.mjs);
//   - a pinned bootstrap manifest (CID -> sha256) for any artifact it fetches.
// No enclave.host name, no fleet address, no storage adapter, no lease relay, no app: none of the things being recovered.
// A candidate endpoint inside a failure domain - an address in it, or a name that resolves into it - is EXCLUDED and named
// in the evidence, never silently used. Candidates prove nothing: records are verified by signature/chain, artifacts by hash.
import { createHash } from 'node:crypto';
import * as si from './service-index.mjs';
import { DirectoryClient } from './directory-client.mjs';
import { createHostPolicyRuntime, hostPolicySnapshot } from './host-policy-runtime.mjs';
import { operatorDecider } from './host-policy-adapters.mjs';
import { CARRIER_MIRROR, httpCarriers, freshVerifier, carrierFetch, validateCarrierBases, rpcPeers } from './policy-carriers.mjs';

const isV4 = (h) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);
/**
 * failureDomains: [{ name, addresses: [IPv4...], names?: [hostname suffixes...] }]. resolve(hostname) -> [IPv4...] (the
 * caller's resolver; a name that cannot be resolved is excluded too: its failure domain is unknown).
 */
export async function classifyEndpoint(endpoint, failureDomains, resolve) {
  const h = new URL(endpoint).hostname.toLowerCase();
  for (const d of failureDomains) {
    if ((d.names || []).some((n) => h === n || h.endsWith('.' + n))) return { excluded: true, domain: d.name, reason: `name ${h} is in ${d.name}` };
  }
  let addresses = [h];
  if (!isV4(h)) {
    try { addresses = await resolve(h); } catch (e) { return { excluded: true, domain: 'unknown', reason: `name ${h} did not resolve (${e.message})` }; }
    if (!Array.isArray(addresses) || !addresses.length) return { excluded: true, domain: 'unknown', reason: `name ${h} resolved to nothing` };
  }
  for (const d of failureDomains) {
    const hit = addresses.find((a) => (d.addresses || []).includes(a));
    if (hit) return { excluded: true, domain: d.name, reason: `${h === hit ? 'address' : `${h} -> ${hit}`} is in ${d.name}` };
  }
  return { excluded: false, addresses };
}

/**
 * -> { index: {blockNumber, blockHash}, candidates, refusedByPolicy, excluded: [{endpoint, operator, kind, domain, reason}],
 *      usable: {directory:[origins], replica:[origins], dns:[endpoints]}, directory: {origins, answers}, artifacts: [{cid, origin, bytes}] }
 * Throws when no usable directory answers, or an artifact asked for cannot be fetched and verified from a usable replica.
 */
export async function coldDiscover({ peers, clients, indexPin, lookups = [], decide = null, policy = null, failureDomains = [], resolve = async () => { throw new Error('no resolver'); },
  fetch = globalThis.fetch, directoryPath = '/v1/network/records', manifest = null, artifacts = [], timeoutMs = 8000, chainAuthority, chainVerifier }) {
  if (decide && policy) throw new Error('coldDiscover: pass decide OR policy, not both');
  // chainAuthority 'verifier': the index AND the policy are read from the local proof-backed verifier; no RPC is used
  const authority = { chainAuthority, chainVerifier };
  const verifierChosen = chainAuthority === 'verifier';
  if (peers && !verifierChosen) peers = rpcPeers(peers);          // RPC URLs or {label, client} entries
  const read = await si.readServiceIndex({ peers, clients, pin: indexPin, kinds: ['directory', 'replica', 'dns', ...(policy ? ['policy'] : [])], lookups, ...authority });
  if (read.status !== 'complete') throw new Error('service index read incomplete: a partial list proves nothing about the rest');
  const excluded = [], usable = { directory: [], replica: [], dns: [], policy: [] };
  let policyRuntime = null;
  if (policy) {
    // carriers are untrusted and judged by nothing but the bytes they serve, so they are used BEFORE the policy is known
    // (the policy is what they carry); failure domains still exclude them
    for (const c of read.candidates.filter((x) => x.kindName === 'policy')) for (const endpoint of c.endpoints) {
      const k = await classifyEndpoint(endpoint, failureDomains, resolve);
      if (k.excluded) excluded.push({ endpoint, operator: c.operator, kind: 'policy', domain: k.domain, reason: k.reason });
      else if (!usable.policy.includes(endpoint.replace(/\/+$/, ''))) usable.policy.push(endpoint.replace(/\/+$/, ''));
    }
    const bases = [...new Set([...usable.policy, ...validateCarrierBases(policy.carriers || [], 'policy.carriers')])].slice(0, 16);
    // the policy is read over the SAME quorum as the index
    const snapshot = hostPolicySnapshot({ clients: verifierChosen ? null : clients || peers.map((p) => p.client), minAgree: policy.minAgree ?? null,
      ...authority, chainId: indexPin.chainId });
    const pf = carrierFetch({ carriers: httpCarriers(bases, { fetch, timeoutMs }), verify: freshVerifier({ snapshot, book: policy.book, hostOwnership: policy.hostOwnership }), fetch });
    policyRuntime = createHostPolicyRuntime({ book: String(policy.book).toLowerCase(), hostOwnership: String(policy.hostOwnership).toLowerCase(), mirrors: [CARRIER_MIRROR],
      activation: policy.activation || 'anchor' }, { snapshot, fetch: pf });
    decide = operatorDecider(policyRuntime.gate);
  }
  const judged = decide ? await si.applyHostPolicy(read, decide) : { ...read, refusedByPolicy: [] };
  for (const c of judged.candidates) for (const endpoint of c.endpoints) {
    if (c.kindName === 'policy') continue;
    const k = await classifyEndpoint(endpoint, failureDomains, resolve);
    if (k.excluded) { excluded.push({ endpoint, operator: c.operator, kind: c.kindName, domain: k.domain, reason: k.reason }); continue; }
    const origin = new URL(endpoint).origin;
    if (!usable[c.kindName].includes(origin)) usable[c.kindName].push(c.kindName === 'dns' ? endpoint : origin);
  }
  if (!usable.directory.length) throw new Error(`no directory outside the failure domains (${excluded.length} candidate endpoint(s) excluded)`);
  // public records only; a failing origin cannot hide another's answer (DirectoryClient reads every origin)
  const client = new DirectoryClient({ origins: usable.directory.map((o) => o + '/'), fetch, timeoutMs });
  const answers = await client.read(directoryPath);
  const got = [];
  for (const cid of artifacts) {
    const want = manifest?.verifiedObjects?.find((e) => e.cid === cid);
    if (!want || !/^[0-9a-f]{64}$/.test(want.sha256 || '')) throw new Error(`artifact ${cid} is not in the pinned bootstrap manifest`);
    let ok = null;
    for (const origin of usable.replica) {
      try {
        const r = await fetch(`${origin}/ipfs/${cid}`, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) continue;
        const bytes = Buffer.from(await r.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== want.sha256) continue;   // a lying replica costs a try, never correctness
        ok = { cid, origin, bytes }; break;
      } catch { /* next replica */ }
    }
    if (!ok) throw new Error(`artifact ${cid}: no replica outside the failure domains served the pinned bytes`);
    got.push(ok);
  }
  return { index: { blockNumber: read.blockNumber, blockHash: read.blockHash }, candidates: judged.candidates, refusedByPolicy: judged.refusedByPolicy,
    ...(judged.platformPolicyNote ? { platformPolicyNote: judged.platformPolicyNote } : {}), ...(policyRuntime ? { policy: policyRuntime.status() } : {}),
    excluded, usable, directory: { origins: usable.directory, answers }, artifacts: got, evidence: read.evidence };
}
