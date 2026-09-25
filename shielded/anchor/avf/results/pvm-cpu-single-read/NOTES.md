# Single-read model load: tried, refused by its own check, backed out (Pixel 10, 2026-09-23 21:28, build rt6 `76b02383…`)

The idea (results/pvm-cpu-p5: the load's second read of the model through the encrypted store was 36.8 of 59.5 s): the stage
keeps the bytes it judged in a private anonymous mapping and the engine builds the tensors from them, releasing each
tensor's pages once placed. The diff that ran is attempt.patch.txt (not in the tree; a record, trailing whitespace stripped, so not for `git apply`).

What sr-01 shows (one short local run, same conditions as results/pvm-cpu-d4default):
- **The load refused itself, correctly**: `LOCAL refused: token_embd.weight: bytes in the staged model differ from its digest
  at stage time`. Gemma's tied embedding is two tensors in llama's map built from ONE file range; the first placement
  released that range's pages, so the second read zeros and the per-tensor hash caught it. Nothing ran on bad bytes.
- **The stage got slower**: 46.5 s against 18.3 s (pvm-cpu-p5). Writing 3.2 GiB into fresh anonymous memory in a protected
  VM pays a first touch per page (stage-2) on top of the page cache the read already fills; that cost exceeds the second
  read it was meant to save.

So the attempt was backed out (the tree keeps the two-read load). The better shape, not built: keep the stage's page cache
(no drop-behind during the stage when the model is well under the VM's memory) so the loader's second read is served from
memory already populated, with the per-tensor hash kept -- and count uses per file range if anything is ever released early.

The run's VM restarted afterwards (the supervised restart treats a refused load like any interrupted run, bounded at 2);
the lane driver recorded FAIL. Logs normalized after capture (trailing spaces only).
