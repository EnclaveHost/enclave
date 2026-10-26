# Accepted-image endpoints r3: the r2 fixture bug fixed, plus a strict r4-style release harness (PREPARED; not run by Claude)

**Stage:** `accepted-image-assets-stage/r3/`. `SHA256SUMS` sha256 is **3e20951705c683477b821bd3cffe8f53117150f6bdbe55545851a96badd0d14d**.

| file | sha256 |
|---|---|
| `patches/accepted-image-assets-r3-vs-r2.patch` | `522b3bd0…` |
| `jobs/root-accepted-image-endpoints-r3.sh` | `c59cf1af…` |
| `jobs/unenrolled-startup-config.mjs` | `9f26069e…` |
| `PROVENANCE.md` | `8cedb17c…` |

- **Root 1366 evidence:** in `inputs/root-1366/`.
- **Not done:** no tests, builds, queue, SSH, network, live actions or commits. I ran only `bash -n`, `node --check` and tree computation in a scratch repo.
- **Left alone:** r1 (`2210…`), r2 (`be7ba0cf…`), r4 and KVM.

## What 1366 showed, and the fix
- **The endpoint test failure (5/6):**
  - **Cause:** a fixture bug. `canonicalDirectConfig` returns a **deep-frozen** config, and test 4 assigned `cfg.platformApi.derivedReader` on it. The result was a `TypeError`, not the role's refusal.
  - **Fix:** the r3 patch forges on `structuredClone(CFG())` and asserts that the canonical object is frozen.
  - **Scope:** this is the only change. **Tree `59e112516acdb77040687a03729fa2b808ecbe00`** = r2 `c0a5f4e4` + that 1-file patch. Source, role, installer, template and record are unchanged.
- **Overlay:** 25/25 passed with the real inputs.
- **Platform suites timed out:** they wait for "a primary running the relay", and the harness never built `relay/network-runtime.bundle.mjs`.
  - That is a **harness gap**, not a pass. Nothing here counts it as one, or as equal to the baseline.
  - The r3 harness builds the release exactly in r4's qualified order.

## Root harness: `jobs/root-accepted-image-endpoints-r3.sh`
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh aie-r3-check 2560 unshare -Urnm bash accepted-image-assets-stage/r3/jobs/root-accepted-image-endpoints-r3.sh check
# only after check verdict ok:
bash jobs/q-exit-status.sh aie-r3-image 1024 unshare -Urnm bash accepted-image-assets-stage/r3/jobs/root-accepted-image-endpoints-r3.sh image <CHECK_RUN_DIR> <verified BASE> <new OUT>
```
**Limits:**
- **Memory:** 2560 MiB matches r4's relay mode. The queue keeps the 16 GiB floor.
- **Time:** every step has its own `timeout`, and the whole run has a 7200 s budget (`AIE_R3_BUDGET_SEC`).
- **Order:** sequential, with `--test-concurrency=1`.
- **Isolation:** a private user/net/mount namespace. It refuses if any route is present or the mount namespace is not private.

**`check`, in order (any failure stops with `## INVALID`, rc 9):**
1. **Frozen inputs:** the r3 SUMS, then r2 `be7ba0cf`, r1 `2210d3e3` and r4 `afd35070`, each pinned and its files re-verified. r4 `FINAL-TREE` must be `929fc19a`.
2. **Composition:** r4 → r1 (`5052bd58`) → r2 (`c0a5f4e4`) → r3 (**`59e11251`**), each with `git add -f -A` in the private export. The source commit is made here.
3. **Reader inputs and checkpoint:**
   - the reader inputs (root 1361's) are hashed against the committed record;
   - KVM's `readCheckpoint` must still accept the checkpoint. **After 2026-11-01T19:21:59Z it refuses, and so does the job.**
4. **Strict r4 layout:**
   - the clean `64156dcd` dependency tree, lock `9ada1611`, viem 2.53.1 and anvil `10c1c727`;
   - root, `network` and `relay` `node_modules` **bind-mounted read-only**, with locks equal.
5. **Builds, in r4 release order:**
   - `relay/build-network.mjs`: **the shared runtime must equal pin `e12c5baf`**;
   - `build-derived-reader-runtime.mjs`: `schedule_reader.mjs` must equal pin `688b7a1f`;
   - the platform-api guest bundle: `--check` before (recorded), then **regenerated**, then `--check` after, which must be rc 0.
   - The regenerated manifest must carry **this tree's `platform-api-role.mjs` digest**, and its sidecar digests must equal the built `derived-reader-runtime.bundle.mjs` and `schedule_reader.mjs`.
6. **Private release commit:**
   - It is the source commit plus **exactly** the 7 generated files. The tracked guest bundle pair is regenerated; the gitignored derived sidecars and network runtime are force-added.
   - The builds may change no other tracked file. The diff must equal that list.
   - It is preserved as `release.git` with `RELEASE.sha256`. This matters because the overlay installs the bundle **and its sidecars from the commit**.
7. **Tests, each STRICTLY clean** (rc 0, pass = tests, 0 fail/skip/todo/cancelled). There is no baseline-equivalence path.
   - endpoints **6**;
   - overlay **25** (6 derived-reader), with the real reader and chain-verifier inputs, on the release commit;
   - platform-api-config;
   - integration, with r4's inputs: writer **23**, relay reader **4**, KVM **33**;
   - **relay startup, 4 cases.** r4's three writer refusals, plus a new case:
     - **unenrolled:** the stage helper runs the ROLE's `composeDerivedReader`. It uses the bound `10.0.2.2` endpoints and the committed template and record, with the image paths pointed at the verified pinned inputs.
     - The **real `api-relay.js`** must then exit 1 with `fatal: writer authority: … explicit enrollment/recovery required` (KVM `openDerivedJournal`, `initializeState:false`).
     - **No** `derived-state.json`, coverage, `runs/` or anchor journal may appear afterwards. KVM's lock file is never unlinked by design and holds no state.
   - relay group, with r4's reviewed artifact set: native-relay-chain-authority **8**, relay-chain-consumers **10**, and platform-api admin-cli, admin-status, forward, handoff-production, hosted, native-issuer, registry and replica.
8. **Verdict:** `verdict.json` with `ok` and a scope line. It is offline only: **no chain read, no SNP measurement or qualification, no activation.**

**`image CHECK_RUN BASE OUT`:**
- **Preconditions:** the check verdict must be ok, made with the same stage bytes. The release commit must be source `59e11251` plus the generated files.
- **Overlay:** `overlay-control-image.py --control direct` over root's verified BASE, from that release commit, with the real chain-verifier and reader inputs.
- **Requirements:**
  - the manifest commit is the release commit;
  - `platformApiBundle.sha256` is the regenerated bundle;
  - both derived sidecars are installed;
  - `derivedReader.roleEnv` and `chainVerifier` are present.
- **No measurement is accepted.**

**Caveat (unrun):** the unenrolled startup case assumes the relay reaches KVM's journal before any other refusal. The order I read in the source is:
1. the verifier/path checks;
2. `loadRuntime`;
3. `startDerivedReader`: state directory (mkdir and private check), `readCheckpoint`, binding;
4. `openDerivedJournal`.

If root sees a different fatal message, that case is reported as FAIL with its log, and not reinterpreted.

## State: what exists, what does not, and the exact remaining interfaces
**What I do not claim:**
- RAM state with `initializeState:false` **cannot cold boot**. After every guest boot the reader refuses ("derived journal missing; explicit enrollment/recovery required"); the new startup case tests exactly that.
- **Same-host replicas prove no quorum.** The platform-api group checks distinct operator addresses and URLs, which does not prove physically independent hosts.

**What the reader and writer keep today (source):**
- **KVM reader `stateDir`** (one directory, 0700, owner-only):
  - `derived-state.json`: `enclave-derived-root-journal/v1`, ≤ 256 KiB, a hash-chained floor, ≤ 128 entries.
  - Its `binding` = sha256 of {chain 8453, native sha, native/L1 runtime builds, L1 sha, **checkpoint digest**, A1 policy, interval, resultVersion, historyMaximumBytes}.
  - It is created only with `initialize:true`. It is a rollback floor and audit trail, never proof: every start re-derives from a freshly authenticated ASR bootstrap.
  - `coverage/` (`enclave-derived-coverage-journal/v1`, up to `historyMaximumBytes` = 4 GiB) also refuses when missing without `initialize`, and `runs/` follows.
- **Writer `ENCLAVE_DERIVED_ANCHOR_JOURNAL`** (`network/deployment-lifecycle-journal.mjs` `openLifecycleJournal`):
  - **A missing file silently starts empty.** Its `authorityAnchors` monotonic floor is therefore only as durable as its storage. In RAM it resets at reboot.
  - It cannot grant anything while KVM refuses, but it is a rollback hole once enrollment exists.
- **Platform-api replicated state** (`relay/state-replica.mjs` `ReplicaNode`, the role's `dataDir`):
  - majority commits with epoch/promise ordering;
  - the role's response barrier;
  - sealed archives to `platformApi.archives`, with the key escrowed to the admin recovery keys (`recoveryEnvelope`/`openRecovery`);
  - admin-signed bootstrap (genesis, import or recovery) through `scripts/platform-api-admin.mjs`.
  - This is the **existing explicit-owner enrollment/recovery provider**. Its message limit is 64 MiB.

**Exact missing interfaces (none implemented here):**
1. **KVM state split.** `startDerivedReader` needs separate `journalDir` (`derived-state.json` + lock) and `coverageDir`/`runs`.
   - The journal (small, rollback-critical) can then live in the replicated `dataDir`, while the coverage cache stays in RAM.
   - Coverage may be re-initialized on a cold start, because restarted coverage grants nothing (KVM test 20). Today one `stateDir` and one `initialize` flag couple them.
2. **Durable-accept hook.** `openDerivedJournal(dir, { binding, commit })` and `openLifecycleJournal(file, { commit, requireExisting })` would be the new option names.
   - `accept`/`acceptAnchor` must not succeed until the **replica majority commit** returns true. On false or throw, the journal fences, as it already does on a failed write.
   - `requireExisting` closes the silent-empty lifecycle journal.
3. **Enrollment record.** A new `enclave-derived-reader-enrollment/v1` record:
   - **contents:** {groupId, binding, floor anchor (`validateAnchor` shape) or null = "re-derive from the authenticated ASR bootstrap", lifecycle anchor for 8453 or null, checkpoint digest, at, nonce};
   - **signed** by `platformApi.admins` (the `packageSigner` pattern) and committed into the replicated `dataDir` by the leader;
   - **materialized by the role** into `{format, binding, floor, entries: []}` **only from a verified record**. KVM still opens it with `initialize:false`, and its existing validation accepts a floor with no entries. There is no silent initialization.
4. **Full-group cold boot / recovery.** If every member reboots, the replicated RAM state is gone.
   - Recovery is only from a sealed archive, opened with an admin recovery key, **plus an admin-signed acceptance of that archive's head (epoch/seq)**. An archive sink can serve a stale snapshot, and nothing in the archive proves it is the latest.
   - Without that, the reader stays refused.
5. **Checkpoint rotation.** By 2026-11-01T19:21:59Z the checkpoint must be rotated. That is a reviewed `CHECKPOINT_RECORDS` change, and it **changes the binding**, so the existing journal refuses (binding mismatch). It needs a fresh admin enrollment (3).
6. **Independence.** Quorum evidence needs members on independent hosts/operators with attested measurements (`platformApi.members`/`measurements`). A same-host set gives availability testing only.

## Unchanged and remaining
- **Unchanged:** the endpoint design from r2 (bound private `10.0.2.2` origins, untrusted transport, role composition, no secrets), native v3 `49f4d7e3…` (not `581d`), the writer's fixed 120 s ceiling, the custody guard, admin controls and finalized-only derivation.
- **Remaining (root):**
  - `check`, then `image`;
  - SNP measurement and qualification;
  - the bound config with `platformApi.derivedReader`;
  - confirming the live guest's `10.0.2.2` reachability (not inspected: no SSH);
  - checkpoint rotation;
  - state interfaces 1–4 (KVM and platform owners).
