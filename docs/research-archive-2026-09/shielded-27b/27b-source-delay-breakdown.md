# Measured source delays: 27B Shielded inference

Latest completed cached-delivery run: `b27-direct-control-1`, APK v41, Q8_0, MTP5, Pixel 8 Pro protected VM and the verified owned V100 worker. Two 16-token trials took 18.023 s and 26.447 s (0.888 and 0.605 tok/s). All expected output/MTP/work checks passed; no missed pads, local fallback or verification failures.

**Most delay is at the synchronous transport calls.** Their complete exchange spans total 12.067 s and 18.144 s of the respective decode trials, about 68% of the combined 44.470 s. This is not 68% GPU compute: it includes the complete request/response path.

The table ranks ten regions that currently have timers. It is not a claim that every source line is instrumented. Values are milliseconds per 16 generated tokens, averaged across these two trials.

| Rank | Code location | Timed work | Mean elapsed ms | Trial 1 / Trial 2 ms | Mean caller CPU ms |
|---:|---|---|---:|---:|---:|
| 1 | `shielded-wire.c:324` | Wait for reply header | 7309.05 | 5986.48 / 8631.61 | 288.01 |
| 2 | `shielded-wire.c:342` | Read reply payload | 6127.32 | 4903.93 / 7350.70 | 886.48 |
| 3 | `shielded-wire.c:304` | Send masked request | 1351.55 | 914.46 / 1788.65 | 393.86 |
| 4 | `ggml-shielded.cpp:1606` | Restore outliers and output scale | 729.35 | 589.40 / 869.30 | Not separately measured |
| 5 | `shielded-tee.c:1830` | Acquire pads and mask input | 692.30 | 643.80 / 740.80 | Not separately measured |
| 6 | `shielded-tee.c:1935` | Unmask and verify output side | 473.50 | 359.50 / 587.50 | Not separately measured |
| 7 | `ggml-shielded.cpp:1445` | Encode activations and separate outliers | 441.15 | 293.10 / 589.20 | Not separately measured |
| 8 | `shielded-tee.c:1943` | Verify input side | 254.10 | 193.40 / 314.80 | Not separately measured |
| 9 | `shielded-wire.c:336` | Reserve response buffer | 7.52 | 10.36 / 4.68 | 7.21 |
| 10 | `shielded-wire.c:312` | Optional overlap callback | 3.78 | 3.13 / 4.44 | 4.17 |

Do not add nested/background timings to claim an exact wall-time decomposition. The `overlap_work` row can include RHS work in recipes that enable it. Tiny CPU/wall clock boundary differences are retained.

## Exact callsites and interpretation

1. `wasm/ggml-shielded/shielded-wire.c:324`

   ```cpp
   if ((rc = read_all(p->fd, h, SH_HDR)) != SH_OK) {
   ```

   read_all(fd, h, 9): waits until the response header arrives through GPU host, TCP, Android bridge and vsock. The timer cannot assign all this wait to GPU compute.

2. `wasm/ggml-shielded/shielded-wire.c:342`

   ```cpp
   if (size && (rc = read_all(p->fd, p->rbuf + used, (size_t)size)) != SH_OK) {
   ```

   read_all(fd, rbuf + used, size): receives the remaining packed result. Includes transfer and guest wakeup delays.

3. `wasm/ggml-shielded/shielded-wire.c:304`

   ```cpp
   int rc = write_all(p->fd, iov, iovcnt);
   ```

   write_all(fd, iov, iovcnt): sends the masked CRT planes and header. Can block on transport/backpressure.

4. `wasm/ggml-shielded/ggml-shielded.cpp:1606`

   ```cpp
   const double tp0 = sh_now_ms();
   ```

   Timed block calls outlier_add at 1616 and descale at 1620. Their individual times are not separated.

5. `wasm/ggml-shielded/shielded-tee.c:1830`

   ```cpp
   double t0 = now_ms();
   ```

   Includes dealt_wait/take_pads and mask_planes at 1870 plus request packing. Actual pad-wait counter is 0 in both trials, so this is not evidence of waiting for pad generation.

6. `wasm/ggml-shielded/shielded-tee.c:1935`

   ```cpp
   double t3 = now_ms();
   ```

   Packed path calls unmask24_fv at 1937: subtracts pads and computes Freivalds left-hand dot products in one pass.

7. `wasm/ggml-shielded/ggml-shielded.cpp:1445`

   ```cpp
   const double te0 = sh_now_ms();
   ```

   encode_checked at 1448 converts the private activation to field integers; the same timed block copies outlier channels.

8. `wasm/ggml-shielded/shielded-tee.c:1943`

   ```cpp
   if (!overlap) {
   ```

   fv_dots_x at 1944 computes private-input Freivalds terms. The cumulative counter also admits the overlap callback at 1756–1767, if enabled.

9. `wasm/ggml-shielded/shielded-wire.c:336`

   ```cpp
   if (size && (rc = reply_reserve(p, used + (size_t)size)) != SH_OK) goto fail;
   ```

   reply_reserve(): capacity check/reallocation. This measured region is small; its duration does not explain the large read waits.

10. `wasm/ggml-shielded/shielded-wire.c:312`

   ```cpp
   if (work && n) work(ctx);
   ```

   if (work && n) work(ctx): mostly the callback boundary in this recipe. Do not add to RHS time when the callback performs RHS verification.

## Ten longest individual socket phases

These are separate occurrences, not ten different functions. `CPU` is time consumed by the calling guest thread; elapsed minus CPU includes sleeping and scheduling. All ten have 0 caller minor/major faults; this does not rule out faults elsewhere in the VM.

| Rank | Trial / FIELD call | Actual callsite | Elapsed ms | Caller CPU ms | Guest runnable delay ms |
|---:|---|---|---:|---:|---:|
| 1 | 2 / 2814 | `shielded-wire.c:304` write_request | 356.912 | 158.620 | 0.693 |
| 2 | 2 / 2487 | `shielded-wire.c:342` read_body | 154.751 | 13.837 | 0.000 |
| 3 | 2 / 2793 | `shielded-wire.c:342` read_body | 129.818 | 7.097 | 4.536 |
| 4 | 2 / 2514 | `shielded-wire.c:324` read_header | 126.721 | 0.125 | 0.000 |
| 5 | 1 / 1569 | `shielded-wire.c:342` read_body | 114.567 | 16.459 | 2.374 |
| 6 | 2 / 2946 | `shielded-wire.c:342` read_body | 105.191 | 0.202 | 0.000 |
| 7 | 1 / 1459 | `shielded-wire.c:342` read_body | 103.828 | 5.910 | 0.000 |
| 8 | 1 / 1494 | `shielded-wire.c:342` read_body | 102.630 | 0.127 | 0.000 |
| 9 | 2 / 2672 | `shielded-wire.c:324` read_header | 98.386 | 0.073 | 0.000 |
| 10 | 2 / 2815 | `shielded-wire.c:342` read_body | 92.365 | 27.850 | 4.703 |

The clearest waiting example is FIELD 2514: 126.721 ms in the 9-byte header read, only 0.125 ms caller CPU, 0 guest runnable delay and 0 caller faults. That places the delay in waiting for completion, without proving which remote/host-kernel instruction caused it.

## Startup is a separate bottleneck

Before token generation, the `output.weight` registration alone took 30.971 s in this run: source 23.548 s (21.778 s read, 1.770 s authentication), encoding 3.590 s, link 3.753 s, commit 0.075 s plus smaller terms. These startup numbers explain test preparation time and are excluded from decode tok/s.

## Measurement limits

- Ten instrumented regions, ranked by accumulated elapsed time; this is not an exhaustive ranking of every source line in the process.
- Timers surround blocks and their callees, not isolated instructions. Background MTP activity and nested overlap mean rows should not be summed into an exact wall-time budget.
- Only socket source spans have separate thread-CPU measurements here. For the other five blocks, elapsed time must not be called CPU time.
- Kernel samples expose allocator/compaction call chains but do not provide exact per-line blocked wall time. Guest kernel stack attribution is unavailable in this capture.
- Startup/model registration, pad delivery, GPU kernels and Android bridge have additional nested or concurrent costs; the table isolates instrumented token-generation regions.

The three kernel locations currently under investigation are `virtio_transport_alloc_pkt` → `kmalloc` → `try_to_compact_pages`. Recorded stack samples establish that path runs; they do not provide exact elapsed milliseconds for each kernel source line. The 8 KiB cap experiment targets its allocation-size boundary.

Source root: `/home/steven/Projects/enclave`. Machine-readable details and source hashes: [27b-source-delay-breakdown.json](27b-source-delay-breakdown.json).

## Why `read_all()` is a waiting point

Header reads average 7.309 seconds elapsed per 16 tokens, but only 0.288 seconds of caller CPU. Body reads average 6.127 seconds elapsed and 0.886 seconds of caller CPU. The difference includes blocked time and scheduling; it does not prove an inefficient read loop.

On the host, receiving the complete request through producing the complete reply took 0.942/0.830 seconds total in the two trials. That includes host forwarding, worker handling, and GPU work. On the phone, first-to-last TCP reply reads took 3.639/4.298 seconds, while full TCP reply receipt to the last VM send took 1.187/2.768 seconds. These endpoint intervals overlap and are not an additive decomposition. They implicate the transport and VM delivery path rather than GPU computation alone.
