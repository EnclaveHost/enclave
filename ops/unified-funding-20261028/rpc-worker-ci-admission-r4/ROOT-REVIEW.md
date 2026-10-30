# Changed parent-death fixture admission

Actual CI41137051967 at83375b288713479c2db588773f075bbebacf2e54 compiled successfully (1634ms); harness failed after2797ms with five PASS and one FAIL. Exact parent and child exited; fixture incorrectly required nonzero kill-on-close exit code. The two remaining cases were not reached. Original logs and compiled artifact are retained; no rerun.

Only the fixture assertion changes: stopwatch before supervisor spawn, exact creation-bound handles, both alive before kill, waits clipped to remaining4000ms and exact parent/child exit observed strictly before4000ms. This excludes helper natural5000ms sleep and supervisor4000ms deadline, which starts after spawn. Actual exit codes are diagnostics. Evaluation precedes fallback cleanup; every error still attempts exact handle cleanup. Product source and limits unchanged. Peer read-only assessment agrees this corrects the test rather than relaxing product behavior.

Root admits ONE separate exact-commit disposable Windows CI dispatch after preservation. Same fixed three-source delivery, compiler20s/harness30s, hosted3min jobs, bounded publication, no production credentials/data/provider/VM actions. No automatic retry. This does not admit production host execution or establish provider fencing/reservation release.
