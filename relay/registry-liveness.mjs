// The relay's liveness for a DIRECT registry row (network/host-liveness.mjs; docs/network/host-liveness.md). Admission
// stays where it was (active, the operator allowlist, https and a public address, all in api-relay.js discoverRegistry);
// this decides only whether an admitted row is UP, from authenticated, bounded-fresh evidence:
//   - the host's own operator-signed capacity record, fetched from <its registered endpoint>/v1/host/capacity and
//     verified here against the row this relay read (signer = the row's operator, the exact registered endpoint and
//     hostId, chain 8453 and this registry, the row active), unexpired, and never older than one already seen for that
//     host and operator (no replay);
//   - or its operator's own registry write within the window (the legacy evidence: lastSeen moves only by the
//     operator's transaction, and hosts that predate signed records still send one).
// A tunnel row is not judged here: its attach is the relay's own authenticated observation (tunnel.js).
// An equivocating host (two different records with one sequence) loses its signed evidence until it signs a newer one; a
// registry write within the window still counts for it (that is the operator's own transaction, not its record).
// The record files are byte-identical copies of network/ (test/host-liveness.test.mjs pins them): the relay ships flat.
import { keccak256, toBytes } from "viem";
import { checkCapacityRecordShape, hostCapacityMessage, hostCapacityHash } from "./host-capacity-record.mjs";
import { hostLiveness, REGISTRY_UPDATE_WINDOW_SEC } from "./host-liveness.mjs";
import { recoverOp } from "./fleet-auth.js";

export const HOST_CAPACITY_PATH = "/v1/host/capacity";

/** Verify a capacity envelope against the registry row read for that host. -> record; throws with a reason. */
export async function verifyRowRecord(envelope, row, { chainId, registry, now = Date.now() }) {
  if (!envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join(",") !== "record,signature") throw new Error("not a capacity envelope");
  const { record } = checkCapacityRecordShape(envelope.record, now);
  if (record.hostId !== keccak256(toBytes(record.endpoint))) throw new Error("hostId is not keccak256(endpoint)");
  if (record.chainId !== chainId || record.registry !== String(registry || "").toLowerCase()) throw new Error("the record is for another chain or registry");
  if (record.endpoint !== String(row.endpoint)) throw new Error("the record names another endpoint than the registry row");
  const signer = await recoverOp(hostCapacityMessage(record), envelope.signature);
  if (!signer || signer !== record.operator) throw new Error("the record is not signed by its operator");
  if (signer !== String(row.operator).toLowerCase()) throw new Error("the signer is not the row's registry operator");
  if (row.active !== true) throw new Error("the row is not active");
  return record;
}

/**
 * createRegistryLiveness({ chainId, registry: () -> address, fetchJson: (url) -> json | null, now, registryUpdateWindowSec, log })
 * -> { judge(row) -> { live, evidence, untilMs, reason, seenSec }, forget(hostId) }
 *   row: the registry entry as read ({ endpoint, operator, active, lastSeen }). seenSec: the newest authenticated time
 *   (the record's issue time or the registry write), what the relay publishes as the row's lastSeen.
 */
export function createRegistryLiveness({ chainId = 8453, registry, fetchJson, now = Date.now, registryUpdateWindowSec = REGISTRY_UPDATE_WINDOW_SEC, log = () => {} }) {
  // hostId -> { binding, record | null, floor: { sequence, hash, equivocatedAt } }. Evidence is held for ONE binding (chain,
  // CURRENT registry, row operator): a moved registry (address-book repoint), chain or operator drops it, and a held
  // record is counted only while it still names the current chain and registry.
  const held = new Map();
  async function judge(row) {
    const t = now(), endpoint = String(row?.endpoint || ""), hostId = keccak256(toBytes(endpoint)), op = String(row?.operator || "").toLowerCase();
    const reg = String(typeof registry === "function" ? registry() : registry || "").toLowerCase(), binding = `${chainId}|${reg}|${op}`;
    let h = held.get(hostId);
    if (h && h.binding !== binding) { held.delete(hostId); h = null; }       // evidence never carries over to another binding
    // a record is re-read once less than half its life remains (the host re-signs at half life), or when none is held
    if (row?.active === true && (!h?.record || h.record.expiresAt - t < (h.record.expiresAt - h.record.issuedAt) / 2)) {
      const env = await fetchJson(endpoint.replace(/\/+$/, "") + HOST_CAPACITY_PATH).catch(() => null);
      if (env) {
        try {
          const r = await verifyRowRecord(env, row, { chainId, registry: reg, now: t });
          const f = h?.floor, hash = hostCapacityHash(r);
          if (f && r.sequence < f.sequence) throw new Error("an older record than one already seen (replay)");
          if (f && f.equivocatedAt !== null && r.sequence <= f.equivocatedAt) throw new Error("this host equivocated at this sequence: only a newer record restores its signed evidence");
          if (f && r.sequence === f.sequence && hash !== f.hash) {
            // two different records with one sequence: the host's signed evidence is void (the earlier one too) until a
            // strictly newer record arrives. Its operator's own registry write is separate, chain-authenticated evidence.
            h.record = null; f.equivocatedAt = r.sequence;
            throw new Error("two records with one sequence (equivocation): signed evidence withdrawn");
          }
          h = { binding, record: r, floor: { sequence: r.sequence, hash, equivocatedAt: f?.equivocatedAt ?? null } };
          held.set(hostId, h);
        } catch (e) { log(`capacity record of ${endpoint} refused: ${String(e.message).slice(0, 160)}`); }
      }
    }
    const rec = h?.record;
    const signedUntilMs = rec && rec.expiresAt > t && rec.chainId === chainId && rec.registry === reg && rec.operator === op ? rec.expiresAt : null;
    const v = hostLiveness(row, { nowMs: t, signedUntilMs, registryUpdateWindowSec });
    const seen = Math.max(Number(row?.lastSeen) || 0, signedUntilMs ? Math.floor(rec.issuedAt / 1000) : 0);
    return { ...v, seenSec: v.live ? seen : Number(row?.lastSeen) || 0 };
  }
  return { judge, forget: (hostId) => held.delete(hostId) };
}
