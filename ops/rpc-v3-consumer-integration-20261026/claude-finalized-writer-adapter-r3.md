# Finalized writer adapter r3: frozen r2 qualified against KVM's COMMITTED reader 34a3c0d6d4c5 (job prepared, NOT run); derived writing stays NOT enabled

**Stage:** `finalized-writer-integration-stage/r3/`, `SHA256SUMS` **8ad043f4ab107bbfc8622eef9c3488508121404f27256103c220dc6b8d4a96ea**.

**Earlier stages, kept unmodified (re-verified):**
- r1 `beb4ec4a`, with failing runs tests-1/2 and the passing tests-3;
- r2 `fab96a8f`.

**Earlier reports kept:**
- `claude-finalized-writer-adapter.md` (r1);
- `-r2.md`.

**Not done:**
- no queue job was launched (root's paid job is running); the only checks run were parse-only `node --check`;
- no SSH, live access, commits or background children.

## What r3 is
**Code is unchanged.** r3 adds no new code: the adapter, tests and patch are r2's.
- `r2/patches/finalized-writer-adapter-r2.patch` (`eb804950…`, applies to **64156dcd**; the job pins its sha256 and runs `git apply --check`).
- That includes the **fixed 120 s ceiling with no override** (constructor, reader config and env), and the unsafe verifier as an additional deny-only check.

**What r3 changes is what the code is qualified against:** KVM's **committed** reader **34a3c0d6d4c5aebffffb2492437487c9de74fb66** ("Add native v3 lease coverage journal and snapshot-bound log reads"), instead of its mutable working tree.

**Re-pin result:**
- The 5 inputs r1/r2 were tested on are **byte-identical** to the 34a3 blobs:
  - `coverage.mjs` `d3e88df6…`;
  - `coverage-store.mjs` `3a44e5dd…`;
  - `journal.mjs`, `lease-release-journal.mjs` and `runtime-lock.mjs`.
- So `r3/KVM-INPUTS.sha256` equals r1's.
- The job now checks them against the **commit export**, not the working tree.

| r3 file | sha256 |
|---|---|
| `KVM-34a3-CLOSURE.blobs` (26 git blob ids: `network/derived-reader/**`, `lifecycle-finality-bridge.mjs`, `deployment-lifecycle-journal.mjs`, `deployment-restart-policy.mjs` at 34a3) | `4aab99d1…` |
| `KVM-INPUTS.sha256` | `bffcb1c2…` |
| `jobs/adapter-tests-r3.sh` (ROOT job) | `7f7e51c5…` |
| `jobs/api-composition-check.mjs` | `2e2ddcff…` |

## The ROOT job (run after the paid job; foreground, 512 MiB, offline)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
jobs/q-exit-status.sh <name> 512 unshare -Urn bash finalized-writer-integration-stage/r3/jobs/adapter-tests-r3.sh
```
**Steps:**
1. **Frozen pins:** r1 SUMS = `beb4ec4a`; r2 SUMS = `fab96a8f`; the r3 SUMS; the r2 patch = `eb804950`.
2. **The commit:**
   - KVM commit 34a3 is present;
   - its `ls-tree` for the reader closure equals `KVM-34a3-CLOSURE.blobs`.
3. **Private copy:** `git archive` of 64156dcd (the whole tree, checked with `tar -d`), plus the candidate's generated relay bundle and the compiled ABIs (shas recorded). Then the r2 patch is applied.
4. **Minimal closure:**
   - the 34a3 reader closure is exported **from commit blobs** as pure additions (the job refuses if a path already exists);
   - every base module it imports (`verified-chain`, `gossip-head-source`, `rpc-runtime`, `lease-release-journal`, `runtime-lock`, `package.json`, `package-lock.json`) must be **blob-identical** in 64156dcd and 34a3 (verified now: all identical);
   - `KVM-INPUTS.sha256` is checked on the exported files;
   - no unrelated c66/34a3 files and no contracts are included.
5. **`node --check`** of the patched `api-relay.js`.
6. **Exactly 23 tests:**
   - 16 adapter tests with fakes (including the 120 s boundary, the +5 s future limit, and the refused override attempts);
   - 2 ABI tests;
   - 5 tests over the **committed** coverage validator and store (imported from the composed copy).
   The result requires `tests == 23 == pass`, with no fail, skip or cancel.
7. **API composition check** (`api-composition-check.mjs`; separate from the 23, and must exit 0):
   - the committed `lifecycle.startDerivedLifecycleReader`;
   - `openLifecycleJournal(...)` with `readAnchor`/`acceptAnchor`;
   - the provider's `createDerivedProvider`/`startDerivedReader` and `readDerivedLogs`;
   - the v3 build pin = root's native v3 binary **49f4d7e3…**;
   - **the relay selector driven into the committed `startDerivedLifecycleReader`**: refused by KVM's own native-pin check (`no qualified native derivation build configured`) with **no state created**;
   - the writer's 120 s ceiling is independent of the reader config's 1800 s bridge bound.
8. **5 real `api-relay.js` startup checks:** `no-verifier`, `bad-value`, `url-config` and `not-composed` (64156dcd's generated bundle has no reader export), plus the unset positive control. The result requires exactly 5 OK.
9. `result.json` gets `{stage:"r3", kvmCommit, counts, apiCompositionRc, startupOk}`. The private copy is removed; every receipt stays in `r3/runs/run-*`.

**Expected:** **23/23 tests, 5/5 startup checks, API check rc 0.**

## Lock re-entry (the earlier open question)
Resolved at **fixture-integration level**. KVM's committed tests (33, including the full provider plus store, and a bridge callback doing [B,B] then the wide range) show that `readDerivedLogs` inside the snapshot callback does not re-enter the provider's lock. That is exactly the adapter's call pattern, documented in the committed `COVERAGE.md`. The committed `COVERAGE.md` also documents the `filter` echo with `fromBlock`/`toBlock`, which the adapter accepts only when equal. **This is not a mainnet proof**, and r3 does not itself re-run KVM's 33 tests; they are KVM's and root's reader qualification.

## Still NOT enabled, and why
- **Finalized freshness cannot meet 120 s.** Finality alone takes about 12.8 min, so with a finalized anchor `ENCLAVE_WRITER_AUTHORITY_SOURCE=derived` refuses every release as `stale_snapshot`. **Activation stays blocked.** No wider default exists or is added.
- **The SAFE (signed optimistic L1) tier is KVM's to assess, and was not implemented here.** It would still have to pass the same 120 s check, after measurement and the user's policy decisions (r2 report).
- **No mainnet, witness or SNP proof is claimed.** The coverage in the 5 store tests is fixture data.
- **Remaining gates:**
  - root's reader composition (provided separately) plus a regenerated relay bundle exporting `startDerivedLifecycleReader`/`openLifecycleJournal`/`serveDerivedReader` (until then the real entrypoint refuses with `not composed`);
  - a real v3 witness run;
  - a freshness path that satisfies 120 s;
  - root activation.
- **Unchanged:**
  - custody's 120 s guard;
  - admin controls;
  - the pre-bootstrap refusal (no automatic re-claim);
  - no public fallback counts toward completion.
