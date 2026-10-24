// One stage per process on the reviewed transport (handoff-server.mjs, unchanged: one durable attempt per journal, the
// journal written BEFORE a transaction reaches the browser, only an explicit 4001 resets an unsubmitted attempt, a recorded
// hash is never replaced, origin/host/token/CSP/body-size limits). Here: the stage's prepare/verify (bounded by a
// deadline), and an accept hook that records a hash only when a provider already returns it with exactly the request's
// fields and it is not the other stage's hash. The other stage's journal is only READ.
import { createHandoffServer } from "./handoff-server.mjs";
import { withDeadline } from "./rpc.mjs";
import { STAGES, frozen, prepareFund, prepareAccept, verifyFund, verifyAccept, acceptHook } from "./stages.mjs";

/**
 * A journal left in "preparing" belongs to a process that stopped mid-preparation. The transport hands a transaction to
 * the browser only after "awaiting-wallet" is on disk, so nothing reached the wallet: it is safe to make it "ready".
 * Every other state is kept exactly.
 */
export function recoverInterruptedPreparation(journal) {
  const s = journal.read();
  if (s.status !== "preparing") return false;
  journal.write({ status: "ready", recoveredFrom: "preparing", recoveredAt: new Date().toISOString() });
  return true;
}

/** stageApp({ stage: "fund" | "accept", trust, clients, journals: { fund, accept }, assets }) */
export function stageApp({ stage, trust, clients, journals, assets = {} }) {
  if (!STAGES[stage]) throw new Error("stage must be fund or accept");
  const own = journals[stage], other = journals[stage === "fund" ? "accept" : "fund"];
  recoverInterruptedPreparation(own);
  const prepare = () => withDeadline(trust.deadlineMs, "the preparation", () => (stage === "fund" ? prepareFund : prepareAccept)({ trust, clients, journals }));
  const verify = (request, hash) => withDeadline(trust.deadlineMs, "the verification", () => (stage === "fund" ? verifyFund : verifyAccept)({ trust, request, hash, clients }));
  const hook = acceptHook({ trust, clients, otherJournal: other });
  const accept = (hash, request) => withDeadline(trust.deadlineMs, "the transaction lookup", () => hook(hash, request));
  const initialRequest = { stage, purpose: STAGES[stage], transaction: frozen(trust, stage) };
  return createHandoffServer({ initialRequest, prepare, verify, accept, journal: own, assets });
}
