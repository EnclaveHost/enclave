// The one stage on the reviewed transport (handoff-server.mjs, byte-identical: one durable attempt per journal, the journal
// written BEFORE a transaction reaches the browser, only an explicit 4001 resets an unsubmitted attempt, a recorded hash
// is never replaced, origin/host/token/CSP/body-size limits). Here: prepare/verify bounded by a deadline, and an accept
// hook that records a hash only when a provider already returns it with exactly the request's fields.
import { createHandoffServer } from "./handoff-server.mjs";
import { withDeadline } from "./rpc.mjs";
import { PURPOSE, frozen, prepare, verify, acceptHook } from "./activation.mjs";

/** A journal left in "preparing" never reached the wallet (the transport writes "awaiting-wallet" first): make it "ready". */
export function recoverInterruptedPreparation(journal) {
  const s = journal.read();
  if (s.status !== "preparing") return false;
  journal.write({ status: "ready", recoveredFrom: "preparing", recoveredAt: new Date().toISOString() });
  return true;
}

export function activationApp({ trust, clients, journal, assets = {} }) {
  recoverInterruptedPreparation(journal);
  const hook = acceptHook({ trust, clients });
  return createHandoffServer({ initialRequest: { stage: "activate", purpose: PURPOSE, transaction: frozen(trust) },
    prepare: () => withDeadline(trust.deadlineMs, "the preparation", () => prepare({ trust, clients })),
    verify: (request, hash) => withDeadline(trust.deadlineMs, "the verification", () => verify({ trust, request, hash, clients })),
    accept: (hash, request) => withDeadline(trust.deadlineMs, "the transaction lookup", () => hook(hash, request)),
    journal, assets });
}
