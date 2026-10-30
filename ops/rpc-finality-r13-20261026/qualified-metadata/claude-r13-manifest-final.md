# base-finality-proof-stage/r13-manifest-final: metadata-only revision of r13-final; qualification job PASS (offline; no SSH/live/commit)

**Root cause.** `root-original-canary-r13-0931` failed locally because the frozen cold canary assembler (`61ba3daf`, unchanged) correctly refused r13-final: its `install/MANIFEST.json` still had `"stage": "base-finality-proof-stage/r10"`.
- **Not touched:** r13-final (`f58b0b4f`, still verifies), the assembler, the original-game canary stage and its pins (the 0931 failure is preserved).

## The revision
- **Stage:** `base-finality-proof-stage/r13-manifest-final`, `SHA256SUMS` **`80cea88861f069540bd6d4214cdcd9e2020c897558f7dd4badcf572edecccd60`** (112 files; `logs/` and `bundle/` excluded, as in r13-final).
- **Patch:** exactly one byte span in `install/MANIFEST.json`: `"stage": "base-finality-proof-stage/r10"` → `"stage": "base-finality-proof-stage/r13-manifest-final"`.
  - The JSON differs ONLY in `stage`.
  - The sha changes `5a2de6e7…` → `2ff892564dff…`.
  - No code pins that sha; only `COMPOSITION.tsv` and `SHA256SUMS` record it.
  - The installer reads MANIFEST entries, never `stage`.
- **Added:**
  - `METADATA-REVISION.json`: provenance, the base sums, root's receipt, the changed and added lists, what was retested;
  - `jobs/root-r13-manifest-final.sh`.
- **Kept byte-identical:** the other 109 files, i.e. all source, units, installer, tests, `bundle-origin.json` and `COMPOSITION.tsv`. `COMPOSITION.tsv` is the historical r13 record; `METADATA-REVISION.json` supersedes its single MANIFEST row.

## Qualification (`jobs/root-r13-manifest-final.sh`, shared queue 512, `unshare -Urn`)
- **Run:** `./jobs/q-exit-status.sh claude-r13-manifest-final-1 512 unshare -Urn bash base-finality-proof-stage/r13-manifest-final/jobs/root-r13-manifest-final.sh`
- **Receipt:** `logs/claude-r13-manifest-final-1.out` (sha `cd553f24…`, rc 0), ending `## r13 SHA256SUMS 80cea888…` / `## finality-r13 rc=0`. These are the unchanged installer's expected lines.

**What it checks.** Everything is derived from bytes and root's receipt; nothing is taken from this stage's own claims.
1. **The base:** r13-final `SHA256SUMS` == `f58b0b4f` and its files verify. Root's ACTUAL receipt `logs/root-finality-r13-final-0918.out` (sha `01c34175…`) contains `## r13 SHA256SUMS f58b0b4f…` and `## finality-r13 rc=0`, and its `.rc` is 0.
2. **The metadata-only diff:**
   - the file set = r13-final's plus exactly the 2 declared additions;
   - all 109 other files have r13-final's sha;
   - MANIFEST bytes == old bytes with the one span replaced, and the JSON diff == `{stage}`;
   - `METADATA-REVISION.json` matches.
   - **Root's 0918 receipt (all r13 suites) is therefore REUSED for those 109 byte-identical files.** Nothing is re-run whose bytes did not change.
3. **RETESTED** (what the change can affect):
   - **Manifest closure:** 61 files, 14 trees, 32 bundle entries.
   - **Bundle:** assembly (`tools/assemble_bundle.py`, 32 entries) and closure (32).
   - **ops-installer:** 18 PASS on the unchanged installer and tests with the new manifest.
   - **Cold canary assembler `61ba3daf`** (imported unchanged, pins dir private), dry assembly:
     - **ACCEPTS** this stage (12139 bundle files, `BUNDLE-ORIGIN` stage = the new name);
     - **REFUSES** the r13-final pins (`manifest stage is base-finality-proof-stage/r10`, reproducing 0931);
     - **REFUSES** stale sums, a stale manifest, and the wrong stage name with the new sums.
   - **Stage sums re-verified** after the run.

## Stable handoff pins (root reviews; `logs/r13-manifest-final-handoff-pins.json`)
- **Composed-stage pins** for a NEW original-game canary candidate (the old canary stage is untouched):
  - stage `base-finality-proof-stage/r13-manifest-final`, stageSha256sums `80cea888…`, manifest `2ff89256…`;
  - unchanged: bundleOrigin `4121a5f6…`, captureModule `8da369de…`, finalityState `5e4e38ca…`, finalityCore `686cbc22…`, a1Read `da9a9e9c…`, a1RecheckRead `78df2211…`.
- **Systemd canary (r3) FINAL-PINS:** that stage and sums, with holder_gate `dd680061…`, wrapper `6a4d7aa5…`, finality_state `5e4e38ca…`, `60-release-mode.conf` `2df07889…`, reproof unit `b36ee8d8…`. **Not written into the canary stage:** root fills them, then re-freezes r3.
- **First-bootstrap consumer:** `a1_capture_original.py` `2f7656b8…` (unchanged).
- **Installer qualification:** `--qualification logs/claude-r13-manifest-final-1.out --rc logs/claude-r13-manifest-final-1.rc`, or root's own re-run of the job.

## Not done
No live run, canary run, SSH, commit, or edit of other stages.
