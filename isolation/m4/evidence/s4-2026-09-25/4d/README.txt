S4 row 4d on warden-host, 2026-09-25 (Codex's go; enclave-63). Every time is read from the clock.

WHAT RAN: s4d-run.sh 4e78ba80db7ac14a2d27fd65d495b8feb036ca23 0ee7ed91e5066a0cbe7a4b528250342c354722a84202d043d03c5ee6dbec3086
  (scripts v5, all approved by enclave-e3), DETACHED as the transient unit s4d-apply-20260925T202122Z; exit 0.
  20:21:22Z started; its checks re-ran first (1d, the release, the legacy evidence b60873fa for THIS guestd, the host,
            the exact live ExecStart); the adoption preflight AGAIN at 20:21:26-27Z: 3/3 canaries verify with the
            17e182a8 tree's judge, same keys; vsock 9443/9444 bind-probed free.
  20:21:27Z the ONE ExecStart edit + daemon-reload + restart.
  20:21:28Z the new guestd: "adopted 3 guest(s) ... each verified again as the same guest"; guest pool 5376/300 of
            65536/1600; "host memory floor 16384 MiB"; "non-release deployment guests are built from iso-03be27d6";
            "attested release ON: tickets on vsock 9444, egress on vsock 9443" (guestd-journal.txt).
  20:21:47Z "4D APPLIED and checked" (install-log.txt): every post-check passed, no rollback.
  20:22:03-20:32:15Z observe.sh 4d: GATE PASSED, 6 rounds over 612 s (observe-log.txt).

STATE NOW (after/, 20:33Z):
  guestd   ~/enclave-prod/bin/guestd.4e78ba80 (sha256 0ee7ed91..., reproduced by 5d, e3 and 63), MainPID 4104830,
           NRestarts 0; -isolation ~/enclave-prod/iso-17e182a8/isolation (release a4f22748) -release
           -legacy-isolation ~/enclave-prod/iso-03be27d6/isolation (0181bce3) -instance-prefix gd
           -guest-host-floor-mib 16384, with -guest-mem-mib 65536 -guest-cpus 16 as before.
  /health  supports.release and legacyImage true; config, secrets, egress, configCid, ports, gpu false.
           pool 65536/1600, allocated 5376/300, free 60160/1300, not overcommitted; host floor 16384,
           pendingMiB 2175 (3 x 725: what the canaries may still draw), unreadUnits 0 (the cgroup reader works).
  canaries the 3 units unchanged (09-24 start times, the same MainPIDs 3817611 / 3886326 / 3817567); attested with
           their S0 transport keys (d590dd84 / b071a9c9 / 295ce2e0); public TLS 200 with the same keys.
  unchanged (before/ vs after/, byte-equal): canaries.tsv, public.txt, trusted.txt, relay-row.json, allowlist.txt,
           the node config and instance hashes; the chain records equal apart from leaseUntil; availability 64 GiB /
           16, free 0.7; the node CVM (enclave-metal-iso) running since 11:01 MST; no non-canary on the node.
  The live supervisor (c42612c0) never asks for a release, so no guest changed image.

ROLLBACK (kept): s4/s4d-rollback.sh restores ~/enclave-bench/.../secret/enclave-guestd.service.bak-pre-4d
  (guestd.c42612c0 on iso-03be27d6, no -release, no floor); gated on the 3 S0 canaries alone.
