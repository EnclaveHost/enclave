# The shielded field GEMM on Vulkan: the spike, measured

Status 2026-09-20: DONE. One GLSL shader (`shaders/field_gemm.comp`, 32 SPIR-V variants for
(MR, G) exactly as the CUDA template instantiations) plus `pack24.comp`, and a standalone harness
(`vkfield.cpp`) that runs the worker's own 61 self-test shape cases against the int64 host
reference and the worker's HELLO throughput probe. No vendor SDK anywhere: the harness opens the
Vulkan loader at run time, addresses every buffer by device address (no descriptor sets), and
ships SPIR-V built here with `glslc`.

## Results

| card | driver / OS | self-test (61 cases, both reply forms) | field GEMM, K = N = 4096, m = 8 | dispatch latency, 0.5B gate\|up x2 m = 1 |
|---|---|---|---|---|
| Tesla V100 (idle) | NVIDIA 580, Linux | PASS, bit-exact | **2601 G-MAC/s** (CUDA worker on the same card: 2286) | 34 us best, 39 us mean (record + submit + fence) |
| RTX 3070 (93% foreign load) | NVIDIA 580, Linux | PASS, bit-exact | 734 (CUDA under the same load: ~1100; idle CUDA 2130) | 51 us best |
| Radeon 780M (iGPU) | AMD 2.0.331, **Windows 11** | PASS, bit-exact | 173 G-MAC/s | 201 us best |

- The Vulkan kernel is 13% faster than the CUDA kernel on Volta with the same tiling; the
  reduction has exactly the CUDA shuffle count (16/31/62/93 for NV = 12/24/48/96, checked in the
  SPIR-V), and `dotPacked4x8EXT` lowers to the packed int8 dot instruction on both vendors
  (`integerDotProduct4x8BitPackedSignedAccelerated` = true on all three cards).
- The 780M number is an integrated part sharing DDR5 with the CPU: 173 G-MAC/s is ~12% of a
  V100, and it is the first AMD result for this tier on any API. HIP could not have produced it
  on this box (AMD's Windows HIP SDK does not list gfx1103).
- The 3070 row is contended (a foreign process at 93-97% the whole time) and is reported only to
  show the port runs there; its idle number is expected at or above the CUDA 2130.
- **Per-submit floor** (one pre-recorded command buffer, submit + completion, the exchange path's
  form): V100 33 us with a blocking fence, 37 us spin-polling `vkGetFenceStatus`; Radeon 780M
  198 us blocking, 186 us spinning. The 780M's ~190 us is therefore the AMD Windows driver's
  submit-to-completion latency, not the host wake-up. At the tier's ~128 blocking round trips per
  token that caps a 7B-class decode near 40 tok/s on that iGPU from latency alone (its 173 G-MAC/s
  is the tighter bound anyway); the worker should batch every op of a step into one submit, which
  the installed-graph design already does.

## What it took (the notes the port needs)

1. `%` on negative integers is undefined in GLSL; CUDA's is C's. The Garner step takes negative
   accumulators, so `crt3` uses an explicit truncating-division modulo. This was the only
   correctness bug: the first run produced wrong values on the very first shape.
2. Subgroup size is pinned to 32 through `VkPipelineShaderStageRequiredSubgroupSizeCreateInfo`
   with `REQUIRE_FULL_SUBGROUPS`; the 780M offers 32..64 and runs the kernel at 32 unchanged.
   The K loop has a subgroup-uniform trip count so every shuffle runs in converged control flow.
3. The reduction is written as literal stages (`STAGE`/`SINGLE` macros) so every array index is a
   constant after preprocessing; the loop form left `acc[]` dynamically indexed and only two
   shuffles in the SPIR-V.
4. MR and G are preprocessor constants per module rather than specialization constants: glslc
   validates dead branches against the default specialization and rejects the larger indices.
5. The node table (8 weight pointers, 8 output pointers, N, first block) rides in 220 bytes of
   push constants as `uint64_t` device addresses, the CUDA parameter-space table verbatim.
6. Windows: `NOMINMAX` before `windows.h`; MSVC builds the harness and the C field helper as-is;
   the SPIR-V files are copied over unchanged. Vulkan headers come from the Khronos repo (no SDK).

## The worker on this layer: DONE (Linux and Windows), verified through the protocol

`vkdev.{h,cpp}` implements the CUDA runtime subset `../worker-cuda/worker.cu` calls, on Vulkan;
`make shielded-worker` compiles the unmodified worker source as C++ with `-DSH_VULKAN`. On
Windows, `windows/worker-win/build-vulkan.cmd` does the same with MSVC and the existing
POSIX-over-Winsock compat header (which grew a few shims), so one Windows binary serves any
vendor's card through the driver's Vulkan loader. No CUDA toolkit anywhere in that build.

| | Tesla V100, Linux, Vulkan | Tesla V100, Linux, CUDA (reference) | Radeon 780M, Windows 11, Vulkan |
|---|---|---|---|
| startup self-test (61 shape cases) | PASS | PASS | PASS |
| field GEMM throughput (HELLO figure) | 2558 G-MAC/s | 2286 G-MAC/s | 172 G-MAC/s |
| SMs / CUs reported to the planner | 72 (`VK_NV_shader_sm_builtins`) | 80 | 12 (`VK_AMD_shader_core_properties`) |
| protocol HELLO from the Python TEE | 1.4.0, 22 ms | 1.4.0 | 1.4.0, 47 ms over the LAN |
| 3-node install + 8 masked exchanges, Freivalds-verified, vs local int64 | EXACT | EXACT | EXACT |
| per exchange, Python TEE side included | 3.9 ms | 1.9 ms | 11.8 ms (LAN) |

The exchange test (`synth_exchange.py`, 4 rounds of gate|up shared-x at m = 1 and 4 plus a down
projection) drives the legacy doorbell path: SET_TENSOR, RECOMPUTE, GET_TENSOR. Every reply
passed the TEE's Freivalds check and matched `x . w_fixed` computed locally.

**The full-model run** (`../e2e.py`, Qwen2.5-0.5B-Instruct q8 pack, 3 prompts x 16 tokens, each
prompt generated once with the GPU attached and once with the offload replaced by a local
integer matmul, the two token streams required to be identical):

| worker | identical token streams | masked exchanges | round trips | offloaded | verify failures | wire term per token |
|---|---|---|---|---|---|---|
| Tesla V100, Linux, **Vulkan** | 3 of 3 | 11492 | 6596 | 49.69 GMAC | 0 | 657 ms (first build; re-measured below) |
| Tesla V100, Linux, CUDA | 3 of 3 | 11492 | 6596 | 49.69 GMAC | 0 | 70 ms |
| Radeon 780M, **Windows 11, Vulkan, over the LAN** | 3 of 3 | 11492 | 6596 | 49.69 GMAC | 0 | 1059 ms |

Same outputs, same exchange counts, same peak |y| (2.1e6 against M/2 = 7.2e6) on all three.
The wire term is the Python TEE's per-node doorbell path, three round trips per node; on
Vulkan each of those is a submit plus a fence wait (and, in the first build, a fresh staging
buffer per pageable copy, since replaced by a cache). The engine's one-frame exchange, the
production path, batches a whole step into one pre-recorded command buffer and one submit, so
the doorbell figure is a bound on the legacy path, not on decode. The three runs overlapped on
one CPU, so the TEE-side terms (refill, mask, verify) are not comparable between rows.

What the device layer does differently, and what it does not do yet:
- Device pointers are buffer device addresses; the pool is an arena of 64 MiB-minimum blocks,
  so `claim_reservation()`'s hold-then-free trick reserves real VRAM as before.
- A stream is a lazily submitted command buffer; the captured exchange graph is one pre-recorded
  command buffer replayed per step. The legacy per-node doorbell pays one submit + fence per
  node (~35 us on NVIDIA, ~190 us on the AMD Windows driver), which is where the 3.9 vs 1.9 ms
  above comes from; the engine's one-frame exchange batches a whole step per submit.
- `cudaMemGetInfo` is `VK_EXT_memory_budget`. `card_tflops` cannot be derived (no clock in the
  API): `SHIELDED_CARD_TFLOPS` states it.
- The shm ring (`--shm`) is not available on Windows (the compat `mmap` refuses it); vsock is
  AF_HYPERV there, untested. MPS has no equivalent yet; `VK_EXT_global_priority` is the plan.

## Next

`../worker-cuda/worker.cu` keeps its protocol, admission rules, graph install and VRAM ledger;
its ~60 CUDA runtime call sites become a Vulkan device layer: streams -> a queue plus command
buffers, stream-captured graphs -> one pre-recorded command buffer per installed graph (submit per
step), external events -> timestamp queries, `cudaMallocAsync`/pools -> explicit device memory
with `VK_EXT_memory_budget` for the free figure, mapped host memory -> host-visible allocations,
MPS -> `VK_EXT_global_priority` low priority for the rented queue. Sockets and `mmap` stay POSIX
on Linux and gain a Winsock path for the Windows node.

Build and run:
```
make                      # 33 SPIR-V modules + vkfield (needs glslc, spirv-val, the Vulkan headers)
./vkfield --device 0      # --cus N sets the planner's block threshold (SM/CU count), --no-selftest, --iters N
```
