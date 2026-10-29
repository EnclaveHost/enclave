# Independent host authority r2: root review

2026-10-29. **Staged source, not deployable or installed.** Claude completed exit 0; its unit and author process are terminal. `author-pins.json` preserves the complete delivered source before root changes. `docs/REPORT.md` describes the author's intent; this review overrides its unqualified claims about capacity, owner-offline recording and mandatory publisher consent.

## Verified source changes

The generated candidate host separates its local owner's controls from the Enclave platform policy, applies the latter only to authenticated platform-owned hosts, and preserves old behavior for unrouted apps. It removes the legacy address-book dependency from the dispatch after its handoff. The admission helper makes central catalog moderation optional under the host owner's committed policy. These changes do not yet remove central dependencies inside the actual r6 chain adapter or platform ingress/custody paths.

All 60 delivered author tests passed, zero skipped. They exercise the real candidate host/runner and existing admission helpers against fake loopback RPC and mock authority/runtime/transactions. They are not live Base, host attestation, financial or production independence evidence.

Root reproduced and fixed one additional integration defect: `DeploymentLifecycleRunner`'s generation-proof branch overwrote a current host-local admission refusal with older anchor admission. The staged runner now computes `hostAdmitted && snapshot.admitted !== false`. This only retains a refusal; it cannot raise eligibility, rewrite an authenticated anchor or skip proof verification. The root positive-control/owner-refusal regression passes, and all 26 existing runner and generation-proof regressions pass against this exact runner through a test-only import hook. Original baseline files are unchanged.

The combined candidate suite after that change is **61 pass, 1 fail, 0 skipped**. Its remaining failure is the independently reproduced recovery-capacity defect below. `run-fixed.py` deliberately expects that known nonzero suite result before running the separate proof regressions. Its overall exit 0 is **not** an all-green candidate verdict.

## Open defects requiring implementation

1. Recovered Running assignments publish zero CPU allocation because dispatch uses only this process's start reservations. Capacity must recover real runtime/plan/journal commitments, retain allocations through unknown/fenced states and failed retirement, release only after confirmed retirement, and block new admissions until other recovered commitments are known. Test actual Host.occupies/shareUse, pending/ambiguous launches, concurrent starts and resource headroom. No actual production over-allocation was shown by these mock tests.
2. Two new goal-alignment regressions fail: publisher delisting or yanking the same unchanged artifact vetoes an independently owned deployment even when no catalog moderation was elected. This is a mutable publisher listing preference, not content integrity or deployment-owner authority. In particular, Enclave publishing an app must not give it a global runtime veto on other wallets' hosts. Preserve immutable content verification and deployment/host owner controls; allow the host owner to elect a moderation policy. Discovery metadata must not silently become mandatory running authority. The tests use a fixed mock content commitment, not a real downloaded artifact.
3. r6 still reads and requires global address-book equality, maps catalog moderation into global `enabled`, gates starts on address-book administrator changes, and omits actual resource fields. The author correctly identified these dependencies but did not implement the required adapter changes. A composed fake adapter that allows the app cannot qualify the actual path.
4. Host owner revision floors and local holds remain memory-only. Restart replay/cap-hold recovery needs durable ownership-aware journal integration.
5. Schema-3 emergency ledger/prover integration, independent failed-host submission, real migration handoff, manager/ingress/storage/secret boundaries, verified pre-registration capacity sponsorship and restricted automatic refill remain incomplete. Current immutable grants target the old reserve and cannot be silently repurposed.

## Resource and evidence scope

Each run used the shared small 256 MiB/no-swap allocation, inner RSS cap 220 MiB, floor 27648 MiB, one CPU and bounded timeout. Author suite outer peak235 MiB/minavailable34166; fixed suite+proof regressions outer peak233/minavailable34407; publisher tests outer peak195/minavailable34273. All owned test processes ended; fake RPC listeners were closed by their fixture cleanup. No production file, relay, controller, browser key, journal or payment was changed.

Logs retain the exact author baseline, combined fixed suite, separate runner/proof regressions and the two publisher failures. `review-pins.json` records the final staged source and baseline dependencies. Next source task `lifecycle-independent-composition-r3-20261029` is prepared but not started; the peer's actual ledger/prover author and one bounded compile take the shared main lane first.
