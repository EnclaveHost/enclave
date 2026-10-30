# Enrollment security fixes r2: B1/B3/B4/B5, paths, deadlines, outcome semantics, no-downgrade (PREPARED; not run by Claude)

**Stage:** `accepted-image-enrollment-stage/r2/`, `SHA256SUMS` sha256 **5ffc76a53a045c1bb5972568cf341acc6f3c5084df0acc3f287e9fa5715d9344**. r1 is untouched and still verifies (`ccee4c59…`).

| file | sha256 |
|---|---|
| `patches/accepted-image-enrollment-r2-vs-r1.patch` | `876a3daa…` |
| `jobs/root-accepted-image-enrollment-r2.sh` | `9013bd8b…` |
| `jobs/kvm-overlay.py` | `526a6c5c…` |
| `proposed/derived-reader-runtime.exports.patch` | `8cf8e1cf…` |

- **Tree:** **`d9a7002530afc3c1dcb6e6682f58004ed33ee20e`** = r1 `583f2d7c` + the patch. I reproduced it from r4 + every frozen patch in a clean temporary repo.
- **Not done:** no tests, builds, queue, SSH, network, live actions or commits; only `node --check`, `bash -n`, `py_compile` and tree reproduction. The 4096 MiB retention lane was not touched.
- **Contract:** `logs/derived-state-ipc-contract-r2.md`, written first and also in `inputs/`.
- **Left alone:** KVM-owned modules.

## What changed, by finding
- **B1: seed only the exact, freshly majority-committed bytes.**
  - **One role-wide lock** (`withDerivedLock`) orders every relay start, every `derived-commit`/`derived-enroll-verify` from any child (old or new), and every enrollment. The per-child `busy` flag is gone.
  - **A queued request** from a child that is no longer current is refused **without writing** (`not_current_child`).
  - **`freshCommittedScan()`:**
    - **what it does:** `node.commit({heartbeat:true})` always runs a majority round;
    - **what it requires:** `true`, the same epoch, still primary, and a valid lease;
    - **what it yields:** a copy of `node.index`, i.e. that round's committed scan.
  - **`readState(dataDir, scan)`:** every `derived-authority/*` file must be in the scan with exactly the local bytes, and no local file may be outside it. **Otherwise refuse; nothing is repaired.**
  - **Gate, seed, provider answer and enrollment** all use it. The start re-reads right before seeding, under the same epoch.
  - **The seed** wipes the RAM `journalDir` (including KVM's local `.enrollment-inflight` marker and any pending copy) and the RAM anchor journal, then writes **only** the committed bytes.
  - **Unknown outcomes:** a failed or timed-out write stays local, and the next fresh round may commit it. It is then majority-held and seeded. Nothing assumes it absent; tested.
- **B3: enrollment quiesces the writer under the same lock.**
  1. Signature first (outside the lock, so non-admins stop nothing).
  2. Stop the relay.
  3. Fresh committed scan, then the rules.
  4. Re-verify the held signature.
  5. **Re-read the committed view right before recording** (`state_changed` otherwise).
  6. Write, commit, and require the record's sha in the committed scan of the same epoch.
  7. The relay restarts after the lock: with the new enrollment after durable success, unchanged after a refusal.
  
  An unknown outcome answers `503 outcome_unknown`; the member has stepped down, and the record may still commit.
- **B4: floors.**
  - **`rotate`:** `floorDigest` must be the committed bridge floor's (`wrong_floor`).
  - **`recover` (enrolled):** `highWater` must be ≥ BOTH committed restored floors (bridge `authorityAnchors[8453]` and the reader journal's `floor`), **component-wise per chain**, with an exact block (hash, stateRoot, Base outputRoot) on an equal number (`high_water_below_restored`).
  - **`recover` (never enrolled):** only with no restored derived state.
  - **Future dating:** `at ≤ now + 24 h`.
  - **Still no reset.**
- **B5: exact runtime declaration.** `declaresDerivedStateApi(runtime)` requires `DERIVED_STATE_API === "enclave-derived-state/v1"` **and** `enrollDerivedState`, `derivedReaderBinding`, `openLifecycleJournal` and `startDerivedLifecycleReader`. Otherwise `null`, nothing is started, and writer authority is refused.
  - **Who declares it:** the relay-side runtime module (role composition, per the 15:08 note), only together with a frozen KVM closure: `proposed/derived-reader-runtime.exports.patch`. That patch is **not** in the tree; the job's `kvm-check` mode applies it.
- **Paths:**
  - exactly two durable names (`reader/derived-state.json`, `bridge/anchor-journal.json`) at the client, the role and `readState`;
  - `journalNameMapper` accepts only the two **canonical absolute** RAM paths KVM passes, and rejects relative paths, traversal, foreign files, and a symlinked file or parent before any IPC;
  - the descriptor's paths must be those;
  - **`config.stateDir` is deleted** with the split `journalDir`/`coverageDir`/`runsDir`;
  - `enrollDerivedState(config, {anchorJournal, verifyEnrollment, commit, commitTimeoutMs})` follows the 15:08 freeze.
- **Deadlines and outcome semantics:**
  - **Deadline:** requests carry `timeoutMs`. The role writes nothing once `receipt + timeoutMs − 250 ms` has passed (`deadline`, refused).
  - **Replies:** `outcome:"refused"` means definitely not written; `outcome:"unknown"` means written, possibly committed later.
  - **Client codes:** `derived_commit_refused` vs `derived_commit_outcome_unknown` (which covers role-unknown, deadline, abort in flight and channel loss). Every failure fences.
- **No-authority downgrade defense:**
  - The role sets the role-only `ENCLAVE_DERIVED_INTENDED=1` whenever `derivedReader` is bound, enrolled or not. It is refused in `relayEnv` and dropped from credentials.
  - `relay/api-relay.js`: with it, **no public-RPC lease reader is built**, and writer authority is `refusingWriterAuthority("writer_authority_unproven")` whenever derived is `null`, **independent of `RELAY_CHAIN`**. A log line names it.
- **Crash guard:** also disables derived on an unexpected exit within `derivedStableMs` (default 60 s) **after** serving, not only before.
- **Unchanged:** admin signatures and controls, no reset, the fixed 120 s writer ceiling, the 16 GiB floor, native v3 and the finalized-only derivation.

## Tests and harness
**`test/derived-state-enrollment.test.mjs`** has 14 tests: real `startRole` ×3, real `ReplicaNode` with partition/delay, real viem admin signatures, and real child IPC with a stand-in child running the real client. New coverage:
- **unenrolled start:** only the `INTENDED` marker is given;
- **refusals:** future dating; role-side deadline refusal; the exact name set; refused vs unknown codes;
- **committed-scan seeding:** a local-only write becomes committed by the fresh round and is then seeded; a foreign local file refuses until removed;
- **crash guard:** before and soon after serving;
- **rotate:** bound to the committed floor;
- **enrollment vs a racing commit:** exactly one wins, judged by the committed bytes;
- **recover:** per-chain high-water cases;
- **adapter:** an exact declaration, missing pieces giving `null`, `stateDir` deleted, canonical path mapping including symlinks.

**`jobs/root-accepted-image-enrollment-r2.sh`** is the r1 strict harness on `d9a70025`, plus:
- the 14-test count;
- `api-relay.js` among the regenerated-bundle inputs;
- **a fifth real relay startup:** `ENCLAVE_DERIVED_INTENDED=1` keeps serving (rc 124 at 20 s) and logs the refusal, with no fatal;
- **`kvm-check KVM_DIR SUMS_SHA256`:**
  - overlays a **frozen** KVM closure (`KVM_DIR/tree/<path>`, KVM-owned paths only, no symlinks or `..`, its SUMS pinned) and the proposed declaration;
  - requires the **built** runtime to declare the exact API;
  - runs the closure's own tests strictly;
  - then everything else.
  
  Without a closure, the verdict states the derived path is **NOT qualified**. Stand-in tests are never qualification of the reader path.

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh aie-enroll2-check 2560 unshare -Urnm bash accepted-image-enrollment-stage/r2/jobs/root-accepted-image-enrollment-r2.sh check
bash jobs/q-exit-status.sh aie-enroll2-kvm   2560 unshare -Urnm bash accepted-image-enrollment-stage/r2/jobs/root-accepted-image-enrollment-r2.sh kvm-check <KVM_DIR> <SUMS_SHA256>
```

**Unrun-risk notes:**
- **Timing:** the suite uses `leaseMs` 2000, `derivedStableMs` 1000 (planned restarts wait 1.2 s), and a 250 ms transport delay for the client-deadline case (400 ms client timeout, a ~500 ms round).
- **The racing-enrollment test** accepts either order and asserts the invariant.

## Unresolved blockers (plain)
1. **B2, partial genesis (KVM-owned; not done here).**
   - **The problem:** two separate durable commits. If only one commits, the next `enrollDerivedState` refuses forever.
   - **Requested from the KVM owner:** ONLY exact authenticated same-genesis deterministic committed-subset recovery (divergent, advanced or foreign refused), or a true crash-consistent batch plus manifest.
   - **Today's role behaviour:** the descriptor and provider answer list exactly the committed files and their sha256 (`priorFiles`). A partial genesis leaves derived disabled and the relay serving with writer authority refused.
   - **If KVM picks the batch:** the role needs a batch IPC message; it is **not invented** here and will match KVM's frozen callback.
2. **Rotate/recover runtime (KVM-owned, required).** KVM's first revision refuses them. The role's rotate/recover rules are fail-closed guards, **not completion**. Full rollout needs the carry-floor composition implemented by KVM and covered by `kvm-check` with tests that exercise it.
3. **The exact KVM export module paths.** The proposed declaration assumes `network/derived-reader/provider.mjs`. If the closure differs, `kvm-check` stops at that patch and says so. It is a one-line change, which needs root's note to name the module.
4. **Same-host replicas** are not a quorum; durability is crash-fault over the configured members.
5. **Writer authority:** with L1-finalized anchors, writes stay `stale_snapshot` under the fixed 120 s ceiling. Enrollment and transport are necessary, not sufficient.

## Resumable next work
- **When KVM's frozen closure exists:** stage it as `KVM_DIR/{SHA256SUMS, tree/…}` and run `kvm-check`. If its exports live elsewhere, update `proposed/derived-reader-runtime.exports.patch` (new stage).
- **If B2 resolves as a batch commit:** add `{t:"derived-commit-batch", files:[…]}` to the role and client (one majority round, per-file committed-scan sha check, same outcome semantics), plus tests.
- **Then:** the rotate/recover composition tests with KVM, image re-measurement, and SNP qualification (root).
