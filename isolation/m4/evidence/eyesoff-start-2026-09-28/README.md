# Eyesoff AI isolated hosting recovery — 2026-09-28

Deployment `0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c`, app `eyesoff-ai:1.0.66`.

## Corrections

- Source `36df253a2`: the scheduler now admits CID-based configuration when the isolated manager supports attested release and the deployment is explicitly admitted by the relay. Unlisted or unavailable release admission still refuses work. No host-side secret fetch was added.
- The owner confirmed transaction `0xd1562785fa7ce5c17dba3686623b209c948f05a0f953d41f3c5505035ae6d622` on Base (block 51893564), adding only `isolation.require=snp-guest-per-app`. Saved configuration, shares, balance and routing remained unchanged; there was no deposit or token transfer. Two RPCs independently confirmed the receipt and resulting configuration.
- Source `763046bc8`: the measured runtime passes the GPU reservation and separate private RAM serving budget to the WASI application. The public model filename aliases the same hash-verified private model copy. The 27B application context is 8192 tokens; the old benchmark profile was 512. Saved `nnCtx=180224` does not override this profile. No throughput claim is made for the expanded context.
- Sources `a3ac43a80` and `f0dd79b0d`: the shared engine permits eight inference sessions. The former one-session setting deadlocked a tool-enabled turn that retained its tokenizer while opening generation. This is an engine slot limit, not proof of eight simultaneous chats; tool turns retain an extra tokenizer slot and all sequences share 8192 KV tokens.
- Final application release: `057b2c667661f47dadd1b94153896ddd367e03ced7e18f0cf82143285fab19eb`. It adds the existing `wasm/wasmtime-p2-host-header.patch` to the GGML-only Wasmtime build. Against a real HTTP server requiring Host, the previous binary returned HTTP 400 and the rebuilt binary returned HTTP 200. The public model configuration was not the cause of that error.
- Site source `57396f0d2`: public IPFS reads now carry `Access-Control-Allow-Origin: *`. The config display bypasses obsolete immutable cached response headers once per page and memoizes successfully parsed content. The original 8169-byte config still hashes to its CID. The deployed browser editor displayed 8998 characters of valid, formatted JSON without changing the saved configuration.

## Operational history

Cold independent prediction initially exceeded the 120-second configuration-release deadline. The guest correctly powered off without starting the app. Waiting for verified image reconstruction resolved this; no verification gate was weakened. Inactive test fixture logs were archived to disk with hash verification and original-path symlinks to free RAM-backed temporary storage. The 16 GiB physical host memory floor was retained.

The predictor's configured releases and domain/certificate admission sets must agree. Removing inactive predictor profiles without updating those sets briefly disabled prediction (`prediction_unconfigured`). Aligning the sets restored it. The final configuration retains all four existing CPU profiles and Shield releases `9b088f90`, `ff8ef20e` and `057b2c66`; eight inactive/superseded Shield pins were retired. Their release directories remain available for rollback. Independent reconstruction produced the same final measurement as the local build before Eyesoff was restarted.

The control VM and GPU worker processes survived the later runtime-manager update. All six running guests were successfully re-attested and adopted. Only Eyesoff was restarted to pick up its application profile; its final guest is `gd90f86444`. The five other apps retain their guest IDs. Model weights, inference backend, masking arithmetic and GPU worker binaries are unchanged. The dashboard Restart action refused while the fleet advertised no free capacity, so the authenticated local manager stopped only the old Eyesoff guest and the supervisor relaunched it under its existing lease.

## Validation

Scheduler checks: 43 passed, zero failed. Model loader tests passed; measured init compiled with `-Wall`. The old guest served valid WebPKI HTTPS and passed fresh AMD attestation; Enclave browser SSO succeeded. That first guest was not a functioning chat: missing allocation metadata and the filename mismatch were discovered by `/models` and `/warmup`, rather than treating HTTP 200 as completion.

The final guest passed fresh AMD attestation with measurement `c0ebdc375310acfe6d94ab21659e3aef6e48751374a5b76e17d9557ff65a4d1859226f712256b628d058d0ae53a0e645`, matching independent prediction. It received a valid ZeroSSL certificate and the public `/ping` returned 200 with attestation and TLS-key binding verified. `/models` selected the pinned 27B model and reported it fits. `/warmup?model=qwen3.8-27b-mtp&prefix=0` returned `ok:true`, GPU target, 137 ms load and 135236 ms feed while the browser also warmed the model. This is a cold warmup result, not steady-state throughput. All five other apps passed fresh attestation and public HTTP 200 checks after the rollout.

Site build and automated production deployment succeeded (run `36391208558`). Normal browser loading of build `57396f0d` populated the Config editor with valid JSON. No secrets, config values or private wallet material are included in the config evidence.

A browser chat with the existing tool-enabled configuration completed and returned exactly “Eyesoff is online.” The UI reported GPU, 30 generated tokens, 10.5 tok/s; its 3774-token cold prompt took several minutes to process. A follow-up also returned exactly “Ready.” (GPU, 36 tokens, 9.9 tok/s). It reprocessed 3806 prompt tokens, so prompt reuse remains a performance issue beyond startup. Neither the missing-Host error nor the one-session deadlock occurred. This short application-level result does not reproduce the earlier short-context benchmark throughput. Vision/video and the custom `eyesoff.ai` domain were not validated by this rollout. The measured context remains 8192 tokens despite the larger value in the saved app configuration.

## Private material

Local work is `/home/steven/enclave-bench/eyesoff-start-20260928`. Private configuration, environment backups, wallet material and resolved secrets are deliberately excluded from this evidence directory. No GPU shared-memory ring was recreated or truncated.
