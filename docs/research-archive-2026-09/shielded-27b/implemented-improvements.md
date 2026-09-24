# Enclave Shield: implemented work since coordination began

Snapshot: 2026-09-09 07:15 UTC (September 9 in Phoenix). Based on the repository history from the start of Astra/Fable coordination at approximately 06:40 UTC September 8, the coordination log, and retained test receipts.

**Implemented does not mean a measured speed gain. The best retained 27B Shielded result remains 0.92 tok/s steady / 0.66 overall. The latest retained MTP5 + streamed-ACK recipe measured 0.762/0.783 steady and 0.752/0.765 overall. It improved over the preceding live-refill MTP3 run, with delivery variability still present. No later result has surpassed the 0.92 steady best.** Many performance options remain opt-in; they are not all enabled in every APK or live worker.

## Changes aimed at execution speed

| Implemented change | What it changes | Evidence or current limit |
|---|---|---|
| MTP draft-ahead | Draft the next speculative batch while the target verifies the current batch. | Small-model measurements showed much less separately exposed draft time; no isolated 27B gain established. |
| Verification/transport overlap | Compute the trusted input-side checks while the socket request is in flight. | Small-model paired tests showed a modest benefit, roughly 2 ms/token in that experiment. |
| Local residual/normalization grouping | Keep eligible residual, RMS normalization and scaling operations together in a Shielded scheduler split. | Small-model pairs were approximately neutral. This is not full matrix/exchange fusion. |
| Per-group CPU/GPU placement | Choose which calibrated operation groups go to the GPU and which use phone CPU layouts. | The FFN-focused small-model recipe helped reach about 20 steady tok/s. It does not establish a useful 27B placement. |
| 27B MTP draft-cap tuning | Increase the speculative cap from 3 to 5, reducing the measured 16-token generation from six rounds to five. | Two live-refill trials: 0.715 combined overall / 0.750 steady tok/s versus 0.581 / 0.560 at cap 3. Same generated text; about 25% more pad cells. Short-run improvement, still below the earlier 0.92 steady best. |
| MTP head thread tuning | Limit draft-head CPU threads to reduce contention with verification. | Helped the small-model placement recipe; no isolated 27B result. |
| Parallel dealer minting | Mint independent pad groups using multiple CPU threads. | Implemented and tested for equality with serial minting; no claim that it sustains 20 tok/s on 27B. |
| Balanced dealer scheduling | Distribute unequal groups and size scratch for each thread's assigned work. | Optional implementation; workload-specific gains require measurement. |
| Persistent dealer | Keep the model registered across mint jobs rather than reload/re-encode it for each shipment. | Implemented in the dealer and its process adapter. Reduces repeated preparation, not an established decode-speed gain. |
| Sparse pad generation | Describe, plan and mint requested missing pad intervals instead of always generating full ranges. | Codec, authenticated files, planner and mint path implemented; not all used by the current live delivery recipe. |
| Vector CRT pad refill | Vectorize the final modular reconstruction in CPU pad generation. | Optional implementation used by the development dealer; no demonstrated 27B end-to-end gain. |
| Tiled pad-check setup | Read weights contiguously while preparing trusted checks. | Implemented to remove inefficient strided preparation reads. |
| Tiled online pad verification | Arrange imported-pad checks for vectorization and bounded integer sums. | Implemented; no isolated 27B throughput gain established. |
| ARM request kernels | Optional tuned phone masking/unmasking/check arithmetic. | Implemented for comparisons; not a demonstrated 27B speedup. |
| ARM SHA-256 acceleration | Use ARM SHA2 instructions when available, including optional encoded-cache hashing. | Accelerates a primitive; this is not a tokens/s result. |
| Native phone worker bridge | Replace the Java data-pump path with a native loop and bounded buffers. | Implemented and exercised; native echo comparisons did not show a consistent win. |
| Bridge ring buffers | Avoid moving buffered bytes repeatedly under backpressure. | Implemented, with cancellation/deadline fixes. No demonstrated 27B tok/s gain. |
| Pipelined public-weight upload | Authenticate/read the next cache chunk while the current chunk is sent. | Optional implementation; affects initialization/upload. |
| Worker public-weight RAM cache | Reuse public matrices by digest across connections, avoiding warm reuploads. | Actual CPU and V100 fixtures confirmed correct reuse and zero warm model upload. The latest complete 27B run used all 409 cached matrices and reached decoding; no isolated decode-speed gain established. |
| Configurable GPU graph cache | Expose captured-graph capacity and reuse counters. | Implemented; no established 27B decode gain. |
| Optional V100 MR8 kernel policy | Select a different field-matrix kernel for relevant shapes. | Added following kernel measurements; kernel throughput is not full-model throughput. |
| Configurable maximum row batch | Expose the supported Shielded row limit through manager configuration. | Implemented; no independent speed claim. |
| Streamed pad-ACK hashing | Optionally hash shipment bytes during reception to avoid a separate acknowledgment reread. | Two trials completed on the original cached-file path: 0.762/0.783 steady tok/s, combined 0.772 versus 0.750 without the option. Observed 3% difference, too small to separate confidently from live-delivery timing variation; tentatively retained. |
| Direct streaming of pad shipments | Optional app path forwards HTTP bytes into the VM receiver without writing and rereading an Android temporary file. | Local commit `87fb47b3`, not pushed. Host fixture passed; the 27B trial timed out before completing any trial (542.19 seconds including cleanup). No tok/s result and not retained in the speed recipe. |
| CPU pool polling control | Expose worker polling behavior for phone scheduling comparisons. | Implemented; setting polling to 0 regressed the completed 27B trial to 0.336 steady tok/s and the run timed out during trial 2. Default 50 retained. |
| Small-weight residency threshold | Keep small tensors resident while streaming large tensors, targeting repeated SSM reads during decode. | The latest 27B run confirmed zero additional source reads during both decode trials, but did not surpass the previous best tok/s. |

Moving pad HTTP/relay traffic onto USB networking was also tested. It completed but regressed to 0.570/0.630 steady tok/s, so the original ADB relay route is retained. Disabling CPU polling and direct pad streaming also failed to improve the measured recipe. These options are not counted as speed gains.

The combined small-model work reached repeatable results around **20 tok/s steady and 17–18 tok/s overall** in the later bounded, verified trials. Historical small-model runs reported higher steady figures under other configurations and measurement conditions. These figures must not be transferred to the 27B model.

The bounded 0.8B configuration offloaded FFN gate/up matrices and performed the other operations inside the trusted phone. The 27B configuration offloads 409 matrices across attention, SSM, FFN and the output/head paths. This placement difference also prevents a direct throughput extrapolation.

## Changes that made large-model loading and reuse possible

1. **Authenticated streaming weights:** read and verify individual tensors without keeping the entire 29 GB GGUF in phone RAM; CPU and Shielded paths consume private verified bytes.
2. **Private GGUF metadata:** serve the authenticated model header directly from private memory, avoiding mutable host-backed metadata after verification.
3. **Compact encoded-weight storage:** retain authenticated encoded blocks on disk, plus smaller trusted verification data, instead of all encoded matrices in RAM.
4. **Lower peak memory:** release raw tensor copies after encoding and discard completed source/model page-cache ranges to reduce pressure on Android and the pVM.
5. **Named, larger VM instances:** configure the separate 64 GiB store and effective RAM without silently deleting an incompatible existing instance. The Pixel 8 test recipe uses approximately 6 GiB VM RAM.
6. **Signed reusable prefix state:** produce and consume a container binding target-model state, MTP-head state, pending head data, model identity, calibration and prompt-token boundary.
7. **Catalog model admission:** authenticate pinned model metadata and tensor identities, then check data at use time instead of requiring a fresh whole-model scan for every admission.
8. **Pre-encoded public artifacts:** host conversion and authenticated phone readers avoid repeating source encoding when an artifact is available. All 409 27B host artifacts were produced and independently checked; only 13 were provisioned to the phone in the latest bounded preparation run.
9. **Model reuse tags:** cache model identity hints in the correct app directory and persist guest tags durably. Tags do not replace authentication.
10. **Cache-only model admission:** reuse the retained model or refuse without truncating/retransmitting it. Confirmed on the retained 27B phone model.
11. **Resumable artifact preparation:** HTTP feed, a preparation mode without engine/dealer startup, atomic file publication, completed-file reuse, deadline cancellation and receiver shutdown before recording progress.
12. **Optional larger Android writes:** combine artifact-feed writes. The measured pair did not improve transfer speed, so this remains off.

13. **Optional concurrent source reads** (`f075202f`): added four-reader testing while preserving authentication. The measured resident-model load regressed from 25.2 to 66.5 seconds; the run was stopped early, and this setting remains off.

14. **Next-source prefetch** (`4ff9ff77`): read one tensor ahead while authenticating, encoding and checking the current tensor, with one background reader and at most 128 MiB of extra private bytes. The v17 combined recipe completed a full two-trial 27B cycle in 526.96 seconds; an isolated prefetch speedup is not established.

These are loading, memory and setup capabilities. They have not raised the retained 27B tok/s result.

## Correctness and root-of-trust changes

- Bind the pad recipient and signed bootstrap to the pVM key, approved payload, model, calibration and current grant; separate development/build admission policy from legacy routing.
- Bind pad windows to fresh request nonces; make final receipts single-use; stop issuing windows after finalization.
- Persist counter reservations before signing and prevent reuse after restart, exhaustion, replay-history eviction or corrupted ledger state.
- Implement pVM-signed delivery acknowledgments and use authenticated delivery progress for planning and deletion.
- Keep fetchers, acknowledgments and cancellation within one VM session; fix pruning/import races and unnecessary refetching of spent pads.
- Check shipment dimensions, complete ordered groups, sparse ranges, file extents, cell uniqueness and complete publication; retain held file descriptors while import and pruning overlap.
- Reject malformed or ambiguous attestation fields, invalid pin bytes, zero Diffie–Hellman secrets, failed signatures and incomplete calibration hashes.
- Validate model bytes before granting their seed; authenticate private weight/prefix copies to close check/use races.
- Fix SIMD startup overreads, unsafe activation/reply ranges, integer-overflow cases, undefined NaCl shifts, setup-allocation failures and cleanup ownership.
- Retire verification state after bad GPU products or imported pads so an untrusted peer does not get repeated attempts against the same private challenges.
- Harden the legacy anchor response lifecycle, including replay rejection, single-use pending responses and secret cleanup.
- Fix transport cancellation, interrupted syscalls, zero-progress writes and background-worker cleanup.

These reduce concrete failure modes. They are **not proof that the complete system is bulletproof or production-attested**; the current phone setup still uses development attestation.

## Measurement and test-cycle changes

- Separate actual emitted-token counts, overall decoding time, steady decoding time, MTP acceptance and fallback status.
- Repeat generation from one in-memory prompt snapshot, preserving identical inputs while consuming fresh pad indices.
- Capture bounded, durable session logs and exported stderr; reject incomplete captures and failed runs instead of presenting them as successful benchmarks.
- Measure registration, socket phases, streamed-source reads, encoded-cache reads, imported-pad waiting, GPU utilization and per-artifact transfer phases.
- Add framed echo/bridge probes and GPU/process identity checks to distinguish transport work from actual GPU inference.
- Add the controller enforcing five-minute default / ten-minute maximum local cycles, including preparation and cleanup.
- Repair test packaging and fixtures so the measured code paths can be checked without leaving reference workers behind.
- Run direct 27B Q8 V100 baselines: **27.60 tok/s on U1**, **24.06 on U2**, and **25.70 using both** under those direct-inference conditions. These are baselines, not Shielded improvements.

## Deployment status of recent candidates

- **Host public-cache loader:** Fable's local tool fills the worker cache, checks hits before uploading and supports bounded resume. CPU and GPU validation complete; all 409 entries were used in the complete v17 27B run.
- **Required public-cache mode:** implemented in commit `cf7b12bd`, independently reviewed, and built into APK v15. It authenticates weights and prepares private checks, then releases temporary rows; cache misses and unavailable fallback refuse. Focused checks passed. Two earlier attempts timed out before decoding; combined with source prefetch in v17, it now completes within the test-cycle limit. No isolated decode-speed gain is established.
- **Guest receiver write buffer:** local prototype passed checks but is paused; it is not in the phone APK and is not a measured speed improvement.

Full matrix/exchange fusion, remote confidential-GPU pad generation, phone-GPU pad generation, Q4_K_M support, and the masked-correction redesign are **not completed implementations**. The current performance work remains on the existing Q8 design.

## Commit-level change history

The appendix below includes implementation, supporting tests and documentation since coordination began. Automated image repins and release bookkeeping are omitted. A commit is not a separate measured speed improvement, and some entries repair or supersede earlier work.

- `a908bb8a` — Phone engine: draft-ahead - the MTP head drafts the next round while the target verifies
- `f3de882f` — Bound the packed SIMD self-check vector to prevent startup overreads
- `22638fba` — Phone engine: the bridge echo probe also times two requests in flight
- `3e15d4e1` — Overlap trusted verification with socket transit behind an opt-in knob
- `505827bc` — Reject out-of-field int32 replies before trusted arithmetic can overflow
- `6ff887a9` — Keep calibrated residual norm islands local within shielded graph splits
- `d9b8b754` — Dealt pads delivery: keep the phone's bank ahead of a 16-row decode
- `1d0a4ffd` — Reject unsafe activation ranges before masking and trusted integer arithmetic
- `1a021e6c` — Harden anchor response lifecycle and trusted arithmetic boundaries
- `3b3c0cda` — Validate anchor setup geometry and clear secrets on failed preparation
- `84c1e1a7` — Bind AVF pad recipient to attested transport and approved payload
- `292f0df4` — Remove undefined negative carry shifts in bundled TweetNaCl
- `e9233370` — Authenticate pad seed grants against trusted pVM asset and key context
- `4ef8eb7b` — Phone anchor: the attested key signs only this pVM's own pad-binding transcript (android-avf-pvm/v2)
- `fb9eb49a` — Configure AVF pad build admission independently from legacy routing
- `8dbb1c39` — Shielded dealer: mint a shipment's groups on several threads (SHIELDED_MINT_THREADS, default 1)
- `8be90d2b` — Bind signed pad windows to fresh pVM request nonces
- `6834d956` — Prevent dealt pad counter reuse across restarts and exhaustion
- `c8beb390` — Persist pad ledger reservations before signing and reject corrupt state
- `59ef6866` — Phone anchor: authenticated pad bootstrap with measured, fail-closed pins
- `22ec66a9` — Make v2 phone final receipts single use across replay eviction
- `bd169bc0` — Keep pad delivery acknowledgments and fetchers within one VM run
- `eb02384f` — Stage and hash the model in the pVM before any seed is granted for it
- `11664510` — Make seed box derivation allocation free and reject zero DH secrets
- `93adc3f8` — Read the anchor mode pin as exact canonical bytes
- `9238268d` — Retain shipment descriptors while pad imports race pruning
- `416d7dc0` — Purge a rejected model, drop a pending seed request on re-stage, tamper and fresh knobs
- `d67520d7` — Do not let a stale pin survive into the next APK build
- `dea2dd65` — Propose the pVM-signed pad delivery acknowledgment (PADACK v1)
- `5c3f67cb` — Validate pad shipment extents and fail closed on header hash allocation
- `7b18a44a` — Track authenticated pad delivery independently of reservation
- `6fc5530a` — Plan and prune dealer shipments from authenticated delivery progress
- `4e6e0e9f` — pVM-signed pad delivery acknowledgment: checker, receiver, PADACK, app relay
- `2ca8e8f9` — Judge and hash a shipment through the descriptor the receiver holds
- `cb78f987` — Retry signed pad delivery acknowledgments within each app session
- `66f49d50` — Refuse shipment deletion until signed delivery progress covers it
- `cb28d3a2` — Accelerate anchor SHA256 with runtime-gated ARM SHA2 blocks
- `a2b233d6` — Signer reports failure, one owner for the control channel, one lock for its writers
- `315b09d0` — Expose the selected anchor SHA256 backend for guest verification
- `5e6aa7b2` — Engine tests the signer's status against zero
- `1bdf9fc5` — Add opt-in per-group CPU layout and matched placement profiles
- `ceccbca5` — Say which SHA-256 backend the pVM selected in the PINS line
- `b1507787` — Allow ANCHOR_FINE_PLACEMENT through the engine environment allowlist
- `fa4031a3` — Fail weight registration closed when verification setup fails
- `869cece2` — Document actual delivery acknowledgment ordering and replay semantics
- `f8402472` — Reject zero-DH shipment keys before NaCl key derivation
- `8f488fcb` — Classify what may land on the pads port: shipments, the prefix assets, nothing else
- `7ed800e3` — Hash the calibration whole, or not at all
- `b28a5b4e` — Add opt-in native echo diagnostic to isolate phone transport costs
- `44fcd1c1` — Verify and load the prefix state through one held descriptor; abort on an unhashable calibration
- `b8e8f295` — Probe the encrypted store at boot: filesystem, size, fs-verity, userfaultfd, RAM
- `807bc5c9` — Cache public encoded weights with authenticated bounded reads in dealt mode
- `c6861f03` — Storage probe: policy versus support, AuthFS presence, user-mode-only userfaultfd fault
- `d00d50de` — ANCHOR_WEIGHT_CACHE=1 selects the compact weight cache inside the store; MEM lines around the engine
- `4cd59c01` — Name the VM instance explicitly; never delete an incompatible one on its own
- `a15cbd52` — Derive dealt masks from the authenticated shipment group ordinal
- `bc7dc69b` — Abort cache initialization failures before uploading incomplete weight groups
- `58014149` — GGUF header walk and single-pass per-tensor digests for the pVM model stage
- `ac2ed92c` — Expose incremental SHA256 for one-pass model and tensor authentication
- `573069b2` — Authenticate private weight copies and keep fallback off untrusted mappings
- `6f40afca` — Model stage: one hashing read walks the GGUF header, pins the file and digests every tensor
- `1e36d69c` — Authenticate streamed weight transfers before any backend can consume them
- `acfd7f98` — Split socket exchange timings and reject writes that make no progress
- `640ac727` — Verified private loading in the pVM engine: header from the stage, every tensor hashed before use
- `81afb1e6` — No host-backed home for the verified header
- `2d1bea66` — Serve verified GGUF metadata directly from private memory
- `100c764c` — Retain verified prefix bytes for race-free state loading
- `7a93de91` — Header from private memory, streamed weight sources, prefix state from the verified snapshot
- `6ae0e99c` — Prefix state: verify, then refuse until the envelope adapter lands
- `8591390a` — Remember the model's cache tag in a sidecar keyed by size and mtime
- `299393ab` — Restore signed prefix snapshots through the llama memory-state envelope
- `abf98289` — Prefix state through the proved adapter; wire-phase lines reach the control channel
- `b9d3c526` — Measure streamed weight reads separately from encoded cache reads
- `7026fce0` — Model receiver: exact copy under faults, both descriptors closed on failure, tag only after fsync
- `b2cb9c07` — The stage table carries the whole-model digest from the same read
- `065cb3a2` — Keep the guest's page cache small while a model streams in and is hashed
- `d41e007a` — Share the tested model SHA256 implementation with prefix tooling
- `e220ae74` — Bind signed prefix snapshots to the actual model and calibration
- `9479d7d6` — Require cached prefixes to match complete prompt tokenization
- `0223c2ae` — Release authenticated raw weights before cache writeback and upload
- `fcd55c9d` — Prefix v2 with the whole-model digest, exact token boundary, SOURCE counters
- `474f42a1` — Head state export/import for the compound prefix artifact; bounded prefix and calibration reads
- `4bf0f01b` — Bind target and MTP prefix state in one authenticated private container
- `86392281` — Mint authenticated target and MTP prefix state with an optional producer build
- `0f03d18f` — Engine status: sticky mtp_fallback reason, loop-end status, escaped completion, failed runs exit 3; drop streamed source pages from the guest cache
- `8cd6f669` — Bind dealer assets to consumer grants before changing a pad bank
- `7eff6924` — Tile pad-check preparation for contiguous reads with exact bounded sums
- `b82d430c` — Report failed decode runs without successful throughput summaries
- `fe1c1812` — Offer ARM-accelerated SHA256 for authenticated temporary weight caches
- `00dc6b2b` — Keep receipt state retryable after persistence errors and reject count overflow
- `911025bd` — Engine consumes the compound MTP prefix container; allow the tiled pad-check and SHA-256 cache knobs
- `190dc799` — App: report updatable-VM support in the gate and the instance's effective RAM/storage after retrieval
- `d1b3cec6` — Link: opt-in pipelined upload of cached weights (SHIELDED_UPLOAD_PREFETCH=<MiB>)
- `5b7f492e` — Reuse public worker weights in a bounded optional RAM cache
- `09638b64` — Engine result line carries identity, the requested budget and the MTP counters
- `7d8ff296` — Engine: calibration digest for the result line is read at start of run, from the verified APK mount
- `df75e78f` — Negotiate verified public weight reuse without warm uploads
- `de9d7472` — Engine env allowlist: SHIELDED_PUBLIC_WEIGHT_CACHE (Route A client, df75e78f)
- `26cc51ae` — Retire verification state after failed products to prevent unsafe retries
- `cb043cd9` — Split registration timings to identify source, encoding and verification costs
- `91889d99` — Tile online pad verification into exact bounded sums for vectorization
- `9bc92859` — Anchor app: opt-in native worker bridge (--ez nativebridge true)
- `6a2b1e57` — Engine env allowlist: SHIELDED_PAD_CHECK_TILED (91889d99), next build
- `437b7d2e` — Native bridge integration: lock the cancel handoff, one cleanup scope, direct Os.write, reject pace
- `6ef800c8` — Validate sparse pad layouts against canonical groups and reserved ranges
- `3ac3f2ec` — Native bridge cancellation: half-close the cancel socket instead of writing a byte
- `60d90ed2` — Bind sparse pad manifests to complete ordered groups and immutable identities
- `a241558a` — Worker-bridge frame diagnostic: bridgebench mode (guest -> app pump -> TCP echo)
- `2be96fee` — bridgebench: explicit framed protocol (length prefix, read-all-then-echo, timeout, content check)
- `f6163ee0` — Retire links and backend after background pad integrity failures
- `532e4d15` — bridgebench: reusable host-tested framed loop, deadline both directions, abort on first failure
- `acd8fa74` — bridgebench follow-through: exit code, MSG_NOSIGNAL, length bound, strict gate, API guards
- `38a6bc92` — Export validated registered pad geometry for canonical manifest binding
- `d65b0e81` — Anchor APK versionCode 2: forward same-signer update keeps the anchor64 store
- `4904f811` — Include calibrated MTP head groups when minting pads for MTP consumers
- `e54bd657` — Reject incompatible delivered pad groups before uploading model weights
- `b6323859` — Observe background link retirement before planning or cached graph execution
- `f3024743` — App: grant a pad seed only in engine mode; versionCode 3
- `ec020752` — Retain pad shipments until in-flight imports publish in ring order
- `ab095e9b` — App: prune the pad prefetch cache by the ack floor, not the reservation mark
- `01ed4367` — Anchor APK versionCode 4 (forward update for b27-5b: ec020752 prune fix + ack_floor)
- `017e2634` — Correct the ack_floor prune rationale: alignment with durable delivery, not a loss fix
- `f5bbbe03` — Add bounded sparse pad descriptor codec without changing live delivery
- `2d8f0747` — Publish only complete pad shipments and reject repeated cell nonces
- `d3b92ba7` — Retain receipt nonce history to prevent replay after reservation eviction
- `2baf50c8` — Reject malformed AVF DER lengths and ambiguous security fields
- `170014f8` — Attribute the slowest shielded socket exchange to its public node and phases
- `553eda44` — Engine MTP per-round + prompt-observe + steady-denominator telemetry (SHIELDED_PROFILE)
- `3722e83e` — Plan only missing sparse pad intervals under bounded delivery budgets
- `deeb773c` — Stop issuing new pad windows after a final pVM receipt
- `9c5128cf` — bridgebench: START/END diagnostic handshake so the link watchdog brackets a LIVE socket
- `6811c7a8` — Diagnostic APK versionCode 5; anchor_frame_control host tests (ack/timeout/nonzero-ack)
- `d8cde59e` — bridgebench: per-frame failure instrumentation (phase, direction, bytes moved)
- `ab3d1e6c` — Keep the CPU dealer registered across bounded private pipe jobs
- `de03a6e3` — bridgebench: deterministic frame-failure stats on every exit
- `5e99034b` — dealer-loop: opt-in persistent-child adapter (default off)
- `702af5af` — Add optional balanced CPU pad mint scheduling
- `2008621f` — dealer-loop: harden the persistent-child adapter (still default off)
- `57bffe9b` — dealer-loop: safe adapter startup cleanup
- `a1ac8f9c` — Make captured graph capacity configurable and report cache behavior
- `0f084cee` — Report actual MTP emissions and explicit decode timing denominators
- `22804de4` — dealer-loop: adapter constructor requires an int mtp
- `b90f7926` — Keep diagnostic worker phase timing per connection
- `0c5af65a` — Attribute trusted exchange phase totals to each link
- `edd66d75` — engine: default-off diagnostic stderr export + ggml INFO opt-in
- `b280ee0c` — Capture bounded GPU observations and framed worker intervals
- `65b9845f` — manager: opt-in nnShieldedMaxM -> SHIELDED_MAX_M (1..64)
- `76b142a4` — Add authenticated sparse pad files with bounded no-replace publication
- `c7ad9055` — Mint requested sparse pad ranges with canonical domains and bounded CPU scratch
- `c72189f1` — Size sparse mint scratch for each CPU lane’s assigned groups
- `49b9f15e` — Preserve GPU staging cleanup ownership when buffer growth fails
- `e15d7124` — fix(shielded): reuse caller scratch when blocked refill allocation fails
- `2e363e93` — Add opt-in MR8 kernel policy after balanced V100 measurements
- `8c1d0f2d` — Add opt-in vector CRT epilogue to accelerate CPU pad refill
- `f2eac90a` — Honor native bridge cancellation and deadlines during syscall interruptions
- `89667679` — Avoid native bridge buffer compaction under backpressure
- `e5421696` — Add opt-in ARM request kernels for controlled phone comparisons
- `ba9100a2` — Tag decode counter snapshots so long runs can be reconciled
- `341dfb12` — Anchor app: opt-in per-leg capture file and burner stop at leg end
- `904dfe1c` — Add opt-in streamed pad ACK hashing to avoid a shipment reread
- `2e1e6fce` — Expose CPU pool polling for controlled phone scheduling comparisons
- `2482a252` — Anchor engine: opt-in size floor for streamed weight sources
- `b3a4a70e` — Anchor app: keep the model-tag sidecar in the app's own files dir
- `011da313` — Anchor engine: in-session repeat trials from one prompt-state snapshot
- `b4f30619` — Anchor bench records: reject internally truncated records
- `8363bbe7` — Anchor bench fixture: absurd doubles are refused, not expected to fit
- `302886b2` — Test weight-reader uploads with a valid empty dealt bank
- `8e428c87` — Add measured catalog readers for reusable public model weights
- `9b5e8cb4` — Ship imported AVF and pad modules with the relay
- `23bbc4c1` — Supply valid bank and asset identities in security fixtures
- `661c3f3b` — Inject snapshot read faults through fortified libc calls too
- `7619992d` — Run the CPU reference worker without CUDA test dependencies
- `b641dc80` — Release worker fixture resources promptly after startup
- `87d19beb` — Anchor: catalog-v1 model admission and encoded public-weight artifacts (opt-in)
- `44243d8b` — Avoid refetching spent pads during bank startup and downloads
- `08561658` — Anchor: host HTTP artifact feed into the VM and a no-engine preparation mode
- `368a8471` — Account for imported-pad waiting in link profiling
- `ede8b8b4` — Anchor: quiesce the artifact receiver before the PREPARE snapshot; durable model cache tag
- `c6ed7dd0` — Anchor app: optional coalesced artifact-feed writes (artifacts_coalesce, default off)
- `f1f418cf` — Keep receiver and receipt tests aligned with runtime behavior
- `d9d98213` — Measure artifact receiver phases without changing default ingestion
- `9cc9b54a` — Anchor: cache-only model admission and an explicit ARTIFACT_PROFILE control line for PREPARE
- `cf7b12bd` — Shielded: required public worker cache mode releases encoded rows after the private checks

- `f075202f` — Anchor engine: opt-in concurrent striped reads of large staged sources

- `4ff9ff77` — Shielded: opt-in prefetch of the next streamed source while the current one is authenticated and encoded
