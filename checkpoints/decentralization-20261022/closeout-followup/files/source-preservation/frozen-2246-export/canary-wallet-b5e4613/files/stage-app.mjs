// One local origin, two stages, on the adapted transport (handoff-server.mjs; diff in evidence/handoff-server.diff):
//   upload  (journal upload.json):  token-protected /upload/* routes; the administrator's personal_sign comes from the page
//   publish (journal publish.json): /prepare is gated on the stored, freshly re-fetched component; one durable attempt;
//                                   only an explicit 4001 or a chain-based /reconcile resets an unsubmitted attempt;
//                                   a recorded hash is never replaced.
import { createHandoffServer } from "./handoff-server.mjs";
import { withDeadline } from "./rpc.mjs";
import { uploadStage } from "./upload.mjs";
import { PURPOSE, frozen, prepare, verify, acceptHook, reconcileHook } from "./publish-stage.mjs";

/** A journal left in "preparing" never reached the wallet (the transport writes "awaiting-wallet" first): make it "ready". */
export function recoverInterruptedPreparation(journal) {
  const s = journal.read();
  if (s.status !== "preparing") return false;
  journal.write({ status: "ready", recoveredFrom: "preparing", recoveredAt: new Date().toISOString() });
  return true;
}

export function canaryApp({ trust, clients, preparer, journals, assets = {}, fetchImpl = fetch, now = () => Date.now() }) {
  recoverInterruptedPreparation(journals.publish);
  const upload = uploadStage({ trust, journal: journals.upload, fetchImpl, now });
  const hook = acceptHook({ trust, clients }), rec = reconcileHook({ trust, clients, now });
  const routes = Object.fromEntries(Object.entries(upload.routes).map(([k, f]) => [k, (b) => withDeadline(trust.deadlineMs, "the upload step", () => f(b))]));
  const app = createHandoffServer({ initialRequest: { stage: "publish", purpose: PURPOSE, transaction: frozen(trust) },
    prepare: () => withDeadline(trust.deadlineMs, "the preparation", () => prepare({ trust, preparer })),
    verify: (request, hash) => withDeadline(trust.deadlineMs, "the verification", () => verify({ trust, request, hash, clients })),
    accept: (hash, request) => withDeadline(trust.deadlineMs, "the transaction lookup", () => hook(hash, request)),
    reconcile: (request) => withDeadline(trust.deadlineMs, "the reconciliation", () => rec(request)),
    gate: () => withDeadline(trust.deadlineMs, "the storage check", () => upload.gate()),
    status: async () => ({ upload: upload.status(), component: { size: trust.component.size, sha256: trust.component.sha256, cid: trust.component.cid } }),
    routes, journal: journals.publish, assets });
  return Object.assign(app, { upload });
}
