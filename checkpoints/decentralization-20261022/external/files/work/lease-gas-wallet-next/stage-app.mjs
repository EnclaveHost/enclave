// The stage-2 and stage-3 wallet handoffs on root's own transport (handoff-server.mjs: one durable attempt, the journal
// written BEFORE a transaction reaches the browser, only an explicit 4001 resets an unsubmitted attempt, a submitted
// hash is never replaced). One journal per stage; a stage prepares only when the previous stage's journal is confirmed,
// and even then the previous stages are verified again ON CHAIN from their journaled request + hash: a journal's
// "verification" field is never trusted. A hash that belongs to another stage is refused before it is recorded.
import { createHandoffServer } from "./handoff-server.mjs";
import { prepareExecutorRequest, verifyExecutor, prepareBindRequest, verifyBinding } from "./stages.mjs";

const lc = (h) => String(h || "").toLowerCase();
const confirmed = (j, what) => {
  const s = j.read();
  if (s.status !== "confirmed" || !s.request || !/^0x[0-9a-f]{64}$/.test(lc(s.hash))) throw new Error(`${what} is not confirmed in its journal (status ${s.status}); finish and verify it first`);
  return s;
};

/**
 * stageApp({ stage: "executor" | "bind", trust, artifacts, clients, journals: { reserve, executor, bind }, assets })
 *   journals.reserve is root's reserve journal and is only ever READ here.
 */
export function stageApp({ stage, trust, artifacts, clients, journals, assets = {} }) {
  if (!["executor", "bind"].includes(stage)) throw new Error("stage must be executor or bind");
  const own = journals[stage];
  const others = () => [journals.reserve.read(), stage === "executor" ? journals.bind.read() : journals.executor.read()].map((s) => lc(s.hash)).filter(Boolean);
  const prepare = async () => {
    const r = confirmed(journals.reserve, "the reserve creation");
    if (stage === "executor") {
      if (journals.bind.read().status !== "ready") throw new Error("the binding stage has already started; the executor is not created again");
      return prepareExecutorRequest({ trust, artifacts, reserveRequest: r.request, reserveHash: r.hash, clients });
    }
    const e = confirmed(journals.executor, "the executor creation");
    return prepareBindRequest({ trust, artifacts, reserveRequest: r.request, reserveHash: r.hash, executorRequest: e.request, executorHash: e.hash, clients });
  };
  const verify = (request, hash) => (stage === "executor" ? verifyExecutor : verifyBinding)({ trust, request, hash, clients });
  const accept = async (hash) => { if (others().includes(lc(hash))) throw new Error("that transaction belongs to another setup stage; it is not recorded here"); };
  const initialRequest = stage === "executor"
    ? { purpose: "Create the lease executor for the verified reserve; zero ETH", transaction: { from: trust.admin, chainId: "0x" + trust.chainId.toString(16), value: "0x0" } }
    : { purpose: "Bind the verified executor to the verified reserve, once; zero ETH", transaction: { from: trust.admin, chainId: "0x" + trust.chainId.toString(16), value: "0x0", to: "the verified reserve" } };
  return createHandoffServer({ initialRequest, prepare, verify, accept, journal: own, assets });
}
