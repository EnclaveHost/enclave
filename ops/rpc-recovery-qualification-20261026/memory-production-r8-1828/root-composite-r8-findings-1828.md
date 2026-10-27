# Root review of prepared r8 (not production-ready)

Actual ten unit tests passed in0.754s, peak54MiB, minimum host23642MiB, no warnings/skips, on the existing256MiB small lane. Root reviewed all cases: fake cgroup/setter, own tiny temporary files and subprocesses, read-only own scope. No actual FUSE, real scope mutation, production view or DB read. Full4096 concurrent-main reservation+16GiBfloor unchanged. The script comment suggests512main but tests are safe on256; record actual lane honestly.

Two concrete operational blockers found in source review:
1. The documented stop-session command calls r6/jobs/stop-session.sh, whose process binding requires an argv entry ending composite_session.py. New r8 runtime argv is memory_gate.py runtime, so the documented safe stop refuses. Supply a new narrow identity-bound helper for r8 (prefer pidfd with identity recheck to avoid PID reuse), retaining r6 helper unchanged and testing mismatch refusal/owned stop.
2. jobs/root-composite-validate.sh computes jrc from final job checks but ends exit $rc. When runtime returns0 yet peer changes, mount/process leftovers, missing/malformed final receipt occur, the shell can exit0 despite structurallyCleanRun false or receipt generator failure. Final job status must be nonzero on any failed final evidence without masking already-nonzero runtime classifications; test actual shell decision paths.

Independent Claude review1827 pending. r8 must remain inactive despite the unit PASS. Canonical validation remains separate and preservation incomplete.
