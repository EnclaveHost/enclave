// The step journal: append-only JSONL, each entry hash-chained to the previous one, bound to the pins hash, and naming
// the exact step hash it executed. A step is recorded at most once; nothing is re-run from the journal, and a journal
// whose chain, pins or step hashes do not verify refuses every further step.
// Observations (resolved prerequisites) and learned deployment ids are derived ONLY from verified entries.
import fs from "node:fs";
import { hashOf } from "./canonical.mjs";

export const GENESIS = "0".repeat(64);
const OUTCOMES = ["pass", "fail", "expected-fail", "blocked", "aborted"];

export function entryHash(e) { const { entryHash: _, ...rest } = e; return hashOf("custody-canary-journal-v1", rest); }

// planFor(observations, ids) -> plan: the journal is verified step by step against the plan as it stood when each
// entry was written (ids learned by earlier entries change only later steps' hashes).
export function verifyJournal(entries, planFor) {
  let prev = GENESIS;
  const done = new Map(), observations = {}, ids = {};
  entries.forEach((e, i) => {
    const plan = planFor(observations, ids);
    if (e.seq !== i) throw new Error(`journal: entry ${i} has seq ${e.seq}`);
    if (e.prevHash !== prev) throw new Error(`journal: entry ${i} does not chain to its predecessor`);
    if (entryHash(e) !== e.entryHash) throw new Error(`journal: entry ${i} hash mismatch`);
    if (e.pinsHash !== plan.pinsHash) throw new Error(`journal: entry ${i} belongs to other pins`);
    const step = plan.steps.find((s) => s.id === e.stepId);
    if (!step || step.stepHash !== e.stepHash) throw new Error(`journal: entry ${i} names an unknown step or a step hash this plan does not have`);
    if (!OUTCOMES.includes(e.outcome)) throw new Error(`journal: entry ${i} outcome ${e.outcome}`);
    if (done.has(e.stepId)) throw new Error(`journal: step ${e.stepId} recorded twice`);
    done.set(e.stepId, e);
    if (e.outcome === "pass") {
      for (const [k, v] of Object.entries(e.evidence?.resolves || {})) if ((step.resolves || []).includes(k)) observations[k] = { ...v, stepId: e.stepId };
      if (step.learns && /^0x[0-9a-f]{64}$/.test(String(e.evidence?.deploymentId))) ids[step.learns] = e.evidence.deploymentId;
    }
    prev = e.entryHash;
  });
  return { head: prev, done, observations, ids, plan: planFor(observations, ids) };
}

export function readJournal(path, planFor) {
  if (!fs.existsSync(path)) return { entries: [], ...verifyJournal([], planFor) };
  const text = fs.readFileSync(path, "utf8");
  if (text && !text.endsWith("\n")) throw new Error("journal: partial last line");
  const entries = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { entries, ...verifyJournal(entries, planFor) };
}

// A step may run only when it is ready and every step it follows is recorded as pass (or expected-fail).
export function readyToRun(plan, done, stepId) {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, reason: `unknown step ${stepId}` };
  if (done.has(stepId)) return { ok: false, reason: `step ${stepId} is already recorded (${done.get(stepId).outcome}); steps never re-run` };
  if (step.status === "blocked") return { ok: false, reason: `step ${stepId} is blocked: ${step.blockedBy.join("; ")}` };
  for (const d of step.after) {
    const e = done.get(d);
    if (!e || !["pass", "expected-fail"].includes(e.outcome)) return { ok: false, reason: `step ${stepId} needs ${d} recorded as pass first` };
  }
  return { ok: true, step };
}

export function makeEntry({ plan, head, seq, step, outcome, evidence, at = new Date().toISOString() }) {
  const e = { seq, at, pinsHash: plan.pinsHash, stepId: step.id, stepHash: step.stepHash, kind: step.kind, outcome, evidence, prevHash: head };
  return { ...e, entryHash: entryHash(e) };
}

export function appendEntry(path, entry, guard) {
  guard.check(entry, `journal entry ${entry.stepId}`);
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try { fs.writeSync(fd, JSON.stringify(entry) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
