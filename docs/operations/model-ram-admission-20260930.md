# Keep the app available when its model exceeds the RAM share

The fixed model-size floors described here are superseded by [dynamic guest memory enforcement](dynamic-model-ram-20261001.md).

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

The first rollout was blocked by locked SSH. After the owner unlocked nan, the release was registered and the manager activated on 2026-09-30; the production results below supersede that staging status.

## Checks

- Full Go manager suite passed; dedicated tests cover a 7% guest starting at the capped size and old images still being refused.
- 47 supervisor claim/pool/release tests passed.
- C admission boundary tests cover zero memory, undersized memory, exact thresholds and both model profiles.
- The manifest verifies all 46 files and the Eyesoff measurement has been independently reconstructed locally.

The real 72 GiB SNP guest reports 72,158 MiB usable; admission thresholds therefore use usable RAM (70 GiB for the large model, 7 GiB for the small model), allowing kernel/SNP reservations. An initial overly strict threshold was caught by the large-guest canary and its candidate is superseded. The smaller guest reported 6,251 MiB usable and served the Eyesoff interface with no model copied or graph registered.

Final canary: the exact candidate ran Eyesoff 1.0.70 in a 6,691 MiB SNP guest with no deployment config/secrets and no public routing. Two fresh nonce checks verified attestation and key continuity; a GET `/` on that attested key returned HTTP 200. `/models` reported RAM serving budget 5,481,263,104 bytes with an empty model list. The init log confirms no model load. The guest remained active at 6,419,402,752 host-accounted bytes against its 7,821,328,384-byte unit cap; the canary was then stopped. This is app availability validation, not a successful model inference benchmark. Production config release and public-domain checks subsequently passed as recorded below.

## Production rollout

The host manager binary `guestd.model-ram-61e2d31ce65e` was activated with the pinned `38d14410` template. All five existing CPU guest identities were adopted unchanged. Eyesoff's claim was retried without changing its 7% CPU/RAM or 97% GPU shares.

An unrelated upstream RPC problem delayed configuration release: PublicNode reported block 52,000,926 and an unleased deployment, while Blast and Base reported block 52,001,033 with the new lease. Base's public endpoint then rate-limited the relay workload. dRPC and Blast initially agreed, but dRPC then rate-limited deployment reads as well. Once PublicNode caught up, it was rechecked against Blast at confirmed block 52,001,255: chain 8453, deployment ID, runner, lease, share and catalog reference matched. Nan now uses Blast for primary reads and PublicNode plus Blast for the independent agreement check. The two-provider confirmation requirement was preserved. Configuration backups are under `/root/enclave-ram-admission-38d14410` on nan; no environment secrets are committed here.

The predictor cold cache also exposed a startup delay: it reconstructed 16 historical inference releases serially. Fleet inventory confirmed metal0 is the only SNP app host and Eyesoff its only inference guest. The active domain/certificate admission lists now retain the current `38d14410` inference release, immediate `4bb9f020` rollback release, and both existing CPU releases. Fourteen obsolete inference releases were retired from active admission. Their installed manifests and archives remain; the known-answer test still passes both vectors. This changes neither expected-measurement derivation nor the attestation checks.

### Verified production result (18:15 UTC)

Eyesoff guest `gd0d86e04d` is running with its existing deployment, config and shares. The guest log confirms the insufficient-RAM model refusal, verified config release, app startup and serving front. Fresh nonce attestation checks on both `9eb4e600.app.enclave.host` and `eyesoff.ai` matched the pinned release, AppID, measurement and TLS key; both roots returned HTTP 200. `/models` returned an empty model list, no default, and a 5,481,263,104-byte RAM serving budget. No inference graph is exposed.

A synthetic warmup request returned HTTP 500 while the app stayed available: a subsequent independently attested GET `/` returned HTTP 200 with the same guest key. The existing app's error text fell back to its stock small-model configuration and reported an unattached volume; this is not yet a tailored insufficient-RAM UI message, and this check is not an inference benchmark.

The live host unit used 6,430,822,400 bytes (about 5.99 GiB) against a 7,821,328,384-byte cap (7.28 GiB, including platform overhead); guest RAM is 6,691 MiB. All five other apps retained their original guest IDs and reservations and returned HTTP 200: ipns-publisher, api-mcp-adapter, jot, s3-ipfs-adapter and risc-box.

Local evidence: `9eb4e600-verified-{root,custom,models,refusal,after-refusal}.json`, `all-apps-verified.json`, and the associated response files in the rollout evidence directory. These tests establish availability and bounded RAM with the model unloaded; 27B inference requires a larger RAM allocation.

At 18:16 UTC, new ZeroSSL certificates were installed in the same attested guest for both addresses. Ordinary curl HTTPS checks, with standard CA and hostname validation enabled, returned HTTP 200 for both `https://eyesoff.ai/` and the canonical app address. No TLS verification bypass is needed by browsers.
