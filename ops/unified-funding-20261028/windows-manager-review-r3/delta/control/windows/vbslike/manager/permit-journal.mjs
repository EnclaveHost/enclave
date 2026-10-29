/* ============================================================
   The manager's ONE durable permit journal (permit r3, SOURCE ONLY - authored, not run).

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

   r2 REPLAY SEMANTICS (root finding 2). The hash chain proves only INTEGRITY: the bytes form one unbroken
   sha256 chain from a genesis. It is UNKEYED, so it proves nothing about who wrote them (AUTHENTICITY): anyone
   able to write the ACL'd file can recompute it. Authenticity of every floor comes from the signed v2 permits and
   the authenticated authority reads that produced it, and the file's protection is the owned handle + ACL
   (T0-hv: a host administrator is inside the trust boundary). So replay does NOT trust a well-chained row: every
   record's exact schema AND its transition from the previous row for the same key are checked by the SAME
   functions (checkLc/checkHa/checkInst) that run before every live append, so a live write can never produce a
   journal that will not reopen, and a chained-but-impossible row (negative generation, generation/sequence/denial
   rollback, binding equivocation, unfencing without a newer assignment, revived terminal instance, changed
   immutable identity, unknown field or record kind) refuses the WHOLE journal. Nothing is defaulted to empty.

   r3 REPLAY SEMANTICS (peer finding replay-incomplete):
     - an instance's accepted permit never resets to null, never changes digest at the same sequence, never rolls
       its sequence back, and never moves its effective deadline later for the same digest;
     - `removed` carries the EXACT confirmation schema { by: "survey", at, vmId } with vmId equal to the record's
       bound GUID (null only if never bound); `confirmed` on any other state is refused;
     - a lifecycle row that CLEARS a denial must be immediately preceded by its `restore` provenance record
       (deployment, the cleared denial's blockNumber, the restoring permit's restoredAt >= it), written by
       restoreDenial before the row; a cleared denial without that provenance refuses the journal.
     A durable `removed` is still only as authentic as the owned file: it never erases the obligation to remove a
     protected VM that a survey still finds (PermitEnforcement.recoverAtStartup removes it regardless).

   r2 OWNERSHIP (root finding 1). release() revokes every new admission SYNCHRONOUSLY at its beginning (the
   journal's and hostAuthority's assertLive() throw, so the r18 gate's ownerLive()/work()/stage() refuse and the
   enforcement capability is false), while the PHYSICAL handle stays held until every withdrawal listener has
   settled successfully. During that window only withdrawal-direction writes are accepted (fence, deny,
   hostAuthority.observe/unbind, instance transitions into held/removing/remove-failed/removed/unknown/refused).
   A rejected listener is never treated as success: the handle stays held, admissions stay revoked FOREVER for this
   journal object, and a later release() call retries exactly the listeners that failed.
   ============================================================ */
import { compareHostAuthority, validateHostAuthorityContext, offlineObservationOf } from "../../../network/deployment-host-authority.mjs";

const ID = /^0x[0-9a-f]{64}$/, DEC = /^(0|[1-9][0-9]{0,19})$/;
const INST = /^pp[0-9a-f]{32}$/, E32 = /^[0-9a-f]{32}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDOFF_KINDS = Object.freeze(["fresh-queued-start", "explicit-adoption"]);
const int = (n) => Number.isSafeInteger(n) && n >= 0;
const plain = (o) => !!o && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const exactKeys = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const bad = (what) => { throw Object.assign(Error(`permit journal: ${what}`), { code: "JOURNAL_SEMANTICS" }); };
export const PROTECTED_ID = INST;
export const INSTANCE_STATES = Object.freeze(["staging", "staged", "serving", "held", "removing", "remove-failed", "removed", "refused", "unknown"]);
const TERMINAL = new Set(["removed", "refused"]);
/** States an instance may move INTO while admissions are revoked (release in progress). */
export const WITHDRAWAL_STATES = Object.freeze(["held", "removing", "remove-failed", "removed", "unknown", "refused"]);
/** Allowed instance state transitions (prev -> next). The first record of an instance is always `staging`. */
const NEXT = Object.freeze({
  staging: ["staging", "staged", "held", "removing", "remove-failed", "unknown", "refused"],
  staged: ["staged", "serving", "held", "removing", "remove-failed", "unknown"],
  serving: ["serving", "held", "removing", "remove-failed", "unknown"],
  held: ["held", "removing", "remove-failed", "unknown"],
  removing: ["removing", "remove-failed", "removed", "unknown"],
  "remove-failed": ["remove-failed", "removing", "removed", "unknown"],
  unknown: ["unknown", "removing", "remove-failed", "removed"],
  removed: [], refused: [],
});
const META_KINDS = new Set(["genesis", "open-verified", "torn-tail-quarantine", "reconciled"]);
const LC_KEYS = ["generation", "revision", "sequence", "digest", "fenced", "denial", "binding"];
const INST_KEYS = ["instanceId", "deployment", "generation", "launchEpoch", "managerEpoch", "state", "stagingWallUntil", "vmId", "appId",
  "runtimeId", "image", "recordSha256", "permit", "reason", "error", "at"];
const INST_OPTIONAL = new Set(["confirmed"]);
const IDENTITY_ONCE_SET = ["vmId", "appId", "runtimeId", "image", "recordSha256"];
const emptyRow = () => ({ generation: 0, revision: 0, sequence: 0, digest: null, fenced: false, denial: null, binding: null });
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------- schema + transition checks (replay AND every live append) ----------------
/**
 * lifecycle row: exact schema, internal consistency, and the r18 transition from `prev` (null = no prior row).
 * r3: `restore` is the provenance record that must immediately precede a row clearing a denial (null otherwise).
 */
export function checkLc(id, prev, next, restore = null) {
  if (!ID.test(id || "")) bad("lc deployment id is not a lowercase bytes32");
  if (!exactKeys(next, LC_KEYS)) bad(`lc ${id}: unknown or missing fields`);
  const { generation: g, revision: r, sequence: s, digest: d, fenced, denial, binding } = next;
  if (!int(g) || !int(r) || !int(s)) bad(`lc ${id}: generation/revision/sequence must be non-negative safe integers`);
  if (typeof fenced !== "boolean") bad(`lc ${id}: fenced must be boolean`);
  if (d !== null && !ID.test(d)) bad(`lc ${id}: digest malformed`);
  if (binding !== null && !ID.test(binding)) bad(`lc ${id}: binding malformed`);
  if ((s === 0) !== (d === null)) bad(`lc ${id}: sequence and digest must be both empty or both set`);
  if (g === 0 && (r !== 0 || s !== 0 || binding !== null || fenced)) bad(`lc ${id}: no assignment yet but floors are set`);
  if (g > 0 && r === 0) bad(`lc ${id}: assignment without revision`);
  if (denial !== null && (!plain(denial) || !int(denial.blockNumber))) bad(`lc ${id}: denial must carry a non-negative blockNumber`);
  const p = prev ?? emptyRow();
  if (g < p.generation || (g === p.generation && r < p.revision)) bad(`lc ${id}: assignment rollback`);
  const newer = g > p.generation || r > p.revision;
  if (g > p.generation && (s !== 0 || d !== null)) bad(`lc ${id}: a new generation must restart the permit sequence`);
  if (g === p.generation) {
    if (s < p.sequence || (s === p.sequence && d !== p.digest)) bad(`lc ${id}: permit sequence rollback or equivocation`);
    if (!newer && p.binding !== null && binding !== p.binding) bad(`lc ${id}: assignment binding equivocation`);
    if (p.fenced && !fenced && !newer) bad(`lc ${id}: unfenced without a newer assignment`);
    if (fenced && (s !== p.sequence || d !== p.digest)) bad(`lc ${id}: permit advanced while fenced`);
  }
  if (p.denial && denial && denial.blockNumber < p.denial.blockNumber) bad(`lc ${id}: denial floor rollback`);
  if (p.denial && !denial) {
    // r3: a cleared denial needs its persisted restoration provenance, for exactly this denial
    if (!restore || restore.id !== id || restore.denialBlockNumber !== p.denial.blockNumber || !int(restore.restoredAt) || restore.restoredAt < p.denial.blockNumber)
      bad(`lc ${id}: denial cleared without its restoration provenance`);
  }
  if (p.denial && denial && !sameJson(p.denial, denial) && denial.blockNumber === p.denial.blockNumber) bad(`lc ${id}: denial rewritten at the same block`);
  return next;
}

/** host-authority entry: exact schema, context digests, monotonic floor/offline, handoffs only to the current Online floor. */
export function checkHa(hostId, prev, next) {
  if (!ID.test(hostId || "")) bad("ha host id is not a lowercase bytes32");
  if (!exactKeys(next, ["floor", "bound"]) || !plain(next.bound)) bad(`ha ${hostId}: unknown or missing fields`);
  const f = next.floor;
  if (!exactKeys(f, ["hostGeneration", "ownerRevision", "digest", "context", "offline"])) bad(`ha ${hostId}: floor fields`);
  let c; try { c = validateHostAuthorityContext(f.context); } catch (e) { bad(`ha ${hostId}: floor context invalid: ${e.message}`); }
  if (c.hostId !== hostId || c.digest !== f.digest || c.hostGeneration !== f.hostGeneration || c.ownerRevision !== f.ownerRevision)
    bad(`ha ${hostId}: floor differs from its own context`);
  if (f.offline !== null) {
    const o = f.offline;
    if (!exactKeys(o, ["hostGeneration", "ownerRevision", "digest", "blockHash", "blockNumber"]) || !DEC.test(o.hostGeneration) || !DEC.test(o.ownerRevision)
        || !ID.test(o.digest) || !ID.test(o.blockHash) || !(o.blockNumber === null || DEC.test(o.blockNumber))) bad(`ha ${hostId}: offline record malformed`);
  }
  for (const [dep, b] of Object.entries(next.bound)) {
    if (!ID.test(dep) || !exactKeys(b, ["digest", "hostGeneration", "ownerRevision", "kind", "at"]) || !ID.test(b.digest) || !DEC.test(b.hostGeneration)
        || !DEC.test(b.ownerRevision) || !HANDOFF_KINDS.includes(b.kind) || !Number.isSafeInteger(b.at)) bad(`ha ${hostId}: handoff ${dep} malformed`);
  }
  if (prev) {
    const pf = prev.floor, G = BigInt;
    if (G(f.hostGeneration) < G(pf.hostGeneration) || G(f.ownerRevision) < G(pf.ownerRevision)) bad(`ha ${hostId}: host authority floor rollback`);
    const sameFloor = f.hostGeneration === pf.hostGeneration && f.ownerRevision === pf.ownerRevision;
    if (sameFloor && f.digest !== pf.digest) bad(`ha ${hostId}: host authority equivocation`);
    if (pf.offline && !f.offline && !(G(f.hostGeneration) > G(pf.offline.hostGeneration))) bad(`ha ${hostId}: Offline cleared without a newer host generation`);
    if (pf.offline && f.offline && G(f.offline.hostGeneration) < G(pf.offline.hostGeneration)) bad(`ha ${hostId}: Offline floor rollback`);
    for (const [dep, b] of Object.entries(next.bound))
      if (!sameJson(prev.bound[dep], b) && (b.digest !== f.digest || f.offline)) bad(`ha ${hostId}: handoff ${dep} not to the current Online floor`);
  } else {
    for (const [dep, b] of Object.entries(next.bound)) if (b.digest !== f.digest || f.offline) bad(`ha ${hostId}: handoff ${dep} not to the current Online floor`);
  }
  return next;
}

/** protected instance record: exact schema, immutable identity, allowed state transitions, no revival. */
export function checkInst(instanceId, prev, next) {
  if (!INST.test(instanceId || "") || !plain(next) || next.instanceId !== instanceId) bad("inst record does not name its instance");
  const keys = Object.keys(next);
  if (!INST_KEYS.every((k) => Object.hasOwn(next, k)) || keys.some((k) => !INST_KEYS.includes(k) && !INST_OPTIONAL.has(k))) bad(`inst ${instanceId}: unknown or missing fields`);
  const n = next;
  if (!ID.test(n.deployment || "") || !Number.isSafeInteger(n.generation) || n.generation < 1 || !E32.test(n.launchEpoch || "")
      || typeof n.managerEpoch !== "string" || !n.managerEpoch || n.managerEpoch.length > 128) bad(`inst ${instanceId}: identity malformed`);
  if (!INSTANCE_STATES.includes(n.state) || !Number.isSafeInteger(n.stagingWallUntil) || !Number.isSafeInteger(n.at)) bad(`inst ${instanceId}: state/time malformed`);
  if (n.vmId !== null && !GUID.test(n.vmId)) bad(`inst ${instanceId}: VM GUID malformed`);
  for (const k of ["appId", "runtimeId", "recordSha256", "reason", "error"]) if (n[k] !== null && typeof n[k] !== "string") bad(`inst ${instanceId}: ${k} malformed`);
  if (n.permit !== null && (!exactKeys(n.permit, ["digest", "sequence", "wallUntil"]) || !ID.test(n.permit.digest) || !int(n.permit.sequence)
      || n.permit.sequence < 1 || !Number.isSafeInteger(n.permit.wallUntil))) bad(`inst ${instanceId}: permit malformed`);
  if (["staged", "serving"].includes(n.state) && (n.vmId === null || n.appId === null || n.runtimeId === null)) bad(`inst ${instanceId}: ${n.state} without its bound identity`);
  if (n.state === "serving" && n.permit === null) bad(`inst ${instanceId}: serving without a permit`);
  if (["staging", "staged"].includes(n.state) && n.permit !== null) bad(`inst ${instanceId}: ${n.state} with an accepted permit`);
  if (n.state === "removed") {
    const c = n.confirmed;
    if (!exactKeys(c, ["by", "at", "vmId"]) || c.by !== "survey" || !Number.isSafeInteger(c.at) || c.vmId !== n.vmId) bad(`inst ${instanceId}: removed without its exact survey confirmation`);
  } else if (Object.hasOwn(n, "confirmed")) bad(`inst ${instanceId}: confirmation on a ${n.state} record`);
  if (!prev) { if (n.state !== "staging") bad(`inst ${instanceId}: first record must be the staging intent`); return next; }
  if (!NEXT[prev.state]?.includes(n.state)) bad(`inst ${instanceId}: transition ${prev.state} -> ${n.state} is not allowed`);
  for (const k of ["deployment", "generation", "launchEpoch", "managerEpoch", "stagingWallUntil"]) if (prev[k] !== n[k]) bad(`inst ${instanceId}: immutable ${k} changed`);
  for (const k of IDENTITY_ONCE_SET) if (prev[k] !== null && !sameJson(prev[k], n[k])) bad(`inst ${instanceId}: bound ${k} changed`);
  if (prev.permit && n.permit === null) bad(`inst ${instanceId}: accepted permit reset`);
  if (prev.permit && n.permit) {
    if (n.permit.sequence < prev.permit.sequence) bad(`inst ${instanceId}: permit sequence rollback`);
    if (n.permit.sequence === prev.permit.sequence && n.permit.digest !== prev.permit.digest) bad(`inst ${instanceId}: permit equivocation at the same sequence`);
    if (n.permit.digest === prev.permit.digest && n.permit.wallUntil > prev.permit.wallUntil) bad(`inst ${instanceId}: the same permit extended its deadline`);
  }
  if (prev.permit && !["serving", ...WITHDRAWAL_STATES].includes(n.state)) bad(`inst ${instanceId}: permit carried into ${n.state}`);
  if (n.at < prev.at) bad(`inst ${instanceId}: record time went backwards`);
  return next;
}

export function openPermitJournal(log) {
  if (!log || typeof log.append !== "function" || typeof log.rows !== "function") throw Error("permit journal requires an owned log handle");
  const lc = new Map(), ha = new Map(), inst = new Map();
  let pendingRestore = null;                                     // r3: a `restore` record applies only to the IMMEDIATELY next row
  for (const r of log.rows()) {                                  // complete semantic replay: any impossible row refuses the journal
    const d = r.data, restore = pendingRestore; pendingRestore = null;
    if (r.kind === "lc") { if (!exactKeys(d, ["id", "row"])) bad("lc record shape"); lc.set(d.id, checkLc(d.id, lc.get(d.id) ?? null, d.row, restore)); }
    else if (r.kind === "restore") {
      if (!exactKeys(d, ["id", "denialBlockNumber", "restoredAt"]) || !ID.test(d.id) || !int(d.denialBlockNumber) || !int(d.restoredAt) || d.restoredAt < d.denialBlockNumber) bad("restore record shape");
      pendingRestore = d;
    }
    else if (r.kind === "ha") { if (!exactKeys(d, ["hostId", "entry"])) bad("ha record shape"); ha.set(d.hostId, checkHa(d.hostId, ha.get(d.hostId) ?? null, d.entry)); }
    else if (r.kind === "inst") { if (!exactKeys(d, ["instanceId", "rec"])) bad("inst record shape"); inst.set(d.instanceId, checkInst(d.instanceId, inst.get(d.instanceId) ?? null, d.rec)); }
    else if (!META_KINDS.has(r.kind)) bad(`unknown record kind ${r.kind}`);
  }
  const listeners = [];
  let phase = "live", releasing = null, failedListeners = [];
  const physical = () => log.assertLive();                       // the held handle (withdrawal writes need only this)
  const admit = () => { physical(); if (phase !== "live") throw Error(`permit journal ${phase}: new admissions are revoked`); };
  const rowOf = (id) => { if (!ID.test(id || "")) throw Error("deployment id must be a lowercase bytes32"); return structuredClone(lc.get(id) ?? emptyRow()); };
  const update = (id, fn, gate = admit, restore = null) => {
    gate(); const next = fn(rowOf(id)); checkLc(id, lc.get(id) ?? null, next, restore);
    if (restore) log.append("restore", restore);                 // provenance FIRST, then the row that clears the denial
    log.append("lc", { id, row: next }); lc.set(id, structuredClone(next)); return structuredClone(next);
  };
  const host = (h) => { if (!ID.test(h || "")) throw Error("host id must be a lowercase bytes32"); return h; };
  const putHost = (h, entry, gate = admit) => { gate(); checkHa(h, ha.get(h) ?? null, entry); log.append("ha", { hostId: h, entry }); ha.set(h, structuredClone(entry)); };

  const journal = {
    // ---- the gate's lifecycle journal (r18 deployment-lifecycle-journal transition rules) ----
    read(id) { physical(); return rowOf(id); },
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
    // fence and deny only RESTRICT: permitted while a release withdraws
    fence(id, generation) { return update(id, (row) => { if (row.generation !== generation) throw Error("wrong generation to fence"); return { ...row, fenced: true }; }, physical); },
    deny(id, denial) {
      if (!plain(denial) || !int(denial.blockNumber)) throw Error("denial must carry a non-negative blockNumber");
      return update(id, (row) => ({ ...row, denial: !row.denial || denial.blockNumber > row.denial.blockNumber ? structuredClone(denial) : row.denial }), physical);
    },
    restoreDenial(id, blockNumber) {
      const row = rowOf(id);
      if (!row.denial || !int(blockNumber) || blockNumber < row.denial.blockNumber) { admit(); throw Error("restoration precedes denial"); }
      return update(id, (r) => ({ ...r, denial: null }), admit, { id, denialBlockNumber: row.denial.blockNumber, restoredAt: blockNumber });
    },

    // ---- protected instance mapping ----
    instance(id) { physical(); const r = inst.get(id); return r ? structuredClone(r) : null; },
    instances() { physical(); return [...inst.values()].map((r) => structuredClone(r)); },
    activeFor(deployment) { physical(); return [...inst.values()].filter((r) => r.deployment === deployment && !TERMINAL.has(r.state)).map((r) => structuredClone(r)); },
    putInstance(rec, { admission = false } = {}) {
      if (!INST.test(rec?.instanceId || "") || !INSTANCE_STATES.includes(rec.state)) throw Error("invalid protected instance record");
      const old = inst.get(rec.instanceId);
      if (old && TERMINAL.has(old.state)) throw Error("a terminal protected instance is never revived");
      if (old && (old.deployment !== rec.deployment || old.launchEpoch !== rec.launchEpoch || old.generation !== rec.generation
          || (old.vmId && old.vmId !== rec.vmId))) throw Error("protected instance identity is immutable");
      // while releasing only withdrawal-direction transitions are written (narrow cleanup authority)
      if (admission || !WITHDRAWAL_STATES.includes(rec.state)) admit(); else physical();
      checkInst(rec.instanceId, old ?? null, rec);
      log.append("inst", { instanceId: rec.instanceId, rec }, { admission }); inst.set(rec.instanceId, structuredClone(rec));
      return structuredClone(rec);
    },
    /** recorded after a real backend survey confirmed the exact state of every listed instance */
    reconciled(note) { physical(); log.append("reconciled", note); },
    quarantined: () => log.quarantined(),
    /** integrity vs authenticity, stated (r2) */
    provenance: () => ({ integrity: "unkeyed sha256 hash chain from an installed genesis, read only under the held handle",
      authenticity: "none from the chain: floors are as authentic as the signed permits/authority reads that produced them and the owned, ACL'd file",
      exclusion: log.exclusion, owners: log.rows().filter((r) => r.kind === "open-verified").map((r) => r.data.ownerId) }),
    phase: () => phase,

    // ---- host authority section (gate.hostAuthority; r18 sidecar rules) ----
    hostAuthority: {
      hostAuthorityOwned: true,
      read(h) { physical(); const e = ha.get(host(h)); return e ? structuredClone(e) : null; },
      accept(h, ctx) {
        validateHostAuthorityContext(ctx);
        if (ctx.hostId !== host(h)) throw Error("host authority binds another host");
        admit();
        const e = ha.get(h), how = compareHostAuthority(e?.floor ?? null, ctx);
        if (how === "equal") return how;
        putHost(h, { floor: { hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, digest: ctx.digest, context: structuredClone(ctx), offline: null },
          bound: structuredClone(e?.bound ?? {}) });
        return how;
      },
      observe(h, evidence) {                                   // Offline only restricts: allowed while releasing
        physical();
        const o = offlineObservationOf(evidence);
        if (!o || o.hostId !== host(h)) return "ignored";
        const e = ha.get(h), f = e?.floor ?? null;
        if (f && BigInt(o.hostGeneration) < BigInt(f.hostGeneration)) return "stale";
        if (f?.offline && BigInt(f.offline.hostGeneration) >= BigInt(o.hostGeneration)) return "already";
        const c = evidence.context;
        // r2: the floor advances only when NEITHER axis would decrease (r1 replaced it when either axis grew, which could
        // roll the other axis back); otherwise the old floor is kept and only the Offline restriction is recorded
        const advance = !f || (BigInt(c.hostGeneration) >= BigInt(f.hostGeneration) && BigInt(c.ownerRevision) >= BigInt(f.ownerRevision)
          && (c.hostGeneration !== f.hostGeneration || c.ownerRevision !== f.ownerRevision));
        const floor = advance
          ? { hostGeneration: c.hostGeneration, ownerRevision: c.ownerRevision, digest: c.digest, context: structuredClone(c) }
          : { hostGeneration: f.hostGeneration, ownerRevision: f.ownerRevision, digest: f.digest, context: f.context };
        putHost(h, { floor: { ...floor, offline: { hostGeneration: o.hostGeneration, ownerRevision: o.ownerRevision, digest: o.digest,
          blockHash: o.blockHash, blockNumber: o.blockNumber } }, bound: structuredClone(e?.bound ?? {}) }, physical);
        return "recorded";
      },
      bind(h, id, ctx, { kind, at }) {
        if (!ID.test(id || "") || !HANDOFF_KINDS.includes(kind) || !Number.isSafeInteger(at)) throw Error("explicit handoff kind/time required");
        admit();
        const e = ha.get(host(h));
        if (!e || e.floor.digest !== ctx?.digest || e.floor.offline) throw Error("an app context is handed only to the durable CURRENT Online host authority");
        if (!DEC.test(ctx.hostGeneration) || !DEC.test(ctx.ownerRevision)) throw Error("host authority context malformed");
        const b = { digest: ctx.digest, hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, kind, at };
        putHost(h, { floor: structuredClone(e.floor), bound: { ...structuredClone(e.bound), [id]: b } });
        return structuredClone(b);
      },
      unbind(h, id) {                                          // removes a handoff: allowed while releasing
        physical();
        const e = ha.get(host(h));
        if (!e?.bound?.[id]) return false;
        const bound = structuredClone(e.bound); delete bound[id];
        putHost(h, { floor: structuredClone(e.floor), bound }, physical);
        return true;
      },
      assertLive() { admit(); },
      failed: () => log.failed(),
      released: () => log.released(),
      onRelease(fn) {
        if (typeof fn !== "function") return;
        if (phase !== "live") throw Error("permit journal is releasing: no new withdrawal owner is accepted");
        listeners.push(fn);
      },
    },
    assertLive() { admit(); },
    ownerId: log.ownerId, exclusion: log.exclusion,
    /**
     * Ends ownership. Admissions are revoked NOW (synchronously); withdrawal listeners (the gate's close) are awaited;
     * the physical handle closes only after all of them resolved. A failure keeps the handle held and admissions
     * revoked; calling release() again retries exactly the failed listeners.
     */
    release(reason = "released") {
      if (releasing) return releasing;
      if (phase === "released") return Promise.resolve({ released: true });
      phase = "releasing";
      const run = failedListeners.length ? failedListeners : listeners.splice(0);
      failedListeners = [];
      releasing = (async () => {
        const results = await Promise.allSettled(run.map((fn) => Promise.resolve().then(() => fn(reason))));
        const failed = run.filter((_, i) => results[i].status === "rejected");
        if (failed.length) {
          failedListeners = failed; releasing = null;
          return { released: false, retryable: true, admissionsRevoked: true,
            errors: results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason)) };
        }
        try { log.release(); }
        catch (e) { phase = "released"; return { released: "unknown", admissionsRevoked: true, error: `handle close failed: ${e.message}` }; }
        phase = "released";
        return { released: true };
      })();
      return releasing;
    },
  };
  return journal;
}
