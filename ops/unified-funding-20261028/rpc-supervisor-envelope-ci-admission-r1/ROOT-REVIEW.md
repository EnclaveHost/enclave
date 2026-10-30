# Supervisor envelope source review

Maintained BoundedWorker adds optional one-shot self-assignment before any Run. Fixed128/256MiB job commit limits, CPU1 placement, four active processes including owner. Lifetime handle retained before assignment; no finalizer/detach/retry. Post-assignment exact membership/limit readback and PID/creation receipt; failed entry poisons later Run. Snapshot bootstrap private bytes must be positive and<=64MiB; this is not a peak or prior-allocation enforcement claim. Microsoft explicitly states AssignProcessToJobObject does not examine earlier allocations.

https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit
https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-allowhardterminate

Hosted CI candidate enters256MiB only at top-level harness. Three new cases verify receipt, one-shot refusal and failed-entry gate; original8 exercise child jobs nested under the owner. Inner128MiB memory-refusal case does NOT prove outer256MiB exhaustion. No child/main/supervisor dispatch changed. Same fixed three-source workflow, exact commit verification and disposable deadlines,20s compiler/30s harness. No target-native or VM/provider action admitted.

Future target context selected SYSTEM scheduled task, not SSH/admin. Task duration is a potential independently owned backstop; it is not RAM enforcement or observed death. A separate128MiB observer job does not kill a different owner on observer death. Pre-resume exact-handle observer handshake and target expiry/death test remain missing. No claim guardian implemented. Source-only until separate reviewed CI. Peer identified invalid-argument and receipt-allocation ordering gaps; both repaired. First invocation is consumed before validation; complete receipt construction precedes enabling work. Final narrow correction review pending. No dispatch yet.

Prior8PASS executable5bb8dd6e6c56328b5877b5ba6e0836d97c39bc63b59630669a8bbfa9a60efd1c remains immutable and is not this candidate. Product references/evidence preserve priorcommit f5bb2df8ff8d9967068ca5f5909bef1719761904.
