// TEST facade for site/js/core/config.js (client-site-browser-r1; UNREVIEWED, NOT RUN). MOCKED SHELL.
// Exports only what the /funding page imports. Values come from the owned fixture (/test/fixture/config) via the shell:
//   FUNDING_RUNTIME            the fixture's deployed-receipt runtime pins (or null in the "null runtime" phase)
//   FUNDING_MIGRATION_PROPOSAL the TEST 24 / 4.8 / 1.2 split over the fixture's 8 + 2 apps for this run's original sid (production-grant-terms-r1)
//   FUNDING_MIGRATION_APPROVAL null until the harness's explicit "TEST-approve" button checked the displayed plan
//   APP_CATALOG_RPCS           this loopback origin's read-only /rpc proxy to the owned Anvil (never a public RPC)
// Production config.js keeps all three FUNDING_* values null; nothing here is used outside this harness.
import { H } from "../harness-state.js";

const c = H.pageConfig();
export const APP_CATALOG_RPCS = Object.freeze([`${location.origin}/rpc`]);
export const FUNDING_RUNTIME = c.runtime;
export const FUNDING_MIGRATION_PROPOSAL = c.proposal;
export const FUNDING_MIGRATION_APPROVAL = c.approval;
export const FUNDING_MIGRATION_CUTOVER = c.cutover;   // migration-cutover-site-review-r1: TEST pause terms (null unless a C-phase set them)
export const FUNDING_CUTOVER_ACTIVATION = c.activation;   // migration-cutover-site-review-r1: TEST activation record (never a production review)
