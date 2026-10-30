/* ============================================================
   Shared allocation owner r1 (SOURCE ONLY - authored, not run). ONE local owner of the host's VM physical-memory and
   commit admission, shared by both manager roles (general 8091-class and native 8095) through allocation-service.mjs.

   WHAT IT OWNS. A bounded ledger of reservations, each with the FULL physical MiB and commit MiB of one allocation,
   persisted BEFORE the reservation is granted, so every later request (from either manager) sees it. Nothing here is a
   central authority: the local machine owner establishes the domain, configures the sampler and coverage terms and runs
   the process.

   STORAGE (existing primitives only, unchanged):
     - "owned-log": win-durable.mjs openOwnedLog (Windows share-mode-0 exclusion, FlushFileBuffers append, torn tail
       refused). Purpose LEDGER_PURPOSE, distinct from the permit/guard/operator journals. TEST_inProcessExclusion handles
       are labelled TEST and never production evidence.
     - "owned-durable-state": owned-durable-state.mjs openOwnedLock + openDurableState (Linux flock, intent/ack).
   Establishment is an explicit, separate step for a NEW isolated domain and refuses any existing file. A normal open
   never creates, clears or reinitializes: a missing, foreign, torn, quarantined, uncertain or differently-named domain
   refuses. Replay retains every unresolved reservation, including those of earlier owner/manager incarnations.

   ADMISSION RULE (acquire, serialized): with a sample taken by the owner's OWN sampler after the serial lock is held,
     availablePhysical >= max(18432, domain floor, live floor) + unreflected physical of every held reservation
                          + every owner-declared physical coverage term + this request
     availableCommit   >= domain commit reserve + unreflected commit of every held reservation
                          + every owner-declared commit coverage term + this request
   A missing/non-finite sample or coverage term refuses (unknown, never zero). Coverage is also incomplete until every
   configured role has registered with THIS owner incarnation and reported a baseline whose every record has a known
   physical size; until then new admissions are held (existing domains are never touched).

   RELEASE. A reservation leaves the ledger only on exact evidence: the owner's own record that no WMI boundary entry was
   ever granted (never-entered), the launcher's exact cleanup/stop removal by VM Id, or an explicit qualification-hold
   release by its holder. Expiry only refuses further boundary entries; a timeout, a lost client or an RPC status never
   releases. Uncertain outcomes are retained durably with their reason.

   WHAT THIS IS NOT. The coverage terms (request buffering, component fetches, PowerShell, relay, kernel/worker overhead,
   creator/observer) are owner-DECLARED bounds, not measured or enforced here. The JS serialization is not OS atomicity.
   Windows exclusion/crash behaviour and the sampler's relation to real commit are native-qualification items.
   ============================================================ */
import fs from "node:fs";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { openOwnedLog, initializeOwnedLog, WINDOWS_EXCLUSION } from "./win-durable.mjs";
import { openDurableState, openOwnedLock } from "../../../network/owned-durable-state.mjs";

export const LEDGER_PURPOSE = "enclave-shared-allocation/1";
export const STATE_FORMAT = "enclave-shared-allocation-state/1";
export const MIN_FLOOR_MIB = 18432;
export const MAX_ACTIVE = 128;
export const COVERAGE_TERMS = Object.freeze(["requestBufferMiB", "componentFetchMiB", "powershellMiB", "relayMiB", "hypervOverheadMiB", "observerMiB", "creatorMiB", "otherHostMiB"]);
const MAX_SETTLED_TAIL = 64, MAX_TEXT = 512, MAX_EVIDENCE = 2048, MAX_MIB = 1 << 22;
const ROLES = ["general", "native"];
const HEX = /^[0-9a-f]{32}$/, ID = /^[A-Za-z0-9-]{1,64}$/, NAME = /^[A-Za-z0-9._-]{1,80}$/, DOMAIN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const KINDS = ["domain", "owner-open", "register", "acquire", "enter", "observe"];
const hex = () => crypto.randomBytes(16).toString("hex");
const fail = (status, msg) => Object.assign(Error(msg), { status });
const mib = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MIB;
const text = (v) => String(v ?? "").slice(0, MAX_TEXT);

export function validateDomain(d) {
  if (!d || typeof d !== "object") throw Error("allocation domain required");
  const keys = ["id", "floorMiB", "roles", "commitReserveMiB", "vmCommitOverheadMiB", "maxSampleAgeMs", "maxTtlMs", "isolated"];
  if (Object.keys(d).length !== keys.length || !keys.every((k) => Object.hasOwn(d, k))) throw Error("allocation domain has unknown or missing fields");
  if (!DOMAIN.test(d.id)) throw Error("allocation domain id must be 8-64 lowercase letters, digits or dashes");
  if (!mib(d.floorMiB) || d.floorMiB < MIN_FLOOR_MIB) throw Error(`allocation floor must be at least ${MIN_FLOOR_MIB} MiB`);
  if (!Array.isArray(d.roles) || !d.roles.length || d.roles.some((r) => !ROLES.includes(r)) || new Set(d.roles).size !== d.roles.length) throw Error("allocation roles must be distinct general/native");
  if (!mib(d.commitReserveMiB) || d.commitReserveMiB < 1) throw Error("commit reserve must be stated (positive MiB), never defaulted");
  if (!mib(d.vmCommitOverheadMiB) || d.vmCommitOverheadMiB < 1) throw Error("per-VM commit overhead must be stated (positive MiB), never defaulted");
  if (!Number.isSafeInteger(d.maxSampleAgeMs) || d.maxSampleAgeMs < 1 || d.maxSampleAgeMs > 60_000) throw Error("maxSampleAgeMs must be 1..60000");
  if (!Number.isSafeInteger(d.maxTtlMs) || d.maxTtlMs < 1 || d.maxTtlMs > 3_600_000) throw Error("maxTtlMs must be 1..3600000");
  if (d.isolated !== true) throw Error("only an explicitly isolated allocation domain is established");
  return Object.freeze({ ...d, roles: Object.freeze([...d.roles]) });
}

function checkRequest(r) {
  if (!r || typeof r !== "object" || !ID.test(String(r.id)) || !NAME.test(String(r.name)) || !NAME.test(String(r.vmInstanceId)) || !/^[0-9a-f]{64}$/.test(String(r.appId)))
    throw fail(400, "allocation request identity must name id, deployment name, VM instance id and appId exactly");
  return { id: r.id, name: r.name, vmInstanceId: r.vmInstanceId, appId: r.appId };
}
const sameRequest = (a, b) => !!a && !!b && ["id", "name", "vmInstanceId", "appId"].every((k) => a[k] === b[k]);
function boundedEvidence(e) {
  const s = JSON.stringify(e ?? null);
  if (s.length > MAX_EVIDENCE) throw fail(413, "evidence exceeds its byte bound");
  return JSON.parse(s);
}

/** The pure reducer: every persisted event, in order, through here (replay and live commit alike). */
export function applyEvent(state, kind, data) {
  if (!KINDS.includes(kind)) throw Error(`unknown allocation event ${kind}`);
  if (kind === "domain") {
    if (state) throw Error("allocation domain already established");
    return { format: STATE_FORMAT, domain: validateDomain(data.domain), seq: 1, ownerGeneration: 0, ownerIncarnation: null, managers: {}, active: {}, settledCount: 0, settledTail: [] };
  }
  if (!state) throw Error("allocation ledger does not begin with its domain");
  const s = structuredClone(state);
  if (data?.seq !== s.seq + 1) throw Error("allocation ledger sequence is not contiguous");
  s.seq = data.seq;
  if (kind === "owner-open") {
    if (!HEX.test(data.ownerIncarnation) || data.ownerGeneration !== s.ownerGeneration + 1) throw Error("owner incarnation record malformed");
    s.ownerIncarnation = data.ownerIncarnation; s.ownerGeneration = data.ownerGeneration;
    return s;
  }
  if (data.ownerIncarnation !== s.ownerIncarnation) throw Error("allocation event from another owner incarnation");
  if (kind === "register") {
    s.managers[data.role] = { incarnation: data.incarnation, epoch: data.epoch, ownerIncarnation: s.ownerIncarnation, seq: s.seq, unknown: data.unknown };
    for (const b of data.add) s.active[b.rid] = b;
  } else if (kind === "acquire") {
    if (s.active[data.rec.rid]) throw Error("duplicate reservation id");
    s.active[data.rec.rid] = data.rec;
  } else if (kind === "enter") {
    const r = s.active[data.rid];
    if (!r) throw Error("enter for an unknown reservation");
    r.state = data.boundary === "define" ? "define-entered" : "start-entered";
    r.entered = [...r.entered, data.boundary];
    if (data.vmId) r.vmId = data.vmId;
  } else if (kind === "observe") {
    const r = s.active[data.rid];
    if (!r) throw Error("observe for an unknown reservation");
    if (data.outcome === "reflected") Object.assign(r, { state: "reflected", vmId: data.vmId, reflectedAt: data.at, reflectedOwnerIncarnation: s.ownerIncarnation });
    else if (data.outcome === "uncertain") Object.assign(r, { state: "uncertain", reason: text(data.reason) });
    else {
      delete s.active[data.rid];
      s.settledCount++;
      s.settledTail = [...s.settledTail, { rid: data.rid, outcome: data.outcome, seq: s.seq }].slice(-MAX_SETTLED_TAIL);
    }
  }
  if (Object.keys(s.active).length > MAX_ACTIVE) throw Error("allocation ledger exceeds its record bound");
  return s;
}

export function validateState(s) {
  if (!s || s.format !== STATE_FORMAT || !Number.isSafeInteger(s.seq) || typeof s.active !== "object" || Object.keys(s.active).length > MAX_ACTIVE
      || !Array.isArray(s.settledTail) || s.settledTail.length > MAX_SETTLED_TAIL) throw Error("allocation state malformed");
  validateDomain(s.domain);
  return s;
}

// ---- stores over the EXISTING owned primitives ----
/** win-durable owned log -> store. Refuses torn, quarantined or failed handles; never repairs them. */
export function logStore(handle) {
  if (handle.ambiguous()) throw Error("allocation ledger has a torn tail: refusing (explicit owner review; never cleared here)");
  if (handle.quarantined()) throw Error("allocation ledger carries a quarantined torn record: an unknown event may be lost, refusing");
  if (handle.failed()) throw Error(`allocation ledger failed at open: ${handle.failed()}`);
  let state = null;
  for (const row of handle.rows()) if (row.kind.startsWith("alloc-")) state = applyEvent(state, row.kind.slice(6), row.data);
  return { kind: "owned-log", exclusion: handle.exclusion, state,
    persist(kind, data) { handle.append(`alloc-${kind}`, data, { admission: kind === "acquire" || kind === "register" }); },
    assertLive: () => handle.assertLive(), release: () => handle.release() };
}
/** owned-durable-state -> store (full snapshot per event). Refuses an uncertain or released handle. */
export function durableStore(handle) {
  if (handle.failed()) throw Error(`allocation state is uncertain: ${handle.failed()}`);
  const state = handle.state;
  if (state.format !== STATE_FORMAT) throw Error("allocation state was never established as a domain");
  return { kind: "owned-durable-state", exclusion: "linux-flock", state: validateState(state),
    persist(kind, data, next) { handle.store(next); },
    assertLive: () => handle.assertLive(), release: () => handle.release() };
}
const emptyMarker = Object.freeze({ format: "enclave-shared-allocation-unestablished/1" });
const validateAny = (s) => (s?.format === emptyMarker.format ? s : validateState(s));

/** EXPLICIT establishment of a NEW isolated domain over an owned log. Refuses an existing file (initializeOwnedLog 'wx'). */
export function establishLogDomain(file, { domain, exclusion = WINDOWS_EXCLUSION, fsImpl, platform } = {}) {
  const d = validateDomain(domain);
  initializeOwnedLog(file, { purpose: LEDGER_PURPOSE, ...(fsImpl ? { fsImpl } : {}) });
  const h = openOwnedLog(file, { purpose: LEDGER_PURPOSE, exclusion, ...(fsImpl ? { fsImpl } : {}), ...(platform ? { platform } : {}) });
  try { h.append("alloc-domain", { domain: d }); } finally { h.release(); }
  return d;
}
/** EXPLICIT establishment over owned durable state. Refuses if the file, its marker, intent or acknowledgement exist. */
export async function establishDurableDomain(file, { domain, flockPath } = {}) {
  const d = validateDomain(domain);
  for (const p of [file, `${file}.established`, `${file}.intent`, `${file}.commit`]) if (fs.existsSync(p)) throw Error(`refusing to establish over existing ${p}`);
  const owner = await openOwnedLock(file, flockPath ? { flockPath } : {});
  const h = openDurableState(file, { format: STATE_FORMAT, validate: validateAny, empty: emptyMarker, established: false, owner });
  try {
    if (h.failed()) throw Error(h.failed());
    h.store(applyEvent(null, "domain", { domain: d }));
  } finally { await h.release("establishment complete"); }
  return d;
}
/** Normal open of an established durable domain: never creates (established:true, expectExisting:true). */
export async function openDurableAllocationStore(file, { flockPath } = {}) {
  const owner = await openOwnedLock(file, flockPath ? { flockPath } : {});
  const h = openDurableState(file, { format: STATE_FORMAT, validate: validateAny, empty: emptyMarker, established: true, expectExisting: true, owner });
  try { return durableStore(h); } catch (e) { await h.release("refused at open"); throw e; }
}

export class AllocationOwner {
  #store; #state; #sampler; #coverage; #mono; #now; #chain = Promise.resolve(); #closed = null;
  /** Use openAllocationOwner. */
  constructor(store, { sampler, coverage, monotonic, now }) {
    this.#store = store; this.#state = store.state; this.#sampler = sampler; this.#coverage = coverage; this.#mono = monotonic; this.#now = now;
  }
  get closed() { return this.#closed; }
  get ownerIncarnation() { return this.#state.ownerIncarnation; }
  get domain() { return this.#state.domain; }
  get exclusion() { return this.#store.exclusion; }
  /** read-only snapshot for tests/status (a copy; never a handle on the live ledger) */
  snapshot() { return structuredClone(this.#state); }

  #serial(fn) { const p = this.#chain.then(fn); this.#chain = p.catch(() => {}); return p; }
  #live() {
    if (this.#closed) throw fail(503, `allocation owner closed: ${this.#closed}`);
    try { this.#store.assertLive(); } catch (e) { this.#closed = `ownership lost: ${e.message}`; throw fail(503, `allocation owner closed: ${this.#closed}`); }
  }
  /** persist FIRST, then adopt; any persistence failure closes the owner (new admissions end; nothing is erased) */
  #commit(kind, data) {
    const full = { ...data, seq: this.#state.seq + 1, ...(kind === "owner-open" ? {} : { ownerIncarnation: this.#state.ownerIncarnation }) };
    const next = applyEvent(this.#state, kind, full);
    try { this.#store.persist(kind, full, next); }
    catch (e) { this.#closed = `ledger persistence uncertain: ${e.message}`; throw fail(503, `allocation owner closed: ${this.#closed}`); }
    this.#state = next;
    return next;
  }
  _open() { this.#commit("owner-open", { ownerIncarnation: hex(), ownerGeneration: this.#state.ownerGeneration + 1 }); return this; }

  #caller(role, b, { exactOwner = true } = {}) {
    const m = this.#state.managers[role];
    if (!m || m.ownerIncarnation !== this.#state.ownerIncarnation) throw fail(409, `manager role ${role} is not registered with this owner incarnation`);
    if (b.managerIncarnation !== m.incarnation) throw fail(409, "stale or foreign manager incarnation");
    if (exactOwner && b.ownerIncarnation !== this.#state.ownerIncarnation) throw fail(409, "stale owner incarnation: re-register");
    return m;
  }
  #coverageGap() {
    const s = this.#state, gaps = [];
    for (const r of s.domain.roles) {
      const m = s.managers[r];
      if (!m || m.ownerIncarnation !== s.ownerIncarnation) gaps.push(`${r} has not acknowledged owner incarnation ${s.ownerIncarnation}`);
      else if (m.unknown.length) gaps.push(`${r} holds ${m.unknown.length} record(s) of unknown physical size`);
    }
    return gaps;
  }

  register(role, b) {
    return this.#serial(() => {
      this.#live();
      if (!this.#state.domain.roles.includes(role)) throw fail(403, `role ${role} is not part of this allocation domain`);
      if (!HEX.test(String(b?.managerIncarnation)) || !/^[0-9a-f]{32}$/.test(String(b?.epoch))) throw fail(400, "manager incarnation and epoch required");
      if (!Array.isArray(b.baseline) || b.baseline.length > MAX_ACTIVE) throw fail(413, "baseline exceeds its record bound");
      const held = Object.values(this.#state.active);
      const add = [], unknown = [];
      for (const x of b.baseline) {
        if (!x || !ID.test(String(x.id))) throw fail(400, "baseline record identity malformed");
        if (held.some((r) => r.role === role && r.request.id === x.id)) continue;      // already accounted (reservation or earlier baseline)
        if (!mib(x.physicalMiB) || x.physicalMiB < 1) { unknown.push(x.id); continue; }
        add.push({ rid: hex(), kind: "baseline", role, managerIncarnation: b.managerIncarnation, ownerIncarnation: this.#state.ownerIncarnation,
          request: { id: x.id, name: text(x.name), vmInstanceId: text(x.vmInstanceId), appId: text(x.appId) }, physicalMiB: x.physicalMiB,
          commitMiB: x.physicalMiB + this.#state.domain.vmCommitOverheadMiB, state: "baseline", launching: x.launching === true,
          vmId: typeof x.vmId === "string" ? x.vmId.slice(0, 64) : null, entered: [], createdAt: this.#now() });
      }
      if (unknown.length > MAX_ACTIVE) throw fail(413, "unknown baseline exceeds its bound");
      this.#commit("register", { role, incarnation: b.managerIncarnation, epoch: b.epoch, unknown, add });
      return { ownerIncarnation: this.#state.ownerIncarnation, seq: this.#state.seq, baseline: add.map((r) => ({ rid: r.rid, id: r.request.id })),
               unknown, coverageGaps: this.#coverageGap() };
    });
  }

  async #sample(tLock) {
    let s, c;
    try { s = await this.#sampler(); } catch (e) { throw fail(503, `memory/commit sample unavailable: ${e.message}`); }
    if (!s || !mib(s.availablePhysicalMiB) || !mib(s.availableCommitMiB)) throw fail(503, "memory/commit sample is unknown or not finite: refusing (never zero)");
    if (!Number.isFinite(s.at) || s.at < tLock || this.#mono() - s.at > this.#state.domain.maxSampleAgeMs) throw fail(503, "memory/commit sample is not fresh for this serialized decision");
    if (s.liveFloorMiB !== undefined && !mib(s.liveFloorMiB)) throw fail(503, "live floor is not finite");
    try { c = await this.#coverage(); } catch (e) { throw fail(503, `coverage terms unavailable: ${e.message}`); }
    for (const side of ["physical", "commit"]) for (const k of COVERAGE_TERMS)
      if (!mib(c?.[side]?.[k])) throw fail(503, `coverage term ${side}.${k} is unknown: refusing (never zero)`);
    return { s, c };
  }
  #unreflected(sampleAt) {
    let p = 0, c = 0;
    for (const r of Object.values(this.#state.active)) {
      const inSample = r.state === "reflected" && (r.reflectedOwnerIncarnation !== this.#state.ownerIncarnation || sampleAt > r.reflectedAt);
      if (!inSample) { p += r.physicalMiB; c += r.commitMiB; }
    }
    return { p, c };
  }
  /** Only VM reservations have a recorded pre-entry boundary. Qualification holds may already cover running work; retain them until explicit end evidence. */
  #sweep() {
    const t = this.#mono();
    for (const r of Object.values(this.#state.active))
      if (r.kind === "vm" && r.state === "reserved" && (r.ownerIncarnation !== this.#state.ownerIncarnation || t > r.expiresAt))
        this.#commit("observe", { rid: r.rid, outcome: "never-entered", reason: "expired or owner continuity ended before any boundary entry" });
  }
  sweep() { return this.#serial(() => { this.#live(); this.#sweep(); return { active: Object.keys(this.#state.active).length }; }); }

  acquire(role, b) {
    return this.#serial(async () => {
      const tLock = this.#mono();
      this.#live();
      this.#caller(role, b);
      this.#sweep();
      const gaps = this.#coverageGap();
      if (gaps.length) throw fail(503, `coverage incomplete, new admissions held: ${gaps.join("; ")}`);
      const kind = b.kind === "qualification" ? "qualification" : b.kind === "vm" ? "vm" : null;
      if (!kind) throw fail(400, "reservation kind must be vm or qualification");
      const request = checkRequest(b.request);
      if (!mib(b.physicalMiB) || b.physicalMiB < 1) throw fail(400, "physicalMiB must be a positive bounded integer");
      const commitMiB = kind === "vm" ? b.physicalMiB + this.#state.domain.vmCommitOverheadMiB : b.commitMiB;
      if (!mib(commitMiB) || commitMiB < b.physicalMiB) throw fail(400, "commitMiB must be stated and at least the physical size");
      if (!Number.isSafeInteger(b.ttlMs) || b.ttlMs < 1 || b.ttlMs > this.#state.domain.maxTtlMs) throw fail(400, "ttlMs out of bounds");
      if (Object.values(this.#state.active).some((r) => r.role === role && r.request.id === request.id)) throw fail(409, `${request.id} already holds a reservation`);
      if (Object.keys(this.#state.active).length >= MAX_ACTIVE) throw fail(507, "allocation ledger is at its record bound");
      const { s, c } = await this.#sample(tLock);
      this.#live();
      const floor = Math.max(MIN_FLOOR_MIB, this.#state.domain.floorMiB, s.liveFloorMiB ?? 0);
      const u = this.#unreflected(s.at);
      const sum = (side) => COVERAGE_TERMS.reduce((n, k) => n + c[side][k], 0);
      const needP = floor + u.p + sum("physical") + b.physicalMiB, needC = this.#state.domain.commitReserveMiB + u.c + sum("commit") + commitMiB;
      const terms = { floorMiB: floor, availablePhysicalMiB: s.availablePhysicalMiB, availableCommitMiB: s.availableCommitMiB, unreflectedPhysicalMiB: u.p,
        unreflectedCommitMiB: u.c, coveragePhysicalMiB: sum("physical"), coverageCommitMiB: sum("commit"), needPhysicalMiB: needP, needCommitMiB: needC, source: text(s.source) };
      if (s.availablePhysicalMiB < needP) throw Object.assign(fail(507, `physical memory would fall below the floor: need ${needP} MiB, available ${s.availablePhysicalMiB} MiB`), { terms });
      if (s.availableCommitMiB < needC) throw Object.assign(fail(507, `commit would be exhausted: need ${needC} MiB, available ${s.availableCommitMiB} MiB`), { terms });
      const rec = { rid: hex(), kind, role, managerIncarnation: b.managerIncarnation, ownerIncarnation: this.#state.ownerIncarnation, request,
        physicalMiB: b.physicalMiB, commitMiB, state: "reserved", entered: [], vmId: null, expiresAt: this.#mono() + b.ttlMs, createdAt: this.#now(), terms };
      this.#commit("acquire", { rec });
      return { rid: rec.rid, ownerIncarnation: rec.ownerIncarnation, seq: this.#state.seq, physicalMiB: rec.physicalMiB, commitMiB, terms };
    });
  }

  /** A WMI boundary is about to be crossed: validate everything exactly, persist the entry, THEN answer. */
  enter(role, b) {
    return this.#serial(() => {
      this.#live();
      this.#caller(role, b);
      const r = this.#state.active[b.rid];
      if (!r || r.kind !== "vm") throw fail(409, "no live VM reservation with this id");
      if (r.role !== role || r.managerIncarnation !== b.managerIncarnation) throw fail(409, "reservation belongs to another manager incarnation");
      if (r.ownerIncarnation !== this.#state.ownerIncarnation) throw fail(409, "reservation predates this owner incarnation: continuity broken, no new boundary entry");
      if (!sameRequest(r.request, b.request)) throw fail(409, "boundary identity differs from the reservation");
      if (this.#mono() > r.expiresAt) throw fail(409, "reservation expired: no new boundary entry (it stays held until exact settlement)");
      if (b.boundary === "define") {
        if (r.state !== "reserved") throw fail(409, `define boundary in state ${r.state}`);
        if (b.memMiB !== r.physicalMiB) throw fail(409, "partition memory differs from the reserved physical size");
      } else if (b.boundary === "start") {
        if (r.state !== "define-entered") throw fail(409, `start boundary in state ${r.state}`);
        if (typeof b.vmId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(b.vmId)) throw fail(400, "start boundary needs the defined VM Id");
      } else throw fail(400, "unknown boundary");
      this.#commit("enter", { rid: r.rid, boundary: b.boundary, vmId: b.boundary === "start" ? b.vmId : null });
      return { ok: true, rid: r.rid, boundary: b.boundary, seq: this.#state.seq };
    });
  }

  /** Settlement on exact evidence only (see header). Settlement of an earlier incarnation's record needs exact absence. */
  observe(role, b) {
    return this.#serial(() => {
      this.#live();
      this.#caller(role, b);
      const r = this.#state.active[b.rid];
      if (!r) throw fail(404, "no such unresolved reservation");
      if (r.role !== role) throw fail(409, "reservation belongs to another role");
      const own = r.managerIncarnation === b.managerIncarnation;
      const ev = boundedEvidence(b.evidence);
      const vmOk = (v) => typeof v === "string" && /^[0-9a-fA-F-]{36}$/.test(v);
      let outcome = b.outcome, extra = {};
      if (outcome === "never-entered") {
        if (!own || r.state !== "reserved" || r.kind === "baseline") throw fail(409, "never-entered applies only to this manager's unentered reservation");
      } else if (outcome === "reflected") {
        if (!own && r.kind !== "baseline") throw fail(409, "reflection is stated by the holding manager incarnation");
        const okLaunch = ev?.kind === "launch-returned" && ["start-entered", "baseline"].includes(r.state) && vmOk(ev.vmId) && ev.state === "Running" && ev.vmMiB === r.physicalMiB && (!r.vmId || r.vmId.toLowerCase() === ev.vmId.toLowerCase());
        if (!okLaunch) throw fail(409, "reflection needs the exact launch result (Running, same VM Id, the reserved partition size)");
        extra = { vmId: ev.vmId, at: this.#mono() };
      } else if (outcome === "absent") {
        const vmMatch = vmOk(ev?.vmId) && !!r.vmId && r.vmId.toLowerCase() === ev.vmId.toLowerCase();
        const ok = (ev?.kind === "stop-confirmed" && vmMatch && (ev.removed === true || ev.found === false))
          || (own && ev?.kind === "cleanup-removed" && ["define-entered", "start-entered", "uncertain"].includes(r.state)
              && (ev.removed === true || ev.found === false) && (r.vmId ? vmMatch : typeof ev.name === "string" && ev.name.endsWith(r.request.vmInstanceId)))
          || (own && ev?.kind === "define-not-invoked" && r.state === "define-entered")
          // a successful survey, begun after the launch settled, with no unattributed VM and no VM carrying this identity
          || (ev?.kind === "survey-absent" && r.kind !== "qualification" && r.state !== "reserved" && ev.id === r.request.id && ev.launchSettled === true && ev.unattributed === 0)
          || (own && r.kind === "qualification" && ev?.kind === "qualification-ended" && ev.request?.id === r.request.id);
        if (!ok) throw fail(409, "absence needs exact removal evidence for this VM Id (no status/PID shortcut)");
      } else if (outcome === "uncertain") {
        if (!own) throw fail(409, "uncertainty is stated by the holding manager incarnation");
      } else throw fail(400, "unknown outcome");
      this.#commit("observe", { rid: r.rid, outcome, reason: text(b.reason), evidence: ev, ...extra });
      return { ok: true, rid: r.rid, outcome, seq: this.#state.seq };
    });
  }

  status() {
    const s = this.#state;
    return { ownerIncarnation: s.ownerIncarnation, ownerGeneration: s.ownerGeneration, seq: s.seq, domain: s.domain.id, closed: this.#closed,
      exclusion: this.#store.exclusion, storage: this.#store.kind, active: Object.keys(s.active).length, settled: s.settledCount,
      managers: Object.fromEntries(Object.entries(s.managers).map(([k, m]) => [k, { current: m.ownerIncarnation === s.ownerIncarnation, unknown: m.unknown.length }])),
      coverageGaps: this.#coverageGap(),
      qualification: this.#store.exclusion === "TEST-in-process" ? "TEST" : "source-only: native storage, exclusion, sampler and coverage terms unqualified" };
  }
  /** Release the store (ends ownership). Unresolved reservations stay in the ledger for the next owner. */
  close(reason = "owner closed") { this.#closed ??= reason; try { return this.#store.release(reason); } catch { return null; } }
}

/**
 * Normal open: replay, exact domain id, then ONE persisted owner-open (new incarnation) before anything is served.
 * sampler: async () => { availablePhysicalMiB, availableCommitMiB, at (monotonic ms), liveFloorMiB?, source }
 * coverage: async () => { physical: {COVERAGE_TERMS}, commit: {COVERAGE_TERMS}, source }
 */
export function openAllocationOwner({ store, domainId, sampler, coverage, monotonic = () => performance.now(), now = Date.now }) {
  if (typeof sampler !== "function" || typeof coverage !== "function") throw Error("the owner's own sampler and coverage functions are required");
  if (!store?.state) throw Error("allocation ledger has no established domain: refusing (establishment is a separate explicit step)");
  validateState(store.state);
  if (store.state.domain.id !== domainId) throw Error(`allocation ledger belongs to domain ${store.state.domain.id}, not ${domainId}`);
  return new AllocationOwner(store, { sampler, coverage, monotonic, now })._open();
}
