installer-r5-native: NATIVE WINDOWS POWERSHELL 5.1 VALIDATION OF install-host r5 / update-host r5 (ROOT-ONLY)
Prepared by Claude; never executed by it. No remote call, upload or live mutation was made while preparing it.

WHAT ROOT RUNS (after reviewing run-native.py, native-test.ps1 and fakebundle/install-host.ps1)
  python3 run-native.py
    Default is PLAN ONLY, with no network call. It prints the manifestSha and every PowerShell text.
  python3 run-native.py --execute --root-reviewed b8115834e8c91d218825e637b1327235a8b044bd6fd278aac415d569864bd2d9
  - It refuses unless all 6 local files and transport c50aac8e match their pins, the token equals the reviewed manifest,
    and no native-attempt.json exists. That file is created with O_EXCL BEFORE the first remote call: one attempt, and
    root decides about any retry.
  - Remote writes go ONLY to this run's own C:\ProgramData\Enclave\staging\installer-r5-native-<12 hex>.
    1. Create it plus fakebundle\ (refuses an existing path).
    2. scp the 6 pinned files.
    3. Verify the exact recursive file count and the 6 FileSha pins on minipc.
    4. Run native-test.ps1.
    5. ALWAYS clean up after a create attempt and verify the stage is gone.
    Fixture-local files (fx-* folders) are written only inside that stage.
  - Exit 0 only when validation.pass is true AND cleanup.gone is true. Evidence goes to native-result.json.
  - The ssh account must be an elevated administrator, as for the sibling packages. The fixture creates one protected
    fixture dir with owner BA.
  - Unlike the cutover package, no \Enclave\Update window applies: nothing here reads or touches a task.

PINNED BYTES
  install-host.r5.ps1           1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721  (proposed, ../src)
  update-host.r5.ps1            36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112  (proposed, ../src)
  install-host.r4.ps1           f19dbc19ae19a698c7ded64b1023a502af3e627694728f4bb741407a091b5620  (frozen control, ../frozen/src)
  update-host.r4.ps1            a2ba7b3bb4256d8a049fec84086da45517bfe0c42e2b623aabd18aeb7070a79c  (frozen control, ../frozen/src)
  fakebundle/install-host.ps1   7ccda0fb9eccbf317f1497a73de94adb65ae549aa61672c4c9c0c6633e9333d2  (HARMLESS stand-in)
  native-test.ps1               023f59f9a1e8cb4f9b4ccdf51b0288285935471d266223595a3e7fcee1f31936  (fixture)

NO REAL INSTALLER, NO PRODUCTION ENTITY
- The installer and updater files are only PARSED, and single functions are AST-extracted from them; neither script is
  ever run as a whole.
- The ONLY child installer ever invoked is fakebundle\install-host.ps1. It prints one stdout line and ONE stderr line,
  sleeps 3 s, writes a marker only inside its own stage (prefix-checked), and exits 7. The fixture re-checks its pin
  right before Install runs it.
- Every live-reading or mutating cmdlet is a TRIPWIRE that throws in the fixture and in each part:
  - Get-CimInstance, Get-ScheduledTask(Info), *-ScheduledTask, Stop/Start-Process, *-VM, *-Service, Restart-Computer;
  - Set-Acl, Set/Add-Content, Out-File, New/Remove/Move/Copy/Rename-Item, Invoke-RestMethod/WebRequest,
    Get-NetTCPConnection.
- Writes go only through a path-prefix guard: Set-Content (for the exact Save-InstallStatus), WriteAllText, and
  CreateDirectory. A path outside the stage throws.
- The part processes are the fixture's own [Diagnostics.Process] children, killed only if they overrun 90 s.

EVIDENCE CLASSES (each check is tagged in the result)
  native-interpreter: real Windows PowerShell 5.1 Desktop. The fixture refuses with exit 4 on any other edition.
  - The 5.1 parser on all 6 files (0 errors).
  - The EXACT updater Install (AST-extracted) running the stand-in through a real child powershell.exe:
    - r5 must return 7, log the stdout AND stderr lines, and let the stand-in finish (marker written);
    - CONTROL r4 must THROW under "Stop" at the stderr line (IR-3 reproduced natively).
    Informational: whether the r4 stand-in still completed after the throw (r4ChildCompletedAfterThrow) and the
    exception type. This settles the open question in REVIEW.txt IR-3 about whether 5.1 kills the child.
  - The exact Test-PrivateDir on a real protected SY/BA fixture dir (Get-Item/Get-Acl), and the exact Save-InstallStatus
    write followed by Get-EarlierPending's read (statusBomR5 records the 5.1 UTF-8 BOM, IR-7).
  - The exact Get-ReleaseDependency reading real fixture wrapper files: a quoted -Command "& 'C:\...ps1'" wrapper, and
    a %ProgramFiles% wrapper with real environment expansion; own-source and hs2-shaped actions stay independent.
    CONTROL r4 misses both (IR-2 reproduced).
  mocked-task-semantics: control flow ONLY. Task Scheduler, process lists and every start/stop/kill are in-memory mocks
  recording events; the functions are the exact Stop-ForInstall / Restore-OtherTasks / Save-InstallStatus.
  - r5: Relay and OpDisabled, recorded PENDING by an earlier install, are read; Relay is started exactly once; OpDisabled
    (operator-disabled) is never started; hs2 is untouched; the status is rewritten with Relay running and OpDisabled
    operator-disabled.
  - CONTROL r4: Relay is not restarted (IR-1 reproduced).
  This proves NOTHING about real Task Scheduler start/stop, Running-state timing, process trees or WMI semantics. Those
  remain for the sandbox list in ../REVIEW.txt section 5.

BOUNDS
- Fixture: 600 s (6 parts x 90 s, plus parse).
- Transport watchdog: 660 s for validation, 40 s for create and for cleanup.
- Encoded commands: create 2032, validate 4704, cleanup 2208 (limit 7900).
- There is no load on production; the stand-in sleeps 3 s twice.

LOCAL EVIDENCE (Linux pwsh 7.4 / python, shared queue; NOT Windows evidence)
- fixture3.out, queue EXIT 0, 6/6 on the final fixture bytes (tools/fixture-test.py, -LocalSmoke; a shim powershell.exe
  execs pwsh). Every case builds its own temp stage and verifies afterwards that no fixture process is left, nothing is
  written outside the stage, and the stage is removed.
  - Positive: 11 PASS. The 4 Windows-only checks are SKIPPED, not passed: r4 throw, native ACL, C:\ quoted wrapper, r4
    wrapper control. pwsh 7.4 does not apply "Stop" to redirected native stderr, so locally r4 does NOT throw. That is
    expected and is why that check is Windows-only.
  - Negatives:
    - a tampered pinned byte gives exit 3 before any part;
    - a wrong expected exit code (7 -> 8) gives exit 1 naming the failed install.r5 check;
    - Stop-ScheduledTask inside a part hits the TRIPWIRE (part exit 3) and fails the run;
    - a write to /tmp outside the stage hits the TRIPWIRE;
    - a part overrunning a 1.5 s bound is killed, reported timedOut, and fails the run.
- driver.out, EXIT 0, 10/10 (tools/driver-test.py):
  - plan mode makes no ssh/scp call; --execute without the token, or with a wrong one, refuses;
  - the pins are r5 1d1580c8 / 36f9e0d6 and r4 f19dbc19 / a2ba7b3b, and the fixture carries the same pins;
  - with a fake transport, the attempt file exists before any call, the order is create -> validate -> cleanup, the
    create makes fakebundle\, and uploads go only to installer-r5-native-<12hex>/<relative path>;
  - the validate text carries all 6 pins, the recursive count of 6 and no -LocalSmoke;
  - cleanup runs after a failed validation and after an unconfirmed create, and a pass without a verified cleanup is not
    ok;
  - an existing attempt file refuses; tampered bytes are detected; foreign cleanup paths, including the cutover-review
    prefix, are rejected.
- plan.json, EXIT 0: the plan-only output.
- history/: superseded runs.
  - fixture1: 5 FAIL, because `R` resolves to the built-in alias of Invoke-History, and Join-Path 'C:\...' failed on
    Linux. Both fixed in the fixture.
  - fixture2: 6/6 before the final owner-SDDL edit.
  Recorded, not counted.

LIMITATIONS
- The Windows PowerShell 5.1 runtime itself was never run locally. A 5.1 surprise shows up as a FAIL, or as exit 4 on a
  wrong edition; never as a pass.
- If minipc's ssh token is not an elevated administrator, creating the O:BA protected fixture dir throws and the
  pending.r5 part fails. That is conservative, and root decides.
- If the r4 control does NOT throw natively, IR-3 is refuted for this host. The run then fails on that CONTROL check
  only, and the r5 checks still show whether r5 is correct.

IF CLEANUP IS NOT VERIFIED
  Confirm no fixture powershell.exe from this stage remains (the stand-in ends within about 3 s). Then remove only
  C:\ProgramData\Enclave\staging\installer-r5-native-<hex>. No production state is ever changed, so there is nothing
  else to roll back.
