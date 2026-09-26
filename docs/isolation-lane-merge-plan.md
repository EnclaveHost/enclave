# Merging the isolation lane into main: a plan to decide from

For Steven, via enclave-87. Written by enclave-b4 on 2026-09-26 (read-only: no pushes to main, no branch changes). The
numbers were read at lane `isolation/seccomp-evidence` @ `4cd26e58` and main @ `c6347dd2`; a local trial merge in a
scratch worktree backs every "works" below.

## The decisions this asks for
1. **Land in slices by path, not as one merge commit.** Recommended. Slice A (the isolation source) deploys nothing;
   Slice B deploys the relay; Slice C cuts a Tinfoil release pair and a metal `-cpu` tag. One merge commit would do all
   three in one push. This follows how M2, M4 and the relay predictor already reached main (scoped snapshots).
2. **Keep the evidence off main** (304 files, 12,390 lines under `*/evidence/`), as the M2 re-cut already decided for
   Windows. Tag the lane head instead, so every evidence path stays reachable.
3. **When to cut Slice C's release** (supervisor.js + metal/*): your call. The code is OFF unless a box sets
   `ISOLATION_BACKEND`, but the push still measures and publishes a release pair, and metal boxes that follow `-cpu` tags
   rebuild at their next update.

## The size of it
- Lane-only commits: **312** since the merge base `ae25c406` (2026-09-23 19:18 PT). Main-only commits since then: 211.
- Lane files changed: 598 (57,828 lines added). 304 of them are evidence; 294 are code, tests and docs.
- By area: `isolation/m4` 334, `isolation/m2` 126, `isolation/m3` 64, `isolation/contract` 20, `windows/vbslike` 15,
  `isolation/restore` 8, `metal/` 5, `supervisor.js` 1 (+917 lines), `relay/snp-verify.mjs` 1, tests 11.

## The 10 conflicts and their resolutions (all tried in the trial merge)
Several conflicts exist because the same work reached main twice: M2 (`2aeaab8d`, the Windows node's isolation code
"scoped onto main"), M4 (`bab1e36b`) and the relay predictor (`aeb345e6`) were scoped copies taken from the lane.

| File | Kind | Main vs lane | Resolution |
|---|---|---|---|
| `.gitignore` | content | main added `.verifier-integration/`; the lane added `isolation/m2/release/labpins/` | union of both |
| `cli/enclave.mjs` | content | the lane's only change is an early `--isolation` flag (`06bdcbdf`); main has since shipped its own, later `--isolation` (`c2bbf951`, `8774b4e7`, `7c606f79`) | **main's** |
| `isolation/m2/judge.mjs` | content | main's copy (`13fb51ed`, from M2) is an older subset: the pre-chain self-test only; the lane adds per-release W^X, the seccomp statement, the scope=self opt-in | **the lane's** (a superset) |
| `isolation/m4/guestd/supervisor-guestcert.mjs` | add/add | the lane adds the release naming and `wxCoverage` in the result; main's differs only by those lines' absence | **the lane's** |
| `relay/snp-verify.mjs` | content | main added `provenSnpChip` (used by `relay/tunnel.js`); the lane added ABI/2's `expectedBinding` to `verifyQuote` | **union**: main's `provenSnpChip` + the lane's `verifyQuote` signature |
| `windows/vbslike/datapath/datapath.mjs`, `node-bridge.mjs` | add/add | main's copies are the later M2 versions plus fixes (N4 etc.) | **main's** |
| `windows/vbslike/host/src/hcs.rs`, `isoprobe.rs`, `main.rs` | content / add/add | main's are M2's re-cut ("host/ is the shipped launcher's source") | **main's** |

**Recommended beyond the textual conflicts: leave `windows/` out of the merge entirely.** Everything the lane changes
there is either already on main in a later form (above) or was deliberately kept off main by the M2 re-cut on
enclave-d1's owner review: `HOST-PREREQ.md`, `PHASE2.md`, `test-win.cmd`, two evidence files, and the lane's
`datapath.test.mjs` / `node-bridge.test.mjs`. The last one is already RED on the lane itself (see "What the trial showed").

## What main's consumers would see
- **One judge again.** Today there are two: the NucBox node (main `c6347dd2`) and the v44 manager control (`9de5996a`)
  judge with main's pre-chain `judge.mjs` (sha256 `24311fe8…`), while SNP guestd on metal-iso0 judges with the lane's
  (`650b931d…`, tree `4cd26e58`). After Slice A, main's `judge.mjs` is the lane's, and the next node install and the next
  control tree both carry it.
  - judge-hv (main) already passes `legacyWx` and `seccompUnstated` to `checkRuntime`. Main's pre-chain `checkRuntime`
    ignores them (judge-hv enforces its per-image tables itself); the lane's enforces them too. The trial ran all 69
    Windows test files plus the isolation suites with the lane's judge: green (see below).
  - Live consumers do not change at the merge: the NucBox node changes only at a manual install, and SNP guestd only at
    63's tree swap. So there is no flag day: the per-release (SNP) and per-image (NucBox) tables already decide what each
    live guest must state.
- **A latent mismatch on main that the merge closes.** Main's `judge.mjs` already passes `expectedBinding` (ABI/2) to
  `verifyQuote`, but main's `relay/snp-verify.mjs` does not accept it, so an ABI/2 SNP document judged from main would
  fail its binding. Nothing in production judges SNP from main today (guestd runs the lane's tree), so it has not bitten.
  Slice B fixes it.
- **The supervisor image.** The lane's `supervisor.js` adds the per-app isolation tier (+917 lines), OFF unless
  `ISOLATION_BACKEND` is set. It loads the isolation modules only through dynamic `import()` on that path, and the
  Dockerfile copies no `isolation/` files, so the Tinfoil image still loads with the tier off.
- **The verifier bundle.** The committed verifier bundle's manifest pins its inputs by hash, and `relay/snp-verify.mjs` is
  one of them. Slice B must regenerate the bundle and its manifest in the same change (the trial showed the pin failing).

## How it could land: three slices, then the lane is tagged
| Slice | Paths | Deploy on push (the workflow's own detect arms, run on each slice's file list) | Gate |
|---|---|---|---|
| **A. The isolation source** | `isolation/**` without `*/evidence/` (code, tests, docs), the lane's `test/isolation-*`, `test/restore-*`, `.gitignore`, `.gitleaks.toml`: 265 files | **detect only**: every output false | the full node suite, Go (`isolation/contract`, `m2/front`, `m3/monitor`, `m4/guestd`), the C harnesses (`test-dominit-*`, `test-seccomp-statement.sh`, `test-domexec-*`); CI failing names = main's baseline (6 C/thread tests + pad-ack-receiver) |
| **B. The relay verifier** | `relay/snp-verify.mjs` (the union above) + the regenerated verifier bundle and manifest | **relay=true**: the relay job redeploys nan and nan-relay, which restarts the api relay (the NucBox tunnel re-attaches) | a relay window agreed with e3; never inside a freeze; the default `expectedBinding = null` keeps every ABI/1 caller's path byte-identical (tunnel attach included) |
| **C. The supervisor + metal** | `supervisor.js`, `metal/*` (the launcher's `isolation.release` forwarding, gsup's `ISOLATION_RELEASE`, `-ffile-prefix-map`), `test/metal-*`, `test/launch-spec.test.mjs`: 9 files | **release=true and cpu_release=true**: a measured Tinfoil release pair (GPU + CPU) and a metal `-cpu` tag | Steven's call (decision 3); verifier pins updated for the new measurement; metal boxes that follow `-cpu` tags rebuild at their next update (metal-iso0 runs a pinned prod worktree and does not) |

- The remaining lane changes are no-ops on main: `.githooks/*` and `.github/workflows/secret-scan.yml` are byte-identical
  already; `cli/enclave.mjs` takes main's; `windows/` stays out.
- Slicing by path gives up the lane's 312 commits as main's history. Each slice's message names the lane commit it
  snapshots, and a tag on the lane head (for example `isolation-lane-2026-09-26` at `4cd26e58`) keeps the full history and
  the evidence reachable. A single merge commit would keep the history but land all three deploys at once.
- After the slices, new isolation work starts from main, and the lane is retired.

## What the trial showed
A local trial merge (detached scratch worktree, never pushed): the 10 conflicts resolved as above (0 unmerged, both hand-
merged modules parse), then a guarded run (nice 19, concurrency 1, MemAvailable 81 GiB, PSI 0.00) of 91 files: the 69
Windows test files, the isolation suites, and every test importing `snp-verify`, the guestcert module or `judge.mjs`.
**830 of 836 passed.** The 6 failures, each checked against a control:
- 4 verifier-bundle reproduction tests fail on **unmodified main** too, in the same checkout layout: a symlinked
  `node_modules` makes esbuild embed another path (a known environment effect, not the merge).
- 1 is real and expected: "the manifest names this tree's inputs … with hashes that match" passes on main and fails after
  the merge, because `relay/snp-verify.mjs` changed. That is why Slice B must regenerate the bundle.
- 1 is a **pre-existing red on the lane**: `windows/vbslike/datapath/node-bridge.test.mjs` "the plan refuses exactly when
  supervisor.js's claim gate refuses" also fails at `4cd26e58` itself. The lane's 09-25 pool-accounting gate
  (`829ea21b`, `c42612c0`) refuses "no readable guest pool", and the lane's 09-24 NucBox parity test was never updated.
  Leaving `windows/` out of the merge drops the stale test; whether the NucBox plan should mirror a pool rule (the NucBox
  has no guest pool) is a question for enclave-5d, not a merge blocker.

Not yet run, and part of each slice's gate: the full node suite (~2,250 tests, in a fresh `npm ci` worktree so the bundle
tests are meaningful), the Go packages, and the C harnesses on the merged tree.

## Risks, in order
1. **Slice C is a production release.** It changes the Tinfoil supervisor image's measurement and publishes a release
   pair even though the tier is off. It needs your go and a verifier re-pin.
2. **Slice B restarts the api relay.** It is additive for ABI/1 callers, but it must not overlap the NucBox reboot freeze or
   a soak window.
3. **Stale copies.** The lane holds pre-M2 copies of Windows code. Taking the lane's side anywhere under `windows/` would
   regress the NucBox node (N4 and later fixes).
4. **Review load.** Slice A is 265 files, but every commit in it was reviewed on the lane (bf, 5d, d1, 99). What is new is
   only the conflict resolution (two hunks: `.gitignore`, `snp-verify.mjs`) and the choice of sides above.
