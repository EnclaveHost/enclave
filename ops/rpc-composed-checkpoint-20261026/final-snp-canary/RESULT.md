# Actual SNP hardware qualification

The final verifier image passed a dedicated AMD SEV-SNP hardware canary on 2026-10-26 from 05:15:48 to 05:16:23 UTC. Attestation bound the expected measurement, configuration, TLS key and running supervisor. Report and statement tampering, nonce replay, incorrect measurement/configuration and sequencer mismatch were rejected. Reads failed closed with HTTP 502 while the deliberately unavailable backend was used; writes returned 403.

This qualifies the image boot, identity binding and failure behavior. It does not qualify live Base proof serving, finalized state, transaction execution or production cutover. Production activation remains false. There were no registration keys, app secrets, claims or production volumes in this canary.

The 2 GiB canary VM peaked at 2201 MiB for its guarded process scope. All owned processes were removed, private temporary files were deleted, and existing VM identities, RPC state and user services were unchanged. The complete local evidence remains under final-proof-canary-stage/runs/20261026T051548Z; RESULT.json includes its file hashes and selected results, excluding hardware chip identifiers. Six Node and 21 Python harness checks passed before the hardware run.

Scripts and launch pins are preserved for audit. Absolute paths describe this exact run and require deliberate review before reuse. The nested historical stage tree manifest references the source checkout; its files are not duplicated here.
