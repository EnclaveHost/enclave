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
| Tesla V100, Linux, **Vulkan** | 3 of 3 | 11492 | 6596 | 49.69 GMAC | 0 | 657 ms first build; **54 ms** with the staging cache |
| Tesla V100, Linux, CUDA | 3 of 3 | 11492 | 6596 | 49.69 GMAC | 0 | 70 ms |
| Radeon 780M, **Windows 11, Vulkan, over the LAN** | 3 of 3 | 11492 | 6596 | 49.69 GMAC | 0 | 1059 ms |

Same outputs, same exchange counts, same peak |y| (2.1e6 against M/2 = 7.2e6) on all three.
The wire term is the Python TEE's per-node doorbell path, three round trips per node; on
Vulkan each of those is a submit plus a fence wait. The first build also created a fresh
staging buffer per pageable copy, which is where its 657 ms went; with a cache of staging
buffers the same run measures 54 ms per token against CUDA's 70, and the worker's own GEMM
time over the run fell from 1415 ms to 441 ms (CUDA: 311 ms). The engine's one-frame exchange,
the production path, batches a whole step into one pre-recorded command buffer and one submit.
The three first runs overlapped on one CPU, so their TEE-side terms are not comparable.

What the device layer does differently, and what it does not do yet:
- Device pointers are buffer device addresses; the pool is an arena of 64 MiB-minimum blocks,
  so `claim_reservation()`'s hold-then-free trick reserves real VRAM as before.
- A stream is a lazily submitted command buffer; the captured exchange graph is one pre-recorded
  command buffer replayed per step. The legacy per-node doorbell pays one submit + fence per
  node (~35 us on NVIDIA, ~190 us on the AMD Windows driver), which is where the 3.9 vs 1.9 ms
  above comes from; the engine's one-frame exchange batches a whole step per submit.
- `cudaMemGetInfo` is `VK_EXT_memory_budget`. `card_tflops` cannot be derived (no clock in the
  API): `SHIELDED_CARD_TFLOPS` states it. `SHIELDED_VK_PRIORITY=low|medium|high|realtime|none` sets
  the rented queue's global priority (low by default; see the queue-priority section).
- The shm ring (`--shm`) is not available on Windows (the compat `mmap` refuses it); vsock is
  AF_HYPERV there, untested. MPS has no equivalent; queue priority is wired and measured inert (below).

## The share a tenant pays for: enforced on the worker's GPU turn (both vendors)

MPS gave a fixed SM slice per client, Linux-only and CUDA-only, and could neither let a tenant
burst into an idle neighbour's slice nor guarantee time. The worker now enforces the share as a
share of the card's TIME at the one point every exchange passes: the GPU mutex. A start-time fair
queue (`GpuScheduler` in `worker.cu`) orders waiting links by virtual time = card-seconds held /
share, lifts a link that joins after idling to the running tenant's virtual time (idle earns no
credit, a solo burst leaves no debt), and hands the card outright to a lone waiter. The share is
the link's HELLO reservation over the budget (`SHIELDED_SHARE_DEFAULT` for a 4-byte HELLO);
the metered turn covers the kernel and both copies of the legacy doorbell path (the one-frame
exchange is a single turn already). `SHIELDED_FAIR_SHARE=0` restores plain mutex order.

`fair_share_test.py`: tenant A reserves 75% of the budget, B 25%, four links each, one process per
link, raw exchange frames (0.54 G-MAC each) as fast as the worker answers; then each tenant alone.
Exchange rates from the clients, card time and waiting from the worker's own close log:

| | A : B contending | on the card, A : B | waiting per turn, A : B | A alone | B alone | A+B vs solo |
|---|---|---|---|---|---|---|
| CUDA worker, Tesla V100 | 2392/s : 812/s = **2.95 : 1** | 13.8 s : 4.9 s | 0.25 ms : 0.90 ms | 3240/s | 3220/s | 3204/s vs 3240/s |
| Vulkan worker, Tesla V100 | 1580/s : 520/s = **3.04 : 1** | 14.1 s : 4.8 s | 0.39 ms : 1.42 ms | 2248/s | 1607/s | 2100/s vs 2248/s |

The contended split is the paid share to within 2%, the sum under contention equals one tenant's
solo rate (the card is saturated and nothing is wasted), and a tenant alone gets the whole card:
the burst into unused capacity. The B-alone Vulkan row was measured while another process was
using that card. What this does not do: fence Enclave's tenants from the host's own use (queue
priority, wired and measured inert in the next section) or limit memory (the reservation ledger does).

A false alarm on the way: reservations were refused at ~3.6 GiB on a 32 GiB card during the
first attempts. `VKFIELD_ALLOC_PROBE=1 ./vkfield` shows one Vulkan process can hold 31.2 GiB on
that card; the missing memory was another process's reservation on it at the time.

Bugs found on the way, all fixed: the Vulkan shim's arena recovered a freed allocation's length
from its neighbours and freed live memory once tenants churned; the shim's immediate stream and
maps were shared across connection threads without a lock (SIGSEGV in the NVIDIA driver with
eight links); SET_TENSOR held the GPU mutex before taking the turn (self-deadlock).

## Queue priority: wired on the rented queue, measured inert against the owner's application

The plan was `VK_EXT_global_priority` LOW on the worker's queue so the node owner's own game
wins the card when they contend, the MPS replacement for background mode. It is wired:
`vkdev.cpp` creates the queue through `VK_KHR_global_priority` (else the EXT) at LOW by default,
`SHIELDED_VK_PRIORITY=low|medium|high|realtime|none` overrides, a refused priority falls back
to the default queue with a log line instead of a failed start, and startup logs what it got
(`queue family 2 at global priority low (family offers medium)`). The harness gained the probes:
`--priority`, `--gpu-class` (Windows: the process's WDDM scheduling priority class through
`D3DKMTSetProcessSchedulingPriorityClass`), `--gfx-queue`, `--flood SEC` (the worker: 16-launch
command buffers back to back, rate per second) and `--frames SEC --frame-us US --fps N` (the
owner's game: a fixed amount of GPU work per frame, paced, frame GPU time from submit to fence).

What the drivers in hand say when asked:

| | NVIDIA 580.178 Linux (3070, V100, PG500-216) | AMD 32.0.13031 Windows (Radeon 780M) |
|---|---|---|
| query (`VkQueueFamilyGlobalPriorityProperties`) | medium only, every family | compute family low,medium,high; graphics family low,medium |
| low | accepted | accepted |
| high, realtime | `VK_ERROR_NOT_PERMITTED` (privilege) | accepted, realtime too though unlisted |
| WDDM scheduling class idle/below-normal | n/a | accepted (class 2 -> 0 / 1) |

What they do. The game stand-in on the graphics family at 60 fps against the flood on the
compute family (as the worker runs), two processes; frame GPU time is the mean over 12 s and the
flood's rate is its own count. Two runs where given, the scatter is real:

| card | game alone | + flood default | + flood LOW | + flood no priority | flood rate |
|---|---|---|---|---|---|
| Tesla V100 (5.8 ms of work per frame) | 5.7-6.1 ms | 9.2, 10.7 ms | 10.5, 11.0 ms | 10.4, 11.2 ms | 1400-1720 G-MAC/s (2537 alone) |
| RTX 3070 (5.9 ms per frame) | 6.2 ms | 8.2 ms | 8.9 ms | | 1237-1409 |
| Radeon 780M (6.9 ms per frame) | 16.3-16.5 ms | 25.5 ms | 25.9 ms | | 446 (446 alone) |

More on the 780M, same game on the graphics family: flood at REALTIME 25.6 ms; flood at WDDM
class idle 25.5, below-normal 25.3, idle + low 25.4; the flood kept its full solo rate in every
one. With the game moved to the compute family (17.2 ms alone): flood default 12.2 ms (flood 357),
LOW 12.2 (358), REALTIME 12.2 (358), WDDM idle 10.2 (322), and HIGH 25.7 with the flood back at
445. (The 780M's paced baseline sits above its 6.9 ms calibration because the integrated GPU drops
its clock between paced frames; with the flood keeping the clock up the compute-family game
runs faster than alone.)

Reading: NVIDIA time-slices the two contexts equally whatever the flag says, and LOW costs the
worker nothing either (the LOW/default differences are within the run-to-run scatter). The AMD
Windows driver runs the graphics and compute pipes concurrently and no priority or scheduling
class arbitrates the compute units between them; it honours HIGH only between compute queues,
which is the reverse of what a consumer node needs. So on every card in hand the driver cannot
make the worker yield to the owner's application. The default stays LOW: free, and the right
request on a driver that does honour it (Linux amdgpu/RADV honours context priority in the
kernel scheduler; no card here to measure).

The mechanism that would work is the worker's own submission policy, vendor-neutral: a duty
cycle on its GPU turns while the owner is active. The fair scheduler already meters every turn;
sleeping (1-d)/d of the held time before the next turn caps the worker's occupancy at d, and the
owner's frames then lose at most one turn's length. Detection: a turn's held time against the
best seen for that installed graph (any OS; every turn holds the card alone from the worker's
side, so inflation is external), and on Windows the shell's fullscreen state
(`SHQueryUserNotificationState`). Not built; it is a policy (d, hysteresis) to decide first.

## Next

`../worker-cuda/worker.cu` keeps its protocol, admission rules, graph install and VRAM ledger;
its ~60 CUDA runtime call sites become a Vulkan device layer: streams -> a queue plus command
buffers, stream-captured graphs -> one pre-recorded command buffer per installed graph (submit per
step), external events -> timestamp queries, `cudaMallocAsync`/pools -> explicit device memory
with `VK_EXT_memory_budget` for the free figure, mapped host memory -> host-visible allocations,
MPS -> `VK_EXT_global_priority` low priority for the rented queue (wired; measured inert, see
above). Sockets and `mmap` stay POSIX
on Linux and gain a Winsock path for the Windows node.

Build and run:
```
make                      # 33 SPIR-V modules + vkfield (needs glslc, spirv-val, the Vulkan headers)
./vkfield --device 0      # --cus N sets the planner's block threshold (SM/CU count), --no-selftest, --iters N
```
