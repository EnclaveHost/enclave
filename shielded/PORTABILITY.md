# The shielded worker on NVIDIA, AMD and Intel: what is verified, what is chosen

Status 2026-09-20. Requirement: the shielded worker (the untrusted GPU half, `worker-cuda/worker.cu`)
must run on NVIDIA CUDA, AMD ROCm and Intel oneAPI. Two routes were examined, one of them built
as far as it can be without AMD or Intel hardware. Everything below is measured or compiled unless
it says "reported".

## 1. What the worker asks of a GPU

Two integer kernels and a socket protocol. The device surface is small and exact:

| need | CUDA today | notes |
|---|---|---|
| signed int8x4 dot, int32 accumulate, wrapping | `__dp4a` (12 sites) | the whole field GEMM; accumulators stay < 2^31 by construction, so saturation would be a bug |
| 32-lane xor shuffles, masks 1..16 | `__shfl_xor_sync` | the fused reduction of up to 96 partial sums per warp |
| 16-byte vector loads, 256-thread blocks, static shared memory | `int4`, `__ldg`, `__shared__` | |
| launch bound of 2 blocks per SM for m <= 4 | `__launch_bounds__(256, 2)` | tuning only |
| stream-captured graph replayed per step, external timestamp events | `cudaGraph*`, `cudaEventRecordExternal` | 42.5 vs 45.0 us per exchange measured |
| stream-ordered allocator + pool trims = the per-tenant VRAM ledger | `cudaMallocAsync`, `cudaMemPool*` | the fleet's "free" figure depends on it |
| mapped host memory for the reply | `cudaHostAllocMapped` | |

The field arithmetic is integer, so a correct port is bit-exact; the worker's startup self-test
(`selftest()`, eight shapes against a host reference) is the acceptance test on any card.

## 2. Route A: one source, per-vendor compilers (BUILT for CUDA + HIP)

`worker-cuda/device.h` maps the runtime symbols and shims the three intrinsics; the same
`worker.cu` compiles as CUDA (clang, unchanged output) or HIP (`hipcc -x hip`).

- **CUDA**: rebuilt on the RTX 3070 with a root-free toolkit; self-test passes; masked-path
  throughput equal to the previous binary (2130 G-MAC/s idle, ~1100 under a 96% foreign load, both
  binaries).
- **HIP**: compiles for gfx1103 (Radeon 780M, wave32, 8832 `v_dot4_i32_iu8` in the assembly),
  gfx942 (MI300, `v_dot4` + width-32 `ds_bpermute` shuffles) and gfx1100 (RX 7900); links against
  the ROCm 10.2 runtime; starts and exits cleanly on a box with no AMD GPU. **Not yet run on AMD
  hardware.** The 780M in the mini PC runs Windows, where the HIP SDK does not list gfx1103 and
  has no override, so it is not the AMD test target for this route; a Linux RDNA3/CDNA card is.
- **Intel**: HIP does not reach Intel. SYCL (oneAPI DPC++) would be a second kernel source behind
  the same host code. The open-source DPC++ nightly with its CUDA adapter was verified to run SYCL
  on the 3070 here, so SYCL kernels could be tested without Intel hardware; but Codeplay's binary
  NVIDIA/AMD backends are Linux-only and ended at oneAPI 2025.2, and `dot_acc` is plain scalar code
  the backend may or may not lower to dp4a. Not built.

Route A therefore ends at two vendors on Linux, three sources, three toolchains, and no Windows
story for AMD consumer parts.

## 3. Route B: one implementation, Vulkan compute (RECOMMENDED, not yet built)

Vulkan is the one API every vendor ships on every OS this tier targets, including Windows gaming
PCs, with no vendor SDK on the host. Capability check on the hardware in hand:

| | RTX 3070 (Linux, 580) | Radeon 780M (Windows, AMD 2.0.331) |
|---|---|---|
| Vulkan | 1.4.312 | 1.3.302 |
| `integerDotProduct4x8BitPackedSignedAccelerated` | true | true |
| subgroup size | 32 | 32..64, `VK_EXT_subgroup_size_control` |
| `VK_EXT_global_priority` (yield to the game) | yes | yes |
| `VK_EXT_memory_budget` | yes | yes |

Mapping: dp4a -> `GL_EXT_integer_dot_product` (`dotPacked4x8EXT`, Vulkan 1.3 core); shuffles ->
`subgroupShuffleXor` with the subgroup size pinned to 32 where the driver offers it, 64-wide
reductions otherwise (a specialization constant); graph replay -> one pre-recorded command buffer per
(m, node list), submitted per step; external events -> timestamp queries; pools and the VRAM ledger
-> explicit `vkAllocateMemory` with `VK_EXT_memory_budget`; mapped reply -> host-visible memory;
MPS -> queue global priority. Intel Arc/Xe reports the same dot-product acceleration (reported, no
card here). Kernels: GLSL compiled to SPIR-V at build time (`glslc` is installed). The socket
protocol and the admission rules do not change.

Plan if chosen: (1) spike the field GEMM in GLSL with a standalone harness running the self-test
shapes on the 3070 and on the 780M, throughput against the 2130 G-MAC/s baseline; (2) the Vulkan
device layer behind `worker.cu`'s host code; (3) one binary per OS. Route A's `device.h` stays as
the native fallback for Linux datacenter cards.

## 4. Toolchains without root (all verified here)

CUDA 12.6 from pip wheels plus NVIDIA's conda `cuda-nvcc-tools` for `fatbinary`; ROCm 10.2 from
AMD's TheRock wheels (`pip install --index-url https://nightly.repo.amd.com/rocm/whl-next/
"rocm[libraries,devel,device-gfx1103]"`, then `rocm-sdk init`), which compiles for any gfx target
with no AMD GPU present; DPC++ from the intel/llvm nightly tarball with its CUDA adapter.
