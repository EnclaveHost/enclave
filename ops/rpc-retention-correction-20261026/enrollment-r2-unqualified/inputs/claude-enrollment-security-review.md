# Read-only security/integration review: accepted-image-enrollment-stage (SUMS ccee4c59…, tree 583f2d7c)

**Method:** source reading only. I re-materialised tree `583f2d7c` in a private `/tmp` directory from the stage's own recipe (r4 `929fc19a` + r1/r2/r3 + the patch; every intermediate tree hash matched) so I could read code in context.

**Not done:** no edit, test, build, queue job, network access or commit. Nothing here is a test result.

**Line references:** tree `583f2d7c`. **role** = `metal/guest/platform-api-role.mjs`, **DS** = `metal/guest/derived-state.mjs`, **replica** = `relay/state-replica.mjs`, **client** = `relay/derived-state-commit.mjs`, **adapter** = `relay/derived-writer-authority.mjs`.

## Blockers (fix before tests)

### B1. A relay start seeds the LOCAL directory, not the committed bytes (role:221-229, DS:146-156)
- **What the code does:** `derivedPlan()` calls `DS.heldState(dataDir)`, which walks the **local** `data/derived-authority/state` (DS:47-59). `seedDerivedState` then copies those bytes into the reader's RAM copies.
- **Why that is wrong:** `derivedCommit` writes the file **before** `node.commit()` (role:297-298). So the local directory can hold bytes that were never majority-acknowledged:
  - an in-flight commit from the previous child, which keeps running after that child exits (it was checked at role:293-295, before the await);
  - a commit that failed with `not_committed`;
  - a commit that timed out on the client side.
- **This contradicts** the report's "re-seeds RAM working copies only from the committed copies".
- **Impact:** a new boot's reader starts from a journal record the previous writer was told failed (or never heard back about).
- **Minimal fix:**
  1. Serialise relay start behind derived commits: one role-level per-rel mutex across children, not `c.derived.busy` per child.
  2. Run `await node.commit()` (must be `true`, still leader, same epoch) before seeding.
  3. Seed only files whose local sha equals `node.index.get(state/<rel>).sha` from that committed scan. Refuse (stay unenrolled, with a reason) on any mismatch.

### B2. Partial seeding deadlocks: two separate commits with no atomic pair (adapter:298-299, client:54-63)
- **What happens:** first start calls `enrollDerivedState`, which per root's note seeds **both** small journals through `commit()`. That is two IPC requests, i.e. two `node.commit()` rounds.
- **The failure:** a crash, timeout or quorum loss between them leaves exactly one file committed. The next start calls `enrollDerivedState` again (adapter:298, because one file is missing), and KVM "refuses any existing file".
  - The relay then exits before listening, and the role disables derived for that digest (role:273).
  - A new `genesis` is refused (state exists, DS:101).
  - A `rotate` carries the partial state, which `enrollDerivedState` refuses again.
  - **Result: permanent writer-unproven, with no admin path.**
- **Minimal fix (either):**
  - **(a)** a batch IPC request `{files:[{file,bytes,sha256}…]}`: the role writes all files, then ONE `node.commit()`, then replies with every sha. KVM's `enrollDerivedState` uses it for the seed pair.
  - **(b)** KVM's `enrollDerivedState` accepts `priorFiles` that are exactly a subset of its own deterministic genesis seed, and completes it.
- Either way, the contract must state it.

### B3. Enrollment TOCTOU against concurrent derived commits (role:472-480)
- **The window:** `derivedEnrollOnce` reads `held` and runs `checkEnrollment`, which requires `pkg.stateDigest === held.stateDigest` (DS:98). Then it **awaits** `verifiedHeld` (role:479) before `writeEnrollment` and `node.commit()`.
- **The race:** a `derivedCommit` from the running child can change the state inside that window (and inside the commit await). The rotate or recover then records an approved `stateDigest` that is **not** the state it carries. KVM is then started on it (seeded from B1's local bytes).
- **Minimal fix:**
  - stop the relay, or take the per-rel mutex from B1 and refuse new derived commits, **before** reading `held`;
  - re-read `held` synchronously right before `writeEnrollment` and refuse on any digest change;
  - restart the relay only after the commit.

### B4. Rotate does not bind the floor, and recover is not compared with the restored floor (DS:104-116)
- **Rotate:** `floorDigest` is only checked as 64-hex (DS:92) and is not tied to the carried state. KVM compares it "exactly", but against what KVM computes. If KVM trusts the provider's floor digest, a rotate signed with an **older** floor lowers the floor.
  - **Fix:** in `checkEnrollment` for `rotate`, require `pkg.floorDigest === floorDigestOf(bridgeFloor(dataDir))`, i.e. the committed floor of the carried state (DS:183-185).
- **Recover:** `highWater` is only shape-checked (`validAnchor`, DS:66-70). It is never compared with the restored archive's floor, so a high-water **below** the archive's own floor is accepted.
  - **Fix:** require `bridgeFloor(dataDir)` (the restored state) ≤ `highWater`, compared **component-wise per chain**:
    - `base.number` ≤ and `l1.number` ≤;
    - where a number is equal, `hash`, `stateRoot` and `outputRoot` must be identical;
    - never a lexicographic or single-field comparison.
  - **KVM must** also refuse to serve anchors below `highWater` (root note: "recover at ≥ highWater", pending).
- **Note:** neither check is a substitute for KVM's binding. Both are cheap role-side fail-closed guards.

### B5. The adapter gates the whole new API on ONE function name (adapter:284-301)
- **The gap:** the runtime's durable-state API is accepted if `typeof runtime.enrollDerivedState === "function"`. The adapter defines `DERIVED_STATE_API = "enclave-derived-state/v1"` as "the durable-state API a network runtime must declare" (adapter:35-36), but **never checks that the runtime declares it**.
- **Impact:** a runtime that has `enrollDerivedState` but whose `openLifecycleJournal`/`startDerivedLifecycleReader` ignore unknown `{commit, requireCommit, journalCommit, requireJournalCommit}` options would write **unreplicated** journals while the relay presents derived authority.
- **Also:** root's note names `startDerivedReader(config, options)`, while the adapter calls `startDerivedLifecycleReader` (adapter:269, 301). It passes `anchorJournal` (adapter:299), which is not in the note's signature.
- **Minimal fix:** require an exact runtime declaration (e.g. `runtime.DERIVED_STATE_API === "enclave-derived-state/v1"` plus the frozen function names) before handing over `ENCLAVE_DERIVED_STATE`; otherwise return `null`. Freeze the names and options with KVM.

## Point 1: what the acknowledgement actually proves (role:285-305, replica:332-360)
**What it proves:**
- `ok` is `true` only from `_commitOnce`, i.e. a majority acknowledged exactly the sent head. On that path `node.index = scan` happens only after the majority (replica:358).
- Or `!moved`: the directory equals the last acknowledged scan, then `leaseValid()` (replica:341).
- Reading `node.index.get(rel)` right after the await is the committed scan's entry for that rel. The local re-read sha and the leader/epoch check (role:299-302) bind the reply to those bytes.
- **Under a single writer per rel, the ack is sound.**

**What it does not cover:**
- **Single writer per rel is not enforced across children.** `busy` is per child (role:291-292), so an old child's in-flight write and a new child's write can interleave. The `bytes_changed` refusal (role:302) catches it only for the request it hits.
- **Snapshot catch-up reads current bytes, not the scanned bytes:** `readAll(this.dir, scan)` runs **after** an await (replica:346). A lagging member can therefore be sent a newer, never-acknowledged file under an older acknowledged head. On a tie election it may be adopted.
  - This is a pre-existing replica property.
  - With B1 fixed it only means "a failed/timeout commit's outcome is unknown and may later appear".
  - **KVM's contract must say exactly that**: `journalCommit` false or timeout means **unknown**, never "absent". The report says this ("may be adopted"), but the commit API should name it, e.g. error `outcome_unknown`.
- **Cleaner API (optional):** have `ReplicaNode.commit()` resolve `{ok, head, scan}` and compare `scan.get(rel).sha`, rather than reading shared mutable `node.index`.

**Scenario coverage (by code):**

| Scenario | Behaviour |
|---|---|
| Quorum loss | `commit` false, then step-down, then `not_committed` (role:299) |
| Role failover mid-request | `epoch_changed` / `not_primary` |
| Late ack | client `late++`, never resolves (client:30) |
| Restart | new random boot; old-boot replies refused (client:32) |
| Timeout | client fences (client:42); the role keeps writing (no deadline is sent) |

**Missing:** a role-side deadline. Send `deadlineMs` in the request and have the role refuse to start the write past it. Then a fenced client's request does not land later "for nobody", or at least the window is bounded.

## Point 2: signed enrollment, archives, no reseed, path allowlist
**OK:**
- the EIP-191 admin signature over the whole package, re-verified at each start and cached by digest (role:212-217);
- the exact field set (DS:88-89);
- `at` strictly increasing (DS:96) and the `previousDigest` chain (DS:97);
- genesis only on an empty group, with the null floor (DS:100-103);
- rotate needs an enrollment and can never clear a restore marker (DS:104-109);
- recover only with the current marker (DS:110-111);
- a restore writes a marker whenever `derivedReader` is bound or the archive held derived files (role:438-440);
- corrupt or unreadable held state refuses both the gate and enrollment (DS:93, 125), with **no automatic reseed**, and an unverifiable held record is never replaced (role:479).

**Findings:**
- the floor/high-water monotonicity gaps (B4);
- a future-dated `at` freezes enrollment until an admin signs a larger one (low; a bound such as `at ≤ now + 1 day` would help);
- recover of a never-enrolled group accepts `highWater: null` (DS:113). That is correct only if no derived state is present in the restored archive: also require `held.stateDigest === null` in that branch;
- `derivedDisabled` is in memory, so the crash guard resets on a role restart (low; it bounds a loop only per process life).

**Path allowlist:** `STATE_REL` (DS:26 = client:16) is pattern-based (`reader|bridge/<[a-z0-9][a-z0-9.-]{0,63}>.json`, ≤ 8 files), with no traversal possible. `ramPathOf` (DS:136-140) maps `bridge/anchor-journal.json` to the image `roleEnv` path and others under `journal/`.
- **Recommendation:** when KVM freezes its file names, replace the pattern with the exact set (the 2 seed files plus the named reader files). Then a KVM rename cannot create orphans, which the gate (DS:131) would treat as "unexpected" only beyond 8 files.

## Point 3: absent runtime / unenrolled means writer unproven, NOT public RPC (traced on the real start path)
- **The real path:** `relay/api-relay.js:2527-2546`.
  - `derivedWriterAuthorityFromEnv` returns `null` when the source env is unset (the unenrolled gate gives the relay no derived names; adapter:260-261) or when the runtime lacks the API (adapter:284-287).
  - The selection is then `derivedWriterAuthority || leaseGenerationReader || (RELAY_CHAIN ? refusingWriterAuthority("writer_authority_unproven") : null)`.
  - `leaseGenerationReader` (the public-RPC quorum) exists **only when `!RELAY_CHAIN`** (api-relay:2542-2543).
- **The binding:** `platformApi.derivedReader` may be bound only with `ENCLAVE_CHAIN_AUTHORITY=verifier` (`metal/guest/measured-control.mjs:404`). `relayChildEnv` strips provider settings under the bound verifier (role:59-78).
  - So for an image with `derivedReader` bound, `RELAY_CHAIN` is set, and `null` gives **`refusingWriterAuthority`**.
  - The relay serves its other features, writes carry `facts.runner` only, and there is **no downgrade to public RPC**.
- **Residual:**
  - **Indirect guarantee.** It holds only through config validation plus that one expression. Defence in depth: when the role intended derived (e.g. a role-set marker env such as `ENCLAVE_DERIVED_INTENDED=1`, refused in `relayEnv`), api-relay should force the refusing authority if derived is `null`, regardless of `RELAY_CHAIN`.
  - **Crash guard.** It covers only exits **before** listening (role:273). A derived reader that dies after listening (e.g. fatal on a fenced committer) gets the normal restart backoff, not a disable. Confirm KVM surfaces fencing as per-request refusals, not a process exit, or extend the guard to derived-attributed exits.

## Point 4: KVM API and IPC alignment
- **Same channel, no new port.** The client uses Node's per-child IPC (`stdio 'ipc'`), the same channel as the existing `barrier` messages. It correlates by `t` + `boot` + `id` (one id space shared by commit and verify, strictly increasing; role:291, 314). No external port is added.
- **Matches root's 14:49 note:**
  - `journalCommit({file, bytes, sha256, signal})` gives exactly `true` (client:54-63);
  - abort before send rejects without fencing; abort in flight fences as "outcome unknown" (client:39-45);
  - serialized;
  - verify answers bind `binding` and `floorDigest` exactly (client:65-70, DS:192-199).
- **Mismatches:** B5 (declaration and names), and `anchorJournal` (an extra option).
- **Timeouts:** client 10 s = KVM `commitTimeoutMs` 10 s (adapter:38). Role-side replica asks run at `leaseMs/3` each (replica:137), but `node.commit()` is **serialized behind other commits** (barrier, heartbeat), so the role can exceed 10 s under load. That means a client fence, and an unknown outcome (safe, availability cost).
  - **Recommendation:** the role-side deadline in the request (point 1), and a documented relation `commitTimeoutMs > leaseMs`.

## Minimal fix list (for root/50; not implemented)
1. **B1:** a role-level per-rel commit mutex across children; seed only after a fresh `node.commit()`, and only files whose sha equals the committed scan.
2. **B2:** an atomic batch commit for the seed pair (or KVM resume of a partial deterministic seed), with the semantics in the contract.
3. **B3:** stop derived commits (or take the mutex) across enrollment; re-check `held` right before the write.
4. **B4:** rotate `floorDigest` = the committed floor's digest; recover requires `restored floor ≤ highWater` per chain, component-wise, with exact equality on ties; a never-enrolled recover requires no state.
5. **B5:** an exact runtime API declaration and frozen function names before handing over the durable state; otherwise `null`.
6. **Outcome-unknown semantics:** make failure/timeout "outcome unknown" explicit in the IPC errors and the KVM contract; add a role-side request deadline.
7. **Defence in depth:** a role-intended-derived marker that forces the refusing authority; extend the crash guard to post-listen derived exits, or confirm KVM never exits on a fence.

**Unchanged and correct as designed:** the admin signature model, the no-reset rule, archives not treated as freshness, the verifier-only binding, the writer's fixed 120 s ceiling and the 16 GiB floor.
