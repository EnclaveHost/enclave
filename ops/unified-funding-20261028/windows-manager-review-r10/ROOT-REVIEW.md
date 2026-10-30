# Windows host integration r10 — root review

Status: **NOT DEPLOYABLE**. Frozen source reviewed and bounded Linux tests executed. No production, Windows remote, application, financial or configuration mutation. The 222-file product candidate is unchanged by root review.

## Provenance

Same source-only Claude invocation `9e68c9e57cdb4247aeea1e772bfa20ee`, independently verified required Max account; rc0/session `ff1974c3-95ea-4623-8486-6edf629bd9dc`, duration752695ms. 222 frozen files,12 changes,0 removals; manifest `c2ce5554636fa47eea7d760451cc4fa1dd8b07def05358cc95b4d77545c112ff`. All5213 readonly input pins unchanged. Read30/Grep21/Edit30/Write3, no unexpected tool/outside mutation/replay issue. Exact executable/cwd and recorded PID audit established shutdown before collection. Raw85 user rows and51 distinct assistant message IDs are separate from configured55 agentic turns. Inner317MiB/outer383MiB, minimum available32963MiB. See terminal-summary and mutation audit.

## What changed and passed

The actual Host now starts protected reconciliation independently of legacy address-book readiness/failure. Authenticated Stop/Offline is processed before new-work configuration/planning. Protected configuration comes from the selected ledger snapshot instead of the retired catalog/ledger. Publisher yank/delist no longer vetoes unchanged independent content in these consumer checks. Recovered/pending lifecycle allocation participates in the actual Host's capacity accounting; the factory wires dispatch recovery and reservation before staging.

The new eight checks pass: real Host class/tick/private launch/reconcile/share accounting and actual enrollment/supervisor code with labeled TEST external services/runtime and a plan reachability probe; separate actual Host view + real owned factory/journals/dispatch capacity recovery/refusal checks. No positive actual runtime stage/serve follows from these tests. Existing real two-manager/router TCP composite and prior owner-loss regressions continue to pass in their recorded fixture scopes.

The new snapshot `configCid` and `owner` fields exist in both retained legacy and exact schema3 ledger `get` tuple ABIs and flow through the pinned readContract/decode path. This resolves field-existence uncertainty; it is not a live independently authenticated chain read.

## Executed results

| Run | Pass | Fail | Skip/cancel | Evidence |
| --- | ---: | ---: | ---: | --- |
| Focused52 | 51 | 1 | 0/0 | `focused-result.tap`; unitbe299f9aaac7469db930c3200693b9bc |
| External r5 fixture correction + new policy cache checks9 | 7 | 2 | 0/0 | `root-regressions-result.tap`; unit06099f4d86a54de18ca7ce4a292ae4e5 |
| Actual serialized chain helper/send boundary4 | 1 | 3 | 0/0 | `send-boundary-result.tap`; unit72c13d87b31d47c294f35d026f311300 |
| Carried r10 eight + new actual Host route-progress case9 | 8 | 1 | 0/0 | `route-progress-result.tap`; unit276a9bf8a8974de69c6ae0333cc11c06 |

Runs overlap; do not sum as unique coverage. The focused failure was the carried r5 fixture dropping transport timeout/body-bound arguments. The external copy forwards `...bounds` and relocates imports only; all six r5 cases then pass with assertions intact. Original failure and source are retained. All new failures below are independent regressions on unchanged frozen product source.

All tests used shared512MiB lane/hard512, inner450, floor27648, one CPU/no swap, owned loopback-only namespace and short temporary directory. Exact222 candidate pins verified before/after; unitsMainPID0 and temporary directories removed (`root-cleanup-verification.json`). Fast sender tests finished before a guard sample: peak0/min n/a means unavailable measurement, not zero memory use. Other measured peaks are in guards. No network, real signing, transaction or VM execution in the new root cases; the chain tests use the actual serialization/send/helpers with an inert TEST RPC/wallet and public TEST account.

## Reproduced blockers

1. **Policy cache does not invalidate.** After a valid pinned policy has been parsed, corrupting or removing it still returns legacy eligibility/valid state. Initial-corruption positive control correctly refuses; the two post-read cases fail. These execute the actual predicates used at Host send boundaries, not a financial transaction.
2. **Serialized sender lacks final permission checks.** `claimDeployment` and `releaseDeployment` ignore supplied caller gates. Renewal respects an initially refusing gate, but if permission changes while awaited simulation runs, the actual sender reaches the inert wallet write. Three failing cases plus the positive refusal control establish this independently of the policy cache. Host also needs to pass real gates for claim/release. Sponsored sender signing/POST/retry boundaries require corresponding actual source qualification; this run tests only the direct branch.
3. **One route's held plan blocks another route's next Stop pass.** Actual Host protectedTick reaches a held plan for routeA after both routes' first authority read. RouteB then becomes authenticated Stopped and a second tick is requested; no routeB revoke occurs while the plan remains held. The fixture releases the plan in finally and awaits both calls. This proves shared guard delay, not perpetual serving: separate permit deadlines remain defenses. Offline/Stop authority must progress independently of new work.

## Additional source findings requiring executable qualification

See `frozen-host-admission-review.md` for paths and limits. `admitStart` reads fresh host authority but checks/reserves and stages the earlier supplied deployment snapshot. Fresh deployment state/generation/assignment/resources/config must be bound or consumed at the effect; a new host decision alone is insufficient. Reservation discharge is not wired for verified-plan refusal, definitive refused spawn or the runtime's internal startup-deadline stop. Require exact operation/absence evidence before release; never clear unknown or journal-committed work because of an exception or timeout. These are source findings, not executed stale-spawn or leaked-capacity claims.

The actual positive Host + real factory/runtime/client/manager/router queued -> Running -> TCP -> Stop/Offline consumer is still absent. New PartA uses a TEST owned runtime and PartB demonstrates capacity refusal/recovery only. Native protected roles and useful workload boundary code are untouched. Production quiescence verification, independently authenticated Base authority, Windows exclusion, release dependency closure, zero-gas capacity qualification, sponsorship/automatic refill, protected independent Offline gas and fenced migration remain unfinished.

## Next work

One source-only Claude successor is PREPARE ONLY pending root review of immutable inputs/account/runner. Repair reproduced cache/send/route-progress failures and fresh snapshot/reservation closure; require the positive real consumer rather than another constructor-only completion claim. Preserve authenticated independent Offline, owner controls, unknown-send reconciliation, exact absence and neighboring workloads. Continue native/workload/full goal scope. No new wallet request/deposit, no additional recovered-app claim and no production activation.

Published source/ is the twelve changed/new files only; the full frozen candidate is described by the manifest and remains in the local review directory. This evidence package alone is not a standalone deployable build tree.
