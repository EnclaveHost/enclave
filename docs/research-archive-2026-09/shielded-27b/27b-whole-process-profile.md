The completed diagnostic puts the main decode delay on the phone-facing path. **The V100’s measured graph work took about 0.38 seconds in each trial; total decoding took 17.15 and 34.08 seconds.** The slower trial also waited 8.37 seconds for fresh pads. CPU instruction samples identify substantial polling by the target CPU workers while they wait for new graphs.

These results come from Qwen3.8 27B Q8, one V100, the Pixel protected VM, MTP5, and live pad replenishment. They are diagnostic measurements, **not a new clean throughput record**. The original cycle failed during profile export and its initial cleanup check; both complete inference results and the complete checksum-verified profile were subsequently recovered. The failed receipts remain unchanged.

| Measured interval | Trial 1 | Trial 2 |
|---|---:|---:|
| Generated tokens | 16 | 16 |
| Decode wall time | 17.146 s | 34.075 s |
| Overall throughput | 0.933 tok/s | 0.470 tok/s |
| Steady throughput, 13 tokens | 0.921 tok/s | 0.445 tok/s |
| GPU graph, including upload | 0.380 s | 0.380 s |
| Upload portion of GPU graph | 0.041 s | 0.041 s |
| Guest request writes | 0.647 s | 1.259 s |
| Guest reply-header waits | 5.160 s | 8.808 s |
| Guest reply-body reads | 6.068 s | 7.638 s |
| Guest wait for available pads | 0 s | 8.370 s |

GPU durations occur **inside** the socket intervals and must not be added to them. The pad wait is included in the existing “mask” timer: that timer rises from 0.565 to 9.126 seconds without a corresponding increase in masking arithmetic.

Each trial has 1,574 matched FIELD exchanges across the guest, worker, and host forwarder, with matching byte counts. Each has 2,441 offloaded nodes, 6,764 consumed pads, zero local fallback, zero missed pads, and zero verification failures. Both produced identical text and MTP acceptance counts. The almost identical GPU time rules out slower GPU computation as the explanation for the twofold wall-time difference.

The caller used about 1.11 and 2.09 seconds of thread CPU inside 11.89 and 17.71 seconds of socket work. The remaining wall time includes IO waiting and descheduling; this capture does not completely separate them.

The source attribution points to these instructions:

| Exact source location in the profiled build | Operation | Observed samples |
|---|---|---:|
| `ggml-cpu.c:3142,3145,3147,3140` | Check stop/pause flags and graph counter while waiting for work | About 39% / 46% of trial samples |
| `ggml-cpu.c:521` | ARM `yield` inside polling/barrier loops | 10.6% / 13.0% |
| `ggml-cpu.c:3174` | Continue polling for a new graph | Additional polling samples |
| `shielded-pads.c:35` | Generate ChaCha20 input masks | 5.5% / 2.0% at this line |
| `shielded-pads.c:614` | Authenticated pad reader | 4.0% at this line in trial 1 |

Polling and CPU-relax functions together account for at least 53.2% and 63.9% of samples. **These are shares of sampled thread execution, not shares of decode wall time.** Some CPU-relax samples can belong to barriers. Most polling samples belong to the three persistent target workers, guest TIDs 138–140. With `poll=50`, the implementation allows 6,553,600 readiness-loop iterations before sleeping.

The native Android bridge consumed about 3.94 and 3.96 seconds of thread CPU in intervals covering 16.66 and 33.93 seconds of the trials. Polling with a reply queued grew from 0.80 to 2.59 seconds; the maximum pending reply queue grew from 221 KB to 786 KB. Most other bridge wall time was polling with empty queues. Host forwarding measured only 1.05 and 0.97 seconds of summed request-complete to reply-complete time.

A second correlation constrains the clock offset using causal ordering across all matched requests and replies. Assuming a constant clock offset, the cumulative interval from the host observing a complete reply to the guest finishing that reply is **7.11–9.07 seconds in trial 1 and 11.43–13.40 seconds in trial 2**. These intervals include host forwarding, USB/TCP, the Android bridge, vsock delivery, buffering, and scheduling. They do not identify one of those components exclusively. The offset uncertainty is 1.25 ms per exchange.

The body-read median was only 1.06/1.31 ms, but its 99th percentile was 43.95/50.19 ms. The longest body read was 87.42/440.28 ms. This variation matters: an average bandwidth figure hides the slow exchanges.

Cold startup is a separate large cost. Model loading took 27.1 seconds. The first five-token prefill took 430.9 seconds, including weight registration and pad warm-up. The 409 registration records cover 26.02 GB of encoded weights and sum to 398.1 seconds:

| Registration phase | Cumulative wall time |
|---|---:|
| Source acquisition, including authentication | 135.6 s |
| Encoding | 94.4 s |
| Link setup and checks | 161.1 s |
| Other registration work | About 7 s |

Source acquisition contains 104.5 seconds of reads and 31.2 seconds of authentication. The link’s check records contain 85.9 seconds of pad-check preparation, 45.9 seconds of Freivalds preparation, 18.4 seconds of public identity calculation, and 9.9 seconds of scanning/allocation. These are nested breakdowns and must not be added again to the outer totals. The largest individual registration was `output.weight`, at 34.3 seconds.

The non-decode sample phase corroborates that startup work: `shielded-pad-check.h:52`, the row multiply-accumulate loop, has 19.5% of those samples; `shielded-simd.c:298`, Freivalds preparation, has 15.3%. That phase also includes between-trial diagnostics and cleanup, so it is not a pure startup-only sample set. An additional 31.7% falls in libc without exact source symbols. Saved return-address hints often point back to buffer initialization and file IO, but those hints are not a full stack unwind.

Fresh-pad ingestion also has a measured cost. Two initial 809 MB shipments took 24.9 and 35.2 seconds inside the VM receiver. The completed live shipment took 23.3 seconds: 17.9 seconds reading its incoming stream, 3.0 seconds writing, 1.5 seconds hashing, and 0.8 seconds syncing, plus small remaining work. Host process counters confirm the dealer was active during both trials; source-level host-dealer samples were not collected. The phone negotiated USB at 5 Gb/s, which is not a measurement of application throughput.

The engine’s per-round timers also localize the pad stall: trial 2 spent 8.757 seconds in the fourth round’s foreground draft call. That interval includes the 8.370-second pad wait. Across all five rounds, foreground drafting took about 1.216/9.987 seconds; target verification took 15.389/23.718 seconds; accept, rollback, and observe work took 0.512/0.368 seconds. Background head timings overlap verification and must not be added to these foreground intervals.

The first optimization attempt did not fix the problem. An opt-in change paused target CPU workers at Shielded graph entry and allowed the next CPU graph to resume them. Forty real CPU graphs passed exact-output and pause/resume validation; a concurrent callback test verified that a background draft thread could not pause the target pool. However, both the control and candidate hit the 540-second work limit before completing a 16-token trial. Both cleaned up successfully. The candidate completed only one MTP round. **Parking remains off; there is no demonstrated inference improvement.**

Both attempts showed the host minting the next shipments and the app fetching them, followed by a long phone-to-VM import with no completion before the deadline. A new receiver diagnostic now reports its current operation once a second, including how long that operation has remained in flight and the bytes written. Its stages distinguish stream reads, encrypted-store writes, fsync, and publication. The diagnostic run completed both trials and cleanup in 527.23 seconds. The earlier import stall did not reproduce: live shipments completed in 18.55 and 21.46 seconds. Neither trial waited for pads. Overall throughput was 0.678 and 0.701 tok/s, or 0.689 combined; combined steady throughput was 0.720 tok/s. Socket-path time remained 16.79 and 15.78 seconds. This is below the retained baseline, and the receiver observer may itself influence scheduling; it is a diagnostic, not a demonstrated fix.

The host-dealer source gap has now been investigated in a **separate** isolated run. The unchanged production binaries used the real 27B model and public fixture keys to generate two 64-index shipments. This run completed and cleaned up in 26.47 seconds. Its rebuilt debug symbols match the original executable bytes and addresses exactly.

| Dealer source location | Operation | Share of the separate run's CPU samples |
|---|---|---:|
| `shielded-simd.c:420` | AVX-512 VNNI dot product in `refill_rows_blocked` | 30.6% |
| `shielded-simd.c:417` | Load weights for the same loop | 19.1% |
| `shielded-simd.c:419` | Accumulate in the same loop | 5.8% |
| `shielded-tee.c:717` | Weight registration | 7.2% |

The host capture contains 7,085 CPU samples with no lost, dropped, or malformed records. One short-lived thread exited before an event could attach. There are 454 samples without source lines. The capture includes startup as well as two mint operations; its sample percentages are not wall-time shares, and it is not an inference benchmark. It confirms where dealer CPU work occurs while the stalled phone runs establish that their next shipments had already been minted and fetched.

Measurement coverage and limits:

- The full 6,187,685-byte stderr snapshot was recovered, was not truncated, and matched SHA256 `1883e53b9d9eb09467e67ede8c611dde2c763116f34da2a2d8e92cd587963d07`.
- All guest wire spans and 3,410 total worker/forwarder exchanges were captured. Eight unstripped libraries were checked against the APK’s exact executable bytes and addresses for source attribution.
- CPU sampling captured 59,775 samples with no buffer drops. There were 23 timer-registration failures and 12,961 overruns. Short-lived threads can be missed, and CPU-clock samples can be biased by delayed signal delivery. They do not measure every executed line or exact exclusive time per line.
- The background span buffer filled and dropped 23,876 records. Granular refill spans are incomplete, especially in trial 2. The complete wire spans, CPU samples, and aggregate pad-wait counters remain separate evidence.
- Some system libraries lack source symbols. Host-dealer coverage in the original phone run is process CPU/IO and existing timing. The separate dealer run now provides source-PC sampling; it is not a retroactive profile of that phone run. Profiling overhead has not been isolated in a paired run.
- Phone cleanup was confirmed afterward. The original deadline and cleanup failures remain part of the result. Twenty tok/s with the complete Shielded path has not been demonstrated.

The original profile’s saved TCP capture shows 124 cumulative retransmissions (88,184 bytes) on the phone-facing socket and none on the worker loopback connection. One-second sample brackets extend beyond trial boundaries and overlap, so per-trial counter deltas cannot be summed as disjoint events. Retransmissions can be spurious or reflect delayed acknowledgments; the counters alone do not explain the socket delay. Existing prior transport tests already separated occasional multi-second stalls from ordinary slow round trips. A current-APK, no-model bridge profile is the next isolated measurement.

The current v27 no-model bridge diagnostic reproduced a 30-second request-body timeout. At frame 246, native `send()` accounting shows that the app had handed the whole request to its TCP socket, while the host was missing the final 4,112 bytes. This localizes that failure after the app-to-socket handoff; it does not identify one kernel/USB branch. The failed diagnostic and cleanup took 64.24 seconds. The matching ping intervention completed all 630 checked frames in 39.64 seconds, with median round trips of 9.625/21.454/56.283 ms for 64 KiB/256 KiB/1 MiB. Ping was alive across the frame window. This removes the reproduced long stall in one matched observation; ordinary latency remains high. The workload has no model, pads, or inference CPU burners and is not an inference benchmark.

The full profile independently reconciles the earlier MTP5 traffic calculation: each 16-token trial sent 171,091,626 request bytes and received 355,289,430 reply bytes, including headers. Minimum replacement-pad traffic adds 355,383,488 bytes for this same execution mix. At 20 tok/s the combined phone-bound requirement is 888.34 MB/s. Both flows share the observed 5,000 Mb/s USB link, whose deliberately generous raw upper bound is 625 MB/s before overhead. With unchanged execution mix and routing, the idealized raw transport ceiling is 14.07 tok/s, before CPU, protocol, and encoding costs. This is a conditional capacity bound, not achieved throughput; reducing pad traffic, reply volume, or exchanges is required to make 20 tok/s feasible on this link.

A further isolated bridge profile now separates CPU by source call and records the final timing interval. All 630 frames passed and every transferred byte was accounted for, with cleanup complete in 41.15 seconds. Across the bridge lifetime (including control waits), the thread used 7.965 seconds of CPU: 7.777 system and 0.189 user seconds. TCP `send()` consumed 4.295 CPU seconds, `poll()` 1.563, TCP `read()` 0.728, vsock `send()` 0.652, and vsock `read()` 0.571. The remaining 0.156 seconds is outside those call brackets, including instrumentation. Those figures describe the no-model diagnostic; a later actual 27B run collected the same breakdown independently of guest tracing, as detailed below. Android denied both kernel-plus-user and user-only simpleperf events. No kernel instruction profile was collected and no device permissions were changed.

The actual 27B bridge profile completed successfully in 493.81 seconds, with two 16-token trials, live replenishment, unchanged text and MTP decisions, zero fallback and zero verification failures. Overall throughput was 0.961708 and 0.908231 tok/s; steady throughput was 0.972083 and 0.969604 tok/s. Combined values were 0.934205 overall and 0.970842 steady. This is the highest completed short live-refill diagnostic steady measurement so far. It does not establish an isolated optimization gain; the subsequent same-APK profiling-off control is detailed below.

During bins wholly inside the app’s trial-marker receipts, the bridge consumed 3.043 and 2.485 CPU seconds, of which 97.7% and 96.2% were system CPU. TCP read used 0.663/0.678 CPU seconds; TCP send 0.574/0.625; vsock send into the guest 1.257/0.622; vsock read 0.136/0.143; poll 0.336/0.336. These bins cover 16.364/17.506 seconds of the 16.637/17.617-second decodes. App marker spans differ from guest durations by -2.06/+18.34 ms, but a common control-message delay is unbounded by this capture. These are app-observed windows, not exact guest boundaries. The V100 reached 25,847 MiB; the worker identity, offload counts and result checks passed. Trial pad-wait deltas were zero. Guest wire time was 10.855/12.203 seconds; the timers are nested and must not be added to the bridge totals.

Separating the original exact-v24 CPU samples by caller reveals another specific cost: the main wire-calling thread has 21–24% of its samples at `ggml_barrier`/`ggml_thread_cpu_relax`, separate from the background workers’ readiness polling. Roughly 28–30% is in libc without exact symbols. The other sampled hot source lines include outlier addition (`shielded-simd.c:938`), activation encoding (`:232`), descaling (`:240`), and vector copy (`vec.h:119`). These are statistical shares of that thread’s samples. The one-target-thread comparison subsequently completed its first checked trial at 0.440 overall / 0.437 steady tok/s and timed out before the second finished. Four target threads remain the retained setting; removing this coordination did not produce a demonstrated gain.


Update: the same-v29 profiling-off control completed both benchmark records at 0.804/0.631 overall and 0.766/0.638 steady tok/s, but its controller missed completion because the live Android log stream dropped the final messages. The durable app file contains all 172 export chunks, a successful engine exit and END; fresh retrieval, full capture gates and the 247,170-byte snapshot checksum all passed. It remains an originally failed full cycle with a recovered complete diagnostic, not a clean pass. This does not establish the profiled 0.971 steady pair as a repeatable optimization gain. The thread-count comparison then failed to demonstrate improvement, as described above. See 27b-bridge-profile-off-evidence.json and 27b-main-barrier-inline-proof.json.


The next diagnostic adds Android kernel scheduler events to the four-thread path and bridge call timers. A two-second capability check captured 544 scheduler intervals and runnable, running, and blocked states with no trace errors. This uses Perfetto’s supported configuration directory and changes no device permissions. The first actual capture completed both decodes at 0.742/0.593 overall tok/s. Its 16 MiB trace buffer filled during the second trial, so its scheduler figures are preliminary. Over the 21.25-second observed first-trial window, the bridge has 5.154 seconds running, 1.811 seconds runnable, and 14.242 seconds in interruptible sleep; these are diagnostic figures with trace loss, not clean baseline attribution. A larger-buffer capture is now running under the same 600-second limit.


The supported Perfetto profiling service succeeded in collecting kernel call stacks during a 42.55-second complete bridge-only diagnostic, even though simpleperf inside the app had been denied. No device permissions changed. Of 719 CPU samples identified by the native bridge call stack, 704 were kernel-mode and 15 user-mode; there were no reported trace errors. TCP send appeared in 432 samples, software TCP segmentation in 112, and the USB gadget transmit function `eth_start_xmit` in 148. These are nested inclusive counts and cannot be added. Copy routines also appear among the leaf functions. The leading leaf, `_raw_spin_unlock_irqrestore`, must not be equated with lock contention: its caller and interrupt-restoration context matter. Kernel function names were captured; exact kernel instruction offsets and source lines were not disclosed. This test has no model or pads and uses the existing ping stimulus. The current full inference run combines scheduler events with kernel-only call stacks to check the same costs on actual 27B work.

Method references: [Perfetto scheduler events](https://perfetto.dev/docs/data-sources/cpu-scheduling) and [CPU profiling](https://perfetto.dev/docs/getting-started/cpu-profiling). Trace analysis and numerical evidence are local measurements, not figures from those documents.


Actual inference kernel profile, 2026-09-09T11:03:34.263223+00:00

Actual 27B kernel capture b27-kernel-1 completed: inner PASS503.466s, original outer CLEANUP_FAILED508.991s due ADB query timeout. Follow-up confirms phone stopped and owned processes absent. One stopped dealer's unconfirmed320/64shipment809039872B and journal quarantined under exclusive bank lock using production schema/dead-child check; never reused. No trace errors/loss in23,470,307B capture. Trial overall.878805/.633102; combined0.735989, no gain. Actual bridge375/410samples, with vsock-send large allocation→direct compaction124/375 and84/410nested CPU samples. Native guest-send CPU1.611/1.137s. Kernel names only, not exact kernel source lines. Source at phone-reported common fa1d6308d1fe allocates kmalloc(len) with64KiB max packet; current native sends up to1MiB. New opt-in4KiB VM-bound cap implemented, TCP unchanged. Five native ASAN/UBSAN cases PASS5.389s. Preparing v30+matched full kernel capture; no run active yet. Evidence outputs/27b-inference-kernel-profile.json.

The trace attributes about33.1% and20.5% of bridge CPU samples to direct compaction underneath the VM socket packet allocation. These are CPU samples, not percentages of total decode time. Runnable scheduler delay is1.893/2.145seconds in observed18.046/25.283second windows. Most remaining bridge wall time is blocked; the native call timers distinguish empty polling and pending VM-bound data. [Kernel allocation source](https://android.googlesource.com/kernel/common/+/fa1d6308d1fe/net/vmw_vsock/virtio_transport_common.c).
