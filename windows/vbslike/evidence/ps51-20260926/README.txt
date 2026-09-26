PS 5.1 checks on the box (NUCBOX_K11, Windows PowerShell 5.1.26100.9444 Desktop) of the uefi-dev-boot versions v44 pins. Done by enclave-d1 (times read with date -u / on the box).
All runs used copies in scratch dirs under C:\Users\claude\. Test 1 was untouched.

d3f14dca/ (the fail-closed Read-Setting; bf GO), 07:35:24Z. ParseFile only, nothing executed.
- parse.ps1 = the script (fed on stdin); parse-result-0735.txt = its output.
- uefi-dev-boot.ps1 6124105a…: 0 errors.
- The rendered watchdog: 0 errors in all 4 prior states.

22b73629/ (5d's probe-judge fix on d3f14dca; bf GO; v44's pin).
- 07:45:02Z: ParseFile of all three files, 0 errors (parse.ps1, parse-result-0745.txt).
  An earlier attempt at 07:44:53Z had a sed-mangled path: it read nothing, parsed nothing and changed nothing.
- 07:46:50-07:46:52Z: BOTH test files RUN under PS 5.1, on enclave-87's (b) GO (run51.ps1, run51-result-0746.txt).
  - judge-probe.tests.ps1 ran as is: 50 ok, "judge tests: ALL OK", exit 0.
  - firmware-setting.tests.ps1 ran ONLY as a copy, firmware-setting.tests.sandbox.ps1. It differs in line 26 alone: $RegPath is a
    NONEXISTENT HKCU path (HKCU:\Software\EnclaveFwTest-20260926T074622Z-absent), so a missed stub could not reach the
    production key. Result: 27 ok, "firmware-setting tests: ALL OK", exit 0. The output equals pwsh 7.6.6's on ws line for line.
  - HKLM Virtualization, read before, between the two runs, and after: every value (name, value, kind) and the
    GuestCommunicationServices subkeys were IDENTICAL. AllowFirmwareLoadFromFile = 1 (DWord) throughout.
  - The sandbox key never existed, before or after, so there was nothing to remove.
  - *.ps51-output.txt are the box's own output files (UTF-16LE, as PS 5.1 redirection writes them).
