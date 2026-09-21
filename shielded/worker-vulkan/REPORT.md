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

## Next: the worker on this layer

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
