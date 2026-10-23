# frozen-1852 export: how to rebuild

"1852" is this batch's identifier: its actual start, 2026-10-23T18:52Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. Nothing here is merged, imaged, activated or deployed by this capture.
- **The native CPU canary result is a FAILURE of the Hyper-V cap.** Under the Windows 11 root scheduler, a 1% share still used a
  full guest CPU. No CPU production activation was made, and the source fix is pending.
- **Custody v2 is still the original single-seat bootstrap**, not decentralized custody.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

Ignored and untracked files are never read. These include the root-validation binaries, the raw quote file (raw chip ID) and node_modules.

## Exact trees

| Side | Base | Commits → head |
|---|---|---|
| root-cpu-quota | c57a5f47 (frozen-1806 root-cpu-build, pushed in 7422efe6) | **8afbf879** (56f0e35c) |
| custody-live | empty tree | **a90f8339** (b48a5ff5) |

`git read-tree` the base, then `git apply --cached` each patch in order; `git write-tree` must equal each recorded tree.
`verify-frozen-1852-export.py` does this offline from 7422efe6's stored patches; its output is in `REPRODUCE-CHECK.txt`.

## Source-only derivative: b-consumer

- **Range:** B, 673601e5 → 9 commits → c08532b2 (original head tree b578d56b).
- **Base:** 673601e5 is frozen-1339 b-launch's 27th commit. It is rebuilt from the 493ee9ee tree plus the stored frozen-0630,
  frozen-0745 and frozen-1339 patches.
- **Held at their 673601e5 bytes:**
  - the compiled `metal/guest/platform-api.bundle.mjs` (8,878,598 B at c08532b2, over the 5 MB limit);
  - `metal/guest/mcp-server.bundle.mjs`;
  - the three `*.bundle.mjs.manifest.json` files.
- **Converted manifests:** each manifest is published under `converted/` as `sha256  path` sums plus a meta file. The export
  asserts the exact rebuild. The originals' name/hash pairs trip both unchanged scanners, as in frozen-1517 and frozen-1639.
- **Restore:** run the repository's own bundle builders at c08532b2 with B's node_modules. The platform-api builder also needs the
  gitignored `relay/network-runtime.bundle.mjs`. Compare the outputs with INVENTORY `omittedAtHead` and the converted manifests.
  **D did not rebuild them, and makes no rebuild claim.**
- **Status:** source and test only; this is not production provider independence. The result commit c1a8f395 is not captured
  (its exports duplicate these patches). B's outer RESULT.md and handoff/HANDOFFS.md are captured as frozen files.

## Source-only derivative: guest-lineage

- **Range:** R, root → **02863ae1** (original tree bb656d87), minus `REPORT.md`.
- **Why it is omitted:** the report names an existing outputs directory whose name carries the LOWERCASE rewritten provider literal.
  The 2026-10-21 rewrite removed both cases from content, though not from file names, so the report is not published here.
  D's content check (frozen-1852-content-check, rc 1) caught it before any push; the unpushed local commit was dropped.
- **Restore:** from R's repository at 02863ae1. Its blob and sha256 are in INVENTORY `omittedAtHead`. Nothing else differs.

## Touched-file reproduction: m-durability

- **Range:** M, c635fd68 → ed0c536d → 415483ff (original head tree c1366cf9).
- **Why the base can't be reproduced:** the base c635fd68 (custody-release repo-b quote-tested candidate) is on pre-rewrite history.
  It is not in any pushed material, and its tree contains the rewritten literal, so it cannot be published.
- **What is stored:** `base-files/` holds the base blobs of the touched files (no literal).
- **What is checked:** the verifier builds an index of only those files, applies the two patches, and checks every touched path's
  blob at each commit (`touchedBlobs`).
- **The full tree is not reproduced, and that is not claimed.**
- **Status:** source only, and not built, imaged or measured. M's RESULT.md records an e2e constructor fixture failure. The phase-2
  follow-up is not captured.
