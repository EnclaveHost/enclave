# Shield RAM qualification — October 28, 2026

Status: source candidate and bounded CPU qualification only. No production release, GPU/SNP performance claim, reservation reduction, wallet spend or security-policy change. Claude Code on the user-selected Max account authored the candidate; root reviewed, ported and tested it.

## Packed pad rings

Opt-in `SHIELDED_POOL_PACK24=1` stores the exact existing r residues and balanced u values in three bytes rather than four. Default remains int32. The field, PRG, one-use ownership, verification, spill encryption and failure behavior are retained. Invalid representations retire the link. Additional per-link unpack scratch is included in allocation diagnostics. The 25% saving concerns ring allocation only; whole-guest savings are not measured.

The patch is against padgov `4c716378a`, preserving its spare-CPU spill governor. The initial implementation used sdshield `aa3b780ae`; it must not replace the current Qwen backend wholesale. Port used zero-fuzz application for all functional hunks; one include hunk was manually resolved to retain shielded-spill-cpu.h. Exact correspondence of this source commit with deployed backend binary still needs reproducible build evidence.

## Completed checks

- All 2^24 byte representations, signed/unsigned boundaries, invalid rows, poison, overflow helpers and unaligned tails pass ASan/UBSan. Service peak 75.1 MiB, zero swap.
- Current-source field, encrypted spill, dealt and spill-governor unit tests pass. Build/benchmark service peak 138.7 MiB, zero swap.
- Against a dedicated loopback CPU reference worker, packed/legacy ring products agree exactly; packed run consumed 768 pooled pads and generated 288 missing pads. Wraparound and corruption fail-closed checks pass. Encrypted spill integration passes with flag off and on; dealt worker integration passes. Test service peak 330.5 MiB, zero swap; owned worker terminated afterward. No production worker or GPU used.
- First integration attempt had invalid fixture K=67; protocol requires multiples of32. Fixed fixture to K=96 while retaining odd output widths. This was a fixture correction, not a product relaxation.
- Five-trial synthetic codec benchmark: median full pack/unpack/poison cycle 0.671–0.926 ns/value across tested shapes. This includes checksum overhead and is not model throughput. Legacy ring requires no codec, so copy32 is a reference bandwidth pass, not a performance-equivalent baseline.

## Outstanding

Independent security/concurrency review, full-model ring/scratch accounting, and adjacent baseline/candidate SNP measurements of load peak, full-context steady usage, prefill and decode are required. Aim for <=5% throughput loss initially; report actual tradeoff rather than claim a guarantee. Current-state loading audit suggests avoiding temporary block-cache growth may save more than packed rings. That separate candidate is being developed and is not included here.

Administrator controls, 18 GiB production admission floor and existing apps remain intact. Production RPC VM remains off. The new $30 session has not been identified or spent; old CLI session is ended and cannot authorize experiments.

## Reproduction

`python3 materialize.py /absolute/new/output` reconstructs pinned source and applies this patch in a fresh directory. It refuses existing destinations. Build the backend tests using `make -f qualification.mk -j1 pack24-link-selftest spill-link-selftest field-selftest spill-selftest dealt-selftest spill-cpu-selftest` in its wasm/ggml-shielded directory. Run the codec as documented in pack24-selftest.c with ASan/UBSan. Integration tests require the reconstructed shielded/worker.py in CPU mode on an unused loopback port and SHIELDED_WORKER pointing to that owned worker. spill-selftest and spill-link-selftest require a scratch directory on storage supporting O_DIRECT; never use production pad files. Apply bounded cgroup/queue controls, no swap, and always terminate the owned worker.
