# The owner-grace relay window (after the NucBox soak)

This follows enclave-87's ruling of 2026-09-26. relay/owner-grace changes owner-only serving, and test 1 (the soak's target)
is served owner-only, so it lands in its OWN api-relay window:
- **after** d1's final soak summary (the soak loop ends 16:01:05Z by its start record; d1 sends "soak summary done" at about
  16:02–16:05Z), and
- **before** the v42 reboot acceptance, so the reboot runs against the final relay.

It is a code change only. No env line changes, and it is never mixed with an env window.

## What gets pushed

relay/owner-grace @ 64186b97, 2 commits on main 3212f147 (5d GO on the originals):
- 9268236f (= 62469d05, re-cut): a failed owner read leans on the last successful one for at most TUNNEL_OWNER_GRACE_MS (15 min
  default). Past that, owner-only serving is SUSPENDED: the row stays attached, publishes no ownerOnly, and every splice is refused.
  A later good read of the same owner resumes it; any other owner, or none, ENDS it until a re-attach. An attach during a longer
  outage starts suspended.
- 64186b97 (= 9aa2f366, re-cut): that start-suspended attach says so in the journal, once (5d's nit).

The re-cut onto 3212f147 (after the pacing push) is patch-identical: patch-ids f0aa3b48… and 00f1e8a8…, as reviewed. On the
re-cut head: owner-only 12/12, tunnel 23/23, hvnode-consumer 4/4, owner-only-fleet 3/3, handover 5/5, secrets-release 22/22,
release-prewarm 5/5.

**Which relays run it:** only nan's enclave-api-relay loads relay/tunnel.js (via api-relay.js). The CI relay job also copies the
bundle to the SNI relays, which never load it; us-west never runs it. No manual host step.

## Steps

1. `DRY=1 bash og-push.sh`: every pre-push check, with the soak gate reported instead of enforced. Nothing is pushed.
2. On d1's "soak summary done": `SOAK_DONE=1 bash og-push.sh`, then `bash og-accept.sh`.
3. Tell d1 "healthy" with the new invocation. d1 confirms test 1 is 200 via /x (the soak monitor's check). Only then can the v42
   reboot acceptance start.

## How it's derived

The scripts are relay-window-20260926c's pacing scripts (bf GO; run and accepted 06:44:45Z), with only these changes.

**og-push.sh:**
- the pins in lib.sh (PC, REVIEW_BASE 3212f147, the 2 patch-ids, FILES, the tunnel.js and api-relay.js content hashes);
- the SOAK gate: never before SOAK_END (a hard floor), and only with SOAK_DONE=1. DRY reports the gate instead;
- the hv-node row: nucbox-k11 must be attached and serving owner-only BEFORE the push (recorded in hv-row-before.txt).

**og-accept.sh:**
- the pushed files (tunnel.js, api-relay.js);
- nucbox-k11's attach line in the NEW invocation's journal (within 180 s);
- its public row serving owner-only EXACTLY what it served before (within 120 s);
- zero owner-grace lines in the new invocation: no SUSPENDED, no grace start, no env complaint.

**og-rollback.sh / og-recut.sh:** pace-rollback.sh / pace-recut.sh with the names changed.

**What stays the same:**
- the context guard (main unchanged under relay/, site/ and scripts/ since REVIEW_BASE);
- 2 plain commits, no symlink or node_modules path, the patch-ids, the file list;
- no Deploy in progress, and the last completed Deploy on main = BASE + success;
- the ≥10 min restart age;
- the instant predictor probe, with automatic revert on a predictor PROBLEM;
- health in the CERT_SEPARATE mode, ADMIT = 5db18199.

## Rollback

`og-rollback.sh` reverts the 2 commits on main: a new commit, pushed, so one more relay deploy and restart, ≥10 min after.
Reverting restores the pre-window behaviour: a failed owner read serves on the cached owner with no bound.

## Self-test

`og-selftest.sh` is read-only and runs every ADDED check against the live relay and the pinned source:
- hv_row and hv_attach_line on nucbox-k11 and on a name that doesn't exist;
- grace_lines on the current invocation;
- GRACE_RE against the exact wording PC logs, against 5 synthetic lines it must count, and against 4 it must not;
- files_are_pc refusing before the push.
