cutover-review NATIVE validation package for the frozen cutover candidate 943a5f01 - ROOT-ONLY. Prepared by Claude, never
executed by it. No remote call, upload or live mutation was made while preparing it. The frozen candidate and its
RESULT.json/REVIEW.txt are unchanged (re-verified).

WHAT ROOT RUNS (after reviewing run-native.py, native-test.ps1 and sim-guard.ps1)
  python3 run-native.py                      # default: PLAN ONLY, no network; prints manifestSha and every PowerShell text
  python3 run-native.py --execute --root-reviewed b626a708bfae450d1f594825877f58e92eabce98c8fdb3664826d16df3d7d73a
  - Refuses unless the 5 local files and transport c50aac8e match their pins, the token equals the reviewed manifest, and
    no native-attempt.json exists. That file is created with O_EXCL BEFORE the first remote call (one attempt; root decides
    about any retry).
  - Remote writes are limited to this run's own C:\ProgramData\Enclave\staging\cutover-review-native-<12 hex> stage: create
    (refuses an existing path), scp the 5 pinned files, verify the exact file count plus 5 FileSha pins on minipc, run
    native-test.ps1, then ALWAYS clean up after a create attempt and verify the stage is gone.
  - Exit 0 only when validation.pass is true AND cleanup.gone is true. Evidence goes to native-result.json.
  - Run it outside the \Enclave\Update window (hourly at :13:36 per the root snapshot). The fixture refuses its live part
    (exit 4) if Update is running or due within 300 s. Exit 5 = incomplete before-snapshot (refused).

SCOPE: EXACTLY WHAT IS READ-ONLY NATIVE VS SIMULATED
  NATIVE, READ-ONLY (genuine production entities, nothing changed):
    - Windows PowerShell 5.1 parse of all 5 staged scripts, including the full candidate (0 errors required).
    - A static scan: the 26 functions extracted from the candidate call no mutating cmdlet or helper (StopNode, StartNode,
      RestartPrivacy, NodeTask, Invoke-TaskCommand, Revert, CasWrite, ...). The fixture process also tripwires every
      mutating cmdlet (Stop-Process, *-ScheduledTask, Set-Acl, Remove-Item, Start/Stop-VM, ...).
    - The candidate's OWN bounded readers (Invoke-BoundedQuery/Query, which kill only their own child): NodeProcs gives the
      current cmd+agent identity. Same accepts the genuine pid+start and rejects a stale start and a wrong pid.
      OwnsAgentPort accepts the genuine agent as the single 9600 listener and rejects a wrong but real PID (the cmd.exe).
      HostState shows the old node has NO leaseReadiness. LeaseReady rejects the actual state.
    - AgentUp against the OLD production node, bounded to 25 s: it must prove ownership, poll host state at least twice,
      run out of its own deadline and return false. It must never synthesize readiness, and readiness must still be absent
      afterwards. AgentUp with the wrong PID must also refuse.
    - OBSERVATION COMPLETENESS (root review, fixture a7f288d7): manager VMs and Hyper-V VMs must be listed (unavailable or
      empty = UNOBSERVED), the manager pid@start must be non-empty, there must be EXACTLY one privacy-agent identity, and
      \Enclave\ task states must be read. An incomplete BEFORE snapshot refuses (exit 5, out.unobserved names each gap)
      before any identity/listener/AgentUp check. An incomplete AFTER snapshot marks those fields 'UNOBSERVED: ...' and fails.
      A missing observation is never reported as preserved.
    - Before/after preservation, compared field by field: node cmd+agent pid@start, privacy agent, manager pid@start,
      \Enclave\ task names=states, manager VM count+digest, Hyper-V VM count+digest, and the hashes of run-node.cmd,
      node-config.local.cmd, privacy-config.json, privacy-agent.mjs and agent.mjs.
  SIMULATED (child powershell.exe behind sim-guard tripwires; mocked clock, processes, task requests and queries): the
    frozen native-path test (6 checks) and the readiness cadence simulator (9.7/10.5/13/15 s, 60/60 required). This is
    CONTROL-FLOW evidence on the Windows interpreter only, NOT native operation proof.
  NOT PROVEN by this package: StopNode/StartNode/RestartPrivacy/Revert never run on a live entity, so there is NO native
    full-revert proof, NO new-node readiness proof (the live agent c223c043 predates leaseReadiness), and NO end-to-end
    timing for the 550 s recovery budget.

BOUNDS
  Fixture 870 s (30 static + 5 children x 120 s + live 240 s). Every live reader is capped by the candidate's
  Lim/Left at 240 s and by 15 s per query. AgentUp 25 s (+5 s allowed), wrong-PID AgentUp 15 s. Transport watchdog 930 s for
  validation and 40 s for create/cleanup. Get-ScheduledTask(Info)/Get-VM/Get-FileHash are direct reads, bounded only by
  the watchdog. Load on the production node: about 6 listener queries (~10 s each) and about 15 read-only GETs of
  127.0.0.1:9600/v1/host/state.

ROOT-UPDATE INCORPORATED (snapshot 2026-10-22T01:44:55Z)
  The snapshot hashes runNode 3366a005, localConfig 85698d20, privacyConfig d5810879, privacy-agent 7ef4e230 and live agent
  c223c043 are reported as rootSnapshotMatch. Drift is reported, never repaired, and does not fail the run (preservation
  does). The live agent is not the lease-readiness candidate 76cac355, so the AgentUp refusal is the expected result. A
  PRESENT leaseReadiness fails 'oldNodeHasNoLeaseReadiness' (precondition changed; root decides). The snapshot's minimum
  remaining lease was 480 s, below the 910 s requirement: this package is NOT activation permission.

LOCAL EVIDENCE (Linux pwsh 7 / python, shared queue, 512 MiB cap; NOT Windows evidence)
  fixture6: queue exit 0 (fixture6.guard.log; superseded runs in history/). Static-only pass with 5 parses at 0 errors and no mutator calls,
    sim-guard native-path 6/6, cadence 10.5 s 60/60. Negative controls: a failed cadence check (expect 61) exits non-zero
    through the dot-source; a live command inside a simulated test hits the tripwire; a changed staged byte refuses; a
    terminating error still emits one JSON line (rc 3).
  driver: 8/8 (driver2.guard.log). Plan mode makes no ssh/scp call. --execute without the reviewed token, or with a wrong
    one, refuses. Fake-transport runs show the attempt file exists before any call, the call order is
    create -> validate -> cleanup, uploads go only to cutover-review-native-<12hex>, the validate text carries all 5 pins
    and the file count, cleanup runs after a failed validation and after an unconfirmed create, an existing attempt file
    refuses before any call, tampered bytes are detected, and foreign cleanup paths are rejected.
  preservation1/fixture6: 10/10 focused checks AST-extracted from the exact fixture (unavailable or empty VM list, Hyper-V
    list, manager, zero or two privacy agents, no tasks: all UNOBSERVED both before-only and before+after, never preserved;
    error strings never count as true). Negative control: the previous fixture b231396f's inline logic returns
    oldPreservedClaim=true for an unavailable VM list (../probe/old-preservation-probe.ps1).
  driver2: 8/8 with the new pin. plan: plan.json via queue (plan2.out). Encoded sizes are create 1876, validate 4188 and cleanup 2224, all under the 7900 limit.
  Defect found and fixed while preparing: 'exit N' inside a dot-sourced test does not end sim-guard, so a failing
  simulated check would have reported success (history/fixture1.out FAIL). sim-guard now propagates $LASTEXITCODE.

LIMITATIONS
  Windows PowerShell 5.1 behaviour of the two simulated tests was never run locally (pwsh 7 only); a 5.1 incompatibility
  would show as a simulated failure. Whether the ssh account can read Get-VM is unknown: if it cannot, the fixture now
  REFUSES (exit 5, 'hyperv: Hyper-V VM list unavailable or empty'), which is the intended conservative result. Root then
  decides whether to run with an account that can read Hyper-V.

IF CLEANUP IS NOT VERIFIED
  Confirm no fixture powershell.exe from this stage remains, then remove only
  C:\ProgramData\Enclave\staging\cutover-review-native-<hex>. No production state is ever changed, so there is nothing
  else to roll back.
