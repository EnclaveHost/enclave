S8 (enclave-87's queue, 09-26): guestd UPGRADE 4e78ba80 -> 0c087de8 + TREE SWITCH iso-b63c2def (f7888d86) -> iso-0c087de8
(release 5db18199, per-release W^X). Runs AFTER e3's rs-9 is ACCEPTED. Reviewer: enclave-bf.

Order (each step refuses unless the previous one's record is there):
  1. s8-install.sh                   INERT: worktree iso-0c087de8 + release-0c087de8 (1a verify, 1b clean, 1d reproduce)
  2. s8-guestd-install.sh <NBINC> <XSHA>   INERT: guestd.0c087de8 built twice (2nd with an empty Go cache) = XSHA, the
                                     sha a REVIEWER reproduced independently (mine, dry: fda353c9...0767); floor commits;
                                     the three per-release flags present in -h
  3. s8-adoption-preflight.sh <NBINC> <sha>   the NEW tree's client.mjs/judge, guestd's verifyArgs verbatim with
                                     --release <UNREC>, against each canary's CURRENT forwarder: 3/3 attested, same keys
  4. s8t-run.sh                      DETACHED s8t-apply.sh: re-runs the preflight, then ONE ExecStart edit (binary + tree +
                                     the 3 flags), writes fl-20260926/state/s8-switched-epoch, restart, checks; any
                                     failed check -> s8t-rollback.sh (binary AND tree back, no new flags)
  5. tw-legacy-20260926/tw-legacy.sh (a transient unit) right after 4 passes

The flags (lib8.sh; main.go:310-312 at 0c087de8):
  -isolation-release        @release-0c087de8/release.json            (= 5db18199, asserted)
  -legacy-isolation-release @release-0181bce3/release.json,@release-6757d139/release.json  (= 5c3561f9, 6f14ce75;
                            iso-03be27d6's judge predates LEGACY_WX_RELEASES, so guestd requires the @ form: needsRelease)
  -unrecorded-releases      f7888d86,5c3561f9,6f14ce75 (typed; unrec_ok = the sha256 set of the installed release.json's)

Boot path between the trees: EXACTLY isolation/m2/client.mjs + judge.mjs differ (s8t-apply checks it with git diff).

LEGACY PATH (enclave-87's ruling): no new lab run. Legacy-path acceptance is carried by b4's judge run plus the
first-occurrence tripwire (tw-legacy.sh). s4's legacy-check.txt (4e78ba80, byte-equal boot path) is SUPERSEDED.

Rollback after an e7 canary relaunch (OVERRIDE only): from SOURCE, untested: 4e78ba80 ignores the record's new Releases
field, and iso-b63c2def's judge ignores the attest-time form's role keys, so it would re-adopt a 5db18199 canary.

After an S8 ROLLBACK (enclave-bf's note a): a first launch whose guest was created during the S8 window (so on
5db18199) HOLDs in fl-check as "created after the S7 switch but runs 5db18199" once the S8 epoch is removed. Fail-closed
and expected: check that guest by hand (a 5db18199 guest the relay admits) and report it to enclave-87.

ROLLBACK ORDER AFTER rs-10 (enclave-87's ruling, 2026-09-26): once e3's rs-10 (retire f7888d86 from the relay's installed,
admitted and certifiable lines) is ACCEPTED, s8t-rollback.sh ALONE IS NOT ALLOWED. Reason: the rollback puts guestd back
on iso-b63c2def, which builds f7888d86 guests; with f7888d86 retired, those guests get no release and no certificate (the
relay's prediction gate), and every relaunch or first launch would fail. The only way back to f7888d86 is:
  1. roll back rs-10 FIRST (e3's rollback: re-admit f7888d86), and check /v1/expected-guest lists f7888d86 admitted for
     each canary;
  2. THEN s8t-rollback.sh (with OVERRIDE=<reason> once any canary runs 5db18199, which all 3 do since e7).
Otherwise, fix forward on 5db18199.
LEGACY_WX_RELEASES (enclave-87, required): the next chain rev removes f7888d86 from judge.mjs's table; noted beside the tree
in ~/enclave-prod/iso-0c087de8.NOTES.txt.
