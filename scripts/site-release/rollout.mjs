// Rollouts across release roots (work/site-delivery-hardening-interface.txt §2, with the reconcile fixes). A rollout
// activates one CID on every activatable target in file order, each as its own fenced operation (root-state.mjs).
// Every transition is journalled BEFORE the action it describes, so an interrupted rollout (a lost answer, a killed
// process, a partition) can be resolved later from the journal and the targets file:
//   - identity: the journal binds each entry to the target's configuration (local root path; ssh host, port, user,
//     agent and the host keys it trusts) AND to the root's durable rootId. Every settling operation names that rootId,
//     so a different root under the same name refuses instead of being read as "not received";
//   - a lost answer is settled with `cancel`, never with an absence read: cancel returns the operation's result if it
//     ran, and otherwise leaves a durable tombstone, so a delayed copy of it can never commit later;
//   - compensation is a fenced undo of exactly this rollout's activation, with a new attempt identity after a failed or
//     never-run attempt (at most 9), so a transient reload/probe failure can be retried once fixed.
// There is no multi-host atomic commit: a partitioned rollout can leave hosts on different releases, reported as
// `pending` with the exact resolve command; never as unchanged or rolled back.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { agentCall } from "./ssh.mjs";
import { rootStatus, rootActivate, rootUndo, rootCancel, LockedError, WrongRootError, MAX_UNDO_ATTEMPTS } from "./root-state.mjs";

const CID = /^b[a-z2-7]{58}$/;
const newId = () => randomBytes(16).toString("hex");
export const activatable = (t) => (t.kind === "local-root" && t.activate) || (t.kind === "ssh" && t.activate);

// ---- target identity (public: no secret is in it) -----------------------------------------------------------------
function hostKeys(t, env) {
  const text = t.knownHostsFile ? fs.readFileSync(t.knownHostsFile, "utf8") : String(env[t.knownHostsEnv] || "");
  const host = t.host.replace(/^\[|\]$/g, ""), port = t.port ?? 22, names = new Set([host, `[${host}]:${port}`]);
  const keys = new Set();
  for (const line of text.split("\n")) {
    const [hosts, type, blob] = line.trim().split(/\s+/);
    if (!blob || hosts.startsWith("#")) continue;
    if (hosts.startsWith("|1|") || hosts.split(",").some((h) => names.has(h))) keys.add(`${type} ${blob}`);
  }
  return [...keys].sort();
}
export function targetIdentity(t, env = process.env) {
  if (t.kind === "local-root") return { kind: t.kind, root: path.resolve(t.root) };
  return { kind: t.kind, host: t.host, port: t.port ?? 22, user: t.user, agent: t.agent, hostKeys: hostKeys(t, env).map((k) => createHash("sha256").update(k).digest("hex")) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- one adapter per kind: a recorded result, or Unknown, or a definite identity refusal --------------------------
class Unknown extends Error {}
class Identity extends Error {}
export const agentRss = new Map();   // the agents' own peak RSS per target, as they report it
async function ssh(t, op, args) {
  let a;
  try { a = await agentCall(t, op, args); }
  catch (e) { throw new Unknown(e.message); }
  if (Number.isFinite(a?.maxRssMiB)) agentRss.set(t.name, Math.max(agentRss.get(t.name) ?? 0, a.maxRssMiB));
  if (!a.ok) {
    if (a.code === "wrong-root") throw new Identity(a.error);
    // the agent answered that it did not run a CHANGE (its lock, its grammar, its config): nothing changed
    if (a.definite && (op === "activate" || op === "undo")) return { outcome: "refused", reason: a.error };
    throw new Unknown(a.error);
  }
  return a;
}
const local = async (fn, change) => {
  try { return await fn(); }
  catch (e) {
    if (e instanceof WrongRootError) throw new Identity(e.message);
    if (e instanceof LockedError && change) return { outcome: "refused", reason: e.message };
    throw new Unknown(e.message);
  }
};
const api = {
  status: (t) => (t.kind === "ssh" ? ssh(t, "status", []) : local(() => rootStatus(t))),
  activate: (t, x, cid) => (t.kind === "ssh" ? ssh(t, "activate", [cid, x.opId, String(x.expectGeneration), x.rootId])
    : local(() => rootActivate(t, { opId: x.opId, cid, expectGeneration: x.expectGeneration, rootId: x.rootId }), true)),
  undo: (t, x, attempt) => (t.kind === "ssh" ? ssh(t, "undo", [x.opId, String(attempt), x.rootId])
    : local(() => rootUndo(t, { opId: x.opId, attempt, rootId: x.rootId }), true)),
  cancel: (t, x, id) => (t.kind === "ssh" ? ssh(t, "cancel", [id, x.rootId]) : local(() => rootCancel(t, { opId: id, rootId: x.rootId }))),
};

// ---- the journal ---------------------------------------------------------------------------------------------------
function save(file, j) {
  j.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, JSON.stringify(j, null, 1) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
// what an activation's settled outcome means for this rollout ("pending": the root itself has not confirmed a rollback)
const ACT = { committed: "committed", refused: "refused", "rolled-back": "rolled-back", cancelled: "cancelled", pending: "unknown" };
const DONE = new Set(["refused", "rolled-back", "cancelled", "skipped", "undone", "superseded"]);   // this rollout's change is not in effect

function finalStatus(j) {
  if (j.targets.every((x) => x.state === "committed")) return "active";
  if (j.targets.every((x) => DONE.has(x.state))) return "reverted";
  return "pending";
}
function summary(j, file, targetsFile) {
  const status = finalStatus(j);
  return { rolloutId: j.rolloutId, cid: j.cid, status, journal: file,
    targets: j.targets.map((x) => ({ name: x.name, state: x.state, opId: x.opId, ...(x.undoAttempt ? { undoAttempt: x.undoAttempt } : {}), ...(x.detail ? { detail: x.detail } : {}),
      ...(agentRss.has(x.name) ? { agentMaxRssMiB: agentRss.get(x.name) } : {}) })),
    ...(status === "pending" ? { recovery: `site-release resolve --journal ${path.dirname(file)} --rollout ${j.rolloutId} --targets ${targetsFile ?? "TARGETS_FILE"}`,
      meaning: "at least one target's outcome is unknown, unconfirmed or not yet undone: hosts may serve different releases until resolve completes" } : {}) };
}
const why = (e) => String(e?.message ?? e).slice(0, 200);

/** Settle a lost activation with cancel: its result if it ran, else a tombstone. Mutates x. */
async function settleActivation(t, x) {
  try { const r = await api.cancel(t, x, x.opId); x.state = ACT[r.outcome] ?? "unknown"; x.detail = r.reason ?? x.detail; if (r.generation !== undefined) x.generation = r.generation; }
  catch (e) { x.state = "unknown"; x.detail = e instanceof Identity ? `identity: ${why(e)}` : `no answer: ${why(e)}`; }
}
/** Compensate every committed (or not yet undone) target, newest first, with fenced undo attempts. */
async function compensate(byName, j, file) {
  for (const x of [...j.targets].reverse()) {
    if (!["committed", "undoing", "undo-unknown", "undo-failed"].includes(x.state)) continue;
    const t = byName.get(x.name);
    // a previous attempt whose answer was lost: settle it first (its result, or a tombstone so it can never run late)
    if (["undoing", "undo-unknown"].includes(x.state) && x.undoAttempt) {
      try {
        const r = await api.cancel(t, x, `undo-${x.opId}-${x.undoAttempt}`);
        if (r.outcome === "committed" || r.outcome === "nothing-to-undo") { x.state = "undone"; save(file, j); continue; }
        if (r.outcome === "superseded") { x.state = "superseded"; x.detail = r.reason; save(file, j); continue; }
        if (r.outcome === "pending") { x.state = "undo-unknown"; x.detail = r.reason; save(file, j); continue; }
        x.state = "undo-failed"; x.detail = r.reason;   // failed or cancelled: it had no effect, so a new attempt may follow
      } catch (e) { x.state = "undo-unknown"; x.detail = e instanceof Identity ? `identity: ${why(e)}` : `no answer: ${why(e)}`; save(file, j); continue; }
    }
    const attempt = (x.undoAttempt ?? 0) + 1;
    if (attempt > MAX_UNDO_ATTEMPTS) { x.state = "undo-failed"; x.detail = `undo attempts exhausted (${MAX_UNDO_ATTEMPTS}): ${x.detail ?? ""}`; save(file, j); continue; }
    x.undoAttempt = attempt; x.state = "undoing"; save(file, j);
    try {
      const u = await api.undo(t, x, attempt);
      x.state = { committed: "undone", "nothing-to-undo": "undone", superseded: "superseded", failed: "undo-failed", pending: "undo-unknown", refused: "undo-failed" }[u.outcome] ?? "undo-unknown";
      x.detail = u.reason ?? x.detail;
    } catch (e) { x.state = "undo-unknown"; x.detail = e instanceof Identity ? `identity: ${why(e)}` : `no answer: ${why(e)}`; }
    save(file, j);
  }
}

/**
 * Activate `cid` everywhere. -> summary {status: "active"|"reverted"|"pending"|"not-started", targets, journal, recovery?}
 * hooks.afterTarget(name) runs after each target's outcome is journalled (tests interleave rollouts there).
 */
export async function rollout(targets, cid, { journalDir, kind = "activate", targetsFile = null, hooks = {}, env = process.env } = {}) {
  if (!CID.test(cid)) throw new Error("a rollout names one release CID");
  if (!journalDir) throw new Error("a rollout needs --journal DIR: the record that lets an interrupted rollout be resolved");
  const acts = targets.filter(activatable);
  if (!acts.length) throw new Error("no target activates (a local-root `activate` block, or an ssh target with activate: true)");
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const j = { v: 2, rolloutId: newId(), cid, kind, startedAt: new Date().toISOString(),
    targets: acts.map((t) => ({ name: t.name, kind: t.kind, identity: targetIdentity(t, env), state: "planned" })) };
  const file = path.join(journalDir, `${j.rolloutId}.json`);
  save(file, j);
  // plan: every target's root identity and generation, observed before anything changes
  for (const [i, t] of acts.entries()) {
    try {
      const st = await api.status(t);
      if (st.pending) throw new Error("the root has an unconfirmed earlier change pending; resolve that first");
      Object.assign(j.targets[i], { rootId: st.rootId, opId: newId(), expectGeneration: st.generation, previous: st.current });
    } catch (e) {
      for (const x of j.targets) x.state = "skipped";
      j.targets[i].detail = `status unavailable: ${why(e)}`;
      save(file, j);
      return { ...summary(j, file, targetsFile), status: "not-started" };
    }
  }
  save(file, j);
  for (const [i, t] of acts.entries()) {
    const x = j.targets[i];
    x.state = "sent"; save(file, j);
    try {
      const r = await api.activate(t, x, cid);
      x.state = ACT[r.outcome] ?? "unknown"; x.detail = r.reason; if (r.generation !== undefined) x.generation = r.generation;
    } catch (e) {
      if (e instanceof Identity) { x.state = "refused"; x.detail = `identity changed since the plan: ${why(e)}`; }
      else { x.state = "unknown"; x.detail = `no answer: ${why(e)}`; await settleActivation(t, x); }
    }
    save(file, j);
    await hooks.afterTarget?.(t.name, x);
    if (x.state !== "committed") {
      for (const y of j.targets.slice(i + 1)) y.state = "skipped";
      save(file, j);
      await compensate(new Map(acts.map((t) => [t.name, t])), j, file);
      break;
    }
  }
  return summary(j, file, targetsFile);
}

/**
 * Resolve a journalled rollout after any interruption. Every entry must still name the same target (configuration and
 * root identity). Each unsettled outcome is settled with cancel (never an absence read); then the rollout is complete
 * (every target committed) or compensated (fenced undo, retried with new attempts). It never re-sends an activation.
 */
export async function resolve(targets, journalFile, { targetsFile = null, env = process.env } = {}) {
  const j = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  if (j?.v !== 2 || !CID.test(j.cid) || !Array.isArray(j.targets))
    throw new Error(`${journalFile} is not a v2 rollout journal (one binding each target's identity); settle older ones by hand with status/result`);
  const byName = new Map(targets.map((t) => [t.name, t]));
  const mismatched = [];
  for (const x of j.targets) {
    const t = byName.get(x.name);
    if (!t) { mismatched.push(x.name); x.detail = "the targets file no longer has this target"; continue; }
    if (!same(targetIdentity(t, env), x.identity)) { mismatched.push(x.name); x.detail = "the targets file's entry is not the journalled target (configuration or host keys differ): not settled"; }
  }
  if (mismatched.length) { save(journalFile, j); return { ...summary(j, journalFile, targetsFile), status: "pending", refused: `identity mismatch for ${mismatched.join(", ")}` }; }
  for (const x of j.targets) {
    const t = byName.get(x.name);
    if (["sent", "unknown"].includes(x.state)) await settleActivation(t, x);
    else if (x.state === "planned") x.state = "skipped";   // never sent: "sent" is journalled before every send
  }
  save(journalFile, j);
  // compensate once every activation outcome is settled and the rollout cannot be complete
  if (finalStatus(j) !== "active" && !j.targets.some((x) => ["sent", "unknown"].includes(x.state))) await compensate(byName, j, journalFile);
  return summary(j, journalFile, targetsFile);
}
