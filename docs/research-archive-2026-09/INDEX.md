# Research archive — September 2026

Curated notes and evidence rescued from the Codex scratch trees
(`~/Documents/Codex/2026-09-04` and `2026-09-07`) before those working
directories were deleted on 2026-09-15. The bulk of what lived there was
regenerable build output; what follows is the part that was not.

Everything here is a **record of measurements as they were taken**, not a
current statement of how the platform behaves. Dates are given on each
claim. Where a note says a change was "not retained", it means exactly
that — the option exists in the code but is off.

## shielded-27b/ — the 27B phone-anchor speed campaign

The central effort: driving Qwen3.8-27B Q8 through metal0's shielded GPU
with a Pixel 8 Pro protected VM (pKVM) as the trusted half, with no host
TEE. Target was 20 tok/s with verification and live pad replenishment.

**The target was not met.** Best retained result is **0.92 tok/s steady /
0.66 overall**. A complete run does now fit inside the ten-minute test
cycle, which it previously did not.

Start with:

- `implemented-improvements.md` — the master table. Every change made
  during the campaign, what it changed, and the evidence or limit for
  each. Explicitly separates "implemented" from "measured gain"; most
  entries are the former.
- `27b-shielded-progress.md` — running status of the 20 tok/s target.
- `27b-whole-process-profile.md` — the decisive diagnostic: the V100's
  graph work took **~0.38 s** per trial while total decoding took
  **17.15 s and 34.08 s**. The delay is on the phone-facing path, not
  the GPU.

The bottleneck, traced across several notes:

- `27b-receive-operations-v46.md`, `-v46-first-postmortem.md`, `-v47.md`
  — **95–96% of receive time is inside `poll()`** waiting for socket
  readability. `recv()` is 2–3.5%. Repeatedly reconfirmed; never fixed.
- `27b-pad-delivery-profile.md` — a concrete 13.72 s pad-delivery stall,
  corroborated by an independent pad-wait counter.
- `27b-poll-delay-v48.md`, `27b-pad-write-cap-v49.md`,
  `27b-pad64-same-apk-comparison.md` — attempts at the poll delay. None
  established a throughput gain.

Why the target may be unreachable in this shape — worth reading before
anyone retries:

- `27b-byte-budget.md` — 20 tok/s needs **≥888.2 MB/s into the phone**.
  The Pixel 8 Pro's USB link reports 5,000 Mb/s, a raw ceiling of
  625 MB/s before overhead. **Sustained 20 tok/s does not fit this
  workload, format and path unchanged.**
- `27b-transport-budget.md` — 8.601 MB sent and 17.732 MB received per
  generated token.
- `27b-operation-traffic-profile.md` — the calibrated dimensions account
  for every byte of all 1,574 field exchanges. FFN gate/up dominate
  reply volume; FFN down dominates request volume (50.6%).

Dealer and pad-refill work:

- `cpu-refill-crt-dealer.md` — the one clear win in this group: median
  64-row shipment time **3.052 s → 2.211 s (27.6%)** on the real model,
  six balanced pairs.
- `cpu-refill-kernel.md`, `-crt.md`, `-slab.md`, `-reduce-tree.md` —
  kernel sweeps. The slab note concludes **keep the existing 2,048
  element slab**; the reduce-tree candidate stayed a scratch experiment.

V100 kernel and two-card work is in `v100-*.md`;
`shielded-two-tier-design.md` and `masked-correction-proposal.md` are
designs for review, neither implemented nor audited.

## pixel/ — on-device model and accelerator comparisons

Pixel 8 MNN/OpenCL and TPU measurements: `pixel8-model-format-comparison.md`,
`pixel8-mnn-kernel-profile.md`, `pixel8-tpu-*.md`,
`pixel8-qwen08-tpu-baseline.md`. Diagnostic device durations, not
production throughput.

## platform/ — metal0 and RISC Box

- `metal0-gpu-pool.md` — pooled GPU verification (`281e02bf`, plus
  capability-probe correction `bcfff6f1`).
- `metal0-v100-setup.md` — **superseded** by the pooled deployment on
  2026-09-05; its separate-card pricing is historical.
- `risc-box-0.6.54-upload-notes.md`, `risc-box-restart-checkpoint.md`.

## logs/ — the narrative record

- `current-state.md` — Claude's append-only measurement log, newest at
  the bottom. The primary source for how each number above was reached.
- `COORDINATION.md` — the message channel between Claude (Fable 5.1) and
  GPT-5 Astra during the coordinated phase, ~12k lines. Roles were set by
  Steven on 2026-09-08: Astra coordinated, Claude did the measurement.
- `ACTIVE-SPEED-TASK.md` — rolling checkpoints for the Pixel 10 on-device
  lane. Final standings recorded there: **NPU 25.2 > CPU 23 > GPU 20.5
  tok/s**. Its later entries point into
  `Codex/2026-09-07/i-w/work/opus-gui-rope-adapter-fix-1/RESULTS.md`,
  which was **left in place** because that work is still live.
- `litertlm-source-build-HANDOFF.md` — the offline LiteRT-LM source-build
  route: one file to replace, one command to confirm.

## evidence/ — machine-readable receipts

87 JSON files under 200 KB backing the claims above. Large profile dumps
(multi-MB `*-profile.json`) were not kept.

## What was deliberately not archived

- `tensor-sdk/` and `opus-gui-rope-adapter-fix-1/` — still active work,
  left in place in the Codex tree.
- One-time pad shipments (`local-hub-data/`, `dealt-e2e/bank-pixel/`) —
  left in place; pads cannot be regenerated once a device holds the
  matching copy.
- Bazel/LLVM/JDK vendored docs, build trees, and `.litertlm` model
  variants — all regenerable.
