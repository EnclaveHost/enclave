# Final source composition plan r2 (PREPARED; nothing run, built, queued or committed)

**Stage:** NEW `final-source-composition-plan-stage-r2/`. The r1 stage is frozen and was not edited, and the source candidate `debbfb377d90…` is unchanged. Everything here comes from reading the actual r12 outputs, git objects and the actual files; nothing was executed except `bash -n`.

## What the actual r12 says (`root-composition-r12-full-0313`, rc 1)
- **Summary line:** `RESULT: FAIL`, `regressions 8, baseline-not-clean 16; stack 9`, NATIVE metal-control-overlay `rc 0 OK`. 142 rows: 104 REGRESS, 28 component, 9 STACK, 1 NATIVE.
- **The 8 REGRESSION rows** (7 files):
  - attested-chain-verifier: two rows (verifier component and REGRESS), and it also fails as a STACK row;
  - host-service-transport, host-services-cold-start, windows-chain-authority, windows-node-network-enroll and windows-node-wallet-enroll, all with `rpcs is not defined`;
  - **windows-node-lease-renewal-keeper**.
- **Stack failure:** stack-windows-chain-reader fails 2/1.
- **The 9 stack rows** are not "8": the 5 `stack-*` files plus attested-route-composition, attested-chain-verifier, lease-pinned-relay-config and metal-measured-control.
  - The 5 `stack-*` files are r12 harness copies and are **not tracked** in debbfb37.
  - The other 4 are tracked tests, and r12 also ran them as STACK rows.

## Correction 1: the gate is the actual corrected D audit, not `combine`
- **Why not combine:** `combine` correctly preserves the old known failures, so it can never pass before the fixes. Gate A instead checks `composition-fixture-audit-correction-stage/root-actual-0347/audit.json`. It requires all of the following:
  - `ok: true` with no `fails`;
  - identity `{head: debbfb37, changed: 24}`;
  - closure `{consumers, 33 artifacts, 8 build-info}`;
  - deps `.`=`4e0328411792`, `network`=`2a1d5be8df94`, `relay`=`f3459e00dbe4`;
  - dTime "exactly the 33 bound artifacts".
- **Current audit state (sha256 `25a25991…`):** identity, closure, deps and dTime all match. But **`ok: false`**, with one failure: an unexpected `metal/__pycache__/overlay-control-image.cpython-314.pyc`, which is residue from a Python test run.
- **Consequence:** the gate **HOLDs** until root disposes of that file through a reviewed auditor rule or a clean re-audit. It is not waived.

## Correction 2: every non-ok row needs a qualified replacement or an explicit hold (`ROWS.tsv`)
| Disposition | Rows |
|---|---|
| **P1 receipt** (enrollment 82988, started) | host-service-transport, host-services-cold-start, windows-chain-authority, windows-node-network-enroll, windows-node-wallet-enroll (their closure contains P1 only) |
| **P3 receipt** (lease adapter 29692) | lease-designated-relays, lease-host-relay, lease-pinned-relay, lease-relay-migration, windows-current-runtime, windows-host-app-funded, windows-release-journal |
| **P5 receipt** (`stack-import-fixture-stage`, patch `517d529d…`; it applies to `r12/stack-tests`, so it is a harness file, not source) | stack-windows-chain-reader. Its closure contains none of P1–P4. **3/3 is not assumed** |
| **Rig impacted rerun r2** (`root-r12-impacted-rerun-r2-0346`, rc 0 or 3) | lease-relay-host-policy (component and final), cli-independent-sessions, and offchain-heartbeat-writers (which also needs `OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR`; a skip is not a pass) |
| **Composed rerun** | attested-chain-verifier (closure P2+P4; the provider job 92355 is the patch-level control) and cli-combined-independent (closure P4 plus MockFeed) |
| **ACTUAL** | metal-control-overlay, via the r12 F2 NATIVE actual PASS with the full inputs |
| **NEW, UNCOVERED** | **windows-node-lease-renewal-keeper.** It uses a different adapter, `test/helpers/windows-lease-scripted-fixture.mjs`. That adapter re-exports only 4 names, while `chain.mjs` needs `chainAuthorityFromEnv` and `refusingChainAuthority`. P3 does not fix it. It needs a small test-only pass-through patch, P6, and its own receipt. **Gate A HOLDs** on the empty P6 line |
| **HOLD-PROD** (`HOLDS.txt`; never waived, never counted as a pass) | windows-node-lease-readiness test 9 (PWSH unset, external cutover tools missing); the 22 browser tests (5+10+7) site-independent-*, which need a fork of public Base, blocked offline, until the own historical RPC is ready; windows-verifier.e2e (needs the rig); the MCP bundle's measured image; custody v2 REFUSED, lease consumers on HOLD, cutover not authorized |

19 tests need a per-row receipt (`ROW-EVIDENCE.required`). Root fills `ROW-EVIDENCE.tsv`: test, receipt, sha256 and count, each with fail, skip, todo and cancelled all 0.

## Retest set (deduplicated; no full 104 rerun)
- **Composed reruns (`RERUN-COMPOSED.tsv`): 43 unique tests:**
  - r1's 41 P4/P2 closure tests. They already include attested-chain-verifier, lease-pinned-relay-config, metal-measured-control, cli-combined-independent and MCP's own 5 files (the 73 tests);
  - stack-admin-controls (closure P4);
  - windows-node-lease-renewal-keeper (after P6).
- **Invariant stack rows whose closure contains no changed file keep their actual r12 PASS receipts.** Their modules, dependencies and setup are byte-identical: stack-provider-authority 4/0, stack-chain-authority-boundary 2/0, stack-custody-v2-refused 1/0 and attested-route-composition 7/0.
- **Rerun on the composed tree:** the invariants reached by P4, namely admin controls, lease-pinned config, measured control and attested-chain-verifier.
- **All other r12 ok rows reuse their receipts.**
- **Generated artifacts:** only `metal/guest/mcp-server.bundle.mjs` and its manifest change (P4). No other generated file changes.

## Patches (`PATCHES.sha256`, all pinned and checked)
| Patch | sha256 | Changes |
|---|---|---|
| P1 | `266be441…` | `network-enroll.mjs` |
| P2 | `478bc424…` | the G5 test |
| P3 | `34988b0a…` | the lease adapter |
| P4 | `dccad59c…` | MCP. Compose it **only after the 73 tests pass**, as the MCP r6 job 68896 receipt proves |
| P5 | `517d529d…` | the stack harness file |

r1 already checked that P1–P4 apply cleanly, alone and in sequence, on a private archive. The composed tree differs from debbfb37 in 7 files, recorded in `COMPOSED-FILES.sha256`; P5 applies to the r12 stack-tests copy.

**Guards, from source reading:**
- the admin/policy carriers, the custody/v2 refusal, the attested `txBackend` (own backend) path and the fail-closed verifier selection are untouched by P1–P5;
- P4 adds only an explicit fail-closed `chainAuthority: "verifier"`, which refuses `rpcs` or a `quorum` beside it.

## Runner skeleton (`jobs/root-final-compose-r2.sh`)
- **Gate A:** the audit JSON, then the `GATES.txt` job receipts with allowed rcs and exact lines, then exactly 8 MCP PASS rows. Any gap → **exit 3 HOLD**, with nothing written.
- **If gate A passes:**
  1. compose P1–P4 into a NEW private bare repo (read-only alternates);
  2. verify the 7 composed file hashes;
  3. commit as SteveDeFacto to `refs/final/source-unregenerated`;
  4. **exit 4.** Gate B stays open (MCP bundle regeneration, the 43 composed reruns, ROW-EVIDENCE), and every production hold is printed.
- **Never:** it never requires the old failed run to be green, and never waives a row.

## Status now
- **Will HOLD:** gate A, at the audit `ok:false` (pyc), at P1–P5 (82988 started; the others queued) and at the missing P6.
- **Not claimed:** no PASS, no production readiness and no image qualification.
- **Unverified formats:** the receipt line formats for P2, P5 and the rig r2 job are inferred from their runners. A false HOLD is possible, which is the safe direction.
