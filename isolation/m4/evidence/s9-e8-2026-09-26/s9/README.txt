S9 + e8 (enclave-87's queue, 09-26): guestd UPGRADE 0c087de8 -> 4cd26e58 + TREE SWITCH iso-0c087de8 (5db18199) ->
iso-4cd26e58 (release aee2059f: the runtime's seccomp filter STATED at attest), then the 3 canaries onto aee2059f (e8).
Inputs: 53's cut (release aee2059f from isolation/seccomp-evidence 4cd26e58; bf GO on the release; d1 GO on 4cd26e58
inside N2); b4's v44 manifest ~/enclave-bench/manifests/next-rev-v44-20260926T0700Z.md (ac44d30b) items 3-9.
Runs after: rs-11 ACCEPTED (07:07:02Z, e3) and N2-b ACCEPTED (node on N2 fab9c6c7, n2acc); 5d reviews S9 + e8.

Order (each step refuses unless the previous one's record is there):
  1. s9-install.sh                    INERT: worktree iso-4cd26e58 + release-4cd26e58 (1a verify, 1b clean, 1d reproduce)
  2. s9-guestd-install.sh <4cd26e58> <XSHA>  INERT: guestd.4cd26e58 built twice (2nd empty Go cache) = XSHA, 5d's
                                      independent build 25d638c39d7ec3cb70ace9e4d4d6364a2fe09e78ea12b5ab5f1a0562dfb37b18
  3. s9-adoption-preflight.sh <4cd26e58> <sha>  the NEW tree's client.mjs/judge, guestd's verifyArgs verbatim with
                                      --release <each canary's RECORDED Releases> (= 5db18199, listed as seccomp-unstated)
  4. s9t-run.sh                       DETACHED s9t-apply.sh: re-runs the preflight, ONE ExecStart edit, writes
                                      fl-20260926/state/s9-switched-epoch (e3's rs-11 rollback guard keys on it), restart,
                                      checks; any failed check -> s9t-rollback.sh (S8's unit back, byte-exact)
  5. e8-pins.sh                       the installed tree's expected-measurement.sh over each canary's live bundle =
                                      lib-e8's RELM (3facefd8 hookbin; 8a291bbf x2) = e3's = bf's
  6. e8-restart.sh 0ddbd824 / 395bed3e / 4e62e60d, one at a time, each after the previous ACCEPTED

The unit edit (b4 items 5-6): a[0] guestd.0c087de8 -> guestd.4cd26e58; -isolation iso-0c087de8 -> iso-4cd26e58;
-isolation-release @release-0c087de8 -> @release-4cd26e58 (= aee2059f); -legacy-isolation-release KEPT; and
-unrecorded-releases DROPPED ENTIRELY (records_named(): all 3 records name [5db18199], none names f7888d86 - the pairing,
item 4). Boot path between the trees: EXACTLY isolation/m2/judge.mjs (checked; the installed judge = b4's 650b931d).

What the re-adopted canaries show (the evidence check): VERDICT attested, wx_coverage=runtime-covered, and "no seccomp
statement, accepted ONLY because the caller names" 5db18199 (listed in SECCOMP_UNSTATED_RELEASES).

e8's proofs (b4 items 7-9): proof 8 = W^X AND seccomp at attest (seccomp=d4d17c9f…, the judge: "under the seccomp
filter with program sha256 d4d17c9f"); proof 9 = POSITIVE: "DOM seccomp: app filter installed (sha256 d4d17c9f…, 71
rules)" and none of the five refusal lines; N2's judge certifies ("guest attested"); b4's N3: any "did not verify" line
for the id is a FAIL; 5d's A1-A3 retry acceptance (the 20 s line conditional, the install time reported).

fl-check v7: a guest created after S9 must be aee2059f (the guard, 16/16 test-guard.sh), and an aee2059f first launch
must state seccomp=d4d17c9f… (A) and the serial's installed-filter line with no refusal line (C).

ROLLBACK: s9t-rollback.sh returns S8's unit byte-exact (binary, tree, S8's three naming flags); it removes the S9 epoch
only once S8's unit is verified live. Its enforced guard (S8's, one release on): refuses unless the relay admits
5db18199 for every canary (i.e. rs-12 not run, or rolled back first); bypass OVERRIDE_UNADMITTED=<reason>;
test-rollback-guard.sh 11/11. Relay order (e3): N2-b / S9 roll back FIRST, then rs-11.
