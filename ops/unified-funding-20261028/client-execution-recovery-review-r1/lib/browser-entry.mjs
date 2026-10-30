// UNREVIEWED SOURCE, NOT RUN (client-execution-recovery-r1). Successor browser entry: every r4 export unchanged, plus
// the execution-recovery API. confirmGasFund and quoteGasFund are EXPLICIT re-exports, which take precedence over the
// same names reached through `export *` (ECMAScript: star exports never shadow explicit ones), so the bundle exposes
// exactly one implementation of each. The portable copy for sdk/funding is produced by integration/prepare.py.
export * from "../../client-repair-r4/lib/util.mjs";
export * from "../../client-repair-r4/lib/v2-store.mjs";
export * from "../../client-repair-r4/lib/funding-client.mjs";
export * from "../../client-repair-r4/lib/migration.mjs";
export {
  confirmGasFund, quoteGasFund, reconcileGasExecution, listGasExecutions, executionBlockers, classifyExecuteFailure,
  verifyStoredIntent, proveCandidate, bindReview, execId, isBlocking, EXEC_SCHEMA, CLEARED, DEFINITIVE_REFUSALS,
  MAX_DISCOVERY_BLOCKS, MAX_CANDIDATES,
} from "./gas-execution.mjs";
