// Host capacity records (docs/network/independent-capacity.md): a host operator's signed statement of its own
// /availability document, so free capacity can be read without the Enclave relay's fleet poll.
//
// What a record is worth, exactly:
//   - its signature says WHO reported it: the operator EOA the pinned registry names, at one agreed quorum block, as the
//     active operator of this exact registered endpoint;
//   - it is NOT proof that the hardware exists, is free, or is reserved for anyone. A host may overstate; hardware is
//     proven at claim and connect time (attestation), and a claim can still fail;
//   - registered prices are registry facts (the ledger charges them) and are never capacity: a host can post a price
//     and have nothing free.
// The record's fields, bounds and message are network/host-capacity-record.mjs (no package imports, so hosts can ship
// it); this file adds what readers need: the keccak hostId check, signature recovery, the registry binding, floors and
// the aggregate. No I/O here: network/host-capacity-http.mjs fetches and discovers.
import { recoverMessageAddress, keccak256, toBytes } from "viem";
import { HOST_CAPACITY_KIND, HOST_CAPACITY_MAX_MS, HOST_CAPACITY_MAX_JSON, hostCapacityMessage, hostCapacityHash, parseAvailability,
         checkCapacityRecordShape, buildCapacityRecord, signCapacityRecord } from "./host-capacity-record.mjs";
export { HOST_CAPACITY_KIND, HOST_CAPACITY_MAX_MS, HOST_CAPACITY_MAX_JSON, hostCapacityMessage, hostCapacityHash, parseAvailability };

export const hostIdOf = (endpoint) => keccak256(toBytes(String(endpoint)));
/** Structure, bounds, lifetime and hostId = keccak256(endpoint). -> { record, availability } */
export function validateHostCapacityRecord(r, now = Date.now()) {
  const v = checkCapacityRecordShape(r, now);
  if (r.hostId !== hostIdOf(r.endpoint)) throw new Error("a host capacity record names its registered https endpoint and hostId = keccak256(endpoint)");
  return v;
}


/** A record for this host, now. `sequence` defaults to the issue time (monotonic for one signer's clock). */
export const buildHostCapacityRecord = (o) => buildCapacityRecord({ ...o, hostId: hostIdOf(o.endpoint) });
export async function signHostCapacity(account, record) {
  validateHostCapacityRecord(record, record?.issuedAt);
  return signCapacityRecord(account, record);
}

/**
 * Verify an envelope. pins = { chainId, registry }; entry = the AGREED registry row for record.hostId (one quorum
 * block): { endpoint, operator, active } or null. -> { record, availability, signer }; throws with a reason.
 */
export async function verifyHostCapacity(envelope, { pins, entry, now = Date.now() }) {
  if (!envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join(",") !== "record,signature") throw new Error("a host capacity envelope is exactly { record, signature }");
  const { record, availability } = validateHostCapacityRecord(envelope.record, now);
  if (record.chainId !== pins.chainId || record.registry !== String(pins.registry).toLowerCase()) throw new Error("the record is for another chain or registry");
  if (typeof envelope.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(envelope.signature)) throw new Error("the record carries no signature");
  let signer;
  try { signer = (await recoverMessageAddress({ message: hostCapacityMessage(record), signature: envelope.signature })).toLowerCase(); }
  catch { throw new Error("the signature does not recover"); }
  if (signer !== record.operator) throw new Error("the record is not signed by its operator");
  if (!entry) throw new Error("the host is not in the pinned registry");
  if (entry.endpoint !== record.endpoint) throw new Error("the registry names another endpoint for this host");
  if (String(entry.operator).toLowerCase() !== signer) throw new Error("the signer is not the host's current registry operator");
  if (entry.active !== true) throw new Error("the host is not active in the registry");
  return { record, availability, signer };
}

// ---- floors: no replay of an older record, no equivocation; per host AND operator -------------------------------------
export class CapacityFloors {
  constructor() { this.floors = new Map(); }
  /** -> "accept" | "same" ; throws on replay or equivocation. Does not record. */
  check(r) {
    const f = this.floors.get(`${r.hostId}|${r.operator}`);
    if (!f) return "accept";
    if (r.sequence < f.sequence) throw Object.assign(new Error("an older host capacity record than one already seen (replay)"), { stale: true });
    if (r.sequence === f.sequence) { if (f.hash !== hostCapacityHash(r)) throw Object.assign(new Error("two different records with one sequence (equivocation)"), { equivocation: true }); return "same"; }
    return "accept";
  }
  record(r) {
    const k = `${r.hostId}|${r.operator}`, f = this.floors.get(k);
    if (!f || r.sequence > f.sequence) this.floors.set(k, { sequence: r.sequence, hash: hostCapacityHash(r) });
    while (this.floors.size > 65536) this.floors.delete(this.floors.keys().next().value);
  }
  toJSON() { return Object.fromEntries(this.floors); }
  static from(o) { const f = new CapacityFloors(); for (const [k, v] of Object.entries(o || {})) if (Number.isSafeInteger(v?.sequence) && /^[0-9a-f]{64}$/.test(v?.hash || "")) f.floors.set(k, v); return f; }
}

// ---- choosing one record per host, and the aggregate -------------------------------------------------------------------
/**
 * candidates: [{ envelope, verified: {record, availability} }] for ONE host from all sources. -> the winner, or a
 * conflict marker. Copies of one record (same bytes) are one record; a higher sequence wins; an equal sequence with
 * different bytes is equivocation and selects nothing.
 */
export function chooseRecord(candidates) {
  let best = null, conflict = false;
  for (const c of candidates) {
    const r = c.verified.record;
    if (!best || r.sequence > best.verified.record.sequence) { best = c; conflict = false; continue; }
    if (r.sequence === best.verified.record.sequence && hostCapacityHash(r) !== hostCapacityHash(best.verified.record)) conflict = true;
  }
  return conflict ? { equivocation: true } : best;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
// the relay's own pool rules (relay/api-relay.js gpuFreeOf / cpuFreeOf), so a figure means the same thing on both paths
export const gpuFreeOf = (a) => num(a.gpuShareFree ?? (a.gpu ? a.maxShare ?? 0 : 0));
export const cpuFreeOf = (a) => num(a.cpuShareFree ?? (a.gpu ? 0 : a.maxShare ?? 0));
/**
 * The /availability aggregate over verified host documents, each host once (the relay's aggregateAvailability rules:
 * best card slice among gpu === true hosts, best node pool among all, gpuEnclaveCpuShareFree on the best card's host).
 * Only hosts whose document says they claim work count toward buyable capacity (the relay's servingEnclaves rule, here
 * on the host's own word). An Enclave Shield card (gpu false, a `shielded` block) is its own tier, never folded into the
 * confidential GPU pool. Every number is self-reported and labelled so.
 */
export function aggregateCapacity(hosts, { unknown = 0 } = {}) {
  const claiming = hosts.filter((h) => h.availability.claimEnabled === true);
  const best = (rows, f) => rows.slice().sort((x, y) => f(y.availability) - f(x.availability))[0] || null;
  const gh = best(claiming.filter((h) => h.availability.gpu === true), gpuFreeOf), ch = best(claiming, cpuFreeOf);
  const sh = best(claiming.filter((h) => h.availability.gpu !== true && h.availability.shielded && typeof h.availability.shielded === "object"), gpuFreeOf);
  const g = gh?.availability || null, c = ch?.availability || null;
  const sum = (rows, k) => Math.round(rows.reduce((s, h) => s + num(h.availability[k]), 0) * 10) / 10;
  return {
    aggregate: true, selfReported: true, enclaves: hosts.length, claiming: claiming.length, unknown,
    gpu: !!g, type: g ? "gpu" : "cpu",
    gpuShareFree: g ? gpuFreeOf(g) : 0, cpuShareFree: c ? cpuFreeOf(c) : 0, gpuEnclaveCpuShareFree: g ? cpuFreeOf(g) : 0,
    maxShare: g ? gpuFreeOf(g) : (c ? cpuFreeOf(c) : 0),
    vramFreeGb: g ? num(g.vramFreeGb) : 0, gpuTflopsFree: g ? num(g.gpuTflopsFree) : 0, smFree: g ? num(g.smFree) : 0, smTotal: g ? num(g.smTotal) : 0,
    cardVramGb: g ? num(g.cardVramGb) : 0, cardTflops: g ? num(g.cardTflops) : 0, cards: g ? num(g.cards) : 0,
    vcpusFree: c ? num(c.vcpusFree) : 0, ramGbFree: c ? num(c.ramGbFree) : 0, cpuGflopsFree: c ? num(c.cpuGflopsFree) : 0,
    nodeVcpus: c ? num(c.nodeVcpus) : 0, nodeRamGb: c ? num(c.nodeRamGb) : 0, nodeGflops: c ? num(c.nodeGflops) : 0,
    shielded: sh ? { gpuShareFree: gpuFreeOf(sh.availability), host: sh.hostId, tier: sh.availability.tier ?? null,
                     vramGb: num(sh.availability.shielded.vramGb), hostExcluded: false } : null,
    // free resources across hosts, each host once; confidential card memory only from gpu === true hosts
    totals: { vcpusFree: sum(claiming, "vcpusFree"), ramGbFree: sum(claiming, "ramGbFree"), vramFreeGb: sum(claiming.filter((h) => h.availability.gpu === true), "vramFreeGb") },
    bestGpuHost: gh?.hostId ?? null, bestCpuHost: ch?.hostId ?? null,
  };
}
