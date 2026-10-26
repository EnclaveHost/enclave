# Enrollment r7: diagnosis of root 1447's r6 slice and test-only corrections (source only; NOT run by Claude)

**Evidence:** `accepted-image-enrollment-stage/r6/runs/20261026T161518Z-slice-2009141`. It was TERMINAL when I finished: `verdict.json` is present. I read every TAP and the role logs; nothing was stopped or re-run.

| suite | result |
|---|---|
| KVM r3 journal-durability | **22/22** |
| replica exactness | **8/8** |
| real-KVM composition | **4/6**, all four positive cases with real role + IPC + ReplicaNode + KVM r3 passed: |
| | test 1: declaration/binding |
| | test 3: complete reopen |
| | test 4: ADVANCED floors, normal open |
| | test 6: RECOVER with the signed high-water and a crash after ACK 3 |
| role suite | **16/19**: 1–12 pass (including B1, M4, the crash guard and rotation floors); 13, 14 and 15 fail |

## Failures and causes (evidence-based)
1. **Composition 2 (genesis resume) and 5 (rotate resume): wrong assertion layer.** The behaviour was correct:
   - the resumed genesis child sent exactly 2 writes (bridge, then reader);
   - the resumed rotate child sent exactly 1 (the final reader).
   
   The stand-in records acks at the committer, which receives the adapter-mapped canonical **relative** names (`bridge/anchor-journal.json`, `reader/derived-state.json`): the IPC wire contract. The test expected KVM's absolute RAM paths.
   - **r7:** the stand-in also records KVM's own commit calls at the KVM→adapter boundary (`kvm-commit`, absolute canonical paths). Both layers are asserted with exact order and count: KVM `[abs BR, abs RD]` / wire `[BR, RD]` for genesis, and KVM `[abs RD]` / wire `[RD]` for rotate.
2. **Role 13 (B2): test design.**
   - **The role behaved correctly:** member 2's log shows "derived start refused: the committed view changed while starting" after it lost its term.
   - **Why the test then hung:** the earlier failover test STOPPED member 0. With the primary partitioned, only 1 of 3 members was reachable, so no successor can be elected, and the test waited 60 s for "another primary with derived".
   - **Why it cascaded:** it never healed, so 14 (M3) and 15 (in-flight) failed with "timed out waiting for a primary with its relay".
   - **r7, with the group the earlier tests leave:** assert the stale term composes and seeds nothing (anchor journal and descriptor inodes unchanged), and that no other primary exists without a majority. Then **always heal in `finally`**, and require the healed group's primary to seed exactly its committed scan, with every live member agreeing.
3. **Role 15 (in-flight):** not reached in r6 (cascade).
   - **r7 hardening:** the child is killed only once the role has demonstrably written the bytes and awaits the delayed majority round. The commit is provably in flight.

## What r7 changes (and what it does not)
**Stage:** `accepted-image-enrollment-stage/r7/`, `SHA256SUMS` sha256 **0daca3cfc59ccb56e1c7444ea4e45808838354640437488a295ca1839fe2da12**.

| file | sha256 |
|---|---|
| `patches/accepted-image-enrollment-r7-vs-r6.patch` | `76d8f232…` |
| `jobs/root-accepted-image-enrollment-r7.sh` | `61e0d239…` |

- **Tree:** **`1cc32f1c9ce6fd5eeb16808c08f77568f17c3e3a`** = r6 `e72ebae2` + 2 test files, reproduced from the full chain in a clean repo.
- **Left alone:** r6 (`fbbc2136…`) is unchanged; root 1447's verdict, TAPs and role logs are copied into `r7/inputs/root-1447/`.
- **No runtime change:** the B1/B2/M1–M4 fixes from r5, the role, replica, adapter and KVM r3 are identical. No floor rule is loosened, no case is skipped, and no current authority is claimed.
- **Counts unchanged:** slice = KVM unit 22, composition 6, replica 8, role 19; check also KVM 65 + native and the rest.
- **The job** never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP. The role and stand-in logs go to the run's `$L` through `AIE_ROLE_LOG_DIR`.

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh aie-enroll7-slice  256 unshare -Urnm bash accepted-image-enrollment-stage/r7/jobs/root-accepted-image-enrollment-r7.sh slice
```

## Still open
- **The never-enrolled restored group's admin recovery path** is still required; there is a strict refusal today.
- **Writer authority** stays refused under the fixed 120 s ceiling.
- **Co-located replicas** are not a quorum.
- **There is no live reader start and no SNP.**
