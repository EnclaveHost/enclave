S4 ON warden-host: install release 31d117a9 (image d1a38994) beside the live one, then activate guestd -release (4d)
Owner: enclave-63. Procedure: 5d's INSTALL.md (isolation/m4/evidence/production-release-d1a38994/, 023b06be).
Nothing here has run yet. Every script refuses on any mismatch before its first mutation.

  scripts/s4-install.sh        1b, 1a, 1d: the clean d1a38994 worktree ~/enclave-prod/iso-d1a38994, the verified release
                               copy ~/enclave-prod/release-d1a38994, and guestd's own template build from the installed
                               tree reproducing 31d117a9 on this host. INERT: guestd's MainPID/ExecStart and the m2-gd*
                               units are compared before and after. Codex authorized it once enclave-e3 (99's lane)
                               has reviewed it and the reproduction checks pass.
  scripts/s4-guestd-install.sh 1c: ~/enclave-prod/bin/guestd.<merge>, built twice from the merge carrying d1a38994's
                               release services AND the host floor (d67b0020 + 1b5375c9); refuses anything else. INERT.
  scripts/s4d-apply.sh         4d, the activation, gated separately. See its header for the preflight, the single
                               ExecStart edit and the auto-rollback post-checks.
  scripts/s4d-rollback.sh      Back to the budget-64 unit (guestd.c42612c0, iso-03be27d6). It runs standalone only
                               while the 3 S0 canaries alone run; the apply's own failure path passes FROM_APPLY.
  scripts/s4-abandon.sh        Abandons a partial install while it is inert: the worktree removed under the flock (never
                               rm -rf), then the release copy; refuses if guestd's ExecStart references either.
  scripts/lib4.sh              Shared ids and checks (sourced after ../pool-rollout-2026-09-25/scripts/lib.sh).
  v1 -> v2 (scripts-s4-v2.sha256, diff-v2-*): enclave-e3's review. snap()/units() FAIL CLOSED (an unreachable user
  bus printed nothing, so BEFORE == AFTER passed vacuously; now exactly 3 canary units, each active/running with its
  own MainPID, and guestd's MainPID and ExecStart must read); the abandon script and an EXIT trap naming it; 1a without
  a tee|grep -q pipe; `install && mv` and `cp && mv` split so set -e sees a failure. Tested: live rc 0; no user bus,
  a 2-unit shim and a failed-canary shim all fail closed.

Checked from source for 4d (d1a38994):
  - adoptOne applies the same conditions as c42612c0's; old records lack Release/Legacy, which read false;
  - the canaries' CIDs (65536-131071) sit below guestd's new band (131072-196607);
  - a -release guestd whose vsock listen fails exits (log.Fatalf), so the journal's "attested release ON" line proves
    both listeners;
  - the live supervisor (c42612c0) reads pool.budget/allocated/free/perGuest only, so the new pool.host block and
    supports.release change nothing in its claim gate.
Dry-tested without touching production:
  - the -h flag check discriminates: d1a38994's guestd lacks only -guest-host-floor-mib, and the floor branch lacks
    only the release flags;
  - both unit edits run on a copy of the live unit, and the result is exactly INSTALL.md's 4d line;
  - the rollback's backup pattern matches the live unit;
  - lab_quiet and snap were read live.
Found in review of my earlier script: s3-budget64-rollback.sh gates on a READABLE guestd, so its apply's fail() would
have been refused had guestd not come back. The apply succeeded, so it never mattered. 4d's FROM_APPLY is the fix.
