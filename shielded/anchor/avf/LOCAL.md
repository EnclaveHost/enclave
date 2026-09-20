# Mode local: the whole model inside the protected VM

The split engine (`payload/engine.cpp`) keeps the trusted half in the VM and sends masked planes to an
untrusted GPU. Mode local is the phone-only tier: **every weight use, activation, KV row and sampled
token stays inside the protected VM**, on its own CPU. No worker, no pads, no calibration, nothing
blinded, because nothing leaves. It is the same attested payload (`libanchor.so`), the same model
admission, and the same verified loading; only the engine library and its CPU module differ.

## What it is

| piece | file | role |
|---|---|---|
| mode line | `payload/anchor_local.h` | `LOCAL model_bytes=N threads=1..16 ctx=512..32768`, strict, once; conflicts with ENGINE/ECHO/BRIDGEBENCH/SHAPE/`WORKER bridge` are refused, never resolved by precedence |
| dispatch | `payload/anchor_payload.c` `run_local()` | stages the model exactly as engine mode does (one hashing read: whole-file digest against the pin, per-tensor digests), loads `liblocalengine.so`, accepts ONE conversation on vsock 7781 |
| engine | `payload/engine_local.cpp` | verified loader (header from private memory, every tensor hashed against the staged table before use, repacked FROM the verified bytes), one context, KV kept across turns, streamed text |
| chat grammar | `payload/engine_local_proto.h` | `GEN <max_new> <temperature_milli> <hex message>` / `RESET` / `BYE` in; `READY` / `TXT <hex>` / `STATS k=v` / `ERR` out |
| CPU module | `libggml-cpu-repack.so` | the pinned llama.cpp's CPU backend built with `GGML_CPU_REPACK=ON`; the split engine's module stays `OFF` because its encoder reads plain rows |
| app protocol | `host/app/LocalChat.java` | pure `java.*`: request/plan builders, UTF-8 reassembly across token pieces, the session |
| app wiring | `host/app/Main.java` (`mode local`) | model stage, `LOCAL` + `RUN`, the conversation port; `--es ask 'a\|b'` runs scripted turns and logs counters |
| test | `test/anchor-local-proto.test.mjs` | the app's builders cross-fed into the VM's parsers under ASan/UBSan; every refusal |

Catalog authentication (`model_auth catalog`) is not wired into the local engine yet and is refused by
both sides; mode local stages with the whole-file digest (a `protected` build pins it in
`assets/model.sha256` like any other).

## Build and run

```
./build-ggml-arm64.sh                                                   # the pinned llama.cpp, plain rows (as before)
GGML_CPU_REPACK=ON ./build-ggml-arm64.sh "$PWD/out/ggml-arm64-repack-work"   # the repacking CPU module (absolute work dir)
./build.sh engine-pvm && ./build.sh anchor                              # liblocalengine.so rides along when both pieces exist
adb install -r out/anchor.apk && adb shell pm grant host.enclave.anchor.avf android.permission.MANAGE_VIRTUAL_MACHINE
adb shell run-as host.enclave.anchor.avf sh -c 'mkdir -p files && cp /data/local/tmp/model.gguf files/model.gguf'
```

Then from adb: `ASK='first|second' host/local-run.sh`
(gated: phone awake and unlocked, thermal status 0, big cores uncapped). The model is streamed into the
VM's encrypted store once (3.2 GiB in 94 s) and reused on later boots by its cache tag.

The model used for the numbers below: `gemma-4-E2B-it` converted with the pin's `convert_hf_to_gguf.py`
and quantized `Q4_0` (3,360,161,216 bytes, sha256 `5bf274a5…89fc48`). The pin's converter reads
`global_head_dim` from the top-level config; this checkpoint keeps it under `text_config`, so the
conversion needs that one lookup patched (not part of this repo's pin).

## What was measured (Pixel 10 Pro XL, Tensor G5, 2026-09-18)

| | decode tok/s | prefill tok/s |
|---|---|---|
| this llama.cpp pin, native `llama-bench`, 6 big cores, cool | 16.3 ± 0.2 | 169 |
| mode local in the non-debuggable protected VM, first build (default pool) | 14.4 / 13.4 / 11.5 over three back-to-back turns (154 / 321 / 304 tokens) | 64-90 (15-26-token prompts) |

**vCPU placement decides the number.** Without `setShouldBoostUclamp(true)` the host scheduler was sampled stacking two of the
six busy vCPU threads on one big core while another idled; ggml splits every matmul evenly, so the pair sets the pace:

| VM instance | decode tok/s (rested phone, cool start) | vCPU threads |
|---|---|---|
| no boost, clean placement by luck | 14.4 / 13.4 | roaming |
| no boost, two vCPUs on one core | 7.1 / 5.8 | roaming, e.g. v4 and v7 both on core 5 |
| uclamp boost requested (now the default for mode local) | 13.5 / 12.2, clocks uncapped to the end | vCPU *i* on core *i* in every sample |

The boost is fixed at instance creation (`--ei fresh 1` recreates one) and needs the hidden API reachable
(`settings put global hidden_api_policy 1`). A never-sleeping pool (`poll=100`) and pinning the pool to the high-capacity
vCPUs were also tried and measured 1.4-3.2 tok/s, but on a heat-soaked phone without the boost, where the unmodified
build measured 1.7-2.0 as well: **inconclusive, not a verdict**. The engine keeps ggml's default pool.

Boot to `READY` with the model already in the store: about two minutes (VM boot 10-15 s, the stage's
hashing read of 3.2 GiB, then the verified loader: 602 tensors hashed, 316 repacked, 61 s). Both reads
are bounded by the encrypted store (about 100 MB/s).

The same phone runs Google's LiteRT-LM CPU build of this model (mixed int4/int2 weights, MTP drafter)
inside a protected VM at 20-21.7 tok/s (18-19 without the drafter); llama.cpp's Q4_0 is the slower
engine here, and it is the one this app builds reproducibly and authenticates tensor by tensor.
`gemma4-assistant` (the MTP drafter) exists in the pin; wiring it as a draft model is the known lever.

## Speculative rows (optional)

`--es draft <gguf> --ei draft_max 1..4` streams a drafter into the VM (vsock 7783) and the engine drives it with llama.cpp's
own speculative helper (`libllama-common.so`, built in the repack work tree with `-DLLAMA_BUILD_COMMON=ON
-DCMAKE_POSITION_INDEPENDENT_CODE=ON --target llama-common`). Tested with `google/gemma-4-E2B-it-assistant` (f16 GGUF,
154 MB): coherent text, 1.7-2.3 tokens per step, but on the VM's CPU a 5-row verification costs real compute, so it
measured 11.5 tok/s against about 13.5 plain: off by default. The drafter is not authenticated, on purpose: the target
verifies every proposal, so a wrong drafter changes the speed and never the text.

## Traps, each of which produced a false "the VM is slow" conclusion

1. **A dark or locked phone.** `am start` onto a dozing phone never makes the activity top-app: the app
   sits in the background cpuset (cores 0-2 on Tensor G5), its own threads are starved, and crosvm
   inherits that. Measured: 0.4-1.4 tok/s instead of 16-21, VM boot 21-35 s instead of 8-15 s. Awake and
   unlocked, crosvm is in `/top-app`, vCPU *i* runs on host core *i*, and guest compute equals host
   compute (a spin probe: 3.4-3.7K vs 3.6K iterations/s on one thread, 20.3-21.6K vs 21.0-21.3K on
   eight). `AnchorService` exists for the same reason on the split engine (REPORT.md section 9). Mode
   local keeps the screen on (`Main`) and `host/local-run.sh` refuses to measure a
   phone that is not awake.
2. **A new engine per measurement.** First touch of fresh guest memory costs 10-50 us per page in a
   protected VM (about 1 us natively): roughly 500,000 faults and 14-26 s of SYSTEM time after every
   engine creation. Measure a warmed engine; this one is created once per VM session.
3. **Run order is thermal order.** Within about a minute of six-core load the governor lowers
   `scaling_max_freq` of the big cores from 3052 to 2188 MHz and later 1785 MHz; whatever runs last
   loses 20-40 %. Continuous generation settles around 12 tok/s on this phone for any CPU engine,
   native or in the VM.
4. **Idle vCPUs.** Waking a thread on an idle vCPU costs about 360 us in the guest (160-200 us on the
   host); a hot hand-off is 21-27 us. It is why a vsock round trip is still 0.8-1.0 ms with full clocks.
5. **Heat soak.** After hours of load the SoC sensors read MID 92 C / BIG 86 C while "Thermal Status: 0" and uncapped clocks
   still pass as a gate; decode then collapses to about 2 tok/s within seconds. Rest the phone 20 minutes before trusting
   a number. (`dumpsys thermalservice` values are stale while the screen is off.)

## What it is for

This is a host capability, not an app surface: the engine a phone host serves inference with once the phone is a full
enclave host (PLAN.md). Today the only driver is the scripted `ask` path; the text of those turns passes through the owner
app. The weights' use, the KV cache, activations and sampling exist only in the VM. Terminating the tenant's session inside
the VM is what removes the app from the text path.

## Decode rate and CPU cost against model size (2026-09-19)

The Shielded-TPU path was closed on measurement this day (TPU.md): 0.93 tok/s, and 20x MORE phone CPU per
token than this engine, because minting a pad is the same integer MACs as the matmul it protects. That puts
the 15 tok/s question back here, where decode is bandwidth-bound and the lever is the model, not the engine.

Two points, same protected VM, same six vCPUs, `a8w4/cpu_cost.sh` sampling utime+stime of the app, its
virtmgr and its crosvm across one decode turn:

| model | on disk | tok/s | core-ms/token | cores busy |
|---|---|---|---|---|
| Gemma 4 E2B Q4_0 | 3204 MB | 13.08 | 332 | 4.3 |
| Qwen2.5-0.5B q8 | 645 MB | **39.89** | **98** | 4.3 |

The line through them: **12.1 ms/token + 0.0201 ms/MB**, i.e. a fixed per-token cost (attention, norms,
sampling, the embedding lookup) plus the weight stream.

| | on disk | tok/s | core-ms/token | cores needed to HOLD 15 tok/s |
|---|---|---|---|---|
| E2B Q4_0, today | 3204 MB | 13.1 | 329 | flat out, and still short |
| break-even for 15 tok/s | **2716 MB** | 15.0 | 287 | 100 % |
| E2B at about Q3_K_M | 2500 MB | 16.0 | 268 | 93 % |
| a 1B model at Q4_0 | 800 MB | 35.5 | 121 | **42 %** |
| Qwen2.5-0.5B q8 | 645 MB | 39.9 | 108 | 38 % |

Two things follow. **15 tok/s is reachable today** with the root of trust unchanged -- anything under about
2.7 GB clears it, which E2B itself does at a slightly smaller quantisation. And the heat objection is really
a duty-cycle objection: E2B holds 13 tok/s only by pinning six big cores at 100 %, which is what decays
20.0 -> 16.2 -> 12.7 with BIG at 87 C, whereas a 1B model **holds 15 tok/s at 42 % duty** and a third of the
CPU energy per token. Pick a model fast enough that the phone is not pinned, then cap the rate.

Caveat on the Qwen row: the app applied Gemma's chat template to it, so the text carries `<|turn|>` artifacts
and both turns ended on the token budget rather than EOS. The decode rate is still a valid measurement of
forward-pass throughput at ctx 219-449; the row is here for the size curve, not as a model recommendation.
