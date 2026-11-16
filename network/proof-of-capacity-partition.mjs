// A host's proof key INSIDE a Shield partition (isolation/m2/capacity and isolation/m2/front/capacity.go have the guest's
// side): on an Enclave Shield host the supervisor is a process of the host OS, so a proof key it holds is the host's
// file, and its answers to capacity checks are the host's word about itself. With a capacity partition the key is made
// in the partition's memory, the measured work runs there, and every answer is signed there.
//
// Two sides here, neither with a package import (see proof-of-capacity.mjs):
//
//   createPartitionProofKey  the HOST's use of its partition: the key's address, the answer to a challenge (work and
//                            signature in one request to the partition), and the other messages the proof key signs.
//
//   createProofKeyCheck      a CHECKER's look at where another host's proof key lives, as a further check for
//                            createCapacityChecker's `also`. For an Enclave Shield host it asks the host for its capacity
//                            partition's attestation over a fresh nonce and verifies it as a customer's page verifies
//                            a Shield app (the independent verifier, unchanged: the host's TPM session first, then the
//                            partition's report under that boot's key, the image, the app, the TLS key), against the
//                            capacity app THIS CHECKER's own policy pins. Then the key statement: the proof key's
//                            address signed by that TLS key, equal to the proof key the registry publishes.
//
// What a pass says: the key that signs this host's answers and proofs was made in, and has never left, a partition of
// an admitted image running the pinned capacity app, on a boot whose TPM this checker just heard from. What it does not
// say: that the host OS cannot read that partition (the Shield tier's standing limit), or that the partition judged
// anything but the work: reports and proofs of time are signed there at the host's request.
import {createHash, createPublicKey, verify as verifySignature} from 'node:crypto';

export const PROOF_KEY_CHECK = 'proof-key', CAPACITY_KEY_PATH = '/v1/host/capacity-key';
export const KEY_STATEMENT = 'enclave-host-capacity-key/1';
export const GUEST = Object.freeze({key: '/.well-known/enclave-capacity-key', work: '/.well-known/enclave-capacity', sign: '/.well-known/enclave-capacity-sign'});
const HEX32 = /^0x[0-9a-f]{64}$/, HEX64 = /^[0-9a-f]{64}$/, ADDR = /^0x[0-9a-f]{40}$/, SIG = /^0x[0-9a-f]{130}$/, NAME = /^[A-Za-z0-9_-]{1,64}$/;
const need = (ok, what) => { if (!ok) throw new Error(what); };
const DOMAIN_NAME = 'EnclaveProofOfCapacity';

/** Is `tlsSignature` (base64, ASN.1 DER ECDSA) the statement of `address` by the key `spki` (DER)? */
export function keyStatementHolds({address, tlsSignature, spki}) {
  try {
    if (!ADDR.test(String(address)) || typeof tlsSignature !== 'string' || tlsSignature.length > 256) return false;
    const data = Buffer.concat([Buffer.from(KEY_STATEMENT + '\n'), Buffer.from(address.slice(2), 'hex')]);
    return verifySignature('sha256', data, {key: createPublicKey({key: Buffer.from(spki), format: 'der', type: 'spki'}), dsaEncoding: 'der'}, Buffer.from(tlsSignature, 'base64'));
  } catch { return false; }
}

/**
 * The host's side. call(method, path, body | null, {timeoutMs}) -> {status, body: <parsed JSON | null>, instance}: one
 * request to the capacity partition's front over its verified TLS key (`instance` names the partition's start: a new
 * one has a new key).
 * -> {address(), statement(), sign(typedData), answerOf(challenge, domain)}
 */
export function createPartitionProofKey({call, workTimeoutMs = 75000, timeoutMs = 15000}) {
  need(typeof call === 'function', 'a way into the capacity partition');
  let known = null;   // {instance, address, tlsSignature}
  async function statement() {
    const r = await call('GET', GUEST.key, null, {timeoutMs});
    const b = r?.body;
    if (r?.status !== 200 || !ADDR.test(String(b?.address)) || b.statement !== KEY_STATEMENT || typeof b.tlsSignature !== 'string')
      throw new Error(`the capacity partition states no proof key (HTTP ${r?.status ?? 'none'})`);
    known = {instance: r.instance ?? null, address: b.address, tlsSignature: b.tlsSignature};
    return known;
  }
  const domainOf = d => {
    need(d?.name === DOMAIN_NAME && String(d.version) === '1' && Number.isSafeInteger(Number(d.chainId)) && ADDR.test(String(d.verifyingContract).toLowerCase()),
      'the partition signs only for an EnclaveProofOfCapacity');
    return {chainId: Number(d.chainId), contract: String(d.verifyingContract).toLowerCase()};
  };
  const signature = r => { if (r?.status !== 200 || !SIG.test(String(r.body?.signature))) throw new Error(`the capacity partition did not sign (HTTP ${r?.status ?? 'none'}${r?.body?.error ? ': ' + String(r.body.error).slice(0, 120) : ''})`); return r.body.signature; };
  return {
    statement,
    /** The address the registry must publish. Asked again when `fresh`, or never asked before. */
    async address({fresh = false} = {}) { return (fresh || !known ? await statement() : known).address; },
    /** Any message of the capacity contract but the answer, signed in the partition from its fields. */
    async sign(typedData) {
      need(typedData?.primaryType && typedData.primaryType !== 'CapacityAnswer', 'an answer is signed with the work, not by itself');
      const message = Object.fromEntries(Object.entries(typedData.message).map(([k, v]) => [k, typeof v === 'bigint' || typeof v === 'number' ? String(v) : String(v).toLowerCase()]));
      return signature(await call('POST', GUEST.sign, {...domainOf(typedData.domain), primaryType: typedData.primaryType, message}, {timeoutMs}));
    },
    /** For createCapacityResponder's answerOf: the work done and the answer signed in the partition. */
    async answerOf(c, domain) {
      const r = await call('POST', GUEST.work, {chainId: domain.chainId, contract: String(domain.contract).toLowerCase(),
        challenge: {Epoch: c.epoch, Checker: c.checker, Target: c.target, Seed: c.seed, Nonce: c.nonce, Rounds: c.rounds, MemoryMiB: c.memoryMiB, Lanes: c.lanes}}, {timeoutMs: workTimeoutMs});
      if (r?.status === 503) throw Object.assign(new Error('the capacity partition is busy with another check'), {busy: true});
      if (!HEX32.test(String(r?.body?.digest))) throw new Error(`the capacity partition did not answer (HTTP ${r?.status ?? 'none'})`);
      return {digest: r.body.digest, signature: signature(r)};
    },
  };
}

/** The capacity apps a Shield policy pins, with the image measurements it admits for each: [{appSha256, runtimeId, measurements, ...}]. */
export function pinnedCapacityApps(policy) {
  if (!policy || policy.schema !== 'enclave-shield-app-policy/1') return [];
  const list = Array.isArray(policy.capacity) ? policy.capacity : policy.capacity ? [policy.capacity] : [];
  return list.filter(c => c && HEX64.test(String(c.appSha256)) && HEX64.test(String(c.runtimeId))).slice(0, 16).map(c => {
    const images = (Array.isArray(policy.images) ? policy.images : []).filter(i => i && HEX64.test(String(i.measurement)) && i.runtimeId === c.runtimeId && i.nativeDesktop !== true);
    const pinned = images.some(i => i.identity !== undefined);
    return {appSha256: c.appSha256, runtimeId: c.runtimeId, measurements: images.map(i => i.measurement),
      // a partly pinned set is ambiguous: every candidate carries its signer, product and module, or none does
      ...(pinned ? {imageIdentities: images.every(i => i.identity) ? images.map(i => ({measurement: i.measurement, identity: i.identity})) : null} : {})};
  });
}

/**
 * The checker's side: an `also` check. -> async (target, row, {epoch, seed}) -> null | {name, ok: true|false|null, why, evidence?}
 *   host (the checker's id); apiBase (the relay: it carries the target's TPM session and says which box and mode it is)
 *   verifier: the independent verifier's module ({verifyShieldAppWeb}) or a function returning it
 *   policy() -> this checker's own enclave-shield-app-policy/1 (with `capacity`: the pinned capacity app or apps)
 *   boxOf(target, row) -> {name, mode} | null; cacheMs: how long a verified key is not asked about again
 * null (nothing to check): the host is not an Enclave Shield box (a confidential server makes its key in its own VM).
 * not judged: no policy or no capacity app pinned here; the relay or the host says "not now"; the verifier could not
 *   judge (its "error").
 * fail: an Enclave Shield host that serves no capacity partition's key; evidence that was read and refused; a key
 *   statement that is not the TLS key's; a registered proof key that is not the partition's.
 */
export function createProofKeyCheck({host, apiBase, verifier, policy, boxOf = null, fetch = globalThis.fetch, enforce = true, cacheMs = 24 * 3600 * 1000,
  timeoutMs = 60000, now = Date.now}) {
  need(HEX32.test(String(host)) && /^https:\/\//.test(String(apiBase || '')) && typeof policy === 'function', 'proof key check: host id, the relay\'s https base and a policy');
  const base = String(apiBase).replace(/\/+$/, ''), verified = new Map();   // target -> {proofKey, at, evidence}
  const getJson = async (url, ms = 15000) => { const r = await fetch(url, {redirect: 'error', headers: {accept: 'application/json'}, signal: AbortSignal.timeout(ms)}); return {status: r.status, body: r.ok ? await r.json() : await r.json().catch(() => null)}; };
  const defaultBox = async (target, row) => {
    const m = /\/t\/([A-Za-z0-9_-]{1,64})\/?$/.exec(String(row?.endpoint || ''));
    let name = m?.[1];
    if (!name) {
      const list = (await getJson(base + '/enclaves')).body;
      name = (list?.enclaves || []).find(x => String(x?.id || '').toLowerCase() === target && NAME.test(String(x?.name || '')))?.name;
    }
    if (!name) return null;
    const apps = await getJson(`${base}/v1/enclaves/${name}/apps`);
    return apps.status === 200 ? {name, mode: apps.body?.mode ?? null} : null;
  };
  let mod = null;
  return async function proofKeyCheck(target, row, {epoch}) {
    const out = (ok, why, evidence) => ({name: PROOF_KEY_CHECK, ok: ok === false && !enforce ? null : ok, why: (ok === false && !enforce ? 'recorded, not enforced: ' : '') + String(why).slice(0, 240), ...(evidence ? {evidence} : {})});
    let box;
    try { box = await (boxOf || defaultBox)(target, row); } catch (e) { return out(null, `which box the host is: ${e?.message || e}`); }
    if (!box || !NAME.test(String(box.name || ''))) return out(null, 'the relay lists no box for this host');
    if (box.mode !== 'hv-node') return null;
    const proofKey = String(row.proofKey || '').toLowerCase(), seen = verified.get(target);
    if (seen && seen.proofKey === proofKey && now() - seen.at < cacheMs) return out(true, `the proof key was verified as a capacity partition's ${Math.round((now() - seen.at) / 60000)} min ago`, seen.evidence);
    let pins;
    try { pins = pinnedCapacityApps(policy()); } catch (e) { return out(null, `this checker's Shield policy: ${e?.message || e}`); }
    if (!pins.length) return out(null, 'this checker\'s Shield policy pins no capacity app');
    const p0 = policy();
    // The verifier's own flow, with one request answered from the HOST instead of the relay: the app attestation. The
    // host's TPM session (the other requests) still goes through the relay, and nothing the host says is trusted: the
    // expected app and the admitted images are this checker's.
    let asked = null, missing = null;
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (!u.startsWith(`${base}/v1/enclaves/${box.name}/apps/`)) return fetch(url, init);
      const nonce = new URL(u).searchParams.get('nonce');
      const r = await fetch(String(row.endpoint).replace(/\/+$/, '') + `${CAPACITY_KEY_PATH}?nonce=${nonce}`, {redirect: 'error', headers: {accept: 'application/json'}, signal: init?.signal});
      const b = await r.json().catch(() => null);
      if (r.status !== 200 || !b?.document) {
        missing = r.status;
        return new Response(JSON.stringify({error: [429, 503].includes(r.status) ? 'busy' : 'no_capacity_partition', message: String(b?.reason || b?.error || `HTTP ${r.status}`).slice(0, 200)}),
          {status: [429, 503].includes(r.status) ? 503 : 502, headers: {'content-type': 'application/json'}});
      }
      asked = {document: b.document, handshakeSpki: b.handshakeSpki, key: b.key};
      const pin = pins.find(c => c.appSha256 === b.document.appSha256) || pins[0];
      // (echoed as asked: the verifier holds the answer to the name, the id and the nonce of its own request)
      return new Response(JSON.stringify({mode: 'hv-node', name: box.name, deployment: decodeURIComponent(u.slice(u.indexOf('/apps/') + 6).split('/')[0]), nonce, document: b.document, handshakeSpki: b.handshakeSpki,
        expected: {source: 'the capacity app this checker\'s own Shield policy pins', appSha256: pin.appSha256, runtimeId: pin.runtimeId},
        policy: {source: 'this checker\'s own Shield policy', measurements: pin.measurements, ...(pin.imageIdentities !== undefined ? {imageIdentities: pin.imageIdentities} : {}),
          minimumGuestSvn: p0.minimumGuestSvn ?? 0, platforms: p0.platforms}}), {status: 200, headers: {'content-type': 'application/json'}});
    };
    let v;
    try {
      mod = mod || (typeof verifier === 'function' ? await verifier() : verifier);
      if (typeof mod?.verifyShieldAppWeb !== 'function') return out(null, 'this checker has no verifyShieldAppWeb');
      // (the verifier wants a deployment id for its request and its record: the pinned app's hash stands in for one)
      v = await mod.verifyShieldAppWeb({apiBase: base, name: box.name, deployment: '0x' + pins[0].appSha256, fetchImpl, timeoutMs});
    } catch (e) { return out(null, `the verifier: ${e?.message || e}`); }
    const failed = Object.entries(v?.checks || {}).filter(([, ok]) => ok === false).map(([k]) => k);
    const why = String((v?.reasons || []).filter(r => !/^(OMITTED|WARNING)/.test(r)).at(-1) || v?.summary || v?.status || 'no verdict').slice(0, 200);
    const record = {epoch, box: box.name, status: v?.status ?? null, ...(failed.length ? {failed} : {}), ...(asked?.key?.address ? {partitionKey: String(asked.key.address).toLowerCase()} : {}), registered: proofKey};
    if (missing === 404) return out(false, 'an Enclave Shield host whose proof key is not a capacity partition\'s: it serves no partition key', record);
    if (v?.status === 'rejected' && failed.length) return out(false, `the capacity partition's evidence was refused: ${why}`, record);
    if (v?.status !== 'limited' && v?.status !== 'verified') return out(null, why, record);
    if (!asked || !keyStatementHolds({address: String(asked.key?.address || '').toLowerCase(), tlsSignature: asked.key?.tlsSignature, spki: Buffer.from(String(asked.handshakeSpki), 'base64')}))
      return out(false, 'the proof key is not stated by the partition\'s attested TLS key', record);
    if (String(asked.key.address).toLowerCase() !== proofKey) return out(false, 'the proof key the registry publishes is not the capacity partition\'s', record);
    const evidence = {...record, appSha256: asked.document.appSha256, tlsKeySha256: createHash('sha256').update(Buffer.from(String(asked.handshakeSpki), 'base64')).digest('hex'),
      ...(v.omissions?.length ? {omissions: v.omissions.slice(0, 16)} : {})};
    verified.set(target, {proofKey, at: now(), evidence});
    return out(true, 'the proof key was made in a capacity partition of an admitted image, on the boot its TPM just attested', evidence);
  };
}
