# Branch triage, 2026-11-24

Every branch tip in the owner's checkout and on `origin` that is not an ancestor of `main`, compared against main
`30f066e2d`: 444 distinct tips under 335 branch names. `ledger.json` has one row per tip. One branch was merged with
this record. Nothing was deployed, signed, published or restarted, and no branch or worktree was deleted or changed.

This continues `ops/source-consolidation-20261030/`. A row's verdict is computed, not a review; the rows that were
looked at by hand say so in `note`.

## Why 308 tips share no history with main

The history was rewritten on 2026-10-24: the old spelling of a provider's name became "Cloud Provider" in file
contents, file names and commit messages, a bot author became "Configuration automation", and `Co-Authored-By`
trailers were dropped. Every commit got a new id, from the first one (`c99e8879f` became `30cc39932`). Main was not
squashed: it has the same commits, one for one, with the same author times.

307 of the 308 tips are local branches that still point into the old history. For 125
of them `origin` has the rewritten branch of the same tip commit (`rewritten_twin` in the ledger). The remaining tip,
`origin/build/lease-reaper-artifact-20261028`, starts from its own root (`9dd1e250b`, a snapshot of the production
control source) and was never part of either history.

So an old-history commit is matched to main by author time and the first 25 characters of its subject after the
same substitution. 199 of the 308 tips have every commit on main that way.

## Verdicts

| verdict | shared history | pre-rewrite | meaning |
|---|---|---|---|
| `in-main` | 36 | 199 | every non-merge commit has an equivalent on main (`main_commit` is the tip's) |
| `content-in-main` | 5 | 6 | commits differ, at least 97% of the lines they add are in main's files |
| `superseded` | 16 | 19 | what is left is in files main changed later, or removed |
| `carries-records` | 23 | 22 | what main lacks is evidence, records or documents |
| `carries-work` | 45 | 58 | has lines in files main never had, or has not touched since |
| `landed` | 1 | | merged with this record |
| `owned-active` | 3 | | an active session's branch, read only here |
| `not-landed-*`, `candidate-preserved`, `not-for-main` | 7 | 4 | looked at by hand, reason in `note` |

`carries-work` is not "ready to merge". It is 45 shared-history tips in 29 stacks, nearly all from 2026-09-24 to
2026-10-16, and all 29 stack tips are in the 2026-10-30 inventory (`in_20261030_inventory`), which reconciled what
main needed from them by path and left the rest as historical: old control and package versions (`pkg/control-v4x`,
`windows/vbslike-pkg-*`, `windows/uefi-dev-boot-*`), rollout sheets and records (`windows/deployment-record`,
`windows/reboot-go-sheet`, `release/publication-0181bce3-e53`), and candidates that record names
(`review/pvm-*`, `security/relay-txt-key`, `codex/pin-*`, `codex/shield-performance-20261001`). The 58 pre-rewrite
rows are mostly the local copies of the same branches; 14 have no rewritten branch on `origin` and exist only in the
owner's repository (`d1/hv-node-rollout-v2xx`, `windows/hv-node-rollout`, `sdshield/guestd`, `sdshield/supervisor`,
`nucbox/zimage-shield-host`, `codex/nucbox-dynamic-ram-20261002`, `codex/risc-dynamic-ram-20261002`,
`codex/cron-service-config-20261002`, `codex/nucbox-secrets-20261001`, `codex/nucbox-cid-config-20261001`,
`codex/ens-recovery-main`, `security/isolation-contract-enforcement`).

The line count is over added lines of at least 16 characters, compared with main's file of the same path. It cannot
see a change that main made differently on purpose, and it counts a line as present when it is anywhere in the file.

## Landed

`origin/isolation/front-console-guard` (two commits, 2026-09-25, test only): one more case in `TestTracedThread`,
`isolation/m2/front/dumpable_test.go`. Merged on main as `889aa1c0b`. On the merge:
`go test ./front -run TestTracedThread -count=200 -race` passes. The whole package fails three `TestRPCReady*` cases
with and without the merge ("isolated root user namespace required"), so it was not seen green here.

## Looked at and not landed

- `codex/native-session-upload-20261025` (local, three commits): catalog uploads and log reads under a session with
  no wallet fallback, and a new `enclave upload`. It conflicts with main in `cli/enclave.mjs` in four places
  (independent mode, `--chain-only`, the command table), and the `cli/connect` session is working in that file. The
  server side that grants `api.upload` and `api.logs` to a session was not checked.
- `codex/native-control-integration-20261025` (local): the per-image desktop SVN floor (`702854589`) and the measured
  control API qualification. Control image and relay admission. `docs/operations/windows-release-2026.11.18.md`
  already names `702854589` as missing from the tree.
- `origin/build/lease-reaper-artifact-20261028`: unrelated history, cannot be merged. Its `qualification/` tooling
  is not on main.
- `origin/nucbox/domexec-app-port-floor`: the tip says "WIP (not for release)". `origin/nucbox/zimage-shield` below
  it ends in a revert of its own last commit; the rest was reconciled on 2026-10-30.
- `evidence/nan-n6-push-refused-20261030`, `-r2`, `-r3` (local): three attempts at main `232363e56`. They differ
  from it by a 3,760-line `HANDOFF-at-terminal.md` that the push check refused.
- `origin/audit/shield`: on main already (`in-main`).

## The KVM Box desktop image and `codex/native-masked-desktop-20261024`

The image's platform source is that line and is not an ancestor of main:

| image | platform source commit | where it says so |
|---|---|---|
| SVN18 to SVN21 | `82ea9c16f` (two commits below the local tip `0f46f807d`) | `candidate.json` of each export, outside the repository |
| SVN22 | `3b0679ad8` = `kvm-box/stream-flow-20261115` | `ops/stream-flow-20261115/README.md`, and `source-diff.json` of the export (tree clean) |
| SVN23, SVN24 (candidates) | `3ee89bc16` = `kvm-box/purchased-shares-20261120` | `candidate.json` of each export, outside the repository |

Main's records have SVN22 on the NucBox since 2026-11-15 14:20Z and still there on 2026-11-18
(`docs/operations/windows-release-2026.11.18.md`). Main has no record of SVN23 or SVN24 being activated; what runs
today was not read from the host.

`origin` has the line only up to `dc4a4160a`. `0f46f807d` (five commits later), `82ea9c16f`, `3b0679ad8` and
`3ee89bc16` are in the owner's local repository only.

What main lacks relative to `3ee89bc16`, 146 commits ahead of the merge base `adf9c5bbf` (2026-10-18):

- The commits. 109 of them have no equivalent on main; the 2026-10-30 consolidation replayed their content instead
  ("the native desktop range and five local fixes were replayed with semantic conflict resolution").
- Almost none of the content. Of 44,288 added lines, 42,679 are in main's files. Of the 679 files the line changed,
  491 are byte-identical on main. In the other 188 main is the newer side, with two exceptions that the
  2026-10-30 record kept on purpose or that main dropped: `contracts/EnclaveSecretVaultV2.sol` (`aa836ea3b`,
  founderless committee formation; main keeps the deployed contract's source) and four lines of
  `site/components/app-card/app-card.js` and `site/apps.html` (`5322422ff`).
- The two kvm-box commits are ports from main in the other direction (`3c4de3758`, `f56ff8912`). Of their eleven
  files, seven are identical on main today and four are newer on main (`tunnel_flow.go`, its test, `desktop.go`,
  `DESKTOP.md`).
- A record on main of the source commit for SVN18 to SVN21 and SVN23, SVN24.

So the image is behind main, not ahead of it: 32 files under `isolation/` that the line touched differ on main, and
main has 308 files' worth of later changes there. A merge of the line into main would add ancestry and conflicts and
no source. What it takes instead:

1. Push `codex/native-masked-desktop-20261024`, `kvm-box/stream-flow-20261115` and
   `kvm-box/purchased-shares-20261120` to `origin` as they are, so that the source of a running image is not in one
   local repository only. Their owners' call; not done here.
2. Build the next desktop image from main and compare its source inventory with the last export's, as
   `source-diff.json` does. Every difference is then a change main made after 2026-10-26 that has not run in a
   desktop guest. That is a release with its own gates, not a source merge.
3. Until then each kvm-box change is a port of main's files onto the frozen tree, which is what the two branches do.

## Files

- `ledger.json`: one row per tip. `remaining` counts added lines not found on main by where they are
  (`never-in-main`, `removed-on-main`, `differs-main-newer`, `differs-branch-newer`).
- `triage.py`, `classify.py`, `ledger.py`: what produced it (`REPO=<checkout>`; they write beside themselves, so run
  a copy).
