# writer-two-anchor-stage/r1: Option B (two anchors). Source + focused tests + harness: PREPARED, NOT RUN

**Status:** prepared, frozen, never executed.
- **Code:** the network path and the relay adapter are written, and the focused tests and root harness are written.
- **Stage:** frozen at `writer-two-anchor-stage/r1/`, `SHA256SUMS` sha256 `cdacd616e3b217d6450c768b1a2cc520d6000aee719cddd064502297a37ae0b9`.
- **Nothing was executed by me:** no tests, builds, `node --check`, network, VM, live actions or commits.
  - The only checks were `bash -n` (a parse) on the job.
  - Re-applying the patch to a fresh `git archive` of the base reproduces tree `f22d554c`.
- **Not claimed:** qualification, feasibility or production readiness. Writer authority in production stays refused: no image template enables the policy.

## Base and chain of pins
- **r9 release:** `accepted-image-enrollment-stage/r9/runs/20261026T165416Z-check-2058632/release.git`.
  - Commit `296a5833…`, tree `90e4cdaa…`.
  - Its verdict: ok, check mode.
  - r9 stage SUMS `528ff8e8…`.
- **KVM r3 closure** SUMS `14656ef5…`, used for expected counts only.
- **Patch:** `patches/writer-two-anchor-r1-vs-r9-release.patch` (sha256 `3e399062…`) produces source tree **`f22d554c04f959a56d993f1c5048cd9e06a2d4b0`**.
- **Old→new code hashes:** every file is listed in `PROVENANCE.md`. The vendored schedule reader moves `688b7a1f…` → **`694f1297…`**, and `schedule-input-r2.mjs` `b3b814d0…` → `4cf44511…`.
- **Generated artifacts:** the reader bundle, `relay/schedule_reader.mjs` and the guest bundle and its manifest are rebuilt by root's `check`. No build hash is claimed here.
- **Ownership:** the patch changes **KVM-owned** files. It is a new closure for KVM review; the frozen KVM r3 dir is untouched.

## What is implemented (and where each requirement lands)
| requirement | implementation |
|---|---|
| Provisional L1 head = pinned Helios attested `latest`, explicit tier | `l1-runtime.mjs` `attested({maxAgeSec ≤ 60})`: chainId `0x1` recheck, `eth_getBlockByNumber('latest')`, the same header validation, not future. Every head from `finalized()`/`attested()` is branded in a module WeakMap (`l1HeadTier` → `helios-finalized` / `helios-attested-latest`); a JSON copy has no tier. |
| Vendor schedule reader updated, digest-bound | Explicit `mode:'provisional'`, checked before and after the two calls: finalized ≤ anchor ≤ attested, attested ≥ finalized, neither head regresses, `block(n).hash == anchor`. The result carries `l1Mode`. The default mode keeps the same checks and an unchanged result object. Re-pinned in `schedule-input-r2.mjs` (`verifyReaderPin`), `provenance.json`, the job's `SCHED_PIN` and the packaging test's message. |
| Tier chosen by the owned provider, never the caller | `proof.mjs`: `prepareProof({mode:'provisional'})` and `bindNativeV3(…, 'l1-attested-derived')` require the attested-branded head. A branded attested head can **never** bind the finalized tier (relabel refusal). Only provider code passes a tier. |
| Finalized-only bootstrap/journal/bridge floor/replica | Unchanged: `journal.mjs`, `deployment-lifecycle-journal.mjs` and the coverage-store manifest still accept only finalized tiers. Tests assert each refuses S. S is never `agreed`, journaled, staged, replicated or a floor. |
| Provisional coverage: RAM only, last finalized → S, contiguous, exact endpoints | `provider.mjs` `prepareProvisional`/`submitProvisional`: a one-shot ticket rooted at the **served** finalized anchor; segments chained by exact predecessor hash. The `coverage-store.mjs` `read(…, {overlay})` is read-only: persisted `[availableFrom, B_f]` plus RAM `(B_f, S]`, contiguous from the last persisted segment, ending at S; otherwise refused. A provisional anchor without its overlay is refused. |
| L1 canonicality on every use, reorg discard | Every S read (`readStateAnchor`, overlay `readDerivedLogs`, `prepareProvisional`) re-reads each provisional L1 head from the owned light client. Any difference or failure discards all segments. An attested-head regression (lower number, or same number with another hash) discards them too. |
| Finalized supersession / contradiction | On finalized progress, every provisional block also derived finalized must match (hash and output root). Matching blocks are dropped silently, and only an exact-boundary suffix survives. A mismatch **fences** the provisional track until restart; the evidence is kept in `status().provisional.fenced`. The finalized track keeps serving. |
| Bounded budgets | A signed policy carries `l1MaxAgeSec ≤ 60`, `maxStateAgeSec ≤ 120`, `maxBlocks ≤ 1800`, `maxSpanBlocks ≤ 32768`, `maxSegments ≤ 64`, `maxOverlayBytes ≤ 128 MiB`, `maxWitnessBytes ≤ 128 MiB`, `nativeTimeoutMs ≤ 120000` and `maxMemoryMiB`. The policy must have exact keys. |
| Signed binding with explicit policy; defaults disabled; no env bypass | `readerConfiguration` adds `provisional` to the binding **only when configured**. The default binding formula is byte-for-byte r9's; a test recomputes it. A changed binding requires enrollment rotation (the existing signed admin path). `lifecycle.mjs` gives `readStateAnchor`/`stateSnapshot` only for such a config. The relay takes `stateSnapshot` only from the runtime's service. No env variable, flag or caller enables it; a test shows env knobs and a config key in the relay change nothing. |
| Two-anchor bridge | `snapshot.twoAnchor(read)`: B_f is shape/age/floor-checked as before. S must be `l1-attested-derived`, ≤ 120 s old, and must extend B_f (number, time, L1). Both anchors are verifier-matched and `pinnedClient`-pinned to their own derivation-authenticated hashes and rechecked after the read. **Only B_f is journaled.** Plain `snapshot` is unchanged. |
| Relay adapter split | `relay/derived-writer-authority.mjs`, when `capability.stateSnapshot` is present: rows at B_f and S, and complete coverage `[availableFrom, S]` asked at S. The checks run in this order: (1) **the unchanged 120 s expression on `S.time`** (`:192-193`/`:266-267` text identical, verified); (2) a separate B_f liveness bound (`stale_finalized`, from the reader config's `maxAnchorAgeSec`, ≤ 3600); (3) `claim_not_final` for any last Claimed after B_f, which catches a same-runner release/re-claim through coverage; (4) the row at B_f must replay to the same claim. Then the deny-only verifier runs after S, unchanged. `block.finalized` = B_f. Evidence `{tier:'l1-attested-derived', claimTier:'l1-finalized-derived', finalized, state}`. The lease16 fact bytes are unchanged. The legacy single-anchor path is unchanged. |
| Custody separate | Untouched. `relay/custody-state.mjs` and `custodyRefusal` are independent, verifier-based gates and never consume the writer authority. |
| Admin controls / enrollment / recovery | No code change. Enabling the policy is a binding change that goes through the existing signed enrollment rotation. |
| Orchestration | Loopback `/provisional/prepare` and `/provisional/witness/<ticket>` route to the provisional track. There is no provisional anchor route; S is never served as JSON. |

**Tier name:** `l1-attested-derived`, not the doc's `l1-safe-derived`. In the pinned Helios, `safe` means finalized (A1), so "safe" would mislabel the trust.

## Focused tests (written, not run): 23 new
**`test/derived-reader/two-anchor.test.mjs` (13).** The fixture L1 process serves `finalized` and `latest` separately, with an echo native. The tests cover:
- the schedule-reader modes (finalized unchanged; provisional refusals: `not_attested`, `finalized_floor`, `anchor_mismatch` and the head-regression contradictions);
- disabled by default, plus exact policy validation and the binding formula;
- the provisional happy path (RAM overlay; journal, coverage and chunks unchanged; one-shot tickets);
- never persisted (both journals and stage refuse; a restart has no S);
- reorg discard and attested regression;
- attested bounds and the S 120/121 s boundary;
- finalized supersession and exact-suffix survival;
- the contradiction fence;
- tier provenance and the overlay refusals;
- the bridge `twoAnchor` (pinning, journal holds only B_f, refusals);
- an end-to-end provider → bridge → overlay logs → reorg refusal;
- lifecycle wiring only with the policy;
- the API routes.

**`test/derived-writer-two-anchor.test.mjs` (10).** It covers:
- fact, block and evidence;
- 120 s on S (120/121, +5/+6, never raised, refused before the verifier);
- B_f liveness;
- claims anywhere in (B_f, S] → `claim_not_final`, while a claim at B_f is final;
- same-runner release/re-claim with identical rows → `claim_not_final`;
- Released → `lease_not_current`; B_f row disagreement;
- incomplete coverage → `coverage_incomplete`;
- relabel and anchor binding;
- the verifier staying deny-only;
- the selector (no env enable; legacy 13-min anchor still `stale_snapshot`).

**Existing suites:** all kept, with unchanged counts. I reviewed every existing caller of the changed functions by reading: store reads use finalized-tier anchors, and the bind callers use unbranded heads.

## Harness: `jobs/root-writer-two-anchor-r1.sh` (root runs)
Composition from the qualified r9 `release.git`: verify r9 SUMS, its verdict and the tree, apply the patch, require `f22d554c`.

**`slice` (512 MiB, no build):**
- two-anchor-reader 13, two-anchor-writer 10;
- KVM r3 suites 22/6/5/10/8/14;
- writer 23, composition 6, replica 8, enrollment 19.

**`check` (2560 MiB):**
- **Builds:** build-network (runtime pin unchanged); the reader runtime with **SCHED_PIN `694f1297…`**; the regenerated guest bundle, whose sidecar must carry the new pin.
- **Release commit:** generated files only. Unlike r9, the reader bundle, manifest and sidecar are expected to change.
- **Suites at r9 counts:** endpoints 6, overlay 25/6, platform-api-config 5, relay-derived-reader-runtime 4, the relay set and the 5 startups with the 13-fixture checker.
- **New to this harness:** paid-derived-packaging 5.
- **Environment:** the job never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP. No image mode is prepared.

## NOT implemented / open (exact)
1. **Driver integration (unimplemented).** No in-tree witness producer exists for either track; it is external and untrusted. Nothing yet:
   - schedules `prepareProvisional`/`submitProvisional` (target selection, cadence, back-pressure against `maxOverlayBytes`/`maxSegments`);
   - aligns finalized targets to provisional segment boundaries, so the suffix survives instead of re-deriving `(B_f, S]` after each finality step;
   - produces witnesses for attested-head ranges.
   Without it, S never exists and the writer refuses.
2. **Enabling (deliberately not done):**
   - a new measured reader template carrying `provisional` (`metal/derived-reader-image.json` pin);
   - a signed binding rotation through the existing admin enrollment;
   - KVM review of the changed `network/` closure.
3. **Contradiction alerting:** the fence evidence sits in `status().provisional.fenced` only. Nothing yet logs or alerts it at the relay, or records which facts were issued from a now-contradicted S. Doc §7(a) asks for revocation/alarm policy; that is undecided.
4. **Consumer tier visibility (§7(b)):** facts carry the evidence tier relay-side, but the lease16 bytes are unchanged; whether consumers must see the tier is undecided.
5. **Security limitations (inherent to Option B, accepted only if root decides):**
   - **The attested head adds trust assumptions:** L1 fork-choice re-org exposure, and the attested head's lower (> ½ recent-maximum) sync-committee participation gate without a finality branch (A1).
   - **Residual window:** an L1 re-org after the last canonicality check can remove a Released S showed, or add one S lacked. This is an availability exposure bounded by re-org depth, not the 120 s. The claim and `gen` stay finalized.
   - **Fixtures prove nothing about real derivation:** the native v3 binary's completeness/correctness for attested-head ranges is the pinned executable's property, untested with real witnesses.
6. **Unmeasured feasibility (owned nodes only, root):**
   - **M1** Base safe lag;
   - **M2** Helios `cc962e2b` `latest` age and cadence (60 s bound unvalidated);
   - **M3** native + witness time per increment and cold `B_f→S` (`nativeTimeoutMs ≤ 120 s`);
   - **M4** end-to-end S age;
   - **M5** re-org depth;
   - **M6** not applicable.
   **If p99 S-age > 120 s, B cannot ship;** writer authority then stays `stale_snapshot`.
7. **Separately still open:** the never-enrolled restored-group admin recovery (strict refusal stays).
