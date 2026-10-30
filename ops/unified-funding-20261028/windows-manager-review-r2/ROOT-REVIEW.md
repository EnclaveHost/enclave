# Windows permit r2: tested repairs and remaining integration defects

The full censorship-resistance goal remains incomplete. No production service, app, wallet, grant, router configuration or host admission was changed. This is a frozen source/evidence review, not an installation artifact.

## Author and source identity

One Claude run on the required verified Max account finished rc0 after 916.4 seconds and44 turns. The collector verified all586 read-only inputs unchanged,149 frozen files,8 changed files, no removals and no outside-candidate writes. Frozen manifest SHA256:3ef2255486db86f75e610219902b6ae50aa47bef7fa47bfdf56deb8f785b2490. This package contains the eight deltas and manifest, not all149 files or external dependencies. Root assembled the exact frozen candidate with the existing viem2.53.1 dependency used in r1. No product source was changed during these tests.

## Executed tests

All74 author tests plus the independent actual HTTP/MAC/TCP hold test ran under a512MiB shared allocation,450MiB RSS guard,27,648MiB available-memory floor,one CPU,no swap and an owned loopback-only network namespace. Final unit6ce5b5dcc6a449ad832e89b091114f2c was terminal/MainPID0: **74 PASS,1 FAIL,0 cancelled,0 skipped**. Peak inner257MiB/minimum host available33,257MiB. The three original root repair cases and the false ingress acknowledgment regression now pass. Real sockets/processes/cryptography are used, but chain/inventory/backend/exclusion remain TEST fixtures; this is not Windows, Hyper-V or Base qualification.

The remaining author failure is the prior win-durable test's incomplete instance record. It lacks newly required identity/state fields and transitions directly from staging to removed without confirmation. The strict validator rejects it before its intended assertions. Update that fixture while preserving replay/revival checks; do not weaken the schema. No claim all author tests pass.

The first full run had62 PASS and13 cancellations because the hung-startup test awaits an unref'ed retry timer without any referenced service handle. A test-only preload keeps the runner alive until the test after hook, modeling the real service's listener; the candidate and assertions are unchanged. Short persistent owned TMPDIR avoids both tmpfs journal rejection and overlong Unix socket paths. Initial results are retained.

## Independent remaining defects

Three independent root cases ran against the unchanged candidate: **0 PASS,3 FAIL,0 cancelled,0 skipped**. Unit89438f84034448109deaebdabb1a5d04 terminal/MainPID0,256MiB allocation/220RSS/same floor/noSwap/oneCPU,inner97MiB/min33,449MiB.

1. Registration acknowledges an armed permit after its durable append crosses the wall deadline. Remaining time was measured before the append and the timer is armed afterward without a freshness recheck.
2. Renewal has the same slow-write defect. The test advances injected wall/monotonic clocks during actual append; it does not claim a Windows VM escaped.
3. A journal read error prevents the independent guard withdrawal call, because #remove accesses the journal before dispatching that call and before its retry try/catch. Ingress closure was exercised but the independent guard received zero withdrawals.

The first root-races attempt exposed registration then cancelled two tests: its cleanup hook released the log before stopping the guard, causing removal retries against a released log. The corrected fixture stops the guard before releasing the log and includes the service-lifetime preload. Both versions/results are retained; do not call the initial cancellations product failures.

Other source-only findings remain unqualified: retrying a memoized failed gate close; hung exact removal after loss of guard; instance same-sequence equivocation/null-reset semantics; and authority qualification based on caller-supplied plain fields instead of genuine verified authority construction. The author explicitly leaves supervisor/isolation integration, general8091/native8095 composition, Windows derived authority/exclusion and full desktop/GPU/secrets/storage/ports/workload protection incomplete. Refusing these workloads is not completion of the requested migration.

## Actual live router baseline

One bounded read-only observation at13:49:01UTC found stable8097 listenerPID40360 and unchanged valid journal bytes: lastState observed,physicalMiB0,digest6a64e839b805ee7960c2ef4a8001b6d72d7266a28dac776e7427892cbe01c84d. This is a momentary journal observation, not proof that future/direct/external commitments are absent. The observation remained inadmissible for a memory allocation and performed no lock test or remote file mutation.

The actual router/control.mjs SHA256966fd3b5480e9859de4f1dc578b25afa1150e97552437e8c183c03bba4606e6a differs from the v12 seed ae43a93780e4f8651af6e365720ed5f0cc91557aef0f062979732eb867bc17c8. Exact source exists in native-router-health-v13. Two health hunks preserve catalog capabilities and return503/admission.ready=false for incomplete inventory or blocked journal rather than200 with emptied capabilities. This protects running apps from being misclassified as permanently incompatible. Admission serialization/accounting/routing are otherwise unchanged in this diff. Preserve these live semantics in the next composed candidate. Disk identities do not prove every module loaded in the long-running process.

Next implement the demonstrated repairs and actual host/supervisor/authority/workload integration, preserve current router behavior, then qualify the exact Windows path and fenced migration. No repeat payments, automatic activation or production rollout is authorized by these tests.
