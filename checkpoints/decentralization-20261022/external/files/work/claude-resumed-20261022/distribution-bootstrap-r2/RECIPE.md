# Root-only recipe r2: native C# compile and test (B6). Supersedes r1's recipe N; B3 unchanged

Nothing here has run on a host. No step installs, downloads, signs or publishes. Root's assembly package is not touched.
Do NOT execute r1's plan (manifest 825e6a1a). Keep `distribution-bootstrap/` as evidence.

## N2. Native compile and test with the in-box compiler

```
cd work/claude-resumed-20261022/distribution-bootstrap-r2/native
python3 run-native.py                                     # PLAN ONLY: review texts; manifest 342faaeb...
python3 run-native.py --execute --root-reviewed 342faaebe4017d8296abcc7fff8c71e4d8e0a2bb2c8c1a411f40decc2d4d764c
```

- Stage: `C:\ProgramData\Enclave\staging\distribution-bootstrap-r2-native-<12hex>`, 16 pinned files in repo layout. The
  15 r1 files are there, with EnclaveSetup.cs 5567d0ec, BootstrapCheck.cs 023d8d57 and native-bootstrap.ps1 8bbaf7ed.
  The new file is the existing `bounded-query.ps1` 3a07a15f, unchanged.
- One attempt (`native-attempt.json`, O_EXCL, before the first call). Transport c50aac8e. Fixture bound 900 s
  (120 s of it is the cleanup reserve), transport 960 s.
- **No `-ExecutionPolicy`.** The fixture and the harness run under minipc's existing policy, which the result records
  (`executionPolicy`, `executionPolicyList`). If the policy refuses them, the result is `REFUSED`. Changing the policy
  is root's decision and is not part of this package.
- Run it from the elevated administrator ssh token. Without Administrator the harness SKIPs SecureWorkDir, and the
  result is then PARTIAL.

Fixture steps (each child bounded by the remaining global time; exit confirmed):
1. PS 5.1 parse of `cli\host.ps1`, install-host r5, update-host 36f9 and the harness.
2. `EnclaveSetup.exe` with build-setup.cmd's flags, without `/win32icon`. It is hashed, **never started**.
3. `BootstrapCheck.exe` checks:
   - P1–P6 (r1);
   - **P7**: a policy still open for writing elsewhere is refused and not copied;
   - **P8**: exactly 64 KiB pins whole over a stale copy, 64 KiB + 1 is refused, and no temp file is left;
   - Q1/Q2 through the real `CommandLineToArgvW`;
   - `INFO utf8Glyphs`.
4. `test\windows-native\run.ps1` with `-Node` (node.exe b3094d0b) and TEMP set to the fixture's own folder.
5. A port-file stop for a timed-out harness. Then every own process (named by this run's unique folders) is killed by
   pid + start time and confirmed gone by a second query. Removal happens only after that.

Read `native-result.json` → `status`:

| status | meaning | stage |
|---|---|---|
| `PASS` | all 4 checks, the Node re-judge passed, 0 SKIP, work folder removed, ≤ 900 s | removed + verified |
| `PARTIAL` (exit 6) | everything that ran passed; `partialReasons` names what is missing (no node / SKIP) | removed |
| `FAIL` | a check failed or never ran (`notRun`, `checks`, `harness.failLines`) | removed |
| `REFUSED` | the execution policy refused the fixture or the harness (`refusal`/`output`) | removed |
| `PRECHECK` | stage file count or fixture pin mismatch before anything ran | removed |
| `UNKNOWN` (exit 5) / `NO-RESULT` / `NO-REPORT` | a child's exit could not be confirmed, or no terminal report | **left**: `cleanup.recovery` |

Only `PASS` is native evidence of the full suite. For UNKNOWN, NO-RESULT or NO-REPORT, nothing was removed:
- `cleanup.recovery.stage` names the stage; `left` (fixture work folder under that account's %TEMP%) names the rest.
- First do a read-only check for processes whose command line names those folder names.
- Remove the folders only after none remain. This is root's separate, reviewed step; nothing for it is pre-made here.

`setupBuild.exeSha256` identifies this build only (csc 4.x is not deterministic). Whether to ship is root's decision.

## B3. Config persistence before any release install (unchanged from r1)

`b3/` is byte-identical to r1. Plan cccb6b6a is still valid; follow r1's RECIPE.md section B3. Worker 54825 owns any
node-policy edit.

## Integration (after a native PASS; root's decision)

`src/EnclaveSetup.cs` 5567d0ec replaces `windows/installer/EnclaveSetup.cs`:
- `src/EnclaveSetup.frozen-to-r2.patch` 7d3236f7 applies to the frozen e55a8a90;
- `src/EnclaveSetup.r1-to-r2.patch` 29be8ef5 shows only the finding 1 change.

No commit or push is made here.
