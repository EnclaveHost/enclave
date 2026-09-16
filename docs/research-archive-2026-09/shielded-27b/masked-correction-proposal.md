# Candidate: send a masked correction directly to the worker

Status: design for review, 2026-09-09. No production implementation, security audit, or measured throughput gain. Current priority is measured decoding speed. The existing acknowledgment-hashing and one confidence-gating comparison precede any protocol prototype. This keeps the trusted dealer and untrusted GPU roles; it does not require a confidential GPU.

The existing path precomputes an input mask `r` and its product `rW` in the trusted dealer. The protected phone receives the correction and subtracts it from the GPU's `(x+r)W` result. That correction is large. A separate output mask could move its delivery off the phone's connection.

All arithmetic below is in the existing ring modulo `M = 251 × 241 × 239`. Vectors are rows, matching the implementation.

1. The trusted dealer generates independent, one-use input and output masks `r` and `s`. The protected phone receives confidential, scoped seeds sufficient to regenerate those masks.
2. The dealer computes `c = rW − s` and delivers `c` directly to the untrusted worker.
3. The phone sends `a = x+r`. The worker returns `b = aW−c = xW+s`.
4. The phone subtracts `s`, runs its existing verification against the private input and authenticated weights, and releases the result only after verification succeeds.

The dealer still computes `rW`. The change adds linear work over the output to the worker and mask generation to the phone. The seeds are small; the expanded output masks are still large. Their generation needs a phone benchmark. The current mask generator consumes 64 pseudorandom bits per field element, so expanding an output mask can require more stream-generator work than decrypting the existing packed three-byte correction. The change removes delivery of the large `rW` correction to the phone. It does not remove GPU replies, masked inputs, CPU verification, or the dealer's computation and delivery costs.

## Why the algebra merits review

For fixed public `W` and any private `x`, the worker sees `a`, `c`, and `b=aW−c`. If `r` and `s` are independent uniform vectors, every possible pair `(a,c)` corresponds to exactly one mask pair:

`r = a−x`, `s = rW−c`.

Thus this idealized transcript has the same distribution for every `x`, including when `W` is singular or the modulus is composite. Using pseudorandom masks instead requires an appropriate cryptographic generator, separate domains, and a full adaptive protocol argument. This observation is not a proof of the complete implementation.

The current client already unmasks before verifying against the private input (`shielded-tee.c`, `sh_link_mul_group`). That is a promising integration point: replacing the correction by the regenerated `s` preserves the algebra of the final result checked by Freivalds. It still needs review of field ranges, packed representations, exceptional paths, and every verification/receipt dependency.

The underlying use of precomputed masks for outsourced linear layers is established in [Slalom, Tramèr and Boneh](https://www.floriantramer.com/docs/papers/iclr19slalom.pdf). That source is background for the current design; it does not certify this proposed delivery change.

## Conditions that cannot be omitted

- Seeds remain confidential to the attested phone and trusted dealer. An ordinary phone GPU is not a protected place to expand them under the current threat model.
- Input masks are never reused across distinct plaintext rows, including retries and speculative decoding. Shared-input projections must follow the existing group policy.
- Output masks need independent domains across every output node, row, session, model, calibration, and pad index. Sharing an output mask between different weight matrices can reveal the input mask.
- The ideal uniform-mask argument must not be confused with the current `sh_pad_r` implementation's 64-bit remainder reduction. A new version should use an explicitly reviewed sampling rule, such as rejection sampling for exact uniformity, with bounded counter regions and deterministic refusal on exhaustion. Changing existing mask derivation in place would break protocol compatibility; versioning and old/new refusal tests are required.
- Grant windows, consumed indices, cancellation, rollback and replay handling must bind both masks and the public correction. Giving the phone a seed must not enable unaccounted reuse or minting outside the authorized window.
- A worker cache hit, correction receipt or dealer signature must never replace the protected client's verification of a result. Missing, changed or mismatched corrections must fail without releasing output or reusing masks.
- Correctness of the existing dealer's correction checks and delivery acknowledgments must be retained or explicitly replaced with reviewed equivalents. The phone will no longer hold `rW` directly.
- A dealer/worker transport and storage budget remains necessary. The correction is shifted to another route, not compressed away system-wide.

## Conditional traffic effect

The latest successful MTP5 trial generated 16 tokens, receiving **355,289,430 bytes of worker replies** and consuming pad cells whose minimum replacement payload is **355,383,488 bytes**. At the same execution schedule, moving the correction delivery away from the phone would reduce the incoming requirement at 20 tokens/s from **888.34 MB/s** to approximately **444.11 MB/s**, plus scoped seed/control traffic. The earlier MTP3 trace projected 354.65 MB/s for replies alone; it had a different row count and is not the current recipe.

The phone would instead regenerate **118,425,088 output-mask elements per 16-token trial**. Reusing the current `sh_pad_r` sampling cost of eight pseudorandom bytes per element would require **1.184 GB/s of pseudorandom stream generation at 20 tokens/s**, in addition to input masks. This is a workload calculation, not measured phone capability. The current implementation generates one ChaCha20 block at a time and reduces 64-bit samples modulo the field modulus. A new output-mask domain and reviewed sampling rule are required; calling the current input-mask API with colliding coordinates would be unsafe.

These are arithmetic projections for that trace, not a measured sustained rate. Removing phone pad ingress does not remove the 1,574 sequential exchanges per 16 tokens, worker replies, masked inputs, CPU verification, or dealer computation. The next useful prototype measurement is trusted output-mask generation at the actual output dimensions, compared with current pad import; a host-only throughput number cannot establish Pixel pVM performance.

## Checks completed and next decision

A bounded public toy fixture enumerated 21,609 complete transcripts over a small ring for zero, singular and invertible matrices, and compared their distributions across three inputs. Another 200 cases checked correctness and modified-output rejection under the production CRT modulus. The fixture also demonstrates the leaks from input-mask reuse and from output-mask reuse across distinct matrices. Those checks validate the algebra and examples only.

Next: Fable independently looks for counterexamples and maps this proposal to the existing pad-bank, grant, group and verification lifecycle. If that review survives, build an isolated synthetic protocol prototype with replay, reordering, cancellation and corruption cases. Do not enable it in the production phone path based on the toy tests.
