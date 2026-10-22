# fefence review: an invalid pairing (C2 driver × v27 fenced), not a migration regression — read-only diagnosis

- **Run:** `20261022T074318-2c83b92890fa` (journal stage `cleaned` at 07:51:32Z; read after it finished, nothing touched).
- **Inputs:** every input is pinned in `REVIEWED-INPUTS.sha256`.
- **Scope:** no test, harness, container or build was started, and no Rust or Go was rebuilt.

## 1. What actually happened in `fefence` (harness `fe` = fence-enclave v27, driver = C2-4 snapshot `d45df48e`)

- **Four boot-dependent cases** (two_starters, delayed_old_writer, listing_after_install, and both blocked_*) end with the same EVIDENCE line:
  `fence-boot Err("C2 precondition: r0 does not report the "cas-v4" and "op-nonce" capabilities (old indexd); refusing to boot fenced …")`.
  The following upload then fails: `0 of 0 admitted replicas`.
  - That refusal is the C2 SDK's designed precondition, in `sdk-snapshot-c2-4/sia-s3/src/replica.rs:1115` (`5a8fc0e1`).
  - The reason is in `fencing.rs` `FencePolicy::check` (lines ~170-200). Under C2 a fenced instance needs NO no-clone evidence, *only because* every indexer is verified at boot to report `cas-v4` and `op-nonce`.
  - v27 lacks them. So a C2 client must refuse it, or the copy-safety argument that replaces no-clone evidence would not hold.
  - `accept_unevidenced_isolation` "is not needed by C2 and exempts nothing". There is no flag that should, or could, make these cases pass on v27.
- **`real_fence_endpoint_semantics_exact_receipt_and_refusals` passed.** It calls the fence endpoint directly and never boots a fenced store, so it is valid evidence about v27's `/fence` API.
- **`"mode": "fence"` has no effect.** `case-group.sh` exports `SIAS3_REAL_INDEXD=$MODE`, but the C2 snapshot's `real_fencing.rs` never reads it; its header just repeats the old fence-era command line. Only `real_indexd.rs:57` reads it, and only to choose `v060`→Feed or `u1`→Current. `"fence"` therefore falls back to Feed.
- **The original C2 matrix never made this pairing** (`indexd-c2-implementation/tools/real-runs.sh`):
  - groups `r` and `b` (the same fence cases) ran the C2 driver on `harness-c2` (v28);
  - only group `o` ran the C2 driver against an old indexer, as a **refusal** test.
  - `fefence` combined "C2 driver" with "v27 fenced semantics", which no supported client does.
- **The fence-era evidence for v27 fenced semantics used a different client.**
  - The client was `storage-real-indexd/bin/sdk-final-driver` (`a2f0deda`), built from `sdk-snapshot-final` (`FINAL-tree.sha256.published 323d3038`) per `runs/sdk-final-cases.json`.
  - It ran on `bin/harness-block` (`33bee1ac`) with the `indexd-replica-rollout` release tree, in runs sk1/sk2/sk3/sk3x, all ok.
  - That client's test policy is `accept_unevidenced_isolation: true // DRIVER ONLY` (`sdk-snapshot-final/sia-s3/src/real_fencing.rs:77`). Its boot status reads "isolation risk accepted: no recorded no-clone evidence for Snp".
  - It is the pre-C2 model that the C2 no-clone guarantee replaces, so it is **not** a deployable combination.

## 2. Is v27 fenced mode required for the migration? No — from source

`control-package/storage-migration/MIGRATION-PLAN.md`:
- line 39: "Production accounts are never enrolled or fenced by a migration";
- line 90 (Phase C step 4): "No account is enrolled. The unfenced sia-s3 and adapter are unchanged; there is no repoint";
- lines 92-93: `rollback-c2` "refuses while any account is enrolled, and nothing is enrolled in Phase C".

So during the v27 interval, and after a rollback to v27, only **unfenced** clients talk to the indexer. A C2 client must refuse v27. A fenced pre-C2 client is not deployed and would need the no-clone override.

## 3. The required supported combinations, and what this run shows for each

| # | Combination (required) | Group | Result in run 2c83b928 (libtest summary; the old parser said "missing") | Status |
|---|---|---|---|---|
| R1 | C2 client → v28: C2 positive semantics | c2epos | ok, 5 passed, 0 failed | evidence |
| R1 | C2 client → v28: fence API semantics | c2efence | ok, 4/0 | evidence |
| R1 | C2 client → v28: admin blocklist + fence (admin block/unblock preserved) | c2eblock | ok, 2/0 | evidence |
| R2 | C2 client → v27: **refused** before raising anything | fec2neg | ok, 1/0. EVIDENCE `old-indexer`: capabilities `[]`, `ready:false`, `fence_after:null` | evidence |
| R2' | v27 `/fence` endpoint API (no fenced boot) | fefence, endpoint case only | ok | evidence (incidental) |
| R3 | unfenced Feed-listing client (deployed shape) → v27 | feindexd | 6 passed, 1 failed (see 4b) | 6 evidence + 1 expectation mismatch |
| R4 | unfenced Feed-listing client → v28 | c2eindexd | **NOT RUN**: harness setup failed (see 4a) | **missing: required rerun** |
| — | C2 client → v27 **fenced semantics** | fefence, 5 boot cases | refused by design (= R2's mechanism) | **invalid pairing**: drop or reclassify |

## 4. The other two failures

**a. c2eindexd: environmental, before any test ran.**
- `c2eindexd.harness.log` reads: `setup failed: indexer r0 formed 11 of 12 contracts`.
- This comes from `harness-src/cmd/harness-block/main.go` `waitContracts`, which gives up after 3 minutes. The file (`e47286ab`) is identical to the fence-era harness.
- The same flake is recorded in the fence era: "`v060a`: 11 of 12 contracts" (`claude-storage-indexd-result.md` §failed runs).
- Synthetic-host contract formation on a 2-CPU cpuset is the cause; it is not an SDK or indexd behaviour. The group needs one rerun with no changes.

**b. feindexd `real_bootstrap_after_an_acknowledged_but_unpublished_pin`: a v26-only assertion.**
- **What passed:** every deployed-shape (Feed) assertion before line 376.
  - EVIDENCE `boot-while-unpublished {"indexd":"v060","kSeen":null,"listing":"Feed"}`;
  - EVIDENCE `acknowledged-delete-undone {"deleteRecorded":false,"kAfterPublication":"v2"}`.
  - These are exactly the v26 baseline: finding X1 (the feed listing misses an acknowledged PUT, and a DELETE is undone) reproduces on v27 unchanged. It is pre-existing behaviour of the deployed Feed client, neither introduced nor fixed by the migration.
- **What failed:** line 376, `load_listing(Current).err().expect("no current listing on stock indexd")`.
  - That line assumes the indexer has no `GET /current/objects`. That is true for stock v0.6.0, where the tree has 0 hits.
  - It is false by design for fence-enclave and c2-enclave: both `api/app/app.go` serve it.
  - The test file is byte-identical to the fence-era one (`real_indexd.rs 750fea3b` in both). It was written when only v26 existed.
- **Conclusion:** not a regression. The test's expectation is version-specific. Do not count this case as passed: the Current-listing half is unproven on v27 until 5b runs.

## 5. Narrow corrected matrix and extra test recipe (proposal: `proposed-groups.json`; the running package is not edited)

1. **fefence.** Keep only `real_fence_endpoint_semantics_exact_receipt_and_refusals`, renamed `fe-fence-api`; it needs no fenced boot. Remove the 5 fenced-boot cases from the v27 group.
   - Their refusal is already the required R2 evidence (fec2neg).
   - Keeping them as "expected to fail" would duplicate R2 without asserting anything more.
   - **Never** add `accept_unevidenced_isolation`, a fixture no-clone assumption, or a capability spoof to make them pass.
2. **c2eindexd.** Rerun unchanged: same harness, cases, mode `v060` and limits. This is required for R4.
3. **Additive Current-branch coverage on the enclave trees, no rebuild:** `fe-current` and `c2e-current`, mode `u1`, cases
   `real_bootstrap_after_an_acknowledged_but_unpublished_pin` and `real_listing_right_after_an_acknowledged_pin`.
   - With the same C2-4 driver, mode `u1` selects `Listing::Current`. The bootstrap case then asserts that "the acknowledged DELETE holds".
   - This proves the fail-closed current listing works on v27 and v28. It is the half that line 376 wrongly assumed absent.
   - It is the fixed-listing client path, not the deployed Feed client, and is labelled as such.
4. **Source fix for the v26-only assertion** (test-only; `patch/real_indexd-capability-conditional.patch`; NOT built). On an indexer that serves `/current/objects`, the Feed branch asserts the current listing loads. On stock it keeps the fail-closed assertion.
   - Root or the SDK worker rebuild the driver only if they want a single 7/7 group. Items 2 and 3 already cover the semantics without a rebuild.
5. **Optional, not migration-blocking:** a fence-era historical-parity group, `sdk-final-driver a2f0deda` × `fe` harness, cases `real_fence_*`.
   - It exercises v27's **server-side** fence enforcement on the enclave-small tree with the pre-C2 client.
   - It requires that client's DRIVER-ONLY `accept_unevidenced_isolation: true`, so it says nothing about any deployable client, and nothing about C2's no-clone guarantee.
   - Run it only if root wants enclave-small parity of the v27 fence endpoints beyond R2'.
   - Its driver's own harness contract differs: it ran on `harness-block 33bee1ac`, and `fe` is the enclave-small build of the same `main.go`. That difference is an open question for that optional group only.

Resources are the same envelope as the reviewed runner: one container, 1280 MiB, 2 CPUs, queue 1536. Items 2 and 3 add 3 groups, about 3 to 6 minutes each.

## 6. What the remaining groups prove, and what they don't

**Prove**
- Real SDK ↔ real indexd interop on the accepted enclave-small trees (v27 fence-enclave, v28 c2-enclave). The setup is local: 3 indexers, 12 synthetic Sia hosts, network-none, a fixture PostgreSQL.
- C2 positive semantics, fence API semantics and the admin blocklist on v28.
- A C2 client's refusal of v27.
- The deployed-shape Feed client's unchanged behaviour on v27, including X1.

**Don't prove**
- **The deployed sia-s3 binary.** The driver is the C2-4 snapshot. Its unfenced path is a proxy. The main-lineage `sias3-real-driver` (`1a10c22b`) also carries the U1-isolated `store.rs`, and was only run on stock v26 (v060c, 7/7).
- **Production authority binding.** The `lease16` / `lease17` authority, `chain 8453`, `ledger 0x1111…` and `deployment 0x2222…` are synthetic FIXTURE facts (`real_fencing.rs` header). They are **not** authorization to migrate legacy contracts, and they are not ledger17 migration evidence; ledger17 stays disabled per the requirements.
- Live replica independence, no-clone isolation evidence, real Sia network behaviour, or real data migration (the offline rehearsal is separate).
- The rollback path on the enclave trees (`rollback-c2` → `rollback`), and v26 behaviour after a rollback: that is fence-era v060c only, not the enclave trees.
- C2 behaviour under the X1 publication lag for the *deployed* Feed client. X1 persists on v27 and v28 for Feed clients until they move to a current-listing client.

## 7. The parser and the "missing" cases

- The four earlier groups (c2epos, fec2neg, c2efence, c2eblock) have driver rc 0, harness 0, and libtest `ok … 0 failed`.
- Under `--nocapture`, the EVIDENCE output lands on the same line as `test <name> ...`, so per-case `… ok` lines are not standalone. The parser being fixed elsewhere reported them as "missing".
- This review used the libtest summaries and the `failures:` lists only. It did not change the parser.
