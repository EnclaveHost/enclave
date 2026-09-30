# Keep the app available when its model exceeds the RAM share

This supersedes the all-or-nothing model admission behavior recorded in `ram-share-enforcement-20260930.md`. The owner's requirement is to keep the application available inside its share while declining an oversized model.

## Behavior

- A Shield guest whose pinned runtime carries `rt/shield-ram-admission.enabled` is sized to the smaller of its normal requirement and its CPU/RAM share, with existing fixed platform overhead separately reserved.
- The measured guest init checks usable guest RAM before copying the public model or registering the inference graph. An insufficient-memory guest skips the model copy, source-reclamation descriptors, GPU broker and graph preload. The WASI application and attesting HTTPS front still start.
- The app receives an empty preload list and a RAM serving budget based on its actual guest memory. A model without a registered graph cannot be loaded by name. No CPU fallback, unverified model mapping, masking change or validation bypass is introduced.
- Adequately sized guests retain the existing model profile. The admission requirement is conservative; this change does not establish a lower minimum for running 27B.
- Older pinned images that copy/load the model unconditionally retain the manager refusal. A smaller VM is not booted with an old image that would OOM during model copying.
- The supervisor source mirrors the new manager capability before claiming; the currently deployed control image learns the outcome at provision time.

For the actual 88 GiB host pool and Eyesoff's existing 7% share, the app allowance is 6,307 MiB and the guest size is 6,691 MiB, including 384 MiB guest overhead. The host unit cap additionally includes the existing 768 MiB QEMU allowance. Owner shares and app identity remain unchanged.

## Candidate

Only guest init and the capability marker differ from production release `4bb9f020d0d3c0760c60f7e3a28e32e4429139c82023785d5415f83bcb054170`. Existing native engine/backend libraries, compact weights, caches and masking optimizations are preserved.

Release: `38d14410530da09512344f2dc7a848d54da392d7c15f5b5acc436bc13efd4dc9`.
Eyesoff 1.0.70 AppID: `4a9188f0fb55b6ce56ac98bd1aae9fada17df6639bf594aa9c60e43473506b45`.
Predicted measurement: `db1e5c8e37726695345d85945e6395b0f121829e0cae14539309224af793e578aa55bcc9f318d6daeed72627b506bfcb` (recorded in `prediction-final.txt`).

Evidence and prepared rollout: `/home/steven/enclave-bench/model-ram-admission-20260930`.
The relay delta retains all earlier releases and changes no secrets or wallet shares. Before manager activation, register this measured release on nan, verify its independently reconstructed measurement, then apply `manager-ready.conf` through the prepared bounded manager switch. Confirm Eyesoff's HTTPS response, capped reservation and skipped model load, and verify the other five guests retain their identities.

At preparation time SSH to nan was locked (`Permission denied`), so the candidate was not activated. Do not mistake a staged binary/template for a production rollout.

## Checks

- Full Go manager suite passed; dedicated tests cover a 7% guest starting at the capped size and old images still being refused.
- 47 supervisor claim/pool/release tests passed.
- C admission boundary tests cover zero memory, undersized memory, exact thresholds and both model profiles.
- The manifest verifies all 46 files and the Eyesoff measurement has been independently reconstructed locally.

The real 72 GiB SNP guest reports 72,158 MiB usable; admission thresholds therefore use usable RAM (70 GiB for the large model, 7 GiB for the small model), allowing kernel/SNP reservations. An initial overly strict threshold was caught by the large-guest canary and its candidate is superseded. The smaller guest reported 6,251 MiB usable and served the Eyesoff interface with no model copied or graph registered.

Final canary: the exact candidate ran Eyesoff 1.0.70 in a 6,691 MiB SNP guest with no deployment config/secrets and no public routing. Two fresh nonce checks verified attestation and key continuity; a GET `/` on that attested key returned HTTP 200. `/models` reported RAM serving budget 5,481,263,104 bytes with an empty model list. The init log confirms no model load. The guest remained active at 6,419,402,752 host-accounted bytes against its 7,821,328,384-byte unit cap; the canary was then stopped. This is app availability validation, not a successful model inference benchmark. Production config/secrets release and public-domain checks remain part of rollout after SSH is unlocked.
