# Signed host authority: protocol and actual-chain review

Status: NOT deployable or whole-profile qualified. Root fixes two demonstrated integration defects; same-generation Offline restoration remains a failing acceptance case, and actual safe dispatch/runtime adoption and durable authority lifecycle remain incomplete. No production or financial action occurred.

## Terminal Claude source and scope

Verified steven.r.batchelor@gmail.com Max source-only author completed rc0,37turns/1192.220seconds with all77 input pins unchanged. Terminal33 files frozen; original first writes and report retained. The terminal generator cd09161a is byte-identical to the independently checked five-file generator snapshot. Guard bounds1536/1408RSS/floor27648/CPU1/noSwap; measured inner290/outer363/minavailable33817MiB. Unit inactive/MainPID0. Author tests were not executed by Claude.

## Real signed protocol and root integration failures

Root reconstructed a13-module pinned dependency closure and used the actual collector, witness class, typed-data verification, gate, runtime producer and lifecycle/authority journals. Ephemeral TEST accounts perform actual signatures. Witness transport, chain observations, manager/readiness and hardware boundary acknowledgements are explicitly test doubles. The process ran in an owned network namespace without external routes.

All7 authored protocol cases PASS,0skip. Three independent root cases then FAIL,0skip:

- Advancing another host's authority withdraws this host's installed grant, violating the host ownership boundary.
- An actual-adapter-shaped snapshot with verified=true and without the fixture's invented top-level proofVerified fails at the real serving-context conversion. This shape test is not an actual adapter/EVM execution.
- After the real verifier refuses an authenticated same-generation Offline context, an older Online context reinstalls the same valid signed envelope. Unlike the prior sidecar baseline, this test reached and failed the stale-Online restoration assertion.

Root r2 changes only two lines: host-wide invalidation filters entries by the affected hostId; servingContextOf maps the actual adapter's top-level verified field at the authenticated snapshot boundary. The original file/diff and all failures are retained. Re-generated protocol plus authored7/root3 gives9PASS/1FAIL/0skip. The unresolved test is same-generation Offline restoration. Nested flags alone remain insufficient to prove real chain authority; full actual adapter-to-runtime composition is still required.

## Actual canonical registry and final-send adapter

Root reviewed the authored harness before running a narrow23-case subset against owned Anvil8453/public TEST keys. The actual canonical registry artifact and linked schema3 ledger/controller/prover are used, with exact runtime/binding checks. TEST finality/receipt authorities, synthetic balances, public fixture signers and relay spy are explicitly labelled. No code-size override or signature shim. No live Base, production attestation or inclusion-latency claim.

One-stage root-b648 canonical suite:15PASS/1FAIL/0skip. The failing case is line147 of root-host-registry-profile.test.mjs: direct prepare(Running) while host Offline does not reject. Earlier no-new-serving assertions in that case passed; assertions after the failure did not run. The old adapter has no corresponding direct prepare guard. This is a genuine old-adapter gap; it must not be hidden by weakening the test.

Final generated adapter suite:7PASS/0FAIL/0skip. It verifies context persisted in exact durable intent; Offline during actor signing and owner policy change during approval collection refuse before send; unqualified final read refuses; stable authority sends exactly once; mined lost response resolves after recovery/restart with no resend; owner Stop remains available while Offline and historical qualification expired; old contextless payload remains readable but cannot authorize a new Running send. The new prepare guard covers an Offline positive-refusal case, but the entire canonical16 suite has not yet been run against the final layered adapter. Its provenance/generator test must verify both layers, not compare to old b648 bytes.

The native unit terminated exit1 from the retained one-stage failure, not a guard stop.512MiB outer/450RSS/floor27648/CPU1/noSwap; measured inner289MiB/outer351MiB/minavailable33937MiB. Exact TEST compiler child exits before Anvil. Both owned suites/temporary tree cleaned. Source pins unchanged. Root shell delta only selects23 cases, redirects outputs to frozen root stage, fixes the known OUT/one directory omission and adds exact solc pins. Original authored175-case proposal is retained, not claimed run. Compiler raw input/output remains under the local native-r1 paths; fixture manifests retain their hashes and exact compiler delta. Do not conflate these23 executions with protocol tests or earlier101 composition checks.

## Remaining integration work

- Durable host-wide Offline denial and observation ordering, including restart, same-generation stale Online refusal, qualified-generation recovery and isolation from unrelated hosts.
- Actual dispatch incarnation journal must be repaired/replaced coherently; adding a separate gate journal does not repair the four old sidecar failures. Established-state loss across restart, writer exclusion and uncertain durability need real lifecycle coupling.
- Mandatory v2 selection for the new profile; preserve v1 defaults for legacy profiles.
- Post-sign witness closure/fence/deadline checks after its final awaited authority read.
- Safe dispatch-to-runtime handoff wiring and positive progress after stop retires runtime state while the ledger remains Running. Direct runtime calls with a comment claiming safe authorization are insufficient.
- Production independent witness reader, actual hardware resource boundary enforcement, capacity/attestation/sponsorship, funded independent Offline sender, positive Base authority and fenced migration remain required by the full goal.

The next exact source-only task and141 pins are in next-task. It uses root r2 corrections and requires complete available JS/protocol/composer wiring and the unchanged acceptance cases. Approval to write source is not activation authority or a test pass. No current contract/session permissions, funds, host controls or serving apps changed.

Published logs remove trailing spaces only where listed in raw-log-formatting.json, preserving exact original local paths/hashes. Full failures remain visible. All package files are hash-pinned in review-pins.json.
