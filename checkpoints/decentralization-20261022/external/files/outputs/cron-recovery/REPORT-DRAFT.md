Superseded by the verified report in REPORT.txt. This draft is retained for incident history.

# Cron (`cron:1.0.3`) stuck QUEUED: recovery report

**DRAFT. Verification is pending.** Public health is still being monitored. This report does not claim the app is
healthy.

## What happened
- **The trigger.** The minipc host's VM manager restarted repeatedly between 11:28 and 11:52 UTC on 2026-10-21. That
  issue was repaired at 12:13.
- **Cron's VM died.** During the recovery, cron's fresh VM stopped itself about 2 seconds into boot, at 11:55:52. That
  was before the app or its secrets started.
- **The host gave up.** The host's default policy does not retry such a VM; it gives up. The lease lapsed at 12:09, and
  the dashboard showed QUEUED.
- **A second problem kept recurring.** Whenever the host could not confirm its wallet policy on chain ("chain quorum
  unavailable"), it stopped running apps, including cron. One public RPC provider (drpc) was seen returning HTTP 429
  (rate limited). Whether all providers were being rate limited is **not yet established**; new per-provider
  diagnostics will show it.
- **Not the cause:** cron's configuration, its secrets, or the cron artifact itself. The same version ran for hours
  before and after.
- **The screenshot's error is unexplained.** The message "WASM … exited i32 status 1, stderr [cron]" could not be traced
  to this host in the incident window. It may be stale, or from another host's attempt. Cron prints that only when its
  configuration fails to load.

## What was changed (15:00–15:01 UTC, one restart of the host's node agent, about 51 s)
1. The host now **restarts cron's VM inside its lease** if it ends, instead of giving the lease up. This is a per-app
   setting; the timing for the other listed app is unchanged.
2. **Chain checks retry rate-limited reads for a bounded 10 seconds** and report which provider failed. An unanswerable
   check still counts as "unknown", never as "allowed".
3. **Host checks no longer overlap.** One pass runs at a time, which avoids duplicate stops and renewals.

Admin controls and moderation checks are unchanged. Every change has a tested rollback with pinned backups. The same
fixes are now in the main source code.

## Still open
- Confirm that public HTTPS for cron serves normally on a stable VM and lease. This is in progress.
- Root is diagnosing one post-restart check: the set of VMs changed during the restart.
- Later, separately: decide the codebase-wide default for the policy-mirror list. This host deliberately keeps its
  own setting. The fix is already in the main source and the reviewed candidate, tested there.
