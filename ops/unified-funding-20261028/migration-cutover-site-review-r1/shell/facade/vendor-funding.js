// TEST facade for the page's import("/vendor/funding.js") (client-site-browser-r1; UNREVIEWED, NOT RUN).
// Re-exports EVERYTHING of the ACTUAL generated portable client (/harness/vendor/funding.js = client-site-repair-r2/
// candidate/site/vendor/funding.js, 327921 bytes, sha256 4c56d071..., hash-gated by the server) unchanged - every core
// function (verifyRuntime, buildMigrationPlan, signSteps, runMigration, reconcileMigration, quoteGasFund,
// confirmGasFund, ownerControl, native P-256 signing ...) is the actual one. Two shell overrides only:
//   IndexedDbV2Store()  without a name opens this run's random TEST database (any other name is refused);
//   jsonRpc(url)        the actual jsonRpc, preceded by the harness's one-shot RPC hold (a delayed read that runs a
//                       network switch while a page flow is pending). Arguments and results pass through unchanged.
import * as Real from "/harness/vendor/funding.js";
import { H } from "../harness-state.js";

export * from "/harness/vendor/funding.js";

export class IndexedDbV2Store extends Real.IndexedDbV2Store {
  constructor(...args) {
    if (args.length) throw new Error("TEST harness: the page must not choose a database name");
    super(H.dbName("v2", [Real.V2_DB, Real.LEGACY_DB]));
  }
}
export function jsonRpc(url, fetchImpl) {
  const rpc = fetchImpl === undefined ? Real.jsonRpc(url) : Real.jsonRpc(url, fetchImpl);
  return async function heldRpc(method, params = []) {
    await H.onRpc(method);
    return rpc(method, params);
  };
}
