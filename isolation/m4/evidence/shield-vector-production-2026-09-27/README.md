# Measured 27B vector-refill rollout — September 27, 2026

Deployed to metal0: four decode threads, sixteen total masking refill threads
(eight per V100), and the checked vector CRT refill kernel for the 27B profile.
The 0.5B profile retains its previous settings. Source commit
`0b9104abee1da5b8440726b95eb24a486809c90b` is pushed on
`codex/v100-per-app-shield-20260927`.

## Production release

- New Shield release: `c427ef6351b62a190eff7d0361c641268211e8eeee26c986388ec52463d17b48`.
- Previous Shield release retained: `f674c047ad946c351ab8607bca69ea72c94d704f4151c599f67c76f9609e0644`.
- CPU-only apps retain `85948b987bcd621d1b47bbaa402ea293720e7cbc77961e4f5dd670b552a72ee0`.
- The release manifest differs only in `template/init`: no model, runtime,
  backend, verification, transport, firmware, or kernel bytes changed.
- Guest remains 16 vCPUs / 50 GiB, pool remains 24 logical CPUs / 64 GiB.
- Guestd uses `/home/steven/enclave-prod/release-c427ef63/template`. The manager
  executable/assembler remain the previously deployed ffb5b3e8 versions because
  their interfaces and resource policy did not change. The control image and
  GPU workers were not restarted. The host-specific native affinity shim and
  native AVX-512 CPU module are not included in this rollout.

## Real-guest checks

A temporary guest created by the real guest manager ran the exact new release,
with the same Q4 GGUF, 17-token public prompt, 128 output tokens, two V100-class
cards, column splitting, verification overlap and shared masked rings.

| Decode mode | Per-run tok/s | Aggregate tok/s |
|---|---|---:|
| Ordinary | 14.52, 13.47 | 13.97 |
| MTP k=1 | 13.99, 13.48, 12.97 | 13.47 |

Rates time the 127 tokens following the token produced by prefill. All five
responses match token-for-token. Each successful request passed fresh AMD chain,
TCB, expected measurement, runtime/W^X, TLS-key binding, second nonce and replay
checks before inference and returned HTTP 200. One initial connection attempt
failed before attestation/any app request; its subsequent attempt passed all
checks. Failure evidence remains in the local rollout directory.

Model preparation is excluded from decode rates: first ordinary prefill/setup
was 83.876 s; first MTP setup/prefill 42.115 s. Desktop and hosted apps remained
active. These are short production-image measurements, not a sustained SLA.
The previous 11.75/11.14 production series used a different 20-token prompt;
no exact before/after speedup percentage is claimed. Native 23.32 tok/s is not
this isolated production result.

## Admission, compatibility and availability

Nan's existing pinned assembler reproduced both prior known answers and exactly
matched the local expected measurement for a catalog-derived 27B bundle using
the new release. Predictor/domain/certificate admission was extended with the
new release; prior releases remain admitted. The relay source and assembler
commit stayed unchanged. A relay restart briefly returned warming 503s for
expected-image requests while caches rebuilt; app guests continued running.

Before switching, adoption checks passed for all five existing apps. After the
manager restart, their IDs, creation times, measurements and TLS keys were
unchanged. Fresh public attestation and health results are in
`production-health.json`. The manager, control and both workers remain active.

The vector refill arithmetic/tail/stride/oracle tests, forced allocation-failure
fallback and SIMD bounds tests passed. The unchanged small-model path is checked
with two attested eight-token requests; results are recorded separately. An
initial small-canary request supplied a GPU share different from its bundle and
was correctly refused before launch, then retried with the bound share.

Only nondeployment lab canaries were created. No paid/on-chain deployment or
wallet transaction was made. Test guests and their temporary manager are removed
after checks; see `cleanup.json`.

## Rollback and evidence

Local private backup: `/home/steven/enclave-bench/v100-shield-20260927/rollout-vector/production-backup/80-shield-inference.conf`.
Nan private environment backup: `/root/enclave-vector-backup-20260927/api-relay.env`.
For rollback, first drain any NEW inference guests on the new release; restore
the old guestd drop-in, reload/restart guestd and verify adoption. Keep CPU app
guests and GPU workers running. Old release admission remains available.

Raw request and build logs are under
`/home/steven/enclave-bench/v100-shield-20260927/rollout-vector`.
