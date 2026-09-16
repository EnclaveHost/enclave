# GUI -> root, 2026-09-10T21:17Z — LiteRT-LM source-build route: one file to replace, one command to confirm the target

Offline only. No build, no device, no network, no account, no terms accepted. New owned directory.

    BUILD-PLAN.md               the plan, staged, with stop conditions
    evidence.json               every measured number in machine-readable form
    internal-source-paths.txt   145 internal source paths recovered from the shipped binary
    jni-exports-0.16.1.txt      the 23 JNI exports a replacement library must provide

## 1. The seam is narrow and verifiable

A kernel patch changes exactly one file in the AAR: `jni/arm64-v8a/liblitertlm_jni.so`. It exports
**23 symbols**, all `Java_com_google_ai_edge_litertlm_*` under `VERS_1.0`, and `NativeLibraryLoader`
just does `System.loadLibrary("litertlm_jni")` — **I found no version or ABI handshake with
`classes.jar`**, so a self-built library binds to the Maven Kotlin API unchanged. The app already
hand-places `libLiteRtDispatch_GoogleTensor.so` in `src/main/jniLibs/arm64-v8a/`, so the swap
mechanism exists; add `pickFirsts` for the duplicate path and then **verify by hashing the `.so`
inside the built APK** instead of trusting AGP's merge order.

## 2. The target — recovered from the binary, needs one command to confirm

The shipped library contains its own blaze output path:

    blaze-out/arm64-v8a-opt-ST-.../bin/third_party/odml/litert_lm/
        kotlin/java/com/google/ai/edge/litertlm/jni/liblitertlm_jni.so

so the public label should be `//kotlin/java/com/google/ai/edge/litertlm/jni:<target>`. **I am not
asserting `kotlin/` is mirrored** — `ls kotlin/java/com/google/ai/edge/litertlm/jni/` in a `v0.16.0`
checkout settles it in a second. Two things say it probably is: the public WORKSPACE registers
`rules_kotlin` 2.3.20, and its `maven_install` set (gson 2.13.2, kotlinx-coroutines 1.9.0) is the
published POM's dependency set. The documented public target is the CLI,
`bazel build --config=android_arm64 //runtime/engine:litert_lm_main`, which is the stage-1b fallback.

The patch target itself **is** confirmed mirrored and matching: the six error strings and the
register-by-register branch match put the shipped KV copy at `HWKVCacheUpdate`,
`runtime/executor/llm_litert_npu_compiled_model_executor_utils.cc:640-652`, tag v0.16.0.

## 3. Do not aim to reproduce the shipped binary — it is a google3 build, three proofs

`blaze-out` and **zero** `bazel-out` strings; `.comment` carries `Linker: LLD google3-trunk`,
two `google3 clang 9999.0.0` entries, Android clang 21.0.0 `+pgo +bolt +lto +mlgo`, and
`rustc 1.97.0-nightly`; and it has google3-only sections (`google_init_cold`, `google_malloc`,
`malloc_hook`, `filewrapper_toc`, …). **The public dispatch `.so` is also a google3 build.** So the
success criterion must be behavioural — your existing 220-token / hash `9a3b50f2391d` gate — not
binary equality. Two calibration measurements: 0.16.0 vs 0.16.1 differ in **1,915 of 21,529,648
bytes** (same size, different BuildId — which also closes the question I left open in ABI-MATCH-2 §3:
they are **not** the same binary), and v2.1.6 vs v2.2.0 dispatch differ in **235,967 of 314,624**.

## 4. What this host is missing, and the prediction you should test first

**Missing:** bazel entirely; an NDK **r28b+** (only 27.2/clang 18 here, while the shipped dispatch was
built with r29 and the JNI library's NDK clang is 21.0.0); a JDK 21; `ANDROID_NDK_HOME`/`ANDROID_HOME`
are unset, and the WORKSPACE silently registers a **dummy** toolchain when the NDK variable is unset.
**Present:** 1.1 TB free, SDK 35 + build-tools 34/35, and your gradle home at
`work/pixel8-nano-direct-1/gradle-home` (AGP 8.7.3, gradle 8.9, all three AARs already cached), so the
APK side needs nothing new. Three named build risks before you spend time: the `javax_json`
`http_jar` points at sunset **jcenter**; `google_tensor()` may want the ACL-gated Tensor SDK (one
`cat` of the fetched `workspace.bzl` answers it); and the Rust toolchain is mandatory, not optional.

**The prediction worth testing first:** a build from public `v0.16.0` compiles against litert
`0ff28117`, which has no `LiteRtAbiHeader` — so it should pair with the **v2.1.6** dispatch we already
hold, **not** the v2.2.0 that the shipped AAR needs. Both zips' manifests name G3-G6 including G5, so
v2.1.6 is not excluded from our SoC by its own packaging. If that pairing fails, **stop rather than
bumping `LITERT_REF`**: a ref new enough for the AbiHeader approaches the `get_hooks` slot-26 code that
SIGSEGV'd 0.17+2.2.

## 5. Stage 1 is the unpatched build, deliberately

Build unpatched, check the 23 exports, swap, and run your existing gate **before any patch**. If an
unpatched source build cannot reproduce 220 tokens at hash `9a3b50f2391d`, no patch is worth
applying — and that failure is itself the answer on viability. Then KV first (device differential
**PASS 22,492 cases**, paired medians **1.20x-1.74x** at the real geometry), sampler second and only
once its benchmark exists — it has a device differential **PASS 23,090 comparisons** but **no speed
measurement yet**, and its source file still needs pinning by
`grep -rn 'Unsupported logit type for batch sampling' runtime/`.

For stage 3, `compare_sdk.py --variable none` is the closest existing label for a patched-library pair
(SDK string constant, APK and `.so` differ); say the word and I will add `--variable jni` so the
library hash is the gated variable. Carry one number from the SDK comparison into the adoption
threshold: **within-run spread over three repeats was 3.9-6.4% on decode rate**, so a kernel change
has to clear that or the repeat count has to rise.

## 6. Not claimed

That the public tag reproduces the shipped binary (§3 says it cannot); that the `kotlin/` jni target
exists publicly (§2 gives the command); that the build succeeds (three blockers named, none resolved);
or any decode-rate gain from either kernel — the KV win is a microbenchmark at the real geometry and
the copy's share of a decode step is still not established.

---

# GUI -> root, 2026-09-10T21:40Z — stage 0 done, argmax patch delivered and PARKED

Offline except the authorized public checkout and a few authorized raw fetches. No build, no device, no
compiler run. **`git status` in `litert-lm-v0.16.0/` is clean — I did not modify the checkout.**

    STAGE0.md                  checkout results: target, signature verification, tools, dep access
    argmax-integration.patch   6,275 B  sha256 01b0977fcb6f5088e096ea21ad802c1fb65de6a0c759b93b5579cb63a0c774c3
    PATCH-NOTES.md             what the patch does, why NaN is exact, and why it is parked
    make_argmax_patch.py       generator, pristine hash-pinned, 9 post-conditions
    check_argmax_patch.py      23 static checks on the patched result, no compiler
    verify_jni_abi.py / verify_jni_reflection.py   the signature and reflected-member checks
    distdir/javax.json-1.0.4.jar                   the artifact the WORKSPACE pin actually needs

## 1. The patch, and why it is optional

`git apply -p1 argmax-integration.patch` at the repo root. One file, one function:
`FindMaxIndexFloatNeon` at `..._utils.cc:61-104` becomes the pristine 4-lane kernel kept **verbatim**
as `FindMaxIndexFloatNeon4Lane`, two `__aarch64__`-guarded helpers, and the v16 kernel
(`argmax_kernels_v2.h` `bb753831…`) with four independent accumulators.

**NaN is exact by construction, not by argument:** four paths return the old answer by *calling the old
code* — `size < 16`, NaN in the vector accumulators, NaN in the scalar remainder, and non-AArch64.
Detection is exact because FMAX propagates. **The default NEON-off path is untouched:** the patch does
not touch the header, so `FindMaxIndex<T>`, the `if (use_neon_sampling)` branch and the scalar loop are
byte-identical, and `enable_neon_for_npu_greedy_sampling` keeps its `true` default — so the scalar path
stays available as a control arm.

One portability point worth knowing: **`vminvq_u32` is AArch64-only** (verified in the NDK's
`arm_neon.h` — both definitions sit inside the `__aarch64__` region), and the repo has a working
`--config=android_arm`, so without the inner guard that configuration would stop compiling. Guarded.

**PARKED, per your call and your AHB result.** On the public-pin `RARELY` flags the shipped scan is
**1,019,589 ns** and v16 only **1.023x**; with `OFTEN` it is **58,559 ns** and v16 **2.828x**. Your
third variant settles the cause: dropping `GPU_DATA_BUFFER` and keeping `RARELY` is still 1.02 ms, so it
is the frequency hints, **17.4x** on the same 1 MiB scan. I have written that into `PATCH-NOTES.md` §4a
as the reason this patch is demoted, including the log's own caveats — host-filled buffer, not a
TPU-produced one, and public-pin flags that are **not** proven to match the private build. The allocator
lane is the lever and it is the right GUI's; I am not touching it.

## 2. What I verified statically, since I could not compile

The generator refuses unless the pristine function hashes to `82dbf895…`, then asserts the pristine body
is present verbatim exactly once, exactly four fallback returns, no new `#include`, and every line
outside `:61-104` byte-identical; then `git apply --check`. The checker applies the patch to a temp copy
and runs 23 checks — balanced braces/parens/`#if`, **every helper defined before first use** (the check
that was missing when the MNN opmap transform broke your build), the function still inside the
`__ANDROID__ && __ARM_NEON` block, **all 19 NEON intrinsics present in the NDK header**, the A64-only one
used only under its guard, and four anchor functions unchanged. **ALL PASS — and that is not a compile.**

Coverage note for when you do build: `//runtime/executor:llm_litert_npu_compiled_model_executor_utils_test`
is a **host** test, so the whole NEON block is compiled out and it gives **zero** coverage of this patch,
and it has **no NaN fixtures**. Your standalone differential harness remains the authority.

## 3. On build-1 timing out

Exit 124 at the 180 s limit after ~1000 of 3876 actions, with dependency setup passed, is consistent with
everything in `STAGE0.md` §4: nothing in the dependency graph blocked, so the `javax_json` checksum trap
and the `@google_tensor` fetch did not bite this target. Two things already staged for the next cycles,
neither of which needs anything from you but a flag: `--distdir=<this dir>/distdir` (costs nothing, and
covers `javax_json` if a later action pulls it) and `--config=public_cache`, whose bucket I verified
answers anonymously with HTTP 200 and which is read-only by definition in that config. Expect partial
hits at best — action digests include the local toolchain — and the cache you preserved is the bigger
lever. The build is yours; I am not proposing to run any part of it.

## 4. Next from me

Parked on the argmax patch until a full unpatched baseline exists. When the right GUI's allocator-flag
scoping patch is ready I will audit it independently — on my side that means the scoping question
(which allocations change, and whether anything outside the logits path is affected), whether a
`RARELY` -> `OFTEN` change can alter correctness or coherency expectations for an NPU-written buffer
rather than only performance, and whether the public-pin flag values it edits are the ones the private
build actually uses, which your own log says is unproven. No device or build work from me.

---

# GUI -> root, 2026-09-10T22:04Z — URGENT: interposition refuted; the version script is safe but is not the fix

Full detail in `INTERPOSITION-AUDIT.md`. Symbol and source inspection only; no build, no device, no
edits to your files.

**1. Your two addresses are exact instructions, confirmed in your unstripped build-5 library:**
`0x1602620` is the `bl _ZdlPv@plt` inside `LiteRtDestroyOpaqueOptions` (0x1602600+0x20) and
`0x1601740` is the `bl LiteRtDestroyOpaqueOptions@plt` inside `LiteRtDestroyOptions` (0x160172c+0x14).
So the faulting call is an **unsized** `operator delete(void*)` on an opaque-options node.
**That rules out a sized-delete size mismatch** — unsized free + "corrupt chunk" means the pointer is
already freed or not from this heap, i.e. a double destroy or a foreign-heap free.

**2. The export asymmetry is real — 29,795 exports versus the shipped 24, including 448 `LiteRt*` and
all 20 C++ allocation operators — but nothing can bind to them.** Dispatch v2.1.6 exports one symbol
and imports 88, **every one libc**: zero `LiteRt*`, zero `_Z*`. The provider exports 6, needs only
libc/libdl/liblog/libm, and imports 181, again **zero `LiteRt*` and zero allocation operators**; the
JNI imports its three `LiteRtLmGemmaModelConstraintProvider_*` entry points, so the dependency runs
one way only. **So: the provider needs no JNI internals — `{ global: Java_*; local: *; };` is safe for
both it and the dispatch — and equally, no interposition can have occurred.** Apply the script for
parity, size and future safety, but please do not read a still-crashing build as the script having
been applied wrongly.

**3. One cause ruled out by source:** `litert/c/litert_opaque_options.{h,cc}` and
`litert/c/litert_options.{h,cc}` are **byte-identical** between the LM 0.16 pin `0ff28117` and the
v2.1.6 tag `1461b6b2`. What is left is the asymmetry this lane keeps meeting: **the released dispatch
is a google3 build, not a build of that tag** (its `.comment` says so), and a source-built JNI plus an
internally-built dispatch need not agree on who destroys an options object.

**4. Cheapest next steps, your device and your call:** (a) read the rest of the tombstone — SCUDO
names its failure mode and usually prints the allocating and freeing stacks, which separates
double-destroy from foreign-heap free outright; (b) run the same APK with `--backend=cpu`, which tells
you whether init is clean with no dispatch in the process, no rebuild needed; (c) build the dispatch
from the same `LITERT_REF` so both sides are one source revision —
`bazel build --config=android_arm64 @litert//litert/vendors/google_tensor/dispatch:dispatch_api_so`,
and if it pulls `@google_tensor`, an **empty directory** in `GOOGLE_TENSOR_COMPILER_LIB` satisfies it
(that BUILD only globs `**/*.so`). If those leave it open, the next step is a source bisect of the
init options path, which is mine to prepare rather than yours to guess.

**5. Packaging, for the record:** my copy had the same `facts['exports']` KeyError you hit — fixed —
and the `base_aar_sha256` clobber you found came from my extras loop reusing `got`; that loop is gone
and the variable is now `base_sha`, so a record cannot carry a library hash in that field. Per your
simplification my packager does one JNI replacement, no AAR additions, and it **allows a declared
non-platform DT_NEEDED** (default `libGemmaModelConstraintProvider.so`) while printing the full
`DT_SONAME`/`DT_NEEDED` lists and refusing anything undeclared. `verify_apk.py` now derives
expectations from the record's AAR entry list, so it covers the provider inside the AAR automatically,
checks every non-platform `DT_NEEDED` is satisfied **inside the APK**, and identifies the dispatch
build by hash (it knows both v2.1.6 `86f8a5d0…` and v2.2.0 `35b59265…`). Eight refusal paths are
negative-tested, including a truncated ELF, which now fails with a bounds message rather than a stack
trace. Per your review the ZIP header patch is gone — flags and attributes are left to the zipfile
module, and only names, order, compression, timestamps and content are asserted.

**6. The ~175-action recompiles** are most likely action-key changes, not cache loss: `--repo_env=CC`
/`CXX` present in some invocations and not others, `--distdir`/`--config` differences, or a touched
`try-import` file (`.bazelrc.user`, `.tf_configure.bazelrc`, `warnings.bazelrc`). `--explain=explain.log
--verbose_explanations` states per action why it re-ran. Not worth a build while the crash is open.

---

# GUI -> root, 2026-09-10T22:19Z — callback ABI frozen (43 vs 44 / graph table), probe review delivered

`INTERPOSITION-AUDIT.md` §7 (frozen) and `PROBE-REVIEW.md`. Source and binary inspection only.

## 1. The dispatch table ABI, measured — and your same-pin result explains itself

`LiteRtDispatchGetApi` copies **48 bytes in the prebuilt v2.1.6 and 48 in your same-pin build**, same
three relocated pointers at the same offsets, versus **56 in v2.2.0** (the `LiteRtAbiHeader` layout).
So the top-level table was never the fault, and `LiteRtDispatchInterface` is **25 pointers in both**,
matching the pinned header exactly (25 unconditional + 2 behind `LITERT_ENABLE_FABRIC_INTEGRATION`,
off in both). The difference is in the **graph-interface region: 16 contiguous relocated pointers in
the prebuilt versus 17 in your same-pin build, and the prebuilt's seventeenth word is the literal
`0x1`.** The header defines 16 unconditional graph members plus two fabric-gated ones, so a fabric
difference would move the count by two, not one — **I therefore do not claim the seventeenth word is a
struct member**; a relocation run can continue into a neighbouring object and my method cannot
separate those. What is established is that the two producers lay that region out differently.

That is enough for both signatures without choosing between them: the export-only SIGSEGV was an
**instruction abort** (`esr 0x82000006`, `x8 = pc = 0x19000`) — a `blr` through a word that was never
a relocated pointer — and the earlier SCUDO case was a `unique_ptr<void,deleter>::reset` driving an
opaque destructor whose pointer came from the wrong slot. **Your correction is in the document:** an
unsized `_ZdlPv` only rules out SCUDO's sized-delete size check, not a layout or table-offset
mismatch, which can feed a bogus pointer straight into it. I had that wrong.

Operational rule, now with three instances behind it (AbiHeader offsets, 0.17 `get_hooks` slot 26,
this): **build the vendor dispatch from the same `LITERT_REF` as the runtime, and treat a prebuilt
dispatch as ABI-compatible only with the binaries shipped beside it.** Your 5.346 s / 16-action build
makes that the cheap default.

## 2. Sampler probe revision 3 — four material items, one I would fix before the run

**(a) Wall clock only.** `NowNs()` is `CLOCK_MONOTONIC`, so a multi-millisecond `scan_us` cannot be
told apart from "the thread was descheduled". Adding a `CLOCK_THREAD_CPUTIME_ID` pair and printing
`cpu_us_per_call` is ~8 lines and turns an ambiguous result decisive: cpu ≈ wall means the loads are
genuinely slow, cpu << wall means preemption. Given the AHB result predicts the former, this is the
difference between one run and two.

**(b) Unlock is invisible on every path** — the `ScanScope` destructs before the lock in
`FindMaxIndex`, and the verify lock outlives the slice loop. Your own AHB numbers put unlock at
**21.4 us RARELY versus 1.35 us OFTEN**, on exactly the axis under test, up to ~0.17 ms per step
unaccounted. Time it, or say in the report that it is excluded.

**(c) `probe_path` defaults to 0**, so any caller that is not one of the four tagged sites is silently
counted as `main`. All four NPU sites are tagged today, but `ApplyGreedySampling` lives in a shared
header. Make it required in the probe build, or give it a fourth `kUntagged` bin.

**(d) A failed request contaminates the next one:** `ABSL_RETURN_IF_ERROR(session_->WaitUntilDone())`
returns before the emit, so that request's counters survive into the following one. An `absl::Cleanup`
at function entry fixes it on every exit path.

Recorded but not worth delaying the build: `EmitAndReset` is `Report()` then `Reset()` so increments
between the two passes are lost (benign for one in-flight request); the header's own comment still
claims "no BUILD change needed", which the patch contradicts; includes are inserted mid-block in both
files; and with `--log-tag SAMPLER_PROBE` the capture will not contain the app's own
`RUN_BEGIN`/`RUN_END` markers, so the N-th block ties to the N-th repeat only by order — logging the
repeat index inside the block would fix that.

Verified correct, so you do not need to re-check: no double counting on the verify path
(`SampleLogitsSliceFromLockedPtr` never re-enters `FindMaxIndex`), widths taken from `sizeof(T)` and
`element_size` rather than assumed, default arguments declared only in the header, counters
zero-initialised with a thread-safe magic static, and no unused variables in the disabled build.
Nothing in the patch changes sampling behaviour.

---

# GUI -> root, 2026-09-10T22:27Z — CPU-clock delta patch ready (not applied), three review items withdrawn

`CPUCLOCK-PATCH.md`, `sampler-probe-cpuclock.patch` (`88b242d6…`), `make_cpuclock_patch.py`.
Source only, **not applied and not built**; your `source/` tree is untouched by me.

**Target pinned:** `source/runtime/executor/sampler_probe.h` sha256 `c94b26fd…`. The generator refuses
if that hash has moved, so it cannot silently patch a file it was not reviewed against. `git apply
--check` passes; `patch -p1` into a copy also verified.

**What it does, minimally:** adds `CLOCK_THREAD_CPUTIME_ID` beside the monotonic clock for the **scan
only** — `AddLock` untouched, asserted by post-condition — and appends `cpu_us`,
`cpu_us_per_call`, `cpu_frac` to each path line plus `cpu_us` to TOTAL. **All eight existing fields keep
their name, order and format**, so your parser keeps working. **No `.cc` or BUILD edits**: the
`T0`/`SCAN_END` macros keep their names and arity, only the T0 variable's type changes to a two-field
`Instant` that nothing else touches, and `LOCK_END` still uses the monotonic field alone. Disabled
branch untouched; `cpu_ns` defaults to 0 so an un-updated caller still compiles.

`cpu_frac` is the single number to read: **≈1.0 means the loads really are slow; well under 1.0 means
the wall figure includes time off-core.** Cost is one extra `clock_gettime` per scan — budget 100-300 ns
since the thread CPU clock is not always a vDSO fast path, which is under 0.5% of even the 60 us floor.
Declaration order checked on the patched result (`CpuNowNs`/`Instant`/`NowInstant` all before first use,
including before the macros) — the check whose absence broke your MNN build once.

**Three items from `PROBE-REVIEW.md` withdrawn or downgraded, you were right on all three:**

* **Item 8 was incorrect** — `--log-tag` *adds* a tag, so `TensorNpuProbe` markers are captured and
  blocks tie to repeats directly. Withdrawn.
* **Item 4 does not apply** — one fresh process per run means no later request exists to contaminate.
* **Items 1 and 2 are labelled, not defects.** Labelling wall-time and the unlock exclusion in the
  output is the right call. This patch converts the scan half of item 1 from a label into a
  measurement; the unlock label stands, with your AHB numbers (21.4 us RARELY vs 1.35 us OFTEN) as the
  reference if it ever needs a figure.

**Item 3 is the one I did not address:** `probe_path` defaults to 0, so any caller that is not one of
the four tagged sites is silently counted as `main`. Fixing it means removing the default or adding a
fourth bin — both behaviour changes rather than additive measurement, so I left it to you. Not urgent
while all four NPU sites are tagged.

Noted on your compile fix: raw `TensorBuffer` construction replaced by
`WrapCObject(env.GetHolder(), raw, OwnHandle::kYes)`. Nothing in my patch constructs a TensorBuffer, so
it is unaffected either way. No A/B hold needed for the CPU clock — it is additive and can ride the
next diagnostic build whenever it suits the OFTEN testing.

---

# GUI -> root, 2026-09-10T22:37Z — stage-timing patch ready (not applied); the 9 s framed

`STAGE-TIMING.md`, `sampler-probe-stagetiming.patch` (`2f547718…`), `make_stagetiming_patch.py`.
Source only, not applied, not built. Your tree untouched.

**Pinned to your current files** (`sampler_probe.h` `c94b26fd…`, NPU executor `b46edb14…`); the
generator refuses if either moved. `git apply --check` passes and `patch -p1` into a copy was verified.
**It conflicts with the parked `sampler-probe-cpuclock.patch` — apply one, not both**; both add the same
clock helpers, and this one leaves the sampler's own fields entirely untouched.

**Your OFTEN numbers say the sampler lane is done: scan is 0.239 s of 9.431 s (2.5%), lock 0.088 s
(0.9%), so ~9.1 s is in no counter.** Also worth noting from the ABBA means: 2.434 s of scan saving
bought 1.672 s of wall, so ~0.7 s was overlapped or displaced into something unmeasured — another
reason to bracket stages rather than kernels.

**On "Run/RunAsync + wait boundaries": there is no async boundary on this path.** `RunAsync` appears
only in the CPU/GPU executor and the standalone MTP drafter, never in
`llm_litert_npu_compiled_model_executor.cc` — every Run there is synchronous and returns after
completion. So the submission/completion split comes from **two clocks around each existing call**:
`cpu_frac ≈ 1` means the host was busy inside Run (submission, buffers, validation), `cpu_frac ≈ 0`
means it was blocked on the device. **Nothing is serialised**, and the generator enforces that: it
refuses if the diff changes the count of `Wait(`, `RunAsync`, `IsSignaled`, `Notification`,
`SleepFor`, `this_thread`, `.Run(`, `absl::Now()`, any of the three error macros, or `latency_stats_`.

**Seven bins** — `dec_rope`, `dec_mask`, `dec_llm`, `drf_aux`, `drf_llm`, `vfy_aux`, `vfy_llm` — each
reporting calls, wall_us, cpu_us, wall_us_per_call and cpu_frac, appended to the existing report at the
same once-per-request boundary, with every sampler field unchanged.

**One finding worth your attention independent of the patch: the verify LLM Run is in no accumulator at
all.** `llm_compiled_model_.Run(LlmSignatures::kVerifyLlm, …)` has no surrounding timer, so verify
inference over K+1 rows is invisible in `LatencyStats` as well as in the probe. If the 9 s has one
large hiding place, that is where I would look first, and it is why `vfy_llm` is in the set.

**KV-cache paths are deliberately untouched** (`HWKVCacheUpdate`, `CacheUpdateSignatures` counts
asserted unchanged) since that lane is the other worker's; I also left the embedder, prefill and
anything outside the decode/draft/verify loop alone to keep this small.

Reading it: `STAGE_TOTAL wall_us` near ~9 s means the NPU graphs *are* the wall time and the question
becomes which signature dominates; materially short of that means the missing seconds are host-side
work *between* stages, and the next probe should bracket the gaps instead of the calls. Either way
`STAGE_TOTAL cpu_frac` says whether the host is burning CPU or waiting. Cost is two `clock_gettime`
calls per stage, order 1 ms against 9.4 s.

---

# GUI -> root, 2026-09-10T22:41Z — stage-timing revision 2: verifier aux completed, cpu/wall claim corrected

`sampler-probe-stagetiming.patch` regenerated: **12,093 B, sha256
4b1f0607415070464d517595af765238f42c75c868f88cdc7a113c192ee305b5** (supersedes `2f547718…`, which you
had not applied). Same two pinned files, `git apply --check` OK, `patch -p1` into a copy verified.
Source only, nothing built, your tree untouched. Also noted: the CPU/GPU offload question was typed into
the wrong window — disregarded, no offload research started, and nothing in my queue changed.

**1. `vfy_aux` was incomplete and you were right.** Revision 1 wrapped only the `else` branch, so
**verify RoPE and the WH mask branch were in no bin at all**. The scope now spans all three consecutive
statements — the `RopeSignatures::kVerifyRope` Run, then the mask by whichever branch is configured —
with nothing moved, added or removed. Verified on the patched copy: statement order reads
`kVerifyRope → HWMaskUpdate → kVerifyMask → kVerifyLlm`, exactly as before, and a new post-condition
now **fails patch generation** if any of those three tokens falls outside the verifier auxiliary scope.
Scope count is still 8, and the bin no longer changes meaning depending on `verify_mask_update_method_`.

**2. The cpu/wall claim is corrected everywhere, including in the generated comments.** It measures
**caller on-core versus off-core time, nothing more**:

* off-core time is **not** proof of a TPU wait — a lock, preemption or a page fault looks identical;
* on-core time is **this thread only**, so it is not a measure of all host CPU work and says nothing
  about other threads or anything the vendor library runs.

What it still gives is a bound worth having: a stage almost entirely off-core cannot be fixed by making
host code cheaper, and one almost entirely on-core cannot be explained by device latency. I corrected
the same overstatement in `CPUCLOCK-PATCH.md` and in `PROBE-REVIEW.md` item 1, so the parked scan patch
does not carry the wrong reading either.

Everything else is unchanged: seven bins, no synchronisation added (the banned-token post-conditions
still hold: `Wait(`, `RunAsync`, `IsSignaled`, `Notification`, `SleepFor`, `this_thread`, `.Run(`,
`absl::Now()`, the three error macros and `latency_stats_` all unchanged in count), KV-cache paths
untouched, sampler output fields untouched, and a no-op macro for a flag-off build. It still conflicts
with the parked `sampler-probe-cpuclock.patch` — apply one, not both.

---

# GUI -> root, 2026-09-10T22:47Z — G5 compiler feasibility: one gated .so, three symbols; G5 is a public target

`COMPILER-FEASIBILITY.md`. Public source at our pin `0ff28117` plus the local checkout. No signup, no
weights, no build, no device. Stage patch frozen at `4b1f0607…`, measurements parked.

**Answer: every piece of the compile path is public except one shared library.** The plugin source
(`litert/vendors/google_tensor/compiler/compiler_plugin.cc`, 34 KB), both adapters, the python AOT
driver, the op rules, the options proto, and the `.litertlm` container tooling are all public — and
`litert-lm-builder` / `litert-lm-peek` are on **PyPI**, so building, unpacking and inspecting the
container needs nothing gated at all. The plugin target's deps are entirely in-repo plus
absl/protobuf/re2, so it is buildable.

**The gate is exactly this:** `adapter_aot.cc:56-67` dlopens **`liblitert_plugin_compiler.so`** and needs
three symbols — `GoogleTensorCompileFlatbuffer`, `GoogleTensorCompilerFreeCompiledCode`,
`GoogleTensorCompilerFreeErrorMessage`. The public python backend finds it via
`ai_edge_litert_sdk_google_tensor.path_to_sdk_libs()` **or the `GOOGLE_TENSOR_COMPILER_LIB` env var** —
the same variable the bazel repo rule uses, so there is a clean public insertion point the moment that
`.so` exists on disk. The authors state the gate themselves in two BUILD comments ("Don't build/test in
OS until liblitert_plugin_compiler.so is available", plus `no_oss`/`nobuilder` tags), and the pip shim
still has no public URL (TODO b/475410468).

**G5 is not the problem.** It is a named target in three independent public places: `kPluginSocModels`
("Tensor_G3/G4/G5/G6"), python `SocModel.TENSOR_G5`, and the options proto's
`DEVICE_TYPE_TENSOR_G5 = 3;  // Pixel 10 Series`.

**On ops, the rules are readable and nothing excludes Qwen by architecture.** The plugin carries a
~40-entry deny-list (variable ops, hashtable, `Random*`, NMS, complex, `Svdf`, `Conv3d`, `Where`,
`Shape`, `ShloScatter`, `ShloWindow` — and **`TflCustom`**) and accepts exactly three StableHLO
composites: `odml.rms_norm`, `odml.group_norm`, `odml.scaled_dot_product_attention`. So the risk sits in
the **export**, not the model family: custom ops are rejected outright, and attention/norms must arrive
as those composites. Also worth knowing for the mixed-INT4 question: the options proto has **no
quantization knobs** — only float truncation and sharding — so quantization is upstream and **whether
the compiler accepts INT4 tensor types is not provable from public source.**

**Cheapest unknown worth closing, and it is yours not mine:** `adapter_odc.cc` compiles **on-device**
through `/vendor/lib64/libedgetpu_litert.so` using five `EdgeTpuCompiler*` symbols. All five were
**absent on Pixel 8 / G3**; on **Pixel 10 / G5 this is untested**. If they are present, on-device
compilation bypasses the host SDK gate entirely. It is the same read-only dlopen/dlsym probe you already
ran on Pixel 8, about a minute of device time.

**Next step in my lane, on your word:** a source-only static op-coverage checker that takes a
`.litertlm` (or its tflite subgraphs) and reports the op histogram, every deny-list hit, composite
presence and tensor element types — "would the G5 plugin accept this graph?" answered **without** the
gated compiler. Run against main's Qwen3.5-4B CPU/GPU export it resolves your question either way:
clean graph means the only blocker is the gated `.so`, otherwise it names the ops needing re-export. No
weights download by me, no device, no signup — main's lane supplies the file.

Not claimed: that the SDK can be obtained or by what route; that INT4 is accepted; that a compiled graph
would satisfy the runtime's signature set (`prefill_N`/`decode`/`verify`/`mtp_drafter` plus embedder,
RoPE, mask, cache-update) — that is the export pipeline's job and a different lane; and nothing here is
a performance claim about Qwen on G5.

---

# GUI -> root, 2026-09-10T22:55Z — Pixel 10 ODC: real implementations, ABI pinned, bounded probe source ready

`ODC-VIABILITY.md` and `odc-probe/odc_probe.c` (271 lines, sha256 `307ebef0e39e5312…`). Read-only
inspection of your pulled library plus public source. **No device, no build, no weights.** I did not
touch `qwen35-4b-mixed-int4.litertlm.partial` — only saw the name in a listing.

**1. All five exports are real, not stubs.** `Create` (56 B) allocates 40 bytes, writes 1 at +8, returns
0 — **unconditional, no property read, no failure path**. `CompileFlatbuffer` (240 B) null-checks seven
arguments then calls the internal implementation at **`0x1c7d18`**, a 752-byte-frame routine that first
parses the options buffer (`0x565870`, boolean result — a protobuf `ParseFromArray` shape). So the
compiler lives in this library and the public header's ABI is the whole surface.

**2. On "could they still be gated at run time": nothing gates the entry path, and I found no
entitlement machinery — but I cannot prove absence.** Zero `license`/`entitle`/`selinux` strings; the
`ro.*` properties are device identification (`ro.board.platform`, `ro.hardware.chipname`,
`ro.boot.hw.soc.rev`, `ro.build.type`…); 107 `not supported` strings read like a compiler's op
diagnostics. **But `DT_NEEDED` includes `libbinder_ndk`**, so a check behind a system-service call
cannot be excluded statically. One call settles it.

**3. A hard constraint worth knowing before you read any failure:** the wrapper's success path requires
the internal result to hold **exactly one** bytecode (`cmp x8, #1`), so a successful ODC compile always
returns `num_bytecodes == 1`, and a model the compiler would split into several fails here even if
compilation itself succeeded. Don't read that as "unsupported ops".

**4. Options: empty is correct and it is upstream's own behaviour.** The argument is a serialized
`litert.google_tensor.EdgeTpuCompilerOptions` — public definition is **one field**,
`bytes internal_options = 1` — and the device library embeds that exact message name. The public
`adapter_odc.cc:87-92` ignores its input and sends a **default-constructed, zero-length** message (TODO
b/467884692). The probe defaults to exactly that, with an optional `--internal-options FILE` if you ever
have a payload to try. No protobuf dependency.

**5. The probe is bounded by construction:** one `dlopen`, one `Create`, one deliberate
invalid-argument self-check, **one** compile call, then the library's own free functions and `Destroy`.
No loops, retries or threads; it reads no properties itself; **it never writes the compiled bytecode** —
sizes only; and a `--max-bytes` cap (32 MiB) refuses an oversized input. Aimed at a **small
known-supported model, not Qwen**, per your instruction.

The self-check is what makes the rest trustworthy: it passes a null model pointer and expects `rc == 3`
with `"Invalid argument"` — what the disassembly says this build does — and exits 5 saying the binding is
wrong rather than reporting a compile result you could not believe. Build line and the four
outcome readings are in `ODC-VIABILITY.md` §5: success means the host SDK gate is bypassed; an op message
means a coverage question with the op named; a permission or service message means a runtime gate after
all and `libbinder_ndk` is where to look; a parse message means empty options are insufficient here.

**Caveat on my side:** the probe is **host syntax-checked only** (`clang -fsyntax-only -Wall -Wextra`,
clean). It has not been compiled for Android, and given the MNN precedent I would rather say that plainly
than imply it is build-tested.

**Deferred, not dropped:** the op-coverage checker. This outranked it, and it gets better afterwards — a
real error string from a real compiler tells us which op names actually matter.

---

# GUI -> root, 2026-09-10T23:05Z — Qwen pruning: safe, 32 bytes, verified dry-run; weights are shared so the file will not shrink

`PRUNE-PLAN.md`, `prune/derive_pruned_litertlm.py`, `prune/dryrun-receipt.json`. Read-only on the
verified artifact; **the staged original is never opened for writing** and its size+mtime are checked
after any run. No device, no build. Reuses `tools/litertlm_parse.py` as instructed. Noted your
odc-smoke changes (unbuffered stdout, self-check requires rc==3 rather than merely rejecting 0) — yours
is the stricter reading and the right one.

**Answer: yes, and it is far cheaper than expected — 8 fields, 32 bytes written, 16 bytes actually
different.** Keeping `prefill_1 + decode` leaves **5,786 of 132,963 ops (4.35%)** and 7,381 of 140,568
tensors, so it removes 95.7% of what the GPU backend compiled in that 100.628 s init before aborting.

**Three findings that shaped it:**

1. **The weights are shared, so the derived file is the same 2,754,365,536 bytes.** Of 612 external
   buffers carrying 2.649 GB, the five dropped subgraphs own **0.002 GB** exclusively; prefill_1 and
   decode already reference 2.647 GB. **Pruning buys compile work and compile memory, not weight
   residency** — worth being clear about given the OOM framing.
2. **Weight buffers sit outside the flatbuffer at section-relative offsets** (lowest 101,389,856;
   `max(offset+size)` = 2,750,400,608 = exactly the section length; `buffer_location` metadata
   present). Any rebuild would move 2.6 GB and re-derive 612 offsets — which is why I did not rebuild.
3. **Nothing references a subgraph by index.** All 29 operator_codes checked against `IF`, `WHILE`,
   `CALL_ONCE` and the seven `STABLEHLO_*` forms: **none present**. So dropping subgraphs cannot break a
   cross-reference. Also, neither metadata section declares the prefill buckets — LlmMetadataProto is
   the Jinja template, ExecutorMetadataProto is kv-cache names — so no metadata edit is needed.

**The method:** re-point the `subgraphs` and `signature_defs` vectors at the kept entries, reduce both
counts, remap the two `subgraph_index` fields. Dropped tables remain as unreferenced bytes, which
flatbuffers permits. Nothing moves, so all 612 external offsets stay valid and every weight byte stays
put. Verified by applying the patches to an in-memory copy of the 101 MB flatbuffer prefix and
re-parsing: 2 subgraphs (2,866 and 2,920 ops), 2 signature_defs with `subgraph_index` 0 and 1 and
intact 67-input maps, and buffers/operator_codes/metadata/external-offsets all unchanged.

**The tool is dry-run by default** and refuses on: not exactly one TFLiteModel section, a missing `TFL3`
identifier, any subgraph-referencing opcode, a keep-set entry that is not both a signature key and a
subgraph name, a keep-set equal to everything, no external buffers, `--out` == `--in`, an existing
`--out`, or any patch site whose current value is not the expected old one. After writing it verifies
the copy: names and keys == keep-set, indices remapped, buffer/opcode/metadata counts unchanged, **all
612 external offsets identical**, no unpatched byte differing in the prefix, weight region identical
(64 sampled 1 MiB windows, or full sha256 with `--verify-weights-full`), size unchanged, and the
original's size+mtime unchanged.

**One tradeoff to weigh before running it:** `prefill_1` only means a 220-token prompt prefills one
token at a time — a real TTFT cost, not a correctness problem. By compiled ops: `prefill_1+decode`
4.35%, `+prefill_64` 21.25%, `+prefill_256` 23.27%, `+prefill_4+prefill_64` 38.24%. The keep-set is a
parameter, so it is a dial.

**Still gated on your word and the runtime lane:** if `maxNumTokens` or a signature-selection path makes
the runtime compile fewer graphs, no derived artifact is needed and this stays on the shelf. I claim
nothing about whether the runtime accepts a two-signature model, and nothing about whether this clears
the abort — only that it removes 95.7% of the compiled graph.

---

# GUI -> root, 2026-09-10T23:09Z — review: kv-cache mapping survives pruning (64/64 names resolve); prefill_64 variant ready

`PRUNE-REVIEW.md`, `prune/dryrun-receipt-p64.json`. Read-only on the verified original; **nothing
mutated**, no device, no build. I re-derived the metadata from its own published schema rather than
leaning on my earlier pruning analysis.

**1. The mapping cannot be invalidated by dropping prefill graphs, and the reason is structural.**
`runtime/proto/executor_metadata.proto` defines `StateBuffer` with four **string name** fields —
`prefill_input_name`, `prefill_output_name`, `decode_input_name`, `decode_output_name` — plus policy,
type, sequence_axis and min/max sequence length. **No subgraph index, no signature index, no tensor
index anywhere in the message**, and exactly **one** prefill name pair per buffer rather than one per
bucket. So it is bucket-agnostic by construction.

**2. Verified against the artifact, not just the schema.** Decoded the 4,293-byte section with a
hand-rolled wire reader and cross-checked every name against the TFLite signature tensor maps:

    state_buffers 64 = GLOBAL_KEY_CACHE 8 + GLOBAL_VALUE_CACHE 8 + LINEAR_ATTENTION 48
    sequence_axis 2 on the key caches, 3 on the value caches, absent on the 48 linear
    maximum_sequence_length 4096 on the 16 global caches only;  max_history_size 0
    all four name fields identical within each state buffer: TRUE
    all prefill signatures expose identical input AND output name sets: TRUE
    decode inputs == prefill_1 inputs; decode has exactly one extra output: 'logits'
    keep prefill_1+decode   -> unresolved names: 0
    keep prefill_64+decode  -> unresolved names: 0

**All 64 state buffers resolve in both keep-sets, across all four fields.** Incidentally the 8/8/48 split
makes this a hybrid-attention model, and the key/value `sequence_axis` 2-versus-3 is the same K/V
transposition that drove the MNN KV work — neither depends on the bucket set. `LlmMetadataProto` is the
Jinja template only, and the tokenizer section is untouched and not index-referenced.

**3. The prefill_64 + prefill_1 + decode variant is ready**: 11 fields, 44 bytes, **28,255 of 132,963
ops (21.25%)**, tensors 22.08%. Patch table and the exact command are in `PRUNE-REVIEW.md` §4; keep-order
preserves the original relative order so the diff stays readable.

Worth knowing before you choose: **prefill_64 dominates prefill_16 and prefill_4** — 22,469 ops versus
22,589 each, a *smaller* graph that covers more tokens per call, so if one middle bucket is affordable it
should be prefill_64. And the cost ladder is 4.35% (two signatures) -> 21.25% (adding prefill_64) ->
100% (all seven), i.e. the three-signature variant is 4.9x more graph than the minimum but still 4.7x
less than the original.

**4. No correctness claim, as you asked.** Everything above is structural: names resolve, indices remap,
counts stay consistent. **That is not evidence the derived model generates correct text.** The test that
settles it is generation with a fixed prompt, and for a pruned model the meaningful comparison is against
the **unpruned GPU result on the same prompt** rather than the Gemma hash — the prefill bucketing changes
how the prompt is consumed, so I would not expect a hash match to any earlier run to be the criterion.
I will hold any correctness statement until that text exists.

---

# GUI -> root, 2026-09-10T23:19Z — execution route: direct dispatch invocation, source ready; prefill_64 parked

`EXEC-PLAN.md`, `dispatch-exec/{exec_bytecode.cc,BUILD.snippet,run-recipe.sh}`. Source only, nothing
built or run. Every call and type copied from public source at the pin — no invented signature.

**Your pointer was right and it is the shorter path.** I implemented **direct invocation**, not a
container build. For the record I did work out the container convention first, from the real G5 Gemma
artifact, so it is available if ever needed: a compiled NPU graph is a TFLite whose subgraph holds
**exactly one custom op `DISPATCH_OP`**, and its `custom_options` is a flexbuffer map with keys
**`bytecode_size`, `bytecode_offset`, `name`** (`"subgraph_0_fn"`), alongside a `LiteRtStamp` metadata
buffer starting with `Google`. But direct invocation skips synthesising a flatbuffer entirely.

**Sequence, from `dispatch_api_test_fixtures.cc` and `dispatch_api_simple_model_test.cc`:**
environment with `kLiteRtEnvOptionTagDispatchLibraryDir` -> `LiteRtDispatchInitialize(LrtGetRuntimeContext(),
env, options)` -> `DeviceContextCreate` -> `InvocationContextCreate(..., kLiteRtDispatchExecutableTypeMlModel,
&LiteRtMemBuffer{fd=-1, base_addr, offset=0, size, alloc_base_file_offset=0}, function_name=nullptr,
num_inputs, num_outputs, &ctx)` -> per-tensor `Get{Input,Output}Requirements` ->
`SupportedTensorBufferType`/`BufferSize` -> `LiteRtCreateManagedTensorBuffer` ->
`RegisterTensorBuffer` -> `Attach{Input,Output}` -> lock/write -> **`LiteRtDispatchInvoke`** -> lock/read
-> Detach -> Unregister -> Destroy in the test's order. **The async/fence half is deliberately omitted**
because it needs internal `platforms/darwinn` headers; the synchronous path needs none.

**One build detail worth knowing:** `LrtGetRuntimeContext()` lives only in
`//litert/c/internal:litert_runtime_context_testonly`, so `BUILD.snippet` marks the binary
`testonly = 1`. The dep list is copied from the real test target, which is **commented out** in the
public BUILD (internal-only) — so the deps come from reading it, not from a build.

**Bounds:** one environment, one device context, one invocation context, one attach cycle, `--warmup 1
--iters 10` by default, every call status-checked with the call text printed on failure, and it
**refuses** if the dispatch's required buffer size is smaller than the declared shape implies. That is
what makes `timeout 30` realistic; `run-recipe.sh` has the push/run/pull lines.

**What I need to finish it:** the FC model's **shapes**. I have the bytecode and your compile receipt but
not `qwen_fc_blockwise_quantized.tflite`, so I cannot read its signature — either main reads num
inputs/outputs, shapes and dtypes off it, or send me the file and I will print the exact flag line with
the same parser I used on the Qwen container. For numerics, `--input …=file` / `--output …=file` exist so
the comparison against main's CPU reference is byte-level rather than eyeballed.

**Not claimed:** that it executes, or that the INT4 bytecode is invocable through the ML-model path at
all — compiler acceptance (rc 0, 1,712,128 B, 0.430 s) is not runtime acceptance, and the first real
signal will be the status from `InvocationContextCreate`. No speed claim either: the invoke timing is a
kernel number for one FC block, not a model rate.

**prefill_64 parked, complete:** `PRUNE-REVIEW.md` has the full review — all 64 state-buffer names
resolve under both keep-sets, and the 11-field/44-byte patch table is ready if you want it.

---

# GUI -> root, 2026-09-10T23:22Z — execution harness DELIVERED (not a plan): builds to one binary, verdict in-process

All prefill work parked. `dispatch-exec/` now contains a complete harness, and the parts I can test
without a device **are tested and passing**.

    exec_bytecode.cc   309 lines  f2e08b88be9b1542…   the harness
    spec_parse.inc     102 lines  0ac10e95bae50974…   pure helpers, shared, one source of truth
    selftest_pure.cc   ---        a9da141055c88090…   host self-test: 29 checks, ALL PASS
    BUILD.snippet                 462e6b6c17bc5155…   deps copied from the real dispatch test target
    run-recipe.sh                 5575508d37c302b7…   push/run/pull, timeout 30, real file names

**Shapes are no longer a guess.** Your staged files settle them: `fc-input-f32.bin` and
`fc-reference-f32.bin` are **4,096 bytes = 1,024 float32** each (input is a ramp starting
-0.75, -0.5, -0.25, 0.0; reference spans -1.515 to 1.677). The recipe therefore runs
`--input 1x1024:f32=…/fc-input-f32.bin --output 1x1024:f32=…/out0.bin --reference …/fc-reference-f32.bin`.
If the vendor rejects the rank, the one-line retry is `1024:f32` on both — identical 4,096 bytes, only the
declared rank changes.

**It gives a verdict in-process, so there is nothing to post-process.** Per output it prints
`beyond_tol`, `max_abs`, `max_rel`, `rel_rms`, the worst index with got/want, and `NUMERIC[i] PASS|FAIL`,
then exits **20** on numeric mismatch — distinct from **10/11** for a failed dispatch call and **2** for
usage. It also prints `VENDOR`, `BUILD`, `API x.y.z`, `CAPABILITIES`, the per-tensor buffer type and size
the dispatch itself asked for, and `INVOKE min/mean/max` over the timed iterations.

**What I verified off-device, rather than asserting:** I refactored the pure logic into
`spec_parse.inc` so it compiles on the host, and `selftest_pure.cc` exercises it — spec parsing
(rank, dims, byte arithmetic, the `=file` suffix, and five rejection cases including rank>8 and
zero-size), and the comparison maths (identical, one large error with the right worst index, atol
boundary both ways, rtol accepting 1% at 0.02 and rejecting it at 0.001). **29 checks, all pass**,
compiled with `clang++ -Wall`. Braces and parens balance in the harness, and the include sits inside the
anonymous namespace ahead of first use.

**Build:** `BUILD.snippet` mirrors the real `dispatch_api_simple_model_test` deps —
`litert_common`, `litert_runtime_c_api_shared_lib`, `litert_runtime_context_testonly`,
`litert_dispatch_c_api`. Note `LrtGetRuntimeContext()` exists only in the **testonly** target, so the
binary is marked `testonly = 1`; I found no non-testonly equivalent at this pin. The async/fence half of
the upstream test is deliberately absent, so no `platforms/darwinn` header is needed.

**Bounds:** one environment, one device context, one invocation context, one attach cycle, default 1
warmup + 10 timed invokes, every call status-checked with the call text and line printed on failure, and
it refuses if the dispatch's required buffer size is smaller than the declared shape implies.

**Still not claimed:** that it runs. It has not been compiled against litert or executed, and the first
real signal is the status from `LiteRtDispatchInvocationContextCreate` — compiler acceptance is not
runtime acceptance. The invoke timing it prints is a kernel number for one FC block, not a model rate.

---

# GUI -> root, 2026-09-10T23:29Z — harness FROZEN: NaN defect fixed and demonstrated, 49 checks pass, deps pinned

Astra's finding was correct and load-bearing. `EXEC-PLAN.md` section "FROZEN" has the detail; source is
frozen at:

    exec_bytecode.cc  39ddcdc5e6b4572a…    spec_parse.inc    75f5bf6a33b69761…
    selftest_pure.cc  12a3b5439845ec95…    BUILD.snippet     462e6b6c17bc5155…
    run-recipe.sh     5575508d37c302b7…

**The defect was real and I proved it rather than asserting it.** I compiled the pre-fix comparison body
on the host against a single NaN element:

    pre-fix logic on one NaN: beyond_tol=0 max_abs=0 -> verdict PASS (WRONG)

**Fix:** `std::isfinite` is now required on **both** sides per element; any non-finite element counts as
wrong; `nonfinite_got` and `nonfinite_want` are reported separately; `worst_at` points at the first
non-finite element rather than a meaningless magnitude; and `rel_rms`/`max_abs` stay finite because
non-finite elements never enter the sums. **Tolerances are rejected** if not finite and >= 0 — both at
argument-parse time and independently inside `CompareF32`, which sets `valid_tolerances=false` and
returns `n` so a caller ignoring the flag still fails loudly.

**Self-test is now 49 checks, all passing**, with the fixtures you asked for: NaN in the output, NaN in
the reference, Inf on both sides, Inf against finite, all-NaN, NaN alongside a real error (counts both
and keeps the real `max_abs`), plus five tolerance-validation cases.

**Exact runtime dependencies, so you can build without guessing.** Build deps are
`//litert/c:litert_common`, `//litert/c:litert_runtime_c_api_shared_lib`,
`//litert/c/internal:litert_runtime_context_testonly`, `//litert/vendors/c:litert_dispatch_c_api` —
the third is why the binary is `testonly = 1`. At run time there are **three** libraries: **`libLiteRt.so`**
(from `//litert/c:litert_runtime_c_api_so`, soname `libLiteRt.so`) needs pushing and `LD_LIBRARY_PATH`;
**`libLiteRtDispatch_GoogleTensor.so`** is dlopened from `--dispatch-dir`; and
`/vendor/lib64/libedgetpu_litert.so` is already on the device, dlopened by the dispatch library.

**One linker caveat:** `.bazelrc` defaults to `--define=resolve_symbols_in_exec=true` and litert's shim
links `-Wl,--undefined-glob=LiteRt*`, so a client executable is expected to **export** its `LiteRt*`
symbols for the vendor library to resolve against. Build with the repo defaults and **do not** add
`-fvisibility=hidden` or a version script here — the opposite of what was right for the JNI library.

Flags for this artifact are fixed by your files (1,024 float32 each): `--input 1x1024:f32=…`,
`--output 1x1024:f32=…`, `--reference …`, `--atol 1e-3 --rtol 1e-3 --warmup 1 --iters 10`; retry with
`1024:f32` if the rank is rejected. Exit 0 good, 20 numeric mismatch, 10/11 dispatch failure, 2 usage.

**Recorded:** prefill_64 at **5.03367 tok/s against 5.75-5.79** is slower and not adopted — the
two-signature variant stands, and my expectation that the bucketing would pay for its extra 22,469
compiled ops was wrong on this prompt. Still not claimed: that the harness runs. It has not been compiled
against litert or executed.

---

# GUI -> root, 2026-09-10T23:36Z — wrapping recipe: already implemented in public code; one actionable harness note

`WRAPPING-PLAN.md`. Artifact and source inspection only; **no code written, no build, no device.**

**First, something useful for the run you are about to do.** In every shipped DISPATCH_OP section, the
subgraphs of one section **share a single bytecode blob** and are told apart only by the `name` field,
which is `subgraph_N_fn` — and that string is the same `function_name` the dispatch API takes. Our FC
bytecode came from a single-subgraph tflite, so its entry is almost certainly **`subgraph_0_fn`**.
`exec_bytecode` passes `nullptr` by default, matching the upstream test; **if
`InvocationContextCreate` fails, retry with `--function subgraph_0_fn`** before drawing any conclusion
about the bytecode itself.

**The layout is measured, not inferred.** Across five sections of the G5 Gemma artifact,
`bytecode_offset + bytecode_size == section length` exactly, with the offset equal to the flatbuffer
length: `prefill_decode` 34,912 + 1,107,197,888; `mtp_drafter` 3,376 + 43,877,824; `vision_encoder`
3,632 + 229,828,864; `audio_encoder_hw` 2,000 + 102,587,968; `audio_adapter` 1,568 + 5,409,600. Each
subgraph is **exactly one op**, the custom op `DISPATCH_OP`, with the real tensors as its inputs/outputs.

**And the writer is public, so there is nothing to duplicate.**
`litert/core/build_stamp.h` gives `kLiteRtDispatchOpCustomName = "DISPATCH_OP"`,
`kLiteRtBuildStampKey = "LiteRtStamp"` and `MakeBuildStamp(manufacturer, model)` (the 250-byte stamp I
measured is exactly `124 + 124 + 2` and starts with `Google`). `model_serialize.cc:264-277` writes the
custom options as `MakeDispatchOpOptions({1, 1, <name>})` — **placeholders** — and
`:363-470` then appends each asset after the flatbuffer with `BytecodeAlignment()` padding and rewrites
the real offset and size in place. The hook that marks an op as carrying bytecode is
`model.h:1103 AttachAssetToOp(op, buf_id, name)`.

**So the minimal integration is five steps and only one of them is new code:** build a one-op subgraph
with the boundary tensors; register the bytecode as a buffer and `AttachAssetToOp(op, buf_id,
"subgraph_0_fn")`; add `LiteRtStamp` via `MakeBuildStamp("Google", "Tensor_G5")`; serialize through the
normal path, which fills the offsets itself; then either run it with the dispatch delegate or wrap it
into a `.litertlm` with the public `litert-lm-builder`. Writing the options by hand is exactly what to
avoid — the offsets are placeholders until serialization.

**On growing toward Qwen, one number is worth having before planning anything.** The compiler **bakes
weights into the bytecode**: Gemma's prefill+decode blob is **1.107 GB**. Qwen carries 2.6 GB of external
weights, so a compiled prefill+decode would be a multi-gigabyte blob produced **on the device** — and our
only ODC data point is 590,816 B -> 1,712,128 B in 0.430 s. That extrapolates to nothing. I would do a
**size ladder** — one transformer block, then a few — watching bytecode size, compile time and peak
memory, rather than attempting a whole signature; the GPU path already hit a wall at 142 MB MemAvailable.
Op coverage is the other gate: `rc=2` already happened for a8w8 and a16w8 Add, and the deny-list plus the
three required composites in `COMPILER-FEASIBILITY.md` §4 still apply, which is what the static
op-coverage checker would settle cheaply before spending device time.

Not claimed: that the harness runs (frozen, unbuilt), that a wrapped model loads (I produced no file), or
anything about whether Qwen can be compiled on-device.

---

# GUI -> root, 2026-09-10T23:47Z — app/JNI wrapper in app-dispatch/, plus a 30-second test that may beat building it

`app-dispatch/` — `jni/dispatch_jni.cc`, `jni/BUILD.snippet`, `app/` (2 Java files, manifest, no Maven
deps), `INTEGRATION.md`. Source only, nothing built, no device. **Your snapshot is not edited**, and your
existing Qwen/Gemma apps are untouched: different `applicationId` (`org.enclave.dispatchexec`), separate
Gradle project.

**No duplication.** The JNI glue declares `extern "C" int litert_exec_main(int, char**)` and the BUILD
snippet compiles **your `exec_bytecode.cc` unmodified** with `-Dmain=litert_exec_main`, so the dispatch
sequence exists once — in your file, at sha256 `80a1891971a2e506…`, including your `--async` path. **One
root-side line is the only change I need:** `exports_files(["exec_bytecode.cc"])` in
`litert/vendors/root_odc_probe/BUILD`.

**Before building the app, I think 30 seconds of shell time may settle it.** The abort text is
`Unexpected fd from epoll: 0`. A new eventfd or socket takes the **lowest free descriptor**, so if fd 0 is
closed the vendor's first notification fd *becomes* 0 — and that message says the vendor treats 0 as "not
a pending fd". Your runner calls `subprocess.run(adb shell …, stdout=PIPE, stderr=STDOUT)` with **no
`stdin=`**, so the device process inherits the automation harness's stdin, which may well be closed. Two
runs decide it:

    A:  ./exec_bytecode …  < /dev/zero     # fd 0 certainly open
    B:  ./exec_bytecode …  0<&-            # fd 0 certainly closed -- expect the abort

A succeeding and B aborting proves the cause is ours and the fix is one line in any launcher. Both
aborting kills the theory and the app comparison becomes the next step. Either way the wrapper is
defensive: it opens `/dev/null` onto any closed 0/1/2 **and reports how many it filled**, so an app run is
self-describing — a zygote-started process should report 0.

Also worth naming precisely: the async failure is `LiteRtDispatchInvokeAsync` returning **status 7 =
`kLiteRtStatusErrorTimeoutExpired`** (`litert_common.h:270`), i.e. the submission never completed rather
than an event being lost later.

**Dependencies, exactly.** Native: the same four bazel targets plus `-llog`, built as
`//litert/vendors/root_odc_probe:libdispatchexec_jni.so` — the target is *named* `libdispatchexec_jni.so`
so bazel emits that filename with no rename step. **Do not** add `-fvisibility=hidden` or a version
script: `resolve_symbols_in_exec=true` is the `.bazelrc` default and the shim links
`-Wl,--undefined-glob=LiteRt*`, so `LiteRt*` must stay exported. APK: AGP 8.7.3 / Gradle 8.9 / JDK 21 as
your other apps, `minSdk` 31, arm64 only, `useLegacyPackaging true`, `keepDebugSymbols` on all `.so` so
packaged bytes stay hash-verifiable, and **zero Maven dependencies**. Three libraries in
`jniLibs/arm64-v8a/`: the JNI lib, `libLiteRt.so`, and the **same-pin** dispatch — all from one bazel
tree, since mixing a prebuilt dispatch is what caused the earlier ABI faults.

**Permissions: none, deliberately.** The manifest declares no `<uses-permission>`. The dispatch library
loads from the app's own `nativeLibraryDir`, the vendor library is already on the device, and dmabuf or
binder use inside our own process is not permission-gated. I am not guessing one in; if the platform
denies something it will appear as `avc: denied` in logcat naming the class and operation, and that is
what to act on.

Run protocol, staging via `run-as` so nothing outside the app is touched, is in `INTEGRATION.md` §4, and
§5 reads the four possible outcomes — including the one that matters most for main's audit: the same abort
with `std_fds_filled=0` would mean it is neither descriptors nor process type.

Not claimed: that the app builds or runs, or that fd 0 is the cause. §2 is a hypothesis with a decisive
cheap test, and I would rather you falsify it in 30 seconds than build an app on my say-so.

---

# GUI -> root, 2026-09-10T23:50Z — FC vs ELU: the FC bytecode has NO argument-bound input

`FC-VS-ELU.md`. Artifact inspection only on the two saved bytecodes plus your compile logs. No build,
no device.

**The bytecodes answer it directly.** Same container (`DGC0`, header 3,952), **identical empty compile
options**, and these symbols:

    ELU  (runs)        _tpu_input_from_arg0        _tpu_output_from_tfl_elu
    FC   (times out)   _tpu_input_from_g1          _tpu_output_from_g1_linear_1

**ELU's input is bound to invocation argument 0; the FC file contains no `arg`-bound input symbol at
all.** Attach a host buffer as input 0 and invoke, and the FC graph has no arg0 DMA to consume — which is
precisely a submission that never completes. ELU also carries `before_fence_hw_instructions_3` and
`dive_model_info`, both absent from FC, and its scratch symbol is `dive_scratch_24080384` (~24 MB)
against FC's `dive_scratch_200704` (~200 KB).

**So it is not the options and not INT4 as such.** Both used the empty `EdgeTpuCompilerOptions` the public
adapter sends, and the compiler accepted the INT4 graph at rc 0 in 0.389 s. The difference is where the
graph's input came from.

**For main's fixture lane, a falsifiable criterion:** if the activation is not a genuine **subgraph
input** — a constant, or an intermediate the converter kept internal — the compiler binds the consumer to
the internal producer it found, which is what `g1` on both the input and output symbols looks like. A good
fixture must compile to a bytecode **containing `_tpu_input_from_arg0`**, as ELU does.

**And a pre-flight gate that costs no device time:**

    grep -o -a -E '_tpu_input_from_arg[0-9]+' <bytecode> | sort -u     # expect one per input

ELU: arg0 present. FC: nothing. Had we run that before the first invoke we would have predicted the
timeout instead of discovering it. Say the word and I will run the same check across the G5 Gemma
sections to confirm the convention holds for production bytecode — that artifact is local.

**Bounds:** these are symbol names read as strings out of a vendor container. The inference is strong
because the names are systematic and the two files differ exactly where the symptom points, but I have not
decoded the container's tables, so I cannot state the argument count the FC bytecode declares — only that
no `arg`-bound input symbol exists in it. Nothing was run, and this is about invocability, not numerics.

**App wrapper paused as instructed**, delivered and unbuilt in `app-dispatch/`. One correction to go with
it: the fd-0 hypothesis in its `INTEGRATION.md` §2 is **superseded and withdrawn** — your Binder
constructor fixed ELU in the same standalone process, so descriptors were never the issue, and I would
rather retract it than leave it to send someone down that path.

---

# GUI -> root, 2026-09-11T00:00Z — FC-VS-ELU WITHDRAWN; real fields say the fixture mirrors production

`FC-VS-ELU-CORRECTION.md` supersedes it; the old file is `FC-VS-ELU-WITHDRAWN.md` with a banner. All
three of your corrections accepted:

**The `_tpu_input_from_arg0` gate is withdrawn** — names in a vendor container are not a binding schema,
and you parsed the truth: **both fixtures have `INPUTS = [0]`**, so the input was bound in the failing
case. **rc=0 does not exonerate quantized lowering** — I used acceptance as evidence and that was wrong.
**"Binder fixed ELU" is withdrawn** — ELU without Binder was never tested, so the comparison does not
exist, and Binder did not fix FC.

**What the real flatbuffer fields show.** D (int4, times out) against E (float, 1.288 ms), parsed field by
field: `inputs=[0]`, `outputs=[2]`, one FULLY_CONNECTED with `inputs=[0,1]`, `input` FLOAT32 [1,1,64] and
`output` FLOAT32 [1,1,64] — **identical in both**. The only difference is the weights: D has
`weights_int4` INT4 [64,64] in a 2,048-byte buffer plus `weights_scale_f16` FLOAT16 [64,2] in a 256-byte
buffer; E has `weights_f32` FLOAT32 [64,64] in 16,384 bytes.

**And D's quantization is well-formed — I nearly told you otherwise.** It carries
`details_type=2 (BlockwiseQuantization)`, `{scales: 3, block_size: 32}`, `quantized_dimension=0`, no scale
vector. My first reading was that `scales: 3` meant buffer 3, which is empty — an off-by-one in the
fixture. **The production model disproved that before I wrote it:** all **243** INT4 tensors in Qwen
`prefill_1` use `BlockwiseQuantization` with `block_size=32`, `qdim=0`, no scale vector, and
`scales` in the **thousands** — impossible as a buffer index in a 1,901-buffer model, perfectly valid as a
**tensor index** among 3,657 tensors. So `scales` is a tensor index, D's `3` correctly names
`weights_scale_f16`, and 64 columns / block 32 = 2 blocks matches its [64,2] shape.

**So the fixture mirrors the shipped encoding exactly, and the failure is on the INT4 path** — your
position, now with the field evidence behind it.

**The container diff cannot settle anything either:** the two bytecodes differ in **644,263 of 658,752
bytes (97.80%)** across 108 regions, so no field story is readable by inspection. One small delta is worth
keeping: **`0x0800` = 2,048 vs `0x2000` = 8,192**, which is D's INT4 weights against a **bfloat16**
rendering of E's 64x64 weights — and that also explains E's strict numeric FAIL (43/64, max abs 1.19e-5),
since the public options proto defaults `FLOAT_TRUNCATION_TYPE_AUTO` with `BFLOAT16` among its values. A
float control should either widen tolerance to bf16 or request `FLOAT_TRUNCATION_TYPE_NO_TRUNCATION` —
an options field, not a fixture change.

**Two compiles would separate the remaining candidates**, if main wants a shape to aim at: an INT4 tensor
with an ordinary per-axis `scale` vector and **no** `details` (tests INT4 as a type), and an **INT8**
tensor **with** `BlockwiseQuantization` at `block_size=32` (tests the detail). Whichever runs localises
it; both timing out points at quantized lowering generally, which would also fit the a8w8/a16w8 `rc=2`
results.

Method note, since this is twice: I read names and a single field and inferred a contract. What caught the
second one was checking the shipped artifact before asserting, so that is now the order I work in — and
where I cannot check, I will say the schema is undecoded rather than infer it.

---

# GUI -> root, 2026-09-11T00:11Z — correction to my own correction: the bf16/options paragraph is withdrawn

Fixed in `FC-VS-ELU-CORRECTION.md` §4 (now sha256 `aaa25be0c725d407…`). You are right, and the paragraph
contradicted a finding I had already made myself.

**Both halves of it were wrong:**

* **bf16 is ruled out by measurement, not argument.** Main's nine-model comparison against all 64 device
  outputs (`nano-model-config-opus/FP16-TRUNCATION-FINDING.md`) has **fp16 weights with fp32 accumulation
  reproducing all 64 values bit-exactly, zero error**, while **bf16 weights scored 1/64, max abs 1.43e-4**.
* **The options route does not exist on the ODC path, and `ODC-VIABILITY.md` §4 already said so** — the
  adapter's `CreateEdgeTpuCompilerOptions` discards its input (upstream TODO b/467884692), and the only
  thing reaching the on-device compiler is the **opaque `EdgeTpuCompilerOptions.internal_options`**. So no
  public `GoogleTensorOptions` field explains anything here, and my
  `FLOAT_TRUNCATION_TYPE_NO_TRUNCATION` suggestion is withdrawn as unreachable.

**What I now state, and nothing beyond it:** a size word consistent with **two bytes per weight**, plus a
numerical model that matches every output byte. That is **a numerical observation, not evidence of a
compiler option and not a statement about hardware precision.** The only practical consequence is that a
strict 1e-3 tolerance is the wrong gate for a float control whose weights are fp16-rounded; the cause of
the rounding is unestablished.

I also added a cross-reference in `COMPILER-FEASIBILITY.md` §4 marking that `google_tensor_options.proto`
is **AOT-only** and must not be used to reason about ODC, so the same mistake is harder to repeat. The
earlier handoff paragraph above stands in the record as written, with this note as its correction.

Hardware is yours exclusively — I have run nothing and will not; noted that you are doing the CPU/GPU/NPU
Qwen runs for the user, and main's bridge withdrawal is read. No open asks from me.

---

# GUI -> root, 2026-09-11T00:18Z — plugin-integration.md: the plugin is publicly buildable and Android selects ODC

`plugin-integration.md` (sha256 `738b384cd4d536b4…`). Source-only at our pin plus the local checkout. No
build, no device, no downloads, no shared edits.

**Verdict: nothing needs patching — the missing piece is the plugin .so itself, in a directory litert-lm
already points at.**

**The target** is `litert/vendors/google_tensor/compiler/BUILD:27-57`, emitting
**`libLiteRtCompilerPlugin_google_tensor.so`**; build it as
`@litert//litert/vendors/google_tensor/compiler:google_tensor_compiler_plugin_so` with
`--config=android_arm64`. Its `nobuilder/no_oss/notap` tags only exclude it from CI and wildcards — naming
it on the command line still builds it — and its visibility restricts *dependencies*, not a top-level
request. The macros it needs are public, including `friends_of_google_tensor_compiler_plugin()`
(`special_rule.bzl:32-36`), and `ungrte` is inert for android
(`litert_build_defs.bzl:262-291`).

**The ODC gate is the good news:** `litert/vendors/google_tensor/BUILD:111-120` selects `:adapter_odc` on
`//litert:android`, so a plugin built for Android compiles **on the device** through
`/vendor/lib64/libedgetpu_litert.so` and the five `EdgeTpuCompiler*` symbols you already confirmed present.
The ACL-gated host path (`adapter_aot` + `liblitert_plugin_compiler.so`) is **not selected for Android**,
and `@google_tensor` is **not** among the target's deps — so the gated repo is irrelevant here.

**Your error message is precise, and it tells us the option was set.**
`compiler_plugin.cc:989-993` emits **"Compiler plugin is not configured"** when the env option is absent;
**"No compiler plugin found"** (`:1014-1018`) means the directory was set but nothing loaded. And
`runtime/util/litert_util.cc:99-113` shows litert-lm setting `kCompilerPluginLibraryDir` to **the same
`library_dir` as the dispatch library** — so the plugin belongs in the **same jniLibs directory** as
`libLiteRtDispatch_GoogleTensor.so`, with a filename beginning `libLiteRtCompilerPlugin`
(`dynamic_loading.h:26-33`). Three log lines then say exactly what happened: `Attempting to load plugin
at`, `Failed to load plugin at … with error`, and `Unsupported compiler plugin version` (`:277`) — the
last ruled out by construction when plugin and runtime come from one pin, as yours do.

**And why Qwen took that path at all:** `litert_util.cc:139-145` sets
`uses_generic_npu_compiler_plugin = !aux_model_buffer.ok() || empty()`. The Qwen artifact has **one
TFLiteModel section and no `tf_lite_aux`**, where G5 Gemma has one — so for Qwen on NPU the flag is true,
a plugin is expected, none was there, and XNNPACK took over. Exactly the sequence you saw.

**No patch proposed.** If a build does trip on `ungrte` or visibility, the minimal fixes are to drop
`ungrte = True` from that one target, or add the requesting package to the friends macro — but I would
rather you hit the real error than pre-emptively patch a shared file. §6 lists the pre-ship checks:
filename prefix, the eight plugin entry points in `--dyn-syms`, and `Tensor_G5` among the advertised SoC
models (`compiler_plugin.cc:78-79`).

**Numerics recorded unchanged:** fixture E stays a **FAIL at the strict 1e-3 gate — 43/64 beyond, max abs
1.19e-5, rel RMS 4.07e-4**; fixture D **times out**, no numbers. Main's fp16-weight match is a numerical
observation and I have not used it to widen any tolerance.

Not claimed: that the plugin builds, or that it will partition and compile the Qwen graph once it loads —
that is governed by the deny-list and composite rules in `COMPILER-FEASIBILITY.md` §4 and by whatever your
tiny INT8 bytecode test shows.

---

## 2026-09-11T00:51Z — ODC per-partition patch rev 2, weights audit, RAM bounds

Owned outputs, all in `litertlm-source-build-opus/`:

* `ODC-PARTITION-PLAN.md` (sha256 `701ece3a6b67d640…`) — the whole deliverable:
  the measured gate, the weights audit, the Tensor_G5 answer, the patch design and
  its verification, quantified RAM bounds, blocker order, and one cheap device
  discriminator.
* `odc-partition/PATCH.litert_odc_per_partition` (sha256 `30f28349f6c5e0f0…`,
  +278/−0, one file) and `odc-partition/make_odc_partition_patch.py` (19
  pre/post-conditions). `odc-partition/applytest/` and `basetest/` hold the scratch
  copies used for the apply and syntax checks.
* `prune/measure_partition_payload.py` + `prune/partition-payload.json` — read-only
  per-subgraph buffer accounting.

Corrections made this cycle:

* fixture E's recorded gate is now `atol=1e-06 rtol=0.0001` with root's
  `tiny-float-phone.log` quoted verbatim, in both `plugin-integration.md` §7 and
  `FC-VS-ELU-CORRECTION.md`. Still a FAIL; no tolerance was widened.
* revision 1 of the patch is withdrawn (it changed defaults, retried arbitrary
  vendor failures, and used partition-count equality as proof of non-mutation).

Answers:

* **weights through partition serialization** — preserved by reference
  (`Yank` borrows the parent buffer manager, `model.cc:198`) and re-appended by
  `SerializeWithAppendedBuffers`. The real defect is that `Yank` copies no
  metadata, so the partition loses `buffer_location`, which is the *only* thing
  tflite uses to decide buffers live outside the flatbuffer
  (`model_builder_base.h:671-681`); the real Qwen model does carry that key.
  Whether ODC consults it is undecoded.
* **Tensor_G5** — never selected in ODC mode: `soc_model` arrives as nullptr,
  becomes `"Unspecified"`, and the device is set to `DEVICE_TYPE_UNSPECIFIED`
  (`vendors/.../compiler_plugin.cc:735-742, 846-853`; `adapter_odc.h:47`). No extra
  SoC option is needed, and there is no public way to force G5 here.
* **RAM (new constraint)** — transient peak is one ~2.65 GB serialization buffer
  per partition, sequential. The decisive figure is the byte code: root's own two
  INT4 compiles fit `fixed(~656 KB) + 1 byte per weight` to within 1.3%, and reject
  packed-INT4, fp16 and no-weights. Projected to the full model that is ≈3.6 GB per
  partition, ≈7.1 GB for both, and a successful JIT additionally re-serialises the
  whole model into ~2.65 GB of anonymous memory (`compiled_model.cc:1152-1170`),
  which the CPU/GPU paths never do. Recommendation: do not spend a full-Qwen run on
  this yet; settle the scaling law with one more tiny compile, and if it survives,
  compile **decode only** via `subgraphs_to_partition` rather than both partitions.

Open for root: the three appended-weight fixtures (§7) and the byte-code scaling
compile (§5.4 step 1). No device, build, or shared-source action was taken here.

---

## 2026-09-11T00:58Z — rev 2 FROZEN; memory claims narrowed; INT4 scaling fixtures ready

**Patch frozen, not applied.** `odc-partition/FROZEN.md` records it:
`PATCH.litert_odc_per_partition` sha256 `30f28349f6c5e0f0…`, +278/−0, one file.
Regenerable by `make_odc_partition_patch.py` (19 checks). `ODC-PARTITION-PLAN.md`
§4 now carries a FROZEN banner. Nothing was applied to any tree.

**Memory section narrowed** (`ODC-PARTITION-PLAN.md` §5.2/§5.4, sha256
`e31b24b166413faa…`). The one-byte-per-weight reading of root's two compiles is now
stated as a hypothesis worth testing, not a finding, with explicit statements that
it does **not** establish native or resident weight format, does **not** establish
precision, and does **not** predict full-model RAM; that `elu` and the INT8 A/B/C
fixtures are not in the family and must not be fitted alongside it; and that
block-32 and per-channel fixtures are not comparable. The projection table is
labelled as arithmetic on the hypothesis. What stands unchanged, because it is
measured or source-established: the ≈2.65 GB transient serialization buffer per
partition (sequential, not cumulative); the ≈2.65 GB anonymous re-serialization on
a successful JIT (`compiled_model.cc:1152-1170`), which CPU/GPU never pay and which
the compilation cache turns into a first-run-only cost; and that per-partition
compilation pays the per-module cost once per partition because ODC cannot share a
module — structural, whatever the module contains.

**New: `odc-scaling/`** — three same-structure blockwise INT4 FC fixtures plus
docs (`ODC-SCALING-FIXTURES.md`, sha256 `2135061d2202a8f9…`):

| n | file | file bytes | packed weights | scales | fixed |
|---:|---|---:|---:|---:|---:|
| 64 | existing `fc_int4_blockwise_D.tflite` | 2,992 | 2,048 | 256 | 688 |
| 128 | `fc_int4_blockwise_n128.tflite` | 9,904 | 8,192 | 1,024 | 688 |
| 256 | `fc_int4_blockwise_n256.tflite` | 37,552 | 32,768 | 4,096 | 688 |
| 512 | `fc_int4_blockwise_n512.tflite` | 148,144 | 131,072 | 16,384 | 688 |

Every field is identical family-wide except shapes and payload sizes; the
non-payload part is **exactly 688 bytes in all four, spread 0**. The n=64 member is
the file root already compiled, and membership is proven: the generator regenerates
it **byte-identically** (sha256 `8b0f731a19ee48b4…`) or refuses to write anything.
Each new fixture ships `*-input-f32.bin` and `*-reference-f32.bin` (fsum in double,
stored float32, the dequantisation reference only — not a device prediction), and
`manifest.json` carries every count, size, sha256 and the caveats. Validation:
independent `Fb` re-parse of every field, member-to-member family identity, INT4
packing round trip, fp16 scale decode within 2^-10. All INT4 payloads measure
exactly 4.00 bits per weight.

Nothing compiled, nothing run. Root decides whether the compile-only sweep happens;
main's vendor-side duplication audit is the independent line on the same question.

---

## 2026-09-11T01:11Z — sweep recorded, weight-copy claim corrected, KV/activation audit

**Sweep recorded** in `ODC-PARTITION-PLAN.md` §5.2 (n=128 672,000 B; n=256 723,904 B;
n=512 925,696 B; with the already-measured n=64 658,752 B). Marginal growth per added
weight element: 1.078, 1.056, 1.026 B across the three steps. Recorded as a
**file-size relationship only** — the earlier one-byte-per-weight *interpretation* is
withdrawn, no resident-format or precision inference is drawn, and the full-model
projection table is deleted rather than rescued.

**§5.3 corrected against main's rev 2.** My "a successful apply copies all 2.65 GB of
weights" is **withdrawn**. `SlicePartitionFromGraph` drops the partition's ops from
the root subgraph and runs `DCE(root)` (`algo.cc:300-317`); a weight tensor whose only
consumer moved into the slice has no defining op, zero uses, is not subgraph IO, and
is removed (`model.cc:406-408, 620-644`) before the serializer walks
`litert_subgraph.Tensors()`. So `model_buf_` holds the retained set — unselected ops'
weights plus bytecode — not every weight; at 2866/2866 and 2920/2920 selection the
retained-weight term is near zero. Still standing: the ≈2.65 GB **transient** buffer
(it is the *sliced* model that is serialized for the vendor), and that no-plugin runs
pay none of this.

**New: `KV-ACTIVATION-AUDIT.md`** (sha256 `4627737411b2b3d5…`), tool
`kv-audit/measure_state_and_activations.py`, data
`kv-audit/state-activations-prefill1.json`.

* Architecture as declared: 32 layers, full attention on 3/7/11/…/31 (8 layers),
  linear attention on the other 24. The container's `ExecutorMetadataProto` types all
  **64** state buffers: 8 `GLOBAL_KEY_CACHE` (seq axis 2), 8 `GLOBAL_VALUE_CACHE`
  (axis 3), 48 `LINEAR_ATTENTION` (no seq axis).
* **One full state bank = 321,912,832 B (321.9 MB)**, all FLOAT32: k 8×16,777,216,
  v 8×16,777,216, lr 24×2,097,152, lc 24×131,072. Derived rates: **64 KiB of global KV
  per token of context**; **53.5 MB of linear-attention state is context-independent**.
* **The 4096 context is baked in**: 0 of 3,657 and 0 of 3,724 tensors carry a negative
  `shape_signature` dim, so `LitertState::Resize` cannot apply and the incremental
  growth path (`kv_increament_size_`) is dead for this artifact. Full 321.9 MB is
  allocated for a one-token conversation.
* **Activations are not the problem**: lifetime high-water 4,346,528 B per signature
  (method: live from defining op to last consumer, max over op order; estimate, not an
  exact arena), versus a 251.7/253.1 MB no-reuse upper bound. State dominates by ~75×.
* **The one knob**: `llm_litert_compiled_model_executor.cc:1842-1850` sends GPU to
  `kPingPong` — a **second full bank**, and because `TYPE_LINEAR_ATTENTION` is bucketed
  as `is_key` (`state.cc:711-713`) the duplicate covers all 64 buffers — unless an
  input is literally named `param_tensor`
  (`kInputInt32ParamNames`, `litert_compiled_model_executor_utils.cc:97-98`). This
  model has `tokens`/`input_pos`/`mask` and no `param_tensor`, so **GPU pays
  643.8 MB of state where CPU/NPU pay 321.9 MB**. Proposed: a default-off gate letting
  GPU use `kInplace`, every unset path unchanged. Expected behaviour: bit-identical
  output and 321.9 MB returned if the graph's state update is alias-safe; loud
  divergence if not. Cost is a correctness risk, not a quality trade-off, so the gate
  is root's existing exact-output-hash comparison on one bounded GPU run. GPU-only —
  CPU and NPU already default to `kInplace`.
* Rejected alternatives, with arithmetic: FLOAT16 state (−134.2 MB) and a 1024 context
  (−201.3 MB) both need a re-export, and the latter costs real capability.

No device, no build, no shared-source edits, no new fixtures. The frozen rev-2 patch
remains frozen and unapplied.

---

## 2026-09-11T01:28Z — GPU in-place state experiment, patch rev 2 (root's review applied)

`GPU-INPLACE-STATE-EXPERIMENT.md` (sha256 `6b2de2bb59be4831…`),
`gpu-inplace-state/PATCH.litertlm_gpu_inplace_state` (sha256 `b3eee0f994432770…`,
4 files / 9 hunks / +190 −1, the one deletion being `hdrs = ["state.h"],` becoming a
two-entry list), generator `make_gpu_inplace_patch.py` (20 post-conditions).
**Not applied.**

All five review points applied:

1. `Size()` errors are no longer swallowed — `BankBytes{bytes, counted, unknown,
   overflow}`, every addition overflow-checked, failed buffers excluded from the
   total and counted, plus an explicit INCOMPLETE warning saying the totals are a
   lower bound and must not be quoted. Nothing in the header can fail a runtime op.
2. Diagnostics have their **own** default-off gate `LITERT_LM_STATE_DIAGNOSTICS=1`,
   separate from the experiment gate `LITERT_LM_GPU_INPLACE_STATE=1`; with both
   unset the patch logs nothing, so unset logging behaviour is preserved.
3. The accounting moved to a **new file**, `runtime/executor/litert/state_bank_diagnostic.h`,
   so it cannot collide with main's requirement-comparison work; `state.cc` keeps a
   3-insertion / 9-line footprint (one include, one call at each of the two
   `LitertState` construction sites).
4. BUILD dep added: the `state` target gains the new header in `hdrs` and
   `@com_google_absl//absl/log:absl_log` — it had **no** log dep, so rev 1 would not
   have compiled.
5. The stand-in compile is no longer offered as a build. I compile the real header
   text against mock absl types (`-Wall -Wextra`, no warnings) and exercise
   diagnostics-off/single-bank/two-bank/Size-failure/overflow paths; that is a smoke
   check of syntax and logic only. Root's build is the first real check, and the
   BUILD dep is the most likely thing to need adjusting.

**GPU lowerings, as asked.** The reference CPU `DYNAMIC_UPDATE_SLICE` kernel
declares `kTfLiteInplaceOpInput0Shared` (`tflite/kernels/dynamic_update_slice.cc:351`;
semantics at `tflite/core/c/common.h:1153-1157`) — declared in-place support, and a
plausible reason `kInplace` is already the CPU default. The TFLite GPU delegate in
this pin does **not** lower it: controlled grep of `tflite/delegates/gpu/` gives
`kTfLiteBuiltinAdd` 2 files, `kTfLiteBuiltinSlice` 2, `kTfLiteBuiltinConcatenation`
2, `kTfLiteBuiltinDynamicUpdateSlice` **0**. But litert-lm's GPU path is ML Drift
(`litert/runtime/accelerators/gpu/ml_drift_*`, deps pointing at
`//ml_drift_delegate/...`) and **no ml_drift repository exists in the pinned external
tree**, so the lowerings actually used are unreadable here. The aliasing question
therefore cannot be closed statically with these sources.

**Two claims in main's alias review I record as overstrong** (main's §1 finding that
input and output buffer requirements are resolved by separate queries is good and is
the right first test):

* "safe **only if** `S_in` has exactly one consumer and that consumer produces
  `S_out`" is not necessary — 48 of the 64 buffers violate it and have the
  *stronger* guarantee (producer transitively downstream of the only read), so the
  rule would misclassify them; and not sufficient — the 16 that satisfy it are
  exactly the ones resting on intra-kernel behaviour we cannot read. The condition
  that matters is "every read of `S_in` ordered before every write of `S_out`",
  satisfied either by dataflow (48) or by kernel contract (16).
* "`kGpuOptimizedInplace` would be redundant if the requirement sets coincided" does
  not follow: its documented purpose is to skip binding state as inputs "to avoid
  overhead" (`state.h:45-49`) and it still binds local KV in prefill
  (`state.cc:427-447`) — a binding/performance motive, not a layout proof. Main's
  comparison settles it; the inference does not.

**Prediction unchanged and falsifiable**: one bank = 321,912,832 B = exactly 307 MiB;
control (GPU, experiment off) should log `bank_2_present=1 total_bytes=643825664`,
experiment arm `bank_2_present=0 total_bytes=321912832`, CPU/NPU unchanged either
way. If `complete=0` the numbers are a lower bound and must not be quoted.

Root owns the build/device after the CPU memory baseline, and prepares the app intent
`gpuInplace` → `LITERT_LM_GPU_INPLACE_STATE`, off by default. No device, build, or
shared-source edits here; the ODC per-partition patch stays frozen.

---

## 2026-09-11T01:41Z — selective alias design; two corrections (Size semantics, ML Drift sources)

`SELECTIVE-ALIAS-DESIGN.md` (sha256 `e320defcc6e38122…`) and
`kv-audit/state-alias-edges.json` (sha256 `86b5ebb99cb5b951…`, all 128 state edges).
Design only; nothing applied, no build, no device. Patch rev 2 stays unapplied and
`GPU-INPLACE-STATE-EXPERIMENT.md` now carries a superseded banner pointing here.

**Correction 1 — `Size()` is not logical bytes.** Type 12 is
`kLiteRtTensorBufferTypeOpenClTexture` (`litert_tensor_buffer_types.h:55`), so the
GPU state buffer is an OpenCL texture. `LiteRtGetTensorBufferSize` returns
`buffer_size()`, which is a **constructor argument** supplied from the backend's
requirements (`tensor_buffer.cc:114-123`), while `packed_buffer_size_` is the logical
figure from `GetNumPackedBytes` (`:129-138`) = 2,097,152 for that tensor. So my
predicted `total_bytes=643825664` is **withdrawn as a measurement method**; 321,912,832 B
survives only as logical tensor content, and a texture-backed bank's device footprint
is a third quantity neither call reports. 2048 fits two exact readings (row pitch
128×4×4, or trailing dim 128×4×4); the distinguishing datum is the same query on a
`kv_cache_k_*` `[1,4,4096,256]` and a `kv_cache_lc_*` `[1,8192,4]`. The diagnostic
should report type + `Size()` + `PackedSize()` per buffer instead of summing.

**Correction 2 — ML Drift delegate source IS present.** `external/litert/ml_drift_delegate/`
has the conversion, support and boundary layers; only `@ml_drift` (IR + kernels) is
absent. Consequences, all readable: DUS **is** supported
(`support_dynamic_update_slice.cc`: ≤4 ranks, 3 in/1 out, non-constant indices — our
`[1,4,4096,256]`/`[1,4,1,256]` qualifies), unlike the stock TFLite GPU delegate which
has no DUS at all; conversion keeps operand and output as distinct IR tensors and
requests no in-place behaviour; **external tensors skip both upload and download**
(`delegate_kernel_litert.cc:557-610`), so aliasing is not laundered by a boundary
copy; and `BindExternalTensorBuffers` (`:193-250`) binds each id with **separate
input and output descriptor arrays** and no duplicate detection — the concrete
mechanism behind main's requirement-divergence concern, and it fails silently.

**The design.** Per-buffer `alias_input_output` on `StateBuffer`, default false,
decided by a static classification (alias only where every consumer of the state
input is an ancestor of the op producing the state output) behind the existing
default-off gate — not a name list. The blocking structural fact: the current policy
is all-or-nothing because `GetStateBuffers` swaps **whole maps** (`state.cc:404-461`),
so a partial bank 2 would leave some state outputs with no buffer; `Resize` and
`SelectAndCopyFrom`/`BroadcastAndCopyFrom` also refuse outright when bank 2 exists,
while `Clear`/`DeepCopy` already tolerate a partial map. Design lists the minimal
per-method changes, the invariants to assert, and defers to main's hunk in state.cc.

**The economics, which is the headline:** the 48 dataflow-proven states
(`kv_cache_lr_*`, `kv_cache_lc_*`) are **53,477,376 B (51 MiB)**; the 16 that need an
unreadable kernel proof (`kv_cache_k_*`, `kv_cache_v_*`, all `DYNAMIC_UPDATE_SLICE`
with the state input as operand 0 and the producer as sole consumer) are
**268,435,456 B (256 MiB)**. Selective aliasing is the safe subset and the small half.
Admitting the 16 needs main's descriptor comparison first, then a single-layer device
discriminator comparing the full output buffer with and without aliasing — not a
prompt comparison.

---

## 2026-09-11T01:51Z — selective design FROZEN + corrected; GPU DUS aliasing probe prepared

**Correction accepted.** "48 provably safe" is withdrawn. Graph ancestry is
necessary, not sufficient: ML Drift lowers into its own IR and may **fuse** the
read chain with the writing op, and a fused kernel can overlap reads and writes
internally whatever the source DAG says. The fusion and scheduling decisions live
in `@ml_drift` (absent); the readable conversion layer does not show them. So all
64 states need device evidence — the 48 simply satisfy one necessary condition the
16 do not. `SELECTIVE-ALIAS-DESIGN.md` now opens with a FROZEN banner saying exactly
that, and no selective production edit is proposed.

**New: `dus-alias-probe/`** — source-only fixture generator + harness, root builds
and runs:

* `dus_alias_k.tflite` (576 B, sha256 `6649262d28e0008d…`): operand
  `[1,4,4096,256]`, update `[1,4,1,256]`, sequence axis 2.
  `dus_alias_v.tflite` (576 B, sha256 `6ef156f45d743315…`): operand
  `[1,4,256,4096]`, update `[1,4,256,1]`, axis 3. Single `DYNAMIC_UPDATE_SLICE`,
  opcode **version 1**, three real inputs with **non-constant `start_indices`** —
  both required by ML Drift's `IsDynamicUpdateSliceSupported`.
* `dus_alias_probe.cc` (sha256 `d49f1fe7e92ebc60…`): public LiteRT C++ API only;
  loads the GPU accelerator dynamically via the `kRuntimeLibraryDir` env option
  (the libLiteRtClGlAccelerator.so path, per `gpu_registry.cc`); prints input and
  output buffer requirements (supported types + `BufferSize()`) and the created
  buffer's type; **exits 3 refusing to report anything if the operand is not a GPU
  buffer type** — a CPU result would be falsely reassuring since the CPU kernel
  already declares `kTfLiteInplaceOpInput0Shared`. Then per position it runs
  `mode=off` (distinct output) and `mode=on` (a `Duplicate()` of the operand as the
  output, exactly what `kInplace` does), reads back all 4,194,304 elements and
  compares every one, splitting mismatches into inside/outside the written slice
  and naming the mechanism: `ALL_MATCH`, `LOST_UPDATE`, `SLICE_WRONG`,
  `CLOBBERED_OUTSIDE`, `MIXED`.
* Patterned nonzero cache `(((h*4096+s)%251)+(d%13)*256)/256` with strictly
  negative updates `-(((h*256+d)%509)+1)/256` — all multiples of 1/256, exact in
  float32, sign-separated so an unwritten slice is unmistakable. Positions 0, 1 and
  last (4095). A zero cache would have hidden a kernel that zeroes what it copies.
* `BUILD.snippet` (all ten dependency labels checked against the pinned
  `litert/cc/BUILD` and `litert/c/BUILD`), `run-recipe.sh` with exit-code meanings,
  `manifest.json`, `README.md`.

**Verification done**: fixtures re-parsed field-by-field with the independent reader
(including "no buffer carries data", so no input is constant, and "exactly the
sequence axis is sliced"); `GetBuiltinCode` = max(builtin, deprecated) = 151 so the
capped legacy field 127 cannot mislead the loader; and the harness's comparison
logic, **extracted verbatim** and compiled standalone with `-Wall -Wextra`, correctly
names all five kernel behaviours for both variants at positions 0/1/last.
**Not done**: the harness has never been compiled against real LiteRT headers nor
run. Two spots to watch in root's build: the `GetInputBufferRequirements("cache")`
overload resolution against a string literal, and whether `Run` accepts the aliased
span pair at all — a refusal there is itself the answer.

Also recorded: root's v2 requirement runs show 64 compared with zero divergence and
zero failures on both prefill_1 and decode, CPU and GPU; and GPU `lr_0` raw 2048
versus packed/logical 2,097,152 is confirmed as a representation difference, not a
memory total.

---

## 2026-09-11T02:03Z — PIVOT: alias/RAM line frozen unvalidated; ODC per-partition resumed

**Frozen unvalidated** (banner added to each, no further iteration):
`dus-alias-probe/README.md`, `SELECTIVE-ALIAS-DESIGN.md`,
`GPU-INPLACE-STATE-EXPERIMENT.md`, `KV-ACTIVATION-AUDIT.md`. Root's last DUS review
is recorded inside the banner as seven open, unapplied points (output-type gate,
delegate execution evidence, arg/position validation and the all-skipped PASS hole,
OFF-before-ON interpretation, main's readback contract, the runtime_c_api_so_shim
dep, Create(filename, Options)). Nothing there is built, run, or to be trusted.

**Resumed: `odc-two-partition/`** — tiny integration fixture for the per-partition
GoogleTensor ODC path, aimed at compile + dispatch + numerics without duplicating a
real model. Root builds and runs.

* `two_partition_inline.tflite` (17,456 B, sha256 `4602efe2dde48e87…`) and
  `two_partition_offset.tflite` (17,568 B, sha256 `1b0596f749f5a917…`): two
  subgraphs, two signatures (`sig_len1` `[1,1,64]`, `sig_len2` `[1,2,64]`), one
  float32 `FULLY_CONNECTED` version 6 each (the exact configuration of fixture E,
  already proven to compile AND execute on this TPU at 1.288 ms), **sharing one
  weight buffer** — the prefill/decode relationship that produced
  `:749 ODC mode does not support multiple subgraphs`. The offset variant appends the
  weights past the flatbuffer (offset 1184 / 16,384 B) and carries the
  `buffer_location` metadata entry, so the pair is a clean A/B on exactly one
  variable: the metadata `Yank` drops and rev 2's `CopyModelMetadata` restores.
* Weights are multiples of 1/256, exactly representable in fp16, and the generator
  **checks** that fp16-rounding them leaves the reference byte-identical — so the
  device behaviour root measured predicts the same bytes and a mismatch cannot be
  blamed on weight precision. INT4/W4 stays out; main owns it.
* `two_partition_probe.cc` (sha256 `ded7e2f99ac4e32d…`): public API only,
  `Create(filename, Options)` + `SetHardwareAccelerators` (checked), env options for
  compiler-plugin / dispatch / runtime dirs, a `--cpu-control` mode that must pass
  before any NPU result is interpreted, strict numeric argument parsing, a
  reference-file contract that rejects short/long/missing files, both signatures
  compared element-by-element at `atol=1e-06 rtol=0.0001` with NaN/Inf counted as
  wrong, **both** input and output buffer types reported, `status=INCOMPLETE` (exit 4)
  if fewer than two signatures were tested so an empty run can never read as PASS,
  and an explicit statement in its own output that **placement evidence is in the
  runtime log, not in the binary**.
* Lifetime review, traced in the README: the shared constant is registered once and
  reused by buffer id (`model_load.cc:228-237`); `DCE` is per subgraph
  (`algo.cc:300-317`) so slicing partition 0 cannot remove partition 1's tensor; and
  every yanked partition model only borrows the parent's `BufferManager`
  (`model.cc:198`), so serializing one partition cannot free what the other needs in
  either order. The fixture is what tests that: a consumed or mis-serialized shared
  constant shows up as the second signature wrong while the first is right.
* **Top risk flagged**: the vendor names every partition's entry point
  `subgraph_0_fn`, so both dispatch ops get the same asset name with different byte
  code. My design argued that is fine; this fixture is the cheapest place that claim
  can break, and it would show as one signature returning the other's result or a
  dispatch lookup error.
* `BUILD.snippet` carries the `runtime_c_api_so_shim` dep root asked for, with an
  explicit note that the label is my reconstruction and `npu_placement_fixture`'s
  actual dep list is the authority. `run-recipe.sh` orders CPU control → NPU inline
  → NPU offset and lists the log lines that constitute placement evidence.

Verified here: every field of both fixtures re-parsed independently (including the
shared buffer index, the appended payload ending the file, and the metadata
round-trip) and the harness's argument/reference/comparison logic extracted verbatim
and self-tested under `-Wall -Wextra`. Not verified: the harness has never been
compiled against real LiteRT headers or run.

Next test for root, in order: CPU control on the inline fixture; then NPU inline with
the rev-2 patch applied and the experiment gate on; then NPU offset. The three logs
answer, in sequence, whether the fixture is sound, whether two partitions compile and
dispatch correctly, and whether the metadata carry matters.

---

## 2026-09-11T02:19Z — rev 2b frozen; failure-path verified; negative fixture; harness %s fix

**Freeze for root, before applying anything** — `odc-two-partition/FREEZE.md`:

| artifact | sha256 |
|---|---|
| `odc-partition/PATCH.litert_odc_per_partition` (**rev 2b**, +289/−0) | `7e8a70948339c6b71f7901dcf97546f514f10aaa021dab838824935c94b61722` |
| `two_partition_probe.cc` (after the %s fix) | `ddf9a221d70e7356fb1c75693b2166d65dd5164e53ee46e4d2c8f00523a3a4a7` |
| `gen_two_partition_fixtures.py` | `c367d941a7bdeda433bb76481fd040223b41407123eb74c02ea933b20fa231e1` |
| `two_partition_inline.tflite` | `4602efe2dde48e873871160b0c6bcc9c14b166fb0bd5bbd2c3b347ef580ee236` |
| `two_partition_offset.tflite` | `1b0596f749f5a91788d4466dbcfce25a27309a650132b2dd252d2c3f781a5731` |
| `neg_candidate_atan2.tflite` | `ec5ed98ebb64338e5637a1983e963be98f317110d43f8436c02477fa0f6a89d0` |
| `two_partition_negative_atan2.tflite` | `a6dbe5a0cf7239e427c82384f6166213a3e73063282bc7855302e0c297502ec6` |
| `FAILURE-PATH-VERIFICATION.md` | `810ee1117a8e19253f8f65ff81362f2ceddd8a2ab920dae903b8391813805293` |

The `.tflite`/`.bin` hashes are unchanged by the harness fix; only the .cc moved.

**1. `HasAppendedWeights` now propagates errors (rev 2b).** It is `Expected<bool>`;
an unresolvable buffer context returns `context.Error()` instead of `false`, and
`CopyModelMetadata` forwards it — rev 2's `false` would have silently dropped
`buffer_location` for a model that does have appended weights. Three new
post-conditions enforce it (22 total, all passing). Re-verified: patch applies
cleanly, **both arms compile with 0 errors**, and the flag-unset preprocessed output
still differs from baseline only in 20 `__LINE__` artifacts.

**2. Harness %s fix + full varargs audit.** Fixed the two
`std::printf("%s", sig.name)` calls root found in their copy. Then audited **all 18**
varargs calls by compiler, not by eye: same format strings, stub args of the same
declared types, built under `-Wall -Wextra -Wformat=2 -Werror=format
-Werror=format-extra-args -Werror=format-zero-length` — no diagnostics. Covered
`%zu` vs `size_t` (including `size ? *size : 0`), `%g`/`%.9g` vs double and
vs float (vararg promotion), `%d` vs `int` after explicit casts, every `%s` vs
`const char*`/`.c_str()`. The frozen DUS probe was checked for the same class: none.
Also made the signature list data-driven (`--sig NAME:LEN`, repeatable) with ten
malformed forms rejected and `status=INCOMPLETE` exit 4 on a short run.

**3. Failure path verified with exact caller lines** —
`odc-two-partition/FAILURE-PATH-VERIFICATION.md`. Chain: my loop returns the error →
`ApplyPluginWithPartition` → `ApplyPlugin` tail-return at
`compiler_plugin.cc:981-983` → `ApplyPlugins` records it as a **message** and
`continue`s at `:1038-1042`, so `*mutated = true` at `:1044-1046` is **skipped** →
`compiled_model.cc:1101` `need_reserialization` stays false → `:1152-1154`
`ApplyPluginsWithCaching` returns **false** → `InitializeModel` (`:763`) does not
take the early return at `:786-790`, falls through (`:791-794`) → **`:807`
`GetTflFlatbuffer(model)`** → `:812-814` `BuildFromBuffer`. So the interpreter is
built from the **incoming** bytes; the mutated in-memory model is never re-serialized
on this path (`SerializeModel` is at `:1156`, after the return). Two consequences
from the same lines: **no cache poisoning** (`SaveModel` at `:1166-1167`, also
unreachable) and partition 1's byte code stays in the buffer manager, unreferenced,
freed with the model. One residual coupling recorded: `apply_plugins_result_` is
stored even on partial failure and `:919-925` feeds `jit_executable_handles` into
dispatch options regardless — empty here because GoogleTensor exports no
`GetCompiledResultHandle` and my patch refuses handles outright.

**4. Bounded negative recipe + fixtures.** `two_partition_negative_atan2.tflite`:
subgraph 0 = ATAN2, subgraph 1 = the known-good FC. Because the loop yanks from the
back, **the good partition compiles and attaches first and ATAN2 fails second** —
exactly the state under review. ATAN2 (builtin 156) is **not** in the plugin's
`kUnSupportedOps` (`vendors/google_tensor/compiler/compiler_plugin.cc:110-155`), so
`IsOpSupported` (`:639-655`) selects it; it has no options table; and it has a CPU
kernel so the CPU control still passes. Whether ODC refuses it is **unknown** — hence
step 1 of the recipe is a compile-only rc sweep on the 912 B
`neg_candidate_atan2.tflite`, with named fallback candidates (CUMSUM 128, SIGN 158,
BITWISE_XOR 160, RIGHT_SHIFT 161, GATHER_ND 107) if ATAN2 compiles. The proof is
numerical: after the mid-loop failure both signatures must still report
`beyond_tol=0`, and `sig_len1` must match its positive-fixture CPU output
byte-for-byte.

Root's order stands: baseline CPU controls with no patch first (both the positive and
the negative model), then the rc sweep, then rev 2b with
`--copt=-DLITERT_ODC_PER_PARTITION_EXPERIMENT` and `LITERT_ODC_PER_PARTITION=1`.
No RAM/DUS work; main's tiny-INT4 wrong-output investigation untouched.

---

## 2026-09-11T02:24Z — probe hang fixed; rev 3 frozen with a single-mutator guard

**1. The startup hang was my parser, and it is fixed.** Root's diagnosis is exactly
right: `--cpu-control` in **trailing** position made `ParseArgs` loop forever. The
value was read first via `argv[++i]`, which does not execute when nothing follows, and
the handler compensated with `--i`, so the loop's own `++i` put the index back on the
same flag. Value-less flags are now handled immediately after reading the argument with
`continue` before any value is consumed, the old branch is deleted, and **no `--i`
idiom remains in the file**.

Tested, not assumed: a positional self-test covers the flag **first, middle, last,
alone and twice**, a missing trailing value for **each of the eight** value-taking
flags, `--sig --cpu-control` (rejected), the ten malformed `--sig` forms, unknown
flags and the tolerance validation — each case under a SIGALRM watchdog. All pass. And
the same test run against a **reconstruction of the pre-fix parser** reports
`HANG in case: bool LAST` and exits 9, so the test demonstrably has the power to catch
the bug root found. The frozen DUS probe was checked for the same idiom: it has no
value-less flags and no `--i`, so it is not affected.

String varargs: the two `std::printf("%s", sig.name)` calls were already fixed, and
**all 18** varargs calls are compiler-audited (same format strings, stub args of the
same declared types, `-Wformat=2 -Werror=format`) — no diagnostics.

**2. Failure-path claim qualified, per root.** `FAILURE-PATH-VERIFICATION.md` §1.1 now
states that step 6 (`*mutated` never set) is a **single-mutator** property: the
`ApplyPlugins` loop (`:1035-1051`) runs every loaded plugin against the same model and
`need_reserialization` is one flag, so an **earlier** plugin's success — or a **later**
one's — makes `:1156 SerializeModel` run and reserialize whatever this path attached
before failing. I am not generalizing rollback safety across plugins. Two responses:

* **documented requirement**: the experiment is only meaningful with exactly one
  model-mutating plugin loaded, which is root's setup (a directory holding only
  `libLiteRtCompilerPlugin_google_tensor.so`);
* **rev 3 guard**: `PerPartitionEligible` now takes the `ApplyPluginsResult&` and
  declines when `result.num_applied_plugins != 0` (`:1024` init, `:1049` increment),
  logging why — closing the "earlier plugin already succeeded" half with evidence the
  function can see.

The complementary case (a later plugin succeeding after we fail) cannot be closed from
inside that function and is documented, with the point that `PartitionModel` mutates
the model **before any compile**, so an unpatched single-compile failure already leaves
dispatch ops behind for a later plugin to reserialize: the per-partition loop widens
that window, it does not create it.

**3. Freeze — rev 3 is the version to apply** (`odc-partition/FROZEN.md`,
`odc-two-partition/FREEZE.md`):

| artifact | sha256 |
|---|---|
| `odc-partition/PATCH.litert_odc_per_partition` (**rev 3**, +302/−0) | `78b89f77e9bb94c48fe88357a8f58b0c0e18331a46d209ea9676c69ec9921af8` |
| `odc-two-partition/two_partition_probe.cc` (%s + hang fixes) | `f507a780aca47e99f946308afe040350334835de340206706ce3fd3f498cef21` |
| `two_partition_inline.tflite` | `4602efe2dde48e873871160b0c6bcc9c14b166fb0bd5bbd2c3b347ef580ee236` |
| `two_partition_offset.tflite` | `1b0596f749f5a91788d4466dbcfce25a27309a650132b2dd252d2c3f781a5731` |
| `neg_candidate_atan2.tflite` | `ec5ed98ebb64338e5637a1983e963be98f317110d43f8436c02477fa0f6a89d0` |
| `two_partition_negative_atan2.tflite` | `a6dbe5a0cf7239e427c82384f6166213a3e73063282bc7855302e0c297502ec6` |

Rev 3 re-verified: applies cleanly, **both arms compile with 0 errors**, flag-unset
preprocessed output differs from baseline in exactly 20 lines, all `__LINE__`
artifacts. Never built with the NDK, never run.

**4. Recorded root's CPU controls**: both PASS with no patch, 2 signatures each,
inline 0.257 s and appended-offset 0.312 s
(`pixel10-unified-model-1/two-partition/cpu-controls.json`). That fixes the references
and shows the **appended-weights model loads and runs**, so it is not a suspect if the
offset variant later misbehaves on the NPU path.

Still open in my lane, in order: the negative model's CPU control
(`--sig sig_bad:1 --sig sig_len1:1`), then the compile-only rc sweep on
`neg_candidate_atan2.tflite` (needs rc != 0 or I switch candidate), then rev 3 on the
NPU. Root's next step is the public W4 CompiledModel harness first; per-partition
after. No device work here, no RAM/DUS work, main's tiny-INT4 investigation untouched.

---

## 2026-09-11T02:39Z — rev 4 (test-only injection) + fallback harness mode + dispatch-name audit

Recording root's result first: **rev 3 built (33.691 s) and ran on the TPU.** Same
binary, OFF-inline reproduces the `:749` multi-subgraph guard; ON-inline and ON-offset
both take the full TPU path, 2 signatures each, DispatchDelegate 1/1 each, numerics
**EXACT 192/192 per model** (1.074 s / 0.682 s diagnostic), evidence
`pixel10-unified-model-1/odc-rev3`. So per-partition compile works, and the
appended-weights + `buffer_location` path works. ATAN2 compiles on ODC, so the ATAN2
model is **not** a negative case — kept as an extra positive, not run as negative.

**1. FROZEN.md now leads with the real current revision** and preserves history: the
file opens with the frozen hash and the four conditions it is frozen under, then
"History — revision 2 (superseded; was: do not apply)", then rev 2b, rev 3, rev 4.

**2. Rev 4: deterministic test-only failure injection** (sha256
`b0b0ea68c6404dc7244e123c81ab7fce5ddb18163c50d07e0703cc89c3af3636`, +358/−0, 29
post-conditions). Inside the existing `#ifdef` and behind a **second, separately
named** variable: `LITERT_ODC_PER_PARTITION_FAIL_AFTER=N` compiles and attaches N
partitions then **fails before compiling the next**. Unset/empty/0/non-decimal/>64 all
leave it off, malformed input warns instead of guessing, both log lines are prefixed
`PER_PARTITION_FAILURE_INJECTION`, and a post-condition asserts the helper is defined
after the `#ifdef` so it cannot exist in a default build. Rev 3's behaviour on every
path it exercised is unchanged.

**Note for root's tooling:** your external tree now carries the applied patch, so the
generator can no longer produce a diff from it. It now **refuses a patched tree** with
a message naming `odc-partition/pristine/` (sha256 `592f41dc19521bd2…`), which is the
pristine copy I generate against. Rev 4 was verified against that: applies cleanly,
both arms 0 errors, flag-unset preprocessed output differs in exactly 20 lines, all
`__LINE__` artifacts.

**3. Harness negative mode** (`two_partition_probe.cc`, sha256
`c2f6cbd8230e617535fcff54acee58c68ecfd1256a4386db2c253eef7fad9e5e`): `--expect-fallback`
requests the NPU path but **requires a clean fallback** — numerics still exact **and**
no signature accelerator-resident. It prints `MODE=negative`, a per-signature
`residency=accelerator|host` label, and a `FALLBACK … verdict=CLEAN_FALLBACK |
FALLBACK_VIOLATION | NUMERIC_FAILURE` line, with `RESULT status=… mode=negative
accelerator_resident=N` and an explicit note that the authoritative original-flatbuffer
evidence is the runtime log line, not this binary. `--cpu-control` and
`--expect-fallback` are mutually exclusive and rejected together in both orders.

Because the new flag is **value-less** — the class that caused your startup hang — the
positional test was extended: `--expect-fallback` first/middle/last/twice, combined
with `--sig`, both-modes rejection in both orders, alongside the existing
`--cpu-control` cases and the eight missing-value cases. All pass under the SIGALRM
watchdog. The format audit was re-run over **23** varargs calls including the five new
or changed lines: clean under `-Wformat=2 -Werror=format`.

**4. Dispatch-name audit** — `odc-two-partition/DISPATCH-NAME-AUDIT.md` (sha256
`cfdfde3984dda4c1a1b1ead26eb3368ae16c90c4baa9fba42f6f535ba7d4fc9e`). Lifetime: the
name survives the vendor's `strdup` and the `CompiledResult` because
`AttachAssetToOp` (`model.h:1103-1106`) takes it **by value** into a map **keyed by
op**. Mapping: each op carries its own `{bytecode_size, bytecode_offset, name}`
(`dispatch_op_schema.h:28-38`, written at `model_serialize.cc:269-273`, patched at
`:446-464`) and the kernel builds a **per-node** buffer and context
(`dispatch_delegate_kernel.cc:62-92`, `:672-691`) with no name-keyed lookup — so
duplicate `subgraph_0_fn` names are unambiguous, which is what your exact numerics
confirm. The **one** name-keyed collision site is the JIT-handle map consulted first at
`:639-653` (keyed by name only, from `compiled_model.cc:919-925`): if a vendor ever
returned a handle, both ops would take it and ignore their own offsets. It cannot fire
here — GoogleTensor exports no `GetCompiledResultHandle`, and my patch refuses handles
outright, which is why that refusal is load-bearing. The note also lists the four
symptoms to look for, in order, if a later run does fail, including the one case with
**no generic-side fix** (a vendor-internal name registry).

**5. Negative-fixture expected outputs verified independently** —
`verify_negative_expected.py` + `expected-negative.json`. It reads the ATAN2 constant
and the FC weights **out of the model file** rather than from the generator's Python,
and confirms: `sig_bad-reference.bin` is **64/64 bit-identical** to
`atan2(input, model constant)` (worst diff 0), `sig_len1-reference.bin` is 64/64
bit-identical to `FC(input, model weights)`, and the two signatures' outputs share
**0/64** elements, so a swap cannot hide. The frozen harness's argument controls were
re-verified by re-extracting `ParseArgs` from the frozen file itself (hash match
confirmed) and re-running the full positional suite.

Next, for root when convenient: apply rev 4, then step 4 of `run-recipe.sh` —
`LITERT_ODC_PER_PARTITION_FAIL_AFTER=1` with `--expect-fallback` — and step 5, the same
binary with the injection unset, which must return to the full TPU path. No builds or
device work from me; no full-model test; main's runtime weight fixture and right's
hybrid INT4 format untouched.

---

## 2026-09-11T02:42Z — NUL escaping fixed (rev 4b), lexical checks added, negative guard finished

**1. The NUL bytes are gone, and the cause is fixed at the source.** Root found literal
NULs at offsets 2077 and 2160 in the rev-4 patch, which made the file binary to `rg`.
Cause: a Python escape `\0` in this generator emitted the **byte** instead of the
two-character C escape. Fixed in the generator (`'\\0'` → emits `'\0'`). The patch is
now 15,796 bytes with **0 NUL and 0 non-ASCII bytes**, and the patched source also
contains 0 NULs.

Precise about the blast radius rather than alarmed: the emitted code **meant the same
thing** either way, since a NUL character literal is value 0 exactly like `'\0'`, so
rev 4 would have compiled and behaved identically — and root has **rev 3** applied,
which never contained the helper at all. The defect was lexical; it is the kind that
hides future diffs, so it is fixed rather than excused.

**2. Six lexical checks now run before the patch is written**: no NUL bytes, no control
characters besides tab and newline, pure ASCII, the two C NUL escapes present as
two-character escapes, no stray backslash-newline, every line a valid diff line. Proven
to fire, not just present: reintroducing the bad escape makes the generator print
`REFUSED: lexical check failed: no NUL bytes` and write nothing.

**3. Frozen rev 4b** — `odc-partition/FROZEN.md`, `odc-two-partition/FREEZE.md`:

| artifact | sha256 |
|---|---|
| `PATCH.litert_odc_per_partition` (**rev 4b**, +358/−0, 15,796 B) | `4a9530f1a9db00fbce63a4bbb92ef880ff319a5d01cf07a4d093d037535f623c` |
| rev 3, what root has applied | `78b89f77e9bb94c48fe88357a8f58b0c0e18331a46d209ea9676c69ec9921af8` |
| `two_partition_probe.cc` (adds `--expect-fallback`) | `c2f6cbd8230e617535fcff54acee58c68ecfd1256a4386db2c253eef7fad9e5e` |
| `FAILURE-PATH-VERIFICATION.md` | `0c3d252e4887cd78496f394755589de6dbe8d6ce8656876ddf5d29248993dd53` |
| `DISPATCH-NAME-AUDIT.md` | `cfdfde3984dda4c1a1b1ead26eb3368ae16c90c4baa9fba42f6f535ba7d4fc9e` |
| pristine baseline the patch is generated from | `592f41dc19521bd2fbd64384c23850f2ad86f523a3bc2c4c076f3d24f3509567` |

Re-verified after the lexical fix: applies cleanly to pristine, both arms compile with
0 errors, patched source has 0 NULs. **Root's source is untouched** — rev 3 remains the
only applied revision, its macro restored OFF, and the generator now refuses to run
against a patched tree so it cannot silently diff against root's applied copy.

**4. The deterministic negative guard is finished**, and §2 of
`FAILURE-PATH-VERIFICATION.md` now records it properly:

* `2.0` ATAN2 **compiles** on ODC (root's rc sweep), so it is not a negative case — kept
  as an extra positive, not run as negative. No further op-hunting.
* `2.1` the deterministic replacement: `LITERT_ODC_PER_PARTITION_FAIL_AFTER=1` attaches
  one partition then fails before compiling the next, run through the harness's
  `--expect-fallback` mode, which requires numerics exact **and** zero
  accelerator-resident signatures, labels the outcome `CLEAN_FALLBACK` /
  `FALLBACK_VIOLATION` / `NUMERIC_FAILURE`, and states that the authoritative
  original-flatbuffer evidence is the runtime log line. Recipe step 5 re-runs the same
  binary with injection unset and must return to the full TPU path, so a negative result
  cannot be confused with leftover state.
* `2.2` the old op-search plan is kept for the record, clearly marked superseded.

Noted and not duplicated: runtime-weight **BMM passes on the NPU, 64/64 with a dynamic
RHS**, while dynamic FC is rejected to host, and root prioritises the BMM path. That is
main's and root's lane; nothing in my files assumes the FC shape beyond the two-partition
fixtures already frozen. No builds, no device work here.

---

## 2026-09-11T03:00Z — rev 4b frozen untested; new lane: Gemma 4 E2B PLE common weight source

**Rev 4b frozen untested.** `odc-partition/FROZEN.md` now opens with that statement:
rev 3 remains the only revision root built and ran (TPU, both signatures exact, inline
and appended-weights); rev 4b adds only the test-only injection and the lexical fix and
has never been built, so its injection path must not be treated as exercised.

**New: `gemma-ple-sharing/CANONICAL-WEIGHT-AUDIT.md`** (sha256 `d12c72c001920fc5…`).
Source-only; no build, device or export. Findings, with file:line in the note:

* **The format already has the mechanism.** Schema **3d** adds
  `ExternalBufferGroup{name}`, `ExternalBuffer{id, group, offset, length, packing}` and
  `Tensor.external_buffer` (field **10**), with `Model.external_buffer_groups` = field 8
  and `external_buffers` = field 9. A weight tensor can carry **no inline data** and name
  a slice of a group instead, and several models can name the **same** group. This is
  distinct from the `Buffer.offset/size` >2 GB form the current Qwen artifact uses.
* **One packed file satisfies groups by name.**
  `Options::SetExternalWeightScopedFile(ScopedFile&, ScopedWeightSectionMap)` —
  documented as registering a file that contains **all** external buffer groups — plus
  two other ways (`model_directory` path, or `WeightInMemoryMap` group → host span).
* **CPU is zero-copy.** `compiled_model.cc:576-632` points each tensor at the external
  bytes with `kTfLiteMmapRo` specifically "so TFLite engine and delegates treat the
  external buffer as guaranteed, immutable read-only data".
* **GPU needs a device copy, not a second host copy, and not all at once.**
  `WeightAccessRequest{cpu, opencl, metal}`; `EnsureOpenClTensorBuffer` makes a device
  buffer per id; `DiscardExternalWeightByBuffer` → `DiscardCpuMappingPages` and
  `ReleaseExternalWeightByBuffer` are **per external buffer id**, so upload-then-discard
  works tile by tile. Upstream even tracks unifying the two buffers
  (`TODO(b/456581477)`). So "two full resident copies are inevitable" is **not**
  supported by the source, and I am not asserting the opposite either — §4 states exactly
  what is and is not required.
* **Nothing in the public framework forbids dynamic weights on TPU.** The GoogleTensor
  partitioner selects on just two things: the static `kUnSupportedOps` list
  (`:110-155`) and `GetFilterOutcome` (`:564-618`), which is **regex on output tensor
  names** from `op_filters_proto`. There is **no constant-weight condition**, and neither
  FC nor BMM is excluded. So root's measured split — BMM dynamic-RHS PASS 64/64 versus
  dynamic FC rejected to host — is a property of the **closed ODC compiler, per op**, and
  is probeable op by op. The filter regex is also a public knob for putting only tile ops
  on the TPU.
* **PLE is already separated.** `per_layer_embeddings` is a recognised model input
  (`kPerLayerEmbeddingNames`), the lookup takes **raw table pointers**
  (`HWPerLayerEmbeddingLookup(token_ids, num_tokens, const uint8_t* const* table_ptrs, …)`)
  so tables can point into one mapped file with only `num_tokens × ple_dim` materialised,
  and `EmbeddingLookupManager::Create` already accepts `external_weight_file` +
  `external_weight_sections`. The common-weight route needs **no new mechanism** here.

**Actual restrictions found** (§7): `packing` is carried and **keyed**, never converted —
one canonical packing must suit every consumer or each needs its own slice; GPU requires
a device-resident copy of whatever it touches; TPU dynamic-weight support is per op and
closed; AOT-compiled subgraphs carry their own weight image; the public CLI takes one
group per run (multi-group needs the C++ map); and schema 3d is required end to end.

**Minimum reusable experiment** (§8), ordered, and **E1 needs no new code** because
`litert/tools/run_model.cc` already has `--scoped_weight_file/group/offset/length`
alongside `--accelerator` and `--compare_numerical`:

* **E1** one tiny FC whose weight tensor has no inline data and resolves through
  `Tensor.external_buffer` → group, run on cpu / gpu / npu from **one** packed file;
  success is identical numerics with no per-backend model variant.
* **E2** a `BATCH_MATMUL` with the RHS as a runtime **tile** input sourced from the same
  file — the one dynamic-weight shape already proven on the NPU — checking two tiles equal
  one full matmul with only one tile resident.
* **E3** PLE through the existing lookup path, pointing
  `EmbeddingLookupManager::Create` at a group in the same file; no graph change.

E1 must precede E2 (if `external_buffer` does not resolve on a backend, tiles prove
nothing); E3 is independent and cheapest. Next from me, on request: the E1 fixture — my
writer needs three additions (Model fields 8 and 9, Tensor field 10), which the audit
records. Right owns portable artifacts, main the runner, root the tests.

---

## 2026-09-11T03:07Z — E1 external-weight fixtures built and independently reparsed; audit claims corrected

**Artifacts** (all in `gemma-ple-sharing/`, source-only, never built or run by me):

| file | bytes | sha256 |
|---|---:|---|
| `e1_int4_external.tflite` | 1,136 | `6cc74e77b589443b…` |
| `e1_fp32_external.tflite` | 712 | `c5727f7f8b13b380…` |
| `e1_packed_weights.bin` | 18,432 | `ca291bbfddae1cb3…` |
| `gen_e1_external_fixtures.py` | — | `ce3b342792b5d6f0…` |
| `verify_e1_fields.py` | — | `6b16425d711a3304…` |
| `E1-RECIPE.md` | — | `d82f519515ee3375…` |
| `CANONICAL-WEIGHT-AUDIT.md` (corrected) | — | `7afb180a67ccea9a…` |

**Preferred INT4 first, as asked.** `e1_int4_external.tflite` is the intended shape: one
FC whose INT4 `[64,64]` blockwise weights (block 32) carry **no inline bytes** and resolve
through `Tensor.external_buffer` → `ExternalBuffer` → `ExternalBufferGroup`, with the fp16
scales `[64,2]` deliberately left inline so the external mechanism is the only variable.
`e1_fp32_external.tflite` exists **only as a control, labelled not-the-end-goal** in the
manifest, the recipe and the file comment — to separate "external weights resolve at all"
from "INT4 blockwise resolves through them". Both share one packed file with two named
sections (`e1_int4_weights`@0+2048, `e1_fp32_weights`@2048+16384).

**Numerical target is inherited, not invented.** The INT4 payload, the scales and the
input are the same bytes as fixture D/E, which root already ran on CPU and TPU, and the
generator **refuses to write** if the reference stops being byte-identical to
`fixture64-reference-f32.bin`. It passed.

**Loader semantics were read, not assumed**: `Tensor.external_buffer` is field 10 and
holds an `ExternalBuffer.id` where **0 means none** (so ids start at 1);
`ExternalBuffer.group` is an **index**; the group **name** is matched against the caller's
section map; and `ExternalBuffer.offset` is **section-relative**
(`absolute = section.offset + offset`, bounds-checked) — so both fixtures carry offset 0
and each run passes its own section. `packing` is left absent on purpose.

**Independent reparse: 34 checks, all pass** (`verify_e1_fields.py`, using the independent
reader, not the writer). Including: Model fields 8 and 9; id non-zero; group index;
section-relative offset; length equal to the section; packing absent; field 10 equal to the
id; **the weight tensor holding zero inline bytes**; exactly one tensor claiming an external
buffer; the section inside the packed file; 4 bits per weight for INT4 and 4 bytes for
FP32; inline scales sized `[64,2]`; blockwise details → tensor 3, block 32; and the
strongest one, **the reference recomputed from artifact bytes only** — INT4 read out of the
packed file at the model's own section, scales read out of the model's inline buffer —
**64/64 bit-identical for both models**.

**Your three scope corrections are applied to the audit, not paraphrased:**

* §3 retitled "CPU: the assignment is a pointer, which is NOT the same as 'one host copy'".
  It now says the pointer assignment proves no copy **at that assignment**, and explicitly
  that **XNNPACK repacks**, so the practical CPU steady state can be mapping + repacked
  copy; `kTfLiteMmapRo` makes a repack safe and cacheable rather than preventing it, and
  host residency for a real graph is a device measurement.
* §4 retitled "GPU needs a device copy; bounding it is expressible, not automatic". The
  existence of `Discard`/`Release` is stated as making bounded residency *expressible*;
  nothing shows who calls them, when, or whether a real compiled model does — so GPU
  residency is to be treated as unbounded until measured. §7 item 2 matches.
* §2 now opens with "**One file is not one copy**" — naming one file fixes where the
  canonical bytes live and says nothing about materialised copies.

**Your newest measurements recorded in §6a**, not re-derived: FP32 dynamic BMM now exact on
**all three** backends with GPU fp32, so E2's dynamic-weight shape is not TPU-only; portable
Gemma same artifact, **different outputs** (CPU 18.0125 tok/s 251 vs GPU 8.8343 tok/s 228) —
which I flag as a prerequisite problem for any sharing claim, since "one artifact" has
already been shown insufficient for "same results"; PLE 35 INT4 buffers byte-identical to
G5, with scales and semantics explicitly right's check and byte-identity alone not
establishing interchangeable meaning; main's packed repeated rounds not duplicated. **No
full-sharing claim is made anywhere.**

**Runs for root** (`E1-RECIPE.md`): INT4 on cpu → gpu → npu with
`--scoped_weight_file/group/offset/length`, CPU first because nothing else is interpretable
if CPU is wrong; the FP32 control only if INT4 fails on CPU. The recipe spells out what each
of the four outcomes means, including the most useful negative — mechanism works, INT4
through it does not.

---

## 2026-09-11T03:21Z — NPU external-binding root cause, default-off bridge, INT4 control twin

**1. Why the weight became a missing runtime input — chain with lines**
(`gemma-ple-sharing/NPU-EXTERNAL-BINDING.md`, sha256 `81a4bc8a69801998…`):

* `tflite/core/subgraph.cc:1730-1749` raises `"Input tensor %d lacks data"` for a **node
  input** with no data — so the weight was an input, not a constant;
* `model_load.cc` **never reads `tensor.external_buffer`** (grep count 0), so the tensor
  arrives in the LiteRt graph with an **empty** weights buffer;
* `model.cc:507-519`: `IsConstant` is literally `Weights().Buffer().Size() > 0` → not a
  constant;
* `algo.cc:334-337`: every non-constant tensor with no defining op is **promoted to an
  input of the dispatch op** → the vendor compiled a graph expecting weights at run time,
  which matches "Dispatch 1 host 0";
* and the restore could not rescue it: the loader is built over **`fb_model_`**
  (`compiled_model.cc:511-522`), which on the JIT path is the **re-serialized** model, and
  `model_serialize.cc` **never writes** `external_buffers`/`external_buffer_groups` → empty
  `GetWeightInfo()` → "no external weight tensors found" → `weight_loader_ = nullptr`. Plus
  restoration is CPU-scoped by name (`RestoreExternalWeightsForCpu`) with
  `request.opencl = false` and an upstream `TODO(b/456318365)`.

That also explains the successes: FP32 CPU/GPU never re-serialize, so `fb_model_` stays the
**incoming** flatbuffer which does carry the tables. Two separable defects are named: (A) the
compiler never sees the weights; (B) the linkage does not survive re-serialization. Three fix
options are compared; I do **not** claim the bridge is the right design, only the minimum
that turns the failure into a measurement.

**2. Bridge patch, default off, never applied** —
`gemma-ple-sharing/bridge/PATCH.litert_external_weight_bridge` (sha256
`d2d531e010d0a601…`, **2 hunks, +170/−0**), generated against
`bridge/pristine_compiled_model.cc` (sha256 `5d8ea3a6b6d83a71…`, which the generator
verifies before patching). Gated on the build define
`LITERT_EXTERNAL_WEIGHT_BRIDGE_EXPERIMENT` **and** `LITERT_EXTERNAL_WEIGHT_BRIDGE=1`
**and** a non-null `options->scoped_weight_source`. It sits in `InitializeModel`
immediately before `ApplyPluginsWithCaching`, **borrows** the scoped source (leaving the
existing `std::move` intact), resolves `ExternalBuffer` **by id**, resolves the group by
**name**, reads at `section.offset + entry->offset` with the loader's own bounds checks, and
`SetWeightsFromOwnedBuffer`s the bytes onto the tensor. Every failure is returned; a missing
section is a warning that leaves the tensor alone. The success log states plainly that it
**copies** and therefore trades the single canonical source for a compilable graph.

Verified: 10 post-conditions + 4 lexical checks including **"ordinary path byte-for-byte"**;
applies cleanly; and against the **real** LiteRT/absl/TFLite/OpenCL headers
`g++ -fsyntax-only` gives **0 errors in both arms** (unset and set). The preprocessed unset
arm differs from pristine in 72 lines, **all of them `__LINE__` values**. Never built with
the NDK, never run.

**3. INT4 control twin, as you required before any attribution** —
`e1_int4_inline.tflite` (sha256 `e60a9db28821e8ab…`): same graph, names, shapes and
blockwise quantization, the **same 2,048 INT4 bytes** (verified sha-equal to the packed
file's section) and the same inline scales, but **no `external_buffer`, no group, no tables**
(independently re-parsed: fields 8/9 absent, field 10 zero; 8/8 twin checks pass). Decision
rule is written into the manifest and the recipe: same numbers as the external model →
external path exonerated; reference numbers → external path implicated.

Corroboration, explicitly **not** a substitute for that run: `e1-reference-qd8.bin` under one
candidate dynamic-quantization scheme puts element 0 at `0.0108011579` versus your observed
`0.01078213` — **1.9e-5** away, while the exact reference is **2.35e-4** away. About 12×
closer to a quantized computation than to exact float math, so the INT4 difference looks like
the kernel quantizing activations; the residual shows my scheme is not its exact arithmetic.
**No attribution is made pending the twin.**

**Next, in order**: the twin on CPU; then FP32 external on NPU **with the bridge**, expecting
`EXTERNAL_WEIGHT_BRIDGE: copied 1 …`, no "lacks data", and the same exact 64 values CPU and
GPU give — one run that isolates defect (A); then INT4 external on NPU only if the twin
clears the external path. Real Gemma affine path stays main-owned; your PLE lookup run is
next on that side. No full-sharing claim.

---

## 2026-09-11T03:30Z — loader exonerated; bridge hardened as specified; non-copying designs

**1. Your control settles the INT4 question and I have recorded it as settled.** The inline
twin is **byte-identical to the external INT4 model on all 64 values**, both differing from
the ideal by max `0.000578465`, with my dynamic-quantization hypothesis still off by max
`0.000110806`. **The external loader is exonerated for the CPU fixture**; the residual
belongs to the INT4 kernel's arithmetic, and I am not refining that hypothesis further since
it is not my lane. Recorded in `NPU-EXTERNAL-BINDING.md` §4 and `E1-RECIPE.md`, with the
original reasoning kept for the record rather than rewritten.

**2. Bridge hardened, all four points, before any build** —
`gemma-ple-sharing/bridge/PATCH.litert_external_weight_bridge` (sha256
`3eb1b4deec3f78e4…`, **2 hunks, +227/−0**, 15 post-conditions + 4 lexical checks):

* **explicit total byte cap**: `kBridgeMaxTotalBytes = 1 MiB`, checked per tensor against
  the running total with no-overflow arithmetic; exceeding it is an **error** naming the cap
  and stating that the bridge is a tiny diagnostic that cannot serve a full model.
* **bounds checked, not assumed**: `section.offset + offset` is checked for wrap against
  `numeric_limits<uint64_t>::max()`, the absolute offset must fit `off_t` for `pread`, and
  the length must fit `size_t` — each its own error.
* **non-empty `packing` is rejected** (`kLiteRtStatusErrorUnsupported`) because the bridge
  copies bytes verbatim and converts no layout; copying under a packing it does not
  understand would hand the compiler silently wrong weights.
* **a missing section for a group now fails** instead of warning and continuing — continuing
  would leave exactly the dataless tensor this bridge exists to diagnose. Unknown group index
  and unknown buffer id were already errors.
* the source comment now states that it **CANNOT satisfy a full-model memory goal** and is a
  tiny diagnostic only; a post-condition enforces that sentence's presence.

Re-verified: applies cleanly to the recorded pristine copy; **0 errors in both arms** under
`g++ -fsyntax-only` against the **real** LiteRT/absl/TFLite/OpenCL/XNNPACK headers; and the
unset arm's preprocessed output is **provably line-number-only** different from pristine —
after normalising integers *and* the `expected_value_or_error_<LINE>` identifiers the two
files are **identical**. Never built with the NDK, never run.

**3. Non-copying designs with their barriers** —
`gemma-ple-sharing/NONCOPYING-SOURCE-DESIGN.md` (sha256 `d4f09368bd557176…`):

* **Design 1, borrowed buffers** (`SetWeightsFromUnownedBuffer` into the mapping).
  *Barrier 1, lifetime*: the mapping must outlive the model, every yanked partition model
  that borrows the same `BufferManager`, the vendor `Compile`, and serialization — so its
  owner must sit above `InitializeModel`, and a narrower owner is a silent wrong-weights
  risk, not necessarily a crash. *Barrier 2, serializer*: re-serialization **turns a borrowed
  buffer back into a copy** — inline when `should_append` is false, appended-but-still-copied
  when true — so borrowing fixes the load-time copy only; past it needs the serializer to
  **re-emit the external linkage** (defect B) plus the loader to read the field at all.
  *Barrier 3*: the accelerator still bakes what it compiles, so Design 1's honest ceiling is
  one host mapping plus whatever the TPU bakes.
* **Design 2, tiled runtime weights**: weights never enter the graph, so barrier 2 and
  barrier 3 **disappear** rather than being solved, and the promoted-input defect becomes the
  intended design. *Barriers*: op coverage is per op and measured (BMM dynamic RHS exact on
  all three; dynamic FC rejected on NPU); tile shape is compile-time with the loop host-side,
  so accumulation order must be chosen and its numerics stated; bounded residency is a
  property of the orchestration (reuse one buffer per tile slot) and the API only makes it
  expressible; and per-tile dispatch cost trades throughput for residency at a rate that must
  be measured.
* **Recommendation, flagged as such**: Design 2 for the TPU path, Design 1 for CPU/GPU —
  only Design 2 escapes the compiled weight image, only Design 1 leaves the graph shape
  untouched, and one canonical file can serve both. Minimum experiments for each are
  specified, including a deliberate re-serialize-and-reload step that isolates barrier 2 from
  barrier 1.

No full-sharing claim. Real Gemma affine path stays main-owned; your PLE lookup run is next
on that side.

---

## 2026-09-11T03:44Z — bridge end-offset/file-end bounds + all-or-nothing; borrowed-buffer prototype

**1. Bridge: your three remaining concerns fixed** —
`gemma-ple-sharing/bridge/PATCH.litert_external_weight_bridge` (sha256
`b9d7e4334415fb5e…`, **2 hunks, +267/−0**, 17 post-conditions + 4 lexical checks):

* **end offset bounded before anything is allocated or read**: `length <= off_t_max -
  absolute` is checked up front, so the `file_offset += read_bytes` cursor in the read loop
  cannot overflow signed `off_t` — the check you asked for, placed before the allocation
  rather than inside the loop;
* **actual file end bounded too**: `absolute + length <= ScopedFile::GetSize()`, so a slice
  that fits the caller's declared section but runs past the real file is rejected with its
  own message, not read;
* **no partial success**: restructured into two passes. Pass one validates every entry
  (packing, group, section, caps, all bounds) **and reads every slice into a staging vector**;
  pass two only assigns, and nothing in it can fail. A failure anywhere therefore leaves the
  model exactly as it was. The 1 MiB cap is what makes staging affordable, and that
  connection is stated in the code.

Re-verified: applies cleanly to the recorded pristine copy; **0 errors in both arms** under
`g++ -fsyntax-only` against the real LiteRT/absl/TFLite/OpenCL/XNNPACK headers. Still never
built with the NDK, never run. Ready for you to apply as the bounded diagnostic.

**2. Borrowed-buffer prototype** — `gemma-ple-sharing/borrowed/`
(`borrowed_weight_probe.cc` sha256 `1f9c22829af6daad…`, plus `BUILD.snippet` and a README).
Own files, **not a patch**, nothing in your tree touched, and **off unless `--run` is
passed**. Three steps, each printing what it finds:

1. loads the E1 external fixture and shows `weights_bytes_before=0 is_constant_before=0` —
   the defect, visible in the graph;
2. mmaps the canonical file, binds the tensor with `SetWeightsFromUnownedBuffer`, and proves
   the bind is a **borrow** by address equality (`borrowed_no_copy=1`), with
   `is_constant_after=1` — the bridge's mechanism achieved without copying;
3. **the serialization boundary check you asked for**: it serializes via the public
   `LiteRtSerializeModel` and searches the output for the borrowed bytes, printing
   `BOUNDARY copy=PRESENT at_offset=N placement=inline_flatbuffer|appended_tail` — the exact
   point where the borrow becomes a copy. `--append` toggles
   `BufferContext::should_append` so both serializer placements can be compared. If it ever
   prints `copy=absent`, my reading of the serializer is wrong and the design note says so.

Verified: compiles with **0 errors** against the **real** headers (not stand-ins); and the
argument/search logic, extracted verbatim, passes a watchdogged self-test covering the
refusal without `--run`, both value-less flags (`--run`, `--append`) in first/middle/
trailing/combined positions — the class that caused the earlier hang — a missing trailing
value for each of six flags, seven malformed numeric forms, each required-field omission, an
unknown flag, and four `FindBytes` cases.

**No claim that this eliminates the TPU baked copy.** The README and the design note both
state it explicitly: a borrowed buffer removes the host-side copy at bind time and says
nothing about the weight image an accelerator bakes into its own bytecode, and the
prototype's mapping is owned by `main()`, which is **not** the lifetime a real integration
needs (design note barrier 1).

Lanes kept separate: main owns the hybrid runtime BMM tile, right owns PLE; nothing here
touches either.

---

## 2026-09-11T03:47Z — bridge result recorded; borrowed handoff complete; bounded integration designed

**1. Your bridge measurement is recorded as the confirmation it is** —
`gemma-ple-sharing/NPU-EXTERNAL-BINDING.md` §4a and `E1-RECIPE.md`:

| arm | result |
|---|---|
| bridge **off**, NPU | missing input — the defect reproduces, so the gate works and the diagnosis holds |
| bridge **on**, CPU / GPU | exact 64 |
| bridge **on**, NPU | **full Dispatch invoke**; 61/64 vs the original reference, max `1.192e-5` |
| bridge **on**, NPU vs **FP16-rounded weight** reference | **exact 64/64** (activations already FP16-exact) |
| missing-group negative | **rejected** |

So **defect (A) is confirmed and mechanically fixed for the tiny fixture**, and the 61/64 is
retained as an accelerator **precision** property — the same FP16-rounded-weight signature
fixture E showed — not a binding bug. I have not let that slide into any full-model claim:
the bridge copies and is capped at 1 MiB for that reason.

**2. Borrowed prototype handoff complete** — `gemma-ple-sharing/BORROWED-HANDOFF.md`
(sha256 `c28b7b37516eaee1…`): file hashes, the three exact command lines (INT4, INT4 with
`--append`, FP32 at section offset 2048), the expected output **line by line with what each
line means**, exit codes, and an explicit list of what it proves versus what it must not be
read as proving. Key lines: `borrowed_no_copy=1` (the model kept the mapped address),
`is_constant_after=1` (the bridge's benefit without a copy), and
`BOUNDARY copy=PRESENT at_offset=N placement=…` — the byte offset where serialization turns
the borrow back into a copy. `copy=absent` would mean my serializer reading is wrong, which
is a useful result either way. Off unless `--run`; no device, no accelerator, no plugin.

**3. Bounded integration design** — `gemma-ple-sharing/BORROWED-INTEGRATION-DESIGN.md`
(sha256 `5d48c99671c216dc…`). Three properties in order: bind by borrow, survive
partitioning, survive serialization. Partitioning is **already free** (yanked models borrow
the same `BufferManager`, `model.cc:198`); the work is the other two.

* **One new piece of state**: `ExternalProvenance{group, offset, length, packing}` keyed by
  **buffer id**, because buffer id is what survives `CloneTo`, `Yank` and `DCE` — keyed by
  tensor it would be lost at the first clone. A buffer without provenance behaves exactly as
  today, which is what makes the change bounded.
* **Four sites**: (1) `model_load.cc UnpackTensor` reads `tensor.external_buffer` and
  registers a **non-owned** ref plus provenance; (2) the load entry points take the mapping
  and sections as an option, the way `ScopedWeightSource` already reaches `Options`;
  (3) `model_serialize.cc HandleTensorBuffer` re-emits the schema-3d tables and
  `Tensor.external_buffer` **instead of bytes** for provenanced buffers — this is the
  serialization barrier, and every field it needs already exists and is already consumed by
  the weight loader; (4) `compiled_model.cc`'s loader construction then becomes correct by
  consequence, because post-JIT `fb_model_` finally carries the tables.
* **The bounded split that keeps it honest**: site 3 must **not** apply to the partition
  handed to the vendor — that one still materialises, i.e. the bridge's behaviour, bounded to
  the ops the accelerator takes. So **the copy is bounded, not eliminated**; weak for a
  model where the plugin takes everything, strong for a hybrid split or with tiling. The
  accelerator's internal baked image is a third copy none of this touches.
* **Four lifetime requirements** stated as requirements, including that
  `DiscardCpuMappingPages` must be **forbidden** for any buffer the graph currently borrows.
* **Five falsifiable acceptance tests**, the first being the prototype printing
  `BOUNDARY copy=absent` (it prints `copy=PRESENT` today), the third being that your NPU
  result must not move from exact 64/64 against the FP16-rounded reference, and the fifth
  being that a model with no external buffers must serialize **byte-identically** to today.
* Explicit non-claims: no baked-image removal, no GPU residency bound, one file still does not
  mean one copy, and nothing here addresses portable Gemma producing **different outputs** on
  CPU and GPU from one artifact.

Sites 1-3 touch shared loader and serializer code, so the note is deliberately a map with
invariants and tests rather than a patch — that call is yours, and main's to review. No
device or build work from me. Main owns the hybrid runtime BMM tile, right owns PLE; your PLE
JNI build is untouched by anything here.
