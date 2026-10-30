# Windows operator wiring r1 — root review

Status: SOURCE ONLY; not installed. Production migration is authorized, but this candidate fails seven independent release-boundary tests. No new user approval is needed merely to repair or qualify it. App-card self-host Top up remains live; d979, EyesOff and sia-s3 are the three previously verified original recoveries. No payment, grant, backend restart or migration was performed in this review.

## Frozen source and preservation

Claude invocation bae7715b7cc4405fb9adad4aea36d4e5 terminated rc0. Peer collected exactly once after known PID/start/executable/CWD termination. Frozen248 manifest SHA3d07b8960f71a212745630bb68efa90fc2390a93bc29a00fff55a261ed582840; eight changed files, none removed; 11116 read-only input pins unchanged, no replay/outside-tool issues. The complete delivery is committed/pushed at d9a547a1b84bed5a3f2044fb156fb348ae06a8c3. All248 candidate hashes were independently checked before and after tests. No product repairs were made here.

## Executed evidence

The delivered Windows wiring suite plus retained durability/quarantine checks passed **92/92**, zero skips/cancellations. The retained tests use actual Linux owned storage and the unchanged shipped client with inert external signer/RPC/relay fixtures. The new suite uses actual loader/Host constructor/chain/installer functions, with labeled external Windows runtime/ACL/probe answers. Its TEST apply uses disposable Linux storage and an in-process exclusion. The full agent is not imported or booted. This is not native Windows, EXLOCK, real service ACL, Base or OS-crash qualification.

Seven additional root tests all failed (**0/7**, zero skips/cancellations):
1. Explicit selected-service full-control ACL on config directory was accepted by preflight.
2. BA/SY-only config directory, inaccessible to the selected service, was also accepted.
3. Minimal release manifest without the actual imported owned-durable-state.mjs was accepted.
4. An existing1MiB config was read by unbounded readFileSync before the16KiB bound was checked.
5. Production config runner selected relative powershell.exe through PATH.
6. A large multibyte output chunk exceeded the combined UTF8 output budget.
7. Timeout only requested kill; it did not settle until the mocked external process emitted close.

The first four tests call the actual installer/config modules with disposable external fixtures. The last three load the actual psrun/config modules and intercept only child_process.spawn; no process or PowerShell was spawned. They establish source behavior, not native process-death containment. Author baseline, all failures and fixture provenance are retained. The root installer helper is derived from the author fixture; the ancestor source test is unchanged.

Additional peer source findings remain to address: service principal syntax does not prove user/service versus group; exact config/qualification/evidence access needs the selected service SID and protected immutable inputs; legacyDir must bind actual NODE_DIR and fresh old-writer exclusion, not an arbitrary clean directory; existing/legacy reads need preallocation bounds/link/race checks. The agreed operator dependency closure must be pinned, with full Host composition separately stated. Normal read-only reconciliation and Stop must stay available while unsafe operator effects refuse.

## Resources and next action

Both test units are terminal MainPID0; owned temporary directories are gone. Shared queue512MiB hard,450RSS inner,27648MiB host-available floor,CPU1,noSwap, isolated loopback namespace. Baseline peak245MiB aggregate/min32589MiB; root boundaries peak193/min32614MiB. No active test/build. Failed boundary unit state is retained as evidence, not automatically reset.

Peer is preparing ONLY a narrow source repair r2 against exact frozen248 and these failure-backed inputs. No author launch/product preedit/test/build/live action was delegated by preparation. Root will review finaltask/runner/pins/Max before one bounded Claude author. Preserve all92 prior passing behaviors, root account-nonce quarantine, r12 three transport/identity fixes and existing bundles. Do not bypass failures with synthetic qualification or a TEST production path.

Native qualification remains unadmitted: live18432MiB floor plus pending,observer and early-setup commitments must be preserved; old17408MiB launcher cutoff is insufficient. No native Windows execution, new grant or protocol migration is implied. Automatic refill, capacity qualification, independent ledger Offline and full censorship-resistance goal remain unfinished.
