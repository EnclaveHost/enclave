// Public signed-policy CARRIERS for the platform host policy (work/hosted-service-placement): how a host or a client obtains
// the administrator's signed policy document WITHOUT any fleet (DigitalOcean) mirror - including a fresh cold start with no
// admission cache while the address book anchors a policy.
//
// A carrier is untrusted transport, never an authority. Nothing here admits anything: the UNCHANGED gate
// (network/platform-host-policy.mjs through host-policy-runtime.mjs) still requires the exact digest the book anchors at a
// fresh majority-agreed block, the book's CURRENT owner's signature at that block (EIP-712, or ERC-1271), the persisted
// high-water sequence (rollback and equivocation refusal), and applies bans and allowlists. Carriers only choose which
// candidate bytes the gate is shown.
//
// Sources (a carrier is async (digest) -> [{ document, signature }]):
//   fileCarrier    a directory of <digest>.json: a copy the operator imported (from any channel - the admin's publication,
//                  another host, removable media) and this host's own policy-mirror store. It needs no network, so a host
//                  whose network carriers are all down, or that is the FIRST carrier, still loads the anchored policy: this
//                  is what breaks "the mirror cannot start until it fetches its own policy".
//   httpCarriers   policy-mirror roles on other Enclave hosts, <base>/<digest>.json (http or https: the bytes self-verify).
//   indexCarriers  policy-mirror roles advertised in the pinned EnclaveServiceIndex (kind "policy"), read at one agreed block.
// Before the gate sees a candidate, carrierFetch checks it against FRESH authoritative state (freshVerifier: its digest is
// the one asked for, and the book's current owner signs it at a fresh agreed block), so a lying carrier cannot shadow an
// honest one; the gate then verifies it again, independently.
//
// The gate's mirror list takes HTTPS origins (host-policy-mirrors.mjs, shared with the measured guest, the relay bundle and
// the site build). Rather than change that code, the carrier set is shown to it as ONE reserved origin, CARRIER_MIRROR
// (`.invalid` never resolves, so without carrierFetch it reaches nothing), which carrierFetch answers locally; every other
// request goes to the real fetch unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { readPolicyFacts, verifySignedPolicy, policyDigest, decodeAnchor } from './platform-host-policy.mjs';
import { MAX_POLICY_RESPONSE } from './host-policy-mirrors.mjs';
import { createPublicClient, http } from 'viem';
import { rpcEndpoint, rpcLabel } from './rpc-identity.mjs';

// the reserved origin and the carrier base rule live in the dependency-free host-policy-gate-config.mjs (the Windows node
// validates an operator's carriers before it writes them); re-exported here unchanged
import { CARRIER_MIRROR, MAX_CARRIERS, CARRIER_BASE as BASE, validateCarrierBases } from './host-policy-gate-config.mjs';
export { CARRIER_MIRROR, MAX_CARRIERS, validateCarrierBases };
const H32 = /^0x[0-9a-f]{64}$/;
/**
 * RPC URLs -> the {label, client} peers service-index.mjs readServiceIndex takes (entries pass through). https only (http
 * on loopback); one vote per provider or loopback port.
 */
export function rpcPeers(list) {
  if (!Array.isArray(list)) throw Error('RPC peers: a list');
  const seen = new Set();
  return list.map((u) => {
    if (u && typeof u === 'object') return u;
    const { identity } = rpcEndpoint(u);
    if (seen.has(identity)) throw Error('RPC peers must use distinct providers (or distinct loopback test ports)');
    seen.add(identity);
    return { label: rpcLabel(u), client: createPublicClient({ transport: http(u, { timeout: 8000, retryCount: 0 }) }) };
  });
}
/** A candidate's own digest, or null (malformed): computed from the document, never taken from the carrier. */
export function candidateDigest(c) {
  try { return policyDigest(typeof c.document === 'string' ? JSON.parse(c.document) : c.document); } catch { return null; }
}
const shaped = (j) => j && typeof j === 'object' && typeof j.signature === 'string' && /^0x[0-9a-fA-F]{2,2048}$/.test(j.signature)
  && (typeof j.document === 'string' || (j.document && typeof j.document === 'object'));

/** <dir>/<digest>.json files (at most MAX_POLICY_RESPONSE bytes each). A missing directory or file is no candidate. */
export function fileCarrier(dir) {
  return async (digest) => {
    if (!H32.test(String(digest))) return [];
    const file = path.join(dir, `${digest}.json`);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_POLICY_RESPONSE) return [];
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return shaped(j) ? [{ document: j.document, signature: j.signature }] : [];
    } catch { return []; }
  };
}

async function boundedJson(r) {
  const declared = r.headers?.get?.('content-length');
  if (!r.ok || (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_POLICY_RESPONSE)) || !r.body?.getReader) { try { await r.body?.cancel(); } catch {} return null; }
  const reader = r.body.getReader(), chunks = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_POLICY_RESPONSE) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
/** One carrier per base URL: GET <base>/<digest>.json, bounded, no redirects or credentials. */
export function httpCarriers(bases, { fetch = globalThis.fetch, timeoutMs = 8000 } = {}) {
  return validateCarrierBases(bases).map((base) => async (digest) => {
    if (!H32.test(String(digest))) return [];
    try {
      const r = await fetch(`${base}/${digest}.json`, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      const j = await boundedJson(r);
      return shaped(j) ? [{ document: j.document, signature: j.signature }] : [];
    } catch { return []; }
  });
}
/**
 * Policy-mirror roles advertised in the pinned service index (kind "policy"): the listing is read at one agreed block and
 * cached for refreshMs (a failed read keeps the previous listing). Advertisements are untrusted candidates like any carrier;
 * a banned operator's carrier can only withhold, never admit. accept(endpoint) -> bool filters (e.g. failure domains).
 */
export function indexCarriers({ pin, peers, clients, fetch = globalThis.fetch, timeoutMs = 8000, refreshMs = 5 * 60_000, accept = async () => true, log = () => {},
  chainAuthority, chainVerifier }) {
  let listing = [], at = 0, reading = null;
  if (peers && chainAuthority !== 'verifier') peers = rpcPeers(peers);
  const list = async () => {
    if (Date.now() - at < refreshMs && at) return listing;
    reading ||= (async () => {
      try {
        const si = await import('./service-index.mjs');
        const r = await si.readServiceIndex({ peers, clients, pin, kinds: ['policy'], chainAuthority, chainVerifier });
        const bases = [];
        for (const c of r.candidates) for (const e of c.endpoints) {
          const b = String(e).replace(/\/+$/, '');
          if (BASE.test(b) && !bases.includes(b) && bases.length < MAX_CARRIERS && await accept(b)) bases.push(b);
        }
        listing = bases; at = Date.now();
      } catch (e) { log(`[policy-carriers] service index listing unavailable: ${e.message}`); }
      finally { reading = null; }
      return listing;
    })();
    return reading;
  };
  const carrier = async (digest) => {
    const bases = await list();
    for (const one of bases.length ? httpCarriers(bases, { fetch, timeoutMs }) : []) { const c = await one(digest); if (c.length) return c; }
    return [];
  };
  carrier.listing = () => [...listing];
  return carrier;
}

/**
 * snapshot(fn): one majority-agreed fresh block (host-policy-runtime.mjs quorumSnapshot / clientSnapshot). ->
 * async (candidates) -> { block, anchor: {state, digest?}, verified: [{ document, signature, digest, sequence, anchored }] }:
 * the candidates the book's CURRENT owner signs at that block, bound to this book, its registry and hostOwnership.
 */
export function freshVerifier({ snapshot, book, hostOwnership }) {
  const lc = (s) => String(s).toLowerCase();
  return async (cands = []) => {
    const pairs = cands.slice(0, 40).map((c) => ({ digest: candidateDigest(c), signature: c.signature })).filter((p) => p.digest);
    const facts = await snapshot(async (at) => ({ ...(await readPolicyFacts(at, { book: lc(book), hostOwnership: lc(hostOwnership), check1271: pairs })), block: at.block ?? null }));
    let anchor; try { anchor = decodeAnchor(facts.anchorHi, facts.anchorLo); } catch (e) { anchor = { state: 'torn', reason: e.message }; }
    const authority = { book: lc(book), registry: facts.registry, hostOwnership: lc(hostOwnership), owner: facts.owner, ownerIsContract: facts.ownerIsContract,
      isValid1271: async (d, s) => facts.valid1271?.[d + ':' + s] === true };
    const verified = [];
    for (const c of cands.slice(0, 40)) {
      try {
        const v = await verifySignedPolicy(c, authority);
        verified.push({ document: typeof c.document === 'string' ? c.document : JSON.stringify(c.document), signature: c.signature, digest: v.digest,
          sequence: v.policy.sequence, anchored: anchor.state === 'anchored' && anchor.digest === v.digest });
      } catch { /* not the current owner's, or bound elsewhere: never shown */ }
    }
    return { block: facts.block === null || facts.block === undefined ? null : String(facts.block), anchor, verified };
  };
}

/**
 * A fetch that answers CARRIER_MIRROR/<digest>.json from the carriers (in order; the first candidate that verifies at a
 * fresh block wins) and passes every other request to `fetch`. latest.json (unanchored operation) is never answered: a
 * carrier serves only digest-named documents.
 */
export function carrierFetch({ carriers, verify, fetch = globalThis.fetch, log = () => {} }) {
  const prefix = CARRIER_MIRROR + '/';
  return async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith(prefix)) return fetch(url, opts);
    // the gate's own deadline (its AbortSignal) bounds the whole carrier walk
    if (!opts.signal) return answer(u);
    if (opts.signal.aborted) throw opts.signal.reason;
    return Promise.race([answer(u), new Promise((_, no) => opts.signal.addEventListener('abort', () => no(opts.signal.reason), { once: true }))]);
  };
  async function answer(u) {
    const m = /^(0x[0-9a-f]{64})\.json$/.exec(u.slice(prefix.length));
    if (!m) return new Response('not served', { status: 404 });
    for (const carrier of carriers) {
      let cands = [];
      try { cands = (await carrier(m[1])).filter((c) => candidateDigest(c) === m[1]); } catch { cands = []; }
      if (!cands.length) continue;
      let v;
      try { v = await verify(cands); } catch (e) { log(`[policy-carriers] fresh verification unavailable: ${e.message}`); return new Response('chain unavailable', { status: 503 }); }
      const ok = v.verified.find((x) => x.digest === m[1]);
      if (ok) return new Response(JSON.stringify({ document: ok.document, signature: ok.signature }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('no carrier has it', { status: 404 });
  }
}
