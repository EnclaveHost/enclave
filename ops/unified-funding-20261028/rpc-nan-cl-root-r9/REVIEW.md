# Nan n9: measured 1800-second startup — source preparation only

Separate candidate derived from frozen n8. Nonce `6b0ddadd-94f2-4d4e-b687-f0859a4d4780`; new n9 service/slice/socket/upload/mount/runtime/COW/admission namespaces. No candidate execution, test run, syntax check, assembler execution, author-model call, remote access, image access, native launch or finance occurred in this lane. Root owns review, tests, immutable source integration, fresh horizon admission and any execution. Frozen n8 and EL r8 remain untouched.

## Why a longer measured window

Root reports n8 terminal2/main0 with all known PIDs gone, unchanged runtime pins, cleanup PASS, original unchanged and private COW retained. PARSED-MAIN.json records 216 samples, 44 diagnostics, 464535 history bytes and no RPC during the 450-second window. Observed peak2814087168 bytes and noOOM do not prove steady-state memory fit. Native logs progressed through DB initialization, hot-state loading/caching, fork choice and genesis state; the client was later killed after its stop grace and was not graceful. Repeating the same short cold load is not a production qualification strategy. This candidate grants one longer measured startup window, not indefinite execution or an automatic retry.

## Admission and unchanged safety policy

Maximum active admission is2100 seconds from the actual `FRESH-OBSERVATION.json` timestamp. The complete admission.at must equal observation.at; metadata hashes, boot, nonce, scope, timer/schedule evidence and root authorization stay bound. Metadata load and immediately before remote main require at least2010 seconds remaining, preserving the maximum90-second observation-to-main gap. Immediately before the1800-second measured window, require at least1805 seconds remaining in BOTH admission and watchdog. The active guard still checks actual expiry; longer cleanup units grant no extra active authority.

Root must review pending jobs, timers, process identities and other resource commitments over the full2100-second active horizon and2500-second outer/cleanup horizon. Existing checks are preserved, including timer changes entering the admitted window, exact cron/schedule files, unrelated process identities, creator classification/identity, queued-work rejection, live budgets and OS reserve. This is still a policy admission with continuous checks, not a universal kernel reservation against arbitrary future allocations. The longer horizon must not inherit a short n8 observation or be justified only by current free memory.

Same CL4096MiB, attach128MiB, guardian128MiB,2048MiB residual OS reserve and zero swap. Same CPU restrictions and Warden worker512/RSS450/floor27648/CPU1/noSwap profile. Same Lighthouse binary/debug/cache arguments, n5 binary copy verification, native idmap fixture, UID/GID mapping, exact mount receipt, perboot/nonce identity and private original-backed COW. No n8 COW reuse. Same disk growth/free-space/evidence guards and independent teardown. Memory cap, pruning, payload and trust policy are not relaxed.

## Finite timing envelope

| Component | n9 seconds | Purpose |
| --- | ---: | --- |
| Actual-observation admission maximum | 2100 | Active authorization ceiling |
| Metadata load and pre-main minimum remaining | 2010 | Preserve90-second maximum observation-to-main gap |
| Preparation bound | 90 | Existing bounded setup |
| Measured startup window | 1800 | Stop early on valid startup RPC |
| Admission/watchdog minimum before sampling | 1805 each | Window plus5 seconds |
| Watchdog deadline from state creation | 2090 | Independent active stop |
| Watchdog service runtime / stop grace | 2230 / 70 | Deadline plus140-second cleanup margin |
| Helper runtime / stop grace | 2100 / 145 | Finite helper and cleanup receipt wait |
| Main capture | 2255 | 2100+145+10 transport/capture margin |
| NBD runtime / stop grace | 2240 / 10 | Retain attachment through normal cleanup interval |
| Cleanup receipt wait | 140 | Unchanged |
| Request-stop capture | 20 | Unchanged |
| Verify capture | 60 | Unchanged45 runtime+10 stop+5 capture margin |
| Socket-clear capture | 20 | Unchanged |
| Local reap reserve | 20 | Unchanged |
| Nominal sequential bound | 2465 | 90+2255+20+60+20+20 |
| Required outer timeout | 2500 | 35-second nominal remainder |

Watchdog/runtime and NBD timers start at different setup points; these bounds preserve n8 ordering and explicit margins. Root must review actual generated commands and outer enforcement before launch. This bounds configured waits, not uninterruptible kernel I/O or arbitrarily stalled filesystems. Missing teardown proof still fails closed. Expiry and resource guards remain active during the measured window; cleanup follows the established owned-resource path.

## Bounded evidence and startup-only success

Sampling remains every2 seconds and diagnostics at least10 seconds apart. Retain at most901 samples and1MiB serialized history; perform at most181 diagnostic samples, with unchanged64-thread/0.25-second per-process limits and bounded journal output. Preserve the whole remote output cap2MiB. New `out['lastSample']` is assigned before history admission so the newest bounded sample survives a full history budget and later failure. Dropped rows remain counted; no unbounded history is introduced. Existing valid startup response is recorded separately and ends observation immediately, even after history fills.

The early-RPC schema is unchanged: exact booleans plus ASCII decimal uint64 head_slot/sync_distance, no error envelope. A valid response can still be syncing, optimistic or EL-offline; it is startup-only evidence, not production readiness. Existing graceful-stop and independently verified cleanup remain required. The n8 fixed-label journal sampler is unchanged in this narrow timing candidate; no identity fallback or arbitrary log capture is added.

## Root workflow and proposed tests

Root reviews/tests source, runs pure assemble.py, commits/pushes immutable source/runtime BEFORE a new separately reviewed fresh read. Generated source copies `run.py` and `remote-program.py` from the old package were deliberately not copied: the existing assembler generates runtime versions from the explicit source parts. No assembler or generated runtime exists in this candidate yet. Assembler command allowlists and source remote-command definitions both use helper2100/stop145.

Root exclusively supplies runtime/FRESH-OBSERVATION.json and ROOT-ADMISSION.json after reviewing the full horizon. Use scope `actual-nan-cl-bounded-client-n9`, new nonce/boot/runtime pins SHA, exact observation SHA and complete admission SHA. The manifest remains unauthorized with zero admission timestamps; no old authority/results were copied. Set outer2500 explicitly in the reviewed worker launch, not the older1000. Launch only after root resource scheduling permits it. No automatic retry or promotion.

There are97 defined test methods:90 inherited with relevant lifetime/window expectations updated, plus7 new regressions. New cases exercise the real sample loop over simulated1800 seconds with bounded history and latest-sample preservation, early RPC with a full history budget, precise load/sample boundaries, runtime expiry, and helper/watch/NBD/outer arithmetic. Tests have NOT been run. Full qualification, actual RPC/memory/exit evidence, subsequent paired EL/CL readiness, Base coverage and production cutover remain outstanding.
