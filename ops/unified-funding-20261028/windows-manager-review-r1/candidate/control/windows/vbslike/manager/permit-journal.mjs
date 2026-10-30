/* ============================================================
   The manager's ONE durable permit journal (permit r1, SOURCE ONLY - authored, not run).

   One owned Windows log (win-durable.mjs), one owner, three sections replayed from it:
     lc   deployment -> the permit-gate lifecycle row (floors: generation/revision/sequence/digest, fenced, denial,
          assignment binding) with EXACTLY the transition rules of the r18 deployment-lifecycle-journal.mjs that the
          real DeploymentPermitGate calls (read/deny/restoreDenial/observeAssignment/permit/fence).
     ha   hostId -> the host-authority floor/Offline/handoff entry with EXACTLY the r18 deployment-host-authority-journal
          rules (accept/observe/bind/unbind), using the r18 pure comparison functions, not a re-derivation.
     inst instanceId -> the protected instance mapping (deployment, staged generation, app/runtime/image identity,
          launch epoch, VM GUID, staging deadline, accepted permit digest + effective deadline, cleanup state).
   Every mutation is ONE appended full-row record written and flushed BEFORE the caller acts on it; replay is
   last-record-wins per key over a hash chain read only after the exclusive open. There is no reset, no delete
   and no rewrite: a removed instance stays as a terminal record (`removed`, with how absence was confirmed).

   Ownership is the log handle. Every method calls assertLive() first; a released, failed or ambiguous log
   refuses, and onRelease listeners (the gate's close()) run when ownership ends. Nothing here takes a caller
   boolean as ownership.
   ============================================================ */
import { compareHostAuthority, validateHostAuthorityContext, offlineObservationOf } from "../../../network/deployment-host-authority.mjs";

const ID = /^0x[0-9a-f]{64}$/, DEC = /^(0|[1-9][0-9]{0,19})$/;
const INST = /^pp[0-9a-f]{32}$/;
const HANDOFF_KINDS = Object.freeze(["fresh-queued-start", "explicit-adoption"]);
const int = (n) => Number.isSafeInteger(n) && n >= 0;
export const PROTECTED_ID = INST;
export const INSTANCE_STATES = Object.freeze(["staging", "staged", "serving", "held", "removing", "remove-failed", "removed", "refused", "unknown"]);
const TERMINAL = new Set(["removed", "refused"]);
const emptyRow = () => ({ generation: 0, revision: 0, sequence: 0, digest: null, fenced: false, denial: null, binding: null });

export function openPermitJournal(log) {
  if (!log || typeof log.append !== "function" || typeof log.rows !== "function") throw Error("permit journal requires an owned log handle");
  const lc = new Map(), ha = new Map(), inst = new Map();
  for (const r of log.rows()) {
    if (r.kind === "lc") lc.set(r.data.id, r.data.row);
    else if (r.kind === "ha") ha.set(r.data.hostId, r.data.entry);
    else if (r.kind === "inst") inst.set(r.data.instanceId, r.data.rec);
    else if (!["genesis", "open-verified", "torn-tail-quarantine", "reconciled"].includes(r.kind)) throw Error(`unknown permit journal record ${r.kind}`);
  }
  const listeners = [];
  let releasing = null;
  const live = () => log.assertLive();
  const rowOf = (id) => { if (!ID.test(id || "")) throw Error("deployment id must be a lowercase bytes32"); return structuredClone(lc.get(id) ?? emptyRow()); };
  const update = (id, fn) => { live(); const next = fn(rowOf(id)); log.append("lc", { id, row: next }); lc.set(id, next); return structuredClone(next); };
  const host = (h) => { if (!ID.test(h || "")) throw Error("host id must be a lowercase bytes32"); return h; };
  const putHost = (h, entry) => { live(); log.append("ha", { hostId: h, entry }); ha.set(h, entry); };

  const journal = {
    // ---- the gate's lifecycle journal (r18 deployment-lifecycle-journal transition rules) ----
    read(id) { live(); return rowOf(id); },
    observeAssignment(id, generation, revision, bindingDigest = null) {
      if (!int(generation) || !int(revision) || generation === 0 || revision === 0) throw Error("invalid assignment");
      if (bindingDigest !== null && !ID.test(bindingDigest)) throw Error("invalid assignment binding");
      return update(id, (row) => {
        if (generation < row.generation || generation === row.generation && revision < row.revision) throw Error("assignment rollback");
        if (generation === row.generation && revision === row.revision) {
          if (row.binding && bindingDigest && row.binding !== bindingDigest) throw Error("assignment binding equivocation");
          return { ...row, binding: row.binding ?? bindingDigest };
        }
        return { ...row, generation, revision, binding: bindingDigest, fenced: false,
          ...(generation > row.generation ? { sequence: 0, digest: null } : {}) };
      });
    },
    permit(id, { generation, revision, sequence, digest }) {
      if (!int(sequence) || sequence < 1 || !ID.test(digest)) throw Error("invalid permit");
      return update(id, (row) => {
        if (row.fenced || row.generation !== generation || row.revision !== revision) throw Error("generation fenced or unknown");
        if (sequence < row.sequence || sequence === row.sequence && digest !== row.digest) throw Error("permit replay or equivocation");
        return { ...row, sequence, digest };
      });
    },
    fence(id, generation) { return update(id, (row) => { if (row.generation !== generation) throw Error("wrong generation to fence"); return { ...row, fenced: true }; }); },
    deny(id, denial) { return update(id, (row) => ({ ...row, denial: !row.denial || denial.blockNumber >= row.denial.blockNumber ? denial : row.denial })); },
    restoreDenial(id, blockNumber) {
      return update(id, (row) => {
        if (!row.denial || !int(blockNumber) || blockNumber < row.denial.blockNumber) throw Error("restoration precedes denial");
        return { ...row, denial: null };
      });
    },

    // ---- protected instance mapping ----
    instance(id) { live(); const r = inst.get(id); return r ? structuredClone(r) : null; },
    instances() { live(); return [...inst.values()].map((r) => structuredClone(r)); },
    activeFor(deployment) { live(); return [...inst.values()].filter((r) => r.deployment === deployment && !TERMINAL.has(r.state)).map((r) => structuredClone(r)); },
    putInstance(rec, { admission = false } = {}) {
      if (!INST.test(rec?.instanceId || "") || !INSTANCE_STATES.includes(rec.state)) throw Error("invalid protected instance record");
      const old = inst.get(rec.instanceId);
      if (old && TERMINAL.has(old.state)) throw Error("a terminal protected instance is never revived");
      if (old && (old.deployment !== rec.deployment || old.launchEpoch !== rec.launchEpoch || old.generation !== rec.generation
          || (old.vmId && old.vmId !== rec.vmId))) throw Error("protected instance identity is immutable");
      live(); log.append("inst", { instanceId: rec.instanceId, rec }, { admission }); inst.set(rec.instanceId, structuredClone(rec));
      return structuredClone(rec);
    },
    /** recorded after a real backend survey confirmed the exact state of every listed instance */
    reconciled(note) { live(); log.append("reconciled", note); },
    quarantined: () => log.quarantined(),

    // ---- host authority section (gate.hostAuthority; r18 sidecar rules) ----
    hostAuthority: {
      hostAuthorityOwned: true,
      read(h) { live(); const e = ha.get(host(h)); return e ? structuredClone(e) : null; },
      accept(h, ctx) {
        validateHostAuthorityContext(ctx);
        if (ctx.hostId !== host(h)) throw Error("host authority binds another host");
        live();
        const e = ha.get(h), how = compareHostAuthority(e?.floor ?? null, ctx);
        if (how === "equal") return how;
        putHost(h, { floor: { hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, digest: ctx.digest, context: structuredClone(ctx), offline: null },
          bound: structuredClone(e?.bound ?? {}) });
        return how;
      },
      observe(h, evidence) {
        live();
        const o = offlineObservationOf(evidence);
        if (!o || o.hostId !== host(h)) return "ignored";
        const e = ha.get(h), f = e?.floor ?? null;
        if (f && BigInt(o.hostGeneration) < BigInt(f.hostGeneration)) return "stale";
        if (f?.offline && BigInt(f.offline.hostGeneration) >= BigInt(o.hostGeneration)) return "already";
        const c = evidence.context;
        const floor = !f || BigInt(o.hostGeneration) > BigInt(f.hostGeneration) || BigInt(o.ownerRevision) > BigInt(f.ownerRevision)
          ? { hostGeneration: c.hostGeneration, ownerRevision: c.ownerRevision, digest: c.digest, context: structuredClone(c) }
          : { hostGeneration: f.hostGeneration, ownerRevision: f.ownerRevision, digest: f.digest, context: f.context };
        putHost(h, { floor: { ...floor, offline: { hostGeneration: o.hostGeneration, ownerRevision: o.ownerRevision, digest: o.digest,
          blockHash: o.blockHash, blockNumber: o.blockNumber } }, bound: structuredClone(e?.bound ?? {}) });
        return "recorded";
      },
      bind(h, id, ctx, { kind, at }) {
        if (!ID.test(id || "") || !HANDOFF_KINDS.includes(kind) || !Number.isSafeInteger(at)) throw Error("explicit handoff kind/time required");
        live();
        const e = ha.get(host(h));
        if (!e || e.floor.digest !== ctx?.digest || e.floor.offline) throw Error("an app context is handed only to the durable CURRENT Online host authority");
        if (!DEC.test(ctx.hostGeneration) || !DEC.test(ctx.ownerRevision)) throw Error("host authority context malformed");
        const b = { digest: ctx.digest, hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, kind, at };
        putHost(h, { floor: structuredClone(e.floor), bound: { ...structuredClone(e.bound), [id]: b } });
        return structuredClone(b);
      },
      unbind(h, id) {
        live();
        const e = ha.get(host(h));
        if (!e?.bound?.[id]) return false;
        const bound = structuredClone(e.bound); delete bound[id];
        putHost(h, { floor: structuredClone(e.floor), bound });
        return true;
      },
      assertLive() { live(); },
      failed: () => log.failed(),
      released: () => log.released(),
      onRelease(fn) { if (typeof fn === "function") listeners.push(fn); },
    },
    assertLive() { live(); },
    ownerId: log.ownerId, exclusion: log.exclusion,
    /** Ends ownership: withdrawal listeners (the gate's close) run first and are awaited; the handle closes after. */
    release(reason = "released") {
      if (releasing) return releasing;
      releasing = (async () => {
        const results = await Promise.allSettled(listeners.splice(0).map((fn) => Promise.resolve().then(() => fn(reason))));
        const bad = results.filter((r) => r.status === "rejected");
        // A failed withdrawal keeps the handle HELD: a new owner must not start while effects may be live.
        if (bad.length) return { released: false, errors: bad.map((r) => String(r.reason?.message ?? r.reason)) };
        log.release();
        return { released: true };
      })();
      return releasing;
    },
  };
  return journal;
}
