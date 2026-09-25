# Legacy path with the MERGED guestd (the 4d binary), real SEV-SNP (2026-09-25 20:13-20:14Z, PASS)

The re-run enclave-63's s4d-apply.sh requires: the pre-4d legacy-path check (`../legacy-2026-09-25/`) repeated with a
lab guestd built from the commit the 4d binary comes from.

- **Merge commit `4e78ba80db7ac14a2d27fd65d495b8feb036ca23`.** enclave-63's e3-approved host-memory floor
  (d67b0020 + 1b5375c9 + d36e8da7 + ee8dbbcd) merged onto the release image commit 17e182a8. The guest image's inputs
  are unchanged: release a4f22748.
- **The lab guestd:** sha256 `0ee7ed91e5066a0cbe7a4b528250342c354722a84202d043d03c5ee6dbec3086` (`guestd.sha256`,
  `guestd-buildinfo.txt`: vcs.revision = the merge, vcs.modified = false, -trimpath). It is byte-identical to a
  reference built as the install script will build it: a clean worktree at the merge,
  `cd isolation/m4/guestd && go build -trimpath` with GOFLAGS unset. That reference reproduces under a cold Go cache.
- **Run:** `~/enclave-bench/lab-release/legacy-run-20260925b`, by `run-legacy-check.sh` from that clean worktree.

## Result
- `/health`: `supports.release` and `supports.legacyImage` are true; config and secrets are false.
- Guest `lb6d35c354` (release unset, so legacy) came up in 11 s: legacyImage true, running, verdict attested.
- **AppID d2c4dfc0…** and **measurement be6b8644…da4d** equal the LIVE hookbin canary's VCEK-signed values.
  `expected-measurement.sh --pin 5c3561f9…` reproduces them.
- The app answered HTTP 200 through the front.
- Production m2-gd* units were identical before and after. No process from the run dir, no m2-lb* unit, and the
  worktree still clean.

For s4/legacy-check.txt (enclave-63 writes it): `guestd 4e78ba80db7ac14a2d27fd65d495b8feb036ca23 sha256
0ee7ed91e5066a0cbe7a4b528250342c354722a84202d043d03c5ee6dbec3086 PASS evidence <this commit>`.
