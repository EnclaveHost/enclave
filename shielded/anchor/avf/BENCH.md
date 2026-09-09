# In-session repeat trials (ANCHOR_BENCH_TRIALS) - minimum viable design + record format v1 (rev 2, after review)

Goal: one pVM start-up, then several decode trials from the SAME trusted in-RAM prompt state, each reported with exact
numerators/denominators, so repeated measurements of one setting cost one start-up. SOURCE-ONLY today. It does not by
itself make a 27B session fit the 600 s cap: the 27B start-up is ~33 min measured (ping-3: stage 449 s + loader 32 s +
prefill 1503.6 s, the latter already INCLUDING registration and upload) and there is NO first-start exception to the
cap, so the first use is the 0.8B (start-up ~2-3 min); the 27B waits for the cold set-up work. Default (unset, 0 or 1)
= today's single decode, byte-for-byte, including its timing and receipts.

## What is snapshotted (after prefill AND after the head observed the prompt), and what is not
- target context: `llama_state_seq_get_data(ctx, seq 0)` = KV cells of the attention layers + the recurrent (SSM) states
  for seq 0 (the hybrid memory serialises both); restore = `llama_state_seq_set_data` (llama's state_read does
  `seq_rm(seq, -1, -1)` first for both the KV cache and the recurrent memory, so no explicit clear is needed);
- MTP head context: `anchor_mtp_state_export/import` (the head's own seq-0 state) + `anchor_mtp_pending_export/import`
  (the harvested hidden row the next draft starts from; import clears the tail and harvested-row bookkeeping);
- the first token (`cur` = argmax of the prefill logits) and `n_past`; loop-level bookkeeping (draft-ahead pre-draft,
  MTP counters, steady-state clocks, output text) is reset per trial.
- NOT restored, ever: pad reservations, spent pad indices, the session seed, receipts, verification counters, the link.
  Each trial consumes fresh pads exactly like a fresh decode; the dealer must keep replenishing; verify_fail and pad
  counters are cumulative and are REPORTED before/after each trial, never reset.
Restoration completeness (target/head hidden state), from the source: the fork's hybrid memory serialises the attention
KV cells and the recurrent states of seq 0 (state_write: mem_attn + mem_recr; the recurrent writer resolves "the logical
current state may live in a rollback snapshot plane"), the head's only extra state is its pending row, logits are
recomputed from the restored state, and the n_rs_seq rollback planes are rebuilt by the next decode exactly as after a
fresh prefill. Draft-ahead's pre-draft is deliberately dropped (a trial starts as the original run did). Identical
greedy completion AND identical MTP counts across trials are NECESSARY evidence, not a complete-state proof: keep the
host fixtures and the device runs, and read 0.8B and 27B results separately (different layer mix, k, placement).
Memory: target state = KV(n_past tokens) + recurrent state per SSM layer + conv state; for the 5-token prompt it is
dominated by the recurrent states (48 layers x n_embd_s floats); the exact size is printed in the session record and
bounded to 1 GiB total (target + head + pending), refused loudly above it. With a 3k-token prefix-KV it grows by
~70 KB/token (memory note), still under the bound.

## Record format v1 (contract, aligned with Astra's bench_records.py; one JSON object per line after the literal prefix `BENCH v1 `)
  session : {"record":"session","trials":N,"model_sha256":"64hex","calib_digest":"64hex","snapshot_bytes":{"target":T,"head":H,
             "pending":P},"snapshot_ms":f,"prompt_observe_us":u,"n_past":i,"first_token":i,"prompt_tokens":n,"prefill_ms":f,
             "mtp_requested_k":k,"mtp_fallback":"...","counters_available":{"stats":bool,"pads":bool},
             "settings":{"n_predict":i,"mtp_k":<effective k, 0 when the head is off/fell back>,"draft_ahead":0|1,"threads":i,
             "threads_batch":i,"head_threads":i,"cpu_poll":"<env|unset>","arm_tuned":"<env|unset>","stream_min_bytes":"<env|unset>"},
             "not_restored":"pads,seed,spent indices,receipts,verification state"}
  begin   : {"record":"begin","trial":i,"restore_us":u,"counters_before":C}          (restore_us = 0 for trial 1)
  result  : {"record":"result","trial":i,"status":"budget|eos|decode_failed|rollback_refused","mtp_fallback":"...",
             "generated":g,"decode_us":u,"decode_tokens":g,"steady_us":u,"steady_tokens":s,
             "mtp":{"rounds":r,"drafted":d,"accepted":a,"emitted":e},"text_sha256":"64hex","completion":"escaped","counters_after":C}
  end     : {"record":"end","trials":N,"completed":M,"reason":"complete|restore_failed|head_lost|trial_failed|text_mismatch|
             mtp_mismatch|incomplete","identical_text":bool,"identical_mtp":bool,"generated_total":G,"any_failed":bool}
  C = {"offloaded_nodes":u,"local_nodes":u,"macs":u,"gmac":f,"verify_fail":u,"pads_used":u,"pads_missed":u}  (one flat object,
      cumulative since process start, never reset) or the JSON literal null when either counter source is unavailable -
      never zeroes; the parser also requires counters_available == {stats:true,pads:true}.
Clocks: every trial's decode clock starts AFTER its begin record and counters (trial 1 included); the one-time set-up
(prompt observe, snapshot) is reported in the session record, not in any trial. Rates are the parser's: whole =
decode_tokens / decode_us; steady = steady_tokens / steady_us where steady starts when the loop first iterates with more
than one generated token, i.e. after the first round/window, exactly as the single-run result defines it.
The link's own counters ("wire phases: calls=...") bracket each trial in engine.err between `[shielded] snapshot
begin/end: phase=trial<i>.before|after` (the ba9100a2 markers; the phase names are deliberately NOT prefill/decode so
counter_snapshots.py rejects a bench log). The single-run `{"engine":"avf-pvm",...}` line is NOT emitted in bench mode,
so phone_evidence() rejects it too. Terminal failures (exit 3, end.failed=true, end.reason says which): a trial that
fails, a restore failure, a lost head, a text or MTP-count mismatch against trial 1, fewer completed trials than
requested. `TOKEN` lines and the per-round MTP profile lines are emitted per trial as today.

## What can vary per trial later (not in this prototype: identical settings only)
  safe, loop-level: n_predict, mtp_k, draft_ahead, p_min (variables of the decode loop) | pool poll/threads: re-create the
  pools between trials (llama_attach_threadpool while no graph runs) | SHIELDED_ARM_TUNED: needs a dev-only
  sh_simd re-selection (chosen table is static; the tables are numerically identical by the agree gate) - a small
  shielded-tee.c addition, then one session could run the ARM pair | NOT per trial: anything decided at load
  (placement, stream floor, calibration, weights, worker link, protocol).
Operator-driven trials (`TRIAL <label> [k=..] [ahead=..] [n=..]` on the control channel instead of a fixed count) are the
next step: the payload owns the control reader, so it needs a line callback into the engine (design only).

## Cold set-up and the 600 s cap (measured phases; nothing here is built; no projection)
  ping-3 measured: stage 449 s, loader 32 s, prefill 1503.6 s (= registration + upload + first graph, one number), then
  decode. Source-only levers under review: (1) an APK-authenticated per-tensor manifest instead of the whole-file
  re-hash (Astra's design; every used byte still verified at consume time); (2) a persistent authenticated encoded cache
  (FEASIBILITY.md s.7; probe-gated; a hit still costs one authenticated encoded read per tensor for the fresh checks);
  (3) the worker's public weight cache (protocol 1.4) for the upload. What each removes must be MEASURED per phase before
  any claim that a 27B start fits the cap; until then 27B trials are not launchable under the cap.

## Smallest testable implementation (this candidate: engine.cpp +96/-8 via apply.py, -fsyntax-only OK; payload allowlist +1)
  ANCHOR_BENCH_TRIALS=N (2..16) with identical settings; snapshot + N trials + records + terminal invariants. First
  device evidence = the bounded 0.8B plan (BENCH-0.8B-PLAN.md): one <= 300 s session, N=3 x 128 tokens, identical
  completion + MTP counts, restore_us and snapshot bytes reported, pads/verify counters monotonic across trials. It
  proves the mechanism on the 0.8B only; the 27B needs its own session once a 27B start fits the cap.
