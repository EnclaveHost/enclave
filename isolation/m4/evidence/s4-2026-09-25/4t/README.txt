S4 TREE SWITCH on warden-host, 2026-09-25 (Codex's go, conditional on rs-4; enclave-63). Every time is read from the clock.

rs-4 FIRST (e3's procedure at 0a179f04, d1 PASS; ../rs4/): 21:29:44Z the two predictor lines on nan (PREDICT_RELEASES +
79c5ecf2, DOMAIN_RELEASES = 79c5ecf2), one api-relay restart (invocation d7a7d487 -> 7be8c993); 21:31:42Z ACCEPTED: the KAT
PASS, and for all 3 canaries 79c5ecf2 predicted (2317370d / 6de87365) AND admitted, installed = the 4 releases, admitted =
79c5ecf2 only; release-ticket 503; 404/422.

THE SWITCH (s4t-run.sh, scripts s4t v2, lib4 v6):
  21:32:52Z run 1 REFUSED at 21:32:59Z, before any change (rc 16): MemAvailable 74204 MiB < the 76544 needed. The cause:
            enclave-d1's and enclave-e3's test suites were running on warden-host (21:29-21:34Z); enclave-63 had not told
            d1 to hold. Both stopped and freed their tmpfs scratch; enclave-63 freed ~1 GiB of its own; MemAvailable then
            held 80.1-80.7 GiB for a minute (PSI 0). The same approved script was re-run (every gate re-evaluates).
  21:46:28Z run 2: the fresh adoption preflight 3/3 at 21:46:34Z (the new tree's judge), the relay guard (79c5ecf2 admitted
            for all 3), 1d, lab_quiet, headroom; 21:46:34Z the ONE ExecStart edit (-isolation iso-17e182a8 -> iso-aa6c985c)
            and restart; 21:46:35Z "adopted 3 guest(s) ... each verified again as the same guest", the floor line, the
            legacy line, "attested release ON"; 21:46:55Z "4T APPLIED and checked".
  21:47:09-21:57:20Z observe.sh 4t: GATE PASSED, 6 rounds over 611 s.

STATE NOW: guestd.4e78ba80 (0ee7ed91; the running exe hashed) MainPID 262564, NRestarts 0; -isolation
~/enclave-prod/iso-aa6c985c/isolation (release 79c5ecf2, init against musl), -release, -legacy-isolation iso-03be27d6,
-guest-host-floor-mib 16384, 65536/16. supports release + legacyImage only. pool 65536/1600, 5376/300 allocated; host
floor 16384, pendingMiB 2175, unreadUnits 0. The 3 canary units unchanged (MainPIDs 3817611 / 3886326 / 3817567), their S0
keys. before/ vs after/: canaries.tsv, trusted.txt, relay-row.json, allowlist.txt, the config and instance hashes
byte-equal; the chain equal apart from leaseUntil; availability 64/16, free 0.7; no non-canary. public.txt differs ONLY
because the BEFORE snapshot (21:32:40Z, 3 min after rs-4's api-relay restart dropped every tunnel) caught one transient TLS
EOF for 395bed3e (its served key still matched); AFTER all three are 200 / verify 0 with their keys, as is every observe
round.

ROLLBACK (kept): s4t-rollback.sh -> the 4d unit (iso-17e182a8); then rs-4.sh rollback (DOMAIN_RELEASES back to a4f22748)
before any release turn-on; deeper: s4d-rollback.sh -> guestd.c42612c0. NEVER DELETE ~/.cache/enclave-isolation/musl-1.2.6.
