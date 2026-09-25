POOL ROLLOUT ON metal-iso0, 2026-09-25 (TASK 4c; isolation/GUEST-POOL-ROLLOUT.md S0-S2, then Steven's 64 GiB / 16 budget)
Owner: enclave-63.
Authorized by Codex in enclave-63's session:
  - S0-S2 at 16384 MiB / 8;
  - then, as Steven's explicit request, "up the ram to 64gb and the vcpus to 16", i.e. 65536 MiB / 16.
Technical verdicts: enclave-99, on the artifact (independently reproduced) and on scripts v3/v4. Coordinated with
enclave-5d, who held all lab work on this host throughout. Every time here was read from the clock (date -u), not
estimated. Nothing secret is in this directory: the node config, which holds the operator key, and the relay env stay
on their hosts, and backups live outside the repo.

WHAT CHANGED IN PRODUCTION
  guestd   ~/enclave-prod/bin/guestd.c42612c0 (sha256 4a5f8bd94e487fcd71e80efe27d8961c8416ad33e288156938fd90baaee4bbc3,
           go1.27.0 -trimpath, built twice identically, and by 99 independently).
           Flags: -guest-mem-mib 65536 -guest-cpus 16. The -isolation tree is still iso-03be27d6 (0181bce3), so the
           guest images and their measurements are unchanged.
  node     metal/dist-iso-c42612c0, the ghcr supervisor pinned as before, with an overlay from clean c42612c0.
           Measurement 10622d989bf4f5f3dc560dd237a845684dbda66269e43f2b2b22b82e6956eca3e4289d8d62e99dc118d51f2a49633782
           (build/). It was built twice identically, predicted with the AmdSev OVMF 142589cc, recomputed by hand and
           by 99, and ATTESTED by the node in its raw report (s2-after/node-attestation.json, report offset 0x90).
  relay    nan METAL_ALLOWED_MEASUREMENTS = 04e953a4... (the previous image, KEPT for rollback) + 10622d98...
           Only that one line changed; the backup is on nan (s2a-remote.txt names it).

UNCHANGED, checked at every step against s0-baseline/
  - the three canaries' guests: same units (09-24 start times, same PIDs), same attested transport keys, same
    measurements;
  - every on-chain field of their deployment records except leaseUntil, which moves forward with renewals:
    owner, appRef, configCid, gpuMilli/cpuMilli (100 = 10%), appPort, isPublic, active, rate (0), balance6, spent6,
    runner, runnerOperator, capMaxRate6 (84);
  - the posted price (SELL_CPU_PRICE6 unset: 834); no setConfig, no setShares, no cap edit;
  - no non-canary guest or claim on metal-iso0, by guestd and by the chain.

TIMELINE (rollout.log)
  17:18:43Z  S0 baseline, all green (s0-baseline/). 17:41:45Z: one public probe failed with nothing changed
             (notes.txt), so the public check retries once.
  17:48:02Z  S1 attempt 1: guestd came up correctly (adopted 3, pool 16384/800), but MY journal check read a UTC
             time as local and failed. It rolled back and was verified by 17:48:14Z. Fix: T0 with "UTC" (v4).
  17:49:35Z  S1: applied and checked 17:49:50Z; 10-min gate PASSED 17:49:59-18:00:14Z (s1-observe.log).
  18:00:46Z  S2a: allowlist add + api-relay restart; metal-iso0 re-attached on 04e953a4; checked 18:01:08Z.
  18:01:21Z  S2b: dist switch + node CVM restart. The node attested the prediction at 18:01:37Z. The supervisor resumed
             3 leases ("adopted guest ... launched from this record before the node restarted"), released 0.
             395bed3e was unreachable 18:01:52-18:02:30Z during the resume. Checked 18:02:58Z; 10-min gate PASSED
             18:03:08-18:13:19Z.
  18:15:24Z  BUDGET 64: only the two flags changed, one guestd restart (adopted 3), checked 18:15:41Z; 10-min gate
             in budget64-observe.log.

CAPACITY AS REPORTED NOW (budget64-after/)
  guestd /health.pool: budget 65536/1600, allocated 5376/300 (3 x 1792 MiB / 100%), free 60160/1300, not overcommitted
  supervisor /availability: nodeRamGb 64, nodeVcpus 16, nodeGflops 1000
  cpuShareFree 0.70 = min(two constraints):
    - the share ledger: 1 - 3 x 0.100 = 0.700 (each canary bought 10%);
    - the pool's free fraction: min(60160/65536 = 0.918, 1300/1600 = 0.8125) = 0.8125.
  Physical CPU free is 81.25%. The advertised 70% is the ledger's, correctly. Neither is forced.

ROLLBACK ARTIFACTS, KEPT for the 72 h window and not retired without a review of the results
  - scripts/s3-budget64-rollback.sh: back to 16384/8. It is gated: only while the canaries alone run.
  - scripts/s2b-node-rollback.sh: back to dist-iso-8ed6231f. Gated the same way. Rollback ORDER: s2b before s2a.
  - scripts/s2a-relay-rollback.sh: removes ONLY the new measurement's entry.
  - scripts/s1-rollback.sh: the old guestd binary, which was never overwritten.

REPRODUCE: scripts/ holds the exact scripts run (hashes in scripts-v2.sha256 plus the diffs-* for v3/v4/64g), collect.sh
for the evidence, and build/ holds the image manifest, file hashes and prediction. build/DISCARDED-wrong-ovmf-manifest.json
is my first build: its prediction was against the distro OVMF because --ovmf was omitted. It was caught before
anything was applied.
