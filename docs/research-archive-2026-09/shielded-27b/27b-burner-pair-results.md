# burn0 candidate vs quiet-off control (5 burners)

baseline **VALID**  candidate **INVALID**  matched **False**  burners **PROVED**  sources **PROVED**

## Burner threads
- baseline app pid 7949 (vm 8007, vhost 8010): 5 app burner threads [0, 1, 2, 3, 4] on 5 unique tids; 33 app rows and 31 VM/vhost rows of 64 checked
- candidate app pid 9585 (vm 9631, vhost 9635): 0 app burner threads [] on 0 unique tids; 26 app rows and 31 VM/vhost rows of 57 checked
- candidate receipt burner_threads: {'requested': 0, 'observed': 0, 'threads': [], 'nice_recorded': False, 'scope': 'Thread names, and NI only where the listing carries it, read from the trial-1 kernel_targets discovery. Presence at that one sample: not a duty cycle, not CPU time, and not a claim about any other moment of the leg.'}

## Registered sources
- 32 shared paths, 0 differing
- entry points: {"baseline": {"path": "/home/steven/Documents/Codex/2026-09-07/i-w/work/phone-bench-b27-cache/cycle_quiet.py", "sha256": "213adb9ae494d95600ab50276b27bdd2b9e6b8c8746274476f8c5fa52e896bf5"}, "candidate": {"path": "/home/steven/Documents/Codex/2026-09-07/i-w/work/phone-bench-b27-cache/cycle_burners.py", "sha256": "86d9e0eee4805e98932ce10d303fc99bd8c2ff07103f33590aa6f6be491bd991"}}

## Pad wait, per trial delta
- baseline_burn5 trial 1: before 3 after 3 delta 0 (known)
- baseline_burn5 trial 2: before 3 after 3 delta 0 (known)
- candidate_burn0 trial 1: before None after None delta None (unknown: a before or after card is missing)
- candidate_burn0 trial 2: before None after None delta None (unknown: a before or after card is missing)

## Rates
NOT_COMPARED: leg status: baseline=VALID candidate=INVALID
- leg status: baseline=VALID candidate=INVALID

## Limits
- Both legs are quiet 0. The only intended difference is five burner threads against none; everything else is required to match through the accepted summariser.
- kernel_targets.threads carries app, benchmark VM and vhost threads. Burner names are counted only under each leg own app pid; foreign rows are ordinary threads.
- Trial 1 and trial 2 are different receive-window conditions. Per-condition rows come first; the combined figure describes one balanced sequence and is not an average of repeats.
- One cycle per setting. Repeatability is not established here and is not claimed.
- pads_waited is reported only as a per-trial delta; the raw counter is cumulative from process start.
- A NOT_RUN or INVALID leg is never compared, whatever the burner and source proofs say, and a pair whose proofs failed is not compared either.
