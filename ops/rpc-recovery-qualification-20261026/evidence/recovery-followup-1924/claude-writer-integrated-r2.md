# writer-integrated-stage/r2: integrated r1 re-based on FROZEN history r3, plus a rollup-config pin gate (FINAL: frozen, NOT run)

**Status:** source frozen; nothing run; this does not make the writer production-ready.
- **Inputs (all verified):**
  - history r3 `writer-cold-recovery-stage/r3`: SUMS `320b80b8…` OK; tree `a4dd62c3` reproduced;
  - integrated r1: SUMS `47498c7c…` OK, preserved and superseded;
  - driver r1: SUMS `05c3dc7d…`.
- **Untouched:** every frozen stage, `/tmp/w5` (r1 scratch; only cloned from), `/tmp/w6` (history r3 scratch) and 370's scratch. **Scratch:** `/tmp/w7`, verified in `/tmp/w7-verify`.
- **Executed by me:**
  - `bash -n` on the job;
  - sha256 sums and scratch git trees;
  - **one `node --check`** on the edited integration test (a syntax parse only, no code executed; it printed nothing).
- **Not done by me:** tests, builds, live actions, USB or commits.
- **The stage SUMS hash** is appended at the end of this report.

## Composition (reproducible)
1. r9 release → two-anchor r1, r2, r3 → cold-recovery r2 `e903c224`;
2. **+ the history r3 patch** (`dbe2d1a6…`) → `a4dd62c3`;
3. **+ the driver r1 patch** (two new files; applies cleanly) → `d9ff6a9148fd5a984a35b905ad293edb199cea3c`;
4. **+ `patches/writer-integrated-r2-vs-cold-recovery-r3-plus-driver-r1.patch`** → **`a01a3e95f42b965eddd1d45c968be0c6b0e0e1a7`**.

- **Reproduction:** step 4 was re-applied in a fresh clone from `e903c224` and gives the identical tree.
- **The r1 patch hunks:** the r1 integration patch applied to the r3 base with `--3way` and **no conflicts**.
  - **`provider.mjs`:** the `driver` binding entry sits next to r3's v2 `history` entry. Both refusals on unsigned or uninitialised state are kept.
  - **`derived-writer-authority.mjs`:** the driver start, exclusivity and close order sit beside r3's F1 coverage-first `leaseLogs` and F6. Nothing was dropped.
- **Fixtures and build metadata needing history v2:** none outside r3's own suites, which are already v2.
  - No template, record or other test builds a history policy.
  - `git grep` of `backward-history-policy`, `rawTransactions` and `receiptConcurrency` turns up only r3's files and the unrelated public-rpc `rawTransactions.propagation`.

## r2 changes (beyond re-basing r1)
### 1. Driver policy v2 (`relay/derived-reader-driver-wiring.mjs`)
- **New required signed key:** `rollupConfigTemplateSha256` (64 lowercase hex). v1 is refused; it was never shipped or run.
- **The check:** `startReaderDriver` compares the template bytes it reads to that sha **before** JSON parsing and the 8453 check.
- **The binding:** the sha is part of the `driver` section, so it is inside the signed reader binding (tested).
- **The comment** on `cold: null` now carries r3 F4: the history scan is not worker-isolated, so it is not "I/O only".

### 2. Role pin to the measured image record (`metal/guest/platform-api-role.mjs`, `composeDerivedReader`)
- **The rule:** if the pinned template carries `driver`, then all of the following must hold:
  - the image record must have `files.rollupConfig {path (absolute), sha256}`;
  - `driver.rollupConfigTemplateFile` must equal that path;
  - `driver.rollupConfigTemplateSha256` must equal that sha256;
  - the file must exist with those bytes.
- **Otherwise** composition refuses with `derived_reader_tamper` or `derived_reader_absent`.
- **Templates without `driver` compose exactly as before**, so the endpoint and overlay suites are unaffected by construction.
- **This file is a guest-bundle manifest input.** The job's bundle check now includes it, and `check` regenerates the bundle.

### 3. No template or record change: history and driver stay DISABLED (absent)
- `metal/derived-reader-config.v3.json` (`49ccf144…`) and `metal/derived-reader-image.json` are unchanged.
- **No reviewed Base rollup-config bytes exist** in any input: the tree, the reader inputs or the stages. I **did not fabricate one**, so `files.rollupConfig` is not pinned.
- The new test asserts that the shipped template has no `driver` or `history` and that the record has no `rollupConfig`.
- **Enabling stays an explicit gate**, which needs all of:
  - (a) real Base rollup-config bytes from a reviewed source, shipped and pinned in the record;
  - (b) a template carrying a validated `driver` v2 section and a `history` v2 section (the real ledger list and the 52,515,705 floor);
  - (c) the signed binding rotation;
  - (d) root/KVM approval.
- The README notes the template is untrusted input that the native checks via `rollupConfigHash`, so the pin is defense in depth, not authority.

### 4. Tests (`test/derived-reader-driver-integration.test.mjs`: 8 → **9**)
- **Adapted:** the policy fixture is v2 with the sha; the started drivers pass the real fixture template's sha.
- **Added to the policy test:** v1 refused; a missing sha refused; uppercase, short and non-string shas refused.
- **Added to the outage test:** a sha mismatch is refused before parsing; the non-Base template is still refused with a matching sha.
- **Added to the KVM staging test:** the binding changes when the sha changes.
- **New test 9 (role):**
  - the shipped template has no driver or history, and the record has no `rollupConfig`;
  - with no driver section, composition is unchanged;
  - with a driver section naming the pin, it composes, and the composed config carries the exact section;
  - refusals: no record pin, another path, another sha, a missing file, tampered bytes.
- **Unchanged and preserved:** 120 s on S, finality-first, A2 marker, full proof checks (native + provider), business/admin controls, and enrolled-only startup.

## Root job: `jobs/root-writer-integrated-r2.sh` (derived from the r1 job by explicit replacements)
- **Verifies frozen:** r1, r2, r3 two-anchor; cold-recovery r2; **history r3**; driver r1; **integrated r1**; r9 and KVM r3.
- **Composes:** the 7-patch chain, asserting every tree (`…` → `e903c224` → `a4dd62c3` → `d9ff6a91` → `a01a3e95`).
- **`slice` (512 MiB) = 199:**

| suite | tests |
|---|---|
| driver-integration | **9** |
| driver | 10 |
| backward-history | **13** |
| writer-history | **9** |
| two-anchor | 13 / 12 / 12 |
| KVM r3 six suites | 65 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

  - **Why 199, not 198:** root's estimate of 198 assumed unchanged tests; this stage adds the role test.
- **`check` (2560 MiB):** the r1 check set unchanged (endpoints 6, overlay 25/6, platform-api-config 5, relay-derived-reader-runtime 4, paid-derived-packaging 5, relay set, 5 startups, unenrolled tree), with the bundle check extended by `metal/guest/platform-api-role.mjs`.
- **Run with:**
  - `bash jobs/q-exit-status.sh wint-r2-slice 512 unshare -Urnm bash writer-integrated-stage/r2/jobs/root-writer-integrated-r2.sh slice`
  - then `… wint-r2-check 2560 … check`.
- **Environment:** no HOME, CODEX_HOME, TMPDIR or TEST_TMP repurposing.

## Independent source review of history r3 for integration regressions (while merging)
- **API:** no regression. r3 adds only `status().history.remainingThrough`. The driver reads only `status().provisional`, `verifiedThrough` and its own fields. The provider's `prepare`/`submit` signatures and the error text the driver relies on ("candidate range exceeds reader bounds") are untouched by r3.
- **Synergy:** the driver's routine finality extends runtime coverage, and r3 F1 serves any in-coverage claim **without** the history. Old claims still depend on a completed scan. r3's "retry after 60 s on a later `prepare`" is now driven by the driver's own ticks, rather than by an external client.
- **Risk (unmeasured; not a code defect):** r3 F4 receipt verification is synchronous on the **relay's in-process** event loop, shared with the driver's timers, the provisional 120 s budget and the relay's request handling. Yields happen only between blocks.
  - With `receiptConcurrency` up to 8, plus the driver's hints, plus the provider's own Base requests, the one own Base node is also shared.
  - **Recommendation:** a measured gate (per-block verify time and loop lag during a scan) before enabling history together with the provisional tier. The driver's `cannotMeet120s` reports a miss but does not prevent it.
- **Cache:** r3's cache lives beside `runs/`. Its `O_NOFOLLOW`/regular/uid/size checks and the never-authority rule are consistent with the enrolled split directories. The driver does not touch it.

## Pending (explicit; not in r2)
1. **The witness transport across the guest/RPC-VM boundary** (root 1583).
   - **Why it is pending:** `claude-witness-placement-r2.md` is an **EARLY, unfrozen** proposal ("hashes, patch, harness and freeze follow"), so it is **not consumed**. The r2 transport stays loopback-only, which **cannot** reach the RPC VM. **The driver is therefore not deployable until the next composition.**
   - **Next composition, when 370's placement r2 is frozen:**
     - apply its patch against integrated r1 by `--3way` onto `a01a3e95`;
     - the driver policy is now v2, so its URL-rule and HOST_DATA `witnessUrl` cross-check must use the v2 `driverPolicy`;
     - add the real role config and schema tests.
2. **The producer output bound** (root 1589; not my task): `prlimit --fsize`, bounded stderr, a real child test. Needed before activation; it merges into the producer's corrected stage.
3. **Activation gates as in r1 §gaps:** measured template and record, the real rollup config, signed rotation, KVM review of `network/derived-reader/*` (including history r3 and this stage's `provider.mjs` hunk), bundle rebuild (root `check`), and the unmeasured M1–M6 timings. S may not meet 120 s.

## Merge instructions
- **Root:** run `slice`, then `check`. A failure in history r3 suites (13/9) is r3's (untested), not this stage's. Report it to the r3 owner and do not patch it here.
- **Later fixes:** produce integrated r3 = `a01a3e95` + the fix patches. **Do not edit r2.**
- **Placement r2:** as in "Pending" 1.
- **History-policy users:** the history policy must be v2 everywhere. The driver section must be v2 and name the record's `files.rollupConfig`.

## Correction to my review 1580 (root clarification 1588)
My r10 cut-over verdict was wrong to say the code refuses on `destAliases`/`fsWatchers`.
- **What the code does:** `require_writer_check` enforces `complete`, no hits, no source/retire aliases, freshness/prefix and the source target. It does **not** enforce `destAliases` or `fsWatchers`.
- **Consequence:** those are a manual gate before cut-over (root's stronger procedure), and must be enforced in code by reclaim r4.
- **The attestation** is an operator statement only (≥ 8 characters). It is not an automated freeze.
- An erratum is appended to `logs/claude-cold-r10-review-1580.md`.

---
**Frozen:** `writer-integrated-stage/r2/SHA256SUMS` sha256 **`748cad34b88e2214066eb9404ff571c4fa9bd9c2330d8b36f779bb0d0dad3bd6`**; patch `c9e230d2e32bde5aec0a9e92539ce292e20989cf9872045aff3bd45473bed533`; job `9a3ed28c5c4a7ea3cfaa6fa670c4c3bef0b8c50d948b02893bd465a3aae24c72`.
