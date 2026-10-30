# Windows native readiness gate: inputs and runner (PREPARED; the test was NOT run; no PASS claimed)

**Scope:** native-PowerShell **gate** qualification for r12's only NOT-RUN test. This is **not** proof of a Windows live RPC cutover.

**What Claude did:** read files and git objects (`--no-optional-locks`), plus one capability query, `pwsh --version`.
- **Not done:** no tests, installs, builds of product code, SSH, remote copies, network access, public RPC, VM/app/service changes, or commits.
- **Untouched:** r12 (its `SHA256SUMS` still verifies).

## The gap

`test/windows-node-lease-readiness.test.mjs` (candidate `debbfb37…`, blob `8a062407…`) gives 8 pass and 1 skip in **both** the route baseline and final.
- **The skipped test:** test 9, "actual Host readiness serializes into the exact cutover gate; a cold successor is refused".
- **Its skip conditions** (`:76-78`): `PWSH` unset, or `../../cutover/tools/gate-from-report.ps1` (relative to the test) absent.
- **What it runs** (`:81-87`): `$PWSH -NoProfile -NonInteractive -File <tools>/gate-from-report.ps1 -Script <tools>/../helper/node-hold-cutover.ps1 -Fixture <fixture>`, and it asserts ready = true for the actual Host and false for a cold Host.

## Existing inputs (found; nothing new created)

| Input | Path | Identity |
|---|---|---|
| `gate-from-report.ps1` | `work/lease-readiness-20261022/cutover/tools/` | sha256 `08d6dff1b13abf1c6d117a0e3f678fcc9fd0206122c866b41ccc2f5f36d84fc9`; **the only version** among 46 workspace copies |
| `node-hold-cutover.ps1` | `work/lease-readiness-20261022/cutover/helper/` | sha256 `f1cd279d63f072367103f2210f318435eb2811f5848a8acc65009be22a93cd02`; only version among 46 copies |
| PowerShell | `work/node-hold-package-20261021/tools/pwsh/pwsh` | **PowerShell 7.4.6**; apphost sha256 `827b5d8e…`; tree of 610 entries, digest `45b346f4c3aede929185c61b0e7baa40c6574bf612ac13d9d17f4c5528eaf014`; recorded in that package's `PACKAGE-RESULT.txt:211` ("pwsh 7.4.6") |
| Prior use | `work/lease-readiness-20261022/run-readiness.sh:3` exports this exact `PWSH` | `readiness.out:51`: test 9 **ran and passed** then (memory-guard peak pwsh 174 MiB, `cutover.out:10`) |

**Why a local Linux PowerShell is faithful here:** `gate-from-report.ps1` AST-parses the helper and dot-sources **only** `ReadinessNumber` (5 lines) and `LeaseReady` (21 lines).
- These are pure: their only external references are `$PRM.expectedIds`, `$PRM.lease` and `$PRM.runner`, which the gate sets from the fixture.
- The helper's Windows-only parts (Get-CimInstance, Get-VM, ACLs, scheduled tasks) are never executed by the gate.
- Both functions are byte-identical in the later helper revision `work/node-prepared-config-20261022/helper/node-hold-cutover.ps1` (`190860…`).

**Remote Windows (NUCBOX_K11) is therefore not needed.** No SSH command was issued, and no remote staging is proposed.

## Runner (`windows-native-readiness-stage/`, `SHA256SUMS` sha256 `8cd17f23c5b1911b6b2703583c3be3d54cea5058457d8b319fef5654e7b249a0`; `jobs/root-native-readiness.sh` `7ca2e52e…`)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/windows-native-readiness-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $ST/logs/root-native-readiness.guard -- unshare -rn bash $ST/jobs/root-native-readiness.sh > $ST/logs/root-native-readiness.out 2>&1; echo $? > $ST/logs/root-native-readiness.rc
```

**What it pins and checks:**
- the test, `fake-base-rpc.mjs` (`06bbcd5a…`) and `chain.mjs` blobs; the test itself is **unchanged**;
- both `.ps1` hashes, the PowerShell apphost and tree digest, and `--version` = 7.4.6.

**Setup:**
1. a private `git archive` of the candidate;
2. the two `.ps1` files copied to `<run>/cutover/{tools,helper}`, which is exactly `../../cutover` from the test;
3. `node_modules` linked read-only, with r12's `DEPS.txt` identity;
4. the network runtime built, as in r12's fixture context;
5. `PWSH` set for this one test, with telemetry off and a private `HOME`/`TMPDIR`.

The test fixture is its own local `fake-base-rpc`, so no public RPC is involved.

**PASS** requires rc 0, `# tests 9`, `# pass 9`, 0 fail, skip, todo and cancelled, **and** `ok 9 - actual Host readiness…` present, i.e. the native gate actually ran.

**Memory:** cap 512 MiB. The earlier observed peak was pwsh 174 MiB plus node; pwsh is spawned twice, sequentially.

## Not established

- **Unrun:** the result of this run.
- **Out of scope:** any Windows-host behaviour beyond these two pure functions (process, VM and ACL handling of the real cutover), and any live RPC cutover.
