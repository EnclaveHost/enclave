CONFIG NATIVE FIXTURE: one bounded, root-reviewable native Windows PowerShell 5.1 SCRATCH run of the UNCHANGED r3
migrate-local-config.ps1 (d2ae8f69...) on DUMMY data. Claude, 2026-10-22. Source plus local tests only; never run natively by Claude.
config-persistence-r3 is immutable and untouched (its script is copied byte-exact into stage/).

WHAT IT PROVES (beyond root's C# primitive test, which proved the APIs but not PowerShell overload binding or full-script behaviour)
- The real script runs through `powershell.exe -NoProfile -NonInteractive -File` (no AST extraction, no dot-sourcing, no
  EncodedCommand), on plan -> execute with the EXACT planSha it printed.
- Case c1:
  - a SYSTEM-owned node hook with a distinct DACL (SYSTEM read-only) keeps its owner, its exact DACL SDDL and the expected new
    bytes;
  - the backup holds the original bytes and owner, in a new private directory;
  - the new Shield hook is Administrators-owned, protected, SYSTEM/Administrators only;
  - no replacement temp is left; the source launcher is untouched;
  - the re-plan has nothing to change and writes nothing.
- Real cmd.exe (`cmd.exe /d /c <dummy launcher>`, printing `set ENCF_`):
  - the effective ENCF_* values before migration equal those after migration plus an r6-style launcher rewrite (no set
    lines), covering plain, quoted-with-space, conditional (`if not defined`), same-name/different-value and
    already-persisted lines;
  - CONTROL: the same rewrite WITHOUT migration loses exactly ENCF_GATEWAYS, ENCF_OWNERSHIP, ENCF_PINS_FILE, ENCF_SLOTS and
    ENCF_STARTUP (node) and ENCF_SHIELD_DEBUG (shield).
- c3: nothing to move; MIGRATED with no write; the Shield hook stays absent.
- c4: a bad (name, value hash) pin -> REFUSED, nothing written.
- c5: a wrong planSha -> REFUSED, nothing written.
- c6: a file symbolic link as the node hook -> REFUSED. If this token cannot create one, the check is UNKNOWN (never a pass);
  no privilege is enabled.
- c7: a directory junction (cmd's mklink /J, inside the scratch tree only) as -Root -> REFUSED.
Values are dummy and non-secret: *.invalid hosts, 0x1111.. addresses, C:\dummy paths.

SCOPE / SAFETY
- Only the fixture's own stage C:\ProgramData\Enclave\staging\config-native-fixture-<12 hex> is created, written and removed.
  Fixture.exe refuses any other stage path.
- Inside it, a scratch tree fx\ is created with a protected SYSTEM/Administrators DACL at creation. Every dummy file is
  created exclusively (CreateNew) with its descriptor (owner included) at creation.
- No production file is read or written; no launcher, agent, installer, task or service is started.
- No execution-policy argument or change, no privilege change, no ACL change outside fx\.
- Processes:
  - children are only csc (compile, by the inline step), powershell.exe -File (the script), one read-only
    `powershell -Command Get-ExecutionPolicy -List`, and cmd.exe (the dummy launchers, and one mklink /J);
  - each is bounded (60 s / 15 s), ENCF_* stripped from its environment, killed through its own handle on timeout;
  - all run inside root's reviewed FixtureJob (b82285d6, byte-exact copy). Its drain touches only this fixture's own job
    members; there is no global process scan.
- Links: the fixture deletes only the links it created, never through them. A final non-following scan of fx\ must find 0
  reparse points.
- Bounds: Fixture.exe has a 360 s internal deadline plus a 10 s job drain; the inline run is 420 s; the transport 520 s.
  Child output is capped at 64 KiB.
- Execution policy: the host is Restricted. Fixture.exe never sets a policy. Its powershell children run with the environment
  the fixture inherited. Under Restricted the first -File is reported as "BLOCKED by the host's execution policy" (FAIL, not a
  pass) and nothing works around it. Whether a process-scoped policy is authorized, and how, is the user's/root's decision,
  outside this package. Note: RemoteSigned would not block these files, since scp-copied files carry no Zone.Identifier.
- Cleanup: the wrapper removes the stage only when cleanup is CERTAIN (Fixture.exe exited by itself and reported cleanupClean,
  or nothing ran beyond the compiler). Otherwise it is LEFT and recorded in root/result.json. attempt.json is created
  exclusively (one attempt).

PREREQUISITES (root)
1. Root's reviewed transport work/nucbox-tls-20261021/root-activate-reviewed.py c50aac8e, and SSH to minipc as for root's
   component tests.
2. csc v4.0.30319 at %WINDIR%\Microsoft.NET\Framework64, as root's tests used; System.Web.Extensions.dll is referenced.
3. A decision on execution-policy authorization (see above). Without it the run is expected to report BLOCKED and clean up.

STEPS
1. python3 root/native-config-fixture.py
   -> plan, no network: manifest fd596ab1838f2d6326cd9306e83d3d71ea10b44a25323f36423f8bff71bebf29, 18 files, inline 1707 chars.
   Review native/ConfigNativeFixture.cs, the copied FixtureJob.cs (= root's b82285d6), stage/ (the r3 script, the dummy .cmd
   files, the pins, expected.json, fixture-manifest.json) and the wrapper.
2. python3 root/native-config-fixture.py --execute fd596ab1838f2d6326cd9306e83d3d71ea10b44a25323f36423f8bff71bebf29
   -> root/attempt.json, then root/result.json:
   - validation.build / validation.test;
   - fixture: one JSON line from Fixture.exe with checks[] (PASS/FAIL/UNKNOWN), counts, blockedByExecutionPolicy,
     executionPolicyAsInherited, reparseLeft, jobCleanup, cleanupClean;
   - cleanup.
   PASS = every check PASS and ALL PASS. Any FAIL or UNKNOWN is a finding, never a pass.

LOCAL EVIDENCE (pwsh 7 / Python on Linux; NOT native)
- test/plan_linux.py, PLAN-LINUX PASS (logs/plan-linux1.out): the unchanged r3 script's plan/execute on the same dummy files
  with the reviewed r3 mocks -> stage/expected.json (planned/after hashes, the effective ENCF_* sets, the control loss,
  plain/badpin outcomes).
- test/local_tests.py, 6/6 (logs/local6.out):
  - pins: the r3 script is byte-identical; FixtureJob is byte-identical to root's; the manifest is exact;
  - the wrapper plan is offline, and --execute with a wrong manifest exits 2 writing nothing;
  - the inline text encodes under the transport's 7900 characters;
  - static scope: no -ExecutionPolicy argument, Set-ExecutionPolicy, PSExecutionPolicyPreference, EncodedCommand, Bypass,
    privilege, task or service string; powershell started only with -File on the staged script or the read-only policy
    list; every ProgramData\Enclave path is the fixture's staging pattern;
  - a C# 5 language-level parse of both C# files: 0 errors;
  - the parse's NEGATIVE control (C# 6 interpolation and ?.) fails with 2 CS8026.
- NOT locally possible: compiling or running the C# (no csc/mono here), and anything Windows-specific. The C# was written for
  csc v4 (C# 5) and checked only by the parse above.
